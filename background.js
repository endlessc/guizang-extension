/**
 * 归藏 · service worker
 *
 * 所有需要跨域、需要 bookmarks / omnibox / contextMenus / commands / optional(history, alarms)
 * 的活儿都在这里做：读书签树、移动、批量体检、调模型、地址栏秒搜、右键快收、定期静默体检。
 */

import { parseTree, INBOX_TITLE } from './lib/tree.js';
import { parseOptsOf, listSchemes, getScheme, sanitizeCustomScheme } from './lib/schemes.js';
import { planInstall } from './lib/scheme-install.js';
import {
  saveBackup, listBackups, exportBackup, clearBackups,
  checkBackupReady, readBackup, validateSnapshot, rebuildSubtree,
} from './lib/backup.js';
import { PROTO } from './lib/version.js';
import { checkMany } from './lib/check.js';
import {
  classify, classifyHeuristic, classifyWithModel, designSkeleton, cleanTitles,
  callModel, buildSubNamesMessages, parseSubNames, buildSubAssignMessages, parseSubAssign,
  hasModel, testConnection, DEFAULT_SETTINGS, PROMPT_VERSION, SELECTIVE_THRESHOLD,
} from './lib/llm.js';
import { buildPlan, dropOp, overrideOp, readyOps, preselect, foldersForCodes, planFolders, applySubs, deriveSubs, schemeCreated, extendTargets, leftoverFolders, estimateLeftovers, sampleOps, splitSubs, recount, MAX_CANDIDATES } from './lib/organize.js';
import { pushEntry, latestEntry, findEntry, markUndone } from './lib/journal.js';
import { createWal, appendSteps, walSummary, rollbackSteps, walToJournal, classifyMoveStep, shouldRollbackStep } from './lib/wal.js';
import { migratePending, prunePending } from './lib/pending.js';
import {
  createTaxonomy, pruneTaxonomy, normalizeNames, buildTaxonomyFromSkeleton, sampleForSkeleton, assignByRules,
  approveTaxonomy, toScheme, planExtend, applyExtend, acceptProposals, coverageOf, nodesFromScheme,
} from './lib/taxonomy.js';
import { normalizeUrl, findDuplicates, duplicateIdSet } from './lib/dedup.js';
import { buildOmniboxSuggestions } from './lib/search.js';
import {
  normalizeMeta, pruneMeta, remapRecordById, emptyLearned, recordOverride,
  removeLearnedDomain, migrateLearned, analyzeUsage, pickSerendipity,
} from './lib/meta.js';
import { fetchPageHead, isWeakTitle, lookupWayback } from './lib/head.js';

const KEYS = ['settings', 'health', 'pending', 'meta', 'learned', 'usageCache'];
const PLAN_KEY = 'plan';
const WAL_KEY = 'organizeWal';
const JOURNAL_KEY = 'journal';
const TAXONOMY_KEY = 'taxonomyDraft';
let taxo = { running: false, stage: '', done: 0, total: 0 };
const WEEKLY_ALARM = 'guizang-weekly-check';

/** 整理计划的生成进度（只在内存里，页面靠广播） */
let organize = { running: false, stage: '', done: 0, total: 0 };
let applyCtl = { running: false, stop: false };
let orgCtl = { stop: false };   // 计划生成阶段的中断开关
let aiCtl = { stop: false };    // AI 归类的中断开关

/** 正在跑的检测，只存在内存里；页面靠它显示进度 */
let scan = { running: false, done: 0, total: 0, startedAt: 0 };
let scanAbort = null;

async function readSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function parseOptsFor(settings) {
  return parseOptsOf(settings.schemeId, settings.customSchemes || []);
}

/**
 * 统一的受控分类词表解析：「分类法（scheme）是源，目录（folderScheme）是投影」。
 * 只要选用了方案，所有分类入口统一以方案类目（含挂在其下的现存二级）为词表；
 * 仅在没选方案时退回现存目录。fresh 模式只看新方案本身，不混入旧二级。
 */
function resolveClassifyTargets(settings, folderScheme = [], parentOf = {}, { fresh = false } = {}) {
  const full = getScheme(settings && settings.schemeId, (settings && settings.customSchemes) || []);
  if (!full) return folderScheme;
  if (fresh) {
    return full.folders.map((f) => ({ code: f.code, name: f.name, hint: f.hint || '', parent: f.parent || null }));
  }
  return extendTargets(full.folders, folderScheme, parentOf);
}

async function readLearned() {
  const { learned } = await chrome.storage.local.get('learned');
  return learned && learned.domains ? learned : emptyLearned();
}

/**
 * 找到「待归类」文件夹；没有就建一个。
 * 只在真要写书签时调用（保存 / 打开弹窗），读状态时不做多余副作用。
 */
async function ensureInbox(tree, settings) {
  const s = settings || (await readSettings());
  const opts = parseOptsFor(s);
  const t1 = tree || (await chrome.bookmarks.getTree());
  const p1 = parseTree(t1, opts);
  if (p1.inboxId) return { tree: t1, parsed: p1, inboxId: p1.inboxId, created: false };

  const bar = (t1[0].children || []).find((n) => !n.url) || t1[0].children[0];
  const created = await chrome.bookmarks.create({ parentId: bar.id, title: INBOX_TITLE });
  const t2 = await chrome.bookmarks.getTree();
  return { tree: t2, parsed: parseTree(t2, opts), inboxId: created.id, created: true };
}

async function loadState() {
  const store = await chrome.storage.local.get(KEYS);
  const settings = { ...DEFAULT_SETTINGS, ...(store.settings || {}) };
  const tree = await chrome.bookmarks.getTree();
  const { items, folders, folderScheme, inboxId, parentOf } = parseTree(tree, parseOptsFor(settings));
  const health = store.health || {};
  const pending = store.pending || {};
  const rawMeta = store.meta || {};
  const learned = store.learned && store.learned.domains ? store.learned : emptyLearned();
  const usageCache = store.usageCache || null;

  // 清理已经不存在的书签缓存
  const alive = new Set(items.map((i) => i.id));
  let dirty = false;
  for (const id of Object.keys(health)) {
    if (!alive.has(id)) { delete health[id]; dirty = true; }
  }
  for (const id of Object.keys(pending)) {
    if (!alive.has(id)) { delete pending[id]; dirty = true; }
  }
  // 目标编码既不在现存目录也不在当前启用方案里 → 建议作废，别让它一直挂着
  const activeTargets = resolveClassifyTargets(settings, folderScheme, parentOf);
  const codes = new Set([
    ...folderScheme.map((f) => f.code),
    ...activeTargets.map((f) => f.code),
  ]);
  const stale = prunePending(pending, codes);
  if (stale.dropped) {
    for (const id of Object.keys(pending)) {
      if (!Object.prototype.hasOwnProperty.call(stale.pending, id)) delete pending[id];
    }
    dirty = true;
  }
  const pruned = pruneMeta(rawMeta, alive);
  if (dirty || pruned.dirty) {
    await chrome.storage.local.set({ health, pending, meta: pruned.meta });
  }

  return {
    items,
    folders,
    folderScheme,
    parentOf,
    inboxId,
    health,
    pending,
    pendingDropped: stale.dropped || 0,
    meta: pruned.meta,
    learned,
    usageCache,
    settings,
    aiReady: hasModel(settings),
    wal: walSummary(await readWal()),
    scan,
  };
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

/** 扩展图标徽标提示：只在有新失效或快收反馈时轻亮 */
async function flashBadge(text, color = '#1E4468', durationMs = 2400) {
  if (!chrome.action?.setBadgeText) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text: String(text) });
    if (durationMs > 0) {
      setTimeout(() => {
        chrome.action.setBadgeText({ text: '' }).catch(() => {});
      }, durationMs);
    }
  } catch {}
}

/** 为信息量过弱的条目并发流式抓取 <head> 摘要（最多 16 条，避免拖慢归类） */
async function enrichWeakHeads(items, settings) {
  if (!settings.fetchHeadOnAi) return {};
  const weak = items.filter((it) => isWeakTitle(it.title, it.url) && /^https?:/i.test(it.url)).slice(0, 16);
  if (!weak.length) return {};
  const pageMeta = {};
  const queue = weak.slice();
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const it = queue.shift();
      const head = await fetchPageHead(it.url, { timeout: 4500 });
      if (head && (head.title || head.desc)) pageMeta[it.id] = head;
    }
  });
  await Promise.all(workers);
  return pageMeta;
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

async function readWal() {
  const { [WAL_KEY]: wal } = await chrome.storage.local.get(WAL_KEY);
  return wal || null;
}

async function writeWal(wal) {
  if (!wal) { await chrome.storage.local.remove(WAL_KEY); return null; }
  await chrome.storage.local.set({ [WAL_KEY]: wal });
  return wal;
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

/**
 * 两段式拆二级：① 抽样定 2–5 个子类名；② 按 40 条一块对号入座。
 * 每块输出都很小，一二百条的大类目也不会撞 max_tokens。
 */
async function splitByModel(parent, items, settings, { chunk = 40, sampleSize = 60 } = {}) {
  const topName = String((parent && parent.name) || '');
  const sample = sampleOps(items, sampleSize);
  const names = parseSubNames(
    await callModel(settings, buildSubNamesMessages(topName, sample), { maxTokens: 800 }),
  );
  const assign = {};
  let badChunks = 0;
  for (let i = 0; i < items.length; i += chunk) {
    const part = items.slice(i, i + chunk);
    try {
      const got = parseSubAssign(
        await callModel(settings, buildSubAssignMessages(topName, names, part), { maxTokens: 1600 }),
        part,
        names.length,
      );
      Object.assign(assign, got);
    } catch {
      badChunks += 1;
    }
  }
  return {
    subs: splitSubs(parent && parent.code, names),
    assign,
    badChunks,
    model: String(settings.model || ''),
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * 统一的提交入口：prepare（备份 / 冲突校验）→ commit（建目录 / 幂等搬条目）→ 记录。
 *
 * 四条业务路径都走这里：
 *   organize:apply        ops=计划里可执行的条目，folders=这些条目要用的目录
 *   ai:accept             ops=已确认的待归类建议，folders=按需投影的目录
 *   taxonomy:install      ops=[]（只建目录），folders=方案里的全部类目
 *   organize:splitFolder  先出计划经人确认，再按 apply 走
 */
async function commitOps({
  planId = '', planAt = Date.now(), folders = [], ops = [],
  backup = true, journal = true, scope = 'inbox', progress = false,
  stageConflicts = false,
} = {}) {
  if (backup) await ensureBackupFor({ id: planId || 'adhoc' + planAt.toString(36), at: planAt });

  const settings = await readSettings();
  let tree = await chrome.bookmarks.getTree();
  let { folderScheme } = parseTree(tree, parseOptsFor(settings));
  let folderOf = new Map(folderScheme.map((f) => [f.code, f.id]));

  // prepare：缺的目录按「父在前」建；同码异名默认一律拦下（仅 fresh 重建允许暂移旧目录名，撤销时还原）
  const dedupFolders = [];
  const seenFolderCodes = new Set();
  for (const f of folders || []) {
    if (!f || !f.code || seenFolderCodes.has(f.code)) continue;
    seenFolderCodes.add(f.code);
    dedupFolders.push(f);
  }
  let created = 0;
  let createdFolders = [];          // 本次真建出来的目录：撤销时把空的一并拆掉
  const stagedFolders = [];         // fresh 跨方案重建时暂改名的同码冲突旧目录
  let reused = folderScheme.length;
  if (dedupFolders.length) {
    const kind = dedupFolders.every((f) => /^\d+$/.test(f.code)) ? 'digit' : 'letter';
    // 必须交整份 folders：父目录不在 exists 里时，createFolders 找不到 parentId 会跳过子目录
    let inst = planInstall(tree, { id: 'adhoc', kind, folders: dedupFolders });
    if (inst.conflict.length && stageConflicts) {
      // 全新生成跨方案同码异名（如杜威 100 编程 → PARA 100 项目）：先暂改旧目录名腾出编码，搬空后清理
      for (const c of inst.conflict) {
        try {
          const [node] = await chrome.bookmarks.get(c.folderId);
          const tempTitle = `旧·${node.title}`;
          await chrome.bookmarks.update(c.folderId, { title: tempTitle });
          stagedFolders.push({ id: c.folderId, code: c.code, oldTitle: node.title, tempTitle });
        } catch {}
      }
      tree = await chrome.bookmarks.getTree();
      inst = planInstall(tree, { id: 'adhoc', kind, folders: dedupFolders });
    }
    if (inst.conflict.length) {
      return {
        conflict: inst.conflict,
        created: 0, reused, moved: 0, skippedAlready: 0, skippedConflict: 0,
        failed: 0, stopped: false, journalId: '', movedIds: [], alreadyIds: [], stagedFolders,
      };
    }
    if (inst.missing.length) {
      const made = await createFolders(inst);
      created = made.made;
      createdFolders = [...made.created.entries()].map(([code, id]) => ({ code, id }));
      tree = await chrome.bookmarks.getTree();
      ({ folderScheme } = parseTree(tree, parseOptsFor(settings)));
      folderOf = new Map(folderScheme.map((f) => [f.code, f.id]));
    }
  }

  // commit：幂等搬条目（没有 ops 时只建目录，如 taxonomy:install）
  // 真 WAL：每批 25 条，先把「从哪到哪」的意图落盘，再动手；崩在中间可以按意图回滚
  let moved = 0;
  let skippedAlready = 0;
  let skippedConflict = 0;
  let failed = 0;
  let stopped = false;
  const done = [];
  const alreadyIds = [];
  let wal = null;
  if (ops.length) {
    applyCtl = { running: true, stop: false };
    wal = await writeWal(createWal({ planId, scope, total: ops.length }));
    if (progress) broadcast({ type: 'organize:apply-start', total: ops.length });

    const BATCH_MOVE = 25;
    for (let i = 0; i < ops.length; i += BATCH_MOVE) {
      if (applyCtl.stop) { stopped = true; break; }
      const chunk = ops.slice(i, i + BATCH_MOVE);
      const steps = [];
      for (const op of chunk) {
        const code = op.to && op.to.sub ? op.to.sub.code : op.to && op.to.code;
        const target = folderOf.get(code);
        if (!target) { failed += 1; continue; }
        let node = null;
        try {
          [node] = await chrome.bookmarks.get(op.id);
        } catch {
          node = null;
        }
        const verdict = classifyMoveStep(op, node, target);
        if (verdict === 'already') { skippedAlready += 1; alreadyIds.push(op.id); continue; }
        if (verdict === 'conflict') { skippedConflict += 1; failed += 1; continue; }
        if (verdict !== 'move') { failed += 1; continue; }
        steps.push({ id: op.id, fromFolderId: node.parentId, fromIndex: node.index, toFolderId: target, code });
      }
      if (!steps.length) {
        if (progress) {
          broadcast({ type: 'organize:apply-progress', done: moved + skippedAlready + failed, total: ops.length });
        }
        continue;
      }

      wal = await writeWal(appendSteps(wal, steps));   // ← 动手之前先落盘
      for (const step of steps) {
        try {
          await chrome.bookmarks.move(step.id, { parentId: step.toFolderId });
          done.push(step);
          moved += 1;
        } catch {
          failed += 1;
        }
      }
      if (progress) {
        broadcast({ type: 'organize:apply-progress', done: moved + skippedAlready + failed, total: ops.length });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    applyCtl = { running: false, stop: false };
  }

  // 记录：只有真的动过条目（或建了/改了目录）才写撤销日志；写完才算 committed，WAL 清理掉
  let journalId = '';
  if (journal && (done.length || createdFolders.length || stagedFolders.length)) {
    const entry = walToJournal({ ...(wal || createWal({ planId, scope, total: ops.length })), steps: done }, {
      id: 'j' + Date.now().toString(36), at: Date.now(), failed, stopped,
    });
    entry.createdFolders = createdFolders;   // 撤销时据此清掉本次新建的空目录
    if (stagedFolders.length) entry.renamedFolders = stagedFolders;
    const list = pushEntry(await readJournal(), entry);
    await chrome.storage.local.set({ [JOURNAL_KEY]: list });
    journalId = entry.id;
    if (progress) {
      broadcast({
        type: 'organize:applied',
        entry: { ...entry, ops: undefined, count: done.length },
        failed, total: ops.length, stopped,
      });
    }
  }
  if (wal) await writeWal(null);

  return {
    conflict: [],
    created,
    reused,
    moved,
    skippedAlready,
    skippedConflict,
    failed,
    stopped,
    journalId,
    movedIds: done.map((s) => s.id),
    alreadyIds,
    stagedFolders,
    total: ops.length,
  };
}

/**
 * 换方案 / 修改当前方案时的统一模式迁移：
 *   1. pending 建议：按旧类名 → 新方案同名类目显式映射，其余显式作废并计数
 *   2. learned 域名记忆：同理按类名迁移或作废，杜绝杜威 100 串台到 PARA 100
 *   3. 未执行的整理计划 plan：旧方案计划立即显式作废清空并广播，防止按旧码执行
 */
async function migrateSchemeState(fromId, toId, customs = [], { fromFolders = null, force = false } = {}) {
  if (!force && (fromId || '') === (toId || '')) {
    return { changed: false, mapped: 0, dropped: 0, learnedMapped: 0, learnedDropped: 0, planCleared: false };
  }
  const store = await chrome.storage.local.get(['pending', 'learned', PLAN_KEY]);
  const pending = store.pending || {};
  const learned = store.learned && store.learned.domains ? store.learned : emptyLearned();
  const hasPlan = Boolean(store[PLAN_KEY]);

  let from = Array.isArray(fromFolders) ? fromFolders : (getScheme(fromId || '', customs) || {}).folders || null;
  if (!from || !from.length) {
    // 首次从「未选方案（现存目录）」切到正式方案时，拿当前书签树识别出的目录类名做桥接
    try {
      const tree = await chrome.bookmarks.getTree();
      from = parseTree(tree, parseOptsOf(fromId || '', customs)).folderScheme;
    } catch {
      from = [];
    }
  }
  const to = (getScheme(toId || '', customs) || {}).folders || [];

  const pendRes = Object.keys(pending).length
    ? migratePending(pending, { from, to })
    : { pending, mapped: 0, dropped: 0 };
  const learnRes = Object.keys(learned.domains).length
    ? migrateLearned(learned, { from, to })
    : { learned, mapped: 0, dropped: 0 };

  const patch = {};
  if (Object.keys(pending).length) patch.pending = pendRes.pending;
  if (Object.keys(learned.domains).length) patch.learned = learnRes.learned;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (hasPlan) {
    await chrome.storage.local.remove(PLAN_KEY);
    broadcast({ type: 'organize:done', plan: null });
  }
  return {
    changed: true,
    mapped: pendRes.mapped,
    dropped: pendRes.dropped,
    learnedMapped: learnRes.mapped,
    learnedDropped: learnRes.dropped,
    planCleared: hasPlan,
  };
}

/** 整理计划提交：薄封装，负责挑可执行条目、清计划与广播 */
async function runApply({ includeUnsure = false } = {}) {
  if (applyCtl.running) throw new Error('上一次整理还没结束');
  const plan = await readPlan();
  const ops = readyOps(plan, { includeUnsure });
  if (!ops.length) throw new Error('计划里没有可执行的条目');

  let folders = planFolders(plan, ops);
  // 默认分类：方案里没建过的类目也一起建（哪怕这轮没有书签落进去）
  if (plan.tree === 'scheme') folders = [...folders, ...(plan.scheme || [])];
  const res = await commitOps({
    planId: plan.id,
    planAt: plan.at,
    folders,
    ops,
    backup: true,
    journal: true,
    scope: plan.scope || 'inbox',
    progress: true,
    stageConflicts: plan.tree === 'fresh',
  });

  // 同码异名：prepare 阶段一个目录都不建、一条都不搬。别当成「成功执行 0 条」悄悄收场
  if (res.conflict.length) {
    const codes = res.conflict.map((c) => `${c.code}（现名「${c.got}」，计划里叫「${c.want}」）`).join('、');
    throw new Error(`目标目录对不上：${codes}。多半是计划生成后目录被改名了，重新生成计划再执行`);
  }

  // 全新生成：搬完之后清掉搬空的旧类目目录（含因同码冲突暂改名的旧目录）。只删空的，删一个记一个，撤销时按原名重建
  let removed = [];
  const stillRenamed = [];
  if (plan.tree === 'fresh' && res.journalId) {
    const settings = await readSettings();
    const parsed = parseTree(await chrome.bookmarks.getTree(), parseOptsFor(settings));
    const stagedById = new Map((res.stagedFolders || []).map((s) => [s.id, s]));
    const candidates = [
      ...leftoverFolders(parsed.folderScheme, parsed.items, planCodes(plan)),
      ...(res.stagedFolders || []).map((s) => ({ id: s.id, code: s.code, name: s.oldTitle, depth: 0 })),
    ];
    const seenRm = new Set();
    for (const f of candidates) {
      if (!f || !f.id || seenRm.has(f.id)) continue;
      seenRm.add(f.id);
      try {
        const [node] = await chrome.bookmarks.get(f.id);
        const kids = await chrome.bookmarks.getChildren(f.id);
        if (kids && kids.length) {
          if (stagedById.has(f.id)) stillRenamed.push(stagedById.get(f.id));
          continue;
        }
        await chrome.bookmarks.remove(f.id);
        const origTitle = stagedById.has(f.id) ? stagedById.get(f.id).oldTitle : node.title;
        removed.push({
          id: f.id, title: origTitle, parentId: node.parentId, index: node.index || 0, depth: f.depth || 0,
        });
      } catch {
        if (stagedById.has(f.id)) stillRenamed.push(stagedById.get(f.id));
      }   // 不空 / 已被删掉 / 受管：跳过，绝不为了「干净」硬删
    }
    if (removed.length || (res.stagedFolders && res.stagedFolders.length)) {
      const list = await readJournal();
      const hit = findEntry(list, res.journalId);
      if (hit) {
        const next = list.map((e) => (e.id === res.journalId
          ? {
            ...e,
            folders: [...removed].sort((a, b) => (a.depth || 0) - (b.depth || 0)),
            removedFolders: removed.length,
            renamedFolders: stillRenamed,
          }
          : e));
        await chrome.storage.local.set({ [JOURNAL_KEY]: next });
      }
    }
  }

  await chrome.storage.local.remove(PLAN_KEY);
  broadcast({ type: 'organize:done', plan: null });
  broadcast({ type: 'state:changed' });
  return {
    applied: res.moved,
    skippedAlready: res.skippedAlready || 0,
    skippedConflict: res.skippedConflict || 0,
    failed: res.failed,
    journalId: res.journalId,
    created: res.created,
    removed: removed.length,
  };
}

/** 新结构里的全部编码：一级 + 派生出来的二级。清理旧目录时这些一律保留 */
function planCodes(plan) {
  return new Set([
    ...((plan && plan.scheme) || []).map((f) => f.code),
    ...Object.values((plan && plan.subs) || {}).flatMap((list) => (list || []).map((s) => s.code)),
  ]);
}

/** 撤销：只把这次动过的条目 move 回原处（含 index），不碰别的书签 */
async function runUndo(journalId) {
  const list = await readJournal();
  const entry = journalId ? findEntry(list, journalId) : latestEntry(list);
  if (!entry) throw new Error('没有可撤销的整理记录');
  if (entry.undoneAt) throw new Error('这次整理已经撤销过了');

  // 全新生成会删掉搬空的旧目录：先按记录把目录建回来，拿到新旧 id 映射，书签才搬得回去
  const folderMap = new Map();
  let rebuilt = 0;
  for (const f of [...(entry.folders || [])].sort((a, b) => (a.depth || 0) - (b.depth || 0))) {
    try {
      const node = await chrome.bookmarks.create({
        parentId: folderMap.get(f.parentId) || f.parentId,
        title: f.title,
        index: f.index,
      });
      folderMap.set(f.id, node.id);
      rebuilt += 1;
    } catch {}   // 父目录也找不回来就跳过；能恢复多少恢复多少
  }

  let restored = 0;
  for (const rec of [...(entry.ops || [])].reverse()) {
    const back = folderMap.get(rec.fromFolderId) || rec.fromFolderId;
    try {
      await chrome.bookmarks.move(rec.id, { parentId: back, index: rec.fromIndex });
      restored += 1;
    } catch {
      try {
        await chrome.bookmarks.move(rec.id, { parentId: back });
        restored += 1;
      } catch {}
    }
  }
  // 本次新建的目录：条目都搬走了就应该一并拆掉，否则撤销完还会剩一堆空目录。
  // 只删「空了」的：这些目录里若被你后来放过别的东西，chrome 会拒绝，跳过即可。
  let removedCreated = 0;
  const createdList = [...(entry.createdFolders || [])].reverse();
  for (let pass = 0; pass < 2 && createdList.length; pass += 1) {
    for (const f of createdList) {
      try {
        await chrome.bookmarks.remove(f.id);
        removedCreated += 1;
      } catch {}
    }
  }

  // 若全新生成曾因同码异名暂改旧目录名且该旧目录未删掉，撤销时把原名改回去
  for (const rf of entry.renamedFolders || []) {
    if (!rf || !rf.id || !rf.oldTitle) continue;
    try {
      await chrome.bookmarks.update(rf.id, { title: rf.oldTitle });
    } catch {}
  }

  const next = markUndone(list, entry.id);
  await chrome.storage.local.set({ [JOURNAL_KEY]: next });
  broadcast({ type: 'state:changed' });
  return { restored, rebuilt, removedCreated, total: (entry.ops || []).length };
}

/** 分类法设计流水线：只读语料 + 一次模型调用，不碰书签 */
async function runDesign({ parentSchemeId = '', sampleSize = 200 }) {
  if (taxo.running) throw new Error('上一次归纳还没结束');
  taxo = { running: true, stage: 'sample', done: 0, total: 0 };
  broadcast({ type: 'taxonomy:start' });
  try {
    const state = await loadState();
    const { items, settings } = state;
    if (!hasModel(settings)) throw new Error('归纳分类法需要模型，先在设置里填 API Key');
    if (items.length < 30) throw new Error('书签太少，先攒够 30 条再归纳');

    const sample = sampleForSkeleton(items, sampleSize);
    taxo = { running: true, stage: 'model', done: 0, total: sample.length };
    broadcast({ type: 'taxonomy:progress', stage: 'model', done: 0, total: sample.length });

    const skeleton = await designSkeleton(sample, settings, { maxTop: 10, maxPerTop: 4 });

    taxo = { running: true, stage: 'assign', done: 0, total: items.length };
    broadcast({ type: 'taxonomy:progress', stage: 'assign', done: 0, total: items.length });

    const built = buildTaxonomyFromSkeleton(skeleton, { parentSchemeId });
    const { map, unmatched } = assignByRules(items, built.nodes);
    const nodes = built.nodes.map((n) => ({ ...n, members: map[n.code] || [] }));

    const draft = normalizeNames(createTaxonomy({
      name: parentSchemeId ? `基于 ${parentSchemeId} 的归纳` : '语料归纳',
      parentSchemeId,
      nodes,
      params: built.params,
      source: {
        items: items.length,
        sampled: sample.length,
        unmatched: unmatched.length,
        model: String(settings.model || ''),
        promptVersion: PROMPT_VERSION,
      },
    }));

    // 用全量成员数剪枝：样本里 5 条 ≈ 全量 80 条，拿样本数当阈值会剪错
    const pruned = pruneTaxonomy(draft, {
      minPerCategory: draft.params.minPerCategory,
      maxDepth: draft.params.maxDepth,
    });
    const final = { ...pruned.taxonomy, removed: pruned.removed, dropped: pruned.dropped.length, status: 'draft' };
    // 剪枝会带走一批成员，它们是「还没归」而不是「已归」——重算一次，别让覆盖数虚高
    final.source = { ...final.source, unmatched: coverageOf(final, items).uncovered };

    await chrome.storage.local.set({ [TAXONOMY_KEY]: final });
    broadcast({ type: 'taxonomy:done', draft: final });
    return final;
  } finally {
    taxo = { running: false, stage: '', done: 0, total: 0 };
  }
}

/**
 * 按 plan 建目录：父先子后，已有的按 code 复用。
 *
 * 多轮扫描而不是一趟：调用方给的顺序不保证父在前（拆二级时子编码排在父编码前面），
 * 一轮建不出来的先留着，等它的父这一轮建好了下一轮再建。跑不动了就收工，
 * 剩下的算跳过——不会死循环，也不会静默丢掉。
 */
async function createFolders(plan) {
  const existing = new Map((plan.exists || []).map((e) => [e.code, e.folderId]));
  const created = new Map();
  const pending = [...(plan.missing || [])];
  let made = 0;
  for (let round = 0; round < 8 && pending.length; round += 1) {
    let progress = false;
    for (let i = 0; i < pending.length; i += 1) {
      const f = pending[i];
      let parentId = plan.barId;
      if (f.parent) {
        parentId = created.get(f.parent) || existing.get(f.parent) || null;
        if (!parentId) continue; // 父还没建出来，留到下一轮
      }
      const node = await chrome.bookmarks.create({ parentId, title: `${f.code} ${f.name}` });
      created.set(f.code, node.id);
      made += 1;
      progress = true;
      pending.splice(i, 1);
      i -= 1;
    }
    if (!progress) break;
  }
  return { made, created, skipped: pending.map((f) => f.code) };
}

async function readTaxonomy() {
  const { [TAXONOMY_KEY]: draft } = await chrome.storage.local.get(TAXONOMY_KEY);
  if (!draft) throw new Error('还没有分类法草稿');
  return draft;
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
 * 生成整理计划：预筛 → 历史偏好/本地规则 → 低置信度送模型（附带弱标题 <head> 摘要）→ 冲突消解。
 * 全程只读书签，不动任何数据。
 */
async function runOrganize(scope = 'inbox', folderCode = '', limit = MAX_CANDIDATES, { autoSubs = false, tree = 'collection' } = {}) {
  orgCtl = { stop: false };
  organize = { running: true, stage: 'preselect', done: 0, total: 0 };
  broadcast({ type: 'organize:start' });
  try {
    const state = await loadState();
    const { items, folderScheme, parentOf, settings, learned } = state;
    const isFresh = scope === 'scheme' && tree === 'fresh';
    const full = getScheme(settings.schemeId, settings.customSchemes || []);
    if (scope === 'scheme' && !full) throw new Error('还没选用方案：去设置页点一张方案卡，选「选用这套方案」，再回来生成');
    // 方案是源、目录是投影：只要选用了方案，inbox / all / scheme 统一以方案类目（含挂在下头的现存二级）为判定词表
    const targets = resolveClassifyTargets(settings, folderScheme, parentOf, { fresh: isFresh });
    if (!targets.length) throw new Error('还没有可用的分类方案或目录，先到设置页选用一套方案');

    const { candidates: picked } = preselect(items, {
      scope,
      folderCode,
      codes: new Set(targets.map((f) => f.code)),
      // 全新生成按定义就是「当前所有收藏重新分类」，不按每轮条数截断
      limit: isFresh ? 'all' : limit,
    });

    organize.total = picked.length;
    organize.done = picked.length;
    broadcast({
      type: 'organize:progress', stage: 'preselect',
      done: picked.length, total: picked.length, candidates: picked.length, at: Date.now(),
    });

    // 本地关键词规则 + 历史改判偏好先跑：零成本，能定的先定
    const suggestions = {};
    for (const s of classifyHeuristic(picked, targets, { schemeId: settings.schemeId, learned })) {
      suggestions[s.id] = { ...s };
    }

    // 只把「本地没把握」（低于统一选择性阈值）的送去模型
    // 候选已经被 limit 截过（200 / 500 / 1000 / 全部），这里不再二次截断
    const lowConf = picked.filter((it) => (suggestions[it.id].conf || 0) < SELECTIVE_THRESHOLD);
    if (hasModel(settings) && lowConf.length) {
      organize.stage = 'model';
      organize.total = lowConf.length;
      organize.done = 0;
      broadcast({
        type: 'organize:progress', stage: 'model', done: 0,
        total: lowConf.length, candidates: picked.length, at: Date.now(),
      });
      try {
        const pageMeta = await enrichWeakHeads(lowConf, settings);
        const stats = {};
        const refined = await classifyWithModel(
          lowConf,
          targets,
          settings,
          (done, total) => {
            organize.done = done;
            broadcast({
              type: 'organize:progress', stage: 'model', done, total,
              candidates: picked.length, at: Date.now(),
            });
          },
          {
            learned,
            pageMeta,
            ignoreCurrent: isFresh,
            stats,
            shouldStop: () => orgCtl.stop,
            onBatchStart: (batch, batches, size) => broadcast({
              type: 'organize:progress',
              stage: 'model',
              done: organize.done,
              total: organize.total,
              batch,
              batches,
              batchSize: size,
              candidates: picked.length,
              at: Date.now(),
            }),
          },
        );
        for (const s of refined) suggestions[s.id] = { ...s };
        if (stats.failed && stats.failed.length) {
          broadcast({
            type: 'organize:warn',
            message: `${stats.failed.length} 批模型请求没走通，这部分先用本地规则：${stats.failed[0].error}`,
          });
        }
      } catch (e) {
        broadcast({ type: 'organize:warn', message: '模型没走通，先用本地规则：' + String((e && e.message) || e) });
      }
    }

    // 注意别叫 tree：函数参数里的 tree 是「结构来源」，同名会形成暂时性死区
    const bookmarkTree = await chrome.bookmarks.getTree();
    let plan = buildPlan({
      items,
      scheme: targets,
      schemeId: settings.schemeId || '',
      scope,
      folderCode,
      suggestions,
      blocked: collectManagedIds(bookmarkTree),
      existing: new Set(folderScheme.map((f) => f.code)),
      folderNames: new Map(folderScheme.map((f) => [f.code, f.name])),
      ignoreCurrent: isFresh,
      limit: isFresh ? 'all' : limit,
    });

    // 全新生成：先把当前整树备份下来，再谈重建——备份不成功就不往下走
    if (isFresh) {
      const meta = await saveBackup(bookmarkTree, { planId: plan.id, schemeId: settings.schemeId || '' });
      plan.tree = 'fresh';
      plan.backupId = meta.id;
      plan.backupAt = meta.at;
    }

    // 结构来源：照用方案的默认分类（建全，含空目录）、按收藏生成（只建用到的 + 可选派生二级），
    // 或全新生成（旧目录重判并在搬空后清理）
    if (scope === 'scheme' && tree === 'scheme') {
      plan.tree = 'scheme';
      plan.created = schemeCreated(targets, new Set(folderScheme.map((f) => f.code)));
    } else if (autoSubs && scope === 'scheme') {
      if (!hasModel(settings)) {
        broadcast({ type: 'organize:warn', message: '还没配模型：这一轮只生成一级目录' });
      } else {
        organize.stage = 'subs';
        broadcast({ type: 'organize:progress', stage: 'subs', done: 0, total: 0, at: Date.now() });
        // 非 fresh 模式：已有二级子目录的父类不再重新派生，防止同码 110/120 撞车
        const existingParents = isFresh ? null : new Set(Object.values(parentOf || {}));
        const derived = await deriveSubs(
          plan,
          items,
          ({ code, name, items: part }) => splitByModel({ code, name }, part, settings),
          {
            minPerTop: 6,
            existingParents,
            shouldStop: () => orgCtl.stop,
            onStep: (done, total) => broadcast({
              type: 'organize:progress', stage: 'subs', done, total, at: Date.now(),
            }),
          },
        );
        plan = derived.plan;
        if (!derived.groups) {
          broadcast({ type: 'organize:warn', message: '这轮没有符合派生条件的一级类目（≥6 条且尚无二级），暂不派生二级' });
        }
      }
    }
    if (plan.tree === 'fresh') {
      const keep = planCodes(plan);
      const moving = new Set(readyOps(plan).map((op) => op.id));
      const left = estimateLeftovers(folderScheme, items, keep, moving);
      plan.removeEstimate = left.map((f) => ({ code: f.code, name: f.name }));
    }
    if (orgCtl.stop) broadcast({ type: 'organize:warn', message: '已停止生成，计划按已拿到的建议出' });
    await writePlan(plan);
    return plan;
  } finally {
    organize = { running: false, stage: '', done: 0, total: 0 };
  }
}

async function moveToCode(ids, code, { learn = false } = {}) {
  const settings = await readSettings();
  const tree = await chrome.bookmarks.getTree();
  const { items, folderScheme } = parseTree(tree, parseOptsFor(settings));
  const target = folderScheme.find((f) => f.code === code);
  if (!target) throw new Error(`找不到类目 ${code}，可能分类文件夹被改名或删除了`);
  const byId = new Map(items.map((x) => [x.id, x]));
  let learned = learn ? await readLearned() : null;
  let moved = 0;
  const ops = [];
  for (const id of ids) {
    try {
      const [node] = await chrome.bookmarks.get(id);
      await chrome.bookmarks.move(id, { parentId: target.id });
      ops.push({ id, fromFolderId: node.parentId, fromIndex: node.index, toFolderId: target.id, code });
      if (learn && byId.has(id)) {
        learned = recordOverride(learned, byId.get(id), code);
      }
      moved += 1;
    } catch (e) {
      console.warn('[归藏] 移动失败', id, e);
    }
  }
  if (learn && learned) await chrome.storage.local.set({ learned });
  return { moved, folderId: target.id, code, name: target.name, ops };
}

async function runHealth(ids, { silent = false } = {}) {
  if (scan.running) throw new Error('上一次检测还没结束');
  const state = await loadState();
  const settings = state.settings;
  const wanted = new Set(ids);
  const targets = state.items
    .filter((it) => wanted.has(it.id))
    .slice(0, Math.max(1, settings.checkLimit || 60))
    .map((it) => ({ id: it.id, url: it.url }));

  if (!targets.length) return { started: false, total: 0, newDead: 0 };

  scanAbort = new AbortController();
  scan = { running: true, done: 0, total: targets.length, startedAt: Date.now() };
  if (!silent) broadcast({ type: 'scan:start', total: targets.length });

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
        if (!silent) broadcast({ type: 'scan:progress', done, total, id, result: r });
      },
    });
    clearInterval(timer);
    await flush();
    const deadStatuses = new Set(['dead', 'error', 'timeout', 'unreachable']);
    const newDead = Object.values(results).filter((r) => deadStatuses.has(r.status)).length;
    scan = { running: false, done: Object.keys(results).length, total: targets.length, startedAt: 0 };
    if (!silent) broadcast({ type: 'scan:done', total: targets.length });
    if (silent && newDead > 0) {
      await flashBadge(newDead > 99 ? '99+' : String(newDead), '#A8341E', 0);
    }
    return { started: true, total: targets.length, newDead };
  } catch (e) {
    clearInterval(timer);
    await flush();
    scan = { running: false, done: 0, total: 0, startedAt: 0 };
    throw e;
  }
}

/** 同步定期静默检测闹钟（需已授权 alarms 权限） */
async function syncWeeklyAlarm(enabled) {
  if (!chrome.alarms) return { active: false };
  try {
    const has = chrome.permissions ? await chrome.permissions.contains({ permissions: ['alarms'] }) : true;
    if (!has || !enabled) {
      await chrome.alarms.clear(WEEKLY_ALARM).catch(() => {});
      return { active: false };
    }
    await chrome.alarms.create(WEEKLY_ALARM, { delayInMinutes: 60, periodInMinutes: 10080 });
    return { active: true };
  } catch {
    return { active: false };
  }
}

/** 收纳当前窗口全部 http/https 标签页到待归类（或指定文件夹） */
async function stashWindowTabs({ folderId = '', closeTabs = false } = {}) {
  const settings = await readSettings();
  const { parsed, inboxId } = await ensureInbox(undefined, settings);
  const targetId = folderId || inboxId;
  const existingNorm = new Set(parsed.items.map((it) => normalizeUrl(it.url)));
  const tabs = await chrome.tabs.query({ currentWindow: true });

  let saved = 0;
  let skipped = 0;
  const createdIds = [];
  const toClose = [];

  for (const t of tabs) {
    if (!t.url || !/^https?:/i.test(t.url)) continue;
    const norm = normalizeUrl(t.url);
    if (existingNorm.has(norm)) {
      skipped += 1;
      if (closeTabs && !t.pinned && !t.active) toClose.push(t.id);
      continue;
    }
    existingNorm.add(norm);
    const node = await chrome.bookmarks.create({ parentId: targetId, title: t.title || t.url, url: t.url });
    createdIds.push(node.id);
    saved += 1;
    if (closeTabs && !t.pinned && !t.active) toClose.push(t.id);
  }

  if (toClose.length) {
    await chrome.tabs.remove(toClose).catch(() => {});
  }
  broadcast({ type: 'state:changed' });
  return { saved, skipped, createdIds, closed: toClose.length };
}

/** 把任意快照安全恢复到一个带时间戳的新目录，绝不覆盖现有书签 */
/** 把快照节点写成真实的书签树；counters 逐层累加，idMap 记录旧 id → 新 id 以便迁移旁挂元数据 */
async function writeSnapshot(nodes, parentId, counters = { folders: 0, bookmarks: 0 }, idMap = null) {
  for (const node of nodes || []) {
    if (node.url) {
      const created = await chrome.bookmarks.create({ parentId, title: node.title || node.url, url: node.url });
      if (idMap && node.id) idMap.set(node.id, created.id);
      counters.bookmarks += 1;
      continue;
    }
    const folder = await chrome.bookmarks.create({ parentId, title: node.title || '未命名文件夹' });
    if (idMap && node.id) idMap.set(node.id, folder.id);
    counters.folders += 1;
    await writeSnapshot(node.children || [], folder.id, counters, idMap);
  }
  return counters;
}

/** 安全恢复：把快照写到书签栏下的「归藏恢复 时间」容器里，现有书签一律不动 */
async function restoreSnapshotSafe(snapshot) {
  const snap = validateSnapshot(snapshot);
  const settings = await readSettings();
  const currentTree = await chrome.bookmarks.getTree();
  // 先为当前状态自动留一份退路
  await saveBackup(currentTree, { planId: 'pre-restore', schemeId: settings.schemeId || '' });

  const bar = (currentTree[0].children || []).find((n) => !n.url) || currentTree[0].children[0];
  const d = new Date(snap.at);
  const label = `归藏恢复 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const container = await chrome.bookmarks.create({ parentId: bar.id, title: label });

  const roots = rebuildSubtree(snap.nodes);
  const counters = { folders: 0, bookmarks: 0 };
  for (const r of roots) await writeSnapshot([r], container.id, counters);

  broadcast({ type: 'state:changed' });
  return { mode: 'safe', folderId: container.id, label, folders: counters.folders, bookmarks: counters.bookmarks };
}

/**
 * 替换恢复：先备份当前树，再清空书签栏 / 其他书签下的内容，把快照原样写回去。
 * 这才是「恢复备份」的字面意思；受管书签删不掉，会跳过并计数。
 */
async function restoreSnapshotReplace(snapshot) {
  const snap = validateSnapshot(snapshot);
  const settings = await readSettings();
  const currentTree = await chrome.bookmarks.getTree();
  await saveBackup(currentTree, { planId: 'pre-restore-replace', schemeId: settings.schemeId || '' });

  const root = currentTree[0];
  const chromeRoots = (root.children || []).filter((n) => !n.url);
  let removed = 0;
  let stuck = 0;
  for (const r of chromeRoots) {
    for (const child of [...(r.children || [])]) {
      try {
        await chrome.bookmarks.removeTree(child.id);
        removed += 1;
      } catch {
        stuck += 1;   // 受管书签 / 系统目录：删不掉就留着
      }
    }
  }

  const roots = rebuildSubtree(snap.nodes || []);
  const pickRoot = (title) => {
    const t = String(title || '').trim();
    return chromeRoots.find((r) => String(r.title || '').trim() === t)
      || chromeRoots.find((r) => /书签栏/.test(String(r.title || '')))
      || chromeRoots[0]
      || root;
  };
  const counters = { folders: 0, bookmarks: 0 };
  const idMap = new Map();
  for (const r of roots) {
    const target = pickRoot(r.title);
    for (const c of r.children || []) await writeSnapshot([c], target.id, counters, idMap);
  }

  // 替换恢复会生成全新节点 ID：同步迁移 meta（标签分面/批注/星标）与 health，避免被 pruneMeta 误清空
  let remappedMeta = 0;
  if (idMap.size) {
    const { meta = {}, health = {} } = await chrome.storage.local.get(['meta', 'health']);
    const nextMeta = remapRecordById(meta, idMap);
    const nextHealth = remapRecordById(health, idMap);
    remappedMeta = nextMeta.remapped;
    await chrome.storage.local.set({ meta: nextMeta.record, health: nextHealth.record });
  }

  broadcast({ type: 'state:changed' });
  return {
    mode: 'replace',
    label: '替换恢复',
    removed,
    stuck,
    folders: counters.folders,
    bookmarks: counters.bookmarks,
    remappedMeta,
  };
}

async function openManagerTab({ view, drawer, id, hash, q } = {}) {
  const managerUrlPrefix = chrome.runtime.getURL('ui/manager.html');
  let targetHash = hash || '';
  if (!targetHash) {
    const parts = [];
    if (view) parts.push(`view=${encodeURIComponent(view)}`);
    if (drawer) parts.push(`drawer=${encodeURIComponent(drawer)}`);
    if (id) parts.push(`id=${encodeURIComponent(id)}`);
    if (q) parts.push(`q=${encodeURIComponent(q)}`);
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
}

/* ── 消息路由 ─────────────────────────────────── */


/** AI 归类：本地规则先跑，只把没把握的送模型；全程广播进度，结果落盘后广播 ai:done */
async function runAi(ids) {
  aiCtl = { running: true, stop: false };
  broadcast({ type: 'ai:start', total: (ids || []).length });
  try {
    const state = await loadState();
    const { items, folderScheme, parentOf, settings, learned } = state;
    const wanted = new Set(ids);
    const targets = items.filter((it) => wanted.has(it.id));
    const vocab = resolveClassifyTargets(settings, folderScheme, parentOf);
    if (!vocab.length) throw new Error('没找到可用分类。先在设置页选用一套方案，或在书签栏建类目文件夹。');
    if (!targets.length) { broadcast({ type: 'ai:done', total: 0, count: 0 }); return; }

    // 1) 本地关键词 + 历史偏好：零成本，先定一批
    const base = classifyHeuristic(targets, vocab, { schemeId: settings.schemeId, learned });
    const merged = new Map(base.map((s) => [s.id, s]));
    const lowConf = targets.filter((it) => ((merged.get(it.id) || {}).conf || 0) < SELECTIVE_THRESHOLD);

    // 2) 只把没把握的送模型（没有模型就纯本地）
    const stats = {};
    let list = base;
    if (hasModel(settings) && lowConf.length) {
      const pageMeta = await enrichWeakHeads(lowConf, settings);
      const refined = await classify(
        lowConf,
        vocab,
        settings,
        (done, total) => broadcast({ type: 'ai:progress', done, total }),
        { learned, pageMeta, stats, shouldStop: () => aiCtl.stop },
      );
      for (const s of refined) merged.set(s.id, s);
      list = [...merged.values()];
    }

    const byId = new Map(targets.map((it) => [it.id, it]));
    list = list.filter((s) => s.code && (byId.get(s.id) || {}).code !== s.code);
    const failed = stats.failed || [];

    if (list.length) {
      const pending = { ...state.pending };
      const at = Date.now();
      for (const s of list) pending[s.id] = { ...s, at };
      await chrome.storage.local.set({ pending });
      broadcast({ type: 'state:changed' });
    }
    broadcast({
      type: 'ai:done',
      total: targets.length,
      count: list.length,
      failed,
      source: hasModel(settings) ? 'model' : 'heuristic',
    });
  } finally {
    aiCtl = { running: false, stop: false };
  }
}

const handlers = {
  ping: async () => ({
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

  'summary:load': async () => {
    const settings = await readSettings();
    const { parsed, inboxId } = await ensureInbox(undefined, settings);
    const { items, folderScheme, parentOf } = parsed;
    const { health = {}, pending = {}, meta = {} } = await chrome.storage.local.get(['health', 'pending', 'meta']);
    let dead = 0;
    let susp = 0;
    let moved = 0;
    let unchecked = 0;
    let inbox = 0;
    for (const it of items) {
      if (!it.code) inbox += 1;
      const h = health[it.id];
      if (!h) unchecked += 1;
      else if (h.status === 'dead' || h.status === 'error' || h.status === 'timeout' || h.status === 'unreachable') dead += 1;
      else if (h.status === 'blocked') susp += 1;
      else if (h.status === 'moved') moved += 1;
    }
    const dups = findDuplicates(items);
    const serendipity = pickSerendipity(items, { health, meta, count: 3, seed: Math.floor(Date.now() / 3600000) })
      .map((it) => ({ id: it.id, title: it.title, url: it.url, host: it.host, code: it.code, added: it.added }));

    return {
      folderScheme,
      parentOf,
      inboxId,
      settings,
      meta,
      aiReady: hasModel(settings),
      counts: {
        all: items.length,
        dead,
        susp,
        moved,
        dups: dups.length,
        unchecked,
        inbox,
        pending: Object.keys(pending).length,
      },
      serendipity,
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

  'tabs:stashWindow': async (opts = {}) => stashWindowTabs(opts),

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

  'bookmarks:moveCode': async ({ ids, code, learn = false }) => {
    const r = await moveToCode(ids, code, { learn });
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

  'bookmarks:batchRename': async ({ changes = [] }) => {
    let renamed = 0;
    const prev = [];
    for (const c of changes) {
      if (!c || !c.id || !c.title) continue;
      try {
        const [before] = await chrome.bookmarks.get(c.id);
        await chrome.bookmarks.update(c.id, { title: c.title });
        prev.push({ id: c.id, title: before.title });
        renamed += 1;
      } catch {}
    }
    broadcast({ type: 'state:changed' });
    return { renamed, prev };
  },

  'health:run': async ({ ids }) => {
    if (chrome.action?.setBadgeText) chrome.action.setBadgeText({ text: '' }).catch(() => {});
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

  'health:runUnchecked': async () => {
    const settings = await readSettings();
    const tree = await chrome.bookmarks.getTree();
    const { items } = parseTree(tree, parseOptsFor(settings));
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

  /** 批量更新 301/302 重定向目标地址，返回旧地址以便一键撤销 */
  'health:applyRedirects': async ({ ids = [] }) => {
    const { health = {} } = await chrome.storage.local.get('health');
    const targetIds = ids.length
      ? ids
      : Object.entries(health).filter(([, h]) => h && h.status === 'moved' && h.finalUrl).map(([id]) => id);
    const prev = [];
    let updated = 0;
    for (const id of targetIds) {
      const h = health[id];
      if (!h || !h.finalUrl) continue;
      try {
        const [node] = await chrome.bookmarks.get(id);
        await chrome.bookmarks.update(id, { url: h.finalUrl });
        prev.push({ id, oldUrl: node.url });
        delete health[id];
        updated += 1;
      } catch {}
    }
    await chrome.storage.local.set({ health });
    broadcast({ type: 'state:changed' });
    return { updated, prev };
  },

  'wayback:lookup': async ({ url }) => lookupWayback(url),

  'meta:set': async ({ id, patch }) => {
    const { meta = {} } = await chrome.storage.local.get('meta');
    const next = normalizeMeta(patch, meta[id]);
    if (next) meta[id] = next;
    else delete meta[id];
    await chrome.storage.local.set({ meta });
    broadcast({ type: 'state:changed' });
    return { id, entry: next };
  },

  'meta:batchTag': async ({ ids = [], tag }) => {
    const clean = String(tag || '').trim().replace(/^#+/, '').slice(0, 24);
    if (!clean) throw new Error('标签不能为空');
    const { meta = {} } = await chrome.storage.local.get('meta');
    let count = 0;
    for (const id of ids) {
      const prev = meta[id] || {};
      const tags = [...(prev.tags || []), clean];
      const next = normalizeMeta({ tags }, prev);
      if (next) { meta[id] = next; count += 1; }
    }
    await chrome.storage.local.set({ meta });
    broadcast({ type: 'state:changed' });
    return { count, tag: clean };
  },

  'learned:list': async () => readLearned(),

  'learned:remove': async ({ host }) => {
    const next = removeLearnedDomain(await readLearned(), host);
    await chrome.storage.local.set({ learned: next });
    broadcast({ type: 'state:changed' });
    return next;
  },

  'learned:clear': async () => {
    const next = emptyLearned();
    await chrome.storage.local.set({ learned: next });
    broadcast({ type: 'state:changed' });
    return next;
  },

  /** 吃灰与常阅分析（基于可选 history 权限） */
  'history:analyze': async () => {
    if (!chrome.history) throw new Error('尚未授予浏览历史权限');
    const state = await loadState();
    const entries = await chrome.history.search({ text: '', startTime: 0, maxResults: 10000 });
    const result = analyzeUsage(state.items, entries);
    await chrome.storage.local.set({ usageCache: result });
    broadcast({ type: 'state:changed' });
    return result;
  },

  'ai:run': async ({ ids }) => {
    if (aiCtl.running) throw new Error('上一次 AI 归类还没结束');
    // 长任务不再让页面 await 到底：立即返回，进度与结果都走广播（与整理一致）
    runAi(ids).catch((e) => broadcast({ type: 'ai:error', message: String((e && e.message) || e) }));
    return { started: true };
  },

  'ai:stop': async () => { aiCtl.stop = true; return { stopping: true }; },

  'ai:load': async () => {
    const { pending } = await chrome.storage.local.get('pending');
    return { running: aiCtl.running, pending: Object.keys(pending || {}).length };
  },

  'ai:cleanTitles': async ({ ids = [] }) => {
    const state = await loadState();
    const wanted = new Set(ids);
    const targets = (ids.length ? state.items.filter((it) => wanted.has(it.id)) : state.items).slice(0, 40);
    const pageMeta = await enrichWeakHeads(targets, state.settings);
    const items = await cleanTitles(targets, state.settings, pageMeta);
    return { items };
  },

  'ai:accept': async ({ ids }) => {
    const state = await loadState();
    const p = { ...(state.pending || {}) };
    const byId = new Map(state.items.map((x) => [x.id, x]));
    const vocab = resolveClassifyTargets(state.settings, state.folderScheme, state.parentOf);
    const wantedIds = (ids || []).filter((id) => p[id] && p[id].code && byId.has(id));
    if (!wantedIds.length) return { moved: 0, movedIds: [], failed: 0, missing: [], journalId: '' };

    const ops = wantedIds.map((id) => {
      const it = byId.get(id);
      const s = p[id];
      const hit = vocab.find((f) => f.code === s.code);
      return {
        id,
        title: it.title || '',
        url: it.url || '',
        from: { code: it.code || '', folderId: it.folderId || '' },
        to: { code: s.code, name: (hit && hit.name) || s.code },
        status: 'ready',
      };
    });
    const folders = planFolders({ scheme: vocab }, ops);
    const earliestAt = wantedIds.reduce((m, id) => Math.min(m, p[id].at || Date.now()), Date.now());
    const res = await commitOps({
      planId: 'ai-accept',
      planAt: earliestAt,
      folders,
      ops,
      backup: true,
      journal: true,
      scope: 'ai',
      progress: false,
    });
    if (res.conflict.length) {
      const codes = res.conflict.map((c) => `${c.code}（现名「${c.got}」，方案叫「${c.want}」）`).join('、');
      throw new Error(`目标目录冲突：${codes}，未执行移动`);
    }
    const doneIds = [...(res.movedIds || []), ...(res.alreadyIds || [])];
    doneIds.forEach((id) => delete p[id]);
    await chrome.storage.local.set({ pending: p });
    broadcast({ type: 'state:changed' });
    return {
      moved: res.moved,
      skippedAlready: res.skippedAlready || 0,
      movedIds: doneIds,
      failed: res.failed,
      created: res.created,
      missing: [],
      journalId: res.journalId || null,
    };
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

  /** 按当前启用方案（或现存目录）给出单条建议，带完整数据血缘 */
  'ai:suggestOne': async ({ url, title, fast }) => {
    const settings = await readSettings();
    const learned = await readLearned();
    const tree = await chrome.bookmarks.getTree();
    const { folderScheme, parentOf } = parseTree(tree, parseOptsFor(settings));
    const vocab = resolveClassifyTargets(settings, folderScheme, parentOf);
    const fake = [{ id: 'tmp', title: title || url, url, host: hostOf(url), code: '' }];
    const folderFor = (code) => (folderScheme.find((f) => f.code === code) || {}).id || null;
    const pack = (s, extra = {}) => ({
      code: (s && s.code) || '',
      conf: (s && s.conf) || 0,
      reason: (s && s.reason) || '',
      source: (s && s.source) || 'heuristic',
      model: (s && s.model) || '',
      promptVersion: (s && s.promptVersion) || '',
      folderId: s && s.code ? folderFor(s.code) : null,
      ...extra,
    });

    if (!fast && hasModel(settings) && vocab.length) {
      try {
        const pageMeta = settings.fetchHeadOnAi && isWeakTitle(title, url)
          ? { tmp: await fetchPageHead(url, { timeout: 4000 }) }
          : {};
        const [s] = await classify(fake, vocab, settings, undefined, { learned, pageMeta });
        if (s) return pack(s, { source: s.source || 'model' });
      } catch (e) {
        const [s] = classifyHeuristic(fake, vocab, { schemeId: settings.schemeId, learned });
        return pack(s, { reason: '模型不可用，用了本地规则', error: String(e.message || e) });
      }
    }
    const [s] = classifyHeuristic(fake, vocab, { schemeId: settings.schemeId, learned });
    return pack(s);
  },

  'settings:save': async ({ settings }) => {
    const next = { ...(await readSettings()), ...settings };
    await chrome.storage.local.set({ settings: next });
    await syncWeeklyAlarm(Boolean(next.autoCheckWeekly));
    broadcast({ type: 'state:changed' });
    return { settings: next };
  },

  'settings:test': async ({ settings }) => {
    const merged = { ...(await readSettings()), ...(settings || {}) };
    const raw = await testConnection(merged);
    return { ok: true, raw };
  },

  'schemes:list': async () => {
    const settings = await readSettings();
    return {
      schemes: listSchemes(settings.customSchemes || []),
      current: settings.schemeId || '',
    };
  },

  'scheme:saveCustom': async ({ scheme }) => {
    const clean = sanitizeCustomScheme(scheme);
    const settings = await readSettings();
    const prev = (settings.customSchemes || []).find((s) => s.id === clean.id);
    const list = [...(settings.customSchemes || [])].filter((s) => s.id !== clean.id);
    list.push(clean);
    const next = { ...settings, customSchemes: list };
    await chrome.storage.local.set({ settings: next });
    // 若编辑的是当前激活方案，同步对 pending / learned / plan 跑一次模式迁移
    let sw = { mapped: 0, dropped: 0, learnedMapped: 0, learnedDropped: 0, planCleared: false };
    if (prev && settings.schemeId === clean.id) {
      sw = await migrateSchemeState(clean.id, clean.id, list, { fromFolders: prev.folders, force: true });
    }
    broadcast({ type: 'state:changed' });
    return { scheme: clean, schemes: listSchemes(list), ...sw };
  },

  'scheme:deleteCustom': async ({ schemeId }) => {
    const settings = await readSettings();
    const list = (settings.customSchemes || []).filter((s) => s.id !== schemeId);
    const next = { ...settings, customSchemes: list, schemeId: settings.schemeId === schemeId ? '' : settings.schemeId };
    // 删掉当前方案就等于换成空方案：没有可迁移的目标，全部显式作废
    const sw = await migrateSchemeState(settings.schemeId, next.schemeId, settings.customSchemes || []);
    await chrome.storage.local.set({ settings: next });
    broadcast({ type: 'state:changed' });
    return { schemes: listSchemes(list), ...sw };
  },

  'scheme:preview': async ({ schemeId }) => {
    const settings = await readSettings();
    const scheme = getScheme(schemeId, settings.customSchemes || []);
    if (!scheme) throw new Error('没有这个方案');
    const tree = await chrome.bookmarks.getTree();
    const plan = planInstall(tree, scheme);
    // 用「预览目标方案」自身的解析选项（而不是旧方案）统计哪些类目现在已有书签
    const { items } = parseTree(tree, parseOptsOf(schemeId, settings.customSchemes || []));
    const used = new Set(items.map((it) => it.code || ''));
    const empty = scheme.folders.filter((f) => !used.has(f.code)).map((f) => f.code);
    return { ...plan, empty, summary: { ...plan.summary, empty: empty.length } };
  },

  /** 分类法设计：抽样 → 归纳骨架 → 规则铺全量 → 剪枝，只产出 draft */
  'taxonomy:design': async ({ parentSchemeId = '', sampleSize = 200 } = {}) => {
    runDesign({ parentSchemeId, sampleSize })
      .catch((e) => broadcast({ type: 'taxonomy:error', message: String((e && e.message) || e) }));
    return { started: true };
  },

  'taxonomy:load': async () => {
    const { [TAXONOMY_KEY]: draft } = await chrome.storage.local.get(TAXONOMY_KEY);
    return { draft: draft || null, running: taxo.running };
  },

  /** 审定：改名、删类，状态 draft → approved */
  'taxonomy:approve': async ({ renames = {}, removed = [] } = {}) => {
    const draft = await readTaxonomy();
    if (!draft) throw new Error('还没有分类法草稿');
    const next = approveTaxonomy(draft, { renames, removed });
    if (!next.nodes.length) throw new Error('类目全被删掉了，至少留一个');
    await chrome.storage.local.set({ [TAXONOMY_KEY]: next });
    broadcast({ type: 'taxonomy:done', draft: next });
    return next;
  },

  /** 落成目录：折成方案 → commitOps（只建目录；冲突拦下）→ 启用 */
  'taxonomy:install': async () => {
    const draft = await readTaxonomy();
    if (!draft) throw new Error('还没有分类法草稿');
    if (draft.status !== 'approved') throw new Error('先审定，再落成目录');

    const scheme = toScheme(draft);
    // 提交：只建目录、不动条目，所以不过备份闸门、不写撤销日志
    const res = await commitOps({
      planId: 'install:' + scheme.id,
      folders: scheme.folders.map((f) => ({ code: f.code, name: f.name, parent: f.parent || null })),
      ops: [],
      backup: false,
      journal: false,
    });
    if (res.conflict.length) return { installed: false, conflict: res.conflict };
    const made = res.created;

    const settings = await readSettings();
    const customs = (settings.customSchemes || []).filter((s) => s.id !== scheme.id);
    customs.push(sanitizeCustomScheme({ ...scheme, custom: true }));
    const sw = await migrateSchemeState(settings.schemeId, scheme.id, customs);
    await chrome.storage.local.set({ settings: { ...settings, customSchemes: customs, schemeId: scheme.id } });

    const installed = {
      ...draft,
      status: 'installed',
      installedAt: Date.now(),
      schemeId: scheme.id,
      snapshot: { created: made },
    };
    await chrome.storage.local.set({ [TAXONOMY_KEY]: installed });
    broadcast({ type: 'taxonomy:done', draft: installed });
    broadcast({ type: 'state:changed' });
    return {
      installed: true, created: made, reused: res.reused, schemeId: scheme.id,
      mapped: sw.mapped, dropped: sw.dropped,
      learnedMapped: sw.learnedMapped, learnedDropped: sw.learnedDropped, planCleared: sw.planCleared,
    };
  },

  /**
   * 按选定方案 + 真实收藏生草稿：类名与编码来自方案，只保留真有收藏的类目。
   * 纯本地规则，不调模型；产出仍是草稿，要继续审定 → 落成才会建目录。
   */
  'taxonomy:fromScheme': async ({ schemeId = '' } = {}) => {
    const settings = await readSettings();
    const scheme = getScheme(schemeId || settings.schemeId, settings.customSchemes || []);
    if (!scheme) throw new Error('没有这个方案');
    const state = await loadState();
    const items = state.items || [];
    if (!items.length) throw new Error('还没有收藏可以归类');
    const nodes = nodesFromScheme(scheme);
    if (!nodes.length) throw new Error('这个方案里没有可用的类目');

    const { map, unmatched } = assignByRules(items, nodes);
    const draft = createTaxonomy({
      name: `${scheme.name} · 按收藏裁剪`,
      parentSchemeId: scheme.id,
      nodes: nodes.map((n) => ({ ...n, members: map[n.code] || [] })),
      params: { minPerCategory: 1 },
      source: { items: items.length, sampled: 0, unmatched: unmatched.length },
    });

    // 阈值 1：只剪掉一个成员都没有的类目——目录该不该存在，由你的收藏决定
    const pruned = pruneTaxonomy(draft, { minPerCategory: 1, maxDepth: draft.params.maxDepth });
    const final = { ...pruned.taxonomy, removed: pruned.removed, dropped: pruned.dropped.length, status: 'draft' };
    final.source = { ...final.source, unmatched: coverageOf(final, items).uncovered };

    await chrome.storage.local.set({ [TAXONOMY_KEY]: final });
    broadcast({ type: 'taxonomy:done', draft: final });
    return final;
  },

  /**
   * 增量扩展：只处理「还没归入任何类目」的条目，先按规则归类，塞不下的按站点聚成建议。
   * 不建目录、不改结构，建议要经 acceptProposals → 审定 → 落成目录 才生效。
   */
  'taxonomy:extend': async ({ minCluster = 8 } = {}) => {
    const draft = await readTaxonomy();
    const state = await loadState();
    const plan = planExtend(draft, state.items, { minCluster });
    const assigned = Object.values(plan.assign).reduce((n, ids) => n + ids.length, 0);

    const next = applyExtend(draft, plan.assign);
    const saved = {
      ...next,
      source: { ...draft.source, unmatched: plan.pending },
      proposals: [...(draft.proposals || []), ...plan.proposals],
      lastExtendAt: Date.now(),
      lastExtend: { assigned, proposals: plan.proposals.length, unmatched: plan.pending },
    };
    await chrome.storage.local.set({ [TAXONOMY_KEY]: saved });
    broadcast({ type: 'taxonomy:done', draft: saved });
    if (assigned) broadcast({ type: 'state:changed' });
    return { assigned, proposals: plan.proposals.length, unmatched: plan.pending };
  },

  /** 接受建议：变成正式节点，状态回 draft（还要再审定才能落成目录） */
  'taxonomy:acceptProposals': async ({ keys = [] } = {}) => {
    const draft = await readTaxonomy();
    const next = acceptProposals(draft, keys);
    if (next === draft) throw new Error('没有可接受的建议，或父类目已满');
    await chrome.storage.local.set({ [TAXONOMY_KEY]: next });
    broadcast({ type: 'taxonomy:done', draft: next });
    return next;
  },

  'taxonomy:cancel': async () => {
    await chrome.storage.local.remove(TAXONOMY_KEY);
    broadcast({ type: 'taxonomy:done', draft: null });
    return { ok: true };
  },

  'organize:plan': async ({ scope = 'inbox', folderCode = '', limit = MAX_CANDIDATES, autoSubs = false, tree = 'collection' } = {}) => {
    if (organize.running) throw new Error('上一次整理计划还在生成');
    runOrganize(scope, folderCode, limit, { autoSubs, tree }).catch((e) => broadcast({ type: 'organize:error', message: String((e && e.message) || e) }));
    return { started: true };
  },

  'organize:load': async () => {
    const { plan } = await chrome.storage.local.get(PLAN_KEY);
    return { plan: plan || null, running: organize.running, applying: applyCtl.running, stopping: applyCtl.stop };
  },

  'organize:apply': async ({ includeUnsure = false } = {}) => {
    runApply({ includeUnsure }).catch((e) => {
      applyCtl = { running: false, stop: false };
      broadcast({ type: 'organize:error', message: String((e && e.message) || e) });
    });
    return { started: true };
  },

  /** 把一个已存在的类目拆成二级：生成只针对该目录的计划并立即执行（走备份闸门与撤销日志） */
  'organize:splitFolder': async ({ code }) => {
    if (applyCtl.running) throw new Error('上一次整理还没结束');
    const settings = await readSettings();
    if (!hasModel(settings)) throw new Error('拆分目录需要模型：先在设置里配好 API Key');
    const state = await loadState();
    const codeKey = String(code || '');
    const items = state.items.filter((it) => String(it.code || '') === codeKey);
    if (items.length < 6) throw new Error(`这个目录只有 ${items.length} 条，少于 6 条不必拆`);

    // 二级编码是「父首位 + 10n」，字母方案算出来的 T10 这种 parseTree 认不出，先挡掉
    if (!/^\d{1,3}$/.test(codeKey)) throw new Error('字母编码的类目还不支持拆二级：换成数字方案，或手工建子目录');

    const parsed = parseTree(await chrome.bookmarks.getTree(), parseOptsFor(settings));
    const folder = parsed.folderScheme.find((f) => f.code === codeKey);
    if (!folder) throw new Error('找不到这个类目文件夹（可能已被改名或删除）');

    broadcast({ type: 'organize:split-start', total: 1 });
    let got;
    try {
      got = await splitByModel(folder, items, settings);
    } finally {
      broadcast({ type: 'organize:split-progress', done: 1, total: 1 });
    }
    const { subs, assign } = got;
    // 拿到子类名却算不出编码，说明父编码不对——不报「子类少于 2 个」，那会误导排查方向
    if (!subs.length) throw new Error('子类编码没生成出来：这个类目的编码不是数字，暂时不能拆二级');
    if (subs.length < 2) throw new Error('模型给出的子类少于 2 个，换个模型或稍后重试');

    const byId = new Map(items.map((it) => [it.id, it]));
    const ops = Object.entries(assign)
      .filter(([id]) => byId.has(id))
      .map(([id, idx]) => {
        const sub = subs[idx];
        const it = byId.get(id);
        return {
          id,
          title: it.title || '',
          url: it.url || '',
          from: { code: codeKey, folderId: it.folderId || '' },
          to: { code: codeKey, name: folder.name, sub: { code: sub.code, name: sub.name }, missing: true },
          conf: 1,
          source: 'model',
          model: got.model || '',
          promptVersion: got.promptVersion || PROMPT_VERSION,
          reason: '拆分目录',
          status: 'ready',
        };
      });
    if (!ops.length) throw new Error('模型没有把任何条目分到子类');

    const plan = recount({
      id: 'p' + Date.now().toString(36),
      at: Date.now(),
      schemeId: settings.schemeId || '',
      scope: 'folder',
      scheme: [{ code: codeKey, name: folder.name, parent: null }],
      subs: { [codeKey]: subs.map((x) => ({ code: x.code, name: x.name, hint: x.hint })) },
      existing: parsed.folderScheme.map((f) => f.code),
      ops,
    });
    // 遵守人在回路：只产出拆分计划交给用户审阅确认，不绕过审定直接动树
    await writePlan(plan);
    return {
      planned: true,
      subs: subs.length,
      ops: ops.length,
      plan,
    };
  },

  /** 把整理结果再拆一层二级：按一级分组，逐组问模型要 2–5 个子类并分配条目 */
  'organize:split': async ({ minPerTop = 6 } = {}) => {
    const plan = await readPlan();
    const settings = await readSettings();
    if (!hasModel(settings)) throw new Error('拆分二级需要模型：先在设置里配好 API Key');
    const groups = new Map();
    for (const op of plan.ops) {
      if (!op.to || !op.to.code) continue;
      if (op.status !== 'ready' && op.status !== 'unsure') continue;
      if (!groups.has(op.to.code)) groups.set(op.to.code, []);
      groups.get(op.to.code).push(op);
    }
    const todo = [...groups.entries()].filter(([, ops]) => ops.length >= minPerTop);
    if (!todo.length) throw new Error(`没有可拆分的类目：每个一级至少 ${minPerTop} 条才拆`);
    broadcast({ type: 'organize:split-start', total: todo.length });
    const mapping = {};
    let done = 0;
    for (const [code, ops] of todo) {
      const name = (plan.scheme.find((f) => f.code === code) || {}).name || code;
      if (!/^\d{1,3}$/.test(code)) {
        broadcast({ type: 'organize:warn', message: `「${name}」是字母编码，暂时不支持拆二级` });
        done += 1;
        broadcast({ type: 'organize:split-progress', done, total: todo.length });
        continue;
      }
      try {
        const { subs: names, assign, badChunks, model, promptVersion } = await splitByModel({ code, name }, ops, settings);
        if (names.length < 2) throw new Error('模型给出的子类少于 2 个');
        if (Object.keys(assign).length) mapping[code] = { subs: names, assign, model, promptVersion };
        if (badChunks) {
          broadcast({
            type: 'organize:warn',
            message: `「${name}」有 ${badChunks} 块没分配成功，那部分条目先留在这一级`,
          });
        }
      } catch (e) {
        broadcast({ type: 'organize:warn', message: `「${code}」拆二级没走通：${(e && e.message) || e}` });
      }
      done += 1;
      broadcast({ type: 'organize:split-progress', done, total: todo.length });
    }
    if (!Object.keys(mapping).length) throw new Error('没有任何类目拆分成功');
    const next = applySubs(plan, mapping);
    await writePlan(next);
    return next;
  },

  'organize:stop': async () => {
    applyCtl.stop = true;
    orgCtl.stop = true;
    return { stopping: true };
  },

  'organize:undo': async ({ journalId } = {}) => runUndo(journalId),

  'organize:journal': async () => {
    const list = await readJournal();
    return {
      latest: latestEntry(list),
      list: list.map(({ ops, ...rest }) => ({ ...rest, count: (ops || []).length })),
      wal: walSummary(await readWal()),
    };
  },

  /** 上次提交中断了：按预写日志幂等反序搬回（只搬仍在目标目录的条目，不搅乱未动条目的顺序） */
  'organize:walRollback': async () => {
    const wal = await readWal();
    if (!wal) return { restored: 0, skipped: 0, none: true };
    if (applyCtl.running) throw new Error('还有提交在进行，先等它结束');
    let restored = 0;
    let skipped = 0;
    for (const step of rollbackSteps(wal)) {
      let node = null;
      try {
        [node] = await chrome.bookmarks.get(step.id);
      } catch {
        node = null;
      }
      if (!shouldRollbackStep(step, node)) {
        skipped += 1;
        continue;
      }
      try {
        await chrome.bookmarks.move(step.id, { parentId: step.fromFolderId, index: step.fromIndex });
        restored += 1;
      } catch {
        try {
          await chrome.bookmarks.move(step.id, { parentId: step.fromFolderId });
          restored += 1;
        } catch {}
      }
    }
    await writeWal(null);
    broadcast({ type: 'state:changed' });
    return { restored, skipped, total: walSummary(wal).count };
  },

  /** 用户确认「就这样吧」：只清掉意图，不回滚 */
  'organize:walClear': async () => {
    await writeWal(null);
    return { cleared: true };
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
    const op = plan.ops.find((o) => o.id === id);
    const settings = await readSettings();
    const tree = await chrome.bookmarks.getTree();
    const exists = new Set(parseTree(tree, parseOptsFor(settings)).folderScheme.map((f) => f.code));
    if (op && op.url) {
      const learned = recordOverride(await readLearned(), { host: hostOf(op.url) }, code);
      await chrome.storage.local.set({ learned });
    }
    const next = overrideOp(plan, id, code, { existing: exists });
    await writePlan(next);
    return next;
  },

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

  'backup:restore': async ({ id, snapshotJson, mode = 'safe' }) => {
    const snap = snapshotJson ? validateSnapshot(snapshotJson) : await readBackup(id);
    return mode === 'replace' ? restoreSnapshotReplace(snap) : restoreSnapshotSafe(snap);
  },

  'backup:clear': async () => clearBackups(),

  'backup:check': async ({ planId = '', planAt = 0 }) => checkBackupReady(await listBackups(), { id: planId, at: planAt }),

  /** 只把某套方案设为「当前方案」，不建任何目录：给所有分类入口与按方案建档用 */
  'scheme:select': async ({ schemeId }) => {
    const settings = await readSettings();
    const scheme = getScheme(schemeId, settings.customSchemes || []);
    if (!scheme) throw new Error('没有这个方案');
    const sw = await migrateSchemeState(settings.schemeId, schemeId, settings.customSchemes || []);
    await chrome.storage.local.set({ settings: { ...settings, schemeId } });
    broadcast({ type: 'state:changed' });
    return { selected: true, schemeId, ...sw };
  },

  'scheme:install': async ({ schemeId }) => {
    const settings = await readSettings();
    const scheme = getScheme(schemeId, settings.customSchemes || []);
    if (!scheme) throw new Error('没有这个方案');
    const res = await commitOps({
      planId: 'install:' + schemeId,
      folders: (scheme.folders || []).map((f) => ({ code: f.code, name: f.name, parent: f.parent || null })),
      ops: [],
      backup: false,
      journal: false,
    });
    if (res.conflict.length) return { installed: false, conflict: res.conflict };

    // 换方案 → 已有建议/域名记忆/旧计划显式迁移或作废并计数
    const sw = await migrateSchemeState(settings.schemeId, schemeId, settings.customSchemes || []);

    const next = { ...settings, schemeId };
    await chrome.storage.local.set({ settings: next });
    broadcast({ type: 'state:changed' });
    return { installed: true, created: res.created, reused: res.reused, schemeId, ...sw };
  },

  'bookmarks:update': async ({ id, title, url }) => {
    const changes = {};
    if (title != null) changes.title = title;
    if (url != null) changes.url = url;

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
          await chrome.bookmarks.move(it.id, { parentId: it.oldParentId });
          restored += 1;
        } else if (it.type === 'delete') {
          await chrome.bookmarks.create({
            parentId: it.parentId || '1',
            title: it.title,
            url: it.url,
            index: it.index,
          });
          restored += 1;
        } else if (it.type === 'url') {
          await chrome.bookmarks.update(it.id, { url: it.oldUrl });
          restored += 1;
        } else if (it.type === 'title') {
          await chrome.bookmarks.update(it.id, { title: it.title });
          restored += 1;
        }
      } catch (e) {
        console.warn('[归藏] 撤销还原失败', it, e);
      }
    }
    broadcast({ type: 'state:changed' });
    return { restored };
  },

  'open:manager': async (opts = {}) => openManagerTab(opts),
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
  return true;
});

/* ── Chrome 原生超能力 1：地址栏 Omnibox 秒搜（关键词 gz） ── */

if (chrome.omnibox) {
  chrome.omnibox.setDefaultSuggestion({
    description: '归藏秒搜 — 输入标题、拼音首字母（如 rgzn）、#标签 或 domain:域名，回车直达书库',
  });

  chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
    try {
      const state = await loadState();
      const dupIds = duplicateIdSet(findDuplicates(state.items));
      const list = buildOmniboxSuggestions(
        state.items,
        text,
        { health: state.health, meta: state.meta, scheme: state.folderScheme, dupIds },
        6,
      );
      suggest(list);
    } catch {
      suggest([]);
    }
  });

  chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
    const trimmed = String(text || '').trim();
    if (/^https?:\/\//i.test(trimmed)) {
      if (disposition === 'currentTab') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) await chrome.tabs.update(tab.id, { url: trimmed });
        else await chrome.tabs.create({ url: trimmed });
      } else if (disposition === 'newBackgroundTab') {
        await chrome.tabs.create({ url: trimmed, active: false });
      } else {
        await chrome.tabs.create({ url: trimmed, active: true });
      }
      return;
    }
    await openManagerTab(trimmed ? { q: trimmed } : {});
  });
}

/* ── Chrome 原生超能力 2：右键菜单快收 ─────────────────────── */

function setupContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'guizang-save-page',
      title: '归藏：收当前页进「待归类」',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'guizang-save-link',
      title: '归藏：收此链接进「待归类」',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'guizang-open-manager',
      title: '归藏：打开全屏书库',
      contexts: ['action', 'page'],
    });
  });
}

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'guizang-open-manager') {
      await openManagerTab({});
      return;
    }
    const url = info.menuItemId === 'guizang-save-link' ? info.linkUrl : (info.pageUrl || (tab && tab.url));
    const title = info.menuItemId === 'guizang-save-link'
      ? (info.selectionText || info.linkUrl)
      : ((tab && tab.title) || url);
    if (!url || !/^https?:/i.test(url)) return;
    const { inboxId } = await ensureInbox();
    const existing = await chrome.bookmarks.search({ url });
    if (!existing.length) {
      await chrome.bookmarks.create({ parentId: inboxId, title: title || url, url });
    }
    await flashBadge('✓', '#346347', 1800);
    broadcast({ type: 'state:changed' });
  });
}

/* ── Chrome 原生超能力 3：全局快捷键 Commands ──────────────── */

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'open-manager') {
      await openManagerTab({});
      return;
    }
    if (command === 'stash-current') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return;
      const { inboxId } = await ensureInbox();
      const existing = await chrome.bookmarks.search({ url: tab.url });
      if (!existing.length) {
        await chrome.bookmarks.create({ parentId: inboxId, title: tab.title || tab.url, url: tab.url });
      }
      await flashBadge('✓', '#346347', 1800);
      broadcast({ type: 'state:changed' });
      return;
    }
    if (command === 'stash-window') {
      const r = await stashWindowTabs({ closeTabs: false });
      await flashBadge(`+${r.saved}`, '#1E4468', 2600);
    }
  });
}

/* ── Chrome 原生超能力 4：可选周期静默体检（alarms） ───────── */

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== WEEKLY_ALARM || scan.running) return;
    try {
      const state = await loadState();
      if (!state.settings.autoCheckWeekly) return;
      // 优先测未检测过的，再测最久未检测的
      const pool = state.items
        .slice()
        .sort((a, b) => ((state.health[a.id]?.at || 0) - (state.health[b.id]?.at || 0)))
        .slice(0, state.settings.checkLimit || 60)
        .map((it) => it.id);
      if (pool.length) await runHealth(pool, { silent: true });
    } catch {}
  });
}

/* 书签被外部改动时让界面刷新 */
chrome.bookmarks.onCreated.addListener(() => broadcast({ type: 'state:changed' }));
chrome.bookmarks.onRemoved.addListener((id, info) => {
  chrome.storage.local.get(['health', 'pending', 'meta']).then(({ health = {}, pending = {}, meta = {} }) => {
    let dirty = false;
    const drop = (k) => {
      if (health[k]) { delete health[k]; dirty = true; }
      if (pending[k]) { delete pending[k]; dirty = true; }
      if (meta[k]) { delete meta[k]; dirty = true; }
    };
    drop(id);
    (info.node.children || []).forEach((c) => drop(c.id));
    if (dirty) chrome.storage.local.set({ health, pending, meta });
  });
  broadcast({ type: 'state:changed' });
});
chrome.bookmarks.onChanged.addListener(() => broadcast({ type: 'state:changed' }));

chrome.runtime.onInstalled.addListener(async (details) => {
  setupContextMenus();
  const s = await readSettings();
  if (details.reason === 'install') {
    await chrome.storage.local.set({ settings: s });
    await ensureInbox(undefined, s).catch(() => {});
  }
  await syncWeeklyAlarm(Boolean(s.autoCheckWeekly));
});
