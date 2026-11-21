/**
 * 整理日志：执行过哪些移动，用于「撤销这次整理」。
 *
 * 与整树备份的分工：
 *   journal  —— 只记这次动过的条目，撤销时逐条 move 回去（不动别人的书签）
 *   backup   —— 整树快照，只用于灾难恢复（会丢掉备份之后新增的书签）
 *
 * 环形保留最近 3 次。
 */

export const JOURNAL_LIMIT = 3;

export function pushEntry(list, entry, limit = JOURNAL_LIMIT) {
  return [entry, ...(list || [])].slice(0, limit);
}

export function latestEntry(list) {
  return (list || []).find((e) => !e.undoneAt) || null;
}

export function findEntry(list, id) {
  return (list || []).find((e) => e.id === id) || null;
}

export function markUndone(list, id, at = Date.now()) {
  return (list || []).map((e) => (e.id === id ? { ...e, undoneAt: at } : e));
}

/** 一条日志的可撤销条目数（已撤销的算 0） */
export function undoableCount(entry) {
  if (!entry || entry.undoneAt) return 0;
  return (entry.ops || []).length;
}
