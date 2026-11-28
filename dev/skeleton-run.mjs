#!/usr/bin/env node
/**
 * 用真实模型跑一次「归纳分类骨架」，看它返回的东西到底能不能用。
 *
 * 与扩展里 taxonom:design 走同一个提示词与同一个解析器（designSkeleton / parseSkeleton），
 * 区别只是：这里不写任何存储、不碰书签、把 Key 从环境变量读，用完即走。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node dev/skeleton-run.mjs
 *   OPENAI_API_KEY=sk-xxx BASE_URL=https://api.openai.com/v1 MODEL=gpt-4o-mini node dev/skeleton-run.mjs
 *   （Key 也可以直接用 API_KEY；脚本不会打印它）
 *
 * 注意：会把 200 条书签的标题/域名发给该接口，按你自己服务商的计费算。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { designSkeleton } from '../lib/llm.js';
import { sampleForSkeleton, assignByRules, buildTaxonomyFromSkeleton } from '../lib/taxonomy.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const key = process.env.API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
if (!key) {
  console.error('缺少 API Key。请用环境变量传入，例如：\n  DEEPSEEK_API_KEY=sk-xxx node dev/skeleton-run.mjs\n（脚本只读取它，不会写盘也不会打印）');
  process.exit(2);
}

const settings = {
  baseUrl: arg('base', process.env.BASE_URL || 'https://api.deepseek.com/v1'),
  model: arg('model', process.env.MODEL || 'deepseek-chat'),
  apiKey: key,
  maxTokens: 3000,
  timeout: 60000,
};
const n = Number(arg('n', '200')) || 200;

const file = join(homedir(), 'Library/Application Support/Google/Chrome/Default/Bookmarks');
let items = [];
try {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.url) {
        let host = '';
        try { host = new URL(c.url).host.replace(/^www\./, ''); } catch (e) { host = ''; }
        items.push({ id: c.id, title: c.name || '', url: c.url, host, added: Number(c.date_added || 0) });
      } else {
        walk(c);
      }
    }
  };
  for (const root of Object.values(raw.roots)) if (root && typeof root === 'object') walk(root);
} catch (e) {
  console.error('读取 Chrome 书签失败：' + e.message);
  process.exit(1);
}

console.log(`语料：${items.length} 条；本次抽 ${n} 条 → ${settings.baseUrl} / ${settings.model}\n`);
const sample = sampleForSkeleton(items, n);

let skeleton;
const t0 = Date.now();
try {
  skeleton = await designSkeleton(sample, settings, { maxTop: 10, maxPerTop: 4 });
} catch (e) {
  console.error('调用失败：' + e.message);
  process.exit(1);
}
const ms = Date.now() - t0;

const tops = skeleton.length;
const kids = skeleton.reduce((s, c) => s + c.children.length, 0);
const names = skeleton.flatMap((c) => [c.name, ...c.children.map((k) => k.name)]);
const lens = names.map((x) => x.length);
const noHint = skeleton.filter((c) => !c.hint).length;
const dupTop = tops - new Set(skeleton.map((c) => c.name)).size;

const built = buildTaxonomyFromSkeleton(skeleton, {});
const { map, unmatched } = assignByRules(items, built.nodes);
const covered = items.length - unmatched.length;

console.log('返回结果');
console.log(`  顶层 ${tops} 个，子类 ${kids} 个，用时 ${(ms / 1000).toFixed(1)}s`);
console.log(`  名字长度：最短 ${Math.min(...lens)}，最长 ${Math.max(...lens)}，平均 ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)}`);
console.log(`  重复顶层名：${dupTop} 个；没有 hint 的顶层：${noHint} 个`);
console.log(`  规则铺全量覆盖：${covered}/${items.length}（${((covered / items.length) * 100).toFixed(1)}%），未覆盖 ${unmatched.length}`);
console.log('  每个顶层覆盖条数：');
// 编码是 buildTaxonomyFromSkeleton 分配的，不在模型返回的骨架里，按节点表聚合
for (const t of built.nodes.filter((n) => !n.parent)) {
  const kids = built.nodes.filter((n) => n.parent === t.code);
  const direct = (map[t.code] || []).length;
  const withKids = kids.reduce((s, k) => s + (map[k.code] || []).length, direct);
  console.log(`    ${t.name}（子类 ${kids.length}）：${direct} 条直属 / ${withKids} 条含子类`);
}

const out = arg('json-out', '');
if (out) {
  writeFileSync(out, JSON.stringify(skeleton, null, 2));
  console.log(`\n骨架已写入 ${out}`);
}
console.log('\n骨架 JSON（可直接贴回来）：');
console.log(JSON.stringify(skeleton, null, 2));
