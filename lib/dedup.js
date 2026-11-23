/**
 * 重复书签检测与 URL 规范化（纯函数，可在 Node 直接测）。
 *
 * 识别历史遗留的同页重复收藏：
 *   - http / https 混存
 *   - 末尾斜杠有无差异、www. 前缀差异
 *   - 常见追踪参数（utm_*、spm、ref、fbclid、gclid 等）
 *   - URL 哈希锚点（#section）
 */

const TRACKING_EXACT = new Set([
  'spm', 'ref', 'ref_src', 'ref_url', 'fbclid', 'gclid', 'dclid', 'yclid',
  'mc_cid', 'mc_eid', 'igshid', 'msclkid', 'twclid', 'vd_source', 'share_source',
  'share_medium', 'share_plat', 'share_session_id', 'from', 'isappinstalled',
  'nsukey', 'chksm', 'scene', 'subscene', 'clicktime', 'enterid',
]);

const TRACKING_PREFIX = ['utm_', 'spm_', 'hmb_', 'pk_', 'mtm_'];

function isTrackingParam(key) {
  const k = String(key || '').toLowerCase();
  if (TRACKING_EXACT.has(k)) return true;
  return TRACKING_PREFIX.some((p) => k.startsWith(p));
}

/** 规范化 URL，用于重复判定与历史记录对齐 */
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return s.toLowerCase();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return s;
  }
  // 统一协议为 https、域名小写去 www.
  const host = u.host.toLowerCase().replace(/^www\./, '');
  // 去掉末尾多余斜杠（保留根路径为空串）
  let pathname = u.pathname.replace(/\/+$/, '');
  // 过滤追踪参数并排序
  const kept = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const qs = kept.length
    ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  return `https://${host}${pathname}${qs}`;
}

/**
 * 在一组重复书签中挑出最值得保留的一条：
 * 1. 已归类（有 code）优先于待归类
 * 2. 标题更像人话（不是裸 URL）优先
 * 3. 添加时间更早的优先（保留原始收藏时间）
 */
export function pickKeeper(group) {
  const ranked = [...group].sort((a, b) => {
    const aHasCode = a.code ? 1 : 0;
    const bHasCode = b.code ? 1 : 0;
    if (aHasCode !== bHasCode) return bHasCode - aHasCode;

    const aClean = a.title && !/^https?:\/\//i.test(a.title) ? 1 : 0;
    const bClean = b.title && !/^https?:\/\//i.test(b.title) ? 1 : 0;
    if (aClean !== bClean) return bClean - aClean;

    const aTime = a.added || Number.MAX_SAFE_INTEGER;
    const bTime = b.added || Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;

    return String(a.id).localeCompare(String(b.id));
  });
  return ranked[0];
}

/**
 * 找出所有重复分组。
 * @returns {Array<{key:string, host:string, keepId:string, removeIds:string[], items:Array}>}
 */
export function findDuplicates(items) {
  const buckets = new Map();
  for (const it of items || []) {
    if (!it || !it.url) continue;
    const key = normalizeUrl(it.url);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }

  const groups = [];
  for (const [key, rows] of buckets) {
    if (rows.length < 2) continue;
    const keeper = pickKeeper(rows);
    const ordered = [keeper, ...rows.filter((r) => r.id !== keeper.id)];
    groups.push({
      key,
      host: keeper.host || '',
      keepId: keeper.id,
      removeIds: ordered.slice(1).map((r) => r.id),
      items: ordered,
    });
  }

  // 重复数量多的排前，同数按最近添加排序
  groups.sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    const maxA = Math.max(...a.items.map((x) => x.added || 0));
    const maxB = Math.max(...b.items.map((x) => x.added || 0));
    return maxB - maxA;
  });

  return groups;
}

/** 所有涉及重复的书签 id 集合 */
export function duplicateIdSet(groups) {
  const set = new Set();
  for (const g of groups || []) {
    for (const it of g.items || []) set.add(it.id);
  }
  return set;
}

/** 所有建议清理的冗余条目总数 */
export function removableCount(groups) {
  return (groups || []).reduce((acc, g) => acc + (g.removeIds ? g.removeIds.length : 0), 0);
}
