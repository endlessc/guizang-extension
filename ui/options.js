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
