/**
 * 方案安装的计划计算（纯函数，不碰 chrome API）。
 *
 * 后台负责真正建文件夹，这里只回答三个问题：
 *   哪些已经存在且同名 → 直接复用
 *   哪些不存在        → 需要新建
 *   哪些编码撞车      → 必须人工处理，一个都不能建
 *
 * 为什么会撞车：装了字母方案后，「B 站」这种文件夹会被识别成编码 B（名字「站」），
 * 和方案里的「B 哲学与宗教」同号。若此时再建一个 B，parseTree 按 code 去重，
 * 先出现的那个会赢，会出现「类目被藏起来」的怪现象。所以冲突必须前置拦下。
 */

import { parseTree } from './tree.js';
import { letterSetOf, orderOf, hintMapOf } from './schemes.js';

/** 书签栏 = 根下第一个文件夹（Chrome 里就是 bookmark_bar） */
function pickBar(tree) {
  const root = tree[0];
  const bars = (root.children || []).filter((n) => !n.url);
  return bars[0] || (root.children || [])[0] || root;
}

export function planInstall(tree, scheme) {
  if (!scheme) throw new Error('方案不存在');

  const parsed = parseTree(tree, {
    letterSet: letterSetOf(scheme),
    order: orderOf(scheme),
    hintMap: hintMapOf(scheme),
  });

  const byCode = new Map();
  for (const f of parsed.folders) {
    if (!byCode.has(f.code)) byCode.set(f.code, f);
  }

  const exists = [];
  const missing = [];
  const conflict = [];

  for (const want of scheme.folders) {
    const hit = byCode.get(want.code);
    if (!hit) {
      missing.push({ code: want.code, name: want.name });
      continue;
    }
    if (hit.name === want.name) {
      exists.push({ code: want.code, name: want.name, folderId: hit.id, depth: hit.depth });
    } else {
      conflict.push({
        code: want.code,
        want: want.name,
        got: hit.name,
        folderId: hit.id,
        path: hit.path,
      });
    }
  }

  return {
    schemeId: scheme.id,
    barId: pickBar(tree).id,
    exists,
    missing,
    conflict,
    summary: { exists: exists.length, missing: missing.length, conflict: conflict.length },
  };
}
