#!/usr/bin/env node
/**
 * 方案安装计划的断言（阶段 1）。
 *
 * 覆盖三件最容易出错的事：
 *   1. 按 code 复用、只建缺的
 *   2. 同 code 不同名 → 冲突，必须拦下（否则「B 站」会顶掉「B 哲学与宗教」）
 *   3. 数字目录不参与字母方案的比对
 *
 * 用法：node dev/scheme-install-test.mjs
 */

import { readFileSync } from 'node:fs';
import { planInstall } from '../lib/scheme-install.js';
import { getScheme } from '../lib/schemes.js';

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

const deweyTree = read('tree-dewey');
const lettersTree = read('tree-letters');
const nocodeTree = read('tree-nocode');

console.log('杜威 → 已有 000 / 100 直接复用');
{
  const plan = planInstall(deweyTree, getScheme('dewey'));
  eq('复用两个', plan.exists.map((f) => f.code), ['000', '100']);
  eq('缺八个', plan.missing.map((f) => f.code), ['200', '300', '400', '500', '600', '700', '800', '900']);
  eq('无冲突', plan.summary.conflict, 0);
  eq('落在书签栏里', plan.barId, '1');
}

console.log('中图法 12 类 → 字母在数字目录里一个都不能认领');
{
  const plan = planInstall(deweyTree, getScheme('clc12'));
  eq('000/100 不参与比对', plan.exists, []);
  eq('缺 11 个', plan.summary.missing, 11);
  eq('「B 站」撞车被拦下', plan.conflict.map((c) => [c.code, c.got, c.want]), [['B', '站', '哲学与宗教']]);
}

console.log('中图法 12 类 → 已有同名目录直接复用');
{
  const plan = planInstall(lettersTree, getScheme('clc12'));
  eq('复用 T 与 B', plan.exists.map((f) => f.code), ['B', 'T']);
  eq('缺 10 个', plan.summary.missing, 10);
  eq('二级 TP 不参与', plan.conflict.length, 0);
}

console.log('中图法 22 类 → 同一棵树多缺十个');
{
  // 22 类里 B 的名字是「哲学、宗教」（顿号），与 fixture 的「B 哲学与宗教」不同名 → 算冲突
  const plan = planInstall(lettersTree, getScheme('clc22'));
  eq('只复用 T', plan.exists.map((f) => f.code), ['T']);
  eq('B 因为名字不同被拦下', plan.conflict.map((c) => [c.code, c.got, c.want]), [['B', '哲学与宗教', '哲学、宗教']]);
  eq('缺 20 个', plan.summary.missing, 20);
}

console.log('无编码目录 → 全部要新建');
{
  const plan = planInstall(nocodeTree, getScheme('lite5'));
  eq('零复用', plan.summary.exists, 0);
  eq('五个全建', plan.missing.map((f) => f.code), ['100', '200', '300', '400', '500']);
}

console.log('已经装好一遍 → 再装是空操作');
{
  const clc12 = getScheme('clc12');
  const installed = {
    id: '0',
    children: [
      {
        id: '1',
        title: '书签栏',
        index: 0,
        children: clc12.folders.map((f, i) => ({
          id: 'f' + f.code,
          parentId: '1',
          title: `${f.code} ${f.name}`,
          index: i,
          children: [],
        })),
      },
    ],
  };
  const plan = planInstall([installed], clc12);
  eq('全部复用', plan.summary, { exists: 12, missing: 0, conflict: 0 });
}

console.log('两级方案：按父建子（taxonomy 落成目录用）');
{
  const emptyBar = [{ id: '0', children: [{ id: '1', title: '书签栏', children: [] }] }];
  const scheme = {
    id: 'tx1', name: '语料归纳', kind: 'digit',
    folders: [
      { code: '000', name: '综合' },
      { code: '010', name: '编辑器', parent: '000' },
      { code: '100', name: '资讯' },
    ],
  };
  const plan = planInstall(emptyBar, scheme);
  eq('三个都要建', plan.missing.map((f) => f.code), ['000', '010', '100']);
  eq('父在前子在后', plan.missing.map((f) => f.parent), [null, '000', null]);
  eq('建在书签栏下', plan.barId, '1');
}

console.log('两级方案：同名复用、异名拦下');
{
  const tree = [{
    id: '0',
    children: [{
      id: '1', title: '书签栏', children: [
        {
          id: '10', title: '000 综合', children: [
            { id: '11', title: '010 编辑器', children: [] },
          ],
        },
      ],
    }],
  }];
  const scheme = {
    id: 'tx2', name: '语料归纳', kind: 'digit',
    folders: [
      { code: '000', name: '综合' },
      { code: '010', name: '编辑器', parent: '000' },
      { code: '100', name: '资讯' },
    ],
  };
  const plan = planInstall(tree, scheme);
  eq('同名按 code 复用（含嵌套）', plan.exists.map((f) => f.code), ['000', '010']);
  eq('只建缺的那一个', plan.missing.map((f) => f.code), ['100']);
  eq('无冲突', plan.summary.conflict, 0);

  const renamed = [{
    id: '0',
    children: [{
      id: '1', title: '书签栏', children: [
        { id: '10', title: '000 综合', children: [{ id: '11', title: '010 编辑器工具', children: [] }] },
      ],
    }],
  }];
  const bad = planInstall(renamed, scheme);
  eq('嵌套同名不同名 → 冲突', bad.conflict.map((c) => [c.code, c.got, c.want]), [['010', '编辑器工具', '编辑器']]);
  eq('有冲突时其余仍照常算', bad.missing.map((f) => f.code), ['100']);
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
