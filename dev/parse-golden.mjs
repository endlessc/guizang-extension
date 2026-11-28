#!/usr/bin/env node
/**
 * parseTree 的解析基线（golden）测试。
 *
 * 目的只有一个：证明「识别层泛化」没有改变任何现有行为。
 * 改造前后各跑一次，输出必须逐字节一致。
 *
 * 用法：
 *   node dev/parse-golden.mjs --write            用当前代码生成基线（改代码之前跑）
 *   node dev/parse-golden.mjs                    与基线比对，不一致时退出码 1
 *   node dev/parse-golden.mjs --real <path>      临时算真实 Bookmarks 文件的摘要（不入库）
 *
 * 三个 fixture 各管一段：
 *   tree-dewey   数字类目 / 收件箱 / 重号 / 深层嵌套 / 无日期 / 散条目 / 「B 站」这种字母开头名
 *   tree-nocode  一个数字类目都没有 → 退化成一級文件夹当类目（F1…Fn）
 *   tree-letters 只有字母前缀文件夹 → 在「未安装字母方案」的默认 opts 下不应被当成类目
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTree } from '../lib/tree.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = ['tree-dewey', 'tree-nocode', 'tree-letters'];
const BASELINE = join(HERE, 'fixtures', 'parse-baseline.json');

/** 递归按 key 排序，保证同一份数据每次序列化完全一致 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        if (value[k] !== undefined) acc[k] = stable(value[k]);
        return acc;
      }, {});
  }
  return value;
}

const dump = (value) => JSON.stringify(stable(value), null, 2);
const digest = (value) => createHash('sha256').update(dump(value)).digest('hex').slice(0, 16);

/** 用默认 opts 解析三个 fixture —— 这就是「现有行为」的全部定义 */
function runFixtures() {
  const out = {};
  for (const name of FIXTURES) {
    const tree = JSON.parse(readFileSync(join(HERE, 'fixtures', `${name}.json`), 'utf8'));
    // folderScheme 是 scheme 的别名（术语改名引入），不进基线：基线只描述原有语义
    const { folderScheme, ...rest } = parseTree(tree);
    out[name] = rest;
  }
  return out;
}

/** 找出第一处差异，带 JSON 路径，方便定位 */
function firstDiff(a, b, path = '') {
  if (a === b) return null;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) return { path, a, b };
  if (ta === 'array') {
    if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length };
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return { path, a, b };
}

/** Chrome 的 Bookmarks 文件 → parseTree 认的树（name→title，含文件夹节点） */
function fromChromeFile(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const map = (n) => ({
    id: n.id,
    title: n.name || '',
    url: n.url,
    dateAdded: n.date_added ? Number(n.date_added) : undefined,
    index: n.index || 0,
    children: (n.children || []).map(map),
  });
  return [{ id: '0', title: '', children: Object.values(raw.roots).map(map) }];
}

function realReport(tree) {
  const r = parseTree(tree);
  const byCode = {};
  for (const it of r.items) byCode[it.code || 'inbox'] = (byCode[it.code || 'inbox'] || 0) + 1;
  return {
    digest: digest({ items: r.items, folders: r.folders, scheme: r.scheme, inboxId: r.inboxId }),
    items: r.items.length,
    folders: r.folders.length,
    scheme: r.folderScheme.map((f) => f.code),
    inboxId: r.inboxId,
    byCode,
  };
}

// ── 入口 ──────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === '--real') {
  const file = args[1];
  if (!file) {
    console.error('用法：node dev/parse-golden.mjs --real <Bookmarks 文件路径>');
    process.exit(2);
  }
  console.log(JSON.stringify(realReport(fromChromeFile(file)), null, 2));
  process.exit(0);
}

if (args.includes('--write')) {
  const out = runFixtures();
  writeFileSync(BASELINE, dump(out) + '\n');
  console.log('已写入基线 dev/fixtures/parse-baseline.json');
  for (const name of FIXTURES) {
    const r = out[name];
    console.log(`  ${name}: ${r.items.length} 条书签 / ${r.folderScheme.length} 个类目 / scheme=${r.folderScheme.map((f) => f.code).join(',') || '(空)'}`);
  }
  process.exit(0);
}

const current = runFixtures();
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const diff = firstDiff(current, baseline);

if (diff) {
  console.error('❌ 解析结果与基线不一致');
  console.error('   路径：' + diff.path);
  console.error('   现在：' + JSON.stringify(diff.a));
  console.error('   基线：' + JSON.stringify(diff.b));
  process.exit(1);
}

console.log('✅ 解析结果与基线一致');
for (const name of FIXTURES) {
  const r = current[name];
  console.log(`  ${name}: ${r.items.length} 条 / scheme=${r.scheme.map((f) => f.code).join(',') || '(空)'}`);
}
