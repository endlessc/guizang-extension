/* 页面共用：图标、消息、格式化、提示条 */

import { PROTO } from '../lib/version.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PATHS = {
  search: 'M6.4 2.2a4.2 4.2 0 100 8.4 4.2 4.2 0 000-8.4zM9.6 9.6L13.8 13.8',
  sparkle: 'M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2 6.5 9.5 1.8 8l4.7-1.5z',
  pulse: 'M1.4 8h2.8l1.4-4.4L8 13.2l1.6-5.2 1.2 3h3.8',
  sliders: 'M2.5 5h11M2.5 11h11M5.5 3v4M10.5 9v4',
  plus: 'M8 3.2v9.6M3.2 8h9.6',
  chevron: 'M6 3.5L10.5 8 6 12.5',
  chevronDown: 'M3.5 6L8 10.5 12.5 6',
  check: 'M3 8.4l3.3 3.2L13 4.6',
  x: 'M4 4l8 8M12 4l-8 8',
  folder: 'M1.8 5.2a1 1 0 011-1h2.8l1.2 1.7h5.4a1 1 0 011 1v5.4a1 1 0 01-1 1H2.8a1 1 0 01-1-1z',
  external: 'M9 2.4h4.6v4.6M13.4 2.6L7.2 8.8M11 9.6v3.2a1.2 1.2 0 01-1.2 1.2H3.6a1.2 1.2 0 01-1.2-1.2V6.6a1.2 1.2 0 011.2-1.2h3.2',
  trash: 'M2.6 4.6h10.8M6 4.6V3h4v1.6M4.2 4.6l.7 8.6h6.2l.7-8.6',
  refresh: 'M13.2 8a5.2 5.2 0 11-1.7-3.8M13.4 2.2v3.4h-3.4',
  dots: 'M8 3.2v.1M8 8v.1M8 12.8v.1',
  alert: 'M8 2.6l5.8 10.2H2.2zM8 6.4v3.4M8 11.6v.1',
  clock: 'M8 2.6a5.4 5.4 0 100 10.8A5.4 5.4 0 008 2.6zM8 5.2V8l2 1.3',
  stack: 'M2.4 5.4L8 2.6l5.6 2.8L8 8.2zM2.4 8.6L8 11.4l5.6-2.8M2.4 11.4L8 14.2l5.6-2.8',
  rows: 'M2.4 4.4h11.2M2.4 8h11.2M2.4 11.6h11.2',
  sort: 'M3 4.4h10M3 8h7M3 11.6h4',
  arrowRight: 'M3 8h10M9.4 4.4L13 8l-3.6 3.6',
  window: 'M2.2 4.2h11.6v8.4H2.2zM2.2 6.6h11.6',
  inbox: 'M2 9.2h3.2l.9 1.9h3.8l.9-1.9H14M2 9.2L3.6 3.8h8.8L14 9.2v3.4H2z',
  pencil: 'M11.5 2.5a1.4 1.4 0 012 2L4.5 13.5 2 14l.5-2.5 9-9z',
  copy: 'M5.5 4.5h6a1 1 0 011 1v7a1 1 0 01-1 1h-6a1 1 0 01-1-1v-7a1 1 0 011-1zM3.5 11.5H3a1 1 0 01-1-1v-7a1 1 0 011-1h6a1 1 0 011 1v.5',
  undo: 'M2.5 6.5h7a3.5 3.5 0 010 7H6M2.5 6.5L5.5 3.5M2.5 6.5l3 3',
  menu: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
  palette: 'M8 1.8a6.2 6.2 0 100 12.4c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6h1.4c1.9 0 3.4-1.5 3.4-3.4 0-4-3.4-7.2-7.2-7.2zm-3.6 6a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2zm2.6-2.6a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2zm4 0a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2zm2.6 2.6a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z',
  sun: 'M8 4.2a3.8 3.8 0 100 7.6 3.8 3.8 0 000-7.6zM8 1.5v1.5M8 13v1.5M2.5 8H4M12 8h1.5M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M3.8 12.2l1.1-1.1M11.1 4.9l1.1-1.1',
  moon: 'M13.2 9.4A6.2 6.2 0 016.6 2.8a6.4 6.4 0 106.6 6.6z',
};

export function icon(name, size = 16, sw = 1.4) {
  const d = PATHS[name];
  if (!d) return '';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true"><path d="${d}"/></svg>`;
}

export function mark(size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="0.75" y="0.75" width="22.5" height="22.5" rx="4.5" fill="#1B1811"/>
    <path d="M8.4 5.6v12.8" stroke="#F2EFE5" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M12.4 8.4h5.4M12.4 12h5.4M12.4 15.6h3.2" stroke="#F2EFE5" stroke-width="1.3"
      stroke-linecap="round" opacity="0.85"/></svg>`;
}

const STALE_HINT = '扩展后台还是旧版本：去 chrome://extensions 点一次「重新加载」';

export async function send(type, payload = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 扩展重载过，这个页面还活着但它的 chrome 上下文已经失效
    throw new Error(/context invalidated/i.test(msg) ? '扩展刚重载过，刷新这个页面即可' : msg);
  }
  if (!res) throw new Error(STALE_HINT);
  if (!res.ok) throw new Error(res.error || '未知错误');
  return res.data;
}

/** 页面启动时握一次手：后台的消息表是不是和这份页面代码同版本 */
export async function checkProto() {
  try {
    const r = await send('ping');
    return { ok: Boolean(r) && r.proto === PROTO, proto: r && r.proto, version: r && r.version };
  } catch {
    return { ok: false, proto: null };
  }
}

let toastTimer = null;
let currentUndoAction = null;

export function triggerUndo() {
  if (typeof currentUndoAction === 'function') {
    const fn = currentUndoAction;
    currentUndoAction = null;
    const box = $('#toast');
    if (box) box.classList.remove('on');
    clearTimeout(toastTimer);
    fn();
    return true;
  }
  return false;
}

export function toast(msg, opts = {}) {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const duration = opts.duration || (opts.actionText ? 5500 : 2600);
  currentUndoAction = opts.onAction || null;

  if (typeof msg === 'string' && !opts.actionText) {
    box.textContent = msg;
  } else {
    box.innerHTML = `<span>${esc(typeof msg === 'string' ? msg : msg.text || '')}</span>${
      opts.actionText ? ` <button class="toast-act" id="toastAct">${esc(opts.actionText)}</button>` : ''
    }`;
    if (opts.actionText && opts.onAction) {
      const btn = box.querySelector('#toastAct');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          box.classList.remove('on');
          clearTimeout(toastTimer);
          currentUndoAction = null;
          opts.onAction();
        });
      }
    }
  }
  box.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.remove('on');
    currentUndoAction = null;
  }, duration);
}

export function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.slice(0, 32);
  }
}

export function letterOf(host) {
  const core = String(host || 'g').replace(/^www\./, '').split('.')[0] || 'g';
  return core.slice(0, 1).toUpperCase();
}

export function faviconMark(host, isDead = false) {
  const h = host || '';
  const favUrl = h ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=32` : '';
  const letter = esc(letterOf(h));
  return `<span class="row-mark${isDead ? ' mark-dead' : ''}">
    ${h && !isDead ? `<img class="row-favicon" src="${favUrl}" loading="lazy" alt="" />` : ''}
    <span>${letter}</span>
  </span>`;
}

if (typeof document !== 'undefined') {
  document.addEventListener('error', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('row-favicon')) {
      e.target.remove();
    }
  }, true);
}

export function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getMonth() + 1}·${d.getDate()}`;
}

export function relTime(ms) {
  if (!ms) return '未检测';
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.round(d / 30)} 个月前`;
}

export const TONE = {
  ok: { label: '正常', cls: 'ok' },
  moved: { label: '已跳转', cls: 'mute' },
  dead: { label: '已失效', cls: 'dead' },
  blocked: { label: '疑似失效', cls: 'warn' },
  error: { label: '服务器错误', cls: 'dead' },
  timeout: { label: '超时', cls: 'dead' },
  unreachable: { label: '无法访问', cls: 'dead' },
  invalid: { label: '不可检测', cls: 'mute' },
};

export const PROBLEM = new Set(['dead', 'error', 'timeout', 'unreachable']);
export const SUSPECT = new Set(['blocked']);

export function healthOf(health, id) {
  return (health && health[id]) || null;
}

export function statusMark(h) {
  if (!h) return '<span class="st st-blank"></span>';
  if (h.status === 'ok') {
    const msText = h.ms ? `${h.ms}ms` : '';
    const title = `连通良好${msText ? ' · ' + msText : ''}${h.at ? ' · ' + relTime(h.at) : ''}`;
    return `<span class="st st-ok st-ok-subtle" title="${esc(title)}"><span class="st-dot"></span>${msText ? `<span class="st-code">${msText}</span>` : ''}</span>`;
  }
  const t = TONE[h.status] || TONE.invalid;
  return `<span class="st st-${t.cls}" title="${esc(t.label)} · ${esc(h.code)}"><span class="st-dot"></span><span class="st-code">${esc(h.code)}</span></span>`;
}

export function onBroadcast(handler) {
  chrome.runtime.onMessage.addListener((msg) => {
    handler(msg);
  });
}

export function debounce(fn, wait = 160) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export async function openManager() {
  await send('open:manager');
}

/** 收一条书签；已经有同网址的就只挪位置，避免留两份 */
export async function upsertBookmark({ url, title, folderId }) {
  const found = await chrome.bookmarks.search({ url });
  if (found && found.length) {
    await chrome.bookmarks.move(found[0].id, { parentId: folderId });
    return 'moved';
  }
  await send('bookmark:save', { url, title, folderId });
  return 'created';
}

/* ── 文人典籍配色系统 (Classical Themes) ──────────────── */

export const THEMES = [
  { id: 'system', name: '跟随系统', desc: '随系统晨昏自适', preview: ['#FAF8F2', '#141311', '#1E4468'] },
  { id: 'classic', name: '澄心松烟', desc: '温润米宣 · 霁蓝沉金', preview: ['#FAF8F2', '#1B1812', '#1E4468'] },
  { id: 'celadon', name: '雨过天青', desc: '北宋汝窑 · 黛绿素瓷', preview: ['#F4F7F6', '#132223', '#225C58'] },
  { id: 'amber', name: '琅嬛缃素', desc: '蜜蜡老卷 · 焦茶青铁', preview: ['#F7F2E2', '#261D15', '#2A4860'] },
  { id: 'bamboo', name: '竹简青霭', desc: '幽篁寒玉 · 苍竹青翠', preview: ['#F3F6F0', '#162119', '#2E5C3B'] },
  { id: 'dark', name: '宣纸夜泊', desc: '徽州老墨 · 素绢微光', preview: ['#141311', '#ECE7DA', '#467FA8'] },
  { id: 'lacquer', name: '玄玉泥金', desc: '深邃黑漆 · 泥金描纹', preview: ['#0F1215', '#E8EBF0', '#C9983E'] },
];

export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!theme || theme === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

let themeInited = false;
export function initTheme() {
  if (themeInited || typeof document === 'undefined') return;
  themeInited = true;
  let cached = null;
  if (typeof location !== 'undefined') {
    const p = new URLSearchParams(location.search);
    if (p.has('theme')) cached = p.get('theme');
  }
  if (!cached) {
    cached = (typeof localStorage !== 'undefined' && localStorage.getItem('guizang_theme')) || 'system';
  }
  applyTheme(cached);

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['theme'], (res) => {
      if (res && res.theme && !(typeof location !== 'undefined' && new URLSearchParams(location.search).has('theme'))) {
        localStorage.setItem('guizang_theme', res.theme);
        applyTheme(res.theme);
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'theme:changed' && msg.theme) {
        localStorage.setItem('guizang_theme', msg.theme);
        applyTheme(msg.theme);
      }
    });
  }
}

export async function setTheme(theme) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('guizang_theme', theme);
  }
  applyTheme(theme);
  try {
    await send('theme:set', { theme });
  } catch {
    // 忽略
  }
}

export function getTheme() {
  if (typeof location !== 'undefined') {
    const p = new URLSearchParams(location.search);
    if (p.has('theme')) return p.get('theme');
  }
  return (typeof localStorage !== 'undefined' && localStorage.getItem('guizang_theme')) || 'system';
}

initTheme();
