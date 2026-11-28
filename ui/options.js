/* 设置页 */

import { $, esc, icon, mark, send, toast, openManager, THEMES, getTheme, setThemeAnimated, confirmDialog, choiceDialog, letterOf } from './shared.js';
import { toMarkdown, toNetscapeHtml } from '../lib/export.js';
import { parseSchemeLines } from '../lib/schemes.js';
import { treeOrder } from '../lib/tree.js';

import { ensureEnv } from './env.js';
await ensureEnv();

const FIELDS = ['baseUrl', 'model', 'apiKey', 'maxTokens', 'modelBatch', 'modelTimeout', 'concurrency', 'timeout', 'checkLimit'];
const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
];
let currentSettings = {};
let folderNameByCode = new Map();
let navSnapshot = { aiReady: false, schemeName: '', backupCount: 0 };
let activeOmniQuery = 'rgzn';

function appVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return 'dev';
  }
}

function download(name, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function boot() {
  $('#head').innerHTML = `
    ${mark(26)}
    <div>
      <div class="h1">归藏</div>
      <div class="sub">GUIZANG · SETTINGS</div>
    </div>
    <div class="gap"></div>
    <button type="button" class="btn btn-line btn-sm" id="backToManager">${icon('window', 13)}<span>打开书库</span></button>
    <a class="btn btn-ghost btn-sm" href="manual.html" target="_blank" rel="noopener">使用手册</a>
    <span class="ver mono">v${appVersion()}</span>`;
  $('#backToManager')?.addEventListener('click', () => openManager());

  const summary = await send('summary:load');
  currentSettings = summary.settings || {};
  navSnapshot.aiReady = Boolean(summary.aiReady);
  folderNameByCode = new Map((summary.folderScheme || []).map((f) => [f.code, f.name]));
  fill(currentSettings);
  wireModelTools();
  wireOmniboxDemo();
  renderThemes();
  renderScheme(summary.folderScheme, summary.parentOf);
  await renderPicker().catch(() => {});
  await renderPermissions().catch(() => {});
  await renderLearned().catch(() => {});
  await renderBackups().catch(() => {});
  renderOptNav();

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'theme:changed') renderThemes();
    });
  }

  $('#test').addEventListener('click', test);
  $('#form').addEventListener('submit', save);
  $('#clearHealth').addEventListener('click', async () => {
    if (!await confirmDialog({
      title: '清空检测记录',
      message: '会删掉所有链接健康状态，下次要重新检测。这一步不可撤销。',
      okText: '清空',
      danger: true,
    })) return;
    clear('health:clear', '检测结果');
  });
  $('#clearPending').addEventListener('click', async () => {
    if (!await confirmDialog({
      title: '重置归类建议',
      message: '会丢掉所有还没确认的归类建议。这一步不可撤销。',
      okText: '重置',
      danger: true,
    })) return;
    clear('ai:ignoreAll', '归类建议');
  });
  wireTaxonomy();
  await renderTaxonomy().catch(() => {});
  $('#openShortcuts')?.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  $('#exportMd')?.addEventListener('click', exportMarkdown);
  $('#exportHtml')?.addEventListener('click', exportHtml);
  wireCustomSchemes();
  wireLearned();
  wireBackup();
}

/* ── 顶栏快跳导航 / 模型预设 / 地址栏演练 ─────── */

function renderOptNav() {
  const nav = $('#optNav');
  if (!nav) return;
  const links = [
    { id: 'sec-model', label: '模型配置', ico: 'cpu' },
    { id: 'sec-native', label: '原生能力', ico: 'zap' },
    { id: 'sec-theme', label: '典籍配色', ico: 'palette' },
    { id: 'sec-scheme', label: '分类方案', ico: 'layers' },
    { id: 'sec-taxonomy', label: '因书立目', ico: 'branch' },
    { id: 'sec-backup', label: '备份安全', ico: 'shield' },
  ];
  nav.innerHTML = `
    <div class="opt-nav-links">
      ${links.map((l) => `<button type="button" class="opt-nav-btn" data-jump="${l.id}">${icon(l.ico, 12)}<span>${l.label}</span></button>`).join('')}
    </div>
    <span class="opt-nav-sep" aria-hidden="true"></span>
    <div class="opt-nav-status">
      <span class="tech-pill${navSnapshot.aiReady ? ' is-ok' : ''}">
        <span class="led-dot${navSnapshot.aiReady ? ' is-ok' : ''}"></span>
        <span>${navSnapshot.aiReady ? '模型就绪' : '离线规则'}</span>
      </span>
      ${navSnapshot.schemeName ? `<span class="tech-pill is-brand">${esc(navSnapshot.schemeName)}</span>` : ''}
      <span class="tech-pill">${icon('archive', 11)}<span>备份 ${navSnapshot.backupCount}</span></span>
    </div>`;
  nav.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.jump);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      nav.querySelectorAll('.opt-nav-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });
}

function renderProviderPresets() {
  const host = $('#providerPresets');
  if (!host) return;
  const curUrl = (document.querySelector('[name="baseUrl"]')?.value || '').trim().toLowerCase();
  host.innerHTML = `<span class="preset-label">快捷填充：</span>` + PROVIDER_PRESETS.map((p) => {
    const active = curUrl && curUrl.includes(p.baseUrl.replace(/^https?:\/\//, '').split('/')[0]);
    return `<button type="button" class="preset-chip${active ? ' is-active' : ''}" data-preset="${p.id}">
      ${icon('cpu', 11)}<span>${esc(p.name)}</span>
    </button>`;
  }).join('');
  host.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = PROVIDER_PRESETS.find((x) => x.id === btn.dataset.preset);
      if (!p) return;
      const u = document.querySelector('[name="baseUrl"]');
      const m = document.querySelector('[name="model"]');
      if (u) u.value = p.baseUrl;
      if (m) m.value = p.model;
      renderProviderPresets();
      toast(`已填入 ${p.name} 接口与推荐模型，别忘了点击下方保存`);
    });
  });
}

function wireModelTools() {
  renderProviderPresets();
  document.querySelector('[name="baseUrl"]')?.addEventListener('input', renderProviderPresets);
  const eyeBtn = $('#toggleApiKey');
  const keyInput = $('#apiKeyInput');
  if (eyeBtn && keyInput) {
    const syncEye = () => {
      const shown = keyInput.type === 'text';
      eyeBtn.innerHTML = icon(shown ? 'eyeOff' : 'eye', 14);
      eyeBtn.title = shown ? '隐藏秘钥' : '显示秘钥';
    };
    syncEye();
    eyeBtn.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      syncEye();
    });
  }
}

function wireOmniboxDemo() {
  const preview = $('#omniPreviewText');
  const tryBtn = $('#omniTryBtn');
  if (tryBtn) {
    tryBtn.innerHTML = `${icon('search', 12)}<span>去书库试搜</span>`;
    tryBtn.addEventListener('click', () => openManager('q=' + encodeURIComponent(activeOmniQuery)));
  }
  document.querySelectorAll('[data-omni-q]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeOmniQuery = btn.dataset.omniQ || 'rgzn';
      if (preview) preview.textContent = activeOmniQuery;
      navigator.clipboard?.writeText(`gz ${activeOmniQuery}`).catch(() => {});
      toast(`已切换预览为「gz ${activeOmniQuery}」，可点右侧直达书库`);
    });
  });
}

/* ── 导出全库书目 ─────────────────────────────── */

async function exportMarkdown() {
  try {
    const st = await send('state:load');
    const md = toMarkdown(st.items, st.folderScheme, { health: st.health, meta: st.meta, excludeDead: true });
    download(`guizang-library-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown;charset=utf-8');
    toast('已导出 Obsidian / Markdown 书目');
  } catch (e) {
    toast(e.message);
  }
}

async function exportHtml() {
  try {
    const st = await send('state:load');
    const html = toNetscapeHtml(st.items, st.folderScheme);
    download(`guizang-bookmarks-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html;charset=utf-8');
    toast('已导出标准 HTML 书签文件');
  } catch (e) {
    toast(e.message);
  }
}

/* ── Chrome 按需可选权限（alarms / history） ──── */

async function hasPerm(perm) {
  if (!chrome.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains({ permissions: [perm] });
  } catch {
    return false;
  }
}

async function renderPermissions() {
  const box = $('#permList');
  if (!box) return;
  const [hasAlarms, hasHistory] = await Promise.all([hasPerm('alarms'), hasPerm('history')]);
  const weeklyOn = Boolean(currentSettings.autoCheckWeekly && hasAlarms);

  box.innerHTML = `
    <div class="perm-item${weeklyOn ? ' is-on' : ''}">
      <span class="perm-ico">${icon('clock', 16)}</span>
      <div class="perm-info">
        <div class="perm-title">
          每周静默体检失效链接
          <span class="perm-badge${weeklyOn ? ' is-on' : ''}" style="display:inline-flex;align-items:center;gap:4px">
            <span class="led-dot${weeklyOn ? ' is-ok' : ''}" style="width:5px;height:5px;box-shadow:none"></span>
            ${weeklyOn ? '已开启' : '未开启'}
          </span>
        </div>
        <div class="perm-desc">按需申请 <code>alarms</code> 权限。每周后台静默检测最久未检的 60 条书签，仅发现新失效时亮起角标。</div>
      </div>
      <button type="button" class="btn ${weeklyOn ? 'btn-line' : 'btn-primary'} btn-sm" id="toggleWeekly">
        ${icon(weeklyOn ? 'x' : 'check', 12)}<span>${weeklyOn ? '关闭静默检测' : '授权并开启'}</span>
      </button>
    </div>
    <div class="perm-item${hasHistory ? ' is-on' : ''}">
      <span class="perm-ico">${icon('history', 16)}</span>
      <div class="perm-info">
        <div class="perm-title">
          常阅 / 尘封吃灰感知
          <span class="perm-badge${hasHistory ? ' is-on' : ''}" style="display:inline-flex;align-items:center;gap:4px">
            <span class="led-dot${hasHistory ? ' is-ok' : ''}" style="width:5px;height:5px;box-shadow:none"></span>
            ${hasHistory ? '已授权' : '未授权'}
          </span>
        </div>
        <div class="perm-desc">按需申请 <code>history</code> 权限，仅在本地比对访问频次，找出高频常阅与半年未开的尘封藏卷。</div>
      </div>
      <button type="button" class="btn ${hasHistory ? 'btn-line' : 'btn-primary'} btn-sm" id="toggleHistory">
        ${icon(hasHistory ? 'x' : 'check', 12)}<span>${hasHistory ? '撤销历史权限' : '授权浏览历史'}</span>
      </button>
    </div>`;

  $('#toggleWeekly')?.addEventListener('click', async () => {
    if (weeklyOn) {
      const r = await send('settings:save', { settings: { autoCheckWeekly: false } });
      currentSettings = r.settings;
      toast('已关闭每周静默检测');
      renderPermissions();
      return;
    }
    const ok = chrome.permissions?.request
      ? await chrome.permissions.request({ permissions: ['alarms'] }).catch(() => false)
      : true;
    if (!ok) return toast('未获得定时任务权限');
    const r = await send('settings:save', { settings: { autoCheckWeekly: true } });
    currentSettings = r.settings;
    toast('已开启每周静默体检');
    renderPermissions();
  });

  $('#toggleHistory')?.addEventListener('click', async () => {
    if (hasHistory) {
      await chrome.permissions?.remove?.({ permissions: ['history'] }).catch(() => {});
      toast('已撤销浏览历史权限');
      renderPermissions();
      return;
    }
    const ok = chrome.permissions?.request
      ? await chrome.permissions.request({ permissions: ['history'] }).catch(() => false)
      : true;
    if (!ok) return toast('未获得浏览历史权限');
    await send('history:analyze').catch(() => {});
    toast('已授权并完成首次常阅/吃灰分析');
    renderPermissions();
  });
}

/* ── 主题配色 ─────────────────────────────────── */

/* ── 分类法设计 ───────────────────────────── */

let txDraft = null;
let txBusy = false;
let txConflict = [];   // 落成目录时的冲突单独存：草稿里没这个字段，重渲染会丢
let txRemovedSet = new Set();

function ringGaugeHtml(pct, ok = false) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 19;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - clamped / 100);
  return `<div class="ring-gauge" aria-label="覆盖率 ${clamped}%">
    <svg width="48" height="48" viewBox="0 0 48 48">
      <circle class="ring-track" cx="24" cy="24" r="${r}" />
      <circle class="ring-fill${ok ? ' is-ok' : ''}" cx="24" cy="24" r="${r}" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" />
    </svg>
    <span class="ring-val">${clamped}%</span>
  </div>`;
}

function txStepperHtml(stageIdx) {
  const steps = [
    { num: 1, title: '归纳草稿' },
    { num: 2, title: '审定词表' },
    { num: 3, title: '落成目录' },
  ];
  return `<div class="tx-stepper">
    ${steps.map((st, idx) => {
      const done = idx < stageIdx;
      const active = idx === stageIdx;
      return `<div class="tx-step${done ? ' is-done' : active ? ' is-active' : ''}">
        <span class="tx-step-num">${done ? icon('check', 11, 2.2) : st.num}</span>
        <span class="tx-step-title">${st.title}</span>
      </div>`;
    }).join('')}
  </div>`;
}

async function renderTaxonomy() {
  const status = $('#txStatus');
  const body = $('#txBody');
  const design = $('#btnTxDesign');
  const cancel = $('#btnTxCancel');
  if (!status || !body) return;

  if (txBusy) {
    status.innerHTML = txStepperHtml(0) + `<div class="tx-summary-card">
      <div class="tx-summary-pills">
        <span class="tech-pill is-brand"><span class="led-dot is-brand"></span><span>正在归纳：抽样 → 模型归纳骨架 → 铺全量 → 剪枝…</span></span>
      </div>
      <div class="scan-track"><div class="scan-fill" style="width:48%"></div></div>
    </div>`;
    design.disabled = true;
    cancel.hidden = true;
    return;
  }

  const { draft } = await send('taxonomy:load').catch(() => ({ draft: null }));
  txDraft = draft || null;
  design.disabled = false;

  if (!txDraft) {
    txRemovedSet.clear();
    status.innerHTML = txStepperHtml(0) + `<div class="tx-summary-pills" style="margin-top:4px">
      <span class="tech-pill">${icon('shield', 11)}<span>只读分析收藏，不改动现有书签</span></span>
    </div>`;
    body.innerHTML = '';
    const props = $('#txProposals');
    if (props) props.innerHTML = '';
    const extend = $('#btnTxExtend');
    if (extend) extend.disabled = true;
    cancel.hidden = true;
    return;
  }
  const extendBtn = $('#btnTxExtend');
  if (extendBtn) extendBtn.disabled = false;

  const s = txDraft.stats || {};
  const stageIdx = txDraft.status === 'installed' ? 3 : txDraft.status === 'approved' ? 2 : 1;
  // 覆盖/未覆盖同源推导，保证相加等于总条数；stats.members 会重复计同一成员，不能拿来当覆盖数
  const src = txDraft.source || {};
  const uncovered = Number.isFinite(src.unmatched) ? src.unmatched : null;
  const totalItems = Number.isFinite(src.items) ? src.items : null;
  const covered = uncovered !== null && totalItems !== null
    ? Math.max(0, totalItems - uncovered)
    : (s.members || 0);
  const denom = totalItems || (covered + (uncovered || 0)) || 1;
  const covPct = Math.min(100, Math.round((covered / denom) * 100));
  const lineage = [src.model, src.promptVersion].filter(Boolean).join(' · ');

  status.innerHTML = txStepperHtml(stageIdx) + `<div class="tx-summary-card">
    <div class="ring-wrap">
      ${ringGaugeHtml(covPct, true)}
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:7px">
        <div class="tx-summary-pills">
          <span class="tech-pill is-brand">${esc(txDraft.name || '归纳草稿')}</span>
          <span class="tech-pill"><b>${s.categories || 0}</b> 类 · 最深 ${s.maxDepth || 0} 层</span>
          ${s.singles ? `<span class="tech-pill is-warn">单条类目 ${s.singles}</span>` : ''}
          ${txDraft.dropped ? `<span class="tech-pill">剪枝弃置 ${txDraft.dropped}</span>` : ''}
          ${lineage ? `<span class="lineage-pill">${icon('cpu', 10)}<span>${esc(lineage)}</span></span>` : ''}
          ${txDraft.lastExtend ? `<span class="tech-pill is-ok">上次扩展 +${txDraft.lastExtend.assigned} / 建议 ${txDraft.lastExtend.proposals}</span>` : ''}
        </div>
        <div>
          <div class="tx-cov-track"><div class="tx-cov-fill" style="width:${covPct}%"></div></div>
          <div class="tx-cov-meta" style="margin-top:4px">
            <span>已覆盖 <b>${covered}</b> 条</span>
            <span>${uncovered ? `未覆盖 ${uncovered} 条` : '已全部覆盖'}</span>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  cancel.hidden = false;
  const editable = txDraft.status === 'draft';
  const maxTotal = Math.max(1, ...txDraft.nodes.map((n) => n.total || 0));
  const rows = [...txDraft.nodes]
    .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map((n) => {
      const markedDel = txRemovedSet.has(n.code);
      const barPct = Math.max(4, Math.round(((n.total || 0) / maxTotal) * 100));
      return `
      <div class="tx-row${n.parent ? ' is-child' : ''}${markedDel ? ' is-marked-del' : ''}" data-code="${esc(n.code)}">
        <span class="tx-code">${esc(n.code)}</span>
        ${editable
          ? `<input class="tx-name" data-name="${esc(n.code)}" value="${esc(n.name)}" maxlength="20" spellcheck="false" />`
          : `<span class="tx-name" style="border:0">${esc(n.name)}</span>`}
        <span class="tx-bar-wrap" title="${n.total || 0} 条"><span class="tx-bar-fill" style="width:${barPct}%"></span></span>
        <span class="tx-count">${n.total || 0}</span>
        ${editable ? `<button type="button" class="tx-keep-btn${markedDel ? ' is-drop' : ''}" data-toggle-del="${esc(n.code)}" title="${markedDel ? '点击恢复保留' : '点击标记删除'}">
          ${icon(markedDel ? 'undo' : 'trash', 10)}<span>${markedDel ? '已标删' : '保留'}</span>
        </button>` : ''}
      </div>`;
    })
    .join('');

  const conflicts = txConflict.length
    ? `<div class="alert-card is-dead" style="margin-top:10px">
      <span class="alert-card-ico">${icon('alert', 14)}</span>
      <div class="alert-card-body">
        <div class="alert-card-title">已有目录与草稿编码撞车</div>
        <div>${txConflict.map((c) => `「${esc(c.code)}」现有为「${esc(c.got)}」，草稿要「${esc(c.want)}」`).join('<br>')}</div>
      </div>
    </div>`
    : '';

  body.innerHTML = `
    <div class="tx-list">${rows || '<div class="hint">草稿是空的。</div>'}</div>
    ${conflicts}
    <div class="opt-row tx-actions">
      ${editable
        ? `<button type="button" class="btn btn-primary btn-sm" id="btnTxApprove">${icon('check', 12)}<span>保存修改并审定${txRemovedSet.size ? `（删 ${txRemovedSet.size} 类）` : ''}</span></button>`
        : txDraft.status === 'approved'
          ? `<button type="button" class="btn btn-primary btn-sm" id="btnTxInstall">${icon('folder', 12)}<span>落成目录并启用</span></button>`
          : '<span class="tech-pill is-ok"><span class="led-dot is-ok"></span><span>已落成目录，可在上方切换方案或重新归纳</span></span>'}
    </div>`;

  body.querySelectorAll('[data-toggle-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.toggleDel;
      const marked = txRemovedSet.has(code);
      if (marked) txRemovedSet.delete(code);
      else txRemovedSet.add(code);
      const next = !marked;
      btn.classList.toggle('is-drop', next);
      btn.title = next ? '点击恢复保留' : '点击标记删除';
      btn.innerHTML = `${icon(next ? 'undo' : 'trash', 10)}<span>${next ? '已标删' : '保留'}</span>`;
      btn.closest('.tx-row')?.classList.toggle('is-marked-del', next);
      const approveBtn = $('#btnTxApprove');
      if (approveBtn) {
        approveBtn.innerHTML = `${icon('check', 12)}<span>保存修改并审定${txRemovedSet.size ? `（删 ${txRemovedSet.size} 类）` : ''}</span>`;
      }
    });
  });

  $('#btnTxApprove')?.addEventListener('click', approveTx);
  $('#btnTxInstall')?.addEventListener('click', installTx);

  renderProposals(txDraft.proposals || []);
}

/** 扩展建议：勾选后一次性接受，变成节点再走审定 */
function renderProposals(props) {
  const box = $('#txProposals');
  const msg = $('#txExtendMsg');
  if (!box) return;
  if (!props.length) {
    box.innerHTML = '';
    if (msg && !msg.dataset.keep) msg.textContent = '只处理还没归入任何类目的条目，不建目录、不改结构。';
    return;
  }
  const byCode = new Map((txDraft.nodes || []).map((n) => [n.code, n]));
  box.innerHTML = `
    <div class="tx-props">
      ${props.map((p) => {
        const parent = byCode.get(p.parent);
        const label = parent ? `${p.parent} ${parent.name}` : p.parent || '（无父类）';
        return `<label class="tx-prop">
          <input type="checkbox" class="tx-prop-pick" data-key="${esc(p.key)}" checked />
          <span class="tx-prop-name">${esc(p.name)}</span>
          <span class="tx-prop-meta">挂到 ${esc(label)} · ${p.members.length} 条 · ${esc(p.host || '')}</span>
        </label>`;
      }).join('')}
      <div class="opt-row">
        <button type="button" class="btn btn-primary btn-sm" id="btnTxAcceptProps">接受选中</button>
        <span class="hint">接受后它们会变成正式节点，还要再审定并落成目录才会建文件夹。</span>
      </div>
    </div>`;
  $('#btnTxAcceptProps')?.addEventListener('click', acceptProps);
}

async function acceptProps() {
  const keys = [...document.querySelectorAll('.tx-prop-pick:checked')].map((el) => el.dataset.key);
  if (!keys.length) return toast('先勾选要接受的建议');
  try {
    txDraft = await send('taxonomy:acceptProposals', { keys });
    await renderTaxonomy();
    toast(`已接受 ${keys.length} 条建议，记得再审定一次`);
  } catch (err) {
    toast(err.message);
  }
}

async function approveTx() {
  if (!txDraft) return;
  const renames = {};
  document.querySelectorAll('.tx-name[data-name]').forEach((el) => {
    const code = el.dataset.name;
    const old = (txDraft.nodes.find((n) => n.code === code) || {}).name || '';
    const next = el.value.trim();
    if (next && next !== old) renames[code] = next;
  });
  const removed = [...txRemovedSet];
  const msg = $('#txStatus');
  try {
    txDraft = await send('taxonomy:approve', { renames, removed });
    txRemovedSet.clear();
    await renderTaxonomy();
  } catch (err) {
    if (msg) msg.innerHTML = `<span class="test-msg bad">${esc(err.message)}</span>`;
  }
}

async function installTx() {
  const msg = $('#txStatus');
  try {
    const r = await send('taxonomy:install');
    if (!r.installed) {
      txConflict = r.conflict || [];
      await renderTaxonomy();
      return;
    }
    txConflict = [];
    toast(`已落成目录：新建 ${r.created} 个，复用 ${r.reused} 个${schemeNote(r)}`);
    const summary = await send('summary:load');
    renderScheme(summary.folderScheme, summary.parentOf);
    await renderPicker();
    await renderTaxonomy();
  } catch (err) {
    if (msg) msg.innerHTML = `<span class="test-msg bad">${esc(err.message)}</span>`;
  }
}

function wireTaxonomy() {
  $('#btnTxDesign')?.addEventListener('click', async () => {
    txBusy = true;
    txConflict = [];
    await renderTaxonomy();
    try {
      await send('taxonomy:design', { sampleSize: 200 });
    } catch (err) {
      txBusy = false;
      await renderTaxonomy();
      toast(err.message);
    }
  });
  $('#btnTxExtend')?.addEventListener('click', async () => {
    const msg = $('#txExtendMsg');
    if (msg) { msg.dataset.keep = '1'; msg.textContent = '正在扫描新条目…'; }
    try {
      const r = await send('taxonomy:extend');
      if (msg) msg.textContent = `归入 ${r.assigned} 条，新增 ${r.proposals} 条建议，仍未覆盖 ${r.unmatched} 条`;
      await renderTaxonomy();
    } catch (err) {
      if (msg) msg.textContent = err.message;
    }
  });

  $('#btnTxCancel')?.addEventListener('click', async () => {
    await send('taxonomy:cancel').catch(() => {});
    txDraft = null;
    await renderTaxonomy();
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'taxonomy:done') {
      txBusy = false;
      renderTaxonomy().catch(() => {});
      return;
    }
    if (msg.type === 'taxonomy:error') {
      txBusy = false;
      toast(msg.message || '归纳失败');
      renderTaxonomy().catch(() => {});
    }
  });
}

function renderThemes() {
  const current = getTheme();
  const sysHost = $('#themeSystemHost');
  const box = $('#themeGrid');
  if (!box) return;

  const sysTheme = THEMES.find((t) => t.id === 'system');
  const namedThemes = THEMES.filter((t) => t.id !== 'system');

  if (sysHost && sysTheme) {
    const active = current === 'system';
    sysHost.innerHTML = `
      <button type="button" class="theme-system-bar${active ? ' is-active' : ''}" data-theme-id="system" aria-pressed="${active}">
        <span class="theme-system-mini" aria-hidden="true">
          <span class="theme-system-half is-light"><i></i><i></i><i></i></span>
          <span class="theme-system-half is-dark"><i></i><i></i><i></i></span>
        </span>
        <span class="theme-system-info">
          <span class="theme-card-title">${esc(sysTheme.name)}</span>
          <span class="theme-card-desc">${esc(sysTheme.desc)}</span>
        </span>
        <span class="theme-card-badge">当前使用</span>
      </button>`;
  }

  box.innerHTML = namedThemes.map((th) => {
    const active = th.id === current;
    const [bg, ink, brand] = th.preview;
    const rail = `color-mix(in srgb, ${bg} 92%, ${ink})`;
    return `
      <button type="button" class="theme-card${active ? ' is-active' : ''}" data-theme-id="${th.id}" aria-pressed="${active}">
        <span class="theme-mini-ui" style="--th-bg:${bg};--th-rail:${rail};--th-ink:${ink};--th-brand:${brand}">
          <span class="theme-mini-rail">
            <span class="theme-mini-pill"></span>
            <span class="theme-mini-tick"></span>
            <span class="theme-mini-tick" style="width:55%"></span>
            <span class="theme-mini-tick" style="width:62%"></span>
          </span>
          <span class="theme-mini-main">
            <span class="theme-mini-top">
              <span class="theme-mini-bar"></span>
              <span class="theme-mini-cta"></span>
            </span>
            <span class="theme-mini-row"></span>
            <span class="theme-mini-row is-short"></span>
            <span class="theme-mini-row" style="width:84%"></span>
          </span>
        </span>
        <span class="theme-card-head">
          <span class="theme-card-title">${esc(th.name)}</span>
          <span class="theme-card-badge">当前使用</span>
        </span>
        <span class="theme-card-desc">${esc(th.desc)}</span>
      </button>
    `;
  }).join('');

  document.querySelectorAll('[data-theme-id]').forEach((card) => {
    card.addEventListener('click', async (e) => {
      const id = card.dataset.themeId;
      if (!id) return;
      await setThemeAnimated(id, e);
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
  const headCb = document.querySelector('[name="fetchHeadOnAi"]');
  if (headCb) headCb.checked = s.fetchHeadOnAi !== false;
}

function collect() {
  const out = {};
  for (const k of FIELDS) {
    const el = document.querySelector(`[name="${k}"]`);
    if (!el) continue;
    out[k] = /maxTokens|modelBatch|modelTimeout|concurrency|timeout|checkLimit/.test(k) ? Number(el.value) || 0 : el.value.trim();
  }
  const headCb = document.querySelector('[name="fetchHeadOnAi"]');
  if (headCb) out.fetchHeadOnAi = Boolean(headCb.checked);
  return out;
}

/* ── 整理方案 + 自定义方案 ────────────────────── */

async function renderPicker() {
  const box = $('#schemePicker');
  if (!box) return;
  const { schemes, current } = await send('schemes:list');
  const activeObj = schemes.find((s) => s.id === current);
  navSnapshot.schemeName = activeObj ? activeObj.name : '';
  renderOptNav();
  box.innerHTML = schemes.map((s) => {
    const active = s.id === current;
    return `
      <button type="button" class="scheme-card${active ? ' is-active' : ''}" data-scheme="${esc(s.id)}">
        <span class="scheme-card-name">
          ${esc(s.name)}
          ${active ? '<i class="scheme-card-tag">当前</i>' : ''}
          ${s.custom ? '<i class="scheme-card-tag" style="background:var(--paper-2);color:var(--ink-2)">自定</i>' : ''}
        </span>
        <span class="scheme-card-desc">${esc(s.desc)}</span>
        <span class="scheme-card-meta">${s.kind === 'letter' ? '字母编码' : '数字编码'} · ${s.codes.length} 类</span>
      </button>`;
  }).join('');
  box.querySelectorAll('[data-scheme]').forEach((el) => {
    el.addEventListener('click', () => previewScheme(el.dataset.scheme, schemes));
  });
}

async function previewScheme(id, schemes = []) {
  const box = $('#schemePreview');
  if (!box) return;
  const meta = schemes.find((s) => s.id === id);
  box.innerHTML = '<div class="scheme-plan"><span class="test-msg">正在核对书签栏…</span></div>';
  try {
    const plan = await send('scheme:preview', { schemeId: id });
    const s = plan.summary;
    const conflicts = plan.conflict.length
      ? `<div class="alert-card is-dead" style="margin-top:10px">
        <span class="alert-card-ico">${icon('alert', 14)}</span>
        <div class="alert-card-body">
          <div class="alert-card-title">${plan.conflict.length} 个已有目录编码与方案撞车</div>
          <div>${plan.conflict.map((c) => `「${esc(c.code)}」现有为「${esc(c.got)}」，方案要「${esc(c.want)}」`).join('<br>')}</div>
        </div>
      </div>`
      : '';
    const emptyCount = Array.isArray(plan.empty) ? plan.empty.length : (Number(s.empty) || 0);
    const totalCats = s.missing + s.exists;
    const withItems = Math.max(0, totalCats - emptyCount);
    const pct = totalCats ? Math.round((withItems / totalCats) * 100) : 0;
    box.innerHTML = `
      <div class="scheme-plan">
        <div class="ring-wrap">
          ${ringGaugeHtml(pct, false)}
          <div style="flex:1;min-width:0">
            <div class="tx-summary-pills">
              <span class="tech-pill is-brand">${esc((meta && meta.name) || id)} · ${totalCats} 类</span>
              <span class="tech-pill is-ok">命中书签 ${withItems} 类</span>
              <span class="tech-pill">已有 ${s.exists} · 待建 ${s.missing}</span>
              ${s.conflict ? `<span class="tech-pill is-dead">撞车 ${s.conflict}</span>` : ''}
            </div>
            <div class="scheme-meter-wrap">
              <div class="scheme-meter-bar"><div class="scheme-meter-fill" style="width:${pct}%"></div></div>
            </div>
          </div>
        </div>
        ${conflicts}
        <div class="opt-row">
          <button type="button" class="btn btn-primary btn-md" id="btnSelectScheme">${icon('check', 13)}<span>选用这套方案</span></button>
          <button type="button" class="btn btn-line btn-sm" id="btnTrimScheme">${icon('branch', 12)}<span>按收藏裁剪为草稿</span></button>
          ${meta && meta.custom ? `
            <button type="button" class="btn btn-line btn-sm" id="btnExportScheme">${icon('download', 12)}<span>导出 JSON</span></button>
            <button type="button" class="btn btn-danger-ghost btn-sm" id="btnDeleteScheme">${icon('trash', 12)}<span>删除方案</span></button>
          ` : ''}
        </div>
        <div class="hint" style="margin-top:8px;margin-bottom:0">「选用」仅切换受控词表、不建空目录；之后在书库「整理 → 按方案建档」选择投影方式。</div>
      </div>`;
    $('#btnTrimScheme')?.addEventListener('click', () => trimScheme(id));
    $('#btnSelectScheme')?.addEventListener('click', () => selectScheme(id));
    $('#btnExportScheme')?.addEventListener('click', () => {
      download(`guizang-scheme-${meta.id}.json`, JSON.stringify(meta, null, 2));
      toast('已导出自定义方案');
    });
    $('#btnDeleteScheme')?.addEventListener('click', async () => {
      const r = await send('scheme:deleteCustom', { schemeId: id });
      box.innerHTML = '';
      await renderPicker();
      toast(`已删除自定义方案${schemeNote(r)}`);
    });
  } catch (err) {
    box.innerHTML = `<div class="scheme-plan"><span class="test-msg bad">${esc(err.message)}</span></div>`;
  }
}

function wireCustomSchemes() {
  const editor = $('#customEditor');
  $('#btnNewCustom')?.addEventListener('click', () => {
    editor.hidden = !editor.hidden;
    if (!editor.hidden) $('#customSchemeName')?.focus();
  });
  $('#btnCancelCustom')?.addEventListener('click', () => { editor.hidden = true; });
  $('#btnSaveCustom')?.addEventListener('click', async () => {
    const name = $('#customSchemeName').value.trim();
    const desc = $('#customSchemeDesc').value.trim();
    const folders = parseSchemeLines($('#customSchemeLines').value);
    try {
      await send('scheme:saveCustom', { scheme: { name, desc, folders } });
      editor.hidden = true;
      $('#customSchemeName').value = '';
      $('#customSchemeDesc').value = '';
      $('#customSchemeLines').value = '';
      await renderPicker();
      toast(`已保存自定义方案「${name}」，点击卡片即可安装`);
    } catch (e) {
      toast(e.message);
    }
  });

  const fileInput = $('#schemeFileInput');
  $('#btnImportScheme')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      await send('scheme:saveCustom', { scheme: parsed });
      await renderPicker();
      toast(`已导入方案「${parsed.name || '未命名'}」`);
    } catch (e) {
      toast('导入失败：' + e.message);
    }
  });
}

/**
 * 换方案后旧建议的去向：迁移几条、作废几条。
 * 换方案不再静默清空——这两类计数必须说出来，用户才知道哪些要重判。
 */
function schemeNote(r) {
  const parts = [];
  const pendBits = [];
  if (r.mapped) pendBits.push(`迁移 ${r.mapped} 条`);
  if (r.dropped) pendBits.push(`作废 ${r.dropped} 条`);
  if (pendBits.length) parts.push(`建议${pendBits.join('，')}`);
  const learnBits = [];
  if (r.learnedMapped) learnBits.push(`迁移 ${r.learnedMapped} 条`);
  if (r.learnedDropped) learnBits.push(`作废 ${r.learnedDropped} 条`);
  if (learnBits.length) parts.push(`改判记忆${learnBits.join('，')}`);
  if (r.planCleared) parts.push('旧整理计划已作废');
  return parts.length ? `；模式迁移：${parts.join('；')}` : '';
}

async function selectScheme(id) {
  try {
    const r = await send('scheme:select', { schemeId: id });
    await renderPicker();
    toast(`已选用（没有建任何目录）${schemeNote(r)}；到书库「整理 → 按方案建档 → 生成计划」才会按收藏建目录`);
  } catch (err) {
    toast(err.message);
  }
}

async function trimScheme(id) {
  try {
    const draft = await send('taxonomy:fromScheme', { schemeId: id });
    await renderTaxonomy();
    $('#txStatus')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const removed = (draft.removed || []).length;
    toast(`已生成草稿：留下 ${draft.nodes.length} 个类目${removed ? `，剪掉 ${removed} 个空类目` : ''}；审定后点「落成目录」才建文件夹`);
  } catch (err) {
    toast(err.message);
  }
}

const SCHEME_DOTS = ['#2E5E7E', '#3A7A68', '#A67C37', '#6E5A8A', '#B2523A', '#2F728A', '#577D4B', '#8E6A46', '#4C648E', '#9B6558'];

function renderScheme(scheme, parentOf = {}) {
  const box = $('#scheme');
  if (!scheme.length) {
    box.innerHTML = `<div class="scheme-empty">没找到分类文件夹。在书签栏里新建一个，标题写成「500 人工智能」这样就行。</div>`;
    return;
  }
  // 二级缩进挂在父类下面，别让拆出来的 010/020 看起来和 000 平级
  box.innerHTML = treeOrder(scheme, parentOf)
    .map((f, idx) => `<div class="scheme-item${f.level ? ' is-sub' : ''}">
      <span class="scheme-dot" style="--cat-dot:${SCHEME_DOTS[idx % SCHEME_DOTS.length]}"></span>
      <span class="code">${esc(f.code)}</span>
      <span class="nm">${esc(f.name)}</span>
    </div>`)
    .join('');
}

/* ── 个人改判记忆管理 ─────────────────────────── */

async function renderLearned() {
  const box = $('#learnedList');
  if (!box) return;
  const data = await send('learned:list');
  const entries = Object.entries((data && data.domains) || {}).sort((a, b) => (b[1].count || 1) - (a[1].count || 1));
  if (!entries.length) {
    box.innerHTML = '<div class="backup-empty">还没有改判记忆。你在归类或整理计划里手动改判域名后，会自动沉淀到这里。</div>';
    return;
  }
  box.innerHTML = `<div class="learned-list">${entries.map(([host, info]) => {
    const cname = folderNameByCode.get(info.code);
    const label = cname ? `${info.code} ${cname}` : info.code;
    return `
    <div class="learned-item">
      <span class="learned-dot">${esc(letterOf(host))}</span>
      <span class="learned-host" title="${esc(host)}">${esc(host)}</span>
      <span class="learned-code" title="${esc(label)}">→ ${esc(label)}${info.count > 1 ? ` ×${info.count}` : ''}</span>
      <button type="button" class="ibtn" data-drop-learned="${esc(host)}" title="删除此偏好" style="width:22px;height:22px">${icon('x', 11)}</button>
    </div>`;
  }).join('')}</div>`;
  box.querySelectorAll('[data-drop-learned]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await send('learned:remove', { host: btn.dataset.dropLearned });
      await renderLearned();
      toast('已移除此域名偏好');
    });
  });
}

function wireLearned() {
  $('#clearLearned')?.addEventListener('click', async () => {
    await send('learned:clear');
    await renderLearned();
    const msg = $('#learnedMsg');
    if (msg) { msg.textContent = '已清空改判记忆'; msg.className = 'test-msg ok'; }
  });
}

async function save(e) {
  e.preventDefault();
  const msg = $('#saveMsg');
  try {
    const r = await send('settings:save', { settings: collect() });
    currentSettings = r.settings;
    navSnapshot.aiReady = Boolean(r.settings && r.settings.baseUrl && (r.settings.apiKey || /localhost|127\.0\.0\.1/.test(r.settings.baseUrl)));
    renderOptNav();
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
    msg.textContent = '连接正常：' + String(r.raw || '').slice(0, 60);
    msg.className = 'test-msg ok';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'test-msg bad';
  }
}

/* ── 书签树备份与安全恢复 ─────────────────────── */

async function renderBackups() {
  const box = $('#backupList');
  if (!box) return;
  const list = await send('backup:list');
  navSnapshot.backupCount = list.length;
  renderOptNav();
  if (!list.length) {
    box.innerHTML = '<div class="backup-empty">还没有备份。整理功能会在动手前自动做一份。</div>';
    return;
  }
  box.innerHTML = list
    .map((b) => {
      const when = new Date(b.at).toLocaleString('zh-CN', { hour12: false });
      return `<div class="backup-item">
        <span class="backup-ico">${icon('archive', 14)}</span>
        <div class="backup-info">
          <span class="backup-when">${esc(when)}</span>
          <span class="backup-meta">${b.counts.nodes} 节点 · ${Math.max(1, Math.round(b.bytes / 1024))} KB</span>
        </div>
        <span class="backup-acts">
          <span class="tech-pill" style="padding:2px 7px;font-size:10px">${b.planId ? '整理前自动' : '手动快照'}</span>
          <button type="button" class="btn btn-line btn-sm" data-restore-backup="${esc(b.id)}">${icon('shield', 12)}<span>安全恢复</span></button>
          <button type="button" class="btn btn-ghost btn-sm" data-replace-backup="${esc(b.id)}">${icon('refresh', 12)}<span>替换恢复</span></button>
        </span>
      </div>`;
    })
    .join('');

  box.querySelectorAll('[data-restore-backup]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '安全恢复（副本）',
        message: '把这份快照还原到书签栏新建的「归藏恢复 时间」目录里，现有书签一条都不动。\n恢复前会自动备份当前树。',
        okText: '恢复为副本',
      });
      if (!ok) return;
      try {
        const r = await send('backup:restore', { id: btn.dataset.restoreBackup, mode: 'safe' });
        await renderBackups();
        toast(`已安全恢复 ${r.bookmarks} 条书签到「${r.label}」（可在 Chrome 书签管理器查看，不混入归藏统计）`);
      } catch (e) {
        toast(e.message);
      }
    });
  });

  box.querySelectorAll('[data-replace-backup]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '替换恢复（会用快照覆盖现有书签）',
        message: '先自动备份当前树，再清空书签栏与「其他书签」下的内容，然后把快照原样写回去。\n'
          + '受管书签删不掉，会被跳过并计数；恢复后可用刚生成的那份备份再回退。',
        okText: '替换并恢复',
        danger: true,
      });
      if (!ok) return;
      try {
        const r = await send('backup:restore', { id: btn.dataset.replaceBackup, mode: 'replace' });
        await renderBackups();
        toast(`已替换恢复：清掉 ${r.removed} 项，写回 ${r.folders} 个目录 / ${r.bookmarks} 条书签${
          r.remappedMeta ? `，保留 ${r.remappedMeta} 条标签与批注` : ''
        }${r.stuck ? `（${r.stuck} 项删不掉，已跳过）` : ''}`);
      } catch (e) {
        toast(e.message);
      }
    });
  });
}

function wireBackup() {
  const msg = $('#backupMsg');
  const say = (text, ok = true) => {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'test-msg ' + (ok ? 'ok' : 'bad');
  };

  $('#doBackup')?.addEventListener('click', async () => {
    say('正在备份…');
    try {
      const meta = await send('backup:run', {});
      say(`已备份 ${meta.counts.nodes} 个节点（${Math.round(meta.bytes / 1024)} KB）`);
      await renderBackups();
    } catch (err) {
      say(err.message, false);
    }
  });

  $('#exportBackup')?.addEventListener('click', async () => {
    try {
      const text = await send('backup:export', {});
      const list = await send('backup:list');
      download(`guizang-backup-${list[0].id}.json`, text);
      say('已导出最新那份备份');
    } catch (err) {
      say(err.message, false);
    }
  });

  const fileInput = $('#backupFileInput');
  $('#importBackupBtn')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    const how = await choiceDialog({
      title: '导入 JSON 备份',
      message: `从「${f.name}」恢复。两种方式都会先自动备份当前树。`,
      actions: [
        { id: 'safe', label: '恢复为副本' },
        { id: 'replace', label: '替换现有书签', primary: true, danger: true },
      ],
    });
    if (!how) return;
    try {
      const r = await send('backup:restore', { snapshotJson: await f.text(), mode: how === 'replace' ? 'replace' : 'safe' });
      await renderBackups();
      say(how === 'replace'
        ? `已替换恢复：写回 ${r.folders} 个目录 / ${r.bookmarks} 条书签${r.stuck ? `（${r.stuck} 项删不掉）` : ''}`
        : `已安全恢复 ${r.bookmarks} 条书签到「${r.label}」`);
    } catch (err) {
      say(err.message, false);
    }
  });

  $('#clearBackup')?.addEventListener('click', async () => {
    if (!await confirmDialog({
      title: '删除全部备份',
      message: '删掉之后整理就没有退路了。这一步不可撤销。',
      okText: '全部删除',
      danger: true,
    })) return;
    try {
      const r = await send('backup:clear', {});
      say(`已删除 ${r.removed} 份备份`);
      await renderBackups();
    } catch (err) {
      say(err.message, false);
    }
  });
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
