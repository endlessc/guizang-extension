#!/usr/bin/env node
/**
 * WAL 纯逻辑断言（不碰 chrome，不碰文件）：
 *   node dev/wal-test.mjs
 */
import {
  createWal, appendSteps, walSummary, rollbackSteps, walToJournal,
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

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
