/**
 * 书签树备份 —— 整理之前的「退路」。
 *
 * 只做结构化快照，**不复制书签**：真在 Chrome 里复制一份会让 3000 条变 6000 条。
 * 快照存 chrome.storage.local，环形保留最近 3 份（实测一份 684KB / 3384 节点）。
 *
 * 存法分两层，避免每次列表都把几兆节点读进内存：
 *   backupIndex        → [{ id, at, planId, schemeId, counts, bytes }]   （小）
 *   backup.<id>        → { id, at, planId, schemeId, counts, nodes }     （大）
 *
 * 纯函数（flattenTree / trimIndex / checkBackupReady）不碰 chrome API，可直接在 Node 里测。
 */

export const BACKUP_LIMIT = 3;
export const BACKUP_INDEX_KEY = 'backupIndex';
const ITEM_PREFIX = 'backup.';

export const keyOfBackup = (id) => ITEM_PREFIX + id;

/** 书签树 → 扁平节点列表（含文件夹），丢 children 只留结构关系 */
export function flattenTree(tree) {
  const nodes = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      nodes.push({
        id: c.id,
        parentId: c.parentId || node.id,
        index: c.index ?? 0,
        title: c.title || '',
        url: c.url || '',
        dateAdded: c.dateAdded || 0,
      });
      if (c.children) walk(c);
    }
  };
  const root = tree[0];
  if (root) walk(root);
  const folders = nodes.filter((n) => !n.url).length;
  return { nodes, counts: { folders, bookmarks: nodes.length - folders, nodes: nodes.length } };
}

/** 保留最新的 limit 条，返回 { keep, drop }（index 按时间倒序） */
export function trimIndex(index, limit = BACKUP_LIMIT) {
  const sorted = [...index].sort((a, b) => b.at - a.at);
  return { keep: sorted.slice(0, limit), drop: sorted.slice(limit).map((b) => b.id) };
}

/**
 * 动手之前的闸门：没有「不早于计划」的备份就不许执行。
 * @param {Array} index 备份索引
 * @param {{id?: string, at: number}} plan 计划（at = 创建时间）
 * @returns {{ok: true, backup: object} | {ok: false, code: 'NEED_BACKUP', reason: string}}
 */
export function checkBackupReady(index, plan) {
  const latest = [...(index || [])].sort((a, b) => b.at - a.at)[0];
  if (!latest) {
    return { ok: false, code: 'NEED_BACKUP', reason: '还没有任何备份' };
  }
  const planAt = (plan && plan.at) || 0;
  if (planAt && latest.at < planAt) {
    return { ok: false, code: 'NEED_BACKUP', reason: '最近一次备份早于这次整理计划' };
  }
  return { ok: true, backup: latest };
}

export function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

/** 校验导入/本地快照结构是否合法 */
export function validateSnapshot(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { throw new Error('JSON 解析失败，不是有效的备份文件'); }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.nodes)) {
    throw new Error('备份文件缺少 nodes 字段');
  }
  const nodes = obj.nodes.filter((n) => n && typeof n.id === 'string');
  const folders = nodes.filter((n) => !n.url).length;
  const bookmarks = nodes.length - folders;
  if (!nodes.length) throw new Error('这份备份是空的，没有可恢复的节点');
  return {
    id: String(obj.id || 'import'),
    at: Number(obj.at) || Date.now(),
    schemeId: String(obj.schemeId || ''),
    counts: { folders, bookmarks, nodes: nodes.length },
    nodes,
  };
}

/**
 * 将扁平 nodes 重建为父子层级结构（用于安全恢复到带时间戳的恢复目录，不覆盖现有书签）。
 */
export function rebuildSubtree(nodes) {
  const byId = new Map();
  const childrenOf = new Map();
  for (const n of nodes || []) {
    byId.set(n.id, n);
  }
  const roots = [];
  for (const n of nodes || []) {
    if (n.parentId && byId.has(n.parentId)) {
      if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
      childrenOf.get(n.parentId).push(n);
    } else {
      roots.push(n);
    }
  }
  const attach = (node) => ({
    ...node,
    children: (childrenOf.get(node.id) || [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(attach),
  });
  return roots.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(attach);
}

// ── 下面是碰 chrome API 的薄封装 ─────────────────────

async function readIndex() {
  const store = await chrome.storage.local.get(BACKUP_INDEX_KEY);
  return Array.isArray(store[BACKUP_INDEX_KEY]) ? store[BACKUP_INDEX_KEY] : [];
}

export async function listBackups() {
  return readIndex();
}

export async function saveBackup(tree, { planId = '', schemeId = '' } = {}) {
  const { nodes, counts } = flattenTree(tree);
  const id = 'b' + Date.now().toString(36);
  const at = Date.now();
  const payload = { id, at, planId, schemeId, counts, nodes };
  const bytes = utf8Bytes(JSON.stringify(payload));

  const index = await readIndex();
  index.unshift({ id, at, planId, schemeId, counts, bytes });
  const { keep, drop } = trimIndex(index);

  await chrome.storage.local.set({ [BACKUP_INDEX_KEY]: keep, [keyOfBackup(id)]: payload });
  if (drop.length) await chrome.storage.local.remove(drop.map(keyOfBackup));
  return keep[0];
}

export async function readBackup(id) {
  const store = await chrome.storage.local.get(keyOfBackup(id));
  const hit = store[keyOfBackup(id)];
  if (!hit) throw new Error('这份备份已经不存在了');
  return hit;
}

export async function exportBackup(id) {
  const data = await readBackup(id);
  return JSON.stringify(data, null, 2);
}

export async function clearBackups() {
  const index = await readIndex();
  const keys = [BACKUP_INDEX_KEY, ...index.map((b) => keyOfBackup(b.id))];
  await chrome.storage.local.remove(keys);
  return { removed: index.length };
}
