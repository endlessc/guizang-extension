/* 侧边栏：浏览时顺手归类，顺便看看哪些已经打不开 */

import {
  $, esc, icon, mark, send, toast, letterOf, faviconMark, statusMark, upsertBookmark,
  onBroadcast, debounce, relTime,
} from './shared.js';

import { ensureEnv } from './env.js';
await ensureEnv();
function appVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (e) {
    return 'dev';
  }
}


const S = {
  summary: null,
  tab: null,
  chosen: null,
  existing: null,
  existingFolder: null,
  suggestion: null,
  thinking: false,
  q: '',
  results: null,
  scan: { running: false, done: 0, total: 0 },
};

const canSave = (url) => /^https?:/i.test(url || '');

/* 没选分类就落进「待归类」 */
function inboxChoice() {
  const id = S.summary && S.summary.inboxId;
  return id ? { code: '', name: '待归类', folderId: id } : null;
}

async function boot() {
  $('#searchIcon').innerHTML = icon('search', 13);
  await reload(true);
  bind();
}

async function reload(initial) {
  const [summary, tabs] = await Promise.all([
    send('summary:load'),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  S.summary = summary;
  S.scan = summary.scan || S.scan;
  const tab = tabs[0] || null;
  const changed = !S.tab || !tab || S.tab.url !== tab.url;
  S.tab = tab;

  if (tab && canSave(tab.url)) {
    const chk = await send('bookmark:check', { url: tab.url }).catch(() => ({ exists: false, items: [] }));
    if (chk && chk.exists && chk.items[0]) {
      S.existing = chk.items[0];
      S.existingFolder = summary.scheme.find((f) => f.id === S.existing.parentId) || null;
    } else {
      S.existing = null;
      S.existingFolder = null;
    }
  } else {
    S.existing = null;
    S.existingFolder = null;
  }

  renderHead();
  renderAlerts();
  renderFoot();
  if (initial || changed) {
    S.chosen = inboxChoice();
    S.suggestion = null;
    renderCurrent();
    if (tab && canSave(tab.url)) suggest();
  } else {
    renderCurrent();
  }
  renderList();
}

async function suggest() {
  try {
    const s = await send('ai:suggestOne', { url: S.tab.url, title: S.tab.title, fast: true });
    S.suggestion = s;
  } catch {
    S.suggestion = null;
  }
  renderCurrent();
}

function renderHead() {
  $('#head').innerHTML = `
    ${mark(20)}
    <span class="sp-brand">归藏</span>
    <span class="sp-version mono">v${appVersion()}</span>
    <span class="sp-head-gap"></span>
    <button class="ibtn" id="optBtn" title="设置">${icon('sliders', 14)}</button>`;
  $('#optBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function renderCurrent() {
  const tab = S.tab;
  const host = $('#currentHost');

  if (!tab || !canSave(tab.url)) {
    host.innerHTML = `<div class="current">
      <div class="current-k">当前标签页</div>
      <div class="current-title" style="color:var(--ink-3);font-weight:400">这个页面不能收藏</div>
      <div class="current-url">chrome:// 与扩展页面不属于可收藏的网址。</div>
    </div>`;
    return;
  }

  const s = S.suggestion;
  host.innerHTML = `<div class="current">
    <div class="current-k">当前标签页</div>
    <div class="current-title">${esc(tab.title || tab.url)}</div>
    <div class="current-url">${esc(tab.url)}</div>
    ${S.existing ? `
      <div class="pp-saved-tag" style="margin-top:6px">
        ${icon('check', 11)}
        <span>已收藏在【${esc(S.existingFolder ? S.existingFolder.code + ' ' + S.existingFolder.name : '书签栏')}】</span>
      </div>
    ` : ''}
    <div class="current-foot">
      <button class="current-sug" id="chipBtn" title="换一个分类">
        ${icon(S.chosen && !S.chosen.code ? 'inbox' : 'sparkle', 11)}
        <span>${S.chosen ? (S.chosen.code ? `<b>${esc(S.chosen.code)}</b> ${esc(S.chosen.name)}` : '待归类') : '选个分类'}</span>
      </button>
      ${S.thinking ? '<span class="sp-alert-go">判断中…</span>' : ''}
      <span style="flex:1"></span>
      <button class="btn btn-primary btn-sm" id="saveBtn" ${S.chosen ? '' : 'disabled'}>
        ${icon(S.existing ? 'folder' : 'plus', 12)}<span>${S.existing ? '更新分类' : '收藏'}</span></button>
    </div>
    ${s && s.code && (!S.chosen || S.chosen.code !== s.code) ? `<button class="pp-sug" id="useSug">
        ${icon('sparkle', 11)}
        <span>建议 <b class="tnum">${esc(s.code)}</b> ${esc((S.summary.scheme.find((x) => x.code === s.code) || {}).name || '')}</span>
        <span class="pp-sug-go">采用</span></button>` : ''}
    ${s && s.reason ? `<div class="pp-note">${esc(s.reason)}</div>` : ''}
    <div id="pickerHost"></div>
  </div>`;

  $('#saveBtn').addEventListener('click', doSave);
  $('#chipBtn').addEventListener('click', () => {
    const box = $('#pickerHost');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="pp-folders" style="position:static;margin-top:8px;max-height:200px">
      <button class="pp-folder${S.chosen && !S.chosen.code ? ' is-on' : ''}" data-inbox="1">
        <span class="tnum">—</span>待归类</button>
      ${S.summary.scheme.map((f) => `<button class="pp-folder" data-code="${esc(f.code)}" data-id="${esc(f.id)}">
        <span class="tnum">${esc(f.code)}</span>${esc(f.name)}</button>`).join('')}
      </div>`;
    box.querySelectorAll('[data-code],[data-inbox]').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.dataset.inbox) {
          S.chosen = inboxChoice();
        } else {
          S.chosen = {
            code: el.dataset.code,
            name: el.querySelector('span').nextSibling.textContent.trim(),
            folderId: el.dataset.id,
          };
        }
        renderCurrent();
      });
    });
  });

  const use = $('#useSug');
  if (use) {
    use.addEventListener('click', () => {
      const f = S.summary.scheme.find((x) => x.code === S.suggestion.code);
      if (f) { S.chosen = { code: f.code, name: f.name, folderId: f.id }; renderCurrent(); }
    });
  }
}

async function doSave() {
  if (!S.chosen || !S.tab) return;
  try {
    const how = await upsertBookmark({
      url: S.tab.url,
      title: S.tab.title || S.tab.url,
      folderId: S.chosen.folderId,
    });
    toast(how === 'moved' ? '已更新已有书签的分类' : '已收藏');
    await reload(false);
    renderList();
  } catch (e) {
    toast(e.message);
  }
}

function renderAlerts() {
  const c = S.summary.counts;
  $('#alerts').innerHTML = `
    <div class="sp-alerts-grid">
      <button class="sp-alert-card" id="toPending" title="查看待定卷并逐条确认">
        <div class="sp-alert-card-head">
          <span class="sp-alert-icon tone-brand">${icon('inbox', 12)}</span>
          <span class="sp-alert-card-k">待定卷</span>
        </div>
        <div class="sp-alert-card-val"><b class="tnum">${c.inbox || 0}</b> <span class="sp-alert-card-unit">卷</span></div>
      </button>
      <button class="sp-alert-card is-dead" id="toDead" title="查看已失效链接">
        <div class="sp-alert-card-head">
          <span class="sp-alert-icon tone-dead">${icon('alert', 12)}</span>
          <span class="sp-alert-card-k">已失效</span>
        </div>
        <div class="sp-alert-card-val"><b class="tnum">${c.dead || 0}</b> <span class="sp-alert-card-unit">卷</span></div>
      </button>
    </div>`;
  $('#toPending').addEventListener('click', () => openManager('view=inbox'));
  $('#toDead').addEventListener('click', () => openManager('view=dead'));
}

function renderList() {
  const box = $('#list');
  const label = $('#listLabel');

  if (S.results) {
    label.innerHTML = `<div class="section-label">搜索<span class="section-aside">${S.results.length} 条</span></div>`;
    box.innerHTML = S.results.length
      ? S.results.map(rowHtml).join('')
      : `<div class="pp-empty" style="padding:12px">没有匹配的书签。</div>`;
  } else {
    label.innerHTML = `<div class="section-label">最近收藏<span class="section-aside">最近</span></div>`;
    box.innerHTML = S.summary.recent.slice(0, 6).map(rowHtml).join('');
  }

  box.querySelectorAll('[data-url]').forEach((el) => {
    el.addEventListener('click', () => chrome.tabs.create({ url: el.dataset.url }));
  });
}

function rowHtml(it) {
  const h = it.health;
  const dead = h && (h.status === 'dead' || h.status === 'timeout' || h.status === 'unreachable');
  return `<div class="row row-narrow" data-url="${esc(it.url)}">
    ${faviconMark(it.host, dead)}
    <div class="row-main">
      <div class="row-title">${esc(it.title)}</div>
      <div class="row-meta"><span class="host">${esc(it.host)}</span></div>
    </div>
    ${statusMark(h)}
  </div>`;
}

function renderFoot() {
  const last = S.summary && S.summary.recent.length
    ? S.summary.recent.reduce((m, it) => Math.max(m, (it.health && it.health.at) || 0), 0)
    : 0;
  const foot = $('#foot');
  if (S.scan.running) {
    const pct = S.scan.total ? Math.round((S.scan.done / S.scan.total) * 100) : 0;
    foot.innerHTML = `
      <div class="sp-foot-line">
        <span class="scan-pulse"></span>
        <span>正在检测 <b class="mono">${S.scan.done}</b>/<span class="mono">${S.scan.total}</span></span>
        <button class="sp-foot-action" id="stopBtn">停止</button>
      </div>
      <div class="scan-track"><div class="scan-fill" style="width:${pct}%"></div></div>`;
    $('#stopBtn').addEventListener('click', async () => {
      await send('health:stop');
    });
    return;
  }
  foot.innerHTML = `<div class="sp-foot-line">
    <span class="dot-idle"></span>
    <span>${last ? '上次检测 ' + relTime(last) : '还没有检测过'}</span>
    <button class="sp-foot-action" id="scanBtn">检测未检测的</button>
  </div>`;
  $('#scanBtn').addEventListener('click', async () => {
    const r = await send('health:runUnchecked').catch((e) => ({ started: false, error: e.message }));
    if (r.error) return toast(r.error);
    if (!r.started) return toast('全都检测过了');
    toast(`开始检测 ${r.total} 条`);
  });
}

async function openManager(hash = '') {
  await send('open:manager', { hash });
}

function bind() {
  $('#q').addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    S.q = q;
    if (!q) {
      S.results = null;
      renderList();
      return;
    }
    const found = await chrome.bookmarks.search(q);
    const codeById = {};
    S.summary.scheme.forEach((f) => { codeById[f.id] = f.code; });
    S.results = found
      .filter((n) => n.url)
      .slice(0, 12)
      .map((n) => ({
        id: n.id,
        title: n.title || n.url,
        url: n.url,
        host: (() => { try { return new URL(n.url).host.replace(/^www\./, ''); } catch { return ''; } })(),
        code: codeById[n.parentId] || '',
        health: null,
      }));
    renderList();
  }, 180));

  chrome.tabs.onActivated.addListener(() => reload(false).catch(() => {}));
  chrome.tabs.onUpdated.addListener((id, info, tab) => {
    if (info.url && tab.active) reload(false).catch(() => {});
  });

  onBroadcast((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'scan:start') {
      S.scan = { running: true, done: 0, total: msg.total };
      renderFoot();
    } else if (msg.type === 'scan:progress') {
      S.scan = { running: true, done: msg.done, total: msg.total };
      renderFoot();
    } else if (msg.type === 'scan:done' || msg.type === 'scan:error') {
      S.scan = { running: false, done: 0, total: 0 };
      reload(false).catch(() => {});
    } else if (msg.type === 'state:changed') {
      reload(false).catch(() => {});
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#q').focus();
    }
  });
}

boot().catch((e) => {
  document.body.innerHTML = `<div class="pp-empty" style="padding:16px">侧边栏起不来：${esc(e.message)}</div>`;
});
