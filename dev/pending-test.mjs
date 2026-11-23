#!/usr/bin/env node
/**
 * 归类建议的失效与容错（本轮的四个修复对应的断言）。
 *
 *   1. 换方案 → 旧建议全部作废（不同方案会撞码但语义不同）
 *   2. 读取时 → 目标编码不存在的建议被剔除
 *   3. 接受时 → 某一组目标找不到，不打断其它组
 *   4. 接受后 → 只有成功的那些建议被清掉
 *
 * 用法：node dev/pending-test.mjs
 */

import { onSchemeChange, prunePending, groupPending, runAccept } from '../lib/pending.js';

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

console.log('换方案即作废');
{
  const same = onSchemeChange('dewey', 'dewey', pend);
  eq('同一套方案重复安装：保留', [same.changed, same.dropped, Object.keys(same.pending).length], [false, 0, 3]);

  const changed = onSchemeChange('', 'dewey', pend);
  eq('换了方案：标记 changed', changed.changed, true);
  eq('换了方案：全部作废', Object.keys(changed.pending).length, 0);
  eq('换了方案：报出清掉几条', changed.dropped, 3);

  const toEmpty = onSchemeChange('dewey', '', pend);
  eq('删掉当前方案也算变化', [toEmpty.changed, toEmpty.dropped], [true, 3]);
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
