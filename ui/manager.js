/* 管理页：书架 / 列表与卡片墙 / 检查器 / 命令面板 / 逐卷审定 */

import {
  $, esc, icon, mark, send, toast, triggerUndo, fmtDate, relTime, faviconMark, wireFavicons,
  TONE, PROBLEM, SUSPECT, statusMark, onBroadcast, debounce, checkProto,
  THEMES, getTheme, setThemeAnimated,
} from './shared.js';
import { groupByCode } from '../lib/tree.js';
import { groupOps } from '../lib/organize.js';
import { findDuplicates, duplicateIdSet, removableCount } from '../lib/dedup.js';
import { filterAndScore, parseQuery } from '../lib/search.js';
import { toMarkdown, toSelectionMarkdown, toNetscapeHtml } from '../lib/export.js';
import { collectAllTags, pickSerendipity } from '../lib/meta.js';
import { PROTO } from '../lib/version.js';
import { createTriageController } from './triage.js';

import { ensureEnv } from './env.js';
await ensureEnv();

function readLocal(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

const S = {
  loaded: false,
  items: [],
  scheme: [],
  health: {},
  pending: {},
  meta: {},
  learned: { domains: {} },
  usageCache: null,
  usageTab: 'dusty',       // 'dusty' | 'frequent'
  settings: {},
  aiReady: false,
  scan: { running: false, done: 0, total: 0 },
  view: { kind: 'all' },
  viewMode: readLocal('guizang_view_mode', 'list'), // 'list' | 'cards' | 'compact'
  q: '',
  filterBarOpen: false,
  sortDir: -1,             // -1 新→旧，1 旧→新
  selected: null,
  sel: new Set(),
  lastCheckedId: null,
  renderLimit: 400,
  drawer: null,
  picking: null,           // 正在改判的建议 id
  editing: null,           // 正在编辑的书签 { id, title, url }
  aiBusy: false,
  aiProgress: null,
  pendingNote: 0,          // 因方案变化/类目消失而被清掉的建议数（提示一次）
  plan: null,              // 整理计划
  planBusy: false,
  planProgress: null,
  applyBusy: false,
  applyProgress: null,
  journal: null,           // 最近一次可撤销的整理
  journals: [],            // 最近 3 次整理日志
  orgScope: 'inbox',       // 'inbox' | 'all'
  orgTab: 'plan',          // 'plan' | 'clean'
  cleanList: null,         // AI 标题洗白建议列表
  cleanBusy: false,
  serendipityOpen: false,
  serendipitySeed: Date.now(),
  wayback: {},             // id -> { loading, available, url, dateLabel, browseUrl }
  dragIds: [],
  recentCodes: (() => {
    try { return JSON.parse(readLocal('guizang_recent_codes', '[]')) || []; } catch { return []; }
  })(),
  done: [],                // 刚归入的，做朱砂落印即时反馈
};

/* ── 矿物色带（全景比例尺 + 藏书卡片顶边共用） ── */

const MINERAL_PALETTE = [
  '#2E5E7E', '#3A7A68', '#A67C37', '#6E5A8A', '#B2523A',
  '#2F728A', '#577D4B', '#8E6A46', '#4C648E', '#9B6558',
];

function colorOfCode(code) {
  if (!code || code === 'none') return '#9C927F';
  const idx = S.scheme.findIndex((f) => f.code === code);
  if (idx >= 0) return MINERAL_PALETTE[idx % MINERAL_PALETTE.length];
  let hash = 0;
  for (const ch of String(code)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return MINERAL_PALETTE[hash % MINERAL_PALETTE.length];
}

function rememberRecentCode(code) {
  if (!code) return;
  S.recentCodes = [code, ...S.recentCodes.filter((c) => c !== code)].slice(0, 4);
  try { localStorage.setItem('guizang_recent_codes', JSON.stringify(S.recentCodes)); } catch {}
}

function setViewMode(mode) {
  if (!['list', 'cards', 'compact'].includes(mode)) return;
  S.viewMode = mode;
  try { localStorage.setItem('guizang_view_mode', mode); } catch {}
  renderHead();
  renderList();
}

function downloadFile(name, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 缃黄朱批关键词高亮 */
function highlightHtml(text) {
  const safe = esc(text);
  const q = S.q.trim();
  if (!q) return safe;
  const { terms } = parseQuery(q);
  const usable = terms.filter((t) => t.length >= 1);
  if (!usable.length) return safe;
  const pat = usable
    .map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  try {
    return safe.replace(new RegExp(`(${pat})`, 'gi'), '<mark class="hl">$1</mark>');
  } catch {
    return safe;
  }
}

/* ── 逐卷审定控制器（Triage 模式） ─────────────── */

const triage = createTriageController({
  getState: () => S,
  folderName: (code) => folderName(code),
  onReload: () => { load().catch(() => {}); },
});

/* ── 路由与 Hash 监听 ───────────────────────────── */

const BUILTIN_VIEWS = ['all', 'starred', 'unread', 'pending', 'dead', 'susp', 'moved', 'dups', 'unchecked', 'inbox', 'usage'];

function parseHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return;
  const p = new URLSearchParams(hash);
  const view = p.get('view');
  const drawer = p.get('drawer');
  const id = p.get('id');
  const q = p.get('q');
  const code = p.get('code');
  const tag = p.get('tag');
  const mode = p.get('mode');

  if (view) {
    if (BUILTIN_VIEWS.includes(view)) S.view = { kind: view };
    else if (view === 'tag' && tag) S.view = { kind: 'tag', tag };
    else if (view === 'folder') S.view = { kind: 'folder', code: code || 'none' };
    else S.view = { kind: 'folder', code: view };
  }
  if (mode && ['list', 'cards', 'compact'].includes(mode)) S.viewMode = mode;
  if (drawer) S.drawer = drawer;
  if (id) { S.selected = id; S.drawer = 'detail'; }
  if (q != null) S.q = q;
  if (p.get('modal') === 'shortcuts') setTimeout(openShortcutsModal, 50);
  if (p.get('modal') === 'cmd') setTimeout(openCommandPalette, 50);
  if (p.get('triage') === '1') setTimeout(() => triage.open(), 120);
}

window.addEventListener('hashchange', () => {
  parseHash();
  renderAll();
});

/* ── 派生数据 ─────────────────────────────────── */

function dupGroups() {
  return findDuplicates(S.items);
}

function counts() {
  const c = {
    all: S.items.length,
    starred: 0,
    unread: 0,
    dead: 0,
    susp: 0,
    moved: 0,
    dups: 0,
    unchecked: 0,
    pending: 0,
    inbox: 0,
  };
  for (const it of S.items) {
    if (!it.code) c.inbox += 1;
    const m = S.meta[it.id];
    if (m && m.star) c.starred += 1;
    if (m && m.readState === 'unread') c.unread += 1;
    const h = S.health[it.id];
    if (!h) c.unchecked += 1;
    else if (PROBLEM.has(h.status)) c.dead += 1;
    else if (SUSPECT.has(h.status)) c.susp += 1;
    else if (h.status === 'moved') c.moved += 1;
    if (S.pending[it.id]) c.pending += 1;
  }
  c.dups = removableCount(dupGroups());
  return c;
}

function folderName(code) {
  const f = S.scheme.find((x) => x.code === code);
  return f ? f.name : code;
}

function visible() {
  let rows = S.items;
  const v = S.view;
  if (v.kind === 'folder') rows = rows.filter((it) => (it.code || 'none') === v.code);
  else if (v.kind === 'starred') rows = rows.filter((it) => S.meta[it.id]?.star);
  else if (v.kind === 'unread') rows = rows.filter((it) => S.meta[it.id]?.readState === 'unread');
  else if (v.kind === 'dead') rows = rows.filter((it) => PROBLEM.has((S.health[it.id] || {}).status));
  else if (v.kind === 'susp') rows = rows.filter((it) => SUSPECT.has((S.health[it.id] || {}).status));
  else if (v.kind === 'moved') rows = rows.filter((it) => (S.health[it.id] || {}).status === 'moved');
  else if (v.kind === 'dups') {
    const ids = duplicateIdSet(dupGroups());
    rows = rows.filter((it) => ids.has(it.id));
  } else if (v.kind === 'pending') rows = rows.filter((it) => S.pending[it.id]);
  else if (v.kind === 'unchecked') rows = rows.filter((it) => !S.health[it.id]);
  else if (v.kind === 'inbox') rows = rows.filter((it) => !it.code);
  else if (v.kind === 'tag') {
    const want = String(v.tag || '').toLowerCase();
    rows = rows.filter((it) => (S.meta[it.id]?.tags || []).some((t) => t.toLowerCase() === want));
  } else if (v.kind === 'usage') {
    if (!S.usageCache) return [];
    const targetIds = new Set(S.usageTab === 'frequent' ? S.usageCache.frequentIds : S.usageCache.dustyIds);
    rows = rows.filter((it) => targetIds.has(it.id));
  }

  if (S.q.trim()) {
    const dupIds = duplicateIdSet(dupGroups());
    const scored = filterAndScore(rows, S.q, {
      health: S.health,
      meta: S.meta,
      scheme: S.scheme,
      dupIds,
    });
    return scored
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : ((a.item.added || 0) - (b.item.added || 0)) * S.sortDir))
      .map((x) => x.item);
  }

  if (v.kind === 'usage' && S.usageCache) {
    const order = S.usageTab === 'frequent' ? S.usageCache.frequentIds : S.usageCache.dustyIds;
    const rank = new Map(order.map((id, i) => [id, i]));
    return rows.slice().sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
  }

  return rows.slice().sort((a, b) => ((a.added || 0) - (b.added || 0)) * S.sortDir);
}

function viewMeta() {
  const v = S.view;
  if (v.kind === 'all') return { label: '全部收藏', note: '' };
  if (v.kind === 'starred') return { label: '星标精选', note: '加星置顶的常用典藏与参考书目。' };
  if (v.kind === 'unread') return { label: '稍后阅读', note: '标为未读的待看藏卷，读完可按 U 或在详情页切为已读。' };
  if (v.kind === 'folder') return { label: `${v.code === 'none' ? '—' : v.code} ${v.code === 'none' ? '待归类' : folderName(v.code)}`, note: '' };
  if (v.kind === 'pending') return { label: '归类建议', note: '这些书签拿到了 AI 建议，逐条确认后才会真的移动。' };
  if (v.kind === 'dead') return { label: '已失效', note: '这些地址已经打不开。详情页支持查 Wayback 时光机快照抢救，删前也可导出清单留底。' };
  if (v.kind === 'susp') return { label: '疑似失效', note: '返回 401 / 403 / 429，多半是反爬或需要登录，别急着删。' };
  if (v.kind === 'moved') return { label: '已跳转', note: '这些链接发生了 301 / 302 跳转，可核对新地址后一键批量更新。' };
  if (v.kind === 'dups') return { label: '重复书签', note: '按规范化 URL（忽略 http/https、尾斜杠、锚点与 utm 追踪参数）识别的重复收藏，每组优先保留已分类条目。' };
  if (v.kind === 'unchecked') return { label: '未检测', note: '还没体检过的书签。点「检测失效」即可按批推进。' };
  if (v.kind === 'inbox') return { label: '待归类', note: '可直接拖拽到左侧分类，或按 T 进入「逐卷审定」键盘极速清仓。' };
  if (v.kind === 'tag') return { label: `#${v.tag}`, note: '按旁挂标签交叉检索的结果，不影响 Chrome 原生书签文件夹结构。' };
  if (v.kind === 'usage') return { label: '常阅与吃灰', note: '结合本地浏览历史（按需授权）洞察高频常阅与超过半年未打开的尘封藏卷。' };
  return { label: '全部收藏', note: '' };
}

/* ── 顶栏与水墨涟漪配色菜单 ──────────────────── */

function renderThemeDropdown() {
  const dd = $('#themeDropdown');
  if (!dd) return;
  const current = getTheme();
  dd.innerHTML = `
    <div class="theme-drop-head">典籍配色方案 · 水墨切换</div>
    ${THEMES.map((th) => {
      const active = th.id === current;
      const swatches = th.preview.map((c) => `<span style="background:${c}"></span>`).join('');
      return `
        <button type="button" class="theme-item${active ? ' is-active' : ''}" data-theme-id="${th.id}">
          <span class="theme-swatch">${swatches}</span>
          <span class="theme-info">
            <span class="theme-name">${esc(th.name)}</span>
            <span class="theme-desc">${esc(th.desc)}</span>
          </span>
          <span class="theme-check">${icon('check', 13)}</span>
        </button>
      `;
    }).join('')}
  `;

  dd.querySelectorAll('.theme-item').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.themeId;
      if (!id) return;
      dd.hidden = true;
      await setThemeAnimated(id, e);
      const th = THEMES.find((t) => t.id === id);
      toast(`已应用配色：${th ? th.name : id}`);
    });
  });
}

const mobileMq = typeof window !== 'undefined' ? window.matchMedia('(max-width: 720px)') : null;

function syncMobileOverlay() {
  const overlay = $('#mobileOverlay');
  if (!overlay) return;
  const railOpen = Boolean($('.rail')?.classList.contains('is-mobile-open'));
  const drawerOverlay = Boolean(mobileMq && mobileMq.matches && S.drawer);
  overlay.hidden = !(railOpen || drawerOverlay);
}

$('#mobileOverlay')?.addEventListener('click', () => {
  $('.rail')?.classList.remove('is-mobile-open');
  if (mobileMq && mobileMq.matches && S.drawer) {
    S.drawer = null;
    S.editing = null;
    renderInspector();
    renderTop();
    renderRail();
  }
  syncMobileOverlay();
});

mobileMq?.addEventListener('change', syncMobileOverlay);

function renderTop() {
  const c = counts();
  const wasFocused = document.activeElement && document.activeElement.id === 'q';
  const caret = wasFocused ? document.activeElement.selectionStart : null;
  $('#topbar').innerHTML = `
    <button class="mobile-menu-btn" id="btnRailToggle" title="切换分类书架" aria-label="切换分类书架">${icon('menu', 16)}</button>
    <div class="brand">${mark(24)}<span class="brand-name">归藏</span><span class="brand-sub">GUIZANG</span></div>
    <label class="search">
      ${icon('search', 14)}
      <input id="q" value="${esc(S.q)}" placeholder="搜标题、拼音首字母、#标签 或 >命令" spellcheck="false" />
      <button type="button" class="search-clear" id="qClear" title="清空搜索" aria-label="清空搜索"${S.q ? '' : ' hidden'}>${icon('x', 12)}</button>
      <kbd id="qKbd"${S.q ? ' hidden' : ''}>⌘K</kbd>
    </label>
    <div class="top-actions">
      <button class="ai-btn${S.drawer === 'ai' ? ' is-open' : ''}" id="btnAi">
        ${icon('sparkle', 14)}<span>AI 归类</span>
        ${c.pending ? `<span class="ai-badge">${c.pending}</span>` : ''}
      </button>
      <button class="btn btn-line btn-md" id="btnScan">
        ${icon('pulse', 15)}<span>${S.scan.running ? '检测中 ' + S.scan.done + '/' + S.scan.total : '检测失效'}</span>
      </button>
      <span class="v-rule"></span>
      <button class="btn btn-ghost btn-md" id="btnCmd" title="命令面板 (⌘⇧P 或输入 >)" aria-label="命令面板">${icon('command', 15)}</button>
      <div class="theme-dropdown-wrap">
        <button class="btn btn-ghost btn-md" id="btnTheme" title="切换配色方案" aria-label="切换配色方案" aria-haspopup="true">
          ${icon('palette', 15)}
        </button>
        <div class="theme-dropdown" id="themeDropdown" hidden></div>
      </div>
      <button class="btn btn-ghost btn-md" id="btnOpt" title="设置" aria-label="设置">${icon('sliders', 15)}</button>
    </div>`;

  $('#btnRailToggle')?.addEventListener('click', () => {
    const rail = $('.rail');
    if (!rail) return;
    rail.classList.toggle('is-mobile-open');
    syncMobileOverlay();
  });

  $('#btnCmd')?.addEventListener('click', openCommandPalette);

  const btnTheme = $('#btnTheme');
  const themeDd = $('#themeDropdown');
  if (btnTheme && themeDd) {
    btnTheme.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = themeDd.hidden;
      if (isHidden) {
        renderThemeDropdown();
        themeDd.hidden = false;
      } else {
        themeDd.hidden = true;
      }
    });
  }

  const qInput = $('#q');
  const qClear = $('#qClear');
  const qKbd = $('#qKbd');
  const syncQClear = () => {
    const hasVal = Boolean(S.q);
    if (qClear) qClear.hidden = !hasVal;
    if (qKbd) qKbd.hidden = hasVal;
  };
  qInput.addEventListener('focus', () => {
    if (!S.filterBarOpen) {
      S.filterBarOpen = true;
      renderFilterBar();
    }
  });
  qInput.addEventListener('input', (e) => {
    if (e.target.value === '>') {
      qInput.value = '';
      S.q = '';
      syncQClear();
      openCommandPalette();
      return;
    }
    S.q = e.target.value;
    syncQClear();
    renderFilterBar();
    renderList();
    renderHead();
  });

  if (qClear) {
    qClear.addEventListener('click', (e) => {
      e.preventDefault();
      S.q = '';
      qInput.value = '';
      syncQClear();
      renderFilterBar();
      renderList();
      renderHead();
      qInput.focus();
    });
  }

  $('#btnAi').addEventListener('click', toggleAi);
  $('#btnScan').addEventListener('click', () => (S.scan.running ? stopScan() : scanView()));
  $('#btnOpt').addEventListener('click', () => chrome.runtime.openOptionsPage());

  if (wasFocused) {
    const q = $('#q');
    q.focus();
    if (caret != null) q.setSelectionRange(caret, caret);
  }
}

/* ── 搜索快捷筛选芯片 ──────────────────────────── */

function renderFilterBar() {
  const host = $('#filterBarHost');
  if (!host) return;
  const open = S.filterBarOpen || Boolean(S.q.trim());
  if (!open) { host.innerHTML = ''; return; }

  // 统计高频域名 Top 3
  const hostCount = new Map();
  for (const it of S.items) {
    if (it.host) hostCount.set(it.host, (hostCount.get(it.host) || 0) + 1);
  }
  const topHosts = [...hostCount.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => ({ label: h, token: `domain:${h}` }));

  const chips = [
    { label: '已失效', token: 'status:dead' },
    { label: '疑似失效', token: 'status:warn' },
    { label: '已跳转', token: 'status:moved' },
    { label: '星标', token: 'is:star' },
    { label: '未读', token: 'is:unread' },
    { label: '含批注', token: 'is:noted' },
    ...topHosts,
  ];
  const tokens = S.q.trim().split(/\s+/).filter(Boolean);

  host.innerHTML = `<div class="filter-bar">
    ${chips.map((ch) => {
      const on = tokens.some((t) => t.toLowerCase() === ch.token.toLowerCase());
      return `<button type="button" class="filter-chip${on ? ' is-on' : ''}" data-ftoken="${esc(ch.token)}">${esc(ch.label)}</button>`;
    }).join('')}
    ${S.q.trim() ? '<button type="button" class="filter-chip" id="btnFilterClear">清空</button>' : ''}
    <button type="button" class="ibtn" id="btnFilterClose" title="收起筛选条" style="width:22px;height:22px;margin-left:auto">${icon('x', 11)}</button>
  </div>`;

  host.querySelectorAll('[data-ftoken]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tok = btn.dataset.ftoken;
      const list = S.q.trim().split(/\s+/).filter(Boolean);
      const exists = list.some((t) => t.toLowerCase() === tok.toLowerCase());
      const next = exists
        ? list.filter((t) => t.toLowerCase() !== tok.toLowerCase())
        : [...list, tok];
      S.q = next.join(' ');
      const qInput = $('#q');
      if (qInput) qInput.value = S.q;
      const qClear = $('#qClear');
      const qKbd = $('#qKbd');
      if (qClear) qClear.hidden = !S.q;
      if (qKbd) qKbd.hidden = Boolean(S.q);
      renderFilterBar();
      renderHead();
      renderList();
    });
  });

  host.querySelector('#btnFilterClear')?.addEventListener('click', () => {
    S.q = '';
    const qInput = $('#q');
    if (qInput) qInput.value = '';
    const qClear = $('#qClear');
    const qKbd = $('#qKbd');
    if (qClear) qClear.hidden = true;
    if (qKbd) qKbd.hidden = false;
    renderFilterBar();
    renderHead();
    renderList();
  });

  host.querySelector('#btnFilterClose')?.addEventListener('click', () => {
    S.filterBarOpen = false;
    renderFilterBar();
  });
}

/* ── 书架 + 拖拽归类落点 ───────────────────────── */

function railItem({ code, name, count, bad, active, view, iconName, tone, dropKind = '' }) {
  const lead = code
    ? `<span class="rail-num">${esc(code)}</span>`
    : `<span class="rail-icon tone-${tone || 'ink'}">${icon(iconName, 13)}</span>`;
  const countTone = tone === 'dead' && count ? ' tone-dead' : tone === 'warn' && count ? ' tone-warn' : '';
  const tip = code ? `${code} ${name}（${count} 条${bad ? `，${bad} 条失效` : ''}，可拖入归类）` : `${name}（${count} 条）`;
  const dropAttr = dropKind ? ` data-drop-kind="${dropKind}"` : (code ? ` data-drop-code="${esc(code)}"` : '');
  return `<button class="rail-item${active ? ' is-active' : ''}" data-view="${view}"${dropAttr} title="${esc(tip)}">
    ${lead}
    <span class="rail-name">${esc(name)}</span>
    ${bad ? `<span class="rail-bad" title="${bad} 条失效">${bad}</span>` : ''}
    <span class="rail-count${countTone}">${count}</span>
  </button>`;
}

function wireRailDropTargets() {
  $('#rail').querySelectorAll('[data-drop-code],[data-drop-kind]').forEach((btn) => {
    btn.addEventListener('dragover', (e) => {
      if (!S.dragIds.length) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      btn.classList.add('is-drop-over');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('is-drop-over'));
    btn.addEventListener('drop', async (e) => {
      e.preventDefault();
      btn.classList.remove('is-drop-over');
      const ids = S.dragIds.slice();
      S.dragIds = [];
      if (!ids.length) return;

      const code = btn.dataset.dropCode;
      const kind = btn.dataset.dropKind;
      btn.classList.add('is-drop-pulse');
      setTimeout(() => btn.classList.remove('is-drop-pulse'), 480);

      if (code) {
        const snapshots = ids.map((id) => ({
          type: 'move',
          id,
          oldParentId: S.items.find((x) => x.id === id)?.parentId || '1',
        }));
        const r = await send('bookmarks:moveCode', { ids, code, learn: ids.length === 1 }).catch((err) => ({ error: err.message }));
        if (r.error) return toast(r.error);
        rememberRecentCode(code);
        S.sel.clear();
        await load();
        toast(`已拖入 ${code} ${folderName(code)}（${r.moved} 条）`, {
          actionText: '撤销',
          onAction: async () => {
            await send('bookmarks:restore', { items: snapshots });
            await load();
            toast('已撤销拖拽移动');
          },
        });
      } else if (kind === 'starred') {
        for (const id of ids) await send('meta:set', { id, patch: { star: true } }).catch(() => {});
        S.sel.clear();
        await load();
        toast(`已将 ${ids.length} 条加入星标精选`);
      } else if (kind === 'unread') {
        for (const id of ids) await send('meta:set', { id, patch: { readState: 'unread' } }).catch(() => {});
        S.sel.clear();
        await load();
        toast(`已将 ${ids.length} 条加入稍后阅读`);
      }
    });
  });
}

function renderRail() {
  const c = counts();
  const byCode = {};
  const badByCode = {};
  for (const it of S.items) {
    const k = it.code || 'none';
    byCode[k] = (byCode[k] || 0) + 1;
    if (PROBLEM.has((S.health[it.id] || {}).status)) badByCode[k] = (badByCode[k] || 0) + 1;
  }

  const parts = [];
  parts.push(railItem({ name: '全部收藏', count: c.all, view: 'all', iconName: 'stack', tone: 'ink', active: S.view.kind === 'all' }));
  parts.push(railItem({ name: '星标精选', count: c.starred, view: 'starred', iconName: 'star', tone: 'warn', active: S.view.kind === 'starred', dropKind: 'starred' }));
  parts.push(railItem({ name: '稍后阅读', count: c.unread, view: 'unread', iconName: 'bookmark', tone: 'brand', active: S.view.kind === 'unread', dropKind: 'unread' }));

  parts.push('<div class="section-label">智能视图</div>');
  parts.push(railItem({ name: '待归类', count: c.inbox, view: 'inbox', iconName: 'inbox', tone: 'brand', active: S.view.kind === 'inbox' }));
  parts.push(railItem({ name: '归类建议', count: c.pending, view: 'pending', iconName: 'sparkle', tone: 'brand', active: S.view.kind === 'pending' }));
  parts.push(railItem({ name: '整理与洗白', count: S.plan ? S.plan.ops.length : 0, view: '__organize', iconName: 'folder', tone: 'ink', active: S.drawer === 'organize' }));
  parts.push(railItem({ name: '已失效', count: c.dead, view: 'dead', iconName: 'alert', tone: 'dead', active: S.view.kind === 'dead' }));
  parts.push(railItem({ name: '疑似失效', count: c.susp, view: 'susp', iconName: 'clock', tone: 'warn', active: S.view.kind === 'susp' }));
  parts.push(railItem({ name: '已跳转', count: c.moved, view: 'moved', iconName: 'redirect', tone: 'ink', active: S.view.kind === 'moved' }));
  parts.push(railItem({ name: '重复书签', count: c.dups, view: 'dups', iconName: 'layers', tone: c.dups ? 'warn' : 'ink', active: S.view.kind === 'dups' }));
  parts.push(railItem({ name: '未检测', count: c.unchecked, view: 'unchecked', iconName: 'plus', tone: 'ink', active: S.view.kind === 'unchecked' }));
  parts.push(railItem({
    name: '常阅与吃灰',
    count: S.usageCache ? S.usageCache.summary.dusty : 0,
    view: 'usage',
    iconName: 'history',
    tone: 'ink',
    active: S.view.kind === 'usage',
  }));

  if (S.scheme.length) parts.push('<div class="section-label">分类<span class="section-aside">可拖入</span></div>');
  for (const f of S.scheme) {
    parts.push(railItem({
      code: f.code, name: f.name, count: byCode[f.code] || 0,
      bad: badByCode[f.code] || 0, view: f.code,
      active: S.view.kind === 'folder' && S.view.code === f.code,
    }));
  }

  const allTags = collectAllTags(S.meta);
  if (allTags.length) {
    parts.push('<div class="section-label">标签<span class="section-aside">#</span></div>');
    parts.push(`<div class="rail-tags">${allTags.slice(0, 18).map((t) => `
      <button type="button" class="rail-tag-chip${S.view.kind === 'tag' && S.view.tag === t.tag ? ' is-active' : ''}" data-tag="${esc(t.tag)}">
        <span>#${esc(t.tag)}</span><b>${t.count}</b>
      </button>`).join('')}</div>`);
  }

  $('#rail').innerHTML = parts.join('');
  $('#rail').querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (v === '__organize') {
        openOrganize();
        return;
      }
      S.view = BUILTIN_VIEWS.includes(v) ? { kind: v } : { kind: 'folder', code: v };
      S.selected = null;
      S.drawer = null;
      $('.rail')?.classList.remove('is-mobile-open');
      syncMobileOverlay();
      renderAll();
    });
  });

  $('#rail').querySelectorAll('[data-tag]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.view = { kind: 'tag', tag: btn.dataset.tag };
      S.selected = null;
      S.drawer = null;
      $('.rail')?.classList.remove('is-mobile-open');
      syncMobileOverlay();
      renderAll();
    });
  });

  wireRailDropTargets();

  const last = newestCheck();
  $('#railFoot').innerHTML = `
    <div class="rail-foot-row"><span class="dot-idle"></span>${last ? '上次检测 ' + relTime(last) : '还没有检测过'}</div>
    <button class="rail-foot-link" id="btnScanAll">${icon('pulse', 12)} 检测当前视图全部</button>
    <button class="rail-foot-link is-subtle" id="btnShortcutsHelp">${icon('window', 12)} 快捷键速查 <kbd>?</kbd></button>`;
  $('#btnScanAll').addEventListener('click', scanView);
  $('#btnShortcutsHelp')?.addEventListener('click', openShortcutsModal);
}

function newestCheck() {
  let max = 0;
  for (const id in S.health) {
    const at = S.health[id] && S.health[id].at;
    if (at && at > max) max = at;
  }
  return max;
}

/* ── 藏书全景丝带 + 书海拾遗 + 列表头 ──────────── */

function spectrumHtml() {
  if (S.view.kind !== 'all' || S.q.trim() || !S.items.length) return '';
  const total = S.items.length;
  const byCode = new Map();
  let inboxN = 0;
  for (const it of S.items) {
    if (!it.code) inboxN += 1;
    else byCode.set(it.code, (byCode.get(it.code) || 0) + 1);
  }
  const segs = [];
  for (const f of S.scheme) {
    const n = byCode.get(f.code) || 0;
    if (!n) continue;
    segs.push({ code: f.code, name: `${f.code} ${f.name}`, count: n, color: colorOfCode(f.code), view: f.code });
  }
  if (inboxN) {
    segs.push({ code: 'inbox', name: '待归类', count: inboxN, color: '#9C927F', view: 'inbox' });
  }
  if (!segs.length) return '';
  return `<div class="spectrum" id="spectrum">
    <div class="spectrum-bar">
      ${segs.map((s) => {
        const pct = Math.max(1.5, (s.count / total) * 100);
        return `<button type="button" class="spectrum-seg" style="flex:${pct} 0 0;background:${s.color}"
          data-spec-view="${esc(s.view)}" data-spec-name="${esc(s.name)}" data-spec-count="${s.count}" data-spec-color="${s.color}"
          title="${esc(s.name)} · ${s.count} 卷 (${Math.round((s.count / total) * 100)}%)"></button>`;
      }).join('')}
    </div>
    <div class="spectrum-legend" id="spectrumLegend">
      <span class="spectrum-legend-hint">藏书分布全景 · 共 ${segs.length} 个分卷 · 悬停查看占比，点击直达</span>
    </div>
  </div>`;
}

function serendipityHtml() {
  if (!S.serendipityOpen) return '';
  const picks = pickSerendipity(S.items, { health: S.health, meta: S.meta, count: 3, seed: S.serendipitySeed });
  if (!picks.length) return '';
  return `<div class="serendipity">
    <div class="serendipity-head">
      <span class="serendipity-title">${icon('compass', 14)} 书海拾遗</span>
      <span class="serendipity-sub">随机翻出 3 卷久未重温的完好藏书</span>
      <div class="serendipity-tools">
        <button type="button" class="btn btn-ghost btn-sm" id="btnSerendipityRefresh">${icon('refresh', 12)}<span>换一批</span></button>
        <button type="button" class="ibtn" id="btnSerendipityClose" title="收起" style="width:24px;height:24px">${icon('x', 12)}</button>
      </div>
    </div>
    <div class="serendipity-grid">
      ${picks.map((it) => `<button type="button" class="serendipity-card" data-serendipity-id="${esc(it.id)}">
        <div class="serendipity-card-title">${esc(it.title)}</div>
        <div class="serendipity-card-meta">
          <span class="serendipity-card-host">${esc(it.host)}</span>
          <span class="tnum">${it.code || '待归类'} · ${fmtDate(it.added)}</span>
        </div>
      </button>`).join('')}
    </div>
  </div>`;
}

function renderHead() {
  const rows = visible();
  const meta = viewMeta();
  const dGroups = S.view.kind === 'dups' ? dupGroups() : [];
  const dupRemovable = removableCount(dGroups);
  const movedReady = S.view.kind === 'moved' ? rows.filter((it) => S.health[it.id]?.finalUrl) : [];
  const canTriage = (S.view.kind === 'inbox' || S.view.kind === 'pending') && rows.length > 0;

  $('#listHead').innerHTML = `
    <div class="list-head">
    <div class="crumbs">
      <span class="crumb-dim">书库</span>
      ${icon('chevron', 10, 1.4)}
      <span class="crumb-now">${esc(meta.label)}</span>
      <span class="crumb-count tnum">${rows.length}</span>
    </div>
    <div class="list-tools">
      ${canTriage ? `<button class="btn btn-line btn-sm" id="btnTriage" title="逐卷审定沉浸归档 (T)">${icon('triage', 13)}<span>逐卷审定</span></button>` : ''}
      ${S.view.kind === 'inbox' && rows.length ? `<button class="btn btn-primary btn-sm" id="btnClassifyInbox">${icon('sparkle', 13)}<span>AI 归类这 ${rows.length} 条</span></button>` : ''}
      ${S.view.kind === 'moved' && movedReady.length ? `<button class="btn btn-primary btn-sm" id="btnApplyRedirects">${icon('check', 13)}<span>一键更新 ${movedReady.length} 条跳转</span></button>` : ''}
      ${S.view.kind === 'dups' && dupRemovable ? `<button class="btn btn-primary btn-sm" id="btnCleanDups">${icon('trash', 13)}<span>一键清理 ${dupRemovable} 条重复</span></button>` : ''}
      ${S.view.kind === 'dead' ? `<button class="btn btn-line btn-sm" id="btnExport">${icon('download', 13)}<span>导出 TSV</span></button>` : ''}
      ${S.view.kind === 'usage' && S.usageCache ? `
        <div class="seg-tabs">
          <button type="button" class="seg-tab${S.usageTab === 'dusty' ? ' is-active' : ''}" data-usage-tab="dusty">尘封吃灰 (${S.usageCache.summary.dusty})</button>
          <button type="button" class="seg-tab${S.usageTab === 'frequent' ? ' is-active' : ''}" data-usage-tab="frequent">高频常阅 (${S.usageCache.summary.frequent})</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="btnReanalyzeUsage" title="重新扫描浏览历史">${icon('refresh', 13)}</button>
      ` : ''}
      <div class="seg-tabs" title="切换视图密度 (V)">
        <button type="button" class="seg-tab${S.viewMode === 'list' ? ' is-active' : ''}" data-view-mode="list" title="典藏列表" style="padding:3px 6px">${icon('rows', 13)}</button>
        <button type="button" class="seg-tab${S.viewMode === 'cards' ? ' is-active' : ''}" data-view-mode="cards" title="藏书卡片墙" style="padding:3px 6px">${icon('grid', 13)}</button>
        <button type="button" class="seg-tab${S.viewMode === 'compact' ? ' is-active' : ''}" data-view-mode="compact" title="紧凑单行索引" style="padding:3px 6px">${icon('compact', 13)}</button>
      </div>
      <button class="btn btn-ghost btn-sm${S.serendipityOpen ? ' is-on' : ''}" id="btnSerendipity" title="书海拾遗：随机重温 3 条旧藏卷">${icon('compass', 14)}</button>
      <button class="btn btn-ghost btn-sm" id="btnExportModal" title="导出书目（Obsidian Markdown / HTML）">${icon('download', 14)}</button>
      <button class="btn btn-ghost btn-sm${S.sortDir === 1 ? ' is-on' : ''}" id="btnSort"
        aria-pressed="${S.sortDir === 1}"
        title="${S.sortDir === -1 ? '添加时间：新→旧，点击切为旧→新' : '添加时间：旧→新，点击切为新→旧'}">${icon('sort', 15)}</button>
    </div>
    </div>
    ${meta.note ? `<p class="list-note">${esc(meta.note)}</p>` : ''}
    ${spectrumHtml()}
    ${serendipityHtml()}`;

  // 全景丝带悬停与点击
  const spec = $('#spectrum');
  const specLegend = $('#spectrumLegend');
  if (spec && specLegend) {
    const defaultLegend = specLegend.innerHTML;
    const total = S.items.length || 1;
    spec.querySelectorAll('.spectrum-seg').forEach((seg) => {
      seg.addEventListener('mouseenter', () => {
        const pct = Math.round((Number(seg.dataset.specCount) / total) * 100);
        specLegend.innerHTML = `<span class="spectrum-legend-now"><span class="spectrum-legend-dot" style="background:${seg.dataset.specColor}"></span>${esc(seg.dataset.specName)} · <b class="tnum">${seg.dataset.specCount}</b> 卷（${pct}%）</span>`;
      });
      seg.addEventListener('click', () => {
        const v = seg.dataset.specView;
        S.view = v === 'inbox' ? { kind: 'inbox' } : { kind: 'folder', code: v };
        S.selected = null;
        renderAll();
      });
    });
    spec.addEventListener('mouseleave', () => { specLegend.innerHTML = defaultLegend; });
  }

  $('#listHead').querySelectorAll('[data-view-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.viewMode));
  });

  $('#btnTriage')?.addEventListener('click', () => triage.open(rows));
  $('#btnExport')?.addEventListener('click', exportDead);
  $('#btnExportModal')?.addEventListener('click', openExportModal);
  $('#btnSerendipity')?.addEventListener('click', () => {
    S.serendipityOpen = !S.serendipityOpen;
    if (S.serendipityOpen) S.serendipitySeed = Date.now();
    renderHead();
  });
  $('#btnSerendipityRefresh')?.addEventListener('click', () => {
    S.serendipitySeed = Date.now() + Math.random() * 1000;
    renderHead();
  });
  $('#btnSerendipityClose')?.addEventListener('click', () => {
    S.serendipityOpen = false;
    renderHead();
  });
  $('#listHead').querySelectorAll('[data-serendipity-id]').forEach((el) => {
    el.addEventListener('click', () => {
      S.selected = el.dataset.serendipityId;
      S.drawer = 'detail';
      syncSelectionInPlace();
      renderInspector();
    });
  });

  $('#btnClassifyInbox')?.addEventListener('click', () => {
    S.drawer = 'ai';
    renderInspector();
    renderTop();
    runAi(rows.map((r) => r.id));
  });

  $('#btnApplyRedirects')?.addEventListener('click', async () => {
    const ids = movedReady.map((it) => it.id);
    const r = await send('health:applyRedirects', { ids }).catch((e) => ({ error: e.message }));
    if (r.error) return toast(r.error);
    await load();
    toast(`已更新 ${r.updated} 条跳转链接`, r.prev && r.prev.length ? {
      actionText: '撤销',
      onAction: async () => {
        await send('bookmarks:restore', { items: r.prev.map((x) => ({ type: 'url', id: x.id, oldUrl: x.oldUrl })) });
        await load();
        toast('已撤销跳转更新');
      },
    } : undefined);
  });

  $('#btnCleanDups')?.addEventListener('click', async () => {
    const ids = dGroups.flatMap((g) => g.removeIds);
    const snapshots = ids.map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
    const r = await send('bookmarks:remove', { ids }).catch((e) => ({ error: e.message }));
    if (r.error) return toast(r.error);
    await load();
    toast(`已清理 ${r.removed} 条重复书签`, {
      actionText: '撤销',
      onAction: async () => {
        await send('bookmarks:restore', { items: snapshots.map((it) => ({ type: 'delete', ...it })) });
        await load();
        toast('已撤销重复清理');
      },
    });
  });

  $('#listHead').querySelectorAll('[data-usage-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.usageTab = btn.dataset.usageTab;
      renderHead();
      renderList();
    });
  });
  $('#btnReanalyzeUsage')?.addEventListener('click', analyzeHistoryNow);

  $('#btnSort')?.addEventListener('click', () => {
    S.sortDir = S.sortDir === -1 ? 1 : -1;
    renderHead();
    renderList();
  });
}

async function analyzeHistoryNow() {
  try {
    const ok = chrome.permissions?.request
      ? await chrome.permissions.request({ permissions: ['history'] }).catch(() => false)
      : true;
    if (!ok) return toast('未获得浏览历史权限，无法分析访问频次');
    const res = await send('history:analyze');
    S.usageCache = res;
    renderAll();
    toast(`分析完成：常阅 ${res.summary.frequent} 卷 · 吃灰 ${res.summary.dusty} 卷`);
  } catch (e) {
    toast(e.message);
  }
}

/* ── 无闪烁原地更新选中与勾选态（120fps 丝滑巡航） ── */

function syncSelectionInPlace() {
  const list = $('#list');
  if (!list) return;
  list.querySelectorAll('[data-id]').forEach((el) => {
    const id = el.dataset.id;
    el.classList.toggle('row-active', S.selected === id);
    const cb = el.querySelector('[data-check]');
    if (cb) {
      const on = S.sel.has(id);
      cb.classList.toggle('cb-on', on);
      cb.setAttribute('aria-checked', String(on));
      cb.innerHTML = on ? icon('check', 10, 2.2) : '';
    }
  });
  const cbAll = $('#cbAll');
  if (cbAll) {
    const shown = visible().slice(0, S.renderLimit || 400);
    const allChecked = shown.length > 0 && shown.every((it) => S.sel.has(it.id));
    cbAll.classList.toggle('cb-on', allChecked);
    cbAll.setAttribute('aria-checked', String(allChecked));
    cbAll.innerHTML = allChecked ? icon('check', 10, 2.2) : '';
  }
  renderSelBar();
}

/* ── 列表行 & 藏书票卡片渲染 ───────────────────── */

function rowHtml(it, opts = {}) {
  const { showCat = false, dupRole = '' } = opts;
  const h = S.health[it.id];
  const m = S.meta[it.id] || {};
  const pend = S.pending[it.id];
  const dead = PROBLEM.has((h || {}).status);
  const active = S.selected === it.id;
  const checked = S.sel.has(it.id);
  const moved = h && h.status === 'moved' && h.finalUrl;
  const catBadge = showCat
    ? `<span class="row-cat tnum">${it.code ? `${esc(it.code)} ${esc(folderName(it.code))}` : '待归类'}</span>`
    : '';
  const dupBadge = dupRole === 'keep'
    ? '<span class="row-keep-pill">建议保留</span>'
    : dupRole === 'dup'
      ? '<span class="row-dup-pill">重复项</span>'
      : '';
  const tagsHtml = (m.tags || []).slice(0, 2).map((t) => `<span class="row-tag">#${esc(t)}</span>`).join('');
  const usagePill = S.view.kind === 'usage' && S.usageCache && S.usageCache.usage[it.id]
    ? (() => {
        const u = S.usageCache.usage[it.id];
        return S.usageTab === 'frequent'
          ? `<span class="usage-meta-pill tnum">近30天 ${u.visitCount} 次</span>`
          : `<span class="usage-meta-pill tnum">${u.visitCount ? '最近 ' + relTime(u.lastVisitTime) : '从未打开'}</span>`;
      })()
    : '';

  return `<div class="row${active ? ' row-active' : ''}" data-id="${esc(it.id)}" draggable="true" tabindex="0">
    <span class="cb${checked ? ' cb-on' : ''}" data-check="${esc(it.id)}" role="checkbox" tabindex="0"
      aria-checked="${checked}">${checked ? icon('check', 10, 2.2) : ''}</span>
    ${faviconMark(it.host, dead, it.url)}
    <div class="row-main">
      <div class="row-title" data-title-host="${esc(it.id)}">${m.star ? '<span class="row-star" title="星标精选">★</span>' : ''}${highlightHtml(it.title)}</div>
      <div class="row-meta">
        ${m.readState === 'unread' ? '<span class="row-unread-dot" title="稍后阅读（未读）"></span>' : ''}
        <span class="host">${highlightHtml(it.host)}</span>
        ${dupBadge}${catBadge}${tagsHtml}${usagePill}
      </div>
    </div>
    ${pend ? `<span class="row-suggest" title="AI 建议归入 ${esc(pend.code)} ${esc(folderName(pend.code))}">${icon('arrowRight', 11)}<span class="tnum">${esc(pend.code)}</span></span>` : '<span class="row-suggest is-empty"></span>'}
    ${moved ? `<span class="st st-warn" title="已跳转至新地址，可在详情中更新"><span class="st-dot"></span><span class="st-code">301</span></span>` : statusMark(h)}
    <time class="row-date tnum">${fmtDate(it.added)}</time>
    <div class="row-actions">
      <button class="act-btn" data-quick-open="${esc(it.id)}" title="在新标签打开" aria-label="在新标签打开">${icon('external', 13)}</button>
      <button class="act-btn" data-quick-move="${esc(it.id)}" title="移动分类" aria-label="移动分类">${icon('folder', 13)}</button>
      <button class="act-btn" data-quick-check="${esc(it.id)}" title="单条重测" aria-label="单条重测">${icon('pulse', 13)}</button>
      <button class="act-btn is-danger" data-quick-del="${esc(it.id)}" title="删除" aria-label="删除">${icon('trash', 13)}</button>
    </div>
  </div>`;
}

function cardTileHtml(it, opts = {}) {
  const { dupRole = '' } = opts;
  const h = S.health[it.id];
  const m = S.meta[it.id] || {};
  const pend = S.pending[it.id];
  const dead = PROBLEM.has((h || {}).status);
  const active = S.selected === it.id;
  const checked = S.sel.has(it.id);
  const moved = h && h.status === 'moved' && h.finalUrl;
  const accent = colorOfCode(it.code);
  const dupBadge = dupRole === 'keep'
    ? '<span class="row-keep-pill">建议保留</span>'
    : dupRole === 'dup'
      ? '<span class="row-dup-pill">重复项</span>'
      : '';
  const tagsHtml = (m.tags || []).slice(0, 3).map((t) => `<span class="row-tag">#${esc(t)}</span>`).join('');

  return `<div class="card-tile${active ? ' row-active' : ''}" data-id="${esc(it.id)}" style="--tile-accent:${accent}" draggable="true" tabindex="0">
    <div class="card-tile-top">
      <span class="cb${checked ? ' cb-on' : ''}" data-check="${esc(it.id)}" role="checkbox" tabindex="0"
        aria-checked="${checked}">${checked ? icon('check', 10, 2.2) : ''}</span>
      ${faviconMark(it.host, dead, it.url)}
      ${m.star ? '<span class="row-star" title="星标精选">★</span>' : ''}
      ${m.readState === 'unread' ? '<span class="row-unread-dot" title="未读"></span>' : ''}
      <span class="card-tile-spacer"></span>
      ${moved ? '<span class="st st-warn"><span class="st-dot"></span><span class="st-code">301</span></span>' : statusMark(h)}
    </div>
    <div class="card-tile-title" data-title-host="${esc(it.id)}">${highlightHtml(it.title)}</div>
    <div class="card-tile-host">${highlightHtml(it.host)}</div>
    ${m.note ? `<div class="card-tile-note">${esc(m.note)}</div>` : ''}
    <div class="card-tile-foot">
      <span class="row-cat tnum">${it.code ? `${esc(it.code)} ${esc(folderName(it.code))}` : '待归类'}</span>
      ${dupBadge}${tagsHtml}
      ${pend ? `<span class="row-suggest">${icon('arrowRight', 10)}<span class="tnum">${esc(pend.code)}</span></span>` : ''}
      <time class="card-tile-date">${fmtDate(it.added)}</time>
    </div>
    <div class="row-actions">
      <button class="act-btn" data-quick-open="${esc(it.id)}" title="在新标签打开" aria-label="打开">${icon('external', 13)}</button>
      <button class="act-btn" data-quick-move="${esc(it.id)}" title="移动分类" aria-label="移动">${icon('folder', 13)}</button>
      <button class="act-btn" data-quick-check="${esc(it.id)}" title="单条重测" aria-label="重测">${icon('pulse', 13)}</button>
      <button class="act-btn is-danger" data-quick-del="${esc(it.id)}" title="删除" aria-label="删除">${icon('trash', 13)}</button>
    </div>
  </div>`;
}

function renderList() {
  const rows = visible();
  const list = $('#list');
  const colHost = $('#colHeadHost');
  const isCards = S.viewMode === 'cards';
  list.classList.toggle('mode-compact', S.viewMode === 'compact');

  if (S.view.kind === 'usage' && !S.usageCache) {
    if (colHost) colHost.innerHTML = '';
    list.innerHTML = `
      <div class="usage-banner">
        <div class="usage-banner-text">
          <strong>按需授权本地浏览历史</strong><br>
          归藏不会默认索取历史权限。点击右侧按钮授予 <code>history</code> 权限后，将在本机比对书签访问频次，帮你揪出超过半年未打开的「尘封书卷」与高频「常阅藏书」。
        </div>
        <button type="button" class="btn btn-primary btn-md" id="btnGrantHistory">${icon('history', 14)}<span>授权并扫描</span></button>
      </div>`;
    $('#btnGrantHistory')?.addEventListener('click', analyzeHistoryNow);
    return;
  }

  if (!S.items.length) {
    if (colHost) colHost.innerHTML = '';
    list.innerHTML = `<div class="empty"><div class="empty-rule"></div>
      <div class="empty-title">这里还没有书签</div>
      <div class="empty-hint">先在 Chrome 里存几条，或者用扩展弹窗把当前页收进来。</div></div>`;
    return;
  }

  const shown = rows.slice(0, S.renderLimit || 400);

  if (!shown.length) {
    if (colHost) colHost.innerHTML = '';
    if (S.q.trim()) {
      list.innerHTML = `<div class="empty">
        <div class="empty-mark">${icon('search', 22)}</div>
        <div class="empty-title">未寻得与「${esc(S.q)}」相符之藏卷</div>
        <div class="empty-hint">支持中文拼音首字母（如 <code>rgzn</code>）、<code>#标签</code>、<code>domain:github.com</code>、<code>status:dead</code>，按 <kbd>Esc</kbd> 清空检索。</div>
      </div>`;
    } else if (S.view.kind === 'dead') {
      list.innerHTML = `<div class="empty">
        <div class="empty-mark tone-ok">${icon('check', 22)}</div>
        <div class="empty-title">卷目完好，未见湮灭链接</div>
        <div class="empty-hint">当前没有检测到失效书签。可点击左下角重新核验。</div>
      </div>`;
    } else if (S.view.kind === 'dups') {
      list.innerHTML = `<div class="empty">
        <div class="empty-mark tone-ok">${icon('check', 22)}</div>
        <div class="empty-title">书库洁净，未发现重复收藏</div>
        <div class="empty-hint">已按规范化地址（忽略追踪参数与锚点）全量扫描。</div>
      </div>`;
    } else if (S.view.kind === 'moved') {
      list.innerHTML = `<div class="empty">
        <div class="empty-mark tone-ok">${icon('check', 22)}</div>
        <div class="empty-title">暂无待更新的重定向链接</div>
        <div class="empty-hint">检测发现 301 / 302 跳转后会在此集中列出，支持一键批量换新。</div>
      </div>`;
    } else if (S.view.kind === 'pending') {
      list.innerHTML = `<div class="empty">
        <div class="empty-mark tone-brand">${icon('sparkle', 22)}</div>
        <div class="empty-title">卷目已清，暂无待决建议</div>
        <div class="empty-hint">所有书签皆已妥善归类。收录新网址时，建议将在此呈递。</div>
      </div>`;
    } else {
      list.innerHTML = `<div class="empty">
        <div class="empty-rule"></div>
        <div class="empty-title">此部目下尚无藏卷</div>
        <div class="empty-hint">可使用顶栏搜寻，或直接把其他书签拖拽到左侧此分卷中。</div>
      </div>`;
    }
    return;
  }

  let body = '';
  const flat = Boolean(
    ['folder', 'dead', 'susp', 'moved', 'starred', 'unread', 'tag', 'usage'].includes(S.view.kind) || S.q.trim()
  );
  const showCat = flat && S.view.kind !== 'folder';
  const itemRenderer = (it, o) => (isCards ? cardTileHtml(it, o) : rowHtml(it, o));
  const wrapItems = (html) => (isCards ? `<div class="cards-grid">${html}</div>` : html);

  if (S.view.kind === 'dups' && !S.q.trim()) {
    const groups = dupGroups();
    body = groups.map((g, idx) => `<div class="group-head">
        <span class="group-num">#${idx + 1}</span>
        <span class="group-name">${esc(g.host || g.key)}</span>
        <span class="group-count">${g.items.length} 条重复</span>
        <span class="group-rule"></span>
      </div>` + wrapItems(g.items.map((it) => itemRenderer(it, { showCat: true, dupRole: it.id === g.keepId ? 'keep' : 'dup' })).join(''))
    ).join('');
  } else if (flat) {
    body = wrapItems(shown.map((it) => itemRenderer(it, { showCat })).join(''));
  } else {
    const groups = groupByCode(shown, S.scheme);
    body = groups.map((g) => {
      const bad = g.rows.filter((it) => PROBLEM.has((S.health[it.id] || {}).status)).length;
      return `<div class="group-head">
        <span class="group-num">${esc(g.code)}</span>
        <span class="group-name">${esc(g.name)}</span>
        <span class="group-count">${g.rows.length} 条</span>
        <span class="group-rule"></span>
        ${bad ? `<span class="group-bad">${bad} 条失效</span>` : ''}
      </div>` + wrapItems(g.rows.map((it) => itemRenderer(it, { showCat: false })).join(''));
    }).join('');
  }

  const allChecked = shown.length > 0 && shown.every((it) => S.sel.has(it.id));
  if (colHost) {
    colHost.innerHTML = isCards
      ? ''
      : `<div class="col-head">
          <span><span class="cb${allChecked ? ' cb-on' : ''}" id="cbAll" role="checkbox" tabindex="0" aria-checked="${allChecked}">${allChecked ? icon('check', 10, 2.2) : ''}</span></span>
          <span></span><span>书签</span><span class="col-c1">建议</span><span class="col-c2">状态</span><span class="col-c3">添加</span>
        </div>`;
  }

  const tail = rows.length > shown.length
    ? `<div class="load-more-bar">
        <button class="btn btn-line btn-md" id="btnLoadMore">${icon('plus', 13)}<span>加载下 200 条（已显示 ${shown.length}/${rows.length}）</span></button>
        <button class="btn btn-ghost btn-sm" id="btnLoadAll">加载全部</button>
      </div>`
    : '<div class="list-tail"></div>';

  list.innerHTML = body + tail;

  $('#btnLoadMore')?.addEventListener('click', () => { S.renderLimit += 200; renderList(); });
  $('#btnLoadAll')?.addEventListener('click', () => { S.renderLimit = rows.length; renderList(); });

  const cbAll = $('#cbAll');
  if (cbAll) {
    const toggleAll = () => {
      const nowAll = shown.length > 0 && shown.every((it) => S.sel.has(it.id));
      if (nowAll) shown.forEach((it) => S.sel.delete(it.id));
      else shown.forEach((it) => S.sel.add(it.id));
      syncSelectionInPlace();
    };
    cbAll.addEventListener('click', toggleAll);
    cbAll.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleAll(); }
    });
  }

  wireFavicons(list);

  list.querySelectorAll('[data-check]').forEach((el) => {
    const handleCheck = (e) => {
      e.stopPropagation();
      const id = el.dataset.check;
      const curIdx = shown.findIndex((x) => x.id === id);

      if (e.shiftKey && S.lastCheckedId != null) {
        const lastIdx = shown.findIndex((x) => x.id === S.lastCheckedId);
        if (lastIdx !== -1 && curIdx !== -1) {
          const from = Math.min(lastIdx, curIdx);
          const to = Math.max(lastIdx, curIdx);
          for (let i = from; i <= to; i++) S.sel.add(shown[i].id);
          syncSelectionInPlace();
          return;
        }
      }

      S.lastCheckedId = id;
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      syncSelectionInPlace();
    };

    el.addEventListener('click', handleCheck);
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handleCheck(e); }
    });
  });

  list.querySelectorAll('[data-quick-open]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const it = S.items.find((x) => x.id === btn.dataset.quickOpen);
      if (it) chrome.tabs.create({ url: it.url });
    });
  });

  list.querySelectorAll('[data-quick-move]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const it = S.items.find((x) => x.id === btn.dataset.quickMove);
      if (!it) return;
      pickFolder(it.title, '移动到这个分类', async (code) => {
        await moveWithUndo([it.id], code, true);
      });
    });
  });

  list.querySelectorAll('[data-quick-check]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await send('health:run', { ids: [btn.dataset.quickCheck] }).catch((err) => toast(err.message));
    });
  });

  list.querySelectorAll('[data-quick-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteWithUndo([btn.dataset.quickDel]);
    });
  });

  list.querySelectorAll('[data-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('input, button, [data-check]')) return;
      S.selected = el.dataset.id;
      S.drawer = 'detail';
      S.editing = null;
      syncSelectionInPlace();
      renderInspector();
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('input, button, [data-check]')) return;
      const it = S.items.find((x) => x.id === el.dataset.id);
      if (it) chrome.tabs.create({ url: it.url });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e, el.dataset.id);
    });
    el.addEventListener('dragstart', (e) => {
      const id = el.dataset.id;
      S.dragIds = S.sel.has(id) ? [...S.sel] : [id];
      el.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', S.dragIds.join(','));
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('is-dragging');
      S.dragIds = [];
      $('#rail')?.querySelectorAll('.is-drop-over').forEach((n) => n.classList.remove('is-drop-over'));
    });
  });

  renderSelBar();
}

/* ── 公共增删改辅助 + 原地行内重命名 ───────────── */

async function moveWithUndo(ids, code, learn = false) {
  const snapshots = ids.map((id) => ({
    type: 'move',
    id,
    oldParentId: S.items.find((x) => x.id === id)?.parentId || '1',
  }));
  const r = await send('bookmarks:moveCode', { ids, code, learn }).catch((err) => ({ error: err.message }));
  if (r.error) return toast(r.error);
  rememberRecentCode(code);
  S.sel.clear();
  await load();
  toast(`已移到 ${code} ${folderName(code)}${ids.length > 1 ? `（${r.moved} 条）` : ''}`, {
    actionText: '撤销',
    onAction: async () => {
      await send('bookmarks:restore', { items: snapshots });
      await load();
      toast('已撤销移动');
    },
  });
}

async function deleteWithUndo(ids) {
  const snapshots = ids.map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
  if (!snapshots.length) return;
  const r = await send('bookmarks:remove', { ids }).catch((err) => ({ error: err.message }));
  if (r.error) return toast(r.error);
  if (ids.includes(S.selected)) { S.selected = null; S.drawer = null; S.editing = null; }
  S.sel.clear();
  await load();
  toast(snapshots.length === 1 ? `已删除「${snapshots[0].title}」` : `已删除 ${r.removed} 条书签`, {
    actionText: '撤销',
    onAction: async () => {
      await send('bookmarks:restore', { items: snapshots.map((it) => ({ type: 'delete', ...it })) });
      await load();
      toast('已撤销删除');
    },
  });
}

function startInlineRename(id) {
  const it = S.items.find((x) => x.id === id);
  const host = $(`[data-title-host="${id}"]`);
  if (!it || !host) return;
  const oldTitle = it.title;
  host.innerHTML = `<input class="inline-edit-input" value="${esc(oldTitle)}" spellcheck="false" />`;
  const input = host.querySelector('input');
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    if (!save || !next || next === oldTitle) {
      renderList();
      return;
    }
    try {
      await send('bookmarks:update', { id: it.id, title: next });
      await load();
      toast('已重命名', {
        actionText: '撤销',
        onAction: async () => {
          await send('bookmarks:update', { id: it.id, title: oldTitle });
          await load();
          toast('已撤销重命名');
        },
      });
    } catch (e) {
      toast(e.message);
      renderList();
    }
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ── 自定义磨砂右键菜单 ────────────────────────── */

function closeContextMenu() {
  const m = $('#ctxMenu');
  if (m) m.hidden = true;
}

function openContextMenu(e, id) {
  const menu = $('#ctxMenu');
  const it = S.items.find((x) => x.id === id);
  if (!menu || !it) return;

  S.selected = id;
  syncSelectionInPlace();

  const targetIds = S.sel.has(id) && S.sel.size > 1 ? [...S.sel] : [id];
  const multi = targetIds.length > 1;
  const m = S.meta[id] || {};
  const recentMoves = S.recentCodes
    .map((c) => S.scheme.find((f) => f.code === c))
    .filter(Boolean)
    .slice(0, 3);

  menu.innerHTML = `
    ${multi ? `<div class="ctx-label">已选 ${targetIds.length} 条书签</div>` : ''}
    ${!multi ? `
      <button type="button" class="ctx-item" data-ctx="open">${icon('external', 13)}<span>在新标签打开</span><kbd>↵</kbd></button>
      <button type="button" class="ctx-item" data-ctx="open-bg">${icon('window', 13)}<span>后台静默打开</span><kbd>O</kbd></button>
      <button type="button" class="ctx-item" data-ctx="copy-url">${icon('link', 13)}<span>复制网址</span><kbd>C</kbd></button>
      <button type="button" class="ctx-item" data-ctx="copy-md">${icon('copy', 13)}<span>复制 Markdown 链接</span></button>
      <button type="button" class="ctx-item" data-ctx="rename">${icon('pencil', 13)}<span>原地重命名</span><kbd>E</kbd></button>
      <div class="ctx-sep"></div>
    ` : ''}
    ${recentMoves.length ? `
      <div class="ctx-label">快速移入</div>
      ${recentMoves.map((f) => `<button type="button" class="ctx-item" data-ctx-move="${esc(f.code)}">${icon('folder', 13)}<span>${esc(f.code)} ${esc(f.name)}</span></button>`).join('')}
    ` : ''}
    <button type="button" class="ctx-item" data-ctx="move">${icon('folder', 13)}<span>移动到其他分类…</span><kbd>M</kbd></button>
    <div class="ctx-sep"></div>
    <button type="button" class="ctx-item" data-ctx="star">${icon('star', 13)}<span>${!multi && m.star ? '取消星标' : '加入星标精选'}</span><kbd>S</kbd></button>
    <button type="button" class="ctx-item" data-ctx="unread">${icon('bookmark', 13)}<span>${!multi && m.readState === 'unread' ? '标为已读' : '加入稍后阅读'}</span><kbd>U</kbd></button>
    <button type="button" class="ctx-item" data-ctx="check">${icon('pulse', 13)}<span>${multi ? '批量检测状态' : '单条重测健康'}</span><kbd>R</kbd></button>
    <div class="ctx-sep"></div>
    <button type="button" class="ctx-item is-danger" data-ctx="del">${icon('trash', 13)}<span>${multi ? `删除这 ${targetIds.length} 条` : '删除书签'}</span><kbd>⌫</kbd></button>
  `;

  menu.hidden = false;
  const mw = menu.offsetWidth || 220;
  const mh = menu.offsetHeight || 300;
  const x = Math.min(e.clientX, window.innerWidth - mw - 10);
  const y = Math.min(e.clientY, window.innerHeight - mh - 10);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';

  menu.querySelectorAll('[data-ctx-move]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeContextMenu();
      moveWithUndo(targetIds, btn.dataset.ctxMove, targetIds.length === 1);
    });
  });

  menu.querySelectorAll('[data-ctx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.ctx;
      closeContextMenu();
      if (act === 'open') chrome.tabs.create({ url: it.url });
      else if (act === 'open-bg') { chrome.tabs.create({ url: it.url, active: false }); toast('已在后台标签打开'); }
      else if (act === 'copy-url') { await navigator.clipboard.writeText(it.url).catch(() => {}); toast('已复制网址'); }
      else if (act === 'copy-md') { await navigator.clipboard.writeText(`[${it.title}](${it.url})`).catch(() => {}); toast('已复制 Markdown 链接'); }
      else if (act === 'rename') startInlineRename(it.id);
      else if (act === 'move') pickFolder(multi ? `${targetIds.length} 条书签` : it.title, '移动到分类', (code) => moveWithUndo(targetIds, code, targetIds.length === 1));
      else if (act === 'star') {
        const next = multi ? true : !m.star;
        for (const tid of targetIds) await send('meta:set', { id: tid, patch: { star: next } });
        await load();
        toast(next ? '已加星标' : '已取消星标');
      } else if (act === 'unread') {
        const next = multi ? 'unread' : (m.readState === 'unread' ? 'read' : 'unread');
        for (const tid of targetIds) await send('meta:set', { id: tid, patch: { readState: next } });
        await load();
        toast(next === 'unread' ? '已加入稍后阅读' : '已标为已读');
      } else if (act === 'check') {
        await send('health:run', { ids: targetIds }).catch((err) => toast(err.message));
      } else if (act === 'del') {
        await deleteWithUndo(targetIds);
      }
    });
  });
}

/* ── 悬浮多选条 ───────────────────────────────── */

function renderSelBar() {
  const existing = $('.selbar');
  if (existing) existing.remove();
  if (!S.sel.size) return;

  const rows = visible();
  const bar = document.createElement('div');
  bar.className = 'selbar';
  bar.innerHTML = `
    <span class="selbar-count">已选 <b class="tnum">${S.sel.size}</b> 条</span>
    ${rows.length > S.sel.size ? `<button class="btn btn-ghost btn-sm" id="btnSelAllTotal">全选 ${rows.length} 条</button>` : ''}
    <button class="btn btn-ghost btn-sm" id="btnInvertSel" title="反向勾选当前视图条目">反选</button>
    <span class="v-rule"></span>
    <button class="btn btn-ghost btn-sm" data-act="move">${icon('folder', 13)}<span>移动</span></button>
    <button class="btn btn-ghost btn-sm" data-act="tag">${icon('tag', 13)}<span>标签</span></button>
    <button class="btn btn-ghost btn-sm" data-act="ai">${icon('sparkle', 13)}<span>归类</span></button>
    <button class="btn btn-ghost btn-sm" data-act="check">${icon('pulse', 13)}<span>检测</span></button>
    <button class="btn btn-ghost btn-sm" data-act="share">${icon('copy', 13)}<span>书单</span></button>
    <span class="v-rule"></span>
    <button class="btn btn-ghost btn-sm" data-act="del">${icon('trash', 13)}<span>删除</span></button>
    <button class="selbar-x" data-act="none" title="取消选择">${icon('x', 12)}</button>`;
  $('.list-pane').appendChild(bar);

  bar.querySelector('#btnSelAllTotal')?.addEventListener('click', () => {
    rows.forEach((r) => S.sel.add(r.id));
    syncSelectionInPlace();
  });

  bar.querySelector('#btnInvertSel')?.addEventListener('click', () => {
    rows.forEach((r) => {
      if (S.sel.has(r.id)) S.sel.delete(r.id);
      else S.sel.add(r.id);
    });
    syncSelectionInPlace();
  });

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const ids = [...S.sel];
    if (act === 'none') { S.sel.clear(); syncSelectionInPlace(); return; }
    if (act === 'move') {
      pickFolder(ids.length + ' 条书签', '移动到这个分类', (code) => moveWithUndo(ids, code, false));
      return;
    }
    if (act === 'tag') {
      const tag = window.prompt(`为选中的 ${ids.length} 条书签添加标签（不需要带 #）：`, '');
      if (!tag || !tag.trim()) return;
      const r = await send('meta:batchTag', { ids, tag: tag.trim() }).catch((err) => ({ error: err.message }));
      if (r.error) return toast(r.error);
      await load();
      toast(`已为 ${r.count} 条打上 #${r.tag}`);
      return;
    }
    if (act === 'share') {
      const chosen = ids.map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
      const md = toSelectionMarkdown(chosen, S.scheme, { meta: S.meta });
      try {
        await navigator.clipboard.writeText(md);
        toast(`已复制 ${chosen.length} 条精选书单到剪贴板`);
      } catch {
        downloadFile('guizang-reading-list.md', md, 'text/markdown;charset=utf-8');
        toast(`已下载 ${chosen.length} 条精选书单`);
      }
      return;
    }
    if (act === 'check') {
      const limit = S.settings.checkLimit || 60;
      const batch = ids.slice(0, limit);
      await send('health:run', { ids: batch }).catch((err) => toast(err.message));
      if (ids.length > batch.length) {
        toast(`已选 ${ids.length} 条，这次测前 ${batch.length} 条；单次上限可在设置里调`);
      }
      return;
    }
    if (act === 'ai') {
      S.drawer = 'ai';
      runAi(ids);
      return;
    }
    if (act === 'del') {
      await deleteWithUndo(ids);
    }
  });
}

/* ── 检测 ─────────────────────────────────────── */

async function scanView() {
  const rows = visible();
  if (!rows.length) return toast('当前视图没有可检测的书签');
  const limit = S.settings.checkLimit || 60;
  const fresh = rows.filter((it) => !S.health[it.id]).map((it) => it.id);
  const pool = fresh.length ? fresh : rows.map((it) => it.id);
  const batch = pool.slice(0, limit);
  await send('health:run', { ids: batch }).catch((err) => toast(err.message));
  const rest = pool.length - batch.length;
  if (rest > 0) toast(`本批 ${batch.length} 条，还有 ${rest} 条没测，再点一次接着跑`);
  else if (!fresh.length) toast(`这个视图都测过了，这次复检 ${batch.length} 条`);
}

async function stopScan() {
  await send('health:stop');
  toast('已停止检测');
}

function renderScan() {
  const host = $('#scanHost');
  if (!S.scan.running) { host.innerHTML = ''; return; }
  const pct = S.scan.total ? Math.round((S.scan.done / S.scan.total) * 100) : 0;
  host.innerHTML = `<div class="scan">
    <div class="scan-line">
      <span class="scan-pulse"></span>
      <span class="scan-text">正在检测 <b class="tnum">${S.scan.done}</b> / <span class="tnum">${S.scan.total}</span></span>
      <span class="scan-eta tnum">并发 ${esc(String(S.settings.concurrency || 4))}</span>
      <button class="scan-stop" id="scanStop">停止</button>
    </div>
    <div class="scan-track"><div class="scan-fill" style="width:${pct}%"></div></div>
  </div>`;
  $('#scanStop').addEventListener('click', stopScan);
  const btn = $('#btnScan');
  if (btn) btn.querySelector('span').textContent = `检测中 ${S.scan.done}/${S.scan.total}`;
}

/* ── 检查器 ───────────────────────────────────── */

function renderInspector() {
  const box = $('#inspector');
  const resizer = $('#inspResizer');
  if (!S.drawer) {
    box.hidden = true;
    box.innerHTML = '';
    if (resizer) resizer.hidden = true;
    syncMobileOverlay();
    return;
  }
  box.hidden = false;
  if (resizer) resizer.hidden = false;

  if (S.drawer === 'ai') {
    box.innerHTML = aiPanel();
    wireAi();
    syncMobileOverlay();
    return;
  }
  if (S.drawer === 'organize') {
    box.innerHTML = organizePanel();
    wireOrganize();
    syncMobileOverlay();
    return;
  }
  const it = S.items.find((x) => x.id === S.selected);
  if (!it) {
    box.hidden = true;
    if (resizer) resizer.hidden = true;
    S.drawer = null;
    syncMobileOverlay();
    return;
  }
  box.innerHTML = detailPanel(it);
  wireDetail(it);
  syncMobileOverlay();
}

async function undoJournal(id) {
  const r = await send('organize:undo', { journalId: id }).catch((err) => ({ error: err.message }));
  if (r.error) return toast(r.error);
  toast(`已撤销 ${r.restored} 条`);
  await load();
}

function openOrganize(tab = 'plan') {
  S.drawer = 'organize';
  S.orgTab = tab;
  S.selected = null;
  renderInspector();
  renderRail();
}

function journalHistoryHtml() {
  const list = S.journals || [];
  if (!list.length) return '';
  return `<div class="journal-list">
    <div class="journal-head">最近整理与归类日志（可撤销）</div>
    ${list.map((j) => `<div class="journal-item">
      <div class="journal-item-meta">
        <span>移动 <b>${j.applied || j.count || 0}</b> 条${j.scope === 'all' ? '（全库）' : j.scope === 'ai' ? '（AI 建议）' : '（待归类）'}</span>
        <span class="journal-item-when">${relTime(j.at)}</span>
      </div>
      ${j.undoneAt
        ? '<span class="journal-done">已撤销</span>'
        : `<button type="button" class="btn btn-line btn-sm" data-undo-id="${esc(j.id)}">撤销</button>`}
    </div>`).join('')}
  </div>`;
}

function organizePanel() {
  const plan = S.plan;
  const busy = S.planBusy;
  const isClean = S.orgTab === 'clean';

  const head = `<div class="insp-head">
      <div class="insp-head-bar">
        <div class="insp-kicker">${icon(isClean ? 'wand' : 'folder', 12)} ${isClean ? '标题洗白' : '整理计划'}</div>
        <div class="insp-head-tools">
          <button class="ibtn" data-close title="收起">${icon('x', 13)}</button>
        </div>
      </div>
      <h2 class="insp-title">${isClean
        ? (S.cleanBusy ? '正在扫描噪声标题' : S.cleanList ? `${S.cleanList.length} 条可洗白` : '标题规范化')
        : (S.applyBusy ? '正在整理' : busy ? '正在生成' : plan ? plan.ops.length + ' 条待整理' : '还没有计划')
      }</h2>
      <div class="seg-tabs insp-seg">
        <button type="button" class="seg-tab${!isClean ? ' is-active' : ''}" data-org-tab="plan">归位整理</button>
        <button type="button" class="seg-tab${isClean ? ' is-active' : ''}" data-org-tab="clean">标题洗白</button>
      </div>
    </div>`;

  if (isClean) {
    if (S.cleanBusy) {
      return head + `<div class="insp-body"><div class="plan-busy">
        <div class="plan-busy-line">正在识别未读角标、裸网址与冗余后缀…</div>
        <div class="scan-track"><div class="scan-fill" style="width:45%"></div></div>
      </div></div>`;
    }
    const list = S.cleanList;
    if (!list) {
      return head + `<div class="insp-body"><div class="plan-empty">
        <div class="plan-empty-line">把杂乱标题洗成干净可读的书目名</div>
        <div class="plan-empty-hint">自动剔除 <code>(3)</code> 未读角标、裸域名后缀或乱码标题；配了模型时还可结合页面摘要精修，逐条确认后才改。</div>
        <button type="button" class="btn btn-primary btn-md" data-run-clean>${icon('wand', 13)}<span>扫描当前视图噪声标题</span></button>
      </div></div>`;
    }
    if (!list.length) {
      return head + `<div class="insp-body"><div class="plan-empty">
        <div class="plan-empty-line">当前视图标题都很干净</div>
        <div class="plan-empty-hint">未发现需要清洗的未读角标或冗余后缀。</div>
        <button type="button" class="btn btn-line btn-sm" data-run-clean>重新扫描</button>
      </div></div>`;
    }
    return head + `<div class="insp-body">
      ${list.map((c) => `<div class="clean-row">
        <div class="clean-old">${esc(c.from)}</div>
        <div class="clean-new">${esc(c.to)}</div>
        <div class="clean-acts">
          <button type="button" class="btn btn-primary btn-sm" data-apply-clean="${esc(c.id)}">应用</button>
          <button type="button" class="btn btn-ghost btn-sm" data-drop-clean="${esc(c.id)}">忽略</button>
        </div>
      </div>`).join('')}
    </div>
    <div class="insp-foot plan-foot">
      <div class="plan-foot-actions">
        <button type="button" class="btn btn-primary btn-sm" data-apply-clean-all>应用全部 ${list.length} 条</button>
        <button type="button" class="btn btn-ghost btn-sm" data-run-clean>重扫</button>
      </div>
    </div>`;
  }

  if (S.applyBusy) {
    const ap = S.applyProgress || { done: 0, total: 0 };
    const pct = ap.total ? Math.round((ap.done / ap.total) * 100) : 6;
    return head + `<div class="insp-body">
      <div class="plan-busy">
        <div class="plan-busy-line">正在移动 ${ap.done}/${ap.total || '…'}</div>
        <div class="scan-track"><div class="scan-fill" style="width:${pct}%"></div></div>
        <button class="btn btn-line btn-sm" data-stop style="margin-top:12px">停止</button>
      </div>
    </div>`;
  }

  if (busy) {
    const pr = S.planProgress || { stage: 'preselect', done: 0, total: 0 };
    const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 6;
    return head + `<div class="insp-body">
      <div class="plan-busy">
        <div class="plan-busy-line">${pr.stage === 'model' ? '模型正在判断' : '正在预筛'} ${pr.done}/${pr.total || '…'}</div>
        <div class="scan-track"><div class="scan-fill" style="width:${pct}%"></div></div>
      </div>
    </div>`;
  }

  if (!plan) {
    const ready = S.scheme.length > 0;
    return head + `<div class="insp-body">
      <div class="plan-empty">
        <div class="plan-empty-line">当前方案：${ready ? `${S.scheme.length} 个类目` : '还没有可用的分类目录'}</div>
        <div class="seg-tabs">
          <button type="button" class="seg-tab${S.orgScope === 'inbox' ? ' is-active' : ''}" data-org-scope="inbox">仅待归类</button>
          <button type="button" class="seg-tab${S.orgScope === 'all' ? ' is-active' : ''}" data-org-scope="all">全库巡检错放</button>
          <button type="button" class="seg-tab${S.orgScope === 'scheme' ? ' is-active' : ''}" data-org-scope="scheme">按方案建档</button>
        </div>
        <div class="plan-empty-hint">${ready
          ? (S.orgScope === 'all'
              ? '全库巡检：优先挑「还不在本方案类目里」的书签（每次最多 200 条），归位后它们就离开候选池，再点一次自动接着下一批；方案内错放也会一并列出。确认无误且自动备份后才动手。'
              : S.orgScope === 'scheme'
                ? '按方案建档：用当前方案定义的完整类目来判断（不只书签栏里已经建好的那几个），每批最多 200 条。计划里出现、但还没有对应文件夹的类目，会在执行时按方案自动创建，然后把这些书签搬进去——目录由你的收藏决定，不再是一套默认空目录。'
                : '按类目列出「待归类书签该挪去哪」，逐条可剔除或改判；确认无误且自动备份后才执行。')
          : '先到设置页装一套方案（杜威、中图法或自定义方案），再回来生成计划。'}</div>
        <button class="btn btn-primary btn-md" data-gen ${ready ? '' : 'disabled'}>生成整理计划</button>
        ${journalHistoryHtml()}
      </div>
    </div>`;
  }

  const groups = groupOps(plan).map((g) => `
    <div class="plan-group">
      <div class="plan-group-head">
        <span class="plan-group-code">${esc(g.code)}</span>
        <span class="plan-group-name">${esc(g.name)}</span>
        <span class="plan-group-n">${g.ops.length}</span>
      </div>
      ${g.ops.map((op) => planRow(op, plan)).join('')}
    </div>`).join('');

  const s = plan.stats;
  return head + `
    <div class="insp-body">
      <div class="plan-stats">
        <span>范围 <b>${plan.scope === 'scheme' ? '按方案建档' : plan.scope === 'all' ? '全库' : '待归类'}</b></span>
        ${(plan.scope === 'all' || plan.scope === 'scheme') && plan.outside ? `<span>方案外 <b>${plan.outside}</b></span>` : ''}
        ${plan.created && plan.created.length ? `<span>新建目录 <b>${plan.created.length}</b></span>` : ''}
        <span>可移 <b>${s.ready}</b></span>
        <span>拿不准 <b>${s.unsure}</b></span>
        <span>跳过 <b>${s.skip}</b></span>
        ${s.blocked ? `<span class="tone-dead">动不了 <b>${s.blocked}</b></span>` : ''}
      </div>
      ${groups || '<div class="plan-empty"><div class="plan-empty-hint">计划是空的：没有需要移动的书签。</div></div>'}
    </div>
    <div class="insp-foot plan-foot">
      <div class="plan-foot-line">生成于 ${relTime(plan.at)}${plan.overflow ? ` · 还有 ${plan.overflow} 条没纳入` : ''
      }${plan.scope === 'all' && plan.outside
        ? `<br>方案外共 ${plan.outside} 条，本轮计划列入 ${plan.ops.length} 条；执行完再点「重新生成」接着下一批，这个数字会越来越小直到清空`
        : ''}</div>
      <div class="plan-foot-actions">
        <button class="btn btn-primary btn-sm" data-apply ${s.ready ? '' : 'disabled'}>执行 ${s.ready} 条</button>
        <button class="btn btn-line btn-sm" data-gen>重新生成</button>
        <button class="btn btn-ghost btn-sm" data-clear>清空</button>
      </div>
    </div>`;
}

function planRow(op, plan) {
  const pickList = (plan && plan.scheme && plan.scheme.length) ? plan.scheme : S.scheme;
  const tone = op.status === 'ready' ? '' : op.status === 'unsure' ? ' tone-warn' : op.status === 'blocked' ? ' tone-dead' : ' tone-ink';
  const fromPrefix = op.from && op.from.code ? `${esc(op.from.code)} ` : '';
  const tag = op.status === 'ready' ? `${fromPrefix}→ ${esc(op.to.code)} ${esc(op.to.name)}${op.to.missing ? '（新建目录）' : ''}`
    : op.status === 'unsure' ? '拿不准'
    : op.status === 'blocked' ? '动不了'
    : '跳过';
  const pickable = op.status === 'ready' || op.status === 'unsure';
  return `<div class="plan-row">
    <div class="plan-row-top">
      <div class="plan-title" title="${esc(op.title)}">${esc(op.title)}</div>
      <button class="ibtn plan-drop" data-drop="${esc(op.id)}" title="从计划里剔除" aria-label="从计划里剔除">${icon('x', 11)}</button>
    </div>
    <div class="plan-row-bot">
      <div class="plan-sub">
        <span class="plan-tag${tone}">${tag}</span>
        ${op.reason ? `<span class="plan-why" title="${esc(op.reason)}">${esc(op.reason)}</span>` : ''}
      </div>
      ${pickable ? `<select class="plan-pick" data-pick="${esc(op.id)}" title="改判到哪个类目" aria-label="改判目标类目">
        ${pickList.map((f) => `<option value="${esc(f.code)}"${op.to && op.to.code === f.code ? ' selected' : ''}>${esc(f.code)} ${esc(f.name)}</option>`).join('')}
      </select>` : ''}
    </div>
  </div>`;
}

function wireOrganize() {
  const box = $('#inspector');
  box.querySelector('[data-close]')?.addEventListener('click', () => {
    S.drawer = null;
    renderInspector();
    renderRail();
  });
  box.querySelectorAll('[data-org-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { S.orgTab = btn.dataset.orgTab; renderInspector(); });
  });
  box.querySelectorAll('[data-org-scope]').forEach((btn) => {
    btn.addEventListener('click', () => { S.orgScope = btn.dataset.orgScope; renderInspector(); });
  });
  box.querySelector('[data-run-clean]')?.addEventListener('click', async () => {
    S.cleanBusy = true;
    renderInspector();
    try {
      const ids = visible().slice(0, 40).map((x) => x.id);
      const r = await send('ai:cleanTitles', { ids });
      S.cleanList = r.items || [];
    } catch (e) {
      toast(e.message);
      S.cleanList = [];
    } finally {
      S.cleanBusy = false;
      renderInspector();
    }
  });
  box.querySelectorAll('[data-apply-clean]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.applyClean;
      const item = (S.cleanList || []).find((x) => x.id === id);
      if (!item) return;
      const r = await send('bookmarks:batchRename', { changes: [{ id: item.id, title: item.to }] });
      S.cleanList = S.cleanList.filter((x) => x.id !== id);
      await load();
      toast('已更新标题', {
        actionText: '撤销',
        onAction: async () => {
          await send('bookmarks:restore', { items: r.prev.map((p) => ({ type: 'title', ...p })) });
          await load();
          toast('已撤销标题修改');
        },
      });
    });
  });
  box.querySelectorAll('[data-drop-clean]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.cleanList = (S.cleanList || []).filter((x) => x.id !== btn.dataset.dropClean);
      renderInspector();
    });
  });
  box.querySelector('[data-apply-clean-all]')?.addEventListener('click', async () => {
    const list = S.cleanList || [];
    if (!list.length) return;
    const r = await send('bookmarks:batchRename', { changes: list.map((x) => ({ id: x.id, title: x.to })) });
    S.cleanList = [];
    await load();
    toast(`已洗白 ${r.renamed} 条标题`, {
      actionText: '撤销',
      onAction: async () => {
        await send('bookmarks:restore', { items: r.prev.map((p) => ({ type: 'title', ...p })) });
        await load();
        toast('已撤销批量改名');
      },
    });
  });
  box.querySelector('[data-gen]')?.addEventListener('click', async () => {
    S.planBusy = true;
    S.planProgress = { stage: 'preselect', done: 0, total: 0 };
    renderInspector();
    await send('organize:plan', { scope: S.orgScope }).catch((err) => {
      S.planBusy = false;
      toast(err.message);
      renderInspector();
    });
  });
  box.querySelector('[data-clear]')?.addEventListener('click', async () => {
    await send('organize:cancel');
    S.plan = null;
    renderInspector();
    renderRail();
  });
  box.querySelectorAll('[data-drop]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const plan = await send('organize:drop', { id: btn.dataset.drop }).catch(() => null);
      if (plan) { S.plan = plan; renderInspector(); renderRail(); }
    });
  });
  box.querySelector('[data-apply]')?.addEventListener('click', async () => {
    S.applyBusy = true;
    S.applyProgress = { done: 0, total: (S.plan && S.plan.stats.ready) || 0 };
    renderInspector();
    await send('organize:apply').catch((err) => {
      S.applyBusy = false;
      toast(err.message);
      renderInspector();
    });
  });
  box.querySelector('[data-stop]')?.addEventListener('click', async () => {
    await send('organize:stop').catch(() => {});
    toast('正在停下…');
  });
  box.querySelectorAll('[data-undo-id]').forEach((btn) => {
    btn.addEventListener('click', () => undoJournal(btn.dataset.undoId));
  });
  box.querySelectorAll('[data-pick]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const plan = await send('organize:override', { id: sel.dataset.pick, code: sel.value }).catch(() => null);
      if (plan) { S.plan = plan; renderInspector(); renderRail(); toast('已改判并记住此域名偏好'); }
    });
  });
}

/* ── AI 归类抽屉（带朱砂「已归」落印动效） ────── */

function aiPanel() {
  const pend = Object.entries(S.pending)
    .map(([id, p]) => ({ id, ...p, item: S.items.find((x) => x.id === id) }))
    .filter((x) => x.item)
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  const doneRows = S.done.map((d) => `<div class="sg sg-done"><div class="sg-done-line">
      <span class="sg-done-mark">${icon('check', 11, 2)}</span>
      <span style="flex:1">已归入 <b class="tnum">${esc(d.code)}</b> ${esc(d.name)}</span>
      <span class="seal-stamp">已归</span>
    </div></div>`).join('');

  const busy = S.aiBusy
    ? `<div class="sg"><div class="sg-why">正在生成建议 ${S.aiProgress ? `${S.aiProgress.done}/${S.aiProgress.total}` : '…'}</div>
       <div class="scan-track" style="margin-top:8px">
       <div class="scan-fill" style="width:${S.aiProgress ? Math.round(S.aiProgress.done / S.aiProgress.total * 100) : 8}%"></div></div></div>`
    : '';

  const note = S.pendingNote
    ? `<div class="sg sg-note"><div class="sg-why">有 ${S.pendingNote} 条建议的目标类目已不存在（多半是换了分类方案），已自动清除。</div>
       <button class="btn btn-ghost btn-sm" data-note-ok style="margin-top:6px">知道了</button></div>`
    : '';

  const body = note + busy + doneRows + pend.map((p) => suggestionCard(p)).join('');

  return `<div class="insp-head">
      <div class="insp-head-bar">
        <div class="insp-kicker">${icon('sparkle', 12)} 归类建议</div>
        <div class="insp-head-tools">
          ${pend.length ? `<button class="ibtn" id="btnAiTriage" title="切入逐卷审定大卡模式 (T)">${icon('triage', 13)}</button>` : ''}
          <button class="ibtn" data-close title="收起">${icon('x', 13)}</button>
        </div>
      </div>
      <h2 class="insp-title">${pend.length ? `${pend.length} 条待确认` : (S.aiBusy ? '正在判断' : '没有待确认的建议')}</h2>
      <p class="insp-sub">优先复用你的历史改判偏好，模型结合标题、域名与页面摘要判断；确认之后才会真的移动。</p>
    </div>
    <div class="insp-body">
      ${body || `<div class="empty" style="padding:22px 14px">
        <div class="empty-hint">${S.aiReady
          ? `给当前视图的 ${Math.min(visible().length, 80)} 条生成建议${visible().length > 80 ? `（当前视图共 ${visible().length} 条，一次最多 80 条）` : ''}，先看看它怎么判。`
          : '还没配置模型。可以在设置里填 API Key，或者先用本地关键词规则试跑。'}</div>
      </div>`}
    </div>
    ${pend.length ? `<div class="insp-foot">
      <button class="btn btn-primary btn-md btn-block" data-acceptall>
        ${icon('check', 14)}<span>接受全部 ${pend.length} 条</span></button>
      <div class="insp-progress">${Object.keys(S.pending).length} 条建议在队列</div>
    </div>` : ''}`;
}

function suggestionCard(p) {
  const it = p.item;
  const unsure = p.conf < 0.75;
  const picking = S.picking === p.id;
  return `<div class="sg" data-sg="${esc(p.id)}">
    <div class="sg-top">
      <button class="sg-title" data-locate="${esc(p.id)}">${esc(it.title)}</button>
      <span class="sg-conf${unsure ? ' is-unsure' : ''}" title="${unsure ? '对这个判断不太确定' : '置信度'}">
        <span class="sg-conf-bar"><span style="width:${Math.round(p.conf * 100)}%"></span></span>
        ${p.conf.toFixed(2)}
      </span>
    </div>
    <div class="sg-move">
      <span class="chip chip-from tnum">${esc(it.code || '待归类')}</span>
      ${icon('arrowRight', 12)}
      <span class="chip chip-to"><b>${esc(p.code)}</b>${esc(folderName(p.code))}</span>
      ${unsure ? '<span class="sg-unsure-tag">拿不准</span>' : ''}
      ${p.source === 'heuristic' ? '<span class="sg-unsure-tag">本地规则</span>' : ''}
      ${p.source === 'learned' ? '<span class="sg-unsure-tag" style="color:var(--ok);background:var(--ok-wash)">历史偏好</span>' : ''}
    </div>
    <p class="sg-why">${esc(p.reason || '模型没有给出理由')}</p>
    ${picking ? `<div class="sg-picker">${S.scheme.map((f) => `
        <button class="sg-pick${f.code === p.code ? ' is-on' : ''}" data-override="${esc(p.id)}" data-code="${esc(f.code)}">
          <span class="sg-pick-num">${esc(f.code)}</span>${esc(f.name)}</button>`).join('')}</div>`
      : `<div class="sg-actions">
        <button class="btn btn-primary btn-sm" data-accept="${esc(p.id)}">${icon('check', 12)}<span>接受</span></button>
        <button class="btn btn-line btn-sm" data-pick="${esc(p.id)}">改判</button>
        <button class="btn btn-ghost btn-sm" data-ignore="${esc(p.id)}">忽略</button>
      </div>`}
  </div>`;
}

function wireAi() {
  const box = $('#inspector');
  box.querySelector('[data-close]')?.addEventListener('click', () => {
    S.drawer = null; S.picking = null; renderInspector(); renderTop();
  });
  box.querySelector('[data-note-ok]')?.addEventListener('click', () => {
    S.pendingNote = 0;
    renderInspector();
  });

  box.querySelector('#btnAiTriage')?.addEventListener('click', () => {
    const items = Object.keys(S.pending).map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
    triage.open(items);
  });

  const acceptAll = box.querySelector('[data-acceptall]');
  if (acceptAll && !acceptAll.disabled) {
    acceptAll.addEventListener('click', async () => {
      const ids = Object.keys(S.pending).filter((id) => S.items.some((x) => x.id === id));
      await acceptIds(ids);
    });
  }

  if (!S.pending || !Object.keys(S.pending).length) {
    const empty = box.querySelector('.insp-body .empty-hint');
    if (empty && !S.aiBusy) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-md';
      btn.style.marginTop = '12px';
      btn.innerHTML = `${icon('sparkle', 14)}<span>为当前视图生成建议</span>`;
      btn.addEventListener('click', () => runAi(visible().map((x) => x.id)));
      empty.after(btn);
    }
  }

  box.querySelectorAll('[data-locate]').forEach((el) => {
    el.addEventListener('click', () => {
      $(`[data-id="${el.dataset.locate}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });
  box.querySelectorAll('[data-accept]').forEach((el) => {
    el.addEventListener('click', () => acceptIds([el.dataset.accept]));
  });
  box.querySelectorAll('[data-ignore]').forEach((el) => {
    el.addEventListener('click', () => ignoreIds([el.dataset.ignore]));
  });
  box.querySelectorAll('[data-pick]').forEach((el) => {
    el.addEventListener('click', () => { S.picking = el.dataset.pick; renderInspector(); });
  });
  box.querySelectorAll('[data-override]').forEach((el) => {
    el.addEventListener('click', () => overrideSuggestion(el.dataset.override, el.dataset.code));
  });
}

async function acceptIds(ids) {
  if (!ids.length) return;
  const snapshot = ids.map((id) => ({
    id,
    code: S.pending[id] ? S.pending[id].code : '',
    title: (S.items.find((x) => x.id === id) || {}).title || '',
  }));
  const r = await send('ai:accept', { ids }).catch((err) => ({ error: err.message }));
  if (r.error) return toast(r.error);
  const movedIds = new Set(r.movedIds || []);
  snapshot
    .filter((s) => !movedIds.size || movedIds.has(s.id))
    .slice(0, 12)
    .forEach((s) => S.done.unshift({ ...s, name: folderName(s.code) }));
  S.done = S.done.slice(0, 6);
  S.picking = null;
  await load();
  const tip = r.failed
    ? `已归入 ${r.moved} 条，${r.failed} 条没能归入（${(r.missing || []).join('、')} 已不存在）`
    : `已归入 ${r.moved} 条`;
  toast(tip, r.journalId ? {
    actionText: '撤销',
    onAction: () => undoJournal(r.journalId),
  } : undefined);
}

async function ignoreIds(ids) {
  await send('ai:ignore', { ids }).catch((err) => toast(err.message));
  S.picking = null;
  await load();
}

async function overrideSuggestion(id, code) {
  await send('ai:ignore', { ids: [id] }).catch(() => {});
  const r = await send('bookmarks:moveCode', { ids: [id], code, learn: true }).catch((err) => ({ error: err.message }));
  if (r.error) return toast(r.error);
  rememberRecentCode(code);
  S.done.unshift({ code, name: folderName(code), title: '' });
  S.done = S.done.slice(0, 6);
  S.picking = null;
  await load();
  toast(`已归入 ${code} ${folderName(code)}（已记住此域名偏好）`);
}

async function runAi(ids) {
  if (S.aiBusy) return;
  const scope = ids.slice(0, 80);
  if (!scope.length) return toast('当前视图没有可归类的书签');
  S.aiBusy = true;
  S.aiProgress = { done: 0, total: scope.length };
  renderInspector();
  try {
    const r = await send('ai:run', { ids: scope });
    await load();
    const failed = (r && r.failed) || [];
    if (failed.length) {
      // 部分批次没走通：已经生成的建议照常留下，别让用户以为全废了
      toast(`已生成 ${((r && r.suggestions) || []).length} 条建议；${failed.length} 批没走通：${failed[0].error}`);
    } else {
      toast(`${S.aiReady ? '模型' : '本地规则'}给出了 ${Object.keys(S.pending).length} 条建议`);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    S.aiBusy = false;
    S.aiProgress = null;
    renderInspector();
  }
}

function toggleAi() {
  S.drawer = S.drawer === 'ai' ? null : 'ai';
  renderInspector();
  renderTop();
}

/* ── 详情抽屉 ─────────────────────────────────── */

function breakableUrl(url) {
  return String(url)
    .split(/([\/?#&=_-])/)
    .map((seg, i) => (i % 2 ? esc(seg) + '<wbr>' : esc(seg)))
    .join('');
}

function waybackHtml(it, h) {
  if (!h || !PROBLEM.has(h.status)) return '';
  const wb = S.wayback[it.id];
  if (!wb) {
    return `<div class="wayback-box">
      <div class="wayback-row">
        <button type="button" class="btn btn-line btn-sm" id="btnWayback">${icon('archive', 12)}<span>查 Wayback 时光机存档</span></button>
      </div>
    </div>`;
  }
  if (wb.loading) {
    return `<div class="wayback-box"><div class="wayback-msg">正在向 Internet Archive 查询历史快照…</div></div>`;
  }
  if (wb.available && wb.url) {
    return `<div class="wayback-box">
      <div class="wayback-msg">找到历史快照${wb.dateLabel ? `（${esc(wb.dateLabel)}）` : ''}，可预览或直接替换为存档地址：</div>
      <div class="wayback-row">
        <button type="button" class="btn btn-primary btn-sm" id="btnApplyWayback">${icon('check', 11)}<span>替换为存档链接</span></button>
        <button type="button" class="btn btn-line btn-sm" id="btnOpenWayback">${icon('external', 11)}<span>预览快照</span></button>
      </div>
    </div>`;
  }
  return `<div class="wayback-box">
    <div class="wayback-msg">未查到自动快照，可前往 Wayback 时间轴手动检索。</div>
    <div class="wayback-row">
      <button type="button" class="btn btn-line btn-sm" id="btnBrowseWayback">${icon('external', 11)}<span>打开 Wayback 检索页</span></button>
    </div>
  </div>`;
}

function detailPanel(it) {
  const h = S.health[it.id];
  const m = S.meta[it.id] || {};
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const tone = h ? (TONE[h.status] || TONE.invalid) : null;
  const cls = h ? (PROBLEM.has(h.status) ? ' is-dead' : SUSPECT.has(h.status) ? ' is-warn' : (h.status === 'ok' ? ' is-ok' : '')) : '';
  const isEditing = S.editing && S.editing.id === it.id;

  return `<div class="insp-head">
      <div class="insp-head-bar">
        <div class="insp-kicker">${icon('folder', 12)} 收藏详情</div>
        <div class="insp-head-tools">
          <button class="ibtn${m.star ? ' is-starred' : ''}" id="btnStarItem" title="${m.star ? '取消星标 (S)' : '加星标 (S)'}">${icon('star', 13)}</button>
          <button class="ibtn${m.readState === 'unread' ? ' is-marked' : ''}" id="btnReadItem" title="${m.readState === 'unread' ? '标为已读 (U)' : '加入稍后阅读 (U)'}">${icon('bookmark', 13)}</button>
          <button class="ibtn" id="btnEditItem" title="编辑标题和地址">${icon('pencil', 13)}</button>
          <button class="ibtn" data-close title="收起">${icon('x', 13)}</button>
        </div>
      </div>
      <h2 class="insp-title insp-title-sm">${esc(it.title)}</h2>
      <p class="insp-sub">${esc(it.host)}</p>
    </div>
    <div class="insp-body">
      ${isEditing ? `
        <div class="insp-edit-form">
          <div style="font-size:11px;font-weight:600;margin-bottom:6px">编辑书签</div>
          <label style="font-size:11px;color:var(--ink-3)">标题</label>
          <input class="insp-input" id="editTitleInput" value="${esc(S.editing.title)}" spellcheck="false" />
          <label style="font-size:11px;color:var(--ink-3)">网址 (URL)</label>
          <input class="insp-input" id="editUrlInput" value="${esc(S.editing.url)}" spellcheck="false" />
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" id="btnEditCancel">取消</button>
            <button class="btn btn-primary btn-sm" id="btnEditSave">保存</button>
          </div>
        </div>
      ` : `
        <div class="url-box" title="点击复制网址 (C)">
          <span class="url-box-text">${breakableUrl(it.url)}</span>
          <span class="url-box-icon" title="点击复制">${icon('copy', 13)}</span>
        </div>
      `}
      <div class="status-block${cls}">
        <div class="status-head">
          <span class="status-pill${h ? '' : ' is-idle'}">
            <span class="status-dot"></span>${h ? esc(tone.label) : '未检测'}
          </span>
          ${h ? `<span class="status-code">HTTP ${esc(h.code)}</span>` : ''}
        </div>
        <p class="status-note">${statusNote(h)}</p>
        ${h && h.finalUrl ? `
          <div class="status-redirect-cta">
            <div class="status-redirect-label">
              <div class="status-redirect-cap">重定向新地址</div>
              <div class="status-redirect-url">${breakableUrl(h.finalUrl)}</div>
            </div>
            <button class="btn btn-primary btn-sm" id="btnApplyFinalUrl">${icon('check', 11)}<span>一键更新</span></button>
          </div>
        ` : ''}
        ${waybackHtml(it, h)}
      </div>

      <div class="insp-meta-box">
        <div class="insp-meta-head">
          <span>标签与批注</span>
          <span>${m.readState === 'unread' ? '未读' : m.readState === 'read' ? '已读' : ''}</span>
        </div>
        ${tags.length ? `<div class="tag-list">${tags.map((t) => `
          <span class="tag-pill">#${esc(t)}<button type="button" class="tag-pill-x" data-rm-tag="${esc(t)}" title="移除标签">${icon('x', 9)}</button></span>`).join('')}
        </div>` : ''}
        <div class="tag-add-row">
          <input class="tag-add-input" id="tagAddInput" placeholder="输入标签按回车（如 rust）" spellcheck="false" />
          <button type="button" class="btn btn-line btn-sm" id="btnAddTag">加标签</button>
        </div>
        <textarea class="note-area" id="noteArea" placeholder="记一句摘录或收藏理由（失焦自动保存）">${esc(m.note || '')}</textarea>
      </div>

      <dl class="kv">
        <div class="kv-row"><dt>分类</dt><dd>${it.code ? `<span class="tnum">${esc(it.code)}</span> ${esc(folderName(it.code))}` : '待归类'}</dd></div>
        <div class="kv-row"><dt>添加</dt><dd>${it.added ? new Date(it.added).toLocaleDateString('zh-CN') : '—'} <span style="color:var(--ink-4)">· ${relTime(it.added)}</span></dd></div>
        <div class="kv-row"><dt>检测</dt><dd>${h ? relTime(h.at) + (h.ms ? ` <span style="color:var(--ink-4)">· ${h.ms}ms</span>` : '') : '—'}</dd></div>
      </dl>
      <div class="insp-actions">
        <button class="btn btn-primary btn-md" data-open>${icon('external', 14)}<span>打开</span></button>
        <button class="btn btn-line btn-md" data-move>${icon('folder', 14)}<span>移动</span></button>
        <button class="btn btn-line btn-md" data-check>${icon('pulse', 14)}<span>重测</span></button>
        <button class="btn btn-ghost btn-md" data-del>${icon('trash', 14)}<span>删除</span></button>
      </div>
      ${it.code ? '' : `<button class="insp-cta" data-ai>${icon('sparkle', 13)} 让模型为这一条选个分类</button>`}
    </div>`;
}

function statusNote(h) {
  if (!h) return '还没跑过检测。动手之前先确认一下它是不是还活着。';
  if (h.status === 'ok') return '页面可以正常打开。';
  if (h.status === 'moved') {
    return h.finalUrl
      ? '内容已迁移到新地址。确认落点无误的话，用下面的「一键更新」把书签换过去。'
      : '内容已迁移到新地址，但这次没拿到落点地址——手动打开看一眼更稳。';
  }
  if (h.status === 'dead') return `服务器返回 ${h.code}，这个地址已经没有内容了。`;
  if (h.status === 'blocked') return `返回 ${h.code}，常见于反爬或需要登录，未必真的失效。`;
  if (h.status === 'error') return `服务器返回 ${h.code}，站点自己出问题了，过段时间再看。`;
  if (h.status === 'timeout') return '连接超时，可能站点很慢或网络被拦。';
  if (h.status === 'unreachable') return '连不上：域名解析失败、拒绝连接或证书有问题。';
  return '这种地址不适合做网络检测。';
}

function wireDetail(it) {
  const box = $('#inspector');
  const m = S.meta[it.id] || {};

  box.querySelector('[data-close]')?.addEventListener('click', () => {
    S.drawer = null; S.editing = null; renderInspector();
  });

  box.querySelector('#btnStarItem')?.addEventListener('click', async () => {
    const nextStar = !m.star;
    const r = await send('meta:set', { id: it.id, patch: { star: nextStar } });
    if (r.entry) S.meta[it.id] = r.entry; else delete S.meta[it.id];
    renderRail();
    renderList();
    renderInspector();
    toast(nextStar ? '已加入星标精选' : '已取消星标');
  });

  box.querySelector('#btnReadItem')?.addEventListener('click', async () => {
    const nextState = m.readState === 'unread' ? 'read' : 'unread';
    const r = await send('meta:set', { id: it.id, patch: { readState: nextState } });
    if (r.entry) S.meta[it.id] = r.entry; else delete S.meta[it.id];
    renderRail();
    renderList();
    renderInspector();
    toast(nextState === 'unread' ? '已加入稍后阅读' : '已标为已读');
  });

  const addTag = async () => {
    const input = box.querySelector('#tagAddInput');
    const raw = (input && input.value || '').trim();
    if (!raw) return;
    const nextTags = [...(m.tags || []), ...raw.split(/[,，\s#]+/).filter(Boolean)];
    const r = await send('meta:set', { id: it.id, patch: { tags: nextTags } });
    if (r.entry) S.meta[it.id] = r.entry; else delete S.meta[it.id];
    renderRail();
    renderList();
    renderInspector();
  };
  box.querySelector('#btnAddTag')?.addEventListener('click', addTag);
  box.querySelector('#tagAddInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
  });
  box.querySelectorAll('[data-rm-tag]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.rmTag;
      const nextTags = (m.tags || []).filter((t) => t !== target);
      const r = await send('meta:set', { id: it.id, patch: { tags: nextTags } });
      if (r.entry) S.meta[it.id] = r.entry; else delete S.meta[it.id];
      renderRail();
      renderList();
      renderInspector();
    });
  });

  const noteArea = box.querySelector('#noteArea');
  if (noteArea) {
    const saveNote = async () => {
      const val = noteArea.value.trim();
      if (val === (m.note || '')) return;
      const r = await send('meta:set', { id: it.id, patch: { note: val } });
      if (r.entry) S.meta[it.id] = r.entry; else delete S.meta[it.id];
      if (S.viewMode === 'cards') renderList();
      toast('批注已保存');
    };
    noteArea.addEventListener('blur', saveNote);
    noteArea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); noteArea.blur(); }
    });
  }

  box.querySelector('#btnWayback')?.addEventListener('click', async () => {
    S.wayback[it.id] = { loading: true };
    renderInspector();
    try {
      const r = await send('wayback:lookup', { url: it.url });
      S.wayback[it.id] = { loading: false, ...r };
    } catch {
      S.wayback[it.id] = { loading: false, available: false, browseUrl: `https://web.archive.org/web/*/${it.url}` };
    }
    renderInspector();
  });
  box.querySelector('#btnOpenWayback')?.addEventListener('click', () => {
    const wb = S.wayback[it.id];
    if (wb && wb.url) chrome.tabs.create({ url: wb.url });
  });
  box.querySelector('#btnBrowseWayback')?.addEventListener('click', () => {
    const wb = S.wayback[it.id];
    chrome.tabs.create({ url: (wb && wb.browseUrl) || `https://web.archive.org/web/*/${it.url}` });
  });
  box.querySelector('#btnApplyWayback')?.addEventListener('click', async () => {
    const wb = S.wayback[it.id];
    if (!wb || !wb.url) return;
    const oldUrl = it.url;
    await send('bookmarks:update', { id: it.id, url: wb.url });
    await load();
    toast('已替换为 Wayback 时光机存档地址', {
      actionText: '撤销',
      onAction: async () => {
        await send('bookmarks:update', { id: it.id, url: oldUrl });
        await load();
        toast('已还原原地址');
      },
    });
  });

  box.querySelector('#btnEditItem')?.addEventListener('click', () => {
    S.editing = { id: it.id, title: it.title, url: it.url };
    renderInspector();
  });
  box.querySelector('#btnEditCancel')?.addEventListener('click', () => { S.editing = null; renderInspector(); });
  box.querySelector('#btnEditSave')?.addEventListener('click', async () => {
    const newTitle = $('#editTitleInput').value.trim();
    const newUrl = $('#editUrlInput').value.trim();
    if (!newUrl) return toast('网址不能为空');
    const oldTitle = it.title;
    const oldUrl = it.url;
    try {
      await send('bookmarks:update', { id: it.id, title: newTitle, url: newUrl });
      S.editing = null;
      await load();
      toast('已更新书签信息', {
        actionText: '撤销',
        onAction: async () => {
          await send('bookmarks:update', { id: it.id, title: oldTitle, url: oldUrl });
          await load();
          toast('已撤销修改');
        },
      });
    } catch (e) {
      toast(e.message);
    }
  });

  const applyFinalUrl = box.querySelector('#btnApplyFinalUrl');
  if (applyFinalUrl && S.health[it.id]?.finalUrl) {
    applyFinalUrl.addEventListener('click', async () => {
      const finalUrl = S.health[it.id].finalUrl;
      const oldUrl = it.url;
      try {
        await send('bookmarks:update', { id: it.id, url: finalUrl });
        await load();
        await send('health:run', { ids: [it.id] }).catch(() => {});
        toast('地址已更新，正在重测新地址', {
          actionText: '撤销',
          onAction: async () => {
            await send('bookmarks:update', { id: it.id, url: oldUrl });
            await load();
            toast('已撤销更新');
          },
        });
      } catch (e) {
        toast(e.message);
      }
    });
  }

  box.querySelector('.url-box')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(it.url);
      toast('已复制网址到剪贴板');
    } catch (e) {
      toast('复制失败: ' + e.message);
    }
  });

  box.querySelector('[data-open]')?.addEventListener('click', () => chrome.tabs.create({ url: it.url }));
  box.querySelector('[data-move]')?.addEventListener('click', () => {
    pickFolder(it.title, '移动到这个分类', (code) => moveWithUndo([it.id], code, true));
  });
  box.querySelector('[data-check]')?.addEventListener('click', async () => {
    await send('health:run', { ids: [it.id] }).catch((err) => toast(err.message));
  });
  box.querySelector('[data-del]')?.addEventListener('click', () => deleteWithUndo([it.id]));
  box.querySelector('[data-ai]')?.addEventListener('click', () => {
    S.drawer = 'ai'; renderInspector(); runAi([it.id]);
  });
}

/* ── 命令面板 / 导出 / 分类选择 / 快捷键 ──────── */

function buildCommands() {
  const cmds = [
    { id: 'triage', name: '进入「逐卷审定」沉浸清仓模式', desc: '全键盘 0-9 秒速归档待归类与 AI 建议书签 (快捷键 T)', ico: 'triage', run: () => triage.open() },
    { id: 'mode-cards', name: '切换为「藏书卡片墙」视图', desc: '多列藏书票网格，展示批注、标签与站点色带', ico: 'grid', run: () => setViewMode('cards') },
    { id: 'mode-list', name: '切换为「典藏列表」视图', desc: '经典双行高可读索引列表', ico: 'rows', run: () => setViewMode('list') },
    { id: 'mode-compact', name: '切换为「极致紧凑」视图', desc: '34px 单行超高密度，一屏快速扫视 25+ 条', ico: 'compact', run: () => setViewMode('compact') },
    { id: 'org', name: '打开整理计划', desc: '按分类方案批量归位待归类或全库错放巡检', ico: 'folder', run: () => openOrganize('plan') },
    { id: 'clean', name: 'AI 标题洗白', desc: '识别并清理未读角标、裸网址与冗余站点后缀', ico: 'wand', run: () => openOrganize('clean') },
    { id: 'ai', name: '切换 AI 归类抽屉', desc: '查看待确认建议或为当前视图生成建议', ico: 'sparkle', run: toggleAi },
    { id: 'scan', name: '检测当前视图失效链接', desc: '并发轻量请求核验 HTTP 状态码', ico: 'pulse', run: scanView },
    { id: 'dups', name: '查看重复书签', desc: '按规范化地址合并历史重复收藏', ico: 'layers', run: () => { S.view = { kind: 'dups' }; renderAll(); } },
    { id: 'moved', name: '查看已跳转链接', desc: '集中核对 301 / 302 跳转并一键更新', ico: 'redirect', run: () => { S.view = { kind: 'moved' }; renderAll(); } },
    { id: 'serendipity', name: '书海拾遗（随机翻阅 3 卷）', desc: '从老藏卷中随机抽取 3 条完好书签重温', ico: 'compass', run: () => { S.serendipityOpen = true; S.serendipitySeed = Date.now(); renderHead(); } },
    { id: 'usage', name: '常阅与吃灰分析', desc: '结合本地浏览历史发现高频与尘封藏卷', ico: 'history', run: () => { S.view = { kind: 'usage' }; renderAll(); } },
    { id: 'stash', name: '收纳当前窗口全部标签页', desc: '一键收进「待归类」，自动跳过已收藏链接', ico: 'inbox', run: async () => {
      const r = await send('tabs:stashWindow', { closeTabs: false });
      await load();
      toast(r.saved ? `已收进 ${r.saved} 个标签页` : '本窗标签页都已在收藏夹中');
    } },
    { id: 'export-md', name: '导出 Obsidian / Markdown 书目', desc: '按分类分卷导出干净 .md 文件（自动剔除失效链接）', ico: 'download', run: () => {
      const md = toMarkdown(S.items, S.scheme, { health: S.health, meta: S.meta, excludeDead: true });
      downloadFile(`guizang-library-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown;charset=utf-8');
      toast('已导出 Obsidian Markdown 书目');
    } },
    { id: 'export-html', name: '导出标准 HTML 书签文件', desc: '标准 Netscape 格式，可直接导入任意浏览器', ico: 'download', run: () => {
      const html = toNetscapeHtml(S.items, S.scheme);
      downloadFile(`guizang-bookmarks-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html;charset=utf-8');
      toast('已导出标准 HTML 书签');
    } },
    { id: 'shortcuts', name: '查看键盘快捷键速查', desc: '全键盘流导航与操作清单', ico: 'window', run: openShortcutsModal },
    { id: 'options', name: '打开设置页', desc: '配置模型、方案、改判记忆与备份恢复', ico: 'sliders', run: () => chrome.runtime.openOptionsPage() },
  ];
  for (const th of THEMES) {
    cmds.push({
      id: 'theme-' + th.id,
      name: `切换配色：${th.name}`,
      desc: th.desc,
      ico: 'palette',
      run: async (ev) => { await setThemeAnimated(th.id, ev); toast(`已应用配色：${th.name}`); },
    });
  }
  return cmds;
}

function openCommandPalette() {
  const sheet = $('#sheet');
  const all = buildCommands();
  let filter = '';
  let idx = 0;

  const render = () => {
    const q = filter.trim().toLowerCase();
    const list = q ? all.filter((c) => (c.name + ' ' + c.desc).toLowerCase().includes(q)) : all;
    if (idx >= list.length) idx = 0;
    const listEl = sheet.querySelector('#cmdList');
    if (!listEl) return [];
    listEl.innerHTML = list.length
      ? list.map((c, i) => `<button type="button" class="cmd-item${i === idx ? ' is-active' : ''}" data-cmd-idx="${i}">
          ${icon(c.ico, 14)}
          <span class="cmd-item-info">
            <span class="cmd-item-name">${esc(c.name)}</span>
            <div class="cmd-item-desc">${esc(c.desc)}</div>
          </span>
        </button>`).join('')
      : '<div class="cmd-empty">没有匹配的命令</div>';
    listEl.querySelectorAll('[data-cmd-idx]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const hit = list[Number(btn.dataset.cmdIdx)];
        $('#modal').hidden = true;
        if (hit) hit.run(ev);
      });
    });
    return list;
  };

  sheet.innerHTML = `
    <div class="cmd-input-wrap">
      ${icon('command', 15)}
      <input class="cmd-input" id="cmdInput" placeholder="输入命令名称（如：审定、卡片、导出、主题、重复…）" spellcheck="false" />
      <kbd>Esc</kbd>
    </div>
    <div class="cmd-list" id="cmdList"></div>`;

  $('#modal').hidden = false;
  let curList = render();
  const input = $('#cmdInput');
  input?.focus();
  input?.addEventListener('input', (e) => {
    filter = e.target.value;
    idx = 0;
    curList = render();
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (curList.length) { idx = (idx + 1) % curList.length; curList = render(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (curList.length) { idx = (idx - 1 + curList.length) % curList.length; curList = render(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = curList[idx];
      $('#modal').hidden = true;
      if (hit) hit.run();
    }
  });
}

function openExportModal() {
  const sheet = $('#sheet');
  const rows = visible();
  sheet.innerHTML = `
    <div class="sheet-head">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h3 class="sheet-title">导出典藏书目</h3>
        <button class="ibtn" id="btnCloseExport" title="关闭">${icon('x', 13)}</button>
      </div>
      <div class="sheet-sub">适配 Obsidian / Notion 知识库或浏览器标准迁移</div>
    </div>
    <div class="sheet-body">
      <button class="fold-row" id="expMdClean">
        ${icon('download', 14)}
        <span class="fold-name">全库 Obsidian Markdown（自动剔除失效链接）</span>
        <span class="fold-path">.md</span>
      </button>
      <button class="fold-row" id="expMdView">
        ${icon('download', 14)}
        <span class="fold-name">当前视图 Markdown（${rows.length} 条）</span>
        <span class="fold-path">.md</span>
      </button>
      <button class="fold-row" id="expHtmlAll">
        ${icon('download', 14)}
        <span class="fold-name">标准 Netscape HTML 书签文件（全库）</span>
        <span class="fold-path">.html</span>
      </button>
      <button class="fold-row" id="expTsvView">
        ${icon('download', 14)}
        <span class="fold-name">当前视图表格清单（含状态码）</span>
        <span class="fold-path">.tsv</span>
      </button>
    </div>`;
  $('#modal').hidden = false;
  $('#btnCloseExport')?.addEventListener('click', () => { $('#modal').hidden = true; });
  $('#expMdClean')?.addEventListener('click', () => {
    const md = toMarkdown(S.items, S.scheme, { health: S.health, meta: S.meta, excludeDead: true });
    downloadFile(`guizang-library-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown;charset=utf-8');
    $('#modal').hidden = true;
    toast('已导出全库 Obsidian Markdown 书目');
  });
  $('#expMdView')?.addEventListener('click', () => {
    const md = toMarkdown(rows, S.scheme, { health: S.health, meta: S.meta, excludeDead: false, title: `归藏 · ${viewMeta().label}` });
    downloadFile(`guizang-view-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown;charset=utf-8');
    $('#modal').hidden = true;
    toast(`已导出当前视图 ${rows.length} 条 Markdown`);
  });
  $('#expHtmlAll')?.addEventListener('click', () => {
    const html = toNetscapeHtml(S.items, S.scheme);
    downloadFile(`guizang-bookmarks-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html;charset=utf-8');
    $('#modal').hidden = true;
    toast('已导出标准 HTML 书签');
  });
  $('#expTsvView')?.addEventListener('click', () => {
    $('#modal').hidden = true;
    exportDead();
  });
}

let pickCallback = null;

function pickFolder(title, sub, onPick) {
  pickCallback = onPick;
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-head">
      <div class="sheet-title">${esc(title)}</div>
      <div class="sheet-sub">${esc(sub)}</div>
    </div>
    <div class="sheet-body">
      ${S.scheme.map((f) => `<button class="fold-row" data-code="${esc(f.code)}">
        <span class="fold-code">${esc(f.code)}</span>
        <span class="fold-name">${esc(f.name)}</span>
        <span class="fold-path">${esc(f.path)}</span>
      </button>`).join('') || '<div class="empty-hint" style="padding:12px">还没有分类文件夹。</div>'}
    </div>`;
  $('#modal').hidden = false;
  sheet.querySelectorAll('[data-code]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.code;
      $('#modal').hidden = true;
      if (pickCallback) await pickCallback(code);
    });
  });
}

function openShortcutsModal() {
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-head">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h3 class="sheet-title">快捷键速查</h3>
        <button class="ibtn" id="btnCloseShortcuts" title="关闭">${icon('x', 13)}</button>
      </div>
      <div class="sheet-sub">支持拖拽书签到左栏归类 · 列表右键菜单 · 地址栏 gz 秒搜</div>
    </div>
    <div class="sheet-body shortcuts-sheet">
      <div class="sc-row"><span>聚焦搜索框（支持拼音首字母 / #标签 / domain:）</span><div><kbd>/</kbd> 或 <kbd>⌘ K</kbd></div></div>
      <div class="sc-row"><span>打开命令面板</span><div><kbd>⌘ ⇧ P</kbd> 或搜索框输 <kbd>&gt;</kbd></div></div>
      <div class="sc-row"><span>进入「逐卷审定」沉浸清仓模式</span><div><kbd>T</kbd></div></div>
      <div class="sc-row"><span>循环切换视图（列表 / 卡片墙 / 紧凑）</span><div><kbd>V</kbd></div></div>
      <div class="sc-row"><span>上 / 下切换选择行</span><div><kbd>↑</kbd> / <kbd>↓</kbd></div></div>
      <div class="sc-row"><span>勾选 / 连续范围多选</span><div><kbd>Space</kbd> / <kbd>Shift + Click</kbd></div></div>
      <div class="sc-row"><span>前景打开 / 后台静默打开</span><div><kbd>Enter</kbd> / <kbd>O</kbd></div></div>
      <div class="sc-row"><span>星标 / 稍后阅读 / 复制网址 / 原地改名</span><div><kbd>S</kbd> <kbd>U</kbd> <kbd>C</kbd> <kbd>E</kbd></div></div>
      <div class="sc-row"><span>详情抽屉 / 移动分类 / 重测 / 删除</span><div><kbd>I</kbd> <kbd>M</kbd> <kbd>R</kbd> <kbd>⌫</kbd></div></div>
      <div class="sc-row"><span>撤销上一步操作 / 关闭浮层</span><div><kbd>⌘ Z</kbd> / <kbd>Esc</kbd></div></div>
    </div>`;
  $('#modal').hidden = false;
  $('#btnCloseShortcuts')?.addEventListener('click', () => { $('#modal').hidden = true; });
}

$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') $('#modal').hidden = true;
});

function exportDead() {
  const rows = visible().map((it) => {
    const h = S.health[it.id] || {};
    return [it.title, it.url, h.status || '', h.code || '', fmtDate(it.added)].join('\t');
  });
  const text = '标题\t地址\t状态\t代码\t添加\n' + rows.join('\n');
  downloadFile('guizang-links.tsv', text, 'text/tab-separated-values;charset=utf-8');
  toast(`已导出 ${rows.length} 条`);
}

/* ── 分栏拖拽调节宽度 + 卡片鼠标追光 ───────────── */

function initResizers() {
  const root = document.documentElement;
  const savedRail = Number(readLocal('guizang_rail_w', '0'));
  const savedInsp = Number(readLocal('guizang_insp_w', '0'));
  if (savedRail >= 180 && savedRail <= 360) root.style.setProperty('--rail-w', savedRail + 'px');
  if (savedInsp >= 300 && savedInsp <= 520) root.style.setProperty('--insp-w', savedInsp + 'px');

  const wireHandle = (el, side, varName, storageKey, min, max, def) => {
    if (!el) return;
    el.addEventListener('dblclick', () => {
      root.style.setProperty(varName, def + 'px');
      try { localStorage.removeItem(storageKey); } catch {}
    });
    el.addEventListener('pointerdown', (startEv) => {
      startEv.preventDefault();
      el.classList.add('is-resizing');
      document.body.classList.add('is-col-resizing');
      const startX = startEv.clientX;
      const current = parseInt(getComputedStyle(root).getPropertyValue(varName), 10) || def;
      const onMove = (ev) => {
        const delta = side === 'left' ? (ev.clientX - startX) : (startX - ev.clientX);
        const next = Math.max(min, Math.min(max, Math.round(current + delta)));
        root.style.setProperty(varName, next + 'px');
      };
      const onUp = () => {
        el.classList.remove('is-resizing');
        document.body.classList.remove('is-col-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const val = parseInt(root.style.getPropertyValue(varName), 10);
        if (val) try { localStorage.setItem(storageKey, String(val)); } catch {}
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  };

  wireHandle($('#railResizer'), 'left', '--rail-w', 'guizang_rail_w', 180, 360, 256);
  wireHandle($('#inspResizer'), 'right', '--insp-w', 'guizang_insp_w', 300, 520, 360);
}

// 暗色卡片鼠标追光（轻量事件委托，零额外 DOM）
$('#list')?.addEventListener('pointermove', (e) => {
  const tile = e.target.closest('.card-tile');
  if (!tile) return;
  const r = tile.getBoundingClientRect();
  tile.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  tile.style.setProperty('--my', (e.clientY - r.top) + 'px');
});
$('#list')?.addEventListener('scroll', closeContextMenu, { passive: true });

/* ── 组装与事件 ───────────────────────────────── */

function renderAll() {
  renderTop();
  renderRail();
  renderHead();
  renderFilterBar();
  renderList();
  renderInspector();
  renderScan();
}

function showStaleBar(info) {
  if (document.getElementById('staleBar')) return;
  const bar = document.createElement('div');
  bar.id = 'staleBar';
  bar.className = 'stale-bar';
  bar.innerHTML = `
    ${icon('alert', 13)}
    <span>扩展代码已更新，但后台还在跑旧版本${info && info.proto ? `（协议 ${info.proto} ≠ ${info.expected}）` : ''}，很多操作会没有反应。</span>
    <button class="btn btn-line btn-sm" id="staleReload">打开扩展页重新加载</button>`;
  bar.querySelector('#staleReload').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/' });
  });
  const app = document.querySelector('.app');
  const body = document.querySelector('.manager-body');
  if (!app || !body) return;
  app.insertBefore(bar, body);
  app.classList.add('has-stale');
  requestAnimationFrame(() => {
    app.style.setProperty('--stale-h', bar.offsetHeight + 'px');
  });
}

async function checkHealthProtocol() {
  const r = await checkProto();
  if (!r.ok) showStaleBar({ proto: r.proto, expected: PROTO });
}

async function load() {
  const st = await send('state:load');
  S.items = st.items;
  S.scheme = st.scheme;
  S.health = st.health || {};
  S.pending = st.pending || {};
  S.meta = st.meta || {};
  S.learned = st.learned || { domains: {} };
  S.usageCache = st.usageCache || null;
  S.settings = st.settings || {};
  S.aiReady = st.aiReady;
  S.scan = st.scan || { running: false, done: 0, total: 0 };
  if (st.pendingDropped) S.pendingNote = st.pendingDropped;
  const org = await send('organize:load').catch(() => null);
  if (org) {
    S.plan = org.plan || null;
    S.planBusy = Boolean(org.running);
    S.applyBusy = Boolean(org.applying);
  }
  const jr = await send('organize:journal').catch(() => null);
  if (jr) {
    S.journal = jr.latest;
    S.journals = jr.list || [];
  }
  S.loaded = true;
  renderAll();
}

const reloadSoon = debounce(() => { load().catch(() => {}); }, 150);

onBroadcast((msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'scan:start') {
    S.scan = { running: true, done: 0, total: msg.total };
    renderScan();
    renderTop();
    return;
  }
  if (msg.type === 'scan:progress') {
    S.scan = { running: true, done: msg.done, total: msg.total };
    if (msg.id && msg.result) {
      S.health[msg.id] = msg.result;
      const cell = $(`[data-id="${msg.id}"] .st`);
      if (cell) cell.outerHTML = statusMark(msg.result);
      const row = $(`[data-id="${msg.id}"]`);
      if (row) {
        const markEl = $('.row-mark', row);
        if (markEl) markEl.className = 'row-mark' + (PROBLEM.has(msg.result.status) ? ' mark-dead' : '');
      }
    }
    renderScan();
    return;
  }
  if (msg.type === 'scan:done') {
    S.scan = { running: false, done: msg.total, total: msg.total };
    renderScan();
    reloadSoon();
    toast('检测完成');
    return;
  }
  if (msg.type === 'scan:error') {
    S.scan = { running: false, done: 0, total: 0 };
    renderScan();
    toast(msg.message || '检测中断');
    return;
  }
  if (msg.type === 'ai:start') {
    S.aiBusy = true;
    S.aiProgress = { done: 0, total: msg.total };
    renderInspector();
    return;
  }
  if (msg.type === 'ai:progress') {
    S.aiProgress = { done: msg.done, total: msg.total };
    renderInspector();
    return;
  }
  if (msg.type === 'organize:start') {
    S.planBusy = true;
    S.planProgress = { stage: 'preselect', done: 0, total: 0 };
    renderInspector();
    return;
  }
  if (msg.type === 'organize:progress') {
    S.planProgress = { stage: msg.stage, done: msg.done, total: msg.total };
    renderInspector();
    return;
  }
  if (msg.type === 'organize:apply-start') {
    S.applyBusy = true;
    S.applyProgress = { done: 0, total: msg.total };
    renderInspector();
    return;
  }
  if (msg.type === 'organize:apply-progress') {
    S.applyProgress = { done: msg.done, total: msg.total };
    renderInspector();
    return;
  }
  if (msg.type === 'organize:applied') {
    S.applyBusy = false;
    S.applyProgress = null;
    S.journal = msg.entry || null;
    reloadSoon();
    toast(
      `已移动 ${msg.entry ? msg.entry.applied : 0} 条${msg.failed ? `，失败 ${msg.failed}` : ''}${msg.stopped ? '（已停止）' : ''}`,
      msg.entry ? { actionText: '撤销', onAction: () => undoJournal(msg.entry.id) } : undefined,
    );
    return;
  }
  if (msg.type === 'organize:done') {
    S.planBusy = false;
    S.planProgress = null;
    S.plan = msg.plan || null;
    renderInspector();
    renderRail();
    return;
  }
  if (msg.type === 'organize:error') {
    S.planBusy = false;
    renderInspector();
    toast(msg.message || '整理计划生成失败');
    return;
  }
  if (msg.type === 'organize:warn') {
    toast(msg.message);
    return;
  }
  if (msg.type === 'state:changed') {
    reloadSoon();
  }
});

// 全键盘流导航（零重绘原地巡航 + 单键操作 + 逐卷审定）
document.addEventListener('keydown', async (e) => {
  if (triage.handleKeydown(e)) return;

  const isInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    closeContextMenu();
    openCommandPalette();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    closeContextMenu();
    $('#q')?.focus();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (!isInput && triggerUndo()) {
      e.preventDefault();
      return;
    }
  }

  if (e.key === 'Escape') {
    if (!$('#ctxMenu').hidden) { closeContextMenu(); return; }
    if (!$('#modal').hidden) { $('#modal').hidden = true; return; }
    if (isInput && document.activeElement.id === 'q') {
      if (S.q) {
        S.q = '';
        renderTop();
        renderFilterBar();
        renderList();
        renderHead();
      } else if (S.filterBarOpen) {
        S.filterBarOpen = false;
        renderFilterBar();
      }
      document.activeElement.blur();
      return;
    }
    if (S.editing) { S.editing = null; renderInspector(); return; }
    if (S.drawer) { S.drawer = null; S.editing = null; renderInspector(); renderTop(); return; }
  }

  if (isInput) return;

  const key = e.key.toLowerCase();

  if (e.key === '/') { e.preventDefault(); $('#q')?.focus(); return; }
  if (e.key === '?') { e.preventDefault(); openShortcutsModal(); return; }
  if (key === 't') { e.preventDefault(); triage.open(); return; }
  if (key === 'v') {
    e.preventDefault();
    const order = ['list', 'cards', 'compact'];
    setViewMode(order[(order.indexOf(S.viewMode) + 1) % order.length]);
    return;
  }

  if (key === 'i') {
    e.preventDefault();
    if (S.drawer === 'detail') { S.drawer = null; S.editing = null; }
    else if (S.selected) S.drawer = 'detail';
    renderInspector();
    renderTop();
    return;
  }

  if (key === 's' && S.selected) {
    e.preventDefault();
    const cur = S.meta[S.selected] || {};
    const next = !cur.star;
    const r = await send('meta:set', { id: S.selected, patch: { star: next } });
    if (r.entry) S.meta[S.selected] = r.entry; else delete S.meta[S.selected];
    renderRail();
    renderList();
    if (S.drawer === 'detail') renderInspector();
    toast(next ? '已加星标' : '已取消星标');
    return;
  }

  if (key === 'u' && S.selected) {
    e.preventDefault();
    const cur = S.meta[S.selected] || {};
    const next = cur.readState === 'unread' ? 'read' : 'unread';
    const r = await send('meta:set', { id: S.selected, patch: { readState: next } });
    if (r.entry) S.meta[S.selected] = r.entry; else delete S.meta[S.selected];
    renderRail();
    renderList();
    if (S.drawer === 'detail') renderInspector();
    toast(next === 'unread' ? '已加入稍后阅读' : '已标为已读');
    return;
  }

  if (key === 'c' && S.selected) {
    e.preventDefault();
    const it = S.items.find((x) => x.id === S.selected);
    if (it) { await navigator.clipboard.writeText(it.url).catch(() => {}); toast('已复制网址'); }
    return;
  }

  if (key === 'o' && S.selected) {
    e.preventDefault();
    const it = S.items.find((x) => x.id === S.selected);
    if (it) { chrome.tabs.create({ url: it.url, active: false }); toast('已在后台标签打开'); }
    return;
  }

  if (key === 'e' && S.selected) {
    e.preventDefault();
    startInlineRename(S.selected);
    return;
  }

  if (key === 'm') {
    e.preventDefault();
    const targetIds = S.sel.size ? [...S.sel] : (S.selected ? [S.selected] : []);
    if (!targetIds.length) return;
    const title = targetIds.length === 1 ? (S.items.find((x) => x.id === targetIds[0])?.title || '') : `${targetIds.length} 条选中的书签`;
    pickFolder(title, '移动到分类', (code) => moveWithUndo(targetIds, code, targetIds.length === 1));
    return;
  }

  if (key === 'r') {
    e.preventDefault();
    const targetIds = S.sel.size ? [...S.sel] : (S.selected ? [S.selected] : []);
    if (targetIds.length) {
      toast(`正在重测 ${targetIds.length} 条书签...`);
      await send('health:run', { ids: targetIds }).catch((err) => toast(err.message));
    }
    return;
  }

  const shown = visible().slice(0, S.renderLimit || 400);
  if (!shown.length) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    let curIdx = shown.findIndex((x) => x.id === S.selected);
    if (e.key === 'ArrowDown') curIdx = curIdx < shown.length - 1 ? curIdx + 1 : 0;
    else curIdx = curIdx > 0 ? curIdx - 1 : shown.length - 1;
    S.selected = shown[curIdx].id;
    syncSelectionInPlace();
    if (S.drawer === 'detail') renderInspector();
    $(`[data-id="${S.selected}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }

  if (e.key === 'Enter') {
    if (S.selected) {
      const it = S.items.find((x) => x.id === S.selected);
      if (it) chrome.tabs.create({ url: it.url });
    }
    return;
  }

  if (e.key === ' ') {
    if (S.selected) {
      e.preventDefault();
      if (S.sel.has(S.selected)) S.sel.delete(S.selected);
      else S.sel.add(S.selected);
      syncSelectionInPlace();
    }
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    const targetIds = S.sel.size ? [...S.sel] : (S.selected ? [S.selected] : []);
    if (targetIds.length) {
      e.preventDefault();
      await deleteWithUndo(targetIds);
    }
  }
});

document.addEventListener('click', (e) => {
  const dd = $('#themeDropdown');
  if (dd && !dd.hidden && !e.target.closest('.theme-dropdown-wrap')) dd.hidden = true;
  if (!$('#ctxMenu').hidden && !e.target.closest('#ctxMenu')) closeContextMenu();
});

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'theme:changed') {
      const dd = $('#themeDropdown');
      if (dd && !dd.hidden) renderThemeDropdown();
    }
  });
}

initResizers();
parseHash();
load()
  .then(() => checkHealthProtocol())
  .catch((e) => {
    document.body.innerHTML = `<div class="empty" style="padding:60px">
      <div class="empty-rule"></div><div class="empty-title">加载失败</div>
      <div class="empty-hint">${esc(e.message)}</div></div>`;
  });
