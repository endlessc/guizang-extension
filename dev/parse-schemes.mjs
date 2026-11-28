#!/usr/bin/env node
/**
 * 识别层泛化的能力断言（阶段 0 新增）。
 *
 * 与 parse-golden.mjs 的分工：
 *   parse-golden.mjs  —— 回归基线：默认 opts 的行为一个字都不许变
 *   parse-schemes.mjs —— 新能力：字母编码只在「已安装方案」时生效、按方案顺序排、hint 正确
 *
 * 用法：node dev/parse-schemes.mjs
 */

import { readFileSync } from 'node:fs';
import { parseTree } from '../lib/tree.js';
import { parseOptsOf, getScheme } from '../lib/schemes.js';

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

let failed = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}\n      实际：${a}\n      期望：${b}`);
  }
}

const letters = read('tree-letters');
const dewey = read('tree-dewey');
const clc12 = getScheme('clc12');

console.log('未安装字母方案（默认 opts）');
eq('字母前缀不被当成类目', parseTree(letters).folderScheme.map((f) => f.code), ['F1', 'F2', 'F3', 'F4', 'F5']);

console.log('已安装 clc12');
const r12 = parseTree(letters, parseOptsOf('clc12'));
eq('只认白名单内的字母，按方案顺序排', r12.folderScheme.map((f) => f.code), ['B', 'T']);
eq('hint 取自方案', r12.folderScheme.find((f) => f.code === 'T').hint, clc12.folders.find((f) => f.code === 'T').hint);
eq('二级 TP 不在白名单 → 不算类目', r12.folderScheme.some((f) => f.code === 'TP'), false);
eq('TP 里的书签继承父类 T', r12.items.find((i) => i.id === '1011').code, 'T');
eq('「AI 工具」不被误判', r12.folderScheme.some((f) => f.name === 'AI 工具'), false);
eq('「AI 工具」里的书签仍是待归类', r12.items.find((i) => i.id === '1201').code, '');
eq('「PDF 手册」不被误判', r12.folderScheme.some((f) => f.name === 'PDF 手册'), false);

console.log('已知代价（写进断言，防止误以为修复）');
const rMix = parseTree(dewey, parseOptsOf('clc12'));
eq('装了字母方案后「B 站」会被认成 B', rMix.folderScheme.find((f) => f.code === 'B').name, '站');
eq('方案外编码排在方案内之后', rMix.folderScheme.map((f) => f.code), ['B', '000', '100']);

console.log('数字方案不受影响');
eq('dewey opts 与默认结果一致',
  parseTree(dewey, parseOptsOf('dewey')).folderScheme.map((f) => f.code),
  parseTree(dewey).folderScheme.map((f) => f.code));
eq('未装任何方案（parseOptsOf(undefined)）返回空 opts', parseOptsOf(undefined), {});

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
