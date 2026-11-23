/**
 * 多维检索与拼音首字母匹配（纯函数，书库搜索 / 侧边栏 / Omnibox 共用）。
 *
 * 支持语法：
 *   domain:github.com / host: / site:
 *   code:500 / cat:500 / code:inbox
 *   status:dead | warn | moved | ok | unchecked
 *   tag:rust 或 #rust
 *   is:star | unread | read | dup | noted
 *   before:2025 | after:2025-06
 *   普通词：同时匹配标题、域名、路径、批注、标签与中文拼音首字母（如 rgzn → 人工智能）
 */

const PINYIN_BOUNDS = [
  ['a', '阿'], ['b', '八'], ['c', '嚓'], ['d', '哒'], ['e', '妸'], ['f', '发'],
  ['g', '旮'], ['h', '哈'], ['j', '讥'], ['k', '咔'], ['l', '垃'], ['m', '妈'],
  ['n', '拿'], ['o', '哦'], ['p', '啪'], ['q', '期'], ['r', '然'], ['s', '撒'],
  ['t', '塌'], ['w', '挖'], ['x', '昔'], ['y', '压'], ['z', '匝'],
];

const zhCollator = typeof Intl !== 'undefined' && Intl.Collator
  ? new Intl.Collator('zh-Hans-CN', { sensitivity: 'base' })
  : null;

const charCache = new Map();

function initialOfChar(ch) {
  if (/^[a-z0-9]$/i.test(ch)) return ch.toLowerCase();
  if (!/[\u4e00-\u9fff]/.test(ch)) return '';
  if (charCache.has(ch)) return charCache.get(ch);
  let res = '';
  if (zhCollator) {
    for (let i = PINYIN_BOUNDS.length - 1; i >= 0; i -= 1) {
      if (zhCollator.compare(ch, PINYIN_BOUNDS[i][1]) >= 0) {
        res = PINYIN_BOUNDS[i][0];
        break;
      }
    }
  }
  charCache.set(ch, res);
  return res;
}

/** 提取字符串的拼音首字母串（保留英文/数字，中文转声母首字母） */
export function pinyinInitials(str) {
  let out = '';
  for (const ch of String(str || '')) {
    const c = initialOfChar(ch);
    if (c) out += c;
  }
  return out;
}

function parseDateBound(val, isEnd) {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(String(val || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) - 1 : (isEnd ? 11 : 0);
  const d = m[3] ? Number(m[3]) : (isEnd ? 31 : 1);
  return isEnd
    ? new Date(y, mo, d, 23, 59, 59, 999).getTime()
    : new Date(y, mo, d, 0, 0, 0, 0).getTime();
}

/** 把原始搜索字符串拆成结构化过滤条件 + 自由词列表 */
export function parseQuery(raw) {
  const filters = {
    domains: [],
    codes: [],
    statuses: [],
    tags: [],
    flags: new Set(),
    before: null,
    after: null,
  };
  const terms = [];
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);

  for (const token of parts) {
    if (token.startsWith('#') && token.length > 1) {
      filters.tags.push(token.slice(1).toLowerCase());
      continue;
    }
    const idx = token.indexOf(':');
    if (idx > 0 && idx < token.length - 1) {
      const k = token.slice(0, idx).toLowerCase();
      const v = token.slice(idx + 1).toLowerCase();
      if (k === 'domain' || k === 'host' || k === 'site') {
        filters.domains.push(v);
        continue;
      }
      if (k === 'code' || k === 'cat') {
        filters.codes.push(v === 'inbox' || v === '待归类' ? '' : v.toUpperCase());
        continue;
      }
      if (k === 'status' || k === 'st') {
        filters.statuses.push(v);
        continue;
      }
      if (k === 'tag') {
        filters.tags.push(v);
        continue;
      }
      if (k === 'is' || k === 'has') {
        filters.flags.add(v);
        continue;
      }
      if (k === 'before') {
        const ts = parseDateBound(v, true);
        if (ts) { filters.before = ts; continue; }
      }
      if (k === 'after') {
        const ts = parseDateBound(v, false);
        if (ts) { filters.after = ts; continue; }
      }
    }
    terms.push(token.toLowerCase());
  }

  return { filters, terms };
}

const DEAD_SET = new Set(['dead', 'error', 'timeout', 'unreachable']);

function matchStatus(h, want) {
  if (want === 'unchecked' || want === 'none') return !h;
  if (!h) return false;
  if (want === 'dead' || want === 'bad') return DEAD_SET.has(h.status);
  if (want === 'warn' || want === 'susp' || want === 'blocked') return h.status === 'blocked';
  if (want === 'moved' || want === '301' || want === 'redirect') return h.status === 'moved';
  if (want === 'ok' || want === '200') return h.status === 'ok';
  return h.status === want || String(h.code || '').toLowerCase() === want;
}

/**
 * 过滤并按相关性打分（书库搜索、侧边栏、Omnibox 共用）。
 * @returns {Array<{item:object, score:number}>}
 */
export function filterAndScore(items, rawQuery, ctx = {}) {
  const { health = {}, meta = {}, scheme = [], dupIds = null } = ctx;
  const { filters, terms } = parseQuery(rawQuery);
  const nameByCode = new Map(scheme.map((f) => [f.code, f.name]));
  const out = [];

  for (const it of items || []) {
    const h = health[it.id] || null;
    const m = meta[it.id] || null;
    const tags = (m && Array.isArray(m.tags) ? m.tags : []).map((t) => t.toLowerCase());
    const note = (m && m.note ? String(m.note) : '').toLowerCase();

    // 结构化过滤
    if (filters.domains.length) {
      const host = String(it.host || '').toLowerCase();
      if (!filters.domains.some((d) => host.includes(d))) continue;
    }
    if (filters.codes.length) {
      const c = String(it.code || '').toUpperCase();
      if (!filters.codes.some((want) => want === c)) continue;
    }
    if (filters.statuses.length) {
      if (!filters.statuses.some((st) => matchStatus(h, st))) continue;
    }
    if (filters.tags.length) {
      if (!filters.tags.every((want) => tags.some((t) => t.includes(want)))) continue;
    }
    if (filters.flags.size) {
      let ok = true;
      for (const flag of filters.flags) {
        if (flag === 'star' || flag === 'starred') { if (!m || !m.star) ok = false; }
        else if (flag === 'unread') { if (!m || m.readState !== 'unread') ok = false; }
        else if (flag === 'read') { if (!m || m.readState !== 'read') ok = false; }
        else if (flag === 'noted' || flag === 'note') { if (!note) ok = false; }
        else if (flag === 'dup' || flag === 'duplicate') { if (!dupIds || !dupIds.has(it.id)) ok = false; }
      }
      if (!ok) continue;
    }
    if (filters.before != null && (!it.added || it.added > filters.before)) continue;
    if (filters.after != null && (!it.added || it.added < filters.after)) continue;

    // 自由词匹配 + 相关性计分
    let score = m && m.star ? 4 : 0;
    if (terms.length) {
      const titleLow = String(it.title || '').toLowerCase();
      const hostLow = String(it.host || '').toLowerCase();
      const urlLow = String(it.url || '').toLowerCase();
      const catLow = String((it.code ? `${it.code} ${nameByCode.get(it.code) || ''}` : '待归类')).toLowerCase();
      let initials = null;
      let matchedAll = true;

      for (const term of terms) {
        let termScore = 0;
        if (titleLow.includes(term)) {
          termScore = titleLow.startsWith(term) ? 30 : 20;
        } else if (hostLow.includes(term)) {
          termScore = 16;
        } else if (tags.some((t) => t.includes(term))) {
          termScore = 15;
        } else if (note.includes(term)) {
          termScore = 12;
        } else if (urlLow.includes(term)) {
          termScore = 10;
        } else if (catLow.includes(term)) {
          termScore = 8;
        } else if (/^[a-z0-9]{2,}$/.test(term)) {
          if (initials == null) initials = pinyinInitials(it.title || '') + ' ' + pinyinInitials(catLow);
          if (initials.includes(term)) termScore = 14;
        }

        if (!termScore) {
          matchedAll = false;
          break;
        }
        score += termScore;
      }
      if (!matchedAll) continue;
    }

    // 完好链接略优于失效链接
    if (h && DEAD_SET.has(h.status)) score -= 2;
    out.push({ item: it, score });
  }

  return out;
}

/** Omnibox 建议标题/描述转义（Chrome Omnibox 接受受限 XML 片段） */
export function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 构造 Chrome Omnibox 建议列表（最多 6 条） */
export function buildOmniboxSuggestions(items, rawQuery, ctx = {}, limit = 6) {
  const { scheme = [], health = {}, meta = {} } = ctx;
  const nameByCode = new Map(scheme.map((f) => [f.code, f.name]));
  const hits = filterAndScore(items, rawQuery, ctx)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : (b.item.added || 0) - (a.item.added || 0)))
    .slice(0, limit);

  return hits.map(({ item }) => {
    const cat = item.code ? `${item.code} ${nameByCode.get(item.code) || ''}`.trim() : '待归类';
    const h = health[item.id];
    const st = h && DEAD_SET.has(h.status) ? ` · ${h.code}` : h && h.status === 'moved' ? ' · 301' : '';
    const m = meta[item.id];
    const star = m && m.star ? '★ ' : '';
    const tagStr = m && m.tags && m.tags.length ? ' ' + m.tags.slice(0, 2).map((t) => '#' + t).join(' ') : '';
    const desc = `${star}<match>${escapeXml(item.title)}</match> <dim>— [${escapeXml(cat)}] ${escapeXml(item.host)}${escapeXml(tagStr)}${escapeXml(st)}</dim>`;
    return { content: item.url, description: desc };
  });
}
