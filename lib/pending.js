/**
 * 归类建议（pending）的纯逻辑。
 *
 * 三件事分开管：
 *   切换方案 → 建议全部作废（不同方案会撞码但语义不同，保留一定出错）
 *   读取状态 → 剔除目标编码已不存在的建议（文件夹被改名/删掉）
 *   执行接受 → 按编码分组逐个走，一组失败不影响其它组
 *
 * 全部是纯函数，可在 Node 里直接测（见 dev/pending-test.mjs）。
 */

/**
 * 换方案时清空建议；重复安装同一套（id 没变）则原样保留。
 * @returns {{changed: boolean, pending: object, dropped: number}}
 */
export function onSchemeChange(prevId, nextId, pending) {
  const changed = (prevId || '') !== (nextId || '');
  if (!changed) return { changed: false, pending: pending || {}, dropped: 0 };
  return { changed: true, pending: {}, dropped: Object.keys(pending || {}).length };
}

/** 剔除目标编码已不存在的建议 */
export function prunePending(pending, codes) {
  const ok = codes instanceof Set ? codes : new Set(codes || []);
  const next = {};
  let dropped = 0;
  for (const [id, p] of Object.entries(pending || {})) {
    if (p && p.code && ok.has(p.code)) next[id] = p;
    else dropped += 1;
  }
  return { pending: next, dropped };
}

/** ids → Map(code → [id])，按建议里存的 code 分组 */
export function groupPending(pending, ids) {
  const map = new Map();
  for (const id of ids) {
    const p = pending[id];
    if (!p) continue;
    if (!map.has(p.code)) map.set(p.code, []);
    map.get(p.code).push(id);
  }
  return map;
}

/**
 * 执行接受：逐组调用 move(code, group)。
 * 某组抛错只记账、不中断——一条坏 code 不该毁掉整批。
 *
 * @param {{pending: object, ids: string[], move: (code: string, group: string[]) => Promise<object>}} input
 * @returns {Promise<{pending: object, moved: number, failed: number, ops: Array, missing: string[]}>}
 */
export async function runAccept({ pending, ids, move }) {
  const next = { ...(pending || {}) };
  const groups = groupPending(pending, ids);
  let moved = 0;
  let failed = 0;
  const ops = [];
  const missing = [];

  for (const [code, group] of groups) {
    try {
      const r = await move(code, group);
      moved += (r && r.moved) || 0;
      if (r && r.ops) ops.push(...r.ops);
      group.forEach((id) => delete next[id]);
    } catch (e) {
      failed += group.length;
      missing.push(code);
    }
  }
  return { pending: next, moved, failed, ops, missing };
}
