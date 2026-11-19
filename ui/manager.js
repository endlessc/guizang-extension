/* 管理页：书架 / 列表 / 检查器 */

import {
  $, esc, icon, mark, send, toast, triggerUndo, fmtDate, relTime, letterOf, faviconMark,
  TONE, PROBLEM, SUSPECT, statusMark, onBroadcast, debounce, checkProto,
  THEMES, getTheme, setTheme,
} from './shared.js';
import { groupByCode } from '../lib/tree.js';
import { groupOps } from '../lib/organize.js';
import { PROTO } from '../lib/version.js';

import { ensureEnv } from './env.js';
await ensureEnv();

const S = {
  loaded: false,
  items: [],
  scheme: [],
  health: {},
  pending: {},
  settings: {},
  aiReady: false,
  scan: { running: false, done: 0, total: 0 },
  view: { kind: 'all' },
  q: '',
  sortDir: -1,          // -1 新→旧，1 旧→新
  selected: null,
  sel: new Set(),
  lastCheckedId: null,
  renderLimit: 400,
  drawer: null,
  picking: null,       // 正在改判的建议 id
  editing: null,       // 正在编辑的书签 { id, title, url }
  aiBusy: false,
  aiProgress: null,
  plan: null,          // 整理计划（只读，执行在下一步）
  planBusy: false,
  planProgress: null,
  done: [],            // 刚归入的，做即时反馈
};

/* ── 路由与 Hash 监听 ───────────────────────────── */

function parseHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return;
  const p = new URLSearchParams(hash);
  const view = p.get('view');
  const drawer = p.get('drawer');
  const id = p.get('id');
  const q = p.get('q');
  const code = p.get('code');

  if (view) {
    if (['all', 'pending', 'dead', 'susp', 'unchecked', 'inbox'].includes(view)) {
      S.view = { kind: view };
    } else if (view === 'folder') {
      S.view = { kind: 'folder', code: code || 'none' };
    } else {
      S.view = { kind: 'folder', code: view };
    }
  }
  if (drawer) S.drawer = drawer;
  if (id) { S.selected = id; S.drawer = 'detail'; }
  if (q != null) S.q = q;
  if (p.get('modal') === 'shortcuts') setTimeout(openShortcutsModal, 50);
}

window.addEventListener('hashchange', () => {
  parseHash();
  renderAll();
});

/* ── 派生数据 ─────────────────────────────────── */

function counts() {
  const c = { all: S.items.length, dead: 0, susp: 0, unchecked: 0, pending: 0, inbox: 0 };
  for (const it of S.items) {
    if (!it.code) c.inbox += 1;
    const h = S.health[it.id];
    if (!h) c.unchecked += 1;
    else if (PROBLEM.has(h.status)) c.dead += 1;
    else if (SUSPECT.has(h.status)) c.susp += 1;
    if (S.pending[it.id]) c.pending += 1;
  }
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
  if (v.kind === 'dead') rows = rows.filter((it) => PROBLEM.has((S.health[it.id] || {}).status));
  if (v.kind === 'susp') rows = rows.filter((it) => SUSPECT.has((S.health[it.id] || {}).status));
  if (v.kind === 'pending') rows = rows.filter((it) => S.pending[it.id]);
  if (v.kind === 'unchecked') rows = rows.filter((it) => !S.health[it.id]);
  if (v.kind === 'inbox') rows = rows.filter((it) => !it.code);
  if (S.q.trim()) {
    const q = S.q.trim().toLowerCase();
    rows = rows.filter((it) =>
      (it.title + ' ' + it.host + ' ' + it.url).toLowerCase().includes(q)
    );
  }
  return rows.slice().sort((a, b) => ((a.added || 0) - (b.added || 0)) * S.sortDir);
}

function viewMeta() {
  const v = S.view;
  if (v.kind === 'all') return { label: '全部收藏', note: '' };
  if (v.kind === 'folder') return { label: `${v.code === 'none' ? '—' : v.code} ${v.code === 'none' ? '待归类' : folderName(v.code)}`, note: '' };
  if (v.kind === 'pending') return { label: '归类建议', note: '这些书签拿到了 AI 建议，逐条确认后才会真的移动。' };
  if (v.kind === 'dead') return { label: '已失效', note: '这些地址已经打不开。删之前可以先导出清单留个底。' };
  if (v.kind === 'susp') return { label: '疑似失效', note: '返回 401 / 403 / 429，多半是反爬或需要登录，别急着删。' };
  if (v.kind === 'unchecked') return { label: '未检测', note: '还没体检过的书签。全选后点「检测」即可。' };
  if (v.kind === 'inbox') return { label: '待归类', note: '收藏时没选分类的都落在这里，包括 Chrome 默认存进「其他书签」的散条目。让模型给建议，或者自己挑一个类目。' };
  return { label: '全部收藏', note: '' };
}

/* ── 顶栏 ─────────────────────────────────────── */

function renderThemeDropdown() {
  const dd = $('#themeDropdown');
  if (!dd) return;
  const current = getTheme();
  dd.innerHTML = `
    <div class="theme-drop-head">典籍配色方案</div>
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
      await setTheme(id);
      renderThemeDropdown();
      const th = THEMES.find((t) => t.id === id);
      toast(`已应用配色：${th ? th.name : id}`);
    });
  });
}

function renderTop() {
  const c = counts();
  const wasFocused = document.activeElement && document.activeElement.id === 'q';
  const caret = wasFocused ? document.activeElement.selectionStart : null;
  $('#topbar').innerHTML = `
    <button class="mobile-menu-btn" id="btnRailToggle" title="切换分类书架">${icon('menu', 16)}</button>
    <div class="brand">${mark(24)}<span class="brand-name">归藏</span><span class="brand-sub">GUIZANG</span></div>
    <label class="search">
      ${icon('search', 14)}
      <input id="q" value="${esc(S.q)}" placeholder="搜标题、域名或地址" spellcheck="false" />
      ${S.q ? `<span class="search-clear" id="qClear" title="清空搜索">${icon('x', 12)}</span>` : '<kbd>⌘K</kbd>'}
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
      <div class="theme-dropdown-wrap">
        <button class="btn btn-ghost btn-md" id="btnTheme" title="切换配色方案" aria-haspopup="true">
          ${icon('palette', 15)}
        </button>
        <div class="theme-dropdown" id="themeDropdown" hidden></div>
      </div>
      <button class="btn btn-ghost btn-md" id="btnOpt" title="设置">${icon('sliders', 15)}</button>
    </div>`;

  $('#btnRailToggle')?.addEventListener('click', () => {
    const rail = $('.rail');
    const overlay = $('#mobileOverlay');
    if (!rail) return;
    const open = rail.classList.toggle('is-mobile-open');
    if (overlay) overlay.hidden = !open;
  });
  $('#mobileOverlay')?.addEventListener('click', () => {
    $('.rail')?.classList.remove('is-mobile-open');
    $('#mobileOverlay').hidden = true;
  });

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
  qInput.addEventListener('input', (e) => {
    S.q = e.target.value;
    renderList();
    renderHead();
    const clearBtn = $('#qClear');
    if (clearBtn && !S.q) renderTop();
  });

  const qClear = $('#qClear');
  if (qClear) {
    qClear.addEventListener('click', () => {
      S.q = '';
      renderTop();
      renderList();
      renderHead();
      $('#q').focus();
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

/* ── 书架 ─────────────────────────────────────── */

function railItem({ code, name, count, bad, active, view, iconName, tone }) {
  const lead = code
    ? `<span class="rail-num">${esc(code)}</span>`
    : `<span class="rail-icon tone-${tone || 'ink'}">${icon(iconName, 13)}</span>`;
  return `<button class="rail-item${active ? ' is-active' : ''}" data-view="${view}">
    ${lead}
    <span class="rail-name">${esc(name)}</span>
    <span class="rail-count${tone === 'dead' && count ? ' tone-dead' : ''}">${count}</span>
    ${bad ? `<span class="rail-bad">${bad}</span>` : ''}
  </button>`;
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
  parts.push('<div class="section-label">智能视图</div>');
  parts.push(railItem({ name: '待归类', count: c.inbox, view: 'inbox', iconName: 'inbox', tone: 'brand', active: S.view.kind === 'inbox' }));
  parts.push(railItem({ name: '归类建议', count: c.pending, view: 'pending', iconName: 'sparkle', tone: 'brand', active: S.view.kind === 'pending' }));
  parts.push(railItem({ name: '整理计划', count: S.plan ? S.plan.ops.length : 0, view: '__organize', iconName: 'folder', tone: 'ink', active: S.drawer === 'organize' }));
  parts.push(railItem({ name: '已失效', count: c.dead, view: 'dead', iconName: 'alert', tone: 'dead', active: S.view.kind === 'dead' }));
  parts.push(railItem({ name: '疑似失效', count: c.susp, view: 'susp', iconName: 'clock', tone: 'warn', active: S.view.kind === 'susp' }));
  parts.push(railItem({ name: '未检测', count: c.unchecked, view: 'unchecked', iconName: 'plus', tone: 'ink', active: S.view.kind === 'unchecked' }));

  if (S.scheme.length) parts.push('<div class="section-label">分类<span class="section-aside">编号</span></div>');
  for (const f of S.scheme) {
    // 空类目也要列出来：装了方案却看不见目录，会以为没装上
    parts.push(railItem({
      code: f.code, name: f.name, count: byCode[f.code] || 0,
      bad: badByCode[f.code] || 0, view: f.code,
      active: S.view.kind === 'folder' && S.view.code === f.code,
    }));
  }

  $('#rail').innerHTML = parts.join('');
  $('#rail').querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (v === '__organize') {
        openOrganize();
        return;
      }
      S.view = v === 'all' ? { kind: 'all' }
        : ['pending', 'dead', 'susp', 'unchecked', 'inbox'].includes(v) ? { kind: v }
        : { kind: 'folder', code: v };
      S.selected = null;
      S.drawer = null;
      // 移动端点选后自动关闭抽屉
      $('.rail')?.classList.remove('is-mobile-open');
      const overlay = $('#mobileOverlay');
      if (overlay) overlay.hidden = true;
      renderAll();
    });
  });

  const last = newestCheck();
  $('#railFoot').innerHTML = `
    <div class="rail-foot-row"><span class="dot-idle"></span>${last ? '上次检测 ' + relTime(last) : '还没有检测过'}</div>
    <button class="rail-foot-link" id="btnScanAll">${icon('pulse', 12)} 检测当前视图全部</button>
    <button class="rail-foot-link" id="btnShortcutsHelp" style="color:var(--ink-3);margin-top:2px;">${icon('window', 12)} 快捷键速查 <kbd>?</kbd></button>`;
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

/* ── 列表头 ───────────────────────────────────── */

function renderHead() {
  const rows = visible();
  const meta = viewMeta();
  $('#listHead').innerHTML = `
    <div class="list-head">
    <div class="crumbs">
      <span class="crumb-dim">书库</span>
      ${icon('chevron', 10, 1.4)}
      <span class="crumb-now">${esc(meta.label)}</span>
      <span class="crumb-count tnum">${rows.length}</span>
    </div>
    <div class="list-tools">
      ${S.view.kind === 'inbox' && rows.length ? `<button class="btn btn-primary btn-sm" id="btnClassifyInbox">${icon('sparkle', 13)}<span>AI 归类这 ${rows.length} 条</span></button>` : ''}
      ${S.view.kind === 'dead' ? `<button class="btn btn-line btn-sm" id="btnExport">${icon('external', 13)}<span>导出清单</span></button>` : ''}
      <button class="btn btn-ghost btn-sm${S.sortDir === 1 ? ' is-on' : ''}" id="btnSort"
        aria-pressed="${S.sortDir === 1}"
        title="${S.sortDir === -1 ? '添加时间：新→旧，点击切为旧→新' : '添加时间：旧→新，点击切为新→旧'}">${icon('sort', 15)}</button>
    </div>
    </div>
    ${meta.note ? `<p class="list-note">${esc(meta.note)}</p>` : ''}`;

  const exp = $('#btnExport');
  if (exp) exp.addEventListener('click', exportDead);

  const inboxAi = $('#btnClassifyInbox');
  if (inboxAi) {
    inboxAi.addEventListener('click', () => {
      S.drawer = 'ai';
      renderInspector();
      renderTop();
      runAi(rows.map((r) => r.id));
    });
  }
  const sort = $('#btnSort');
  if (sort) {
    sort.addEventListener('click', () => {
      S.sortDir = S.sortDir === -1 ? 1 : -1;
      renderHead();
      renderList();
    });
  }
}

/* ── 列表行 ───────────────────────────────────── */

function rowHtml(it) {
  const h = S.health[it.id];
  const pend = S.pending[it.id];
  const dead = PROBLEM.has((h || {}).status);
  const active = S.selected === it.id;
  const checked = S.sel.has(it.id);
  const moved = h && h.status === 'moved' && h.finalUrl;

  return `<div class="row${active ? ' row-active' : ''}" data-id="${esc(it.id)}" tabindex="0">
    <span class="cb${checked ? ' cb-on' : ''}" data-check="${esc(it.id)}" role="checkbox" tabindex="0"
      aria-checked="${checked}">${checked ? icon('check', 10, 2.2) : ''}</span>
    ${faviconMark(it.host, dead)}
    <div class="row-main">
      <div class="row-title">${esc(it.title)}</div>
      <div class="row-meta"><span class="host">${esc(it.host)}</span></div>
    </div>
    ${pend ? `<span class="row-suggest" title="AI 建议归入 ${esc(pend.code)} ${esc(folderName(pend.code))}">${icon('arrowRight', 11)}<span class="tnum">${esc(pend.code)}</span></span>` : '<span class="row-suggest is-empty"></span>'}
    ${moved ? `<span class="st st-warn" title="已跳转至新地址，可在详情中更新"><span class="st-dot"></span><span class="st-code">301</span></span>` : statusMark(h)}
    <time class="row-date tnum">${fmtDate(it.added)}</time>
    <div class="row-actions">
      <button class="act-btn" data-quick-open="${esc(it.id)}" title="在新标签打开">${icon('external', 12)}<span>打开</span></button>
      <button class="act-btn" data-quick-move="${esc(it.id)}" title="移动分类">${icon('folder', 12)}<span>移动</span></button>
      <button class="act-btn" data-quick-check="${esc(it.id)}" title="单条重测">${icon('pulse', 12)}<span>重测</span></button>
      <button class="act-btn" data-quick-del="${esc(it.id)}" title="删除">${icon('trash', 12)}</button>
    </div>
  </div>`;
}

function renderList() {
  const rows = visible();
  const list = $('#list');

  if (!S.items.length) {
    list.innerHTML = `<div class="empty"><div class="empty-rule"></div>
      <div class="empty-title">这里还没有书签</div>
      <div class="empty-hint">先在 Chrome 里存几条，或者用扩展弹窗把当前页收进来。</div></div>`;
    return;
  }

  const shown = rows.slice(0, S.renderLimit || 400);

  if (!shown.length) {
    if (S.q.trim()) {
      list.innerHTML = `<div class="empty">
        <div class="empty-mark">${icon('search', 22)}</div>
        <div class="empty-title">未寻得与「${esc(S.q)}」相符之藏卷</div>
        <div class="empty-hint">试换关键词、域名，或按 <kbd>Esc</kbd> 清空检索。</div>
      </div>`;
    } else if (S.view.kind === 'dead') {
      list.innerHTML = `<div class="empty">
        <div class="empty-mark tone-ok">${icon('check', 22)}</div>
        <div class="empty-title">卷目完好，未见湮灭链接</div>
        <div class="empty-hint">当前没有检测到失效书签。可点击左下角重新核验。</div>
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
        <div class="empty-hint">可使用顶栏搜寻，或在详情抽屉中将其他条目移入此分卷。</div>
      </div>`;
    }
    return;
  }
  let body = '';
  const flat = S.view.kind === 'folder' || S.view.kind === 'dead' || S.view.kind === 'susp' || S.q.trim();

  if (flat) {
    body = shown.map(rowHtml).join('');
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
      </div>` + g.rows.map(rowHtml).join('');
    }).join('');
  }

  const allChecked = shown.length > 0 && shown.every((it) => S.sel.has(it.id));
  const colHead = `<div class="col-head">
    <span><span class="cb${allChecked ? ' cb-on' : ''}" id="cbAll" role="checkbox" tabindex="0" aria-checked="${allChecked}">${allChecked ? icon('check', 10, 2.2) : ''}</span></span>
    <span></span><span>书签</span><span class="col-c1">建议</span><span class="col-c2">状态</span><span class="col-c3">添加</span>
  </div>`;

  const tail = rows.length > shown.length
    ? `<div class="load-more-bar">
        <button class="btn btn-line btn-md" id="btnLoadMore">${icon('plus', 13)}<span>加载下 200 条（已显示 ${shown.length}/${rows.length}）</span></button>
        <button class="btn btn-ghost btn-sm" id="btnLoadAll">加载全部</button>
      </div>`
    : '<div class="list-tail"></div>';

  list.innerHTML = colHead + (shown.length ? body : `<div class="empty"><div class="empty-rule"></div>
    <div class="empty-title">这一栏是空的</div>
    <div class="empty-hint">换个分类，或者把搜索词清掉。</div></div>`) + tail;

  const btnMore = $('#btnLoadMore');
  if (btnMore) btnMore.addEventListener('click', () => { S.renderLimit += 200; renderList(); });
  const btnAll = $('#btnLoadAll');
  if (btnAll) btnAll.addEventListener('click', () => { S.renderLimit = rows.length; renderList(); });

  const cbAll = $('#cbAll');
  if (cbAll) {
    const toggleAll = () => {
      if (allChecked) shown.forEach((it) => S.sel.delete(it.id));
      else shown.forEach((it) => S.sel.add(it.id));
      renderList();
      renderSelBar();
    };
    cbAll.addEventListener('click', toggleAll);
    cbAll.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleAll(); }
    });
  }

  // Checkbox 选择（含 Shift 范围连选）
  // 图标加载完成才显示；加载不到就退回首字母
  list.querySelectorAll('img.row-favicon').forEach((img) => {
    img.addEventListener('error', () => img.remove());
    if (img.complete && img.naturalWidth > 0) img.style.opacity = '1';
    else img.addEventListener('load', () => { img.style.opacity = '1'; });
  });

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
          renderList();
          renderSelBar();
          return;
        }
      }

      S.lastCheckedId = id;
      if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      renderList();
      renderSelBar();
    };

    el.addEventListener('click', handleCheck);
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleCheck(e);
      }
    });
  });

  // 单行快捷操作按钮
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
        const oldParentId = it.parentId || '1';
        const r = await send('bookmarks:moveCode', { ids: [it.id], code }).catch((err) => ({ error: err.message }));
        if (r.error) return toast(r.error);
        await load();
        toast(`已移动到 ${code} ${folderName(code)}`, {
          actionText: '撤销',
          onAction: async () => {
            await send('bookmarks:restore', { items: [{ type: 'move', id: it.id, oldParentId }] });
            await load();
            toast('已撤销移动');
          },
        });
      });
    });
  });

  list.querySelectorAll('[data-quick-check]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.quickCheck;
      await send('health:run', { ids: [id] }).catch((err) => toast(err.message));
    });
  });

  list.querySelectorAll('[data-quick-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const it = S.items.find((x) => x.id === btn.dataset.quickDel);
      if (!it) return;
      const snapshot = { ...it };
      await send('bookmarks:remove', { ids: [it.id] });
      if (S.selected === it.id) { S.selected = null; S.drawer = null; }
      await load();
      toast(`已删除「${snapshot.title}」`, {
        actionText: '撤销',
        onAction: async () => {
          await send('bookmarks:restore', { items: [{ type: 'delete', ...snapshot }] });
          await load();
          toast('已撤销删除');
        },
      });
    });
  });

  // 点击行打开详情
  list.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('click', () => {
      S.selected = el.dataset.id;
      S.drawer = 'detail';
      S.editing = null;
      renderList();
      renderInspector();
    });
    el.addEventListener('dblclick', async () => {
      const it = S.items.find((x) => x.id === el.dataset.id);
      if (it) chrome.tabs.create({ url: it.url });
    });
  });

  renderSelBar();
}

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
    <button class="btn btn-ghost btn-sm" data-act="ai">${icon('sparkle', 13)}<span>归类</span></button>
    <button class="btn btn-ghost btn-sm" data-act="check">${icon('pulse', 13)}<span>检测</span></button>
    <span class="v-rule"></span>
    <button class="btn btn-ghost btn-sm" data-act="del">${icon('trash', 13)}<span>删除</span></button>
    <button class="selbar-x" data-act="none" title="取消选择">${icon('x', 12)}</button>`;
  $('.list-pane').appendChild(bar);

  const selAllTotal = bar.querySelector('#btnSelAllTotal');
  if (selAllTotal) {
    selAllTotal.addEventListener('click', () => {
      rows.forEach((r) => S.sel.add(r.id));
      renderList();
      renderSelBar();
    });
  }

  const invertBtn = bar.querySelector('#btnInvertSel');
  if (invertBtn) {
    invertBtn.addEventListener('click', () => {
      rows.forEach((r) => {
        if (S.sel.has(r.id)) S.sel.delete(r.id);
        else S.sel.add(r.id);
      });
      renderList();
      renderSelBar();
    });
  }

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const ids = [...S.sel];
    if (act === 'none') { S.sel.clear(); renderList(); return; }
    if (act === 'move') {
      pickFolder(ids.length + ' 条书签', '移动到这个分类', async (code) => {
        const snapshots = ids.map((id) => {
          const it = S.items.find((x) => x.id === id);
          return { id, oldParentId: it ? it.parentId || '1' : '1' };
        });
        const r = await send('bookmarks:moveCode', { ids, code }).catch((err) => ({ error: err.message }));
        if (r.error) return toast(r.error);
        S.sel.clear();
        await load();
        toast(`已移动 ${r.moved} 条到 ${code} ${folderName(code)}`, {
          actionText: '撤销',
          onAction: async () => {
            await send('bookmarks:restore', { items: snapshots.map((s) => ({ type: 'move', ...s })) });
            await load();
            toast('已撤销移动');
          },
        });
      });
      return;
    }
    if (act === 'check') {
      const limit = S.settings.checkLimit || 60;
      const batch = ids.slice(0, limit);
      await send('health:run', { ids: batch }).catch((err) => toast(err.message));
      // 后台还有一道同样的上限，会静默截断——这里必须说明实际测了多少
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
      const itemsToDel = ids.map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
      const r = await send('bookmarks:remove', { ids }).catch((err) => ({ error: err.message }));
      if (r.error) return toast(r.error);
      S.sel.clear();
      await load();
      toast(`已删除 ${r.removed} 条书签`, {
        actionText: '撤销',
        onAction: async () => {
          await send('bookmarks:restore', { items: itemsToDel.map((it) => ({ type: 'delete', ...it })) });
          await load();
          toast('已撤销批量删除');
        },
      });
    }
  });
}

/* ── 检测 ─────────────────────────────────────── */

async function scanView() {
  const rows = visible();
  if (!rows.length) return toast('当前视图没有可检测的书签');
  const limit = S.settings.checkLimit || 60;
  // 同一视图连点要能接力：先把没检测过的跑完，全都测过了才回头复检
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
  if (!S.drawer) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;

  if (S.drawer === 'ai') {
    box.innerHTML = aiPanel();
    wireAi();
    return;
  }
  if (S.drawer === 'organize') {
    box.innerHTML = organizePanel();
    wireOrganize();
    return;
  }
  const it = S.items.find((x) => x.id === S.selected);
  if (!it) { box.hidden = true; S.drawer = null; return; }
  box.innerHTML = detailPanel(it);
  wireDetail(it);
}

function openOrganize() {
  S.drawer = 'organize';
  S.selected = null;
  renderInspector();
  renderRail();
}

function organizePanel() {
  const plan = S.plan;
  const busy = S.planBusy;

  const head = `<div class="insp-head">
      <div class="insp-head-bar">
        <div class="insp-kicker">${icon('folder', 12)} 整理计划</div>
        <div class="insp-head-tools">
          <button class="ibtn" data-close title="收起">${icon('x', 13)}</button>
        </div>
      </div>
      <h2 class="insp-title">${busy ? '正在生成' : plan ? plan.ops.length + ' 条待整理' : '还没有计划'}</h2>
      <p class="insp-sub">按已安装的方案把待归类书签归位。生成计划只读，不会移动任何书签。</p>
    </div>`;

  if (busy) {
    const pr = S.planProgress || { stage: 'preselect', done: 0, total: 0 };
    const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 6;
    return head + `<div class="insp-body">
      <div class="plan-busy">
        <div class="plan-busy-line">${pr.stage === 'model' ? '模型正在判断' : '正在预筛'} ${pr.done}/${pr.total || '…'}</div>
        <div class="scan-track" style="background:rgba(34,73,110,.14)"><div class="scan-fill" style="width:${pct}%"></div></div>
      </div>
    </div>`;
  }

  if (!plan) {
    const ready = S.scheme.length > 0;
    return head + `<div class="insp-body">
      <div class="plan-empty">
        <div class="plan-empty-line">当前方案：${ready ? `${S.scheme.length} 个类目` : '还没有可用的分类目录'}</div>
        <div class="plan-empty-hint">${ready
          ? '生成后会按类目列出「该挪去哪」，你可以逐条剔除或改判；执行在下一步接入。'
          : '先到设置页装一套方案（杜威、中图法等），再回来生成计划。'}</div>
        <button class="btn btn-primary btn-md" data-gen ${ready ? '' : 'disabled'}>生成整理计划</button>
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
      ${g.ops.map(planRow).join('')}
    </div>`).join('');

  const s = plan.stats;
  return head + `
    <div class="insp-body">
      <div class="plan-stats">
        <span>可移 <b>${s.ready}</b></span>
        <span>拿不准 <b>${s.unsure}</b></span>
        <span>跳过 <b>${s.skip}</b></span>
        ${s.blocked ? `<span class="tone-dead">动不了 <b>${s.blocked}</b></span>` : ''}
      </div>
      ${groups || '<div class="plan-empty-hint">计划是空的：没有需要移动的书签。</div>'}
    </div>
    <div class="insp-foot plan-foot">
      <div class="plan-foot-line">生成于 ${relTime(plan.at)}${plan.overflow ? ` · 还有 ${plan.overflow} 条没纳入` : ''}</div>
      <div class="plan-foot-actions">
        <button class="btn btn-line btn-sm" data-gen>重新生成</button>
        <button class="btn btn-ghost btn-sm" data-clear>清空</button>
      </div>
    </div>`;
}

function planRow(op) {
  const tone = op.status === 'ready' ? '' : op.status === 'unsure' ? ' tone-warn' : op.status === 'blocked' ? ' tone-dead' : ' tone-ink';
  const tag = op.status === 'ready' ? `→ ${esc(op.to.code)} ${esc(op.to.name)}`
    : op.status === 'unsure' ? '拿不准'
    : op.status === 'blocked' ? '动不了'
    : '跳过';
  const pickable = op.status === 'ready' || op.status === 'unsure';
  return `<div class="plan-row">
    <div class="plan-main">
      <div class="plan-title" title="${esc(op.title)}">${esc(op.title)}</div>
      <div class="plan-sub">
        <span class="plan-tag${tone}">${tag}</span>
        ${op.reason ? `<span class="plan-why" title="${esc(op.reason)}">${esc(op.reason)}</span>` : ''}
      </div>
    </div>
    ${pickable ? `<select class="plan-pick" data-pick="${esc(op.id)}" title="改判到哪个类目">
      ${S.scheme.map((f) => `<option value="${esc(f.code)}"${op.to && op.to.code === f.code ? ' selected' : ''}>${esc(f.code)} ${esc(f.name)}</option>`).join('')}
    </select>` : ''}
    <button class="ibtn plan-drop" data-drop="${esc(op.id)}" title="从计划里剔除">${icon('x', 11)}</button>
  </div>`;
}

function wireOrganize() {
  const box = $('#inspector');
  box.querySelector('[data-close]')?.addEventListener('click', () => {
    S.drawer = null;
    renderInspector();
    renderRail();
  });

  const gen = box.querySelector('[data-gen]');
  if (gen) {
    gen.addEventListener('click', async () => {
      S.planBusy = true;
      S.planProgress = { stage: 'preselect', done: 0, total: 0 };
      renderInspector();
      await send('organize:plan', { scope: 'inbox' }).catch((err) => {
        S.planBusy = false;
        toast(err.message);
        renderInspector();
      });
    });
  }

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

  box.querySelectorAll('[data-pick]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const plan = await send('organize:override', { id: sel.dataset.pick, code: sel.value }).catch(() => null);
      if (plan) { S.plan = plan; renderInspector(); renderRail(); }
    });
  });
}

function aiPanel() {
  const pend = Object.entries(S.pending)
    .map(([id, p]) => ({ id, ...p, item: S.items.find((x) => x.id === id) }))
    .filter((x) => x.item)
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  const doneRows = S.done.map((d) => `<div class="sg sg-done"><div class="sg-done-line">
      <span class="sg-done-mark">${icon('check', 11, 2)}</span>
      <span>已归入 <b class="tnum">${esc(d.code)}</b> ${esc(d.name)}</span>
    </div></div>`).join('');

  const busy = S.aiBusy
    ? `<div class="sg"><div class="sg-why">正在生成建议 ${S.aiProgress ? `${S.aiProgress.done}/${S.aiProgress.total}` : '…'}</div>
       <div class="scan-track" style="margin-top:8px;background:rgba(34,73,110,.14)">
       <div class="scan-fill" style="width:${S.aiProgress ? Math.round(S.aiProgress.done / S.aiProgress.total * 100) : 8}%"></div></div></div>`
    : '';

  const body = busy + doneRows + pend.map((p) => suggestionCard(p)).join('');

  return `<div class="insp-head">
      <div class="insp-head-bar">
        <div class="insp-kicker">${icon('sparkle', 12)} 归类建议</div>
        <div class="insp-head-tools">
          <button class="ibtn" data-close title="收起">${icon('x', 13)}</button>
        </div>
      </div>
      <h2 class="insp-title">${pend.length ? `${pend.length} 条待确认` : (S.aiBusy ? '正在判断' : '没有待确认的建议')}</h2>
      <p class="insp-sub">模型读标题与域名，按你现有的编号目录判断；确认之后才会真的移动。</p>
    </div>
    <div class="insp-body">
      ${body || `<div class="empty" style="padding:22px 14px">
        <div class="empty-hint">${S.aiReady ? '给当前视图的 ' + visible().length + ' 条生成建议，先看看它怎么判。' : '还没配置模型。可以在设置里填 API Key，或者先用本地关键词规则试跑。'}</div>
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
      <span class="sg-conf${unsure ? ' is-unsure' : ''}" title="${unsure ? '模型对这个判断不太确定' : '模型置信度'}">
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
  box.querySelector('[data-close]').addEventListener('click', () => {
    S.drawer = null; S.picking = null; renderInspector(); renderTop();
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
      const id = el.dataset.locate;
      const target = $(`[data-id="${id}"]`);
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
  snapshot.slice(0, 12).forEach((s) => S.done.unshift({ ...s, name: folderName(s.code) }));
  S.done = S.done.slice(0, 6);
  S.picking = null;
  await load();
  toast(`已归入 ${r.moved} 条`);
}

async function ignoreIds(ids) {
  await send('ai:ignore', { ids }).catch((err) => toast(err.message));
  S.picking = null;
  await load();
}

async function overrideSuggestion(id, code) {
  await send('ai:ignore', { ids: [id] }).catch(() => {});
  const r = await send('bookmarks:moveCode', { ids: [id], code }).catch((err) => ({ error: err.message }));
  if (r.error) return toast(r.error);
  S.done.unshift({ code, name: folderName(code), title: '' });
  S.done = S.done.slice(0, 6);
  S.picking = null;
  await load();
  toast(`已按你的判断归入 ${code} ${folderName(code)}`);
}

async function runAi(ids) {
  if (S.aiBusy) return;
  const scope = ids.slice(0, 80);
  if (!scope.length) return toast('当前视图没有可归类的书签');
  S.aiBusy = true;
  S.aiProgress = { done: 0, total: scope.length };
  renderInspector();
  try {
    await send('ai:run', { ids: scope });
    await load();
    toast(`${S.aiReady ? '模型' : '本地规则'}给出了 ${Object.keys(S.pending).length} 条建议`);
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

/* 网址没有空格，浏览器只能硬切；在路径分隔符后插 <wbr> 让它断得好看些。
   复制走的是 it.url 原值，不受影响。 */
function breakableUrl(url) {
  return String(url)
    .split(/([\/?#&=_-])/)
    .map((seg, i) => (i % 2 ? esc(seg) + '<wbr>' : esc(seg)))
    .join('');
}

function detailPanel(it) {
  const h = S.health[it.id];
  const tone = h ? (TONE[h.status] || TONE.invalid) : null;
  const cls = h ? (PROBLEM.has(h.status) ? ' is-dead' : SUSPECT.has(h.status) ? ' is-warn' : (h.status === 'ok' ? ' is-ok' : '')) : '';
  const isEditing = S.editing && S.editing.id === it.id;

  return `<div class="insp-head">
      <div class="insp-head-bar">
        <div class="insp-kicker">${icon('folder', 12)} 收藏详情</div>
        <div class="insp-head-tools">
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
        <div class="url-box" title="点击复制网址">
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
  box.querySelector('[data-close]').addEventListener('click', () => {
    S.drawer = null; S.editing = null; renderInspector();
  });

  // 编辑标题与URL
  const editBtn = box.querySelector('#btnEditItem');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      S.editing = { id: it.id, title: it.title, url: it.url };
      renderInspector();
    });
  }
  const editCancel = box.querySelector('#btnEditCancel');
  if (editCancel) {
    editCancel.addEventListener('click', () => {
      S.editing = null;
      renderInspector();
    });
  }
  const editSave = box.querySelector('#btnEditSave');
  if (editSave) {
    editSave.addEventListener('click', async () => {
      const newTitle = $('#editTitleInput').value.trim();
      const newUrl = $('#editUrlInput').value.trim();
      if (!newUrl) return toast('网址不能为空');
      const oldTitle = it.title;
      const oldUrl = it.url;
      try {
        await send('bookmarks:update', { id: it.id, title: newTitle, url: newUrl });
        it.title = newTitle;
        it.url = newUrl;
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
  }

  // 301 重定向顺手一键更新
  const applyFinalUrl = box.querySelector('#btnApplyFinalUrl');
  if (applyFinalUrl && it && S.health[it.id] && S.health[it.id].finalUrl) {
    applyFinalUrl.addEventListener('click', async () => {
      const finalUrl = S.health[it.id].finalUrl;
      const oldUrl = it.url;
      try {
        await send('bookmarks:update', { id: it.id, url: finalUrl });
        await load();
        // 新地址还没验过，顺手跑一次单条检测
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
  if (urlBox) {
    urlBox.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(it.url);
        toast('已复制网址到剪贴板');
      } catch (e) {
        toast('复制失败: ' + e.message);
      }
    });
  }

  box.querySelector('[data-open]').addEventListener('click', () => chrome.tabs.create({ url: it.url }));
  box.querySelector('[data-move]').addEventListener('click', () => {
    pickFolder(it.title, '移动到这个分类', async (code) => {
      const oldParentId = it.parentId || '1';
      const r = await send('bookmarks:moveCode', { ids: [it.id], code }).catch((err) => ({ error: err.message }));
      if (r.error) return toast(r.error);
      await load();
      toast(`已移到 ${code} ${folderName(code)}`, {
        actionText: '撤销',
        onAction: async () => {
          await send('bookmarks:restore', { items: [{ type: 'move', id: it.id, oldParentId }] });
          await load();
          toast('已撤销移动');
        },
      });
    });
  });
  box.querySelector('[data-check]').addEventListener('click', async () => {
    await send('health:run', { ids: [it.id] }).catch((err) => toast(err.message));
  });

  // 非阻塞删除 + 撤销
  box.querySelector('[data-del]').addEventListener('click', async () => {
    const snapshot = { ...it };
    await send('bookmarks:remove', { ids: [it.id] });
    S.selected = null; S.drawer = null; S.editing = null;
    await load();
    toast(`已删除「${snapshot.title}」`, {
      actionText: '撤销',
      onAction: async () => {
        await send('bookmarks:restore', { items: [{ type: 'delete', ...snapshot }] });
        await load();
        toast('已撤销删除');
      },
    });
  });

  const ai = box.querySelector('[data-ai]');
  if (ai) ai.addEventListener('click', () => { S.drawer = 'ai'; renderInspector(); runAi([it.id]); });
}

/* ── 分类选择弹层 ─────────────────────────────── */

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
      <div class="sheet-sub">全键盘流高效整理与检索</div>
    </div>
    <div class="sheet-body shortcuts-sheet">
      <div class="sc-row"><span>聚焦搜索框</span><div><kbd>/</kbd> 或 <kbd>⌘ K</kbd></div></div>
      <div class="sc-row"><span>上 / 下切换选择行</span><div><kbd>↑</kbd> / <kbd>↓</kbd></div></div>
      <div class="sc-row"><span>勾选 / 取消勾选当前项</span><div><kbd>Space</kbd></div></div>
      <div class="sc-row"><span>连续范围多选</span><div><kbd>Shift + Click</kbd></div></div>
      <div class="sc-row"><span>在新标签页打开</span><div><kbd>Enter</kbd></div></div>
      <div class="sc-row"><span>展开 / 收起详情抽屉</span><div><kbd>I</kbd></div></div>
      <div class="sc-row"><span>移动当前项或选中项</span><div><kbd>M</kbd></div></div>
      <div class="sc-row"><span>单条或批量重测健康</span><div><kbd>R</kbd></div></div>
      <div class="sc-row"><span>删除当前项或选中项</span><div><kbd>Delete</kbd> 或 <kbd>Backspace</kbd></div></div>
      <div class="sc-row"><span>撤销上一步操作</span><div><kbd>⌘ Z</kbd></div></div>
      <div class="sc-row"><span>关闭抽屉 / 弹窗 / 清空搜索</span><div><kbd>Esc</kbd></div></div>
      <div class="sc-row"><span>快捷键速查</span><div><kbd>?</kbd></div></div>
    </div>`;
  $('#modal').hidden = false;
  $('#btnCloseShortcuts')?.addEventListener('click', () => { $('#modal').hidden = true; });
}

$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') $('#modal').hidden = true;
});

/* ── 导出失效清单 ─────────────────────────────── */

function exportDead() {
  const rows = visible().map((it) => {
    const h = S.health[it.id] || {};
    return [it.title, it.url, h.status || '', h.code || '', fmtDate(it.added)].join('\t');
  });
  const text = '标题\t地址\t状态\t代码\t添加\n' + rows.join('\n');
  const blob = new Blob([text], { type: 'text/tab-separated-values;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'guizang-dead-links.tsv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast(`已导出 ${rows.length} 条`);
}

/* ── 组装与事件 ───────────────────────────────── */

function renderAll() {
  renderTop();
  renderRail();
  renderHead();
  renderList();
  renderInspector();
  renderScan();
}

/* 页面读的是磁盘上的新代码，service worker 可能还是旧脚本。
   不握手的话，用户只会看到“没有回应”这种没头没尾的提示。 */
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
  // 放在应用层级：窄屏时详情栏是浮层，挂在列表里会被它盖住
  const app = document.querySelector('.app');
  const body = document.querySelector('.manager-body');
  if (!app || !body) return;
  app.insertBefore(bar, body);
  // 窄屏时详情栏是 fixed 浮层，要让它从横幅下方开始
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
  S.settings = st.settings || {};
  S.aiReady = st.aiReady;
  S.scan = st.scan || { running: false, done: 0, total: 0 };
  const org = await send('organize:load').catch(() => null);
  if (org) {
    S.plan = org.plan || null;
    S.planBusy = Boolean(org.running);
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

// 键盘全套导航（⌘K搜索、上下移动高亮行、空格勾选、回车打开、删除撤销）
document.addEventListener('keydown', async (e) => {
  const isInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const q = $('#q');
    if (q) q.focus();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (triggerUndo()) {
      e.preventDefault();
      return;
    }
  }

  if (e.key === 'Escape') {
    if (!$('#modal').hidden) { $('#modal').hidden = true; return; }
    if (isInput && document.activeElement.id === 'q') {
      if (S.q) {
        S.q = '';
        renderTop();
        renderList();
        renderHead();
      }
      document.activeElement.blur();
      return;
    }
    if (S.editing) {
      S.editing = null;
      renderInspector();
      return;
    }
    if (S.drawer) {
      S.drawer = null;
      S.editing = null;
      renderInspector();
      renderTop();
      return;
    }
  }

  if (isInput) return;

  if (e.key === '/') {
    e.preventDefault();
    const q = $('#q');
    if (q) q.focus();
    return;
  }

  if (e.key === '?') {
    e.preventDefault();
    openShortcutsModal();
    return;
  }

  if (e.key.toLowerCase() === 'i') {
    e.preventDefault();
    if (S.drawer === 'detail') {
      S.drawer = null;
      S.editing = null;
    } else if (S.selected) {
      S.drawer = 'detail';
    }
    renderInspector();
    renderTop();
    return;
  }

  if (e.key.toLowerCase() === 'm') {
    e.preventDefault();
    const targetIds = S.sel.size ? [...S.sel] : (S.selected ? [S.selected] : []);
    if (!targetIds.length) return;
    const title = targetIds.length === 1 ? (S.items.find((x) => x.id === targetIds[0])?.title || '') : `${targetIds.length} 条选中的书签`;
    pickFolder(title, '移动到分类', async (code) => {
      const moves = targetIds.map((id) => ({
        type: 'move',
        id,
        oldParentId: S.items.find((x) => x.id === id)?.parentId || '1',
      }));
      const r = await send('bookmarks:moveCode', { ids: targetIds, code }).catch((err) => ({ error: err.message }));
      if (r.error) return toast(r.error);
      S.sel.clear();
      await load();
      toast(`已移到 ${code} ${folderName(code)}`, {
        actionText: '撤销',
        onAction: async () => {
          await send('bookmarks:restore', { items: moves });
          await load();
          toast('已撤销移动');
        },
      });
    });
    return;
  }

  if (e.key.toLowerCase() === 'r') {
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
    if (e.key === 'ArrowDown') {
      curIdx = curIdx < shown.length - 1 ? curIdx + 1 : 0;
    } else {
      curIdx = curIdx > 0 ? curIdx - 1 : shown.length - 1;
    }
    S.selected = shown[curIdx].id;
    if (S.drawer === 'detail') renderInspector();
    renderList();
    const targetEl = $(`[data-id="${S.selected}"]`);
    if (targetEl) targetEl.scrollIntoView({ block: 'nearest' });
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
      renderList();
      renderSelBar();
    }
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.sel.size) {
      e.preventDefault();
      const ids = [...S.sel];
      const itemsToDel = ids.map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
      await send('bookmarks:remove', { ids });
      S.sel.clear();
      await load();
      toast(`已删除 ${ids.length} 条书签`, {
        actionText: '撤销',
        onAction: async () => {
          await send('bookmarks:restore', { items: itemsToDel.map((it) => ({ type: 'delete', ...it })) });
          await load();
          toast('已撤销批量删除');
        },
      });
    } else if (S.selected) {
      e.preventDefault();
      const it = S.items.find((x) => x.id === S.selected);
      if (it) {
        const snapshot = { ...it };
        await send('bookmarks:remove', { ids: [it.id] });
        S.selected = null; S.drawer = null;
        await load();
        toast(`已删除「${snapshot.title}」`, {
          actionText: '撤销',
          onAction: async () => {
            await send('bookmarks:restore', { items: [{ type: 'delete', ...snapshot }] });
            await load();
            toast('已撤销删除');
          },
        });
      }
    }
  }
});

document.addEventListener('click', (e) => {
  const dd = $('#themeDropdown');
  if (dd && !dd.hidden && !e.target.closest('.theme-dropdown-wrap')) {
    dd.hidden = true;
  }
});

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'theme:changed') {
      const dd = $('#themeDropdown');
      if (dd && !dd.hidden) renderThemeDropdown();
    }
  });
}

parseHash();
load()
  .then(() => checkHealthProtocol())
  .catch((e) => {
    document.body.innerHTML = `<div class="empty" style="padding:60px">
      <div class="empty-rule"></div><div class="empty-title">加载失败</div>
      <div class="empty-hint">${esc(e.message)}</div></div>`;
  });
