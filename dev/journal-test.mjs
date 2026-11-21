#!/usr/bin/env node
/**
 * 执行/撤销相关的纯函数断言（阶段 4）。
 *   readyOps / groupReadyOps —— 哪些条目会被真的移动
 *   journal                  —— 环形保留、找最近一条、标记已撤销
 *
 * 用法：node dev/journal-test.mjs
 */

import { buildPlan, readyOps, groupReadyOps } from '../lib/organize.js';
import { pushEntry, latestEntry, findEntry, markUndone, undoableCount, JOURNAL_LIMIT } from '../lib/journal.js';

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
];
const item = (id) => ({ id, code: '', folderId: 'inbox', title: 'T' + id, url: 'https://e/' + id });

console.log('哪些条目会被执行');
{
  const plan = buildPlan({
    items: [item('1'), item('2'), item('3'), item('4')],
    scheme,
    suggestions: {
      1: { code: '100', conf: 0.9 },
      2: { code: '100', conf: 0.3 },   // unsure
      4: { code: '000', conf: 0.9 },   // blocked
    },
    blocked: new Set(['4']),
  });
  eq('只有 ready 会被移动', readyOps(plan).map((o) => o.id), ['1']);
  eq('按类目分组', [...groupReadyOps(plan).keys()], ['100']);
  eq('skip 不参与', readyOps(plan).some((o) => o.id === '3'), false);
}

console.log('日志环形');
{
  const list = [1, 2, 3, 4].reduce((acc, n) => pushEntry(acc, { id: 'j' + n, at: n, ops: [{ id: 'x' }] }), []);
  eq('只留最近 ' + JOURNAL_LIMIT + ' 条', list.length, JOURNAL_LIMIT);
  eq('新的在前', list.map((e) => e.id), ['j4', 'j3', 'j2']);
}

console.log('找最近一条可撤销');
{
  const list = [
    { id: 'j3', at: 3, undoneAt: 9, ops: [{ id: 'a' }] },
    { id: 'j2', at: 2, ops: [{ id: 'b' }] },
  ];
  eq('跳过已撤销的', latestEntry(list).id, 'j2');
  eq('按 id 找得到', findEntry(list, 'j3').id, 'j3');
  eq('已撤销的可撤销数为 0', undoableCount(list[0]), 0);
  eq('未撤销的可撤销数', undoableCount(list[1]), 1);
  const after = markUndone(list, 'j2', 42);
  eq('标记后 latest 为空', latestEntry(after), null);
  eq('标记时间写进去', after[1].undoneAt, 42);
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
