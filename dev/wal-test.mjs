#!/usr/bin/env node
/**
 * WAL 纯逻辑断言（不碰 chrome，不碰文件）：
 *   node dev/wal-test.mjs
 */
import {
  createWal, appendSteps, walSummary, rollbackSteps, walToJournal,
  classifyMoveStep, shouldRollbackStep,
} from '../lib/wal.js';

let failed = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) console.log(`  ✓ ${name}`);
  else { failed += 1; console.error(`  ✗ ${name}\n      实际：${a}\n      期望：${b}`); }
};

console.log('WAL：意图先落盘，回滚用反序');
{
  const wal = createWal({ planId: 'p1', scope: 'inbox', total: 3, at: 1000 });
  eq('新建时状态是 prepared', [wal.state, wal.total, wal.steps.length], ['prepared', 3, 0]);
  eq('id 带时间戳', wal.id, 'w' + (1000).toString(36));

  const wal2 = appendSteps(wal, [
    { id: 'a', fromFolderId: 'f1', fromIndex: 0, toFolderId: 't1', code: '100' },
    { id: 'b', fromFolderId: 'f1', fromIndex: 1, toFolderId: 't1', code: '100' },
  ]);
  eq('追加后不动原对象', wal.steps.length, 0);
  eq('追加两步', wal2.steps.map((s) => s.id), ['a', 'b']);
  eq('摘要不带明细', walSummary(wal2), {
    id: wal2.id, planId: 'p1', scope: 'inbox', at: 1000, state: 'prepared', count: 2, total: 3,
  });

  eq('回滚按反序', rollbackSteps(wal2).map((s) => s.id), ['b', 'a']);
  eq('没有原位置的步骤不回滚', rollbackSteps({ steps: [{ id: 'x' }, { id: 'y', fromFolderId: 'f' }] }).map((s) => s.id), ['y']);
  eq('空 WAL 回滚为空', rollbackSteps(null), []);

  const entry = walToJournal(wal2, { id: 'j9', at: 2000, failed: 1 });
  eq('转 journal：只留撤销需要的字段', entry.ops.map((o) => Object.keys(o).sort()), [
    ['code', 'fromFolderId', 'fromIndex', 'id', 'toFolderId'],
    ['code', 'fromFolderId', 'fromIndex', 'id', 'toFolderId'],
  ]);
  eq('转 journal：计数与来源', [entry.id, entry.applied, entry.failed, entry.planId], ['j9', 2, 1, 'p1']);
}

console.log('幂等提交（CAS）与幂等回滚判定');
{
  const op = { id: 'a', from: { folderId: 'f1' } };
  eq('正常移动', classifyMoveStep(op, { id: 'a', parentId: 'f1' }, 't1'), 'move');
  eq('已在目标目录 → 幂等跳过', classifyMoveStep(op, { id: 'a', parentId: 't1' }, 't1'), 'already');
  eq('审阅期间被外部移走 → 并发冲突跳过', classifyMoveStep(op, { id: 'a', parentId: 'f9' }, 't1'), 'conflict');
  eq('节点或目标缺失 → missing', [
    classifyMoveStep(op, null, 't1'),
    classifyMoveStep(op, { id: 'a', parentId: 'f1' }, ''),
  ], ['missing', 'missing']);

  const step = { id: 'a', fromFolderId: 'f1', toFolderId: 't1' };
  eq('仍在目标目录 → 需要回滚', shouldRollbackStep(step, { id: 'a', parentId: 't1' }), true);
  eq('崩溃前未动过（仍在原目录） → 不回滚', shouldRollbackStep(step, { id: 'a', parentId: 'f1' }), false);
  eq('已移到别处或不存在 → 不回滚', [
    shouldRollbackStep(step, { id: 'a', parentId: 'f9' }),
    shouldRollbackStep(step, null),
  ], [false, false]);
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
