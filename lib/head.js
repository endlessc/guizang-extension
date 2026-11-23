/**
 * 页面元信息流式读取、标题洗白与 Wayback Machine 时光机查询。
 *
 * - 只读响应体前 ~20KB（碰到 </head> 立刻掐断流），零整页下载负担。
 * - 不需要新增任何权限，复用已有 host_permissions。
 */

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(str) {
  return String(str || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
    const low = g.toLowerCase();
    if (ENTITY_MAP[low]) return ENTITY_MAP[low];
    if (low.startsWith('#x')) {
      const code = parseInt(low.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (low.startsWith('#')) {
      const code = parseInt(low.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

/** 从 HTML 头部片段提取 title 与 meta description / og:description */
export function parseHeadHtml(html) {
  const src = String(html || '');
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 140) : '';

  let desc = '';
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(src))) {
    const tag = m[0];
    const nameMatch = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!nameMatch) continue;
    const key = nameMatch[1].toLowerCase();
    if (key !== 'description' && key !== 'og:description' && key !== 'twitter:description') continue;
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const val = contentMatch ? decodeEntities(contentMatch[1] ?? contentMatch[2] ?? '').replace(/\s+/g, ' ').trim() : '';
    if (val && (!desc || key === 'description')) {
      desc = val.slice(0, 180);
      if (key === 'description') break;
    }
  }
  return { title, desc };
}

/** 判断书签标题是否信息量过弱（需要去拉 <head> 补充语义） */
export function isWeakTitle(title, url) {
  const t = String(title || '').trim();
  if (!t || t.length < 5) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^(home|index|dashboard|login|sign in|untitled|new tab|文档|首页|登录|微信公众平台)$/i.test(t)) return true;
  if (/mp\.weixin\.qq\.com|t\.co\/|bit\.ly\//i.test(String(url || '')) && t.length < 14) return true;
  return false;
}

/** 确定性标题清洗：去掉未读数角标、前后噪音符号与冗余空白 */
export function cleanTitleLocal(rawTitle, host = '') {
  let t = String(rawTitle || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!t) return t;
  // 去掉开头的未读提醒数字，例如 "(12) GitHub" / "[3] 通知"
  t = t.replace(/^(?:\(\d+\+?\)|\[\d+\+?\]|【\d+】)\s*/g, '');
  // 去掉多余首尾分隔符
  t = t.replace(/^[-–—|·:：]\s*/, '').replace(/\s*[-–—|·:：]$/, '').trim();
  // 如果标题以裸域名重复结尾（如 "文章标题 - example.com"），保留精简形态
  if (host) {
    const escHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*[-–—|·]\\s*(?:www\\.)?${escHost}$`, 'i'), '').trim();
  }
  return t || String(rawTitle || '').trim();
}

/** 流式抓取页面 <head>（最多读 maxBytes 字节，见到 </head> 立即中止） */
export async function fetchPageHead(url, { timeout = 5000, maxBytes = 20480, fetchImpl = fetch } = {}) {
  if (!/^https?:/i.test(url || '')) return { title: '', desc: '' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' },
    });
    const ct = String(res.headers?.get?.('content-type') || '');
    if (!res.ok || (ct && !/html|xml|text/i.test(ct))) {
      await res.body?.cancel?.().catch(() => {});
      return { title: '', desc: '' };
    }
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = (await res.text()).slice(0, maxBytes);
      return parseHeadHtml(text);
    }
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let total = 0;
    let buf = '';
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(buf)) break;
    }
    await reader.cancel().catch(() => {});
    return parseHeadHtml(buf);
  } catch {
    return { title: '', desc: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** 查询 Wayback Machine 可用历史快照 */
export async function lookupWayback(url, { timeout = 6500, fetchImpl = fetch } = {}) {
  const browseUrl = `https://web.archive.org/web/*/${url}`;
  if (!/^https?:/i.test(url || '')) return { available: false, browseUrl };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const res = await fetchImpl(api, { signal: ctrl.signal });
    if (!res.ok) return { available: false, browseUrl };
    const data = await res.json();
    const snap = data && data.archived_snapshots && data.archived_snapshots.closest;
    if (snap && snap.available && snap.url) {
      const ts = String(snap.timestamp || '');
      const dateLabel = ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : '';
      return {
        available: true,
        url: snap.url.replace(/^http:\/\//i, 'https://'),
        timestamp: ts,
        dateLabel,
        browseUrl,
      };
    }
    return { available: false, browseUrl };
  } catch {
    return { available: false, browseUrl };
  } finally {
    clearTimeout(timer);
  }
}
