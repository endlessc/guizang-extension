/**
 * 归类建议（pending）的纯逻辑。
 *
 * 三件事分开管：
 *   切换方案 → 按类名显式迁移，映射不了的才作废（不许静默清空）
 *   读取状态 → 剔除目标编码已不存在的建议（文件夹被改名/删掉）
 *   执行接受 → 按编码分组逐个走，一组失败不影响其它组
 *
 * 全部是纯函数，可在 Node 里直接测（见 dev/pending-test.mjs）。
 */

const keyOf = (name) => String(name || '').trim().toLowerCase();

/**
 * 换方案时的显式迁移：把每条建议的目标编码，换算成新方案里同名类目的编码。
 *
 *   旧编码 → 旧方案里该编码的类名 → 新方案里同名类目（mapped）
 *   任一步落空就是 dropped，并计数报出去，由调用方决定怎么告诉用户。
 *
 * 不按编码硬映射：杜威 100「哲学」与 PARA 100「项目」同码不同义，硬映射会搬错。
 * 建议上的其它字段（conf/reason/source/model/promptVersion）原样保留——血缘不因换方案失效。
 *
 * @returns {{pending: object, mapped: number, dropped: number, droppedIds: string[]}}
 */
export function migratePending(pending, { from = [], to = [] } = {}) {
  const oldName = new Map((from || []).map((f) => [String(f.code), keyOf(f.name)]));
  const byName = new Map();
  for (const f of to || []) {
    const k = keyOf(f.name);
    if (k && !byName.has(k)) byName.set(k, f);
  }
  const next = {};
  let mapped = 0;
  const droppedIds = [];
  for (const [id, p] of Object.entries(pending || {})) {
    if (!p || !p.code) { droppedIds.push(id); continue; }
    const was = oldName.get(String(p.code));
    const hit = was ? byName.get(was) : null;
    if (!hit) { droppedIds.push(id); continue; }
    next[id] = { ...p, code: hit.code };
    mapped += 1;
  }
  return { pending: next, mapped, dropped: droppedIds.length, droppedIds };
}

/**
 * 剔除目标编码已不存在的建议
 */
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
