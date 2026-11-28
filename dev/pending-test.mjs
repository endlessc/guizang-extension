#!/usr/bin/env node
/**
 * 归类建议的迁移与容错（对应的断言）：
 *
 *   1. 换方案 → 按类名显式迁移，映射不了的才作废，两类计数都要报出来
 *   2. 读取时 → 目标编码不存在的建议被剔除
 *   3. 接受时 → 某一组目标找不到，不打断其它组
 *   4. 接受后 → 只有成功的那些建议被清掉
 *
 * 用法：node dev/pending-test.mjs
 */

import { migratePending, prunePending, groupPending, runAccept } from '../lib/pending.js';

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

const pend = {
  a: { code: 'F1', conf: 0.8 },
  b: { code: 'F2', conf: 0.7 },
  c: { code: 'F1', conf: 0.6 },
};

console.log('换方案 → 按类名迁移，映射不了才作废');
{
  const dewey = [
    { code: '000', name: '总论' },
    { code: '100', name: '哲学与心理学' },
    { code: '300', name: '社会科学' },
  ];
  const para = [
    { code: '100', name: '项目' },
    { code: '200', name: '领域' },
    { code: '300', name: '资源' },
  ];
  // 三个编码在 PARA 里都能找到同码，但类名全不同 —— 一个都不该被搬过去
  const r = migratePending(pend, { from: dewey, to: para });
  eq('同码不同义：不按编码硬映射', [r.mapped, r.dropped], [0, 3]);
  eq('全部作废但报出条数', Object.keys(r.pending).length, 0);
  eq('作废的 id 逐个报出', r.droppedIds.sort(), ['a', 'b', 'c']);

  const tech = [{ code: '100', name: '编程' }, { code: '200', name: '设计' }];
  const next = [{ code: 'A', name: '编程' }, { code: 'B', name: '资讯' }];
  const p2 = {
    x: { code: '100', conf: 0.9, source: 'model', model: 'deepseek-chat', promptVersion: 'p1', reason: '是技术文档' },
    y: { code: '200', conf: 0.5, source: 'heuristic', model: '', promptVersion: '' },
  };
  const r2 = migratePending(p2, { from: tech, to: next });
  eq('同名类目 → 换成新方案的编码', r2.pending.x.code, 'A');
  eq('两条：一条迁移一条作废', [r2.mapped, r2.dropped], [1, 1]);
  eq('新方案没有同名 → 该条作废', r2.pending.y, undefined);
  eq('建议上的血缘随迁移保留', [r2.pending.x.model, r2.pending.x.promptVersion], ['deepseek-chat', 'p1']);
  eq('理由与置信度也原样保留', [r2.pending.x.conf, r2.pending.x.reason], [0.9, '是技术文档']);

  const r3 = migratePending({ z: { code: '999' } }, { from: tech, to: next });
  eq('旧方案没有这个编码 → 作废', [r3.mapped, r3.dropped], [0, 1]);

  const r4 = migratePending({ n: { code: '' } }, { from: tech, to: next });
  eq('没有编码的建议 → 作废', [r4.mapped, r4.dropped], [0, 1]);

  const r5 = migratePending({}, { from: tech, to: next });
  eq('没有建议：两个计数都是 0', [Object.keys(r5.pending).length, r5.mapped, r5.dropped], [0, 0, 0]);

  const self = [{ code: 'F1', name: '甲' }, { code: 'F2', name: '乙' }];
  const r6 = migratePending(pend, { from: self, to: self });
  eq('同一套方案：编码原样、全部算迁移', [r6.pending.a.code, r6.mapped, r6.dropped], ['F1', 3, 0]);

  const r7 = migratePending(p2, { from: tech, to: [] });
  eq('换成空方案（没有目标）：全部作废', [r7.mapped, r7.dropped], [0, 2]);
}

console.log('目标编码不存在 → 剔除');
{
  const r = prunePending(pend, ['000', '100']);
  eq('全失效时全部剔除', [Object.keys(r.pending).length, r.dropped], [0, 3]);

  const mixed = { x: { code: '000' }, y: { code: 'F1' }, z: { code: '100' } };
  const r2 = prunePending(mixed, new Set(['000', '100']));
  eq('只留还在方案里的', Object.keys(r2.pending), ['x', 'z']);
  eq('报出清掉一条', r2.dropped, 1);

  const r3 = prunePending({ bad: { code: '' }, ok: { code: '000' } }, ['000']);
  eq('没有编码的也算失效', Object.keys(r3.pending), ['ok']);
}

console.log('按编码分组');
{
  const g = groupPending(pend, ['a', 'b', 'c', 'missing']);
  eq('两个分组', [...g.keys()], ['F1', 'F2']);
  eq('F1 归拢 a 与 c', g.get('F1'), ['a', 'c']);
  eq('不存在的 id 被忽略', g.get('F2'), ['b']);
}

console.log('坏 code 不阻断其它组');
{
  const calls = [];
  const move = async (code, group) => {
    calls.push(code);
    if (code === 'F2') throw new Error('找不到类目 F2');
    return { moved: group.length, ops: group.map((id) => ({ id, code })) };
  };
  const r = await runAccept({ pending: pend, ids: ['a', 'b', 'c'], move });

  eq('三组都尝试过', calls.sort(), ['F1', 'F2']);
  eq('成功的两组照常移动', r.moved, 2);
  eq('失败的一组记账', r.failed, 1);
  eq('报出缺失的编码', r.missing, ['F2']);
  eq('只清掉成功的建议', Object.keys(r.pending), ['b']);
  eq('ops 只含成功条目', r.ops.map((o) => o.id).sort(), ['a', 'c']);
}

console.log('全部成功');
{
  const move = async (code, group) => ({ moved: group.length, ops: group.map((id) => ({ id, code })) });
  const r = await runAccept({ pending: pend, ids: ['a', 'b', 'c'], move });
  eq('移动数', r.moved, 3);
  eq('无失败', [r.failed, r.missing], [0, []]);
  eq('建议清空', Object.keys(r.pending).length, 0);
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
