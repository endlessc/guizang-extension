#!/usr/bin/env node
/**
 * 备份模块断言（阶段 2）。
 *
 * 只测纯函数部分：树扁平化、环形裁剪、动手前的闸门判定。
 * 真正写 chrome.storage 的那几个薄封装在浏览器里由设置页验证。
 *
 * 用法：node dev/backup-test.mjs
 */

import { readFileSync } from 'node:fs';
import { flattenTree, trimIndex, checkBackupReady, BACKUP_LIMIT } from '../lib/backup.js';

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

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

console.log('扁平化：节点数与分类');
{
  const { nodes, counts } = flattenTree(read('tree-dewey'));
  // 3 个根 + 000 + 100 + 000重号 + 待归类 + B站 + 工具箱 + 深层普通文件夹 = 10 个文件夹
  eq('文件夹数', counts.folders, 10);
  eq('书签数', counts.bookmarks, 9);
  eq('总节点数', counts.nodes, 19);
  eq('根下的书签也带 parentId', nodes.find((n) => n.id === '15').parentId, '1');
  eq('文件夹的 url 是空串', nodes.find((n) => n.id === '10').url, '');
  eq('书签保留 dateAdded', nodes.find((n) => n.id === '1001').dateAdded, 1700000000000000);
}

console.log('环形裁剪：只留最近 3 份');
{
  const index = [
    { id: 'a', at: 100 },
    { id: 'b', at: 300 },
    { id: 'c', at: 200 },
    { id: 'd', at: 400 },
  ];
  const { keep, drop } = trimIndex(index);
  eq('保留数量', keep.length, BACKUP_LIMIT);
  eq('按时间倒序', keep.map((b) => b.id), ['d', 'b', 'c']);
  eq('挤掉最旧', drop, ['a']);
}

console.log('闸门：没有备份不许动手');
{
  const r = checkBackupReady([], { id: 'p1', at: 500 });
  eq('返回 NEED_BACKUP', [r.ok, r.code], [false, 'NEED_BACKUP']);
  eq('说明原因', r.reason, '还没有任何备份');
}

console.log('闸门：备份早于计划也不算数');
{
  const r = checkBackupReady([{ id: 'b1', at: 400 }], { id: 'p1', at: 500 });
  eq('返回 NEED_BACKUP', [r.ok, r.code], [false, 'NEED_BACKUP']);
  eq('说明原因', r.reason, '最近一次备份早于这次整理计划');
}

console.log('闸门：备份不早于计划就放行');
{
  const r = checkBackupReady([{ id: 'b2', at: 500 }], { id: 'p1', at: 500 });
  eq('放行', [r.ok, r.backup.id], [true, 'b2']);
  const r2 = checkBackupReady([{ id: 'b1', at: 400 }, { id: 'b3', at: 900 }], { id: 'p1', at: 500 });
  eq('取最新那份比对', r2.backup.id, 'b3');
}

console.log('闸门：没给计划时间时只要有备份就放行（手动备份场景）');
{
  const r = checkBackupReady([{ id: 'b1', at: 1 }], { id: '', at: 0 });
  eq('放行', [r.ok, r.backup.id], [true, 'b1']);
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
