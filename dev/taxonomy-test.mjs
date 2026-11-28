#!/usr/bin/env node
/**
 * lib/taxonomy.js 的断言（纯函数，不需要浏览器）。
 * 覆盖：校验、计数、minPerCategory 剪枝、maxDepth 折叠、maxTop 超限、
 *       受控词表合并、toScheme 折装顺序。
 *
 * 用法：node dev/taxonomy-test.mjs
 */

import {
  createTaxonomy, recount, pruneTaxonomy, limitTop, foldOverflow,
  normalizeName, normalizeNames, toScheme, computeStats, groupMembers, validateTaxonomy,
} from '../lib/taxonomy.js';

let failed = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}\n      实际：${a}\n      期望：${b}`);
  }
}
function throws(label, fn, keyword) {
  try { fn(); eq(label, '没有抛错', '应当抛错'); }
  catch (e) { eq(label, String(e.message).includes(keyword), true); }
}

const A = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
const tree = [
  { code: '000', name: '综合与工具', members: A },
  { code: '010', name: '开发工具', parent: '000', members: ['b1', 'b2', 'b3'] },
  { code: '020', name: '网盘与下载', parent: '000', members: ['c1', 'c2'] },
  { code: '030', name: '设计与素材', parent: '000', members: [] },
  { code: '031', name: '字体', parent: '030', members: ['d1'] },
  { code: '100', name: '编程与后端', members: ['e1', 'e2'] },
  { code: '110', name: 'Java', parent: '100', members: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'] },
  { code: '200', name: '数据', members: ['g1'] },
];

console.log('校验');
{
  throws('编码重复要报错', () => validateTaxonomy([{ code: '1' }, { code: '1' }]), '重复');
  throws('父类目不存在要报错', () => validateTaxonomy([{ code: '1', parent: '9' }]), '父类目');
  throws('成环要报错', () => validateTaxonomy([
    { code: '1', parent: '2' }, { code: '2', parent: '1' },
  ]), '成环');
  eq('合法结构返回 true', validateTaxonomy(tree), true);
}

console.log('计数与统计');
{
  const tx = createTaxonomy({ id: 't1', name: '测试', nodes: tree });
  const by = Object.fromEntries(tx.nodes.map((n) => [n.code, n]));
  eq('直属成员数', by['000'].count, 6);
  eq('含子类总数', by['000'].total, 6 + 3 + 2 + 1 + 0);
  eq('层级深度', [by['000'].depth, by['010'].depth, by['031'].depth], [0, 1, 2]);
  eq('统计里的最大深度', tx.stats.maxDepth, 2);
  eq('只有 1 条的类目数', tx.stats.singles, 3); // 030(0)、031(1)、200(1)
  // 顶层各计数：000=12、100=8、200=1
  eq('总成员数', tx.stats.members, 21);
}

console.log('minPerCategory 剪枝');
{
  const { taxonomy, removed, dropped } = pruneTaxonomy(createTaxonomy({ id: 't2', nodes: tree }), { minPerCategory: 5 });
  const codes = taxonomy.nodes.map((n) => n.code).sort();
  eq('太小的类目被删', codes, ['000', '100', '110']);
  // 010 只有 3 条（< 5）也保不住，成员并进 000
  eq('删掉的编码', removed.sort(), ['010', '020', '030', '031', '200']);
  eq('顶层没救的成员进 dropped', dropped, ['g1']);
  const by = Object.fromEntries(taxonomy.nodes.map((n) => [n.code, n]));
  eq('成员并入父类目', by['000'].members.length, 6 + 3 + 2 + 1);
  eq('父类目靠吸收活了下来', by['000'].total, 12);
  eq('子类目够大就保留', by['110'].total, 6);
  eq('剪枝后重新统计', taxonomy.stats.categories, 3);
}

console.log('maxDepth 折叠');
{
  const deep = [
    { code: 'T', name: '技术', members: [] },
    { code: 'TA', name: '一级', parent: 'T', members: [] },
    { code: 'TAA', name: '二级', parent: 'TA', members: ['x1', 'x2'] },
    { code: 'TAAB', name: '三级', parent: 'TAA', members: ['x3'] },
  ];
  const { taxonomy } = pruneTaxonomy(createTaxonomy({ id: 't3', nodes: deep }), { minPerCategory: 1, maxDepth: 1 });
  const by = Object.fromEntries(taxonomy.nodes.map((n) => [n.code, n]));
  eq('超深节点被折叠', Object.keys(by).sort(), ['T', 'TA']);
  eq('成员提回允许的最深层', by['TA'].members.sort(), ['x1', 'x2', 'x3']);
}

console.log('maxTop 超限');
{
  const many = Array.from({ length: 15 }, (_, i) => ({
    code: String(i * 10).padStart(3, '0'),
    name: '类' + i,
    members: Array.from({ length: 10 + i }, (_, k) => `m${i}_${k}`),
  }));
  const tx = createTaxonomy({ id: 't4', nodes: many, params: { maxTop: 12 } });
  const { kept, overflow } = limitTop(tx);
  eq('保留 12 个顶层', kept.nodes.length, 12);
  eq('挤出去 3 个', overflow.length, 3);
  // 测试数据里 i 越大成员越多，所以被挤出去的是成员最少的三个
  eq('挤出去的是成员最少的三个', overflow.sort(), ['000', '010', '020']);
  eq('保留下来的重新统计', kept.stats.topCount, 12);
}

console.log('foldOverflow 兜底');
{
  const many = [
    { code: '100', name: '大', members: ['a'] },
    { code: '200', name: '小', members: ['b'] },
    { code: '300', name: '更小', members: ['c', 'd'] },
  ];
  const tx = createTaxonomy({ id: 't5', nodes: many });
  const folded = foldOverflow(tx, ['200', '300'], { code: '900', name: '其他' });
  const by = Object.fromEntries(folded.nodes.map((n) => [n.code, n]));
  eq('兜底类目被建出来', Boolean(by['900']), true);
  eq('成员被搬进兜底类目', by['900'].members.sort(), ['b', 'c', 'd']);
  eq('被折叠的类目已移除', Object.keys(by).sort(), ['100', '900']);
}

console.log('受控词表');
{
  eq('同义词映射到优选词', normalizeName('人工智能', { '人工智能': 'AI' }), 'AI');
  eq('大小写不敏感', normalizeName('A.I.', { 'a.i.': 'AI' }), 'AI');
  eq('没命中就原样返回', normalizeName('  前端  '), '前端');

  const tx = createTaxonomy({
    id: 't6',
    vocab: { '人工智能': 'AI', 'ai': 'AI' },
    nodes: [
      { code: '500', name: '人工智能', members: ['m1'] },
      { code: '510', name: 'ai', members: ['m2'] },
    ],
  });
  const merged = normalizeNames(tx);
  eq('重名合并成一个类目', merged.nodes.length, 1);
  eq('成员合并', merged.nodes[0].members.sort(), ['m1', 'm2']);
  eq('名字取优选词', merged.nodes[0].name, 'AI');
}

console.log('toScheme 折装');
{
  const tx = createTaxonomy({ id: 'tx9', name: '我的分类', nodes: tree });
  const scheme = toScheme(tx);
  eq('父在子前', scheme.folders.map((f) => f.code), ['000', '010', '020', '030', '031', '100', '110', '200']);
  eq('纯数字走 digit', scheme.kind, 'digit');
  eq('带上 custom 标记', scheme.custom, true);
  eq('hint 保留', scheme.folders.every((f) => typeof f.hint === 'string'), true);
  eq('父方案记下来', scheme.parentSchemeId, '');

  const mixed = toScheme(createTaxonomy({
    id: 'tx10',
    nodes: [{ code: 'T', name: '技术', members: [] }, { code: '100', name: '编程', members: [] }],
  }));
  eq('混进字母就走 letter', mixed.kind, 'letter');
}

console.log('预览用分组');
{
  const tx = recount(createTaxonomy({ id: 'tx11', nodes: tree }));
  const rows = groupMembers(tx);
  eq('按编码排序', rows[0].code, '000');
  eq('带上总数', rows.find((r) => r.code === '000').total, 12);
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
