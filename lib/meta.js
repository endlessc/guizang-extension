/**
 * 旁挂元数据（标签 / 批注 / 星标 / 阅读态）、改判记忆规则、书海拾遗与吃灰分析。
 * 全部为纯函数，不直接操作 chrome.* API，不破坏 Chrome 原生书签目录同步。
 */

import { normalizeUrl } from './dedup.js';

const DEAD = new Set(['dead', 'error', 'timeout', 'unreachable']);

/* ── 1. 旁挂元数据 ─────────────────────────────── */

export function normalizeMeta(patch = {}, prev = {}) {
  const next = {
    tags: Array.isArray(prev.tags) ? [...prev.tags] : [],
    note: typeof prev.note === 'string' ? prev.note : '',
    star: Boolean(prev.star),
    readState: prev.readState === 'unread' || prev.readState === 'read' ? prev.readState : '',
    updatedAt: Date.now(),
  };

  if (patch.tags != null) {
    const raw = Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，\s#]+/);
    const seen = new Set();
    next.tags = [];
    for (const t of raw) {
      const clean = String(t || '').trim().replace(/^#+/, '').slice(0, 24);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.tags.push(clean);
      if (next.tags.length >= 12) break;
    }
  }
  if (patch.note != null) next.note = String(patch.note).trim().slice(0, 300);
  if (patch.star != null) next.star = Boolean(patch.star);
  if (patch.readState != null) {
    next.readState = patch.readState === 'unread' || patch.readState === 'read' ? patch.readState : '';
  }

  // 全空则可删掉记录，保持存储干净
  const empty = !next.tags.length && !next.note && !next.star && !next.readState;
  return empty ? null : next;
}

export function collectAllTags(meta = {}) {
  const counts = new Map();
  for (const entry of Object.values(meta || {})) {
    if (!entry || !Array.isArray(entry.tags)) continue;
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.tag.localeCompare(b.tag)));
}

export function pruneMeta(meta = {}, aliveIds) {
  const next = {};
  let dirty = false;
  for (const [id, val] of Object.entries(meta || {})) {
    if (aliveIds.has(id)) next[id] = val;
    else dirty = true;
  }
  return { meta: next, dirty };
}

/**
 * 替换恢复重建书签树后，所有节点都会拿到新的 Chrome id：
 * 按 oldId → newId 映射把旁挂元数据（meta / health）迁移过去，避免标签分面与批注丢失。
 */
export function remapRecordById(record = {}, idMap = new Map()) {
  const next = {};
  let remapped = 0;
  const map = idMap instanceof Map ? idMap : new Map(Object.entries(idMap || {}));
  for (const [oldId, val] of Object.entries(record || {})) {
    const newId = map.get(oldId);
    if (newId) {
      next[newId] = val;
      remapped += 1;
    }
  }
  return { record: next, remapped };
}

/* ── 2. 改判记忆规则（越用越懂个人分类偏好） ─────── */

/** 公共聚合平台不按整站绑定，避免把整个 github.com / zhihu.com 锁死到单一类目 */
const SHARED_HOSTS = new Set([
  'github.com', 'gist.github.com', 'zhihu.com', 'zhuanlan.zhihu.com',
  'juejin.cn', 'bilibili.com', 'youtube.com', 'youtu.be', 'medium.com',
  'mp.weixin.qq.com', 'x.com', 'twitter.com', 'reddit.com', 'v2ex.com',
  'notion.so', 'feishu.cn', 'yuque.com', 'csdn.net', 'blog.csdn.net',
  'sspai.com', 'douban.com', 'wikipedia.org', 'zh.wikipedia.org', 'en.wikipedia.org',
  'google.com', 'baidu.com', 'pan.baidu.com',
]);

export function emptyLearned() {
  return { domains: {} };
}

export function recordOverride(learned, item, code, now = Date.now()) {
  const base = learned && learned.domains ? { domains: { ...learned.domains } } : emptyLearned();
  const host = String((item && item.host) || '').toLowerCase().replace(/^www\./, '');
  if (!host || !code || SHARED_HOSTS.has(host)) return base;
  const prev = base.domains[host];
  base.domains[host] = {
    code: String(code),
    count: prev && prev.code === String(code) ? (prev.count || 1) + 1 : 1,
    at: now,
  };
  // 控制体积，最多记 180 条最近高频域名
  const entries = Object.entries(base.domains);
  if (entries.length > 180) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    base.domains = Object.fromEntries(entries.slice(0, 180));
  }
  return base;
}

export function removeLearnedDomain(learned, host) {
  const base = learned && learned.domains ? { domains: { ...learned.domains } } : emptyLearned();
  delete base.domains[String(host || '').toLowerCase()];
  return base;
}

export function matchLearned(learned, item, validCodes) {
  if (!learned || !learned.domains || !item) return null;
  const host = String(item.host || '').toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const hit = learned.domains[host];
  if (!hit || !hit.code) return null;
  if (validCodes && !validCodes.has(hit.code)) return null;
  return {
    code: hit.code,
    conf: Math.min(0.92, 0.8 + Math.min(hit.count || 1, 4) * 0.03),
    reason: `遵循你的历史偏好（${host}）`,
    source: 'learned',
    model: '',
    promptVersion: '',
  };
}

/**
 * 换方案时按类名显式迁移域名改判记忆，防止杜威 100（编程）切到 PARA 100（项目）后高置信度错判。
 * 映射不上的条目显式作废并计数，不按编码硬套。
 */
export function migrateLearned(learned, { from = [], to = [] } = {}) {
  const domains = (learned && learned.domains) || {};
  const keyOf = (name) => String(name || '').trim().toLowerCase();
  const oldName = new Map((from || []).map((f) => [String(f.code), keyOf(f.name)]));
  const byName = new Map();
  for (const f of to || []) {
    const k = keyOf(f.name);
    if (k && !byName.has(k)) byName.set(k, f);
  }
  const next = {};
  let mapped = 0;
  let dropped = 0;
  for (const [host, entry] of Object.entries(domains)) {
    if (!entry || !entry.code) { dropped += 1; continue; }
    const was = oldName.get(String(entry.code));
    const hit = was ? byName.get(was) : null;
    if (!hit) { dropped += 1; continue; }
    next[host] = { ...entry, code: String(hit.code) };
    mapped += 1;
  }
  return { learned: { domains: next }, mapped, dropped };
}

export function formatLearnedExamples(learned, scheme = [], limit = 12) {
  if (!learned || !learned.domains) return '';
  const valid = new Map(scheme.map((f) => [f.code, f.name]));
  const rows = Object.entries(learned.domains)
    .filter(([, v]) => v && valid.has(v.code))
    .sort((a, b) => (b[1].count || 1) - (a[1].count || 1) || (b[1].at || 0) - (a[1].at || 0))
    .slice(0, limit);
  if (!rows.length) return '';
  return rows.map(([host, v]) => `- ${host} → ${v.code} ${valid.get(v.code)}`).join('\n');
}

/* ── 3. 书海拾遗（随机翻出久未重温的好藏卷） ────── */

export function pickSerendipity(items, { health = {}, meta = {}, count = 3, seed = Date.now() } = {}) {
  const pool = (items || []).filter((it) => {
    const h = health[it.id];
    if (h && DEAD.has(h.status)) return false;
    return /^https?:/i.test(it.url || '');
  });
  if (!pool.length) return [];

  // 给老收藏、未读、星标加权，然后确定性/伪随机抽取
  const now = Date.now();
  const scored = pool.map((it, idx) => {
    const m = meta[it.id] || {};
    const ageDays = it.added ? Math.max(0, (now - it.added) / 86400000) : 30;
    const bonus = (m.readState === 'unread' ? 30 : 0) + (m.star ? 20 : 0) + Math.min(40, ageDays / 10);
    // 简单可复现哈希扰动
    const h = Math.sin((seed + idx * 9301 + String(it.id).charCodeAt(0) * 49297)) * 10000;
    const rnd = h - Math.floor(h);
    return { item: it, weight: rnd * 100 + bonus };
  });

  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, Math.min(count, scored.length)).map((x) => x.item);
}

/* ── 4. 常阅 / 吃灰分析（基于可选 history 权限） ─── */

export function analyzeUsage(items, historyEntries = [], { now = Date.now(), dustyDays = 180, recentDays = 30 } = {}) {
  const byNorm = new Map();
  for (const h of historyEntries || []) {
    if (!h || !h.url) continue;
    const k = normalizeUrl(h.url);
    const prev = byNorm.get(k);
    const visits = (prev ? prev.visitCount : 0) + (h.visitCount || 1);
    const last = Math.max(prev ? prev.lastVisitTime : 0, h.lastVisitTime || 0);
    byNorm.set(k, { visitCount: visits, lastVisitTime: last });
  }

  const recentCut = now - recentDays * 86400000;
  const dustyCut = now - dustyDays * 86400000;
  const usage = {};
  const frequent = [];
  const dusty = [];

  for (const it of items || []) {
    const k = normalizeUrl(it.url);
    const stat = byNorm.get(k) || { visitCount: 0, lastVisitTime: 0 };
    usage[it.id] = stat;

    if (stat.visitCount >= 2 && stat.lastVisitTime >= recentCut) {
      frequent.push({ id: it.id, ...stat });
    }
    const isOldEnough = it.added && it.added < dustyCut;
    if (isOldEnough && (stat.visitCount === 0 || stat.lastVisitTime < dustyCut)) {
      dusty.push({ id: it.id, ...stat, added: it.added });
    }
  }

  frequent.sort((a, b) => b.visitCount - a.visitCount || b.lastVisitTime - a.lastVisitTime);
  dusty.sort((a, b) => (a.added || 0) - (b.added || 0));

  return {
    usage,
    frequentIds: frequent.map((x) => x.id),
    dustyIds: dusty.map((x) => x.id),
    summary: {
      frequent: frequent.length,
      dusty: dusty.length,
      analyzedAt: now,
    },
  };
}
