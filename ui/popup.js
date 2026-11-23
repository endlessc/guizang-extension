/* 弹窗：把当前页归进去，顺手看一眼有什么坏了 */

import { $, esc, icon, mark, send, toast, fmtDate, letterOf, faviconMark, wireFavicons, statusMark } from './shared.js';

import { ensureEnv } from './env.js';
await ensureEnv();

const S = {
  summary: null,
  tab: null,
  chosen: null,
  existing: null,
  existingFolder: null,
  suggestion: null,
  thinking: false,
  pickerOpen: false,
  star: false,
  note: '',
};

const canSave = (url) => /^https?:/i.test(url || '');

/* 收藏时没选分类，就落进「待归类」 */
function inboxChoice() {
  const id = S.summary && S.summary.inboxId;
  return id ? { code: '', name: '待归类', folderId: id } : null;
}

async function init() {
  const [summary, tabs] = await Promise.all([
    send('summary:load'),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  S.summary = summary;
  S.tab = tabs[0] || null;
  S.chosen = inboxChoice();

  if (S.tab && canSave(S.tab.url)) {
    const chk = await send('bookmark:check', { url: S.tab.url }).catch(() => ({ exists: false, items: [] }));
    if (chk && chk.exists && chk.items[0]) {
      S.existing = chk.items[0];
      S.existingFolder = summary.scheme.find((f) => f.id === S.existing.parentId) || null;
      const m = (summary.meta && summary.meta[S.existing.id]) || {};
      S.star = Boolean(m.star);
      S.note = m.note || '';
    }
  }

  renderHead();
  renderNow();
  renderAlerts();
  renderRecent();
  renderFoot();

  if (S.tab && canSave(S.tab.url)) suggest();
}

async function suggest() {
  try {
    const s = await send('ai:suggestOne', {
      url: S.tab.url,
      title: S.tab.title,
      fast: true,
    });
    S.suggestion = s;
  } catch (e) {
    S.suggestion = null;
  }
  renderNow();
}

async function askModel() {
  if (S.thinking || !S.tab) return;
  S.thinking = true;
  renderNow();
  try {
    const s = await send('ai:suggestOne', { url: S.tab.url, title: S.tab.title, fast: false });
    S.suggestion = s;
    const match = S.summary.scheme.find((f) => f.code === s.code);
    if (match) S.chosen = { code: match.code, name: match.name, folderId: match.id };
    if (s.error) toast('模型不可用，已退回本地规则');
  } catch (e) {
    toast(e.message);
  } finally {
    S.thinking = false;
    renderNow();
  }
}

function renderHead() {
  $('#head').innerHTML = `
    ${mark(18)}
    <span class="pp-brand">归藏</span>
    <span class="pp-head-gap"></span>
    <button class="ibtn" id="optBtn" title="设置">${icon('sliders', 13)}</button>`;
  $('#optBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function renderNow() {
  const tab = S.tab;
  const box = $('#now');

  if (!tab || !canSave(tab.url)) {
    box.innerHTML = `<div class="current-k">当前标签页</div>
      <div class="pp-now-title">这个页面不能收进书签</div>
      <div class="pp-note">chrome:// 与扩展页面不属于可收藏的网址。切到普通网页再点开我。</div>`;
    return;
  }

  const s = S.suggestion;
  const badge = S.thinking
    ? '模型判断中…'
    : s && s.source === 'model' ? '模型建议' : s ? '本地规则' : '';

  const saveBtnText = S.existing
    ? '更新分类至此'
    : (S.chosen && !S.chosen.code ? '放进待归类' : '收藏到此分类');

  box.innerHTML = `
    <div class="current-k">当前标签页</div>
    <div class="pp-now-title">${esc(tab.title || tab.url)}</div>
    <div class="pp-now-url">${esc(tab.url)}</div>
    ${S.existing ? `
      <div class="pp-saved-tag">
        ${icon('check', 11)}
        <span>已收藏在【${esc(S.existingFolder ? S.existingFolder.code + ' ' + S.existingFolder.name : '书签栏')}】</span>
      </div>
    ` : ''}
    <div class="pp-pick">
      <button class="pp-pick-main" id="pickBtn">
        <span class="pp-pick-k">归入</span>
        ${S.chosen
          ? (S.chosen.code
              ? `<span class="chip chip-to"><b>${esc(S.chosen.code)}</b>${esc(S.chosen.name)}</span>`
              : `<span class="chip chip-from">待归类</span>`)
          : `<span class="chip chip-from">未选中</span>`}
        <span class="pp-pick-badge">${s ? icon('sparkle', 10) : ''}${esc(badge)}</span>
        ${icon('chevronDown', 12)}
      </button>
      <div class="pp-folders" id="folders" ${S.pickerOpen ? '' : 'hidden'}>
        <button class="pp-folder${S.chosen && !S.chosen.code ? ' is-on' : ''}" data-inbox="1">
          <span class="tnum">—</span>待归类</button>
        ${S.summary.scheme.map((f) => `<button class="pp-folder${S.chosen && S.chosen.code === f.code ? ' is-on' : ''}"
          data-code="${esc(f.code)}" data-id="${esc(f.id)}">
          <span class="tnum">${esc(f.code)}</span><span>${esc(f.name)}</span></button>`).join('')
          || '<div class="pp-empty">还没有分类文件夹</div>'}
      </div>
    </div>
    <button class="btn btn-primary btn-md btn-block" id="saveBtn" ${S.chosen ? '' : 'disabled'}>
      ${icon(S.existing ? 'folder' : (S.chosen && !S.chosen.code ? 'inbox' : 'plus'), 14)}<span>${saveBtnText}</span></button>
    <div class="pp-meta-row">
      <input class="pp-note-input" id="noteInput" value="${esc(S.note)}" placeholder="顺手记一句批注或收藏理由（可选）" />
      <button type="button" class="pp-star-btn${S.star ? ' is-on' : ''}" id="starBtn" title="${S.star ? '取消星标' : '加星标'}">${icon('star', 13)}</button>
    </div>
    ${S.existing ? `<button class="btn btn-danger-ghost btn-sm btn-block pp-remove-btn" id="btnRemoveBookmark">${icon('trash', 12)}<span>移出书签</span></button>` : ''}
    ${s && s.code && (!S.chosen || S.chosen.code !== s.code) ? `<button class="pp-sug" id="useSug">
        ${icon('sparkle', 11)}
        <span>建议 <b class="tnum">${esc(s.code)}</b> ${esc((S.summary.scheme.find((x) => x.code === s.code) || {}).name || '')}</span>
        <span class="pp-sug-go">采用</span></button>` : ''}
    ${s && s.reason ? `<div class="pp-note">${esc(s.reason)}${s.conf ? ` · 把握 ${s.conf.toFixed(2)}` : ''}</div>` : ''}
    ${s && s.source !== 'model' && S.summary.aiReady ? `<div class="pp-note"><button class="pp-link" id="askModel">让模型再判一次</button></div>` : ''}`;

  $('#pickBtn').addEventListener('click', () => {
    S.pickerOpen = !S.pickerOpen;
    renderNow();
  });
  const save = $('#saveBtn');
  if (save) save.addEventListener('click', doSave);

  const noteInput = $('#noteInput');
  if (noteInput) {
    noteInput.addEventListener('input', (e) => { S.note = e.target.value; });
    noteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
  }
  const starBtn = $('#starBtn');
  if (starBtn) {
    starBtn.addEventListener('click', () => {
      S.star = !S.star;
      starBtn.classList.toggle('is-on', S.star);
      starBtn.title = S.star ? '取消星标' : '加星标';
    });
  }

  const removeBtn = $('#btnRemoveBookmark');
  if (removeBtn && S.existing) {
    removeBtn.addEventListener('click', async () => {
      await send('bookmarks:remove', { ids: [S.existing.id] });
      toast('已移出书签');
      setTimeout(() => window.close(), 380);
    });
  }

  box.querySelectorAll('[data-code],[data-inbox]').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.inbox) {
        S.chosen = inboxChoice();
      } else {
        const f = S.summary.scheme.find((x) => x.code === el.dataset.code);
        S.chosen = f ? { code: f.code, name: f.name, folderId: f.id } : null;
      }
      S.pickerOpen = false;
      renderNow();
    });
  });

  const use = $('#useSug');
  if (use) {
    use.addEventListener('click', () => {
      const f = S.summary.scheme.find((x) => x.code === S.suggestion.code);
      if (f) { S.chosen = { code: f.code, name: f.name, folderId: f.id }; renderNow(); }
    });
  }
  const ask = $('#askModel');
  if (ask) ask.addEventListener('click', askModel);
}

async function doSave() {
  if (!S.chosen || !S.tab) return;
  const url = S.tab.url;
  const parentId = S.chosen.folderId;
  try {
    let savedId = null;
    const found = await chrome.bookmarks.search({ url });
    if (found && found.length) {
      await chrome.bookmarks.move(found[0].id, { parentId });
      savedId = found[0].id;
      toast('已更新分类');
    } else {
      const r = await send('bookmark:save', { url, title: S.tab.title || url, folderId: parentId });
      savedId = r && r.id;
      toast('已收藏');
    }
    if (savedId && (S.star || S.note.trim())) {
      await send('meta:set', { id: savedId, patch: { star: S.star, note: S.note.trim() } }).catch(() => {});
    }
    setTimeout(() => window.close(), 380);
  } catch (e) {
    toast(e.message);
  }
}

function renderAlerts() {
  const c = S.summary.counts;
  const hasDead = (c.dead || 0) > 0;
  $('#alerts').innerHTML = `
    <button class="pp-alert" id="toPending" title="查看待定卷">${icon('inbox', 11)}<span>待定卷</span><b class="tnum">${c.inbox || 0}</b></button>
    <button class="pp-alert${hasDead ? ' is-dead' : ''}" id="toDead" title="查看已失效链接">${icon('alert', 11)}<span>已失效</span><b class="tnum">${c.dead || 0}</b></button>`;
  $('#toPending').addEventListener('click', () => openManager('view=inbox'));
  $('#toDead').addEventListener('click', () => openManager('view=dead'));
}

function renderRecent() {
  $('#recentLabel').innerHTML = `<div class="section-label">卷目<span class="section-aside">最近</span></div>`;
  const rows = S.summary.recent.slice(0, 3);
  const recentEl = $('#recent');
  recentEl.innerHTML = rows.length
    ? rows.map((it) => `<div class="row row-narrow" data-url="${esc(it.url)}">
        ${faviconMark(it.host, it.health && (it.health.status === 'dead' || it.health.status === 'unreachable'), it.url)}
        <div class="row-main">
          <div class="row-title">${esc(it.title)}</div>
          <div class="row-meta"><span class="host">${esc(it.host)}</span></div>
        </div>
        ${statusMark(it.health)}
      </div>`).join('')
    : '<div class="pp-empty">还没有收藏。</div>';

  wireFavicons(recentEl);
  recentEl.querySelectorAll('[data-url]').forEach((el) => {
    el.addEventListener('click', () => {
      chrome.tabs.create({ url: el.dataset.url });
      window.close();
    });
  });
}

function renderFoot() {
  $('#foot').innerHTML = `
    <button class="pp-open" id="openManager">打开书库 ${icon('arrowRight', 12)}</button>
    <span class="pp-foot-sep"></span>
    <button class="pp-stash" id="stashWinBtn" title="把当前窗口全部网页收进待归类（自动去重）">${icon('layers', 12)}<span>收本窗标签页</span></button>
    <button class="pp-scan" id="scanBtn" title="检测失效链接（在书库里跑）">${icon('pulse', 13)}</button>`;
  $('#openManager').addEventListener('click', () => openManager());
  $('#scanBtn').addEventListener('click', () => openManager('view=all'));
  $('#stashWinBtn').addEventListener('click', async () => {
    try {
      const r = await send('tabs:stashWindow', { closeTabs: false });
      toast(r.saved ? `已收进 ${r.saved} 个标签页${r.skipped ? `（跳过 ${r.skipped} 条已存）` : ''}` : '本窗标签页都已经在收藏夹里了');
    } catch (e) {
      toast(e.message);
    }
  });
}

async function openManager(hash = '') {
  await send('open:manager', { hash });
  window.close();
}

init().catch((e) => {
  document.body.innerHTML = `<div class="pp-empty" style="padding:16px">弹窗起不来：${esc(e.message)}</div>`;
});
