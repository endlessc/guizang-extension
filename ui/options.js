/* 设置页 */

import { $, esc, icon, mark, send, toast, openManager, THEMES, getTheme, setThemeAnimated, confirmDialog, choiceDialog } from './shared.js';
import { toMarkdown, toNetscapeHtml } from '../lib/export.js';
import { parseSchemeLines } from '../lib/schemes.js';
import { treeOrder } from '../lib/tree.js';

import { ensureEnv } from './env.js';
await ensureEnv();

const FIELDS = ['baseUrl', 'model', 'apiKey', 'maxTokens', 'modelBatch', 'modelTimeout', 'concurrency', 'timeout', 'checkLimit'];
let currentSettings = {};

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
    <span class="ver mono">v${appVersion()}</span>`;
  $('#backToManager')?.addEventListener('click', () => openManager());

  const summary = await send('summary:load');
  currentSettings = summary.settings || {};
  fill(currentSettings);
  renderThemes();
  renderScheme(summary.folderScheme, summary.parentOf);
  await renderPicker().catch(() => {});
  await renderPermissions().catch(() => {});
  await renderLearned().catch(() => {});
  await renderBackups().catch(() => {});

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
    <div class="perm-item">
      <div class="perm-info">
        <div class="perm-title">
          每周静默体检失效链接
          <span class="perm-badge${weeklyOn ? ' is-on' : ''}">${weeklyOn ? '已开启' : '未开启'}</span>
        </div>
        <div class="perm-desc">按需申请 <code>alarms</code> 权限。每周在后台静默检测最久未检的 60 条书签，仅在发现新失效时在工具栏图标亮起角标。</div>
      </div>
      <button type="button" class="btn ${weeklyOn ? 'btn-line' : 'btn-primary'} btn-sm" id="toggleWeekly">
        ${weeklyOn ? '关闭静默检测' : '授权并开启'}
      </button>
    </div>
    <div class="perm-item">
      <div class="perm-info">
        <div class="perm-title">
          常阅 / 尘封吃灰感知
          <span class="perm-badge${hasHistory ? ' is-on' : ''}">${hasHistory ? '已授权' : '未授权'}</span>
        </div>
        <div class="perm-desc">按需申请 <code>history</code> 权限，仅在本地比对书签访问频次，找出高频常阅与超过半年未打开的尘封书卷。</div>
      </div>
      <button type="button" class="btn ${hasHistory ? 'btn-line' : 'btn-primary'} btn-sm" id="toggleHistory">
        ${hasHistory ? '撤销历史权限' : '授权浏览历史'}
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

async function renderTaxonomy() {
  const status = $('#txStatus');
  const body = $('#txBody');
  const design = $('#btnTxDesign');
  const cancel = $('#btnTxCancel');
  if (!status || !body) return;

  if (txBusy) {
    status.innerHTML = '正在归纳：抽样 → 模型归纳骨架 → 铺全量 → 剪枝…';
    design.disabled = true;
    cancel.hidden = true;
    return;
  }

  const { draft } = await send('taxonomy:load').catch(() => ({ draft: null }));
  txDraft = draft || null;
  design.disabled = false;

  if (!txDraft) {
    status.innerHTML = '还没有草稿。归纳只读你的收藏，不会改动任何书签。';
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
  const state = txDraft.status === 'approved' ? '已审定，等落成目录'
    : txDraft.status === 'installed' ? '已落成目录' : '草稿';
  // 覆盖/未覆盖同源推导，保证相加等于总条数；stats.members 会重复计同一成员，不能拿来当覆盖数
  const src = txDraft.source || {};
  const uncovered = Number.isFinite(src.unmatched) ? src.unmatched : null;
  const covered = uncovered !== null && Number.isFinite(src.items)
    ? Math.max(0, src.items - uncovered)
    : (s.members || 0);
  status.innerHTML = `<b>${state}</b> · ${esc(txDraft.name || '未命名')} · `
    + `<b>${s.categories || 0}</b> 个类目 · 最深 <b>${s.maxDepth || 0}</b> 层 · `
    + `只有一条的类目 <b>${s.singles || 0}</b> 个 · 覆盖 <b>${covered}</b> 条`
    + (uncovered ? ` · 未覆盖 <b>${uncovered}</b> 条` : '')
    + (txDraft.dropped ? ` · 剪枝弃置 <b>${txDraft.dropped}</b> 条（已算进未覆盖）` : '')
    + (txDraft.lastExtend
      ? ` · 上次扩展：归入 <b>${txDraft.lastExtend.assigned}</b> 条、新增 <b>${txDraft.lastExtend.proposals}</b> 条建议`
      : '');

  cancel.hidden = false;
  const editable = txDraft.status === 'draft';
  const rows = [...txDraft.nodes]
    .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map((n) => `
      <div class="tx-row${n.parent ? ' is-child' : ''}" data-code="${esc(n.code)}">
        ${editable ? `<input type="checkbox" class="tx-del" data-del="${esc(n.code)}" title="勾掉就删除这一类" />` : '<span style="width:14px"></span>'}
        <span class="tx-code">${esc(n.code)}</span>
        ${editable
          ? `<input class="tx-name" data-name="${esc(n.code)}" value="${esc(n.name)}" maxlength="20" spellcheck="false" />`
          : `<span class="tx-name" style="border:0">${esc(n.name)}</span>`}
        <span class="tx-count">${n.total || 0}</span>
      </div>`)
    .join('');

  const conflicts = txConflict.length
    ? `<div class="scheme-warn">这些已有目录和草稿撞车，先改名或换方案：<br>${
      txConflict.map((c) => `「${esc(c.code)}」现有为「${esc(c.got)}」，草稿要「${esc(c.want)}」`).join('<br>')
    }</div>`
    : '';

  body.innerHTML = `
    <div class="tx-list">${rows || '<div class="hint">草稿是空的。</div>'}</div>
    ${conflicts}
    <div class="opt-row tx-actions">
      ${editable
        ? '<button type="button" class="btn btn-primary btn-sm" id="btnTxApprove">保存修改并审定</button>'
        : txDraft.status === 'approved'
          ? '<button type="button" class="btn btn-primary btn-sm" id="btnTxInstall">落成目录并启用</button>'
          : '<span class="hint">已落成目录，可以在上面切换方案或重新归纳。</span>'}
    </div>`;

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
  const removed = [...document.querySelectorAll('.tx-del:checked')].map((el) => el.dataset.del);
  const msg = $('#txStatus');
  try {
    txDraft = await send('taxonomy:approve', { renames, removed });
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
    const stripes = sysTheme.preview.map((c) => `<span style="background:${c}"></span>`).join('');
    sysHost.innerHTML = `
      <button type="button" class="theme-system-bar${active ? ' is-active' : ''}" data-theme-id="system" aria-pressed="${active}">
        <span class="theme-system-swatch">${stripes}</span>
        <span class="theme-system-info">
          <span class="theme-card-title">${esc(sysTheme.name)}</span>
          <span class="theme-card-desc">${esc(sysTheme.desc)}</span>
        </span>
        <span class="theme-card-badge">当前使用</span>
      </button>`;
  }

  box.innerHTML = namedThemes.map((th) => {
    const active = th.id === current;
    const stripes = th.preview.map((c) => `<span style="background:${c}"></span>`).join('');
    return `
      <button type="button" class="theme-card${active ? ' is-active' : ''}" data-theme-id="${th.id}" aria-pressed="${active}">
        <span class="theme-card-preview">${stripes}</span>
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
      ? `<div class="scheme-warn">这些已有文件夹的编码和方案撞车，先改名或换方案：<br>${
        plan.conflict
          .map((c) => `「${esc(c.code)}」现有为「${esc(c.got)}」，方案要「${esc(c.want)}」`)
          .join('<br>')
      }</div>`
      : '';
    box.innerHTML = `
      <div class="scheme-plan">
        <div class="scheme-plan-line">方案定义 <b>${s.missing + s.exists}</b> 个类目，其中 <b>${Math.max(0, s.missing + s.exists - (s.empty || []).length)}</b> 个现在能找到书签${
          s.conflict ? `，<b class="bad">${s.conflict} 个撞车</b>` : ''
        }</div>
        ${conflicts}
        <div class="opt-row">
          <button type="button" class="btn btn-primary btn-md" id="btnSelectScheme">选用这套方案</button>
          <button type="button" class="btn btn-line btn-sm" id="btnTrimScheme">按我的收藏裁剪</button>
          ${meta && meta.custom ? `
            <button type="button" class="btn btn-line btn-sm" id="btnExportScheme">导出此方案 JSON</button>
            <button type="button" class="btn btn-danger-ghost btn-sm" id="btnDeleteScheme">删除方案</button>
          ` : ''}
        </div>
        <div class="hint" style="margin-top:6px">「选用」只把方案设为分类规则，一个目录都不建。
        之后到书库 →「整理」→「按方案建档」，那里再选目录结构怎么来：
        <b>用方案的默认分类</b>（照方案建全，含空目录）或 <b>按我的收藏生成</b>（只建用得到的，还能派生二级）。
        「按我的收藏裁剪」是另一条路：先用本地规则铺一遍、剪掉空类目，做成草稿等你审定。</div>
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
  const bits = [];
  if (r.mapped) bits.push(`迁移 ${r.mapped} 条`);
  if (r.dropped) bits.push(`作废 ${r.dropped} 条`);
  return bits.length ? `；换方案：建议${bits.join('，')}` : '';
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

function renderScheme(scheme, parentOf = {}) {
  const box = $('#scheme');
  if (!scheme.length) {
    box.innerHTML = `<div class="scheme-empty">没找到分类文件夹。在书签栏里新建一个，标题写成「500 人工智能」这样就行。</div>`;
    return;
  }
  // 二级缩进挂在父类下面，别让拆出来的 010/020 看起来和 000 平级
  box.innerHTML = treeOrder(scheme, parentOf)
    .map((f) => `<div class="scheme-item${f.level ? ' is-sub' : ''}">
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
  box.innerHTML = `<div class="learned-list">${entries.map(([host, info]) => `
    <div class="learned-item">
      <span class="learned-host" title="${esc(host)}">${esc(host)}</span>
      <span class="learned-code">→ ${esc(info.code)}</span>
      <button type="button" class="ibtn" data-drop-learned="${esc(host)}" title="删除此偏好" style="width:22px;height:22px">${icon('x', 11)}</button>
    </div>`).join('')}</div>`;
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

/* ── 书签树备份与安全恢复 ─────────────────────── */

async function renderBackups() {
  const box = $('#backupList');
  if (!box) return;
  const list = await send('backup:list');
  if (!list.length) {
    box.innerHTML = '<div class="backup-empty">还没有备份。整理功能会在动手前自动做一份。</div>';
    return;
  }
  box.innerHTML = list
    .map((b) => {
      const when = new Date(b.at).toLocaleString('zh-CN', { hour12: false });
      return `<div class="backup-item">
        <span class="backup-when">${esc(when)}</span>
        <span class="backup-meta">${b.counts.nodes} 节点 · ${Math.round(b.bytes / 1024)} KB</span>
        <span class="backup-acts">
          <span class="backup-tag">${b.planId ? '整理前' : '手动'}</span>
          <button type="button" class="btn btn-line btn-sm" data-restore-backup="${esc(b.id)}">安全恢复</button>
          <button type="button" class="btn btn-ghost btn-sm" data-replace-backup="${esc(b.id)}">替换恢复</button>
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
        toast(`已安全恢复 ${r.bookmarks} 条书签到「${r.label}」`);
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
          r.stuck ? `（${r.stuck} 项删不掉，已跳过）` : ''
        }`);
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
