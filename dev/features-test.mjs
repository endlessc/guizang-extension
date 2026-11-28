#!/usr/bin/env node
/**
 * v0.6 新增能力单元测试（纯函数，不依赖浏览器）：
 *   node dev/features-test.mjs
 */

import assert from 'node:assert/strict';
import { normalizeUrl, findDuplicates, duplicateIdSet, removableCount } from '../lib/dedup.js';
import { pinyinInitials, parseQuery, filterAndScore, buildOmniboxSuggestions } from '../lib/search.js';
import { toMarkdown, toSelectionMarkdown, toNetscapeHtml } from '../lib/export.js';
import { normalizeMeta, collectAllTags, remapRecordById, recordOverride, matchLearned, migrateLearned, pickSerendipity, analyzeUsage } from '../lib/meta.js';
import { parseHeadHtml, isWeakTitle, cleanTitleLocal } from '../lib/head.js';
import { sanitizeCustomScheme, getScheme, parseOptsOf, parseSchemeLines } from '../lib/schemes.js';
import { normalizeBase } from '../lib/llm.js';
import { classifyHeuristic, classifyWithModel, parseSubNames, parseSubAssign, buildSubAssignMessages, PROMPT_VERSION, SELECTIVE_THRESHOLD } from '../lib/llm.js';
import { validateSnapshot, rebuildSubtree } from '../lib/backup.js';
import { sampleOps } from '../lib/organize.js';
import { parseTree, treeOrder, familyOf, groupByCodeShown } from '../lib/tree.js';

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
test('改判记忆忽略公共大站、记住专属域名，且换方案按类名显式迁移', () => {
  let l = recordOverride(null, { host: 'github.com' }, '100');
  assert.equal(Object.keys(l.domains).length, 0);
  l = recordOverride(l, { host: 'docs.rs' }, '100');
  l = recordOverride(l, { host: 'tool.example' }, '000');
  const hit = matchLearned(l, { host: 'docs.rs' }, new Set(['100', '500']));
  assert.equal(hit.code, '100');
  assert.equal(hit.source, 'learned');
  assert.equal(hit.model, '');
  assert.equal(hit.promptVersion, '');

  // 杜威 100(编程与后端) 切到 PARA 100(项目)：同码不同义必须作废，不能高置信度错判
  const toPara = migrateLearned(l, {
    from: [{ code: '000', name: '综合与工具' }, { code: '100', name: '编程与后端' }],
    to: [{ code: '100', name: '项目' }, { code: '300', name: '资源' }],
  });
  assert.equal(toPara.mapped, 0);
  assert.equal(toPara.dropped, 2);
  assert.deepEqual(toPara.learned.domains, {});

  // 切到同名类目不同编码的方案（如中图法 Z 综合与工具）：同名换码保留，不同名作废
  const toClc = migrateLearned(l, {
    from: [{ code: '000', name: '综合与工具' }, { code: '100', name: '编程与后端' }],
    to: [{ code: 'Z', name: '综合与工具' }, { code: 'T', name: '工业技术' }],
  });
  assert.equal(toClc.mapped, 1);
  assert.equal(toClc.dropped, 1);
  assert.equal(toClc.learned.domains['tool.example'].code, 'Z');
  assert.equal(toClc.learned.domains['docs.rs'], undefined);
});
test('替换恢复后按新旧节点 ID 映射保留旁挂元数据', () => {
  const oldMeta = {
    b1: { tags: ['rust'], note: '核心文档', star: true },
    b2: { tags: ['ai'], note: '', star: false },
  };
  const { record, remapped } = remapRecordById(oldMeta, new Map([['b1', 'new_b1']]));
  assert.equal(remapped, 1);
  assert.deepEqual(record.new_b1.tags, ['rust']);
  assert.equal(record.b2, undefined);
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

console.log('0. 术语对齐：parseTree 的目录投影叫 folderScheme');
test('parseTree 同时提供 folderScheme 与兼容别名', () => {
  const bar = { id: '1', title: '书签栏', children: [{ id: 'f1', title: '100 编程与后端', children: [] }] };
  const tree = [{ id: '0', title: '', children: [bar] }];
  const r = parseTree(tree, {});
  assert.deepEqual(r.folderScheme.map((f) => f.code), ['100']);
  assert.equal(r.scheme, r.folderScheme);
});

console.log('6a. Base URL 归一化');
test('只给域名时自动补 /v1', () => {
  assert.equal(normalizeBase('https://api.siliconflow.cn'), 'https://api.siliconflow.cn/v1');
  assert.equal(normalizeBase('https://api.siliconflow.cn/'), 'https://api.siliconflow.cn/v1');
  assert.equal(normalizeBase('http://localhost:11434'), 'http://localhost:11434/v1');
});
test('已带路径的不要动', () => {
  assert.equal(normalizeBase('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBase('https://x.com/openai/v1/'), 'https://x.com/openai/v1');
});

console.log('6b. 自定义方案支持二级（缩进语法）');
test('缩进行挂在上一条一级类目下', () => {
  const rows = parseSchemeLines('100 工程 | 后端\n  110 Java | JVM\n  120 数据库\n200 资讯');
  assert.deepEqual(rows.map((r) => [r.code, r.parent || '']), [['100', ''], ['110', '100'], ['120', '100'], ['200', '']]);
});
test('二级只挂最近的一级，缩进三级会被拒', () => {
  const clean = sanitizeCustomScheme({
    name: '两层',
    folders: [
      { code: '100', name: '工程' },
      { code: '110', name: 'Java', parent: '100' },
      { code: '111', name: 'JVM', parent: '110' },
    ],
  });
  assert.deepEqual(clean.folders.map((f) => [f.code, f.parent || '']), [['100', ''], ['110', '100']]);
});
test('编码不符合「父首位 + 10n」的子类被丢掉', () => {
  const clean = sanitizeCustomScheme({
    name: 'x',
    folders: [{ code: '100', name: '工程' }, { code: '210', name: '错位', parent: '100' }],
  });
  assert.deepEqual(clean.folders.map((f) => f.code), ['100']);
});
test('父类不存在时子类被丢掉', () => {
  const clean = sanitizeCustomScheme({
    name: 'x',
    folders: [{ code: '100', name: '工程' }, { code: '110', name: '孤儿', parent: '999' }],
  });
  assert.deepEqual(clean.folders.map((f) => f.code), ['100']);
});
test('字母编码不支持二级', () => {
  const clean = sanitizeCustomScheme({
    name: 'x', folders: [{ code: 'B', name: '哲学' }, { code: 'B10', name: '子', parent: 'B' }],
  });
  assert.deepEqual(clean.folders.map((f) => f.code), ['B']);
});
test('每个父类最多 9 个二级', () => {
  const rows = [{ code: '100', name: '工程' }];
  for (let i = 1; i <= 10; i += 1) rows.push({ code: '1' + String(i * 10).padStart(2, '0'), name: '子' + i, parent: '100' });
  const clean = sanitizeCustomScheme({ name: 'x', folders: rows });
  assert.equal(clean.folders.filter((f) => f.parent).length, 9);
});

console.log('6c. 二级拆分两段式：先定名，再分块对号');
test('抽样等距且不重复', () => {
  const ops = Array.from({ length: 175 }, (_, i) => ({ id: 'i' + i }));
  const sample = sampleOps(ops, 60);
  assert.equal(sample.length, 60);
  assert.equal(new Set(sample.map((x) => x.id)).size, 60);
  assert.equal(sample[0].id, 'i0');
  assert.deepEqual(sampleOps(ops.slice(0, 10), 60).length, 10);
});
test('子类名解析：截断到 5 个、丢掉空名', () => {
  const names = parseSubNames(JSON.stringify({ subs: [
    { name: '实时流媒体', hint: 'RTP RTMP' }, { name: '' }, { name: '抓包' },
    { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' },
  ] }));
  assert.deepEqual(names.map((x) => x.name), ['实时流媒体', '抓包', 'A', 'B', 'C']);
});
test('分配解析：越界下标与陌生 id 被丢弃', () => {
  const ops = [{ id: 'a' }, { id: 'b' }];
  const assign = parseSubAssign(JSON.stringify({ items: [
    { id: 'a', sub: 0 }, { id: 'b', sub: 3 }, { id: 'zzz', sub: 1 }, { id: 'b', sub: 1 },
  ] }), ops, 2);
  assert.deepEqual(assign, { a: 0, b: 1 });
});
test('分配请求只带这一块条目', () => {
  const ops = [{ id: 'a', title: 't', url: 'https://x/1' }];
  const msg = buildSubAssignMessages('网络与通信', [{ name: '抓包', hint: 'wireshark' }], ops);
  assert.match(msg[0].content, /0\. 抓包/);
  assert.match(msg[1].content, /"id":"a"/);
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

  // 每批条数可配：48 条用 48 一批只发 1 次请求
  let calls2 = 0;
  const started2 = [];
  const out4 = await classifyWithModel(items, scheme, settings, null, {
    batchSize: 48,
    call: async (st, messages) => {
      calls2 += 1;
      return replyOf(messages, '100');
    },
    onBatchStart: (b, total) => started2.push([b, total]),
    stats: {},
  });
  assert.equal(out4.length, 48);
  assert.equal(calls2, 1, '48 条按 48/批 只应发一次请求');
  assert.deepEqual(started2, [[1, 1]]);
  console.log('  ✓ 每批条数可配（48 条 → 1 次请求）');

  // 越界的批大小会被夹到 4..200
  const out5 = await classifyWithModel(items.slice(0, 8), scheme, settings, null, {
    batchSize: 1000,
    call: async (st, messages) => replyOf(messages, '100'),
    stats: {},
  });
  assert.equal(out5.length, 8);
  console.log('  ✓ 批大小越界会被夹住');

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
  passed += 16;
}

console.log('9. 建议血缘：模型与提示词版本（lib/llm.js）');
{
  const scheme = [{ code: '100', name: '编程' }];
  const items = [{ id: 'a', title: 'Rust 所有权', host: 'a.com', url: 'https://a.com/1' }];
  const settings = { apiKey: 'k', baseUrl: 'http://mock', model: 'deepseek-chat' };
  const out = await classifyWithModel(items, scheme, settings, null, {
    call: async () => JSON.stringify({ items: [{ id: 'a', code: '100', conf: 0.9, reason: 'x' }] }),
  });
  assert.equal(out[0].model, 'deepseek-chat', '建议要记住是哪个模型判的');
  console.log('  ✓ 建议带模型名');
  assert.equal(out[0].promptVersion, PROMPT_VERSION, '建议要记住提示词版本');
  console.log('  ✓ 建议带提示词版本');
  const [h] = classifyHeuristic(items, scheme, { schemeId: 'dewey' });
  assert.equal(h.model, '', '本地规则没有模型血缘');
  console.log('  ✓ 本地规则不带模型名');
  assert.equal(h.promptVersion, '', '本地规则没有提示词版本');
  console.log('  ✓ 本地规则不带提示词版本');

  // 零关键词命中显式拒判：不强塞 000 或首个类目
  const [abstain] = classifyHeuristic(
    [{ id: 'u', title: '一串毫无信号的字符串', host: 'unknown.invalid', url: 'https://unknown.invalid/xyz', code: '' }],
    [{ code: '000', name: '综合与工具' }, { code: '100', name: '编程与后端' }],
    { schemeId: 'dewey' },
  );
  assert.equal(abstain.code, '', '零命中应显式拒判而非硬塞 000');
  assert.equal(abstain.conf, 0, '零命中置信度应为 0');
  assert.equal(SELECTIVE_THRESHOLD, 0.65, '统一选择性分类阈值为 0.65');
  console.log('  ✓ 本地规则零命中显式拒判（不强塞 000）');
  passed += 5;
}

console.log('10. 拆二级后的父子关系与展示顺序（lib/tree.js）');
{
  const tree = [{
    id: '0', title: '', children: [{
      id: '1', title: '书签栏', children: [
        {
          id: '10', title: '000 综合与工具', children: [
            { id: '11', title: '010 效率工具', children: [{ id: '111', title: 'a', url: 'https://a.com' }] },
            { id: '12', title: '020 开发与编程', children: [] },
          ],
        },
        { id: '20', title: '100 编程与后端', children: [] },
      ],
    }],
  }];
  const r = parseTree(tree);
  assert.equal(r.parentOf['010'], '000', '子文件夹要记下父编码');
  console.log('  ✓ 子文件夹记下父编码');
  assert.equal(r.parentOf['100'], undefined, '一级目录没有父编码');
  console.log('  ✓ 一级目录没有父编码');

  const ordered = treeOrder(r.folderScheme, r.parentOf);
  assert.deepEqual(ordered.map((f) => f.code), ['000', '010', '020', '100'], '子类紧跟父类');
  console.log('  ✓ 子类紧跟父类，不再散到列表末尾');
  assert.deepEqual(ordered.map((f) => f.level), [0, 1, 1, 0], '层级从 0 起算');
  console.log('  ✓ 层级从 0 起算');

  const cyc = treeOrder([{ code: 'A' }, { code: 'B' }], { A: 'B', B: 'A' });
  assert.equal(cyc.length, 2, '父子关系成环时也不能漏画');
  console.log('  ✓ 父子关系成环时也不漏画');

  // 全库分页：组头要报「本组共几条」，而不是「前 400 行里落了几条」
  const many = Array.from({ length: 65 }, (_, i) => ({ id: 'a' + i, code: '010' }));
  const few = Array.from({ length: 3 }, (_, i) => ({ id: 'b' + i, code: '020' }));
  const all = [...many, ...few];
  const scheme = [{ code: '010', name: '开发工具' }, { code: '020', name: '网盘' }];
  const truncated = new Set(many.slice(0, 9).map((it) => it.id));
  const g1 = groupByCodeShown(all, scheme, truncated);
  assert.deepEqual(g1.map((g) => [g.code, g.rows.length, g.total]), [['010', 9, 65]], '只画已显示的行，但报全组总数');
  console.log('  ✓ 组头报全组总数（9 / 共 65）');
  const g2 = groupByCodeShown(all, scheme, new Set(all.map((it) => it.id)));
  assert.deepEqual(g2.map((g) => g.total), [65, 3], '全部显示时两组都在');
  console.log('  ✓ 全部显示时不丢组');
  assert.deepEqual(groupByCodeShown(all, scheme, new Set()).length, 0, '默认不画空组');
  console.log('  ✓ 默认不画空组');

  // keepEmpty：列表当索引用时，组头要始终在，没显示的行只报总数
  const keep = groupByCodeShown(all, scheme, truncated, { keepEmpty: true });
  assert.deepEqual(keep.map((g) => [g.code, g.rows.length, g.total]), [['010', 9, 65], ['020', 0, 3]], '空组保留并报总数');
  console.log('  ✓ keepEmpty 时保留空组');
  assert.deepEqual(
    groupByCodeShown(all, scheme, new Set(), { keepEmpty: true }).map((g) => [g.code, g.rows.length]),
    [['010', 0], ['020', 0]],
    '一行未显示时两组都在',
  );
  console.log('  ✓ 一行未显示时组头仍在');

  // 安全恢复会建「归藏恢复 …」容器；里面的副本不该再被当成第二套类目
  const withRestore = [{
    id: '0', title: '', children: [{
      id: '1', title: '书签栏', children: [
        { id: '10', title: '000 综合与工具', children: [{ id: '101', title: 'a', url: 'https://a.com' }] },
        { id: '20', title: '归藏恢复 2026-11-28 22:53', children: [
          { id: '21', title: '000 综合与工具', children: [{ id: '211', title: 'b', url: 'https://b.com' }] },
        ] },
      ],
    }],
  }];
  const rr = parseTree(withRestore);
  assert.deepEqual(rr.folderScheme.map((f) => f.code), ['000'], '恢复副本里不认类目');
  assert.equal(rr.items.length, 1, '恢复副本里的书签不参与统计');
  console.log('  ✓ 归藏恢复容器被跳过');

  // 一级目录的「整枝」：自己 + 全部后代，聚合视图按它筛选
  assert.deepEqual([...familyOf('000', r.parentOf)].sort(), ['000', '010', '020'], '一级目录算上全部子类');
  console.log('  ✓ 一级目录算上全部子类');
  assert.deepEqual([...familyOf('010', r.parentOf)], ['010'], '叶子目录只有自己');
  console.log('  ✓ 叶子目录只有自己');
  assert.deepEqual([...familyOf('999', r.parentOf)], ['999'], '不存在的编码也返回自身');
  console.log('  ✓ 没有子类的编码返回自身');
  assert.deepEqual([...familyOf('', r.parentOf)], [], '空编码（待归类）不算任何类目');
  console.log('  ✓ 空编码不算类目');
  assert.equal(familyOf('A', { A: 'B', B: 'A' }).size, 2, '成环时不死循环');
  console.log('  ✓ 成环时不死循环');
  passed += 11;
}

console.log(`\n✅ 全部通过（${passed} 项断言）`);
