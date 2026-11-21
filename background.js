/**
 * 归藏 · service worker
 *
 * 所有需要跨域、需要 bookmarks 权限的活儿都在这里做：
 * 读书签树、移动、批量体检、调模型。UI 只管画。
 */

import { parseTree, INBOX_TITLE } from './lib/tree.js';
import { parseOptsOf, listSchemes, getScheme } from './lib/schemes.js';
import { planInstall } from './lib/scheme-install.js';
import { saveBackup, listBackups, exportBackup, clearBackups, checkBackupReady } from './lib/backup.js';
import { PROTO } from './lib/version.js';
import { checkMany } from './lib/check.js';
import { classify, classifyHeuristic, classifyWithModel, hasModel, testConnection, DEFAULT_SETTINGS } from './lib/llm.js';
import { buildPlan, dropOp, overrideOp, readyOps, MAX_CANDIDATES } from './lib/organize.js';
import { pushEntry, latestEntry, findEntry, markUndone } from './lib/journal.js';

const KEYS = ['settings', 'health', 'pending'];
const PLAN_KEY = 'plan';

/** 整理计划的生成进度（只在内存里，页面靠广播） */
let organize = { running: false, stage: '', done: 0, total: 0 };
let applyCtl = { running: false, stop: false };
const JOURNAL_KEY = 'journal';

/** 正在跑的检测，只存在内存里；页面靠它显示进度 */
let scan = { running: false, done: 0, total: 0, startedAt: 0 };
let scanAbort = null;

async function readSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/**
 * 找到「待归类」文件夹；没有就建一个。
 * 只在真要写书签时调用（保存 / 打开弹窗），读状态时不做多余副作用。
 */
async function ensureInbox(tree, schemeId) {
  // 注意：这里必须传 schemeId，否则装了字母方案后「待归类」的判定会退化
  const opts = parseOptsOf(schemeId);
  const t1 = tree || (await chrome.bookmarks.getTree());
  const p1 = parseTree(t1, opts);
  if (p1.inboxId) return { tree: t1, parsed: p1, inboxId: p1.inboxId, created: false };

  const bar = (t1[0].children || []).find((n) => !n.url) || t1[0].children[0];
  const created = await chrome.bookmarks.create({ parentId: bar.id, title: INBOX_TITLE });
  const t2 = await chrome.bookmarks.getTree();
  return { tree: t2, parsed: parseTree(t2, opts), inboxId: created.id, created: true };
}

async function loadState() {
  // 先读设置：解析要用 settings.schemeId 决定字母编码是否生效
  const store = await chrome.storage.local.get(KEYS);
  const settings = { ...DEFAULT_SETTINGS, ...(store.settings || {}) };
  const tree = await chrome.bookmarks.getTree();
  const { items, folders, scheme, inboxId } = parseTree(tree, parseOptsOf(settings.schemeId));
  const health = store.health || {};
  const pending = store.pending || {};

  // 清理已经不存在的书签，别让缓存无限长
  const alive = new Set(items.map((i) => i.id));
  let dirty = false;
  for (const id of Object.keys(health)) {
    if (!alive.has(id)) { delete health[id]; dirty = true; }
  }
  for (const id of Object.keys(pending)) {
    if (!alive.has(id)) { delete pending[id]; dirty = true; }
  }
  if (dirty) await chrome.storage.local.set({ health, pending });

  return {
    items,
    folders,
    scheme,
    inboxId,
    health,
    pending,
    settings,
    aiReady: hasModel(settings),
    scan,
  };
}

function broadcast(message) {
  // 没有页面在听的时候 sendMessage 会 reject，这里忽略即可
  chrome.runtime.sendMessage(message).catch(() => {});
}

/** 受管书签（企业策略）及其子树：Chrome 会拒绝移动，计划里先标出来 */
function collectManagedIds(tree) {
  const set = new Set();
  const walk = (node, inherited) => {
    const managed = inherited || node.unmodifiable === 'managed';
    if (managed && node.id) set.add(node.id);
    for (const c of node.children || []) walk(c, managed);
  };
  if (tree && tree[0]) walk(tree[0], false);
  return set;
}

async function readJournal() {
  const { journal } = await chrome.storage.local.get(JOURNAL_KEY);
  return Array.isArray(journal) ? journal : [];
}

/** 动手前保证有一份「不早于计划」的备份；没有就当场做一份，做不出来就抛 */
async function ensureBackupFor(plan) {
  const ready = checkBackupReady(await listBackups(), { id: plan.id, at: plan.at });
  if (ready.ok) return ready.backup;
  const settings = await readSettings();
  const tree = await chrome.bookmarks.getTree();
  const meta = await saveBackup(tree, { planId: plan.id, schemeId: settings.schemeId || '' });
  broadcast({ type: 'organize:backup-made', meta });
  return meta;
}

/** 按类目批量移动，每 25 条让出一次事件循环；随时可停 */
async function runApply() {
  if (applyCtl.running) throw new Error('上一次整理还没结束');
  const plan = await readPlan();
  const ops = readyOps(plan);
  if (!ops.length) throw new Error('计划里没有可执行的条目');

  await ensureBackupFor(plan);

  const settings = await readSettings();
  const tree = await chrome.bookmarks.getTree();
  const { scheme } = parseTree(tree, parseOptsOf(settings.schemeId));
  const folderOf = new Map(scheme.map((f) => [f.code, f.id]));

  applyCtl = { running: true, stop: false };
  broadcast({ type: 'organize:apply-start', total: ops.length });

  const done = [];
  let failed = 0;
  let stopped = false;
  for (let i = 0; i < ops.length; i += 1) {
    if (applyCtl.stop) { stopped = true; break; }
    const op = ops[i];
    const target = folderOf.get(op.to.code);
    if (!target) { failed += 1; continue; }
    try {
      const [node] = await chrome.bookmarks.get(op.id);
      await chrome.bookmarks.move(op.id, { parentId: target });
      done.push({ id: op.id, fromFolderId: node.parentId, fromIndex: node.index, toFolderId: target, code: op.to.code });
    } catch (e) {
      failed += 1;
    }
    if (i % 25 === 24) {
      broadcast({ type: 'organize:apply-progress', done: done.length + failed, total: ops.length });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const entry = {
    id: 'j' + Date.now().toString(36),
    at: Date.now(),
    planId: plan.id,
    applied: done.length,
    failed,
    ops: done,
  };
  const journal = pushEntry(await readJournal(), entry);
  await chrome.storage.local.set({ [JOURNAL_KEY]: journal });
  await chrome.storage.local.remove(PLAN_KEY);
  applyCtl = { running: false, stop: false };

  broadcast({ type: 'organize:applied', entry: { ...entry, ops: undefined, count: done.length }, failed, total: ops.length, stopped });
  broadcast({ type: 'organize:done', plan: null });
  broadcast({ type: 'state:changed' });
  return { applied: done.length, failed, journalId: entry.id };
}

/** 撤销：只把这次动过的条目 move 回原处（含 index），不碰别的书签 */
async function runUndo(journalId) {
  const list = await readJournal();
  const entry = journalId ? findEntry(list, journalId) : latestEntry(list);
  if (!entry) throw new Error('没有可撤销的整理记录');
  if (entry.undoneAt) throw new Error('这次整理已经撤销过了');

  let restored = 0;
  for (const rec of [...(entry.ops || [])].reverse()) {
    try {
      await chrome.bookmarks.move(rec.id, { parentId: rec.fromFolderId, index: rec.fromIndex });
      restored += 1;
    } catch (e) {
      // index 可能越界（原文件夹里删过东西），退一步只还原父目录
      try {
        await chrome.bookmarks.move(rec.id, { parentId: rec.fromFolderId });
        restored += 1;
      } catch (e2) {
        // 原目录被删了就真的回不去了，跳过
      }
    }
  }
  const next = markUndone(list, entry.id);
  await chrome.storage.local.set({ [JOURNAL_KEY]: next });
  broadcast({ type: 'state:changed' });
  return { restored, total: (entry.ops || []).length };
}

async function readPlan() {
  const { plan } = await chrome.storage.local.get(PLAN_KEY);
  if (!plan) throw new Error('还没有整理计划');
  return plan;
}

async function writePlan(plan) {
  await chrome.storage.local.set({ [PLAN_KEY]: plan });
  broadcast({ type: 'organize:done', plan });
  return plan;
}

/**
 * 生成整理计划：预筛 → 本地规则 → 低置信度送模型 → 冲突消解。
 * 全程只读书签，不动任何数据。
 */
async function runOrganize(scope) {
  organize = { running: true, stage: 'preselect', done: 0, total: 0 };
  broadcast({ type: 'organize:start' });
  try {
    const state = await loadState();
    const { items, scheme, settings } = state;
    if (!scheme.length) throw new Error('还没有分类目录，先到设置里装一套方案');

    const picked = (scope === 'all' ? items : items.filter((it) => !it.code)).slice(0, MAX_CANDIDATES);
    organize.total = picked.length;
    organize.done = picked.length;
    broadcast({ type: 'organize:progress', stage: 'preselect', done: picked.length, total: picked.length });

    // 本地关键词规则先跑：零成本，能定的先定
    const suggestions = {};
    for (const s of classifyHeuristic(picked, scheme)) suggestions[s.id] = { ...s };

    // 只把「本地没把握」的送去模型，别拿几千条去烧 token
    const lowConf = picked.filter((it) => (suggestions[it.id].conf || 0) < 0.55).slice(0, MAX_CANDIDATES);
    if (hasModel(settings) && lowConf.length) {
      organize.stage = 'model';
      organize.total = lowConf.length;
      organize.done = 0;
      broadcast({ type: 'organize:progress', stage: 'model', done: 0, total: lowConf.length });
      try {
        const refined = await classifyWithModel(lowConf, scheme, settings, (done, total) => {
          organize.done = done;
          broadcast({ type: 'organize:progress', stage: 'model', done, total });
        });
        for (const s of refined) suggestions[s.id] = { ...s };
      } catch (e) {
        // 模型不通不耽误出计划，退回本地规则
        broadcast({ type: 'organize:warn', message: '模型没走通，先用本地规则：' + String((e && e.message) || e) });
      }
    }

    const tree = await chrome.bookmarks.getTree();
    const plan = buildPlan({
      items,
      scheme,
      scope,
      suggestions,
      blocked: collectManagedIds(tree),
    });
    await writePlan(plan);
    return plan;
  } finally {
    organize = { running: false, stage: '', done: 0, total: 0 };
  }
}

async function moveToCode(ids, code) {
  const settings = await readSettings();
  const tree = await chrome.bookmarks.getTree();
  const { scheme } = parseTree(tree, parseOptsOf(settings.schemeId));
  const target = scheme.find((f) => f.code === code);
  if (!target) throw new Error(`找不到类目 ${code}，可能分类文件夹被改名或删除了`);
  let moved = 0;
  for (const id of ids) {
    try {
      await chrome.bookmarks.move(id, { parentId: target.id });
      moved += 1;
    } catch (e) {
      // 单条失败不打断整批
      console.warn('[归藏] 移动失败', id, e);
    }
  }
  return { moved, folderId: target.id, code, name: target.name };
}

async function runHealth(ids, opts) {
  if (scan.running) throw new Error('上一次检测还没结束');
  const state = await loadState();
  const settings = state.settings;
  const wanted = new Set(ids);
  const targets = state.items
    .filter((it) => wanted.has(it.id))
    .slice(0, Math.max(1, settings.checkLimit || 60))
    .map((it) => ({ id: it.id, url: it.url }));

  if (!targets.length) return { started: false, total: 0 };

  scanAbort = new AbortController();
  scan = { running: true, done: 0, total: targets.length, startedAt: Date.now() };
  broadcast({ type: 'scan:start', total: targets.length });

  /*
   * 结果先在内存里攒着，定时整批落盘。
   * 每完成一条就「读一次 storage 再写回去」的话，四条并发会互相覆盖，
   * 场面是：界面显示检测了 60 条，storage 里只剩十几条。
   */
  const acc = {};
  let flushing = null;
  const flush = () => {
    if (flushing) return flushing;
    const batch = { ...acc };
    for (const k of Object.keys(batch)) delete acc[k];
    flushing = chrome.storage.local
      .get('health')
      .then(({ health = {} }) => chrome.storage.local.set({ health: { ...health, ...batch } }))
      .catch(() => {})
      .finally(() => { flushing = null; });
    return flushing;
  };
  const timer = setInterval(flush, 800);

  try {
    const results = await checkMany(targets, {
      concurrency: settings.concurrency || 4,
      timeout: settings.timeout || 8000,
      signal: scanAbort.signal,
      onProgress: (done, total, id, r) => {
        scan.done = done;
        acc[id] = r;
        broadcast({ type: 'scan:progress', done, total, id, result: r });
      },
    });
    clearInterval(timer);
    await flush();
    scan = { running: false, done: Object.keys(results).length, total: targets.length, startedAt: 0 };
    broadcast({ type: 'scan:done', total: targets.length });
    return { started: true, total: targets.length };
  } catch (e) {
    clearInterval(timer);
    await flush();
    scan = { running: false, done: 0, total: 0, startedAt: 0 };
    throw e;
  }
}

/* ── 消息路由 ─────────────────────────────────── */

const handlers = {
  /** 握手：页面靠它判断后台是不是同一个版本 */
  'ping': async () => ({
    proto: PROTO,
    version: chrome.runtime.getManifest().version,
  }),

  'state:load': () => loadState(),

  'theme:get': async () => {
    const { theme = 'system' } = await chrome.storage.local.get('theme');
    return { theme };
  },

  'theme:set': async ({ theme }) => {
    await chrome.storage.local.set({ theme });
    broadcast({ type: 'theme:changed', theme });
    return { theme };
  },

  /** 弹窗/侧边栏只要摘要，别把几千条书签塞进消息通道 */
  'summary:load': async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    const { parsed, inboxId } = await ensureInbox(undefined, merged.schemeId);
    const { items, scheme } = parsed;
    const { health = {}, pending = {} } = await chrome.storage.local.get(['health', 'pending']);
    let dead = 0;
    let susp = 0;
    let unchecked = 0;
    let inbox = 0;
    for (const it of items) {
      if (!it.code) inbox += 1;
      const h = health[it.id];
      if (!h) unchecked += 1;
      else if (h.status === 'dead' || h.status === 'error' || h.status === 'timeout' || h.status === 'unreachable') dead += 1;
      else if (h.status === 'blocked') susp += 1;
    }
    return {
      scheme,
      inboxId,
      settings: merged,
      aiReady: hasModel(merged),
      counts: {
        all: items.length,
        dead,
        susp,
        unchecked,
        inbox,
        pending: Object.keys(pending).length,
      },
      recent: items.slice(0, 8).map((it) => ({
        id: it.id,
        title: it.title,
        url: it.url,
        host: it.host,
        code: it.code,
        added: it.added,
        health: health[it.id] || null,
      })),
      scan,
    };
  },

  'bookmark:save': async ({ url, title, folderId }) => {
    let parentId = folderId;
    if (!parentId) {
      const { inboxId } = await ensureInbox();
      parentId = inboxId;
    }
    const created = await chrome.bookmarks.create({ parentId, title: title || url, url });
    return { id: created.id, folderId: parentId };
  },

  'inbox:ensure': async () => {
    const { inboxId, created } = await ensureInbox();
    if (created) broadcast({ type: 'state:changed' });
    return { inboxId, created };
  },

  'bookmarks:move': async ({ ids, folderId }) => {
    let moved = 0;
    for (const id of ids) {
      try {
        await chrome.bookmarks.move(id, { parentId: folderId });
        moved += 1;
      } catch (e) {
        console.warn('[归藏] 移动失败', id, e);
      }
    }
    broadcast({ type: 'state:changed' });
    return { moved };
  },

  /** 按类目编号移动：界面里说的都是 code，只有这里知道它对应哪个 folderId */
  'bookmarks:moveCode': async ({ ids, code }) => {
    const r = await moveToCode(ids, code);
    broadcast({ type: 'state:changed' });
    return r;
  },

  'bookmarks:remove': async ({ ids }) => {
    let removed = 0;
    for (const id of ids) {
      try {
        await chrome.bookmarks.remove(id);
        removed += 1;
      } catch (e) {
        console.warn('[归藏] 删除失败', id, e);
      }
    }
    broadcast({ type: 'state:changed' });
    return { removed };
  },

  'health:run': async ({ ids }) => {
    // 不 await：立刻告诉界面"开始了"，进度靠广播
    runHealth(ids).then((r) => broadcast({ type: 'state:changed', summary: r })).catch((e) => {
      scan = { running: false, done: 0, total: 0, startedAt: 0 };
      broadcast({ type: 'scan:error', message: String(e.message || e) });
    });
    return { started: true };
  },

  'health:stop': async () => {
    if (scanAbort) scanAbort.abort();
    return { stopped: true };
  },

  /** 侧边栏只有计数，没有 id 列表，让后台自己挑没检测过的 */
  'health:runUnchecked': async () => {
    const settings = await readSettings();
    const tree = await chrome.bookmarks.getTree();
    const { items } = parseTree(tree, parseOptsOf(settings.schemeId));
    const { health = {} } = await chrome.storage.local.get('health');
    const ids = items.filter((it) => !health[it.id]).map((it) => it.id);
    if (!ids.length) return { started: false, total: 0 };
    runHealth(ids).catch((e) => broadcast({ type: 'scan:error', message: String(e.message || e) }));
    return { started: true, total: ids.length };
  },

  'health:clear': async () => {
    await chrome.storage.local.set({ health: {} });
    broadcast({ type: 'state:changed' });
    return { ok: true };
  },

  'ai:run': async ({ ids }) => {
    const state = await loadState();
    const { items, scheme, settings } = state;
    const wanted = new Set(ids);
    const targets = items.filter((it) => wanted.has(it.id)).slice(0, 80);
    if (!scheme.length) throw new Error('没找到可用分类。先在书签栏建几个类目文件夹（例如「500 人工智能」）。');
    if (!targets.length) return { suggestions: [] };

    broadcast({ type: 'ai:start', total: targets.length });
    const list = await classify(targets, scheme, settings, (done, total) => {
      broadcast({ type: 'ai:progress', done, total });
    });

    const pending = { ...state.pending };
    const at = Date.now();
    for (const s of list) pending[s.id] = { ...s, at };
    await chrome.storage.local.set({ pending });
    broadcast({ type: 'state:changed' });
    return { suggestions: list, source: hasModel(settings) ? 'model' : 'heuristic' };
  },

  'ai:accept': async ({ ids }) => {
    const { pending } = await chrome.storage.local.get('pending');
    const p = pending || {};
    const targets = ids.filter((id) => p[id]);
    const byCode = new Map();
    for (const id of targets) {
      const code = p[id].code;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(id);
    }
    let moved = 0;
    for (const [code, group] of byCode) {
      const r = await moveToCode(group, code);
      moved += r.moved;
      group.forEach((id) => delete p[id]);
    }
    await chrome.storage.local.set({ pending: p });
    broadcast({ type: 'state:changed' });
    return { moved };
  },

  'ai:ignore': async ({ ids }) => {
    const { pending } = await chrome.storage.local.get('pending');
    const p = pending || {};
    ids.forEach((id) => delete p[id]);
    await chrome.storage.local.set({ pending: p });
    broadcast({ type: 'state:changed' });
    return { ok: true };
  },

  'ai:ignoreAll': async () => {
    await chrome.storage.local.set({ pending: {} });
    broadcast({ type: 'state:changed' });
    return { ok: true };
  },

  'ai:suggestOne': async ({ url, title, fast }) => {
    const tree = await chrome.bookmarks.getTree();
    const { scheme } = parseTree(tree);
    const settings = await readSettings();
    const fake = [{ id: 'tmp', title: title || url, url, host: hostOf(url), code: '' }];
    const folderFor = (code) => (scheme.find((f) => f.code === code) || {}).id || null;

    if (!fast && hasModel(settings)) {
      try {
        const [s] = await classify(fake, scheme, settings);
        return { code: s.code, conf: s.conf, reason: s.reason, source: 'model', folderId: folderFor(s.code) };
      } catch (e) {
        const [s] = classifyHeuristic(fake, scheme);
        return {
          code: s.code, conf: s.conf, reason: '模型不可用，用了本地规则', source: 'heuristic',
          folderId: folderFor(s.code), error: String(e.message || e),
        };
      }
    }
    const [s] = classifyHeuristic(fake, scheme);
    return { code: s.code, conf: s.conf, reason: s.reason, source: 'heuristic', folderId: folderFor(s.code) };
  },

  'settings:save': async ({ settings }) => {
    const next = { ...(await readSettings()), ...settings };
    await chrome.storage.local.set({ settings: next });
    broadcast({ type: 'state:changed' });
    return { settings: next };
  },

  'settings:test': async ({ settings }) => {
    const merged = { ...(await readSettings()), ...(settings || {}) };
    const raw = await testConnection(merged);
    return { ok: true, raw };
  },

  /** 可选方案清单 + 当前装的是哪套 */
  'schemes:list': async () => ({
    schemes: listSchemes(),
    current: (await readSettings()).schemeId || '',
  }),

  /** 预检：不出手，只算「会建几个 / 复用几个 / 有几个撞车」 */
  'scheme:preview': async ({ schemeId }) => {
    const scheme = getScheme(schemeId);
    if (!scheme) throw new Error('没有这个方案');
    const tree = await chrome.bookmarks.getTree();
    return planInstall(tree, scheme);
  },

  'organize:plan': async ({ scope = 'inbox' } = {}) => {
    if (organize.running) throw new Error('上一次整理计划还在生成');
    runOrganize(scope).catch((e) => broadcast({ type: 'organize:error', message: String((e && e.message) || e) }));
    return { started: true };
  },

  'organize:load': async () => {
    const { plan } = await chrome.storage.local.get(PLAN_KEY);
    return { plan: plan || null, running: organize.running, applying: applyCtl.running, stopping: applyCtl.stop };
  },

  /** 执行计划。备份闸门在这里：没有合规备份就当场做一份，做不出来才拒绝。 */
  'organize:apply': async () => {
    runApply().catch((e) => {
      applyCtl = { running: false, stop: false };
      broadcast({ type: 'organize:error', message: String((e && e.message) || e) });
    });
    return { started: true };
  },

  'organize:stop': async () => {
    applyCtl.stop = true;
    return { stopping: true };
  },

  'organize:undo': async ({ journalId } = {}) => runUndo(journalId),

  'organize:journal': async () => {
    const list = await readJournal();
    return {
      latest: latestEntry(list),
      list: list.map(({ ops, ...rest }) => ({ ...rest, count: (ops || []).length })),
    };
  },

  'organize:cancel': async () => {
    await chrome.storage.local.remove(PLAN_KEY);
    broadcast({ type: 'organize:done', plan: null });
    return { ok: true };
  },

  'organize:drop': async ({ id }) => {
    const plan = await readPlan();
    const next = dropOp(plan, id);
    await writePlan(next);
    return next;
  },

  'organize:override': async ({ id, code }) => {
    const plan = await readPlan();
    const next = overrideOp(plan, id, code);
    await writePlan(next);
    return next;
  },

  /** 整理前的退路：整树结构化快照，环形保留 3 份 */
  'backup:run': async ({ planId = '' } = {}) => {
    const settings = await readSettings();
    const tree = await chrome.bookmarks.getTree();
    return saveBackup(tree, { planId, schemeId: settings.schemeId || '' });
  },

  'backup:list': async () => listBackups(),

  'backup:export': async ({ id }) => {
    const list = await listBackups();
    const target = id || (list[0] && list[0].id);
    if (!target) throw new Error('还没有备份可导出');
    return exportBackup(target);
  },

  'backup:clear': async () => clearBackups(),

  /** 闸门：后台自己校验，不靠界面自觉。没有合规备份就返回 NEED_BACKUP。 */
  'backup:check': async ({ planId = '', planAt = 0 }) => checkBackupReady(await listBackups(), { id: planId, at: planAt }),

  /**
   * 安装：按 code 复用已有目录，只建缺的。
   * 有冲突就一个都不建，把冲突原样返回给界面处理。
   */
  'scheme:install': async ({ schemeId }) => {
    const scheme = getScheme(schemeId);
    if (!scheme) throw new Error('没有这个方案');
    const tree = await chrome.bookmarks.getTree();
    const plan = planInstall(tree, scheme);
    if (plan.conflict.length) return { installed: false, conflict: plan.conflict, plan };

    for (const f of plan.missing) {
      await chrome.bookmarks.create({ parentId: plan.barId, title: `${f.code} ${f.name}` });
    }
    const next = { ...(await readSettings()), schemeId };
    await chrome.storage.local.set({ settings: next });
    broadcast({ type: 'state:changed' });
    return { installed: true, created: plan.missing.length, reused: plan.exists.length, schemeId };
  },

  'bookmarks:update': async ({ id, title, url }) => {
    const changes = {};
    if (title != null) changes.title = title;
    if (url != null) changes.url = url;

    // 地址变了，之前的检测结论描述的是另一个页面，留着会误导
    let urlChanged = false;
    if (url != null) {
      try {
        const before = await chrome.bookmarks.get(id);
        urlChanged = Boolean(before && before[0] && before[0].url !== url);
      } catch {
        urlChanged = true;
      }
    }

    const updated = await chrome.bookmarks.update(id, changes);

    if (urlChanged) {
      const { health = {} } = await chrome.storage.local.get('health');
      if (health[id]) {
        delete health[id];
        await chrome.storage.local.set({ health });
      }
    }

    broadcast({ type: 'state:changed' });
    return { id: updated.id, title: updated.title, url: updated.url, urlChanged };
  },

  'bookmark:check': async ({ url }) => {
    if (!url) return { exists: false, items: [] };
    const items = await chrome.bookmarks.search({ url });
    return { exists: items && items.length > 0, items: items || [] };
  },

  'bookmarks:restore': async ({ items }) => {
    let restored = 0;
    for (const it of items || []) {
      try {
        if (it.type === 'move') {
          // 移动还原
          await chrome.bookmarks.move(it.id, { parentId: it.oldParentId });
          restored += 1;
        } else if (it.type === 'delete') {
          // 删除还原：重新创建书签
          await chrome.bookmarks.create({
            parentId: it.parentId || '1',
            title: it.title,
            url: it.url,
            index: it.index,
          });
          restored += 1;
        }
      } catch (e) {
        console.warn('[归藏] 撤销还原失败', it, e);
      }
    }
    broadcast({ type: 'state:changed' });
    return { restored };
  },

  'open:manager': async ({ view, drawer, id, hash } = {}) => {
    const managerUrlPrefix = chrome.runtime.getURL('ui/manager.html');
    let targetHash = hash || '';
    if (!targetHash) {
      const parts = [];
      if (view) parts.push(`view=${encodeURIComponent(view)}`);
      if (drawer) parts.push(`drawer=${encodeURIComponent(drawer)}`);
      if (id) parts.push(`id=${encodeURIComponent(id)}`);
      targetHash = parts.join('&');
    }
    const targetUrl = targetHash ? `${managerUrlPrefix}#${targetHash}` : managerUrlPrefix;

    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => t.url && t.url.startsWith(managerUrlPrefix));
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true, url: targetUrl });
      if (existing.windowId && chrome.windows?.update) {
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      }
      return { ok: true, reused: true };
    }
    await chrome.tabs.create({ url: targetUrl });
    return { ok: true, created: true };
  },
};

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // 异步回应
});

/* 书签被外部改动时让界面刷新 */
chrome.bookmarks.onCreated.addListener(() => broadcast({ type: 'state:changed' }));
chrome.bookmarks.onRemoved.addListener((id, info) => {
  // 被删的是文件夹时，其子树里的缓存也一起清掉
  chrome.storage.local.get(['health', 'pending']).then(({ health = {}, pending = {} }) => {
    let dirty = false;
    if (health[id]) { delete health[id]; dirty = true; }
    if (pending[id]) { delete pending[id]; dirty = true; }
    (info.node.children || []).forEach((c) => {
      if (health[c.id]) { delete health[c.id]; dirty = true; }
      if (pending[c.id]) { delete pending[c.id]; dirty = true; }
    });
    if (dirty) chrome.storage.local.set({ health, pending });
  });
  broadcast({ type: 'state:changed' });
});
chrome.bookmarks.onChanged.addListener(() => broadcast({ type: 'state:changed' }));

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const s = await readSettings();
    await chrome.storage.local.set({ settings: s });
    // 第一次装就把「待归类」建好，用户收藏时不用先想放哪
    await ensureInbox().catch(() => {});
  }
});
