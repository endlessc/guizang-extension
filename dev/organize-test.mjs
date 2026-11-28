#!/usr/bin/env node
/**
 * 整理计划（lib/organize.js）的断言（阶段 3）。
 *
 * 这个模块不碰 chrome、不调模型，所以能在 Node 里直接测：
 * 预筛、状态判定（ready/unsure/skip/blocked）、统计、分组、剔除与改判。
 *
 * 用法：node dev/organize-test.mjs
 */

import {
  preselect, buildPlan, groupOps, dropOp, overrideOp, foldersForCodes, readyOps,
  subCodeFor, splitSubs, applySubs, planFolders, deriveSubs, schemeCreated, extendTargets,
  leftoverFolders, estimateLeftovers,
  UNSURE_THRESHOLD, MAX_CANDIDATES,
} from '../lib/organize.js';

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

const scheme = [
  { code: '000', name: '综合与工具' },
  { code: '100', name: '编程与后端' },
  { code: '500', name: '人工智能' },
];

const item = (id, code, extra = {}) => ({
  id, code, folderId: 'f' + (code || 'inbox'), title: 'T' + id, url: 'https://e/' + id, ...extra,
});

console.log('预筛');
{
  const items = [item('1', ''), item('2', '100'), item('3', '')];
  eq('inbox 只挑未分类', preselect(items).candidates.map((i) => i.id), ['1', '3']);
  eq('all 全都要', preselect(items, { scope: 'all' }).candidates.length, 3);

  // 方案外的排前面：它们归位后就离开候选池，下一轮才会浮出后面的条目
  const mixed = [item('a', '100'), item('b', 'F1'), item('c', '500'), item('d', 'F2')];
  const all = preselect(mixed, { scope: 'all', codes: new Set(['000', '100', '500']) });
  eq('方案外优先', all.candidates.map((i) => i.id), ['b', 'd', 'a', 'c']);
  eq('方案外单独计数', all.outside, 2);
  eq('候选池总数不受排序影响', all.pool, 4);
  const planAll = buildPlan({ items: mixed, scheme, scope: 'all', suggestions: {}, blocked: new Set(), now: 7 });
  eq('计划里带方案外条数', [planAll.outside, planAll.pool], [2, 4]);

  // 每轮上限：可调，也可一次跑完
  const small = preselect(mixed, { scope: 'all', codes: new Set(['000', '100', '500']), limit: 2 });
  eq('limit 决定本轮条数', small.candidates.length, 2);
  eq('limit 之外记进 overflow', small.overflow, 2);
  const everything = preselect(mixed, { scope: 'all', codes: new Set(['000', '100', '500']), limit: 'all' });
  eq('limit=all 不设上限', [everything.candidates.length, everything.overflow], [4, 0]);
  const planAllLimit = buildPlan({ items: mixed, scheme, scope: 'all', suggestions: {}, blocked: new Set(), limit: 'all', now: 8 });
  eq('计划里记录本轮上限', [planAllLimit.limit, planAllLimit.pool], [4, 4]);

  const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => item('x' + i, ''));
  const r = preselect(many);
  eq('超出上限被截断', [r.candidates.length, r.overflow], [MAX_CANDIDATES, 5]);
}

console.log('状态判定');
{
  const items = [item('1', ''), item('2', ''), item('3', ''), item('4', ''), item('5', '100')];
  const suggestions = {
    1: { code: '100', conf: 0.9, source: 'model', reason: 'ok' },
    2: { code: '500', conf: UNSURE_THRESHOLD - 0.01, source: 'heuristic' },
    4: { code: '000', conf: 0.8, source: 'model' },
    5: { code: '100', conf: 0.9, source: 'model' }, // 建议=现状，应被丢掉
  };
  const plan = buildPlan({ items, scheme, suggestions, blocked: new Set(['4']), now: 1000 });

  eq('计划 id 带时间戳', plan.id, 'p' + (1000).toString(36));
  eq('建议=现状的不产生动作', plan.ops.some((o) => o.id === '5'), false);
  eq('高置信 → ready', plan.ops.find((o) => o.id === '1').status, 'ready');
  eq('低置信 → unsure', plan.ops.find((o) => o.id === '2').status, 'unsure');
  eq('拿不到建议 → skip', plan.ops.find((o) => o.id === '3').status, 'skip');
  eq('受管 → blocked', plan.ops.find((o) => o.id === '4').status, 'blocked');
  eq('blocked 的说明', plan.ops.find((o) => o.id === '4').reason, '受管书签，无法移动');
  eq('统计', plan.stats, { total: 4, ready: 1, unsure: 1, blocked: 1, skip: 1 });
  eq('目标类目带名字', plan.ops.find((o) => o.id === '1').to, { code: '100', name: '编程与后端', missing: false });
  eq('来源保留', plan.ops.find((o) => o.id === '1').source, 'model');
  eq('scheme 快照保留 code/name/parent', Object.keys(plan.scheme[0]).sort(), ['code', 'name', 'parent']);

  // 数据血缘透传（model / promptVersion / schemeId）
  const lineagePlan = buildPlan({
    items: [item('1', '')],
    scheme,
    schemeId: 'dewey',
    suggestions: { 1: { code: '100', conf: 0.9, source: 'model', model: 'deepseek-chat', promptVersion: 'p2', reason: 'ok' } },
    now: 1001,
  });
  const lOp = lineagePlan.ops[0];
  eq('计划记录 schemeId', lineagePlan.schemeId, 'dewey');
  eq('计划 op 保留模型与提示词血缘', [lOp.model, lOp.promptVersion], ['deepseek-chat', 'p2']);
  const ov = overrideOp(lineagePlan, '1', '500').ops[0];
  eq('人工改判清空模型血缘', [ov.source, ov.model, ov.promptVersion], ['user', '', '']);

  // fresh 跨方案同码异名（杜威 100 编程与后端 → PARA 100 项目）不得被跳过，且标 missing
  const para = [{ code: '100', name: '项目' }, { code: '300', name: '资源' }];
  const freshCross = buildPlan({
    items: [item('x', '100')],
    scheme: para,
    schemeId: 'para',
    scope: 'scheme',
    suggestions: { x: { code: '100', conf: 0.9, source: 'model' } },
    existing: new Set(['100']),
    folderNames: new Map([['100', '编程与后端']]),
    ignoreCurrent: true,
    now: 1002,
  });
  eq('fresh 同码异名不被当成原地不动跳过', freshCross.ops.length, 1);
  eq('fresh 同码异名标为 missing 需新建', freshCross.ops[0].to.missing, true);
}

console.log('按方案建档：缺的目录标出来，执行时再建');
{
  // 方案里有 000/100/500，但书签栏里只建了 000，另外两个要到执行时创建
  const items = [item('a', ''), item('b', ''), item('c', '')];
  const suggestions = {
    a: { code: '100', conf: 0.9, source: 'model' },
    b: { code: '500', conf: 0.9, source: 'model' },
    c: { code: '000', conf: 0.9, source: 'model' },
  };
  const plan = buildPlan({
    items, scheme, scope: 'all', suggestions, blocked: new Set(), existing: new Set(['000']), now: 9,
  });
  eq('缺目录的目标被标 missing', plan.ops.filter((o) => o.to.missing).map((o) => o.to.code).sort(), ['100', '500']);
  eq('已有目录不标', plan.ops.find((o) => o.to.code === '000').to.missing, false);
  eq('将新建的目录清单去重且带名字', plan.created, [
    { code: '100', name: '编程与后端' }, { code: '500', name: '人工智能' },
  ]);
  // 分批跑时可能只有子类有可执行条目：父目录必须一起补建，否则子目录没处放
  const tree = [
    { code: '100', name: '编程与后端', parent: null },
    { code: '110', name: 'Java', parent: '100' },
    { code: '111', name: 'JVM', parent: '110' },
    { code: '200', name: '资讯', parent: null },
  ];
  eq('父目录一并展开且父在前', foldersForCodes(['111', '200'], tree), [
    { code: '100', name: '编程与后端', parent: null },
    { code: '200', name: '资讯', parent: null },
    { code: '110', name: 'Java', parent: '100' },
    { code: '111', name: 'JVM', parent: '110' },
  ]);
  eq('重复 code 只展开一次', foldersForCodes(['110', '111', '110'], tree).map((f) => f.code), ['100', '110', '111']);
  eq('方案里没有的 code 兜底用 code 当名字', foldersForCodes(['999'], tree), [{ code: '999', name: '999', parent: null }]);

  // 二级：目标只有子类时，「将新建」也要把父级算进去
  const layered = [
    { code: '100', name: '编程与后端', parent: null },
    { code: '110', name: 'Java', parent: '100' },
  ];
  const twoLevel = buildPlan({
    items: [item('z', '')],
    scheme: layered,
    scope: 'all',
    suggestions: { z: { code: '110', conf: 0.9, source: 'model' } },
    blocked: new Set(),
    existing: new Set(),
    now: 11,
  });
  eq('二级目标会连父级一起计入新建', twoLevel.created.map((f) => f.code), ['100', '110']);
  eq('父级已存在时只报子级', buildPlan({
    items: [item('y', '')],
    scheme: layered,
    scope: 'all',
    suggestions: { y: { code: '110', conf: 0.9, source: 'model' } },
    blocked: new Set(),
    existing: new Set(['100']),
    now: 12,
  }).created.map((f) => f.code), ['110']);

  const plain = buildPlan({ items, scheme, scope: 'all', suggestions, blocked: new Set(), now: 9 });
  eq('不传 existing 时视为都已存在', plain.created.length, 0);

  // 只有会执行的条目才计入「将要新建」；拿不准的不算，改判后才算
  const mixed = buildPlan({
    items,
    scheme,
    scope: 'all',
    suggestions: {
      a: { code: '100', conf: 0.9, source: 'model' },   // 可移，缺目录
      b: { code: '000', conf: 0.9, source: 'model' },   // 可移，目录已存在
      c: { code: '100', conf: 0.2, source: 'heuristic' }, // 拿不准，不算新建
    },
    blocked: new Set(),
    existing: new Set(['000']),
    now: 10,
  });
  eq('拿不准的不计入新建', mixed.created.map((f) => f.code), ['100']);
  const fixed = overrideOp(mixed, 'c', '500', { existing: new Set(['000']) });
  eq('改判后新建清单跟着变', fixed.created.map((f) => f.code).sort(), ['100', '500']);
  const dropped = dropOp(fixed, 'a');
  eq('剔除后新建清单少一个', dropped.created.map((f) => f.code), ['500']);
}

console.log('二级拆分：写回计划并参与建目录');
{
  eq('二级编码 = 父首位 + 10n', [subCodeFor('100', 0), subCodeFor('100', 2), subCodeFor('000', 1)], ['110', '130', '020']);
  const items = [item('a', ''), item('b', ''), item('c', '')];
  const suggestions = {
    a: { code: '100', conf: 0.9, source: 'model' },
    b: { code: '100', conf: 0.9, source: 'model' },
    c: { code: '100', conf: 0.9, source: 'model' },
  };
  const plan = buildPlan({ items, scheme, scope: 'all', suggestions, blocked: new Set(), existing: new Set(), now: 30 });
  eq('拆分前没有二级', plan.subs, undefined);
  const split = applySubs(plan, {
    '100': { subs: [{ name: 'Java' }, { name: '数据库' }], assign: { a: 0, b: 0, c: 1 } },
  });
  eq('一级下记下两个二级', split.subs['100'].map((x) => [x.code, x.name]), [['110', 'Java'], ['120', '数据库']]);
  eq('条目挂到二级', split.ops.map((o) => (o.to.sub ? o.to.sub.code : '')).sort(), ['110', '110', '120']);
  eq('将新建含一级与二级', split.created.map((f) => f.code), ['100', '110', '120']);
  eq('改判/剔除后二级编码不变', applySubs(plan, { '100': { subs: [{ name: 'X' }], assign: {} } }).subs['100'][0].code, '110');
}

console.log('提交前：这次要保证存在哪些目录');
{
  const plan = {
    scheme: [{ code: '100', name: '编程', parent: null }],
    subs: { '100': [{ code: '110', name: 'Java' }, { code: '120', name: '数据库' }] },
  };
  eq('二级目标连父级一起列出', planFolders(plan, [
    { to: { code: '100', sub: { code: '110' } } },
    { to: { code: '100', sub: { code: '110' } } },
  ]).map((f) => f.code), ['100', '110']);
  eq('一级目标只列自己', planFolders(plan, [{ to: { code: '100' } }]).map((f) => f.code), ['100']);
  eq('没有目标就没有目录', planFolders(plan, []), []);
}

console.log('执行集合：可选择连「拿不准」一起');
{
  const items = [item('r1', ''), item('u1', ''), item('b1', ''), item('s1', '')];
  const suggestions = {
    r1: { code: '100', conf: 0.9, source: 'model' },
    u1: { code: '500', conf: 0.2, source: 'heuristic' },
    s1: { code: '000', conf: 0.9, source: 'model' },
  };
  const plan = buildPlan({ items, scheme, suggestions, blocked: new Set(['b1']), now: 20 });
  eq('默认只执行 ready', readyOps(plan).map((o) => o.id).sort(), ['r1', 's1']);
  eq('拿不准默认不执行', readyOps(plan).some((o) => o.id === 'u1'), false);
  eq('打开开关后连拿不准一起', readyOps(plan, { includeUnsure: true }).map((o) => o.id).sort(), ['r1', 's1', 'u1']);
}

console.log('分组与排序');
{
  const plan = {
    id: 'p', at: 0, scope: 'inbox', scheme, overflow: 0,
    ops: [
      { id: 'a', to: { code: '500', name: '人工智能' }, status: 'ready' },
      { id: 'b', to: { code: '000', name: '综合与工具' }, status: 'ready' },
      { id: 'c', to: null, status: 'skip' },
      { id: 'd', to: { code: '500', name: '人工智能' }, status: 'unsure' },
    ],
    stats: {},
  };
  const groups = groupOps(plan);
  eq('三个分组', groups.map((g) => g.code), ['000', '500', '—']);
  eq('同组归拢', groups.find((g) => g.code === '500').ops.map((o) => o.id), ['a', 'd']);
  eq('未决定的排最后', groups[2].name, '未决定');
}

console.log('剔除与改判');
{
  const plan = buildPlan({
    items: [item('1', ''), item('2', '')],
    scheme,
    suggestions: { 1: { code: '000', conf: 0.9 }, 2: { code: '000', conf: 0.9 } },
    now: 5,
  });
  const after = dropOp(plan, '1');
  eq('剔除一条', after.ops.map((o) => o.id), ['2']);
  eq('不影响原计划', plan.ops.length, 2);
  eq('剔除后统计跟着变', [after.stats.total, after.stats.ready], [1, 1]);

  const changed = overrideOp(plan, '2', '500');
  const op = changed.ops.find((o) => o.id === '2');
  eq('改判目标', op.to, { code: '500', name: '人工智能', missing: false });
  eq('改判后变成 ready 且来源是 user', [op.status, op.source, op.conf], ['ready', 'user', 1]);
  eq('改判后统计重算', [changed.stats.total, changed.stats.ready], [2, 2]);
}

console.log('拆二级：子类编码');
{
  const subs = splitSubs('000', [{ name: '系统工具' }, { name: '浏览器', hint: '常驻' }]);
  eq('编码是父首位 + 10n', subs.map((s) => s.code), ['010', '020']);
  eq('类名与 hint 保留', [subs[0].name, subs[1].hint], ['系统工具', '常驻']);

  // 曾经的 bug：把类目名当父编码传进来，算出「综10」，目录建了但认不出、条目一条都搬不动
  eq('拿类目名当父编码 → 不给编码', splitSubs('综合与工具', [{ name: '系统工具' }]), []);
  eq('字母编码不支持二级', splitSubs('T', [{ name: '前端' }]), []);
  eq('最多 9 个二级', splitSubs('100', Array.from({ length: 12 }, (_, i) => ({ name: '子' + i }))).length, 9);
  eq('没名字的丢掉、编码不重排', splitSubs('100', [{ name: '  ' }, { name: '真' }]).map((s) => s.code), ['120']);
}

console.log('按收藏派生二级（生成计划时自动跑）');
{
  const sch = [{ code: '100', name: '编程' }, { code: '200', name: '数据' }, { code: 'T', name: '技术' }];
  const mk = (n, code) => Array.from({ length: n }, (_, i) => ({ id: code + i, title: 't', url: 'https://a.com/' + i, host: 'a.com', code: '' }));
  const items = [...mk(7, 'a'), ...mk(3, 'b'), ...mk(7, 'c')];
  const suggestions = {
    ...Object.fromEntries(mk(7, 'a').map((x) => [x.id, { code: '100', conf: 0.9 }])),
    ...Object.fromEntries(mk(3, 'b').map((x) => [x.id, { code: '200', conf: 0.9 }])),
    ...Object.fromEntries(mk(7, 'c').map((x) => [x.id, { code: 'T', conf: 0.9 }])),
  };
  const plan = buildPlan({ items, scheme: sch, scope: 'scheme', suggestions, existing: new Set() });

  const calls = [];
  const derive = async ({ code, items: part }) => {
    calls.push([code, part.length]);
    const subs = [{ name: '语言' }, { name: '框架' }];
    return { subs, assign: Object.fromEntries(part.map((x, i) => [x.id, i % 2])) };
  };
  const r = await deriveSubs(plan, items, derive, { minPerTop: 6 });
  eq('只处理 ≥6 条且是数字编码的类目', calls, [['100', 7]]);
  eq('子类编码按父首位 + 10n', r.plan.subs['100'].map((x) => x.code), ['110', '120']);
  eq('条目挂到二级上', r.plan.ops.filter((o) => o.to.code === '100' && o.to.sub).length, 7);
  eq('父与子（以及其它要建的一级）一起进新建清单', r.plan.created.map((c) => c.code).sort(), ['100', '110', '120', '200', 'T']);
  eq('统计报出处理了几个类目', [r.groups, r.split], [1, 1]);

  const bad = await deriveSubs(plan, items, async () => { throw new Error('模型挂了'); }, { minPerTop: 6 });
  eq('某一个类目分不动，不影响整张计划', [bad.split, bad.plan.ops.filter((o) => o.to.sub).length], [0, 0]);

  const skippedCalls = [];
  const skipped = await deriveSubs(
    plan,
    items,
    async ({ code }) => { skippedCalls.push(code); return { subs: [{ name: 'A' }, { name: 'B' }], assign: {} }; },
    { minPerTop: 6, existingParents: new Set(['100']) },
  );
  eq('已有二级目录的父类不再重新派生，防止同码撞车', [skippedCalls.length, skipped.groups], [0, 0]);
}

console.log('目录结构的两种来源');
{
  const full = [
    { code: '100', name: '编程' },
    { code: '110', name: '语言', parent: '100' },
    { code: '200', name: '数据' },
  ];
  eq('默认分类：缺几个建几个（含空的二级）', schemeCreated(full, new Set(['100'])), [
    { code: '110', name: '语言' }, { code: '200', name: '数据' },
  ]);
  eq('全建过了就是空清单', schemeCreated(full, new Set(['100', '110', '200'])), []);
  eq('空方案不报错', schemeCreated(undefined, new Set()), []);
}

console.log('判定池：方案类目 + 挂在下头的现存二级');
{
  const scheme = [{ code: '000', name: '综合与工具' }, { code: '100', name: '编程' }];
  const dirs = [
    { code: '000', name: '综合与工具' },
    { code: '100', name: '编程' },
    { code: '010', name: '效率工具' },
    { code: '020', name: '开发与编程' },
    { code: 'F1', name: '杂项' },
  ];
  const parentOf = { '010': '000', '020': '000' };
  const targets = extendTargets(scheme, dirs, parentOf);
  eq('并进两个现存二级', targets.map((f) => f.code), ['000', '100', '010', '020']);
  eq('二级记住父级，建目录时父在前', targets.find((f) => f.code === '010').parent, '000');
  eq('与方案无关的目录不混进来', targets.some((f) => f.code === 'F1'), false);
  eq('方案已定义的编码不重复', extendTargets(
    [{ code: '100', name: '编程' }, { code: '110', name: '语言', parent: '100' }],
    [{ code: '110', name: '语言' }],
    { '110': '100' },
  ).filter((f) => f.code === '110').length, 1);
}

console.log('全新生成：搬空后的旧目录');
{
  const dirs = [
    { code: '000', name: '综合与工具', id: '10', depth: 1 },
    { code: '010', name: '效率工具', id: '11', depth: 2 },
    { code: '020', name: '开发与编程', id: '12', depth: 2 },
    { code: '100', name: '编程', id: '20', depth: 1 },
  ];
  const items = [{ id: 'a', code: '100' }, { id: 'b', code: '010' }];
  const keep = new Set(['000', '100']);

  eq('没有书签留下的旧类目才算', leftoverFolders(dirs, items, keep).map((f) => f.code), ['020']);
  eq('按深度从深到浅（先删子目录）', leftoverFolders(dirs, [], new Set(['100'])).map((f) => f.code), ['010', '020', '000']);

  const est = estimateLeftovers(dirs, items, keep, new Set(['b']));
  eq('预估：这轮会搬走的条目不算留下', est.map((f) => f.code), ['010', '020']);
  eq('在新结构里的目录一律保留', leftoverFolders(dirs, [], keep).some((f) => keep.has(f.code)), false);
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
