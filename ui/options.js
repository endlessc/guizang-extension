/* 设置页 */

import { $, esc, mark, send, toast, THEMES, getTheme, setTheme } from './shared.js';

import { ensureEnv } from './env.js';
await ensureEnv();

const FIELDS = ['baseUrl', 'model', 'apiKey', 'maxTokens', 'concurrency', 'timeout', 'checkLimit'];

async function boot() {
  $('#head').innerHTML = `
    ${mark(26)}
    <div>
      <div class="h1">归藏</div>
      <div class="sub">GUIZANG · SETTINGS</div>
    </div>
    <div class="gap"></div>
    <span class="ver mono">v0.4.0</span>`;

  const summary = await send('summary:load');
  fill(summary.settings);
  renderThemes();
  renderScheme(summary.scheme);
  // 旧版后台不认识 schemes:list，别让它把整页拖垮
  await renderPicker().catch(() => {});

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'theme:changed') renderThemes();
    });
  }

  $('#test').addEventListener('click', test);
  $('#form').addEventListener('submit', save);
  $('#clearHealth').addEventListener('click', () => clear('health:clear', '检测结果'));
  $('#clearPending').addEventListener('click', () => clear('ai:ignoreAll', '归类建议'));
}

function renderThemes() {
  const current = getTheme();
  const box = $('#themeGrid');
  if (!box) return;
  box.innerHTML = THEMES.map((th) => {
    const active = th.id === current;
    const stripes = th.preview.map((c) => `<span style="background:${c}"></span>`).join('');
    return `
      <div class="theme-card${active ? ' is-active' : ''}" data-theme-id="${th.id}">
        <div class="theme-card-preview">${stripes}</div>
        <div class="theme-card-head">
          <span class="theme-card-title">${esc(th.name)}</span>
          <span class="theme-card-badge">当前使用</span>
        </div>
        <div class="theme-card-desc">${esc(th.desc)}</div>
      </div>
    `;
  }).join('');

  box.querySelectorAll('.theme-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const id = card.dataset.themeId;
      if (!id) return;
      await setTheme(id);
      renderThemes();
      const th = THEMES.find((t) => t.id === id);
      toast(`已应用配色：${th ? th.name : id}`);
    });
  });
}

function fill(s) {
  for (const k of FIELDS) {
    const el = document.querySelector(`[name="${k}"]`);
    if (el) el.value = s[k] == null ? '' : s[k];
  }
}

function collect() {
  const out = {};
  for (const k of FIELDS) {
    const el = document.querySelector(`[name="${k}"]`);
    if (!el) continue;
    out[k] = /maxTokens|concurrency|timeout|checkLimit/.test(k) ? Number(el.value) || 0 : el.value.trim();
  }
  return out;
}

/* ── 整理方案 ─────────────────────────────── */

async function renderPicker() {
  const box = $('#schemePicker');
  if (!box) return;
  const { schemes, current } = await send('schemes:list');
  box.innerHTML = schemes.map((s) => {
    const active = s.id === current;
    return `
      <button type="button" class="scheme-card${active ? ' is-active' : ''}" data-scheme="${esc(s.id)}">
        <span class="scheme-card-name">${esc(s.name)}${active ? '<i class="scheme-card-tag">当前</i>' : ''}</span>
        <span class="scheme-card-desc">${esc(s.desc)}</span>
        <span class="scheme-card-meta">${s.kind === 'letter' ? '字母编码' : '数字编码'} · ${s.codes.length} 类</span>
      </button>`;
  }).join('');
  box.querySelectorAll('[data-scheme]').forEach((el) => {
    el.addEventListener('click', () => previewScheme(el.dataset.scheme));
  });
}

async function previewScheme(id) {
  const box = $('#schemePreview');
  if (!box) return;
  box.innerHTML = '<div class="scheme-plan"><span class="test-msg">正在核对书签栏…</span></div>';
  try {
    const plan = await send('scheme:preview', { schemeId: id });
    const s = plan.summary;
    const conflicts = plan.conflict.length
      ? `<div class="scheme-warn">这些已有文件夹的编码和方案撞车，先改名或换方案：<br>${
        plan.conflict
          .map((c) => `「${esc(c.code)}」现有为「${esc(c.got)}」，方案要「${esc(c.want)}」`)
          .join('<br>')
      }</div>`
      : '';
    box.innerHTML = `
      <div class="scheme-plan">
        <div class="scheme-plan-line">将新建 <b>${s.missing}</b> 个目录，复用 <b>${s.exists}</b> 个${
          s.conflict ? `，<b class="bad">${s.conflict} 个撞车</b>` : ''
        }</div>
        ${conflicts}
        <div class="row">
          <button type="button" class="btn btn-primary btn-md" id="btnInstall"${
            plan.conflict.length ? ' disabled' : ''
          }>安装并启用</button>
        </div>
      </div>`;
    const btn = $('#btnInstall');
    if (btn) btn.addEventListener('click', () => installScheme(id));
  } catch (err) {
    box.innerHTML = `<div class="scheme-plan"><span class="test-msg bad">${esc(err.message)}</span></div>`;
  }
}

async function installScheme(id) {
  try {
    const r = await send('scheme:install', { schemeId: id });
    if (!r.installed) {
      toast('有编码冲突，未安装');
      return;
    }
    toast(`已启用：新建 ${r.created} 个目录，复用 ${r.reused} 个`);
    $('#schemePreview').innerHTML = '';
    const summary = await send('summary:load');
    renderScheme(summary.scheme);
    await renderPicker();
  } catch (err) {
    toast(err.message);
  }
}

function renderScheme(scheme) {
  const box = $('#scheme');
  if (!scheme.length) {
    box.innerHTML = `<div class="scheme-empty">没找到分类文件夹。在书签栏里新建一个，标题写成「500 人工智能」这样就行。</div>`;
    return;
  }
  box.innerHTML = scheme
    .map((f) => `<div class="scheme-item">
      <span class="code">${esc(f.code)}</span>
      <span class="nm">${esc(f.name)}</span>
    </div>`)
    .join('');
}

async function save(e) {
  e.preventDefault();
  const msg = $('#saveMsg');
  try {
    await send('settings:save', { settings: collect() });
    msg.textContent = '已保存';
    msg.className = 'test-msg ok';
    toast('设置已保存');
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'test-msg bad';
  }
}

async function test() {
  const msg = $('#testMsg');
  msg.textContent = '正在连接…';
  msg.className = 'test-msg';
  try {
    const r = await send('settings:test', { settings: collect() });
    msg.textContent = '通了：' + String(r.raw || '').slice(0, 60);
    msg.className = 'test-msg ok';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'test-msg bad';
  }
}

async function clear(type, label) {
  const msg = $('#dataMsg');
  try {
    await send(type);
    msg.textContent = label + '已清空';
    msg.className = 'test-msg ok';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'test-msg bad';
  }
}

boot().catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;font-size:12px">设置页起不来：${esc(e.message)}</div>`;
});
