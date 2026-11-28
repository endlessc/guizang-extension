/* 管理页：书架 / 列表与卡片墙 / 检查器 / 命令面板 / 逐卷审定 */

import {
  $, esc, icon, mark, send, toast, triggerUndo, fmtDate, relTime, faviconMark, wireFavicons,
  TONE, PROBLEM, SUSPECT, statusMark, onBroadcast, debounce, checkProto,
  THEMES, getTheme, setThemeAnimated, confirmDialog,
} from './shared.js';
import { groupByCode, groupByCodeShown, treeOrder, familyOf } from '../lib/tree.js';
import { groupOps, UNSURE_THRESHOLD } from '../lib/organize.js';
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
  folderScheme: [],
  parentOf: {},            // code → 父 code（拆出来的二级靠它挂回一级）
  schemes: [],             // 可选方案列表（含各自的类目数）
  schemeId: '',            // 当前选用的方案
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
  wal: null,               // 上次提交的预写日志摘要（中断恢复用）
  journals: [],            // 最近 3 次整理日志
  orgScope: 'inbox',       // 'inbox' | 'all'
  orgTab: 'plan',          // 'plan' | 'clean'
  orgLimit: '200',
  orgIncludeUnsure: false,
  orgAutoSubs: false,       // 仅按方案建档/全新生成时可选派生二级，日常归类严格走受控词表
  orgTree: 'collection',    // 'collection' 按收藏生成 | 'scheme' 用方案的默认分类
  planFilter: 'all',        // 'all' | 'ready' | 'unsure' | 'skip' | 'blocked'
  splitBusy: false,
  splitProgress: null,         // 每轮条数：'200' | '500' | '1000' | 'all'
  cleanList: null,         // AI 标题洗白建议列表
  cleanBusy: false,
  serendipityOpen: false,
  serendipitySeed: Date.now(),
  wayback: {},             // id -> { loading, available, url, dateLabel, browseUrl }
  dragIds: [],
  recentCodes: (() => {
    try { return JSON.parse(readLocal('guizang_recent_codes', '[]')) || []; } catch { return []; }
  })(),
  collapsedCodes: (() => {
    try { return new Set(JSON.parse(readLocal('guizang_collapsed_codes', '[]')) || []); } catch { return new Set(); }
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
  const idx = S.folderScheme.findIndex((f) => f.code === code);
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

const BUILTIN_VIEWS = ['all', 'starred', 'unread', 'pending', 'dead', 'susp', 'moved', 'dups', 'unchecked', 'inbox', 'usage', 'organize'];

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
  const f = S.folderScheme.find((x) => x.code === code);
  return f ? f.name : code;
}

function visible() {
  let rows = S.items;
  const v = S.view;
  if (v.kind === 'folder') {
    // 一级目录是「子类的和」：拆过二级之后它自己没有直接条目，但下面的书签仍属于它
    const fam = familyOf(v.code, S.parentOf);
    rows = rows.filter((it) => fam.has(it.code || 'none'));
  }
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
      scheme: S.folderScheme,
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
  if (v.kind === 'organize') return { label: '整理与洗白', note: '按方案把待归类或全库错放的条目归位；确认后才会真的移动。' };
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

function saveCollapsedCodes() {
  try { localStorage.setItem('guizang_collapsed_codes', JSON.stringify([...S.collapsedCodes])); } catch {}
}

function ensureAncestorsExpanded(code) {
  let cur = S.parentOf[code];
  let changed = false;
  for (let guard = 0; cur && guard < 8; guard += 1) {
    if (S.collapsedCodes.delete(cur)) changed = true;
    cur = S.parentOf[cur];
  }
  if (changed) saveCollapsedCodes();
}

function railItem({ code, name, count, own = 0, bad, active, view, iconName, tone, dropKind = '', level = 0, subCount = 0, collapsed = false, hasActiveChild = false }) {
  const lead = code
    ? `<span class="rail-num">${esc(code)}</span>`
    : `<span class="rail-icon tone-${tone || 'ink'}">${icon(iconName, 13)}</span>`;
  const countTone = tone === 'dead' && count ? ' tone-dead' : tone === 'warn' && count ? ' tone-warn' : '';
  // 有子类的一级目录：条数是整枝合计，提示里说清「直挂几条 + 子类几条」
  const bits = [];
  if (subCount) bits.push(`本目录直挂 ${own} 条`, `下含 ${subCount} 个子类共 ${count} 条`);
  else bits.push(`${count} 条`);
  if (bad) bits.push(`${bad} 条失效`);
  const tip = code ? `${code} ${name}（${bits.join('，')}，可拖入归类）` : `${name}（${count} 条）`;
  const dropAttr = dropKind ? ` data-drop-kind="${dropKind}"` : (code ? ` data-drop-code="${esc(code)}"` : '');
  const foldPill = subCount
    ? `<span class="rail-fold-pill${hasActiveChild ? ' has-active-child' : ''}" data-fold-code="${esc(code)}" role="button" tabindex="0" aria-expanded="${!collapsed}" title="${collapsed ? '展开' : '折叠'} ${subCount} 个子类">${icon('chevron', 10, 1.8)}<span>${subCount}</span></span>`
    : '';
  return `<button class="rail-item${active ? ' is-active' : ''}${level > 0 ? ' is-sub' : ''}" data-view="${view}"${dropAttr} title="${esc(tip)}">
    ${lead}
    <span class="rail-name">${esc(name)}</span>
    ${foldPill}
    ${bad ? `<span class="rail-bad" title="${bad} 条失效">${bad}</span>` : ''}
    <span class="rail-count${countTone}">${count}</span>
  </button>`;
}

function wireRailDropTargets() {
  let springTimer = null;
  let springCode = '';
  const cancelSpring = () => {
    if (springTimer) { clearTimeout(springTimer); springTimer = null; }
    springCode = '';
  };
  $('#rail').querySelectorAll('[data-drop-code],[data-drop-kind]').forEach((btn) => {
    btn.addEventListener('dragover', (e) => {
      if (!S.dragIds.length) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      btn.classList.add('is-drop-over');
      // 拖拽悬停在已折叠父目录上 420ms 自动展开子类（类似 macOS 弹簧文件夹）
      const code = btn.dataset.dropCode;
      if (code && S.collapsedCodes.has(code) && springCode !== code) {
        cancelSpring();
        springCode = code;
        springTimer = setTimeout(() => {
          setBranchCollapsed(code, false);
          springCode = '';
          springTimer = null;
        }, 420);
      }
    });
    btn.addEventListener('dragleave', () => {
      btn.classList.remove('is-drop-over');
      if (btn.dataset.dropCode === springCode) cancelSpring();
    });
    btn.addEventListener('drop', async (e) => {
      e.preventDefault();
      cancelSpring();
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

/** code → 直接子类个数 */
function childCounts() {
  const map = new Map();
  for (const f of S.folderScheme) {
    const p = S.parentOf[f.code];
    if (p) map.set(p, (map.get(p) || 0) + 1);
  }
  return map;
}

/** 某目录的直接子类，按展示顺序 */
function childFolders(code) {
  return treeOrder(S.folderScheme, S.parentOf).filter((f) => S.parentOf[f.code] === code);
}

function codeCount(code) {
  let n = 0;
  for (const it of S.items) if ((it.code || '') === code) n += 1;
  return n;
}

/** 一级目录被拆开后：给一组子类入口，别让「本目录 0 条」看起来像空目录 */
function subChipsHtml(code) {
  const kids = childFolders(code);
  if (!kids.length) return '';
  const total = kids.reduce((n, k) => n + codeCount(k.code), 0);
  return `<div class="sub-chips">
    <div class="sub-chips-head">下含 ${kids.length} 个子类 · 共 ${total} 条</div>
    <div class="sub-chips-list">${kids.map((k) => `
      <button type="button" class="sub-chip" data-goto-code="${esc(k.code)}" title="进入 ${esc(k.code)} ${esc(k.name)}">
        <span class="sub-chip-num">${esc(k.code)}</span>
        <span class="sub-chip-name">${esc(k.name)}</span>
        <span class="sub-chip-count">${codeCount(k.code)}</span>
      </button>`).join('')}</div>
  </div>`;
}

function wireSubChips(root) {
  root.querySelectorAll('[data-goto-code]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.gotoCode;
      ensureAncestorsExpanded(code);
      S.view = { kind: 'folder', code };
      S.selected = null;
      S.drawer = null;
      renderAll();
    });
  });
}

/**
 * 整理面板顶部的一行：按方案建档判定用的是「方案定义」，不是书签栏里已建的目录。
 * 这两个数经常不一样（比如装了 10 类的杜威、又手工拆出 5 个二级 → 定义 10、已建 15），
 * 分开写清楚，别让人以为拆出来的二级会被当成方案类目。
 */
function schemeLine() {
  const cur = (S.schemes || []).find((x) => x.id === S.schemeId) || null;
  const subFolderCount = Object.keys(S.parentOf).length;
  let schemePill;
  if (!cur) {
    schemePill = S.folderScheme.length
      ? `<button type="button" class="tech-pill is-warn is-link" data-open-opt title="去设置页选用或自定义分类方案">${icon('layers', 11)}<span>现存目录 · 未绑定方案</span></button>`
      : `<button type="button" class="tech-pill is-dead is-link" data-open-opt title="去设置页选用一套分类方案">${icon('alert', 11)}<span>未选方案 · 点此配置</span></button>`;
  } else {
    const defined = (cur.codes || []).length;
    const extra = anchoredSubs(cur);
    schemePill = `<button type="button" class="tech-pill is-brand is-link" data-open-opt title="切换或自定义分类方案">${icon('layers', 11)}<span>${esc(cur.name)} · ${defined} 类${extra ? ` + ${extra} 二级` : ''}</span></button>`;
  }
  const folderPill = `<span class="tech-pill">${icon('folder', 11)}<span>已建目录 ${S.folderScheme.length}${subFolderCount ? `（含 ${subFolderCount} 二级）` : ''}</span></span>`;
  const modelPill = S.aiReady
    ? `<button type="button" class="tech-pill is-ok is-link" data-open-opt title="当前已配置模型，点击前往模型设置"><span class="led-dot is-ok"></span><span>模型就绪${S.settings && S.settings.model ? ' · ' + esc(S.settings.model) : ''}</span></button>`
    : `<button type="button" class="tech-pill is-link" data-open-opt title="未配置模型，当前使用本地关键词规则；点击去设置"><span class="led-dot"></span><span>离线规则模式</span></button>`;
  return `<div class="org-telemetry">${schemePill}${folderPill}<span class="org-telemetry-gap"></span>${modelPill}</div>`;
}

/** 现存目录里，祖先落在当前方案编码中的二级个数（判定池会把它算进去） */
function anchoredSubs(cur) {
  const known = new Set(cur.codes || []);
  let n = 0;
  for (const code of Object.keys(S.parentOf)) {
    let c = S.parentOf[code];
    let guard = 0;
    while (c && guard < 8 && !known.has(c)) {
      c = S.parentOf[c];
      guard += 1;
    }
    if (c && known.has(c)) n += 1;
  }
  return n;
}

function syncFoldAllBtn() {
  const btn = $('#btnFoldAll');
  if (!btn) return;
  const branches = [...$('#rail').querySelectorAll('[data-branch]')];
  if (!branches.length) return;
  const allCollapsed = branches.every((el) => S.collapsedCodes.has(el.dataset.branch));
  btn.classList.toggle('is-all-collapsed', allCollapsed);
  btn.title = allCollapsed ? '展开全部分类子类' : '折叠全部分类子类';
  btn.innerHTML = `${icon('chevronDown', 10, 1.8)}<span>${allCollapsed ? '全部展开' : '全部折叠'}</span>`;
}

function setBranchCollapsed(code, collapsed) {
  if (collapsed) S.collapsedCodes.add(code);
  else S.collapsedCodes.delete(code);
  saveCollapsedCodes();
  const branch = $(`#rail [data-branch="${CSS.escape(code)}"]`);
  if (branch) {
    branch.classList.toggle('is-collapsed', collapsed);
    const children = branch.querySelector('.rail-children');
    if (children) children.setAttribute('aria-hidden', String(collapsed));
    const pill = branch.querySelector('[data-fold-code]');
    if (pill) {
      pill.setAttribute('aria-expanded', String(!collapsed));
      const count = pill.querySelector('span')?.textContent || '';
      pill.title = `${collapsed ? '展开' : '折叠'} ${count} 个子类`;
    }
  }
  syncFoldAllBtn();
}

function renderRail() {
  const c = counts();
  const byCode = {};
  const aggByCode = {};      // 连同后代一起算：一级目录显示的是「整枝」的条数
  const badByCode = {};
  for (const it of S.items) {
    const k = it.code || 'none';
    byCode[k] = (byCode[k] || 0) + 1;
    const bad = PROBLEM.has((S.health[it.id] || {}).status);
    if (bad) badByCode[k] = (badByCode[k] || 0) + 1;
    let cur = k;
    for (let guard = 0; cur && guard < 8; guard += 1) {
      aggByCode[cur] = (aggByCode[cur] || 0) + 1;
      cur = S.parentOf[cur];
    }
  }

  const parts = [];
  parts.push(railItem({ name: '全部收藏', count: c.all, view: 'all', iconName: 'stack', tone: 'ink', active: S.view.kind === 'all' }));
  parts.push(railItem({ name: '星标精选', count: c.starred, view: 'starred', iconName: 'star', tone: 'warn', active: S.view.kind === 'starred', dropKind: 'starred' }));
  parts.push(railItem({ name: '稍后阅读', count: c.unread, view: 'unread', iconName: 'bookmark', tone: 'brand', active: S.view.kind === 'unread', dropKind: 'unread' }));

  parts.push('<div class="section-label">智能视图</div>');
  parts.push(railItem({ name: '待归类', count: c.inbox, view: 'inbox', iconName: 'inbox', tone: 'brand', active: S.view.kind === 'inbox' }));
  parts.push(railItem({ name: '归类建议', count: c.pending, view: 'pending', iconName: 'sparkle', tone: 'brand', active: S.view.kind === 'pending' }));
  parts.push(railItem({ name: '整理与洗白', count: S.plan ? S.plan.ops.length : 0, view: 'organize', iconName: 'folder', tone: 'ink', active: S.view.kind === 'organize' }));
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

  // 拆出来的二级按父子关系折叠挂在父类下面，支持单独折叠与一键全部折叠
  const kids = childCounts();
  const ordered = treeOrder(S.folderScheme, S.parentOf);
  const parentCodesWithKids = ordered.filter((f) => f.level === 0 && (kids.get(f.code) || 0) > 0).map((f) => f.code);
  const allCollapsed = parentCodesWithKids.length > 0 && parentCodesWithKids.every((code) => S.collapsedCodes.has(code));

  if (S.folderScheme.length) {
    parts.push(`<div class="section-label">分类${
      parentCodesWithKids.length
        ? `<button type="button" class="rail-fold-all${allCollapsed ? ' is-all-collapsed' : ''}" id="btnFoldAll" title="${allCollapsed ? '展开全部分类子类' : '折叠全部分类子类'}">${icon('chevronDown', 10, 1.8)}<span>${allCollapsed ? '全部展开' : '全部折叠'}</span></button>`
        : '<span class="section-aside">可拖入</span>'
    }</div>`);
  }

  for (let i = 0; i < ordered.length; i += 1) {
    const f = ordered[i];
    const subCount = kids.get(f.code) || 0;
    if (f.level === 0 && subCount > 0) {
      const descendants = [];
      while (i + 1 < ordered.length && ordered[i + 1].level > 0) {
        i += 1;
        descendants.push(ordered[i]);
      }
      const collapsed = S.collapsedCodes.has(f.code);
      const hasActiveChild = S.view.kind === 'folder' && descendants.some((d) => d.code === S.view.code);
      const parentHtml = railItem({
        code: f.code, name: f.name, count: aggByCode[f.code] || 0, own: byCode[f.code] || 0,
        bad: badByCode[f.code] || 0, view: f.code, level: 0, subCount, collapsed, hasActiveChild,
        active: S.view.kind === 'folder' && S.view.code === f.code,
      });
      const kidsHtml = descendants.map((d) => railItem({
        code: d.code, name: d.name, count: aggByCode[d.code] || 0, own: byCode[d.code] || 0,
        bad: badByCode[d.code] || 0, view: d.code, level: d.level, subCount: 0,
        active: S.view.kind === 'folder' && S.view.code === d.code,
      })).join('');
      parts.push(`<div class="rail-branch${collapsed ? ' is-collapsed' : ''}" data-branch="${esc(f.code)}">
        ${parentHtml}
        <div class="rail-children" aria-hidden="${collapsed}">
          <div class="rail-children-inner">${kidsHtml}</div>
        </div>
      </div>`);
    } else {
      parts.push(railItem({
        code: f.code, name: f.name, count: aggByCode[f.code] || 0, own: byCode[f.code] || 0,
        bad: badByCode[f.code] || 0, view: f.code, level: f.level, subCount: 0,
        active: S.view.kind === 'folder' && S.view.code === f.code,
      }));
    }
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

  $('#btnFoldAll')?.addEventListener('click', () => {
    const branches = [...$('#rail').querySelectorAll('[data-branch]')];
    const nextCollapse = !branches.every((el) => S.collapsedCodes.has(el.dataset.branch));
    branches.forEach((el) => setBranchCollapsed(el.dataset.branch, nextCollapse));
  });

  $('#rail').querySelectorAll('[data-fold-code]').forEach((pill) => {
    const toggle = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const code = pill.dataset.foldCode;
      setBranchCollapsed(code, !S.collapsedCodes.has(code));
    };
    pill.addEventListener('click', toggle);
    pill.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') toggle(e);
    });
  });

  $('#rail').querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('dblclick', () => {
      const foldPill = btn.querySelector('[data-fold-code]');
      if (!foldPill) return;
      const code = foldPill.dataset.foldCode;
      setBranchCollapsed(code, !S.collapsedCodes.has(code));
    });
    btn.addEventListener('click', (e) => {
      if (e.target.closest('[data-fold-code]')) return;
      const v = btn.dataset.view;
      if (v === 'organize') {
        S.view = { kind: 'organize' };
        S.drawer = null;          // 视图与抽屉互斥
        S.selected = null;
        $('.rail')?.classList.remove('is-mobile-open');
        syncMobileOverlay();
        renderAll();
        return;
      }
      S.view = BUILTIN_VIEWS.includes(v) ? { kind: v } : { kind: 'folder', code: v };
      if (S.view.kind === 'folder') ensureAncestorsExpanded(S.view.code);
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
  const aggByCode = new Map();
  let inboxN = 0;
  for (const it of S.items) {
    if (!it.code) { inboxN += 1; continue; }
    let cur = it.code;
    for (let guard = 0; cur && guard < 8; guard += 1) {
      aggByCode.set(cur, (aggByCode.get(cur) || 0) + 1);
      cur = S.parentOf[cur];
    }
  }
  // 按顶层整枝绘制光谱条，拆出二级后与左栏整枝计数保持一致，不碎成零散色块
  const segs = [];
  for (const f of treeOrder(S.folderScheme, S.parentOf)) {
    if (f.level > 0) continue;
    const n = aggByCode.get(f.code) || 0;
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
  if (S.view.kind === 'organize') { $('#listHead').innerHTML = ''; return; }
  const rows = visible();
  const meta = viewMeta();
  const dGroups = S.view.kind === 'dups' ? dupGroups() : [];
  const dupRemovable = removableCount(dGroups);
  const movedReady = S.view.kind === 'moved' ? rows.filter((it) => S.health[it.id]?.finalUrl) : [];
  const canTriage = (S.view.kind === 'inbox' || S.view.kind === 'pending') && rows.length > 0;

  const walNotice = S.wal && S.wal.count
    ? `<div class="alert-card is-dead" style="margin:10px 24px 0;width:auto">
        <span class="alert-card-ico">${icon('alert', 14)}</span>
        <div class="alert-card-body">
          <div class="alert-card-title">上次提交意外中断</div>
          <div>预写日志记录了 <b>${S.wal.count}</b> 条移动未完成收尾，可前往整理工作台按记录回滚或清理。</div>
        </div>
        <button type="button" class="btn btn-line btn-sm" id="btnGotoWal">${icon('undo', 12)}<span>前往处理</span></button>
      </div>`
    : '';

  $('#listHead').innerHTML = walNotice + `
    <div class="list-head">
    <div class="crumbs">
      <span class="crumb-dim">书库</span>
      ${icon('chevron', 10, 1.4)}
      <span class="crumb-now">${esc(meta.label)}</span>
      <span class="crumb-count tnum">${rows.length}</span>
    </div>
    <div class="list-tools">
      ${S.view.kind === 'folder' && rows.length >= 6 && S.aiReady && !childCounts().get(S.view.code)
        ? `<button class="btn btn-line btn-sm" id="btnSplitFolder" title="让模型给这个目录分 2–5 个二级，建子目录并搬进去（可撤销）">${icon('folder', 13)}<span>拆分此目录</span></button>`
        : ''}
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

  $('#btnGotoWal')?.addEventListener('click', () => openOrganize('plan'));
  $('#btnTriage')?.addEventListener('click', () => triage.open(rows));
  $('#btnSplitFolder')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const code = S.view.kind === 'folder' ? S.view.code : '';
    btn.disabled = true;
    btn.innerHTML = `${icon('folder', 13)}<span>正在生成拆分计划…</span>`;
    try {
      const r = await send('organize:splitFolder', { code });
      if (!r || !r.ops) {
        throw new Error('没生成拆分计划：模型未给出可用的子类分配，请重试');
      }
      if (r.plan) S.plan = r.plan;
      toast(`已生成 ${r.subs} 个二级目录的拆分计划（${r.ops} 条），请审阅确认后执行`);
      openOrganize('plan');
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.innerHTML = `${icon('folder', 13)}<span>拆分此目录</span>`;
    }
  });
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
    const ok = await confirmDialog({
      title: '更新跳转链接？',
      message: `把 ${ids.length} 条书签的地址换成检测到的新地址。更新后提示里可以撤销。`,
      okText: `更新 ${ids.length} 条`,
    });
    if (!ok) return;
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
    const ok = await confirmDialog({
      title: '清理重复书签？',
      message: `每组只保留一条，将删除 ${ids.length} 条重复项。删除后提示里可以撤销。`,
      okText: `清理 ${ids.length} 条`,
      danger: true,
    });
    if (!ok) return;
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
  const hasSel = S.sel.size > 0;
  list.classList.toggle('has-sel', hasSel);
  $('#colHeadHost')?.classList.toggle('has-sel', hasSel);
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
  const { showCat = false, dupRole = '', rowIdx = 0 } = opts;
  const h = S.health[it.id];
  const m = S.meta[it.id] || {};
  const pend = S.pending[it.id];
  const dead = PROBLEM.has((h || {}).status);
  const active = S.selected === it.id;
  const checked = S.sel.has(it.id);
  const moved = h && h.status === 'moved' && h.finalUrl;
  const idxText = rowIdx > 0 ? String(rowIdx).padStart(2, '0') : '';
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
    <span class="row-lead">
      <span class="row-idx tnum" aria-hidden="true">${idxText}</span>
      <span class="cb${checked ? ' cb-on' : ''}" data-check="${esc(it.id)}" role="checkbox" tabindex="0"
        aria-checked="${checked}">${checked ? icon('check', 10, 2.2) : ''}</span>
    </span>
    ${faviconMark(it.host, dead, it.url)}
    <div class="row-main">
      <div class="row-title" data-title-host="${esc(it.id)}">${m.star ? '<span class="row-star" title="星标精选">★</span>' : ''}${highlightHtml(it.title)}</div>
      <div class="row-meta">
        ${m.readState === 'unread' ? '<span class="row-unread-dot" title="稍后阅读（未读）"></span>' : ''}
        <span class="host">${highlightHtml(it.host)}</span>
        ${dupBadge}${catBadge}${tagsHtml}${usagePill}
      </div>
    </div>
    ${pend ? `<span class="row-suggest" title="AI 建议归入 ${esc(pend.code)} ${esc(folderName(pend.code))}${pend.model ? ' · ' + esc(pend.model) : ''}">${icon('arrowRight', 11)}<span class="tnum">${esc(pend.code)}</span></span>` : '<span class="row-suggest is-empty"></span>'}
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
  const list = $('#list');
  if (S.view.kind === 'organize') {
    const colHost = $('#colHeadHost');
    if (colHost) colHost.innerHTML = '';
    list.innerHTML = `<div class="organize-view">${organizePanel()}</div>`;
    wireOrganize($('#list'));
    return;
  }
  const rows = visible();
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
        <div class="empty-hint">试试点击下方快捷检索语法，或按 <kbd>Esc</kbd> 清空。</div>
        <div class="empty-chips">
          <button type="button" class="empty-chip" data-try-q="is:star">${icon('star', 11)}<span>is:star</span></button>
          <button type="button" class="empty-chip" data-try-q="is:unread">${icon('bookmark', 11)}<span>is:unread</span></button>
          <button type="button" class="empty-chip" data-try-q="status:dead">${icon('alert', 11)}<span>status:dead</span></button>
          <button type="button" class="empty-chip" data-try-q="">${icon('x', 11)}<span>清空检索</span></button>
        </div>
      </div>`;
      list.querySelectorAll('[data-try-q]').forEach((btn) => {
        btn.addEventListener('click', () => {
          S.q = btn.dataset.tryQ;
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
    } else if (S.view.kind === 'folder' && childFolders(S.view.code).length) {
      // 拆成二级之后，一级目录自己没有直接条目是正常的——别把它画成「空目录」
      list.innerHTML = `<div class="empty">
        <div class="empty-rule"></div>
        <div class="empty-title">这一级没有直接书签</div>
        <div class="empty-hint">收藏都在子类里，点下面进去看；也可以把别处的书签拖进这个分卷。</div>
        ${subChipsHtml(S.view.code)}
      </div>`;
      wireSubChips(list);
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
  const hasSubs = S.view.kind === 'folder' && childFolders(S.view.code).length > 0;
  // 聚合视图按子类分组（组头就是索引），所以不设 flat；搜索时仍平铺
  const flat = S.q.trim()
    ? true
    : (['folder', 'dead', 'susp', 'moved', 'starred', 'unread', 'tag', 'usage'].includes(S.view.kind) && !hasSubs);
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
      </div>` + wrapItems(g.items.map((it, i) => itemRenderer(it, { showCat: true, dupRole: it.id === g.keepId ? 'keep' : 'dup', rowIdx: i + 1 })).join(''))
    ).join('');
  } else if (flat) {
    body = wrapItems(shown.map((it, i) => itemRenderer(it, { showCat, rowIdx: i + 1 })).join(''));
  } else {
    // 用全量算组头总数，只渲染前 400 行；否则「左栏 65 / 组头 9」会像丢数据
    const shownIds = new Set(shown.map((it) => it.id));
    const groups = groupByCodeShown(rows, hasSubs ? treeOrder(S.folderScheme, S.parentOf) : S.folderScheme, shownIds);
    body = groups.map((g) => {
      const bad = g.rows.filter((it) => PROBLEM.has((S.health[it.id] || {}).status)).length;
      const partial = g.rows.length < g.total;
      return `<div class="group-head">
        <span class="group-num">${esc(g.code)}</span>
        <span class="group-name">${esc(g.name)}</span>
        <span class="group-count"${partial ? ` title="本组共 ${g.total} 条，当前显示 ${g.rows.length} 条；点下方「加载更多」继续"` : ''}>${
          partial ? `${g.rows.length} / 共 ${g.total} 条` : `${g.total} 条`
        }</span>
        <span class="group-rule"></span>
        ${bad ? `<span class="group-bad">${bad} 条失效</span>` : ''}
      </div>` + wrapItems(g.rows.map((it, i) => itemRenderer(it, { showCat: false, rowIdx: i + 1 })).join(''));
    }).join('');
  }

  const allChecked = shown.length > 0 && shown.every((it) => S.sel.has(it.id));
  const hasSel = S.sel.size > 0;
  list.classList.toggle('has-sel', hasSel);
  if (colHost) {
    colHost.classList.toggle('has-sel', hasSel);
    colHost.innerHTML = isCards
      ? ''
      : `<div class="col-head">
          <span class="row-lead" title="悬停或点击全选当前列表">
            <span class="row-idx" aria-hidden="true">#</span>
            <span class="cb${allChecked ? ' cb-on' : ''}" id="cbAll" role="checkbox" tabindex="0" aria-checked="${allChecked}">${allChecked ? icon('check', 10, 2.2) : ''}</span>
          </span>
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
  // 单条删除靠提示里的「撤销」兜底；成批删除先问一句，免得手滑
  if (ids.length > 1) {
    const ok = await confirmDialog({
      title: '删除这些书签？',
      message: `将从书签栏删除 ${ids.length} 条。删除后提示里可以撤销，但撤销只保留到下一次整理。`,
      okText: `删除 ${ids.length} 条`,
      danger: true,
    });
    if (!ok) return;
  }
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
    .map((c) => S.folderScheme.find((f) => f.code === c))
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
      const md = toSelectionMarkdown(chosen, S.folderScheme, { meta: S.meta });
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
  const ok = await confirmDialog({
    title: '撤销这次整理？',
    message: '会把这次搬走的书签放回原位、重建被删掉的目录，并清掉本次新建的空目录。\n撤销本身不能再撤回。',
    okText: '撤销',
    danger: true,
  });
  if (!ok) return;
  const r = await send('organize:undo', { journalId: id }).catch((err) => ({ error: err.message }));
  if (r.error) return toast(r.error);
  toast(`已撤销 ${r.restored} 条${r.rebuilt ? `，重建 ${r.rebuilt} 个旧目录` : ''}${
    r.removedCreated ? `，清掉 ${r.removedCreated} 个新建目录` : ''
  }`);
  await load();
}

function openOrganize(tab = 'plan') {
  S.orgTab = tab;
  S.view = { kind: 'organize' };
  S.drawer = null;            // 视图与抽屉互斥
  S.selected = null;
  renderAll();
}

function journalHistoryHtml() {
  const list = S.journals || [];
  if (!list.length) return '';
  return `<div class="journal-list">
    <div class="journal-head">${icon('history', 13)}<span>最近操作日志（支持一键撤销）</span></div>
    ${list.map((j) => {
      const scopeLabel = j.scope === 'all' ? '全库巡检'
        : j.scope === 'ai' ? 'AI 建议'
        : j.scope === 'folder' ? '目录拆分'
        : j.scope === 'scheme' ? '按方案建档' : '待归类';
      const ico = j.scope === 'ai' ? 'sparkle' : j.scope === 'folder' ? 'branch' : 'folder';
      return `<div class="journal-item${j.undoneAt ? ' is-undone' : ''}">
        <span class="journal-ico">${icon(ico, 14)}</span>
        <div class="journal-item-meta">
          <span>移动 <b class="tnum">${j.applied || j.count || 0}</b> 条${
            j.removedFolders ? ` · 清理 <b class="tnum">${j.removedFolders}</b> 个空目录` : ''
          }<span class="journal-scope-pill">${scopeLabel}</span></span>
          <span class="journal-item-when">${relTime(j.at)}</span>
        </div>
        ${j.undoneAt
          ? '<span class="tech-pill">已撤销</span>'
          : `<button type="button" class="btn btn-line btn-sm" data-undo-id="${esc(j.id)}">${icon('undo', 12)}<span>撤销</span></button>`}
      </div>`;
    }).join('')}
  </div>`;
}

let planTick = null;
function stopPlanTick() {
  if (planTick) { clearInterval(planTick); planTick = null; }
}
function startPlanTick() {
  if (planTick) return;
  planTick = setInterval(async () => {
    if (!S.planBusy) { stopPlanTick(); return; }
    renderOrgArea();
    if (Date.now() - (S.planPollAt || 0) < 5000) return;
    S.planPollAt = Date.now();
    const r = await send('organize:load').catch(() => null);
    // 后台既不在跑、也没有计划：多半是 service worker 被回收了，别让界面一直转
    if (r && !r.running && !r.plan) {
      S.planBusy = false;
      stopPlanTick();
      toast('生成中断了：后台已经不在运行，也没有拿到计划，请重新点一次生成');
      renderOrgArea();
    }
  }, 1000);
}

function pipelineStepsHtml(steps, activeIdx) {
  return `<div class="pipeline-steps" style="--steps:${steps.length}">
    ${steps.map((st, idx) => {
      const done = idx < activeIdx;
      const active = idx === activeIdx;
      return `<div class="pipeline-step${done ? ' is-done' : active ? ' is-active' : ''}">
        <span class="pipeline-dot">${done ? icon('check', 11, 2.2) : (idx + 1)}</span>
        <div>
          <span class="pipeline-step-name">${esc(st.name)}</span>
          <span class="pipeline-step-sub">${esc(st.sub)}</span>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function organizePanel() {
  const plan = S.plan;
  const busy = S.planBusy;
  const isClean = S.orgTab === 'clean';
  const c = counts();
  const curScheme = (S.schemes || []).find((x) => x.id === S.schemeId) || null;

  const head = `<div class="insp-head">
      <div class="org-masthead">
        <div class="org-masthead-left">
          <div class="insp-kicker" style="margin-bottom:0">${icon(isClean ? 'wand' : 'folder', 12)} ${isClean ? '标题洗白工作台' : '整理与归档工作台'}</div>
          <h2 class="org-masthead-title">${isClean
            ? (S.cleanBusy ? '正在扫描噪声标题' : S.cleanList ? `发现 ${S.cleanList.length} 条可优化标题` : '标题规范化')
            : (S.applyBusy ? '正在提交整理计划' : busy ? '正在生成整理计划' : plan ? `审阅 ${plan.ops.length} 条归档计划` : '配置整理计划')
          }</h2>
        </div>
        <div class="org-masthead-right">
          <div class="seg-tabs">
            <button type="button" class="seg-tab${!isClean ? ' is-active' : ''}" data-org-tab="plan">归位整理</button>
            <button type="button" class="seg-tab${isClean ? ' is-active' : ''}" data-org-tab="clean">标题洗白</button>
          </div>
          <button class="ibtn" data-close title="返回全部收藏">${icon('x', 14)}</button>
        </div>
      </div>
    </div>`;

  if (isClean) {
    if (S.cleanBusy) {
      return head + `<div class="insp-body"><div class="pipeline-card" style="margin-top:14px">
        ${pipelineStepsHtml([
          { name: '采集标题', sub: '读取当前视图' },
          { name: '模式识别', sub: '角标与冗余后缀' },
          { name: '生成对照', sub: '待人工逐条确认' },
        ], 1)}
        <div class="scan-track"><div class="scan-fill" style="width:52%"></div></div>
      </div></div>`;
    }
    const list = S.cleanList;
    if (!list) {
      return head + `<div class="insp-body"><div class="plan-empty">
        <div class="org-card-grid">
          <div class="org-card is-active" style="cursor:default">
            <div class="org-card-top"><span class="org-card-ico">${icon('wand', 14)}</span><span class="org-card-badge">规则</span></div>
            <div class="org-card-title">剔除未读角标</div>
            <div class="org-card-desc">清理如 (3)、[12] 等动态消息计数前缀。</div>
          </div>
          <div class="org-card" style="cursor:default">
            <div class="org-card-top"><span class="org-card-ico">${icon('link', 14)}</span><span class="org-card-badge">规范</span></div>
            <div class="org-card-title">修剪冗余后缀</div>
            <div class="org-card-desc">去除裸网址、重复站点名与乱码标题。</div>
          </div>
          <div class="org-card" style="cursor:default">
            <div class="org-card-top"><span class="org-card-ico">${icon('shield', 14)}</span><span class="org-card-badge">可控</span></div>
            <div class="org-card-title">逐条对照确认</div>
            <div class="org-card-desc">展示原/新标题差异，点击应用并支持撤销。</div>
          </div>
        </div>
        <div class="org-cta-bar">
          <button type="button" class="btn btn-primary btn-md" data-run-clean>${icon('wand', 14)}<span>扫描噪声标题</span></button>
          <span class="org-cta-note">${icon('info', 12)}<span>每次最多扫描 40 条书签，不会自动修改</span></span>
        </div>
      </div></div>`;
    }
    if (!list.length) {
      return head + `<div class="insp-body"><div class="plan-empty">
        <div class="empty" style="padding:28px 0">
          <div class="empty-mark tone-ok">${icon('checkCircle', 24)}</div>
          <div class="empty-title">当前视图标题都很规范</div>
          <div class="empty-hint">未发现明显的未读角标、裸网址或冗余后缀。</div>
        </div>
        <button type="button" class="btn btn-line btn-sm" data-run-clean>${icon('refresh', 12)}<span>重新扫描</span></button>
      </div></div>`;
    }
    return head + `<div class="insp-body">
      ${list.map((cItem) => `<div class="clean-row">
        <div class="clean-diff-line"><span class="clean-diff-tag is-old">原</span><div class="clean-old">${esc(cItem.from)}</div></div>
        <div class="clean-diff-line"><span class="clean-diff-tag is-new">新</span><div class="clean-new">${esc(cItem.to)}</div></div>
        <div class="clean-acts">
          <button type="button" class="btn btn-primary btn-sm" data-apply-clean="${esc(cItem.id)}">${icon('check', 11)}<span>应用</span></button>
          <button type="button" class="btn btn-ghost btn-sm" data-drop-clean="${esc(cItem.id)}">${icon('x', 11)}<span>忽略</span></button>
        </div>
      </div>`).join('')}
    </div>
    <div class="insp-foot plan-foot">
      <div class="plan-foot-actions">
        <button type="button" class="btn btn-primary btn-sm" data-apply-clean-all>${icon('check', 12)}<span>应用全部 ${list.length} 条</span></button>
        <button type="button" class="btn btn-ghost btn-sm" data-run-clean>${icon('refresh', 12)}<span>重扫</span></button>
      </div>
    </div>`;
  }

  if (S.applyBusy) {
    const ap = S.applyProgress || { done: 0, total: 0 };
    const pct = ap.total ? Math.round((ap.done / ap.total) * 100) : 8;
    const stepIdx = ap.done >= ap.total && ap.total > 0 ? 2 : 1;
    return head + `<div class="insp-body">
      <div class="pipeline-card" style="margin-top:14px">
        ${pipelineStepsHtml([
          { name: '备份与校验', sub: '整树快照 + 冲突检查' },
          { name: '执行移动', sub: `${ap.done}/${ap.total || '…'} 条` },
          { name: '落盘日志', sub: '写入撤销记录' },
        ], stepIdx)}
        <div class="scan-track"><div class="scan-fill" style="width:${pct}%"></div></div>
        <div class="pipeline-foot">
          <div class="pipeline-telemetry">
            <span class="tech-pill is-brand"><span class="led-dot is-brand"></span><span>已完成 ${ap.done} / ${ap.total || '…'}</span></span>
            <span class="tech-pill tnum">${pct}%</span>
          </div>
          <button class="btn btn-line btn-sm" data-stop>${icon('x', 12)}<span>停止</span></button>
        </div>
      </div>
    </div>`;
  }

  if (busy) {
    const pr = S.planProgress || { stage: 'preselect', done: 0, total: 0 };
    const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 8;
    const waited = S.planStartedAt ? Math.max(0, Math.round((Date.now() - S.planStartedAt) / 1000)) : 0;
    const batchWaited = pr.batchAt ? Math.max(0, Math.round((Date.now() - pr.batchAt) / 1000)) : 0;
    const activeIdx = pr.stage === 'subs' ? 3 : pr.stage === 'model' ? 2 : pr.candidates ? 1 : 0;
    const steps = [
      { name: '预筛范围', sub: pr.candidates ? `${pr.candidates} 条候选` : '拉取书签' },
      { name: '本地规则', sub: '偏好 + 关键词' },
      { name: '模型推理', sub: pr.batch && pr.batches ? `第 ${pr.batch}/${pr.batches} 批` : '低把握送审' },
      { name: '派生二级', sub: S.orgAutoSubs ? '≥6 条聚类' : '按需跳过' },
    ];
    return head + `<div class="insp-body">
      <div class="pipeline-card" style="margin-top:14px">
        ${pipelineStepsHtml(steps, activeIdx)}
        <div class="scan-track"><div class="scan-fill" style="width:${pct}%"></div></div>
        <div class="pipeline-foot">
          <div class="pipeline-telemetry">
            <span class="tech-pill is-brand"><span class="led-dot is-brand"></span><span>进度 ${pr.done}/${pr.total || '…'}</span></span>
            ${pr.batchSize ? `<span class="tech-pill">每批 ${pr.batchSize} 条</span>` : ''}
            ${pr.stage === 'model' ? `<span class="tech-pill${batchWaited > 90 ? ' is-warn' : ''}">本批 ${batchWaited}s${batchWaited > 90 ? ' · 超时将重试' : ''}</span>` : ''}
            <span class="tech-pill">${icon('clock', 11)}<span>总用时 ${waited}s</span></span>
          </div>
          <button class="btn btn-line btn-sm" data-stop-plan>${icon('x', 12)}<span>停止并保留已得建议</span></button>
        </div>
      </div>
    </div>`;
  }

  if (!plan) {
    // 方案是源、目录是投影：只要选用了方案或已有分类目录，所有范围均可生成计划，缺目录提交时按需建
    const ready = Boolean(S.schemeId) || S.folderScheme.length > 0;
    const isFreshMode = S.orgScope === 'scheme' && S.orgTree === 'fresh';
    const schemeMissing = S.orgScope === 'scheme' && !(S.settings && S.settings.schemeId);
    return head + `<div class="insp-body">
      <div class="plan-empty">
        ${S.wal && S.wal.count ? `<div class="alert-card is-dead">
          <span class="alert-card-ico">${icon('alert', 14)}</span>
          <div class="alert-card-body">
            <div class="alert-card-title">检测到上次提交中断（${S.wal.count} 条移动）</div>
            <div>意图记录未写完撤销日志，你可以按记录安全回滚到原位置，或清除这条中断状态。</div>
            <div class="alert-card-acts">
              <button type="button" class="btn btn-line btn-sm" data-wal-rollback>${icon('undo', 12)}<span>按记录回滚</span></button>
              <button type="button" class="btn btn-ghost btn-sm" data-wal-clear>忽略并清除</button>
            </div>
          </div>
        </div>` : ''}
        ${schemeLine()}

        <div class="org-section-cap"><span>1 · 选择整理范围</span></div>
        <div class="org-card-grid">
          <button type="button" class="org-card${S.orgScope === 'inbox' ? ' is-active' : ''}" data-org-scope="inbox">
            <div class="org-card-top">
              <span class="org-card-ico">${icon('inbox', 15)}</span>
              <span class="org-card-idx">01</span>
              <span class="org-card-badge">${c.inbox} 卷</span>
            </div>
            <div class="org-card-title">仅待归类</div>
            <div class="org-card-desc">只处理未归入任何类目的书签，逐条审阅后按需建目录。</div>
            <div class="org-card-tags"><span class="org-card-tag">轻量日常</span><span class="org-card-tag">不动已有目录</span></div>
          </button>

          <button type="button" class="org-card${S.orgScope === 'all' ? ' is-active' : ''}" data-org-scope="all">
            <div class="org-card-top">
              <span class="org-card-ico">${icon('compass', 15)}</span>
              <span class="org-card-idx">02</span>
              <span class="org-card-badge">${S.items.length} 卷</span>
            </div>
            <div class="org-card-title">全库巡检错放</div>
            <div class="org-card-desc">巡检错放与方案外书签，保留现存二级，不预建空目录。</div>
            <div class="org-card-tags"><span class="org-card-tag">纠偏整理</span><span class="org-card-tag">按需创建</span></div>
          </button>

          <button type="button" class="org-card${S.orgScope === 'scheme' ? ' is-active' : ''}" data-org-scope="scheme">
            <div class="org-card-top">
              <span class="org-card-ico">${icon('layers', 15)}</span>
              <span class="org-card-idx">03</span>
              <span class="org-card-badge${curScheme ? '' : ' is-warn'}">${curScheme ? `${curScheme.codes.length} 类` : '需选方案'}</span>
            </div>
            <div class="org-card-title">按方案建档</div>
            <div class="org-card-desc">将分类法投影为书签目录树，支持增量建档或全新重建。</div>
            <div class="org-card-tags"><span class="org-card-tag">模式对齐</span><span class="org-card-tag">支持二级派生</span></div>
          </button>
        </div>

        ${schemeMissing ? `<div class="alert-card">
          <span class="alert-card-ico">${icon('info', 14)}</span>
          <div class="alert-card-body">
            <div class="alert-card-title">尚未选用分类方案</div>
            <div>请先前往设置页选定一套分类法（如杜威十进、中图法或自定义方案）。</div>
            <div class="alert-card-acts">
              <button type="button" class="btn btn-primary btn-sm" data-open-opt>${icon('sliders', 12)}<span>去设置页选方案</span></button>
            </div>
          </div>
        </div>` : ''}

        ${S.orgScope === 'scheme' ? `
        <div class="org-section-cap"><span>2 · 目录树投影策略</span></div>
        <div class="org-card-grid">
          <button type="button" class="org-card${S.orgTree === 'collection' ? ' is-active' : ''}" data-org-tree="collection">
            <div class="org-card-top">
              <span class="org-card-ico">${icon('branch', 15)}</span>
              <span class="org-card-badge">推荐</span>
            </div>
            <div class="org-card-title">按收藏生长</div>
            <div class="org-card-desc">只创建真正命中书签的类目，零空文件夹。</div>
          </button>

          <button type="button" class="org-card${S.orgTree === 'scheme' ? ' is-active' : ''}" data-org-tree="scheme">
            <div class="org-card-top">
              <span class="org-card-ico">${icon('grid', 15)}</span>
              <span class="org-card-badge">完整骨架</span>
            </div>
            <div class="org-card-title">照方案建全</div>
            <div class="org-card-desc">方案定义几个类目就建几个，包含空目录占位。</div>
          </button>

          <button type="button" class="org-card${S.orgTree === 'fresh' ? ' is-active' : ''}" data-org-tree="fresh">
            <div class="org-card-top">
              <span class="org-card-ico">${icon('refresh', 15)}</span>
              <span class="org-card-badge is-warn">整树备份</span>
            </div>
            <div class="org-card-title">全新重建</div>
            <div class="org-card-desc">忽略旧分类全量重判，执行后自动清理搬空的旧目录。</div>
          </button>
        </div>` : ''}

        ${isFreshMode ? '' : `
        <div class="org-bar-card">
          <div class="org-bar-label">
            ${icon('sliders', 14)}
            <span>每轮处理上限</span>
            <span class="org-bar-sub">条数越大耗时越长，随时可停止</span>
          </div>
          <div class="seg-tabs">
            ${['200', '500', '1000', 'all'].map((v) => `<button type="button" class="seg-tab${S.orgLimit === v ? ' is-active' : ''}" data-org-limit="${v}">${v === 'all' ? '全部' : v}</button>`).join('')}
          </div>
        </div>`}

        ${S.orgScope === 'scheme' && S.orgTree !== 'scheme' ? `
        <label class="gz-switch-row${S.aiReady ? '' : ' is-disabled'}" style="width:100%">
          <span class="gz-switch-copy">
            <span class="gz-switch-title">
              ${icon('branch', 13)}
              <span>按收藏派生二级目录</span>
              ${S.aiReady ? '<span class="tech-pill is-brand" style="padding:1px 6px;font-size:10px">需模型</span>' : '<span class="tech-pill is-warn" style="padding:1px 6px;font-size:10px">未配模型</span>'}
            </span>
            <span class="gz-switch-desc">仅对尚无二级且命中 ≥ 6 条的一级类目聚类生成子目录。</span>
          </span>
          <span class="gz-switch">
            <input type="checkbox" data-auto-subs ${S.orgAutoSubs ? 'checked' : ''} ${S.aiReady ? '' : 'disabled'} />
            <span class="gz-switch-track"></span>
          </span>
        </label>` : ''}

        <div class="org-cta-bar">
          <button class="btn btn-primary btn-md" data-gen ${ready && !schemeMissing ? '' : 'disabled'}>
            ${icon('sparkle', 14)}<span>生成整理计划</span>
          </button>
          <span class="org-cta-note">${icon('shield', 13)}<span>人在回路审阅 · 提交前自动整树备份 · 支持一键撤销</span></span>
        </div>
        ${journalHistoryHtml()}
      </div>
    </div>`;
  }

  const walBanner = S.wal && S.wal.count ? `<div class="alert-card is-dead" style="margin:10px 0">
    <span class="alert-card-ico">${icon('alert', 14)}</span>
    <div class="alert-card-body">
      <div class="alert-card-title">上次提交中断（${S.wal.count} 条移动未收尾）</div>
      <div class="alert-card-acts">
        <button type="button" class="btn btn-line btn-sm" data-wal-rollback>${icon('undo', 12)}<span>按记录回滚</span></button>
        <button type="button" class="btn btn-ghost btn-sm" data-wal-clear>清掉记录</button>
      </div>
    </div>
  </div>` : '';

  const s = plan.stats;
  const activeFilter = S.planFilter || 'all';
  const filteredPlan = activeFilter === 'all'
    ? plan
    : { ...plan, ops: plan.ops.filter((op) => op.status === activeFilter) };

  const groups = groupOps(filteredPlan).map((g) => {
    const sorted = [...g.ops].sort((a, b) => String((a.to && a.to.sub) ? a.to.sub.code : '')
      .localeCompare(String((b.to && b.to.sub) ? b.to.sub.code : '')));
    let last = null;
    const rows = sorted.map((op) => {
      const sub = op.to && op.to.sub ? op.to.sub : null;
      const headHtml = sub && (!last || last.code !== sub.code)
        ? `<div class="plan-sub-head"><span>${esc(sub.code)}</span> ${esc(sub.name)}</div>`
        : '';
      if (sub) last = sub;
      return headHtml + planRow(op, plan);
    }).join('');
    return `
    <div class="plan-group">
      <div class="plan-group-head">
        <span class="plan-group-code">${esc(g.code)}</span>
        <span class="plan-group-name">${esc(g.name)}</span>
        <span class="plan-group-n">${g.ops.length} 条</span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  const execCount = S.orgIncludeUnsure ? s.ready + s.unsure : s.ready;

  return head + `
    <div class="insp-body">
      ${walBanner}
      <div class="plan-kpi-grid">
        <button type="button" class="plan-kpi${activeFilter === 'all' ? ' is-active' : ''}" data-plan-filter="all">
          <span class="plan-kpi-label">${icon('stack', 11)}<span>全部计划</span></span>
          <span class="plan-kpi-val">${plan.ops.length}</span>
        </button>
        <button type="button" class="plan-kpi tone-ok${activeFilter === 'ready' ? ' is-active' : ''}" data-plan-filter="ready">
          <span class="plan-kpi-label"><span class="led-dot is-ok"></span><span>可移</span></span>
          <span class="plan-kpi-val">${s.ready}</span>
        </button>
        <button type="button" class="plan-kpi tone-warn${activeFilter === 'unsure' ? ' is-active' : ''}" data-plan-filter="unsure">
          <span class="plan-kpi-label"><span class="led-dot is-warn"></span><span>拿不准</span></span>
          <span class="plan-kpi-val">${s.unsure}</span>
        </button>
        <button type="button" class="plan-kpi${activeFilter === 'skip' ? ' is-active' : ''}" data-plan-filter="skip">
          <span class="plan-kpi-label"><span class="led-dot"></span><span>跳过</span></span>
          <span class="plan-kpi-val">${s.skip}</span>
        </button>
        ${s.blocked ? `<button type="button" class="plan-kpi tone-dead${activeFilter === 'blocked' ? ' is-active' : ''}" data-plan-filter="blocked">
          <span class="plan-kpi-label"><span class="led-dot is-dead"></span><span>受管跳过</span></span>
          <span class="plan-kpi-val">${s.blocked}</span>
        </button>` : ''}
        ${plan.created && plan.created.length ? `<div class="plan-kpi tone-brand is-static">
          <span class="plan-kpi-label">${icon('folder', 11)}<span>将新建目录</span></span>
          <span class="plan-kpi-val">+${plan.created.length}</span>
        </div>` : ''}
      </div>

      ${plan.tree === 'fresh' ? `<div class="alert-card" style="margin-top:10px">
        <span class="alert-card-ico">${icon('shield', 14)}</span>
        <div class="alert-card-body">
          <div class="alert-card-title">全新重建模式 · 整树已安全备份${plan.backupAt ? `（${relTime(plan.backupAt)}）` : ''}</div>
          <div>执行后将清理搬空的旧类目目录${plan.removeEstimate && plan.removeEstimate.length ? `（预计 <b>${plan.removeEstimate.length}</b> 个：${esc(plan.removeEstimate.slice(0, 6).map((f) => f.code).join('、'))}${plan.removeEstimate.length > 6 ? '…' : ''}）` : '（本轮预计无空目录需清理）'}，撤销时自动按原名重建并归还。</div>
        </div>
      </div>` : ''}

      ${groups || `<div class="empty" style="padding:36px 8px">
        <div class="empty-title">${activeFilter === 'all' ? '当前计划没有需要移动的书签' : '此筛选状态下没有条目'}</div>
        <div class="empty-hint">${activeFilter === 'all' ? '全部候选书签已在合适目录中，或已被剔除。' : '点击上方「全部计划」可查看完整列表。'}</div>
      </div>`}
    </div>
    <div class="insp-foot plan-foot">
      <div class="pipeline-telemetry">
        <span class="tech-pill">${icon('clock', 11)}<span>生成于 ${relTime(plan.at)}</span></span>
        <span class="tech-pill">${plan.scope === 'scheme' ? '按方案建档' : plan.scope === 'all' ? '全库巡检' : '待归类'}</span>
        ${plan.overflow ? `<span class="tech-pill is-warn">另有 ${plan.overflow} 条待下轮</span>` : ''}
        ${plan.scope === 'all' && plan.outside ? `<span class="tech-pill">方案外 ${plan.outside} 条</span>` : ''}
      </div>
      ${s.unsure ? `
      <label class="gz-switch-row is-compact">
        <span class="gz-switch-copy">
          <span class="gz-switch-title">连「拿不准」一起执行<span class="tech-pill is-warn" style="padding:1px 6px;font-size:10px">+${s.unsure} 条</span></span>
        </span>
        <span class="gz-switch">
          <input type="checkbox" data-include-unsure ${S.orgIncludeUnsure ? 'checked' : ''} />
          <span class="gz-switch-track"></span>
        </span>
      </label>` : ''}
      <div class="plan-foot-actions">
        <button class="btn btn-primary btn-sm" data-apply ${execCount ? '' : 'disabled'}>${icon('check', 12)}<span>确认提交 ${execCount} 条</span></button>
        <button class="btn btn-line btn-sm" data-split ${S.splitBusy ? 'disabled' : ''}>${icon('branch', 12)}<span>${
          S.splitBusy ? `拆分中 ${S.splitProgress ? `${S.splitProgress.done}/${S.splitProgress.total}` : '…'}` : '再拆一层二级'
        }</span></button>
        <button class="btn btn-line btn-sm" data-gen>${icon('refresh', 12)}<span>重新生成</span></button>
        <button class="btn btn-ghost btn-sm" data-clear>${icon('trash', 12)}<span>清空计划</span></button>
      </div>
    </div>`;
}

function planRow(op, plan) {
  const pickList = (plan && plan.scheme && plan.scheme.length) ? plan.scheme : S.folderScheme;
  const fromCode = op.from && op.from.code ? op.from.code : '待归类';
  const pickable = op.status === 'ready' || op.status === 'unsure';
  const lineage = lineageOf(op);
  const conf = Number.isFinite(op.conf) ? op.conf : null;
  const unsure = op.status === 'unsure' || (conf !== null && conf < UNSURE_THRESHOLD);

  const routeHtml = op.status === 'ready'
    ? `<span class="plan-route">
        <span class="chip chip-from tnum">${esc(fromCode)}</span>
        <span class="sg-arrow">${icon('arrowRight', 11)}</span>
        <span class="chip chip-to"><b>${esc(op.to.code)}</b>${esc(op.to.name)}</span>
        ${op.to.missing ? '<span class="plan-new-badge">+新建</span>' : ''}
      </span>`
    : op.status === 'unsure'
      ? `<span class="plan-route">
          <span class="source-pill is-unsure">拿不准</span>
          ${op.to && op.to.code ? `<span class="chip chip-from tnum">${esc(op.to.code)} ${esc(op.to.name || '')}</span>` : ''}
        </span>`
      : op.status === 'blocked'
        ? '<span class="source-pill" style="background:var(--dead-wash);color:var(--dead)">受管书签</span>'
        : '<span class="source-pill">已在位跳过</span>';

  const sourceBadge = op.source === 'learned'
    ? '<span class="source-pill is-learned">历史偏好</span>'
    : op.source === 'heuristic'
      ? '<span class="source-pill">本地规则</span>'
      : op.source === 'manual'
        ? '<span class="source-pill is-model">手动改判</span>'
        : '';

  return `<div class="plan-row">
    <div class="plan-row-top">
      <div class="plan-title" title="${esc(op.title)}">${esc(op.title)}</div>
      ${conf !== null ? `<span class="sg-conf${unsure ? ' is-unsure' : ''}" title="置信度 ${conf.toFixed(2)}">
        <span class="sg-conf-bar"><span style="width:${Math.round(conf * 100)}%"></span></span>${conf.toFixed(2)}
      </span>` : ''}
      <button class="ibtn plan-drop" data-drop="${esc(op.id)}" title="从计划里剔除" aria-label="从计划里剔除">${icon('x', 11)}</button>
    </div>
    <div class="plan-row-bot">
      <div class="plan-sub" style="flex-wrap:wrap;align-items:center">
        ${routeHtml}
        ${sourceBadge}
        ${lineage ? `<span class="lineage-pill" title="数据血缘：${esc(lineage)}">${icon('cpu', 10)}<span>${esc(lineage)}</span></span>` : ''}
        ${op.reason ? `<span class="plan-why" title="${esc(op.reason)}">${esc(op.reason)}</span>` : ''}
      </div>
      ${pickable ? `<select class="plan-pick" data-pick="${esc(op.id)}" title="改判到哪个类目" aria-label="改判目标类目">
        ${pickList.map((f) => `<option value="${esc(f.code)}"${op.to && op.to.code === f.code ? ' selected' : ''}>${esc(f.code)} ${esc(f.name)}</option>`).join('')}
      </select>` : ''}
    </div>
  </div>`;
}

function wireOrganize(root) {
  const box = root || $('#inspector');
  box.querySelector('[data-close]')?.addEventListener('click', () => {
    S.drawer = null;
    S.view = { kind: 'all' };
    renderAll();
  });
  box.querySelectorAll('[data-open-opt]').forEach((btn) => {
    btn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  });
  box.querySelectorAll('[data-plan-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.planFilter = btn.dataset.planFilter || 'all';
      renderOrgArea();
    });
  });
  box.querySelectorAll('[data-org-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { S.orgTab = btn.dataset.orgTab; renderOrgArea(); });
  });
  box.querySelectorAll('[data-org-scope]').forEach((btn) => {
    btn.addEventListener('click', () => { S.orgScope = btn.dataset.orgScope; renderOrgArea(); });
  });
  box.querySelectorAll('[data-org-limit]').forEach((btn) => {
    btn.addEventListener('click', () => { S.orgLimit = btn.dataset.orgLimit; renderOrgArea(); });
  });
  box.querySelector('[data-run-clean]')?.addEventListener('click', async () => {
    S.cleanBusy = true;
    renderOrgArea();
    try {
      const ids = visible().slice(0, 40).map((x) => x.id);
      const r = await send('ai:cleanTitles', { ids });
      S.cleanList = r.items || [];
    } catch (e) {
      toast(e.message);
      S.cleanList = [];
    } finally {
      S.cleanBusy = false;
      renderOrgArea();
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
      renderOrgArea();
    });
  });
  box.querySelector('[data-apply-clean-all]')?.addEventListener('click', async () => {
    const list = S.cleanList || [];
    if (!list.length) return;
    const ok = await confirmDialog({
      title: '应用全部标题修改？',
      message: `会修改 ${list.length} 条书签的标题。应用后提示里可以撤销。`,
      okText: `应用 ${list.length} 条`,
    });
    if (!ok) return;
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
    S.planFilter = 'all';
    S.planBusy = true;
    S.planStartedAt = Date.now();
    S.planPollAt = 0;
    startPlanTick();
    S.planProgress = { stage: 'preselect', done: 0, total: 0 };
    renderOrgArea();
    const limit = S.orgLimit === 'all' ? 'all' : Number(S.orgLimit) || 200;
    await send('organize:plan', { scope: S.orgScope, limit, autoSubs: S.orgAutoSubs, tree: S.orgTree }).catch((err) => {
      S.planBusy = false;
      toast(err.message);
      renderOrgArea();
    });
  });
  box.querySelector('[data-stop-plan]')?.addEventListener('click', async () => {
    await send('organize:stop').catch(() => {});
    toast('已请求停止，等这一批返回后出计划');
  });
  box.querySelector('[data-include-unsure]')?.addEventListener('change', (e) => {
    S.orgIncludeUnsure = Boolean(e.target.checked);
    renderOrgArea();
  });
  box.querySelector('[data-auto-subs]')?.addEventListener('change', (e) => {
    S.orgAutoSubs = Boolean(e.target.checked);
    renderOrgArea();
  });
  box.querySelectorAll('[data-org-tree]').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.orgTree = btn.dataset.orgTree;
      renderOrgArea();
    });
  });
  box.querySelector('[data-split]')?.addEventListener('click', async () => {
    S.splitBusy = true;
    S.splitProgress = { done: 0, total: 0 };
    renderOrgArea();
    await send('organize:split').catch((err) => {
      toast(err.message);
    }).finally(() => {
      S.splitBusy = false;
      S.splitProgress = null;
      renderOrgArea();
    });
  });
  box.querySelector('[data-wal-rollback]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '按中断记录回滚？',
      message: '会把中断记录里已经搬走的书签搬回原目录。只动记录里那些条目。',
      okText: '回滚',
      danger: true,
    });
    if (!ok) return;
    const r = await send('organize:walRollback').catch((err) => ({ error: err.message }));
    if (r.error) return toast(r.error);
    toast(`已按记录回滚 ${r.restored || 0} 条`);
    await load();
  });
  box.querySelector('[data-wal-clear]')?.addEventListener('click', async () => {
    await send('organize:walClear').catch(() => {});
    toast('已清掉中断记录');
    await load();
  });
  box.querySelector('[data-clear]')?.addEventListener('click', async () => {
    await send('organize:cancel');
    S.plan = null;
    S.planFilter = 'all';
    renderOrgArea();
    renderRail();
  });
  box.querySelectorAll('[data-drop]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const plan = await send('organize:drop', { id: btn.dataset.drop }).catch(() => null);
      if (plan) { S.plan = plan; renderOrgArea(); renderRail(); }
    });
  });
  box.querySelector('[data-apply]')?.addEventListener('click', async () => {
    S.applyBusy = true;
    const st = (S.plan && S.plan.stats) || {};
    S.applyProgress = { done: 0, total: (st.ready || 0) + (S.orgIncludeUnsure ? (st.unsure || 0) : 0) };
    renderOrgArea();
    await send('organize:apply', { includeUnsure: S.orgIncludeUnsure }).catch((err) => {
      S.applyBusy = false;
      toast(err.message);
      renderOrgArea();
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
      if (plan) { S.plan = plan; renderOrgArea(); renderRail(); toast('已改判并记住此域名偏好'); }
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
       <div class="scan-fill" style="width:${S.aiProgress ? Math.round(S.aiProgress.done / S.aiProgress.total * 100) : 8}%"></div></div>
       <div class="sg-why" style="margin-top:6px">先跑本地规则，只有没把握的才送模型；可以先停，已拿到的建议会保留。</div>
       <button class="btn btn-line btn-sm" data-ai-stop style="margin-top:8px">停止</button></div>`
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
      <h2 class="insp-title">${pend.length ? `${pend.length} 条待确认` : (S.aiBusy ? '正在判断' : '归类队列已清')}</h2>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        <span class="tech-pill${S.aiReady ? ' is-ok' : ''}"><span class="led-dot${S.aiReady ? ' is-ok' : ''}"></span><span>${S.aiReady ? (S.settings?.model || '模型就绪') : '离线关键词规则'}</span></span>
        <span class="tech-pill">${icon('shield', 11)}<span>人在回路确认</span></span>
      </div>
    </div>
    <div class="insp-body">
      ${body || `<div class="empty" style="padding:26px 16px">
        <div class="empty-mark tone-brand">${icon('sparkle', 22)}</div>
        <div class="empty-title" style="font-size:16px">暂无待确认建议</div>
        <div class="empty-hint">${S.aiReady
          ? `可为当前视图的 ${visible().length} 条书签生成智能归类建议，确认后才会移动。`
          : '未配置大模型时将使用本地关键词与改判偏好进行规则归类。'}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
          <button type="button" class="btn btn-primary btn-md" data-run-ai-view>${icon('sparkle', 14)}<span>生成建议（${visible().length} 条）</span></button>
          ${S.aiReady ? '' : `<button type="button" class="btn btn-line btn-md" data-open-opt-ai>${icon('sliders', 13)}<span>去配置模型</span></button>`}
        </div>
      </div>`}
    </div>
    ${pend.length ? (() => {
      const confident = pend.filter((p) => (p.conf || 0) >= UNSURE_THRESHOLD);
      const unsureCount = pend.length - confident.length;
      return `<div class="insp-foot">
        ${confident.length && unsureCount ? `<button class="btn btn-primary btn-md btn-block" data-acceptconfident>
          ${icon('check', 14)}<span>接受有把握的 ${confident.length} 条</span></button>
          <button class="btn btn-line btn-sm btn-block" data-acceptall style="margin-top:6px">
          <span>连「拿不准」一起接受（共 ${pend.length} 条）</span></button>` : `<button class="btn btn-primary btn-md btn-block" data-acceptall>
          ${icon('check', 14)}<span>接受全部 ${pend.length} 条${unsureCount ? `（含 ${unsureCount} 条拿不准）` : ''}</span></button>`}
        <div class="insp-progress">${Object.keys(S.pending).length} 条建议在队列${unsureCount ? ` · ${unsureCount} 条拿不准` : ''}</div>
      </div>`;
    })() : ''}`;
}

/** 建议的血缘：哪个模型、哪版提示词判的；本地规则没有血缘，返回空串 */
function lineageOf(p) {
  const bits = [];
  if (p.model) bits.push(p.model);
  if (p.promptVersion) bits.push(p.promptVersion);
  return bits.join(' · ');
}

function suggestionCard(p) {
  const it = p.item;
  const unsure = (p.conf || 0) < UNSURE_THRESHOLD;
  const picking = S.picking === p.id;
  const lineage = lineageOf(p);
  return `<div class="sg" data-sg="${esc(p.id)}">
    <div class="sg-top">
      <button class="sg-title" data-locate="${esc(p.id)}">${esc(it.title)}</button>
      <span class="sg-conf${unsure ? ' is-unsure' : ''}" title="${unsure ? '低于置信阈值，请人工核对' : '置信度'}">
        <span class="sg-conf-bar"><span style="width:${Math.round(p.conf * 100)}%"></span></span>
        ${p.conf.toFixed(2)}
      </span>
    </div>
    <div class="sg-move">
      <span class="chip chip-from tnum">${esc(it.code || '待归类')}</span>
      ${icon('arrowRight', 12)}
      <span class="chip chip-to"><b>${esc(p.code)}</b>${esc(folderName(p.code))}</span>
      ${unsure ? '<span class="source-pill is-unsure">拿不准</span>' : ''}
      ${p.source === 'heuristic' ? '<span class="source-pill">本地规则</span>' : ''}
      ${p.source === 'learned' ? '<span class="source-pill is-learned">历史偏好</span>' : ''}
      ${lineage ? `<span class="lineage-pill" title="数据血缘">${icon('cpu', 10)}<span>${esc(lineage)}</span></span>` : ''}
    </div>
    <p class="sg-why">${esc(p.reason || '模型没有给出理由')}</p>
    ${picking ? `<div class="sg-picker">${S.folderScheme.map((f) => `
        <button class="sg-pick${f.code === p.code ? ' is-on' : ''}" data-override="${esc(p.id)}" data-code="${esc(f.code)}">
          <span class="sg-pick-num">${esc(f.code)}</span>${esc(f.name)}</button>`).join('')}</div>`
      : `<div class="sg-actions">
        <button class="btn btn-primary btn-sm" data-accept="${esc(p.id)}">${icon('check', 12)}<span>接受</span></button>
        <button class="btn btn-line btn-sm" data-pick="${esc(p.id)}">${icon('folder', 12)}<span>改判</span></button>
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
  box.querySelector('[data-run-ai-view]')?.addEventListener('click', () => runAi(visible().map((x) => x.id)));
  box.querySelector('[data-open-opt-ai]')?.addEventListener('click', () => chrome.runtime.openOptionsPage());

  box.querySelector('#btnAiTriage')?.addEventListener('click', () => {
    const items = Object.keys(S.pending).map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
    triage.open(items);
  });

  const acceptConfident = box.querySelector('[data-acceptconfident]');
  if (acceptConfident && !acceptConfident.disabled) {
    acceptConfident.addEventListener('click', async () => {
      const ids = Object.keys(S.pending).filter(
        (id) => S.items.some((x) => x.id === id) && (S.pending[id].conf || 0) >= UNSURE_THRESHOLD,
      );
      await acceptIds(ids);
    });
  }

  const acceptAll = box.querySelector('[data-acceptall]');
  if (acceptAll && !acceptAll.disabled) {
    acceptAll.addEventListener('click', async () => {
      const ids = Object.keys(S.pending).filter((id) => S.items.some((x) => x.id === id));
      const unsureN = ids.filter((id) => (S.pending[id].conf || 0) < UNSURE_THRESHOLD).length;
      if (unsureN > 0) {
        const ok = await confirmDialog({
          title: `包含 ${unsureN} 条「拿不准」的建议`,
          message: `确定把这 ${ids.length} 条（含 ${unsureN} 条低于阈值 ${UNSURE_THRESHOLD} 的建议）全部归位吗？\n执行前会自动备份，且可在整理日志里一键撤销。`,
          okText: `全部接受（${ids.length} 条）`,
        });
        if (!ok) return;
      }
      await acceptIds(ids);
    });
  }

  box.querySelector('[data-ai-stop]')?.addEventListener('click', async () => {
    await send('ai:stop').catch(() => {});
    toast('已请求停止，等这一批返回后收尾');
  });
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

let aiTick = null;
function stopAiTick() { if (aiTick) { clearInterval(aiTick); aiTick = null; } }
function startAiTick() {
  if (aiTick) return;
  aiTick = setInterval(async () => {
    if (!S.aiBusy) { stopAiTick(); return; }
    const r = await send('ai:load').catch(() => null);
    if (r && !r.running) {
      // 后台已经不在跑但没收到 done：多半是 service worker 被回收
      S.aiBusy = false;
      S.aiProgress = null;
      stopAiTick();
      toast('AI 归类中断了：后台已不在运行，已完成的结果已保留');
      await load();
    }
  }, 5000);
}

async function runAi(ids) {
  if (S.aiBusy) return;
  const scope = ids;
  if (!scope.length) return toast('当前视图没有可归类的书签');
  S.aiBusy = true;
  S.aiProgress = { done: 0, total: scope.length };
  renderInspector();
  startAiTick();
  try {
    // 长任务立即返回，结果通过 ai:done / ai:error 广播回来
    await send('ai:run', { ids: scope });
  } catch (e) {
    S.aiBusy = false;
    S.aiProgress = null;
    stopAiTick();
    toast(e.message);
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
          ${h ? `<span class="status-code">${h.ms ? `<span class="lineage-pill" style="margin-right:4px">${h.ms}ms</span>` : ''}HTTP ${esc(h.code)}</span>` : ''}
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

  const urlBox = box.querySelector('.url-box');
  urlBox?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(it.url);
      urlBox.classList.add('is-copied');
      const icoEl = urlBox.querySelector('.url-box-icon');
      if (icoEl) icoEl.innerHTML = icon('check', 13, 2);
      setTimeout(() => {
        urlBox.classList.remove('is-copied');
        if (icoEl) icoEl.innerHTML = icon('copy', 13);
      }, 1400);
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
      const md = toMarkdown(S.items, S.folderScheme, { health: S.health, meta: S.meta, excludeDead: true });
      downloadFile(`guizang-library-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown;charset=utf-8');
      toast('已导出 Obsidian Markdown 书目');
    } },
    { id: 'export-html', name: '导出标准 HTML 书签文件', desc: '标准 Netscape 格式，可直接导入任意浏览器', ico: 'download', run: () => {
      const html = toNetscapeHtml(S.items, S.folderScheme);
      downloadFile(`guizang-bookmarks-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html;charset=utf-8');
      toast('已导出标准 HTML 书签');
    } },
    { id: 'shortcuts', name: '查看键盘快捷键速查', desc: '全键盘流导航与操作清单', ico: 'window', run: openShortcutsModal },
    { id: 'manual', name: '打开操作手册', desc: '安装、整理、备份与故障排查（新标签页）', ico: 'window', run: () => chrome.tabs.create({ url: chrome.runtime.getURL('ui/manual.html') }) },
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
    const md = toMarkdown(S.items, S.folderScheme, { health: S.health, meta: S.meta, excludeDead: true });
    downloadFile(`guizang-library-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown;charset=utf-8');
    $('#modal').hidden = true;
    toast('已导出全库 Obsidian Markdown 书目');
  });
  $('#expMdView')?.addEventListener('click', () => {
    const md = toMarkdown(rows, S.folderScheme, { health: S.health, meta: S.meta, excludeDead: false, title: `归藏 · ${viewMeta().label}` });
    downloadFile(`guizang-view-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown;charset=utf-8');
    $('#modal').hidden = true;
    toast(`已导出当前视图 ${rows.length} 条 Markdown`);
  });
  $('#expHtmlAll')?.addEventListener('click', () => {
    const html = toNetscapeHtml(S.items, S.folderScheme);
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
      ${S.folderScheme.map((f) => `<button class="fold-row" data-code="${esc(f.code)}">
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

// 卡片与工作台 Bento 卡鼠标追光（轻量事件委托，零额外 DOM）
$('#list')?.addEventListener('pointermove', (e) => {
  const tile = e.target.closest('.card-tile, .org-card');
  if (!tile) return;
  const r = tile.getBoundingClientRect();
  tile.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  tile.style.setProperty('--my', (e.clientY - r.top) + 'px');
});
$('#list')?.addEventListener('scroll', closeContextMenu, { passive: true });

/* ── 组装与事件 ───────────────────────────────── */

function renderOrgArea() {
  if (S.view.kind === 'organize') { renderHead(); renderList(); }
  renderInspector();
  renderRail();
}

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
  S.folderScheme = st.folderScheme;
  S.parentOf = st.parentOf || {};
  const sl = await send('schemes:list').catch(() => null);
  if (sl) {
    S.schemes = sl.schemes || [];
    S.schemeId = sl.current || '';
  }
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
    S.wal = jr.wal || st.wal || null;
  } else {
    S.wal = st.wal || null;
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
  if (msg.type === 'ai:done') {
    S.aiBusy = false;
    S.aiProgress = null;
    stopAiTick();
    const failed = msg.failed || [];
    if (failed.length) {
      toast(`已生成 ${msg.count || 0} 条建议；${failed.length} 批没走通：${failed[0].error}`);
    } else {
      toast(`${msg.source === 'model' ? '模型' : '本地规则'}给出了 ${msg.count || 0} 条建议`);
    }
    load().catch(() => {});
    return;
  }
  if (msg.type === 'ai:error') {
    S.aiBusy = false;
    S.aiProgress = null;
    stopAiTick();
    toast(msg.message || 'AI 归类失败');
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
    S.planStartedAt = Date.now();
    S.planPollAt = 0;
    S.planProgress = { stage: 'preselect', done: 0, total: 0, at: Date.now() };
    startPlanTick();
    renderInspector();
    return;
  }
  if (msg.type === 'organize:progress') {
    S.planProgress = {
      stage: msg.stage, done: msg.done, total: msg.total,
      batch: msg.batch || 0, batches: msg.batches || 0, batchSize: msg.batchSize || 0,
      candidates: msg.candidates || (S.planProgress && S.planProgress.candidates) || 0, at: msg.at || Date.now(),
      batchAt: msg.batch ? (msg.at || Date.now()) : (S.planProgress && S.planProgress.batchAt) || 0,
    };
    if (msg.at) S.planStartedAt = S.planStartedAt || msg.at;
    renderOrgArea();
    return;
  }
  if (msg.type === 'organize:split-start') {
    S.splitBusy = true;
    S.splitProgress = { done: 0, total: msg.total || 0 };
    renderOrgArea();
    return;
  }
  if (msg.type === 'organize:split-progress') {
    S.splitProgress = { done: msg.done || 0, total: msg.total || 0 };
    renderOrgArea();
    return;
  }
  if (msg.type === 'organize:apply-start') {
    S.applyBusy = true;
    S.applyProgress = { done: 0, total: msg.total };
    renderOrgArea();
    return;
  }
  if (msg.type === 'organize:apply-progress') {
    S.applyProgress = { done: msg.done, total: msg.total };
    renderOrgArea();
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
    S.planStartedAt = 0;
    stopPlanTick();
    S.planProgress = null;
    S.plan = msg.plan || null;
    renderOrgArea();
    renderRail();
    return;
  }
  if (msg.type === 'organize:error') {
    S.planBusy = false;
    S.planStartedAt = 0;
    stopPlanTick();
    renderOrgArea();
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
    if (S.view.kind === 'organize') {
      // 整理现在是一个视图：Esc 退出到全部收藏，而不是试图关掉不存在的抽屉
      S.view = { kind: 'all' };
      renderAll();
      return;
    }
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
