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
  preselect, buildPlan, groupOps, dropOp, overrideOp,
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
  eq('目标类目带名字', plan.ops.find((o) => o.id === '1').to, { code: '100', name: '编程与后端' });
  eq('来源保留', plan.ops.find((o) => o.id === '1').source, 'model');
  eq('scheme 快照只留 code+name', Object.keys(plan.scheme[0]).sort(), ['code', 'name']);
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
  eq('改判目标', op.to, { code: '500', name: '人工智能' });
  eq('改判后变成 ready 且来源是 user', [op.status, op.source, op.conf], ['ready', 'user', 1]);
  eq('改判后统计重算', [changed.stats.total, changed.stats.ready], [2, 2]);
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
