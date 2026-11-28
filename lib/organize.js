/**
 * 整理计划：把「哪些书签该挪到哪」算成一份可审阅的清单。
 *
 * 这一层**只产出计划，不动书签**。真正执行在阶段 4，且必须先过备份闸门。
 *
 * 流水线分工：
 *   预筛          → preselect()          这里（纯函数）
 *   本地规则/模型  → 调用方（后台）算好 suggestions 传进来
 *   落地+冲突消解  → buildPlan()          这里（纯函数）
 * 把模型调用留在外面，是为了让这个模块能在 Node 里直接测。
 */

export const UNSURE_THRESHOLD = 0.55;
export const MAX_CANDIDATES = 200;

/** 预筛：支持 inbox（仅未分类）、folder（指定类目）、all（全库错放巡检）。 */
export function preselect(items, { scope = 'inbox', folderCode = '', codes = null } = {}) {
  const allScope = scope === 'all' || scope === 'scheme';
  const picked = [];
  for (const it of items) {
    const needs = allScope
      ? true
      : scope === 'folder' && folderCode
        ? it.code === folderCode
        : !it.code;
    if (needs) picked.push(it);
  }

  // 全库巡检：把「还不在本方案类目里」的排前面。
  // 它们归位后就离开候选池，下一轮自然浮出后面的条目——否则永远只看得到前 200 条。
  const hasCodes = Boolean(codes && codes.size);
  let ordered = picked;
  if (allScope && hasCodes) {
    ordered = [
      ...picked.filter((it) => !codes.has(it.code || '')),
      ...picked.filter((it) => codes.has(it.code || '')),
    ];
  }
  const outside = allScope && hasCodes ? picked.filter((it) => !codes.has(it.code || '')).length : 0;

  return {
    candidates: ordered.slice(0, MAX_CANDIDATES),
    overflow: Math.max(0, ordered.length - MAX_CANDIDATES),
    outside,
    pool: ordered.length,
  };
}

function nameOf(scheme, code) {
  const hit = scheme.find((f) => f.code === code);
  return hit ? hit.name : code;
}

/**
 * @param {object} input
 * @param {Array} input.items     全量书签
 * @param {Array} input.scheme    [{code,name,hint}]
 * @param {string} input.scope    'inbox' | 'all'
 * @param {Object} input.suggestions  { [id]: {code, conf, reason, source} }
 * @param {Set} input.blocked     不可动的节点 id（受管书签及其子节点）
 * @param {number} input.now
 */
export function buildPlan({ items, scheme, scope = 'inbox', folderCode = '', suggestions = {}, blocked = new Set(), existing = null, now = Date.now() }) {
  const codes = new Set(scheme.map((f) => f.code));
  const hasFolder = existing instanceof Set ? existing : codes; // 没传就认为方案里的类目都已存在
  const { candidates, overflow, outside, pool } = preselect(items, { scope, folderCode, codes });
  const ops = [];

  for (const it of candidates) {
    const from = { code: it.code || '', folderId: it.folderId || '' };
    const s = suggestions[it.id];

    // 受管书签：Chrome 会拒绝移动，别等执行时才炸
    if (blocked.has(it.id) || blocked.has(it.folderId)) {
      ops.push(makeOp(it, from, null, scheme, { status: 'blocked', reason: '受管书签，无法移动', missing: false }));
      continue;
    }
    if (!s || !s.code) {
      ops.push(makeOp(it, from, null, scheme, { status: 'skip', reason: '没有拿到建议', missing: false }));
      continue;
    }
    // 建议就是现状 → 没有动作，别让用户确认空气
    if (s.code === from.code) continue;

    const status = (s.conf || 0) < UNSURE_THRESHOLD ? 'unsure' : 'ready';
    ops.push(makeOp(it, from, s, scheme, { status, missing: !hasFolder.has(s.code) }));
  }

  const created = [...new Set(ops.filter((o) => o.to && o.to.missing).map((o) => o.to.code))]
    .map((code) => ({ code, name: nameOf(scheme, code) }));

  return recount({
    id: 'p' + now.toString(36),
    at: now,
    scope,
    scheme: scheme.map((f) => ({ code: f.code, name: f.name })),
    ops,
    overflow,
    outside,
    pool,
    created,
  });
}

function makeOp(it, from, suggestion, scheme, extra) {
  const to = suggestion
    ? { code: suggestion.code, name: nameOf(scheme, suggestion.code), missing: Boolean(extra.missing) }
    : null;
  return {
    id: it.id,
    title: it.title || it.url || '',
    url: it.url || '',
    from,
    to,
    conf: suggestion ? Number(suggestion.conf) || 0 : 0,
    source: suggestion ? suggestion.source || 'model' : '',
    reason: (suggestion && suggestion.reason) || extra.reason || '',
    status: extra.status,
  };
}

/** 重新统计：剔除/改判之后必须重算，否则界面上的数字是旧的 */
export function recount(plan) {
  const stats = { total: plan.ops.length, ready: 0, unsure: 0, blocked: 0, skip: 0 };
  for (const op of plan.ops) {
    if (stats[op.status] === undefined) stats[op.status] = 0;
    stats[op.status] += 1;
  }
  return { ...plan, stats };
}

/** 真正会被执行的条目：只有 ready（unsure/blocked/skip 都不动） */
export function readyOps(plan) {
  return plan.ops.filter((op) => op.status === 'ready' && op.to && op.to.code);
}

/** ready 的条目按目标类目分组，执行时一类一次 */
export function groupReadyOps(plan) {
  const map = new Map();
  for (const op of readyOps(plan)) {
    if (!map.has(op.to.code)) map.set(op.to.code, []);
    map.get(op.to.code).push(op);
  }
  return map;
}

/** 计划里某一组（按目标类目）的条目 */
export function groupOps(plan) {
  const map = new Map();
  for (const op of plan.ops) {
    const key = op.to ? op.to.code : '—';
    if (!map.has(key)) map.set(key, { code: key, name: op.to ? op.to.name : '未决定', ops: [] });
    map.get(key).ops.push(op);
  }
  // 按类目编码排；「—」放最后
  return [...map.values()].sort((a, b) => {
    if (a.code === '—') return 1;
    if (b.code === '—') return -1;
    return String(a.code).localeCompare(String(b.code));
  });
}

/** 剔除一条 / 改判一条，返回新计划（保持不可变，便于存 storage） */
export function dropOp(plan, id) {
  return recount({ ...plan, ops: plan.ops.filter((op) => op.id !== id) });
}

export function overrideOp(plan, id, code) {
  const name = (plan.scheme.find((f) => f.code === code) || {}).name || code;
  const ops = plan.ops.map((op) =>
    op.id === id
      ? { ...op, to: { code, name }, status: 'ready', source: 'user', conf: 1, reason: '手动改判' }
      : op,
  );
  return recount({ ...plan, ops });
}
