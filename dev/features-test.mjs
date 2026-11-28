#!/usr/bin/env node
/**
 * v0.6 新增能力单元测试（纯函数，不依赖浏览器）：
 *   node dev/features-test.mjs
 */

import assert from 'node:assert/strict';
import { normalizeUrl, findDuplicates, duplicateIdSet, removableCount } from '../lib/dedup.js';
import { pinyinInitials, parseQuery, filterAndScore, buildOmniboxSuggestions } from '../lib/search.js';
import { toMarkdown, toSelectionMarkdown, toNetscapeHtml } from '../lib/export.js';
import { normalizeMeta, collectAllTags, recordOverride, matchLearned, pickSerendipity, analyzeUsage } from '../lib/meta.js';
import { parseHeadHtml, isWeakTitle, cleanTitleLocal } from '../lib/head.js';
import { sanitizeCustomScheme, getScheme, parseOptsOf } from '../lib/schemes.js';
import { classifyHeuristic, classifyWithModel } from '../lib/llm.js';
import { validateSnapshot, rebuildSubtree } from '../lib/backup.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('1. 重复书签检测（lib/dedup.js）');
test('URL 规范化剥离追踪参数、协议、www、尾斜杠与锚点', () => {
  assert.equal(
    normalizeUrl('http://www.Example.com/docs/a/?utm_source=x&b=2&a=1&spm=9#top'),
    'https://example.com/docs/a?a=1&b=2',
  );
});
test('重复分组优先保留已归类条目', () => {
  const items = [
    { id: '1', title: 'https://a.com/', url: 'https://a.com/?utm_medium=social', host: 'a.com', code: '', added: 100 },
    { id: '2', title: 'A 官方文档', url: 'http://www.a.com/#intro', host: 'a.com', code: '100', added: 200 },
    { id: '3', title: 'B', url: 'https://b.com', host: 'b.com', code: '200', added: 300 },
  ];
  const groups = findDuplicates(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keepId, '2');
  assert.deepEqual(groups[0].removeIds, ['1']);
  assert.equal(removableCount(groups), 1);
  assert.equal(duplicateIdSet(groups).size, 2);
});

console.log('2. 多维搜索与拼音首字母（lib/search.js）');
test('中文拼音首字母提取', () => {
  const py = pinyinInitials('人工智能与神经网络');
  assert.ok(py.startsWith('rgzn'), `got ${py}`);
});
test('结构化语法解析 + 过滤 + Omnibox 建议', () => {
  const q = parseQuery('domain:github.com #rust status:dead before:2026 rgzn');
  assert.deepEqual(q.filters.domains, ['github.com']);
  assert.deepEqual(q.filters.tags, ['rust']);
  assert.deepEqual(q.filters.statuses, ['dead']);
  assert.ok(q.filters.before > 0);
  assert.deepEqual(q.terms, ['rgzn']);

  const items = [
    { id: 'a', title: '人工智能实战', url: 'https://github.com/org/ai', host: 'github.com', code: '500', added: Date.parse('2025-05-01') },
    { id: 'b', title: '普通网页', url: 'https://example.com', host: 'example.com', code: '000', added: Date.parse('2026-08-01') },
  ];
  const ctx = {
    health: { a: { status: 'dead', code: '404' } },
    meta: { a: { tags: ['rust'], star: true } },
    scheme: [{ code: '500', name: '人工智能' }],
  };
  const hits = filterAndScore(items, 'domain:github.com #rust status:dead rgzn', ctx);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].item.id, 'a');

  const omni = buildOmniboxSuggestions(items, 'rgzn', ctx);
  assert.equal(omni.length, 1);
  assert.equal(omni[0].content, 'https://github.com/org/ai');
  assert.ok(omni[0].description.includes('<match>人工智能实战</match>'));
});

console.log('3. 知识库导出（lib/export.js）');
test('Markdown 导出默认剔除失效链接并带标签批注', () => {
  const items = [
    { id: '1', title: 'Rust Book', url: 'https://doc.rust-lang.org', host: 'doc.rust-lang.org', code: '100', added: 1000 },
    { id: '2', title: 'Dead Link', url: 'https://dead.example', host: 'dead.example', code: '100', added: 2000 },
  ];
  const scheme = [{ code: '100', name: '编程与后端' }];
  const md = toMarkdown(items, scheme, {
    health: { 2: { status: 'dead', code: '404' } },
    meta: { 1: { tags: ['rust'], note: '必读', star: true } },
    excludeDead: true,
  });
  assert.ok(md.includes('Rust Book'));
  assert.ok(md.includes('#rust'));
  assert.ok(md.includes('> 必读'));
  assert.ok(!md.includes('Dead Link'));

  const sel = toSelectionMarkdown([items[0]], scheme, { meta: { 1: { note: '精选' } } });
  assert.ok(sel.includes('精选书单'));

  const html = toNetscapeHtml(items, scheme);
  assert.ok(html.includes('NETSCAPE-Bookmark-file-1'));
  assert.ok(html.includes('100 编程与后端'));
});

console.log('4. 元数据、改判记忆、拾遗与吃灰（lib/meta.js）');
test('旁挂元数据清洗与标签聚合', () => {
  const m = normalizeMeta({ tags: '#Rust, AI, rust', note: '好文章', star: true, readState: 'unread' });
  assert.deepEqual(m.tags, ['Rust', 'AI']);
  assert.equal(m.star, true);
  assert.equal(m.readState, 'unread');
  assert.equal(normalizeMeta({ tags: [], note: '', star: false, readState: '' }), null);

  const all = collectAllTags({ a: m, b: { tags: ['AI'] } });
  assert.equal(all[0].tag, 'AI');
  assert.equal(all[0].count, 2);
});
test('改判记忆忽略公共大站、记住专属域名', () => {
  let l = recordOverride(null, { host: 'github.com' }, '100');
  assert.equal(Object.keys(l.domains).length, 0);
  l = recordOverride(l, { host: 'docs.rs' }, '100');
  const hit = matchLearned(l, { host: 'docs.rs' }, new Set(['100', '500']));
  assert.equal(hit.code, '100');
  assert.equal(hit.source, 'learned');
});
test('书海拾遗排除失效链接 & 吃灰分析区分常阅与尘封', () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  const items = [
    { id: '1', title: 'Old', url: 'https://old.example', host: 'old.example', added: now - 400 * 86400000 },
    { id: '2', title: 'Hot', url: 'https://hot.example', host: 'hot.example', added: now - 400 * 86400000 },
    { id: '3', title: 'Dead', url: 'https://dead.example', host: 'dead.example', added: now - 400 * 86400000 },
  ];
  const picks = pickSerendipity(items, { health: { 3: { status: 'dead' } }, count: 3, seed: 7 });
  assert.equal(picks.length, 2);
  assert.ok(!picks.some((x) => x.id === '3'));

  const usage = analyzeUsage(items, [{ url: 'https://hot.example/?utm_source=x', visitCount: 9, lastVisitTime: now - 3 * 86400000 }], { now });
  assert.deepEqual(usage.frequentIds, ['2']);
  assert.ok(usage.dustyIds.includes('1'));
  assert.ok(!usage.dustyIds.includes('2'));
});

console.log('5. 页面头部解析与标题清洗（lib/head.js）');
test('解析 HTML title 与 og:description + 标题清洗去角标', () => {
  const head = parseHeadHtml('<head><title>  Hello &amp; World </title><meta property="og:description" content="A &quot;great&quot; guide"></head>');
  assert.equal(head.title, 'Hello & World');
  assert.equal(head.desc, 'A "great" guide');
  assert.equal(isWeakTitle('首页', 'https://a.com'), true);
  assert.equal(isWeakTitle('用 eBPF 观测内核网络栈', 'https://blog.cloudflare.com'), false);
  assert.equal(cleanTitleLocal('(12) Rust 编程指南 - rust-lang.org', 'rust-lang.org'), 'Rust 编程指南');
});

console.log('6. 自定义方案 + 非杜威方案本地规则修复（lib/schemes.js & lib/llm.js）');
test('中图法与 PARA 不再错配杜威编码', () => {
  const clcScheme = getScheme('clc12');
  const [res] = classifyHeuristic(
    [{ id: '1', title: 'Rust 编译器架构与 LLM Agent', url: 'https://example.org', host: 'example.org', code: '' }],
    clcScheme.folders,
    { schemeId: 'clc12' },
  );
  assert.equal(res.code, 'T');

  const paraScheme = getScheme('para');
  const [paraRes] = classifyHeuristic(
    [{ id: '2', title: 'Rust 语言官方文档参考手册', url: 'https://doc.rust-lang.org', host: 'doc.rust-lang.org', code: '' }],
    paraScheme.folders,
    { schemeId: 'para' },
  );
  // PARA 中 100 是「项目」，300 是「资源」——文档手册应命中 300 而不是被杜威 100 误吸走
  assert.equal(paraRes.code, '300');

  const custom = sanitizeCustomScheme({
    name: '研究四卷',
    folders: [{ code: 'A', name: '大模型', hint: 'llm agent' }, { code: 'B', name: '金融', hint: '财报 投资' }],
  });
  assert.equal(custom.kind, 'letter');
  const opts = parseOptsOf(custom.id, [custom]);
  assert.ok(opts.letterSet.has('A'));
});

console.log('7. 快照恢复树重建（lib/backup.js）');
test('校验快照并重建父子层级', () => {
  const snap = validateSnapshot(JSON.stringify({
    id: 'b1',
    at: 1700000000000,
    nodes: [
      { id: '1', parentId: '0', index: 0, title: '书签栏', url: '' },
      { id: 'f1', parentId: '1', index: 0, title: '500 人工智能', url: '' },
      { id: 'n1', parentId: 'f1', index: 0, title: 'arXiv', url: 'https://arxiv.org' },
    ],
  }));
  assert.equal(snap.counts.bookmarks, 1);
  const tree = rebuildSubtree(snap.nodes);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children[0].children[0].title, 'arXiv');
});

console.log('8. 模型批处理容错（lib/llm.js classifyWithModel）');
{
  const scheme = [{ code: '100', name: '编程' }, { code: '200', name: '资讯' }];
  const items = Array.from({ length: 48 }, (_, i) => ({
    id: 'i' + i, title: 't' + i, host: 'a.com', url: 'https://a.com/' + i,
  }));
  const settings = { apiKey: 'k', baseUrl: 'http://mock', model: 'm' };
  const replyOf = (messages, code) => {
    const raw = String(messages[1].content).split('待归类书签：\n')[1];
    const rows = JSON.parse(raw);
    return JSON.stringify({ items: rows.map((r) => ({ id: r.id, code, conf: 0.8, reason: 'x' })) });
  };

  // 第 1 批成功、第 2 批一直失败（含重试）
  let calls = 0;
  const stats = {};
  const out = await classifyWithModel(items, scheme, settings, null, {
    call: async (st, messages) => {
      calls += 1;
      if (calls >= 2) throw new Error('模型请求超时（模拟）');
      return replyOf(messages, '100');
    },
    stats,
  });
  assert.equal(out.length, 24, '失败批次之外的批次要保留');
  console.log('  ✓ 一批失败不丢已完成的批次');
  assert.equal(stats.failed.length, 1, '失败批次要被记下来');
  console.log('  ✓ 失败批次被记进 stats');
  assert.match(stats.failed[0].error, /超时/, '失败原因要带原文');
  console.log('  ✓ 失败原因带原文');
  assert.equal(calls, 3, '失败批次应重试一次');
  console.log('  ✓ 失败批次重试一次后才放弃');

  // 每批开始先报一次，失败也推进进度（界面不再永远停在 0）
  const startedBatches = [];
  const advanced = [];
  const out3 = await classifyWithModel(items, scheme, settings, (done) => advanced.push(done), {
    call: async () => { throw new Error('模拟超时'); },
    onBatchStart: (batch, batches) => startedBatches.push([batch, batches]),
    stats: {},
  });
  assert.deepEqual(startedBatches, [[1, 2], [2, 2]], '每批开始都要报批次');
  assert.deepEqual(advanced, [24, 48], '失败的批次也要推进进度');
  assert.equal(out3.length, 0);
  console.log('  ✓ 每批开始报批次、失败也推进进度');

  // 第 2 批返回不可解析内容：只丢这一批，并记录
  calls = 0;
  const stats2 = {};
  const out2 = await classifyWithModel(items, scheme, settings, null, {
    call: async (st, messages) => {
      calls += 1;
      return calls === 1 ? replyOf(messages, '200') : '抱歉，我不太确定';
    },
    stats: stats2,
  });
  assert.equal(out2.length, 24);
  console.log('  ✓ 坏 JSON 只丢这一批');
  assert.equal(out2[0].code, '200');
  console.log('  ✓ 好批次的结果照常返回');
  assert.match(stats2.failed[0].error, /没有返回可解析的 JSON/);
  console.log('  ✓ 解析失败也记进 stats');
  assert.equal(stats2.batches, 2);
  console.log('  ✓ stats 记录总批数');
  passed += 9;
}

console.log(`\n✅ 全部通过（${passed} 项断言）`);
