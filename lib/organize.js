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
export function preselect(items, { scope = 'inbox', folderCode = '', codes = null, limit = MAX_CANDIDATES } = {}) {
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

  // limit: 正数为本轮上限；'all' 或 0 表示不设上限（一次跑完全部）
  const cap = limit === 'all' || limit === 0 ? ordered.length : Math.max(1, Number(limit) || MAX_CANDIDATES);
  return {
    candidates: ordered.slice(0, cap),
    overflow: Math.max(0, ordered.length - cap),
    outside,
    pool: ordered.length,
    limit: cap,
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
export function buildPlan({ items, scheme, scope = 'inbox', folderCode = '', suggestions = {}, blocked = new Set(), existing = null, limit = MAX_CANDIDATES, now = Date.now() }) {
  const codes = new Set(scheme.map((f) => f.code));
  const hasFolder = existing instanceof Set ? existing : codes; // 没传就认为方案里的类目都已存在
  const { candidates, overflow, outside, pool, limit: cap } = preselect(items, { scope, folderCode, codes, limit });
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

  return recount({
    id: 'p' + now.toString(36),
    at: now,
    scope,
    scheme: scheme.map((f) => ({ code: f.code, name: f.name, parent: f.parent || null })),
    ops,
    overflow,
    outside,
    pool,
    limit: cap,
    existing: [...hasFolder],
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
  // 只统计「真会执行」的条目会新建哪些目录；二级要连父级一起算，否则界面少报
  const existingSet = new Set(plan.existing || []);
  // 方案 + 二级（二级挂到对应一级下），供祖先展开与命名使用
  const folderTree = [
    ...(plan.scheme || []),
    ...Object.entries(plan.subs || {}).flatMap(([top, list]) =>
      (list || []).map((s) => ({ code: s.code, name: s.name, parent: top }))),
  ];
  const targets = [...new Set(plan.ops
    .filter((op) => op.status === 'ready' && op.to && op.to.missing)
    .map((op) => (op.to.sub ? op.to.sub.code : op.to.code)))];
  const created = foldersForCodes(targets, folderTree)
    .filter((f) => !existingSet.has(f.code))
    .map((f) => ({ code: f.code, name: f.name }));
  return { ...plan, stats, created };
}

/** 从条目里等距抽 n 条（给模型定子类名时用，避免把一个类目的全部标题塞进请求） */
export function sampleOps(ops, n = 60) {
  const list = ops || [];
  if (list.length <= n) return list.slice();
  const out = [];
  const step = list.length / n;
  for (let i = 0; i < n; i += 1) out.push(list[Math.floor(i * step)]);
  return out;
}

/** 二级编码：父首位 + 10n（与方案编码规则一致） */
export function subCodeFor(parentCode, index) {
  const head = String(parentCode)[0];
  return head + String((index + 1) * 10).padStart(2, '0');
}

/**
 * 子类名 → 带编码的子类（父编码首位 + 10n）。
 *
 * 只接受「看起来就是编码」的父值。传类目名进来（如「综合与工具」）会算出
 * 「综10」这类垃圾编码：目录能建出来，但 parseTree 认不出，条目搬过去全失败，
 * 界面上只会显示一句「已拆成 N 个目录」。所以这里直接返回空数组，让调用方报错。
 *
 * 字母编码不支持二级（见 features-test：字母方案只到一级），返回空数组。
 */
export function splitSubs(parentCode, names = []) {
  const code = String(parentCode || '').trim();
  if (!/^\d{1,3}$/.test(code)) return [];
  return (names || [])
    .slice(0, 9)
    .map((n, i) => ({
      name: String((n && n.name) || '').trim().slice(0, 20),
      hint: String((n && n.hint) || '').trim().slice(0, 60),
      code: subCodeFor(code, i),
    }))
    .filter((s) => s.name);
}

/**
 * 把「二级拆分结果」写回计划。
 * mapping: { [topCode]: { subs:[{name,hint}], assign:{ [opId]: 0..n-1 } } }
 * 只影响被点名的条目；没给二级的条目保持原样（仍搬进一级）。
 */
export function applySubs(plan, mapping = {}) {
  const subs = { ...(plan.subs || {}) };
  for (const [top, m] of Object.entries(mapping)) {
    if (!m || !Array.isArray(m.subs)) continue;
    subs[top] = m.subs.slice(0, 9).map((s, i) => ({
      code: subCodeFor(top, i),
      name: String((s && s.name) || '').trim().slice(0, 20),
      hint: String((s && s.hint) || '').trim().slice(0, 60),
    })).filter((s) => s.name);
  }
  const ops = plan.ops.map((op) => {
    const m = mapping[op.to && op.to.code];
    if (!m || !Array.isArray(m.subs)) return op;
    const idx = m.assign ? m.assign[op.id] : undefined;
    if (!Number.isInteger(idx)) return op;
    const sub = subs[op.to.code] && subs[op.to.code][idx];
    if (!sub) return op;
    return { ...op, to: { ...op.to, sub: { code: sub.code, name: sub.name } } };
  });
  return recount({ ...plan, ops, subs });
}

/**
 * 执行前要建的目录：把目标 code 展开成「自身 + 所有祖先」，父在前。
 * 分批跑时某一轮可能只有子类有可执行条目，父类也必须一起建出来，否则子目录没处放。
 */
export function foldersForCodes(codes, folders = []) {
  const byCode = new Map((folders || []).map((f) => [f.code, f]));
  const need = new Set();
  const add = (code) => {
    if (!code || need.has(code)) return;
    need.add(code);
    const hit = byCode.get(code);
    if (hit && hit.parent) add(hit.parent);
  };
  for (const c of codes) add(c);

  const depthOf = (code) => {
    let d = 0;
    let cur = byCode.get(code);
    while (cur && cur.parent) { d += 1; cur = byCode.get(cur.parent); }
    return d;
  };

  return [...need]
    .map((code) => {
      const hit = byCode.get(code) || {};
      return { code, name: hit.name || code, parent: hit.parent || null, depth: depthOf(code) };
    })
    .sort((a, b) => a.depth - b.depth || String(a.code).localeCompare(String(b.code)))
    .map(({ depth, ...f }) => f);
}

/**
 * 这次提交要保证存在的目录：目标 code（二级优先）+ 所有祖先，父在前、去重。
 * 提交阶段只建这一份清单里的目录，不碰方案里没用到的类目。
 */
export function planFolders(plan, ops = []) {
  const tree = [
    ...((plan && plan.scheme) || []),
    ...Object.entries((plan && plan.subs) || {}).flatMap(([top, list]) =>
      (list || []).map((x) => ({ code: x.code, name: x.name, parent: top }))),
  ];
  const codes = (ops || []).map((op) => (op.to && op.to.sub ? op.to.sub.code : op.to && op.to.code));
  return foldersForCodes(codes.filter(Boolean), tree);
}

/**
 * 真正会被执行的条目：默认只有 ready（unsure/blocked/skip 都不动）。
 * includeUnsure=true 时把「拿不准」也一起执行（用户明确要求一次跑完时用，仍可撤销）。
 */
export function readyOps(plan, { includeUnsure = false } = {}) {
  return plan.ops.filter((op) => {
    if (!op.to || !op.to.code) return false;
    if (op.status === 'ready') return true;
    return includeUnsure && op.status === 'unsure';
  });
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

export function overrideOp(plan, id, code, { existing = null } = {}) {
  const name = (plan.scheme.find((f) => f.code === code) || {}).name || code;
  const ops = plan.ops.map((op) => {
    if (op.id !== id) return op;
    // 改判到某个类目后，那个目录是否已存在得重新判断（调用方知道就传 existing）
    const missing = existing instanceof Set
      ? !existing.has(code)
      : Boolean(op.to && op.to.code === code && op.to.missing);
    return { ...op, to: { code, name, missing }, status: 'ready', source: 'user', conf: 1, reason: '手动改判' };
  });
  return recount({ ...plan, ops });
}
