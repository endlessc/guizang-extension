/**
 * 提交的预写日志（WAL）。
 *
 * 与「撤销日志（journal）」的区别：
 *   journal  = 做完之后记一笔，用于撤销；
 *   WAL      = 动手之前先把意图落盘，崩在中间能知道「本该做什么、做到哪」。
 *
 * 这里只放纯数据操作，不碰 chrome API，便于在 Node 里断言。
 *   createWal → 一次提交开始
 *   appendSteps → 动手前把这一批的「从哪到哪」写进意图
 *   rollbackSteps → 中断恢复时按反序搬回
 */

/** 开始一次提交：state 先记 prepared，真正做完才由调用方改成 committed 并删除 */
export function createWal({ planId = '', scope = 'inbox', total = 0, at = Date.now() } = {}) {
  return {
    id: 'w' + at.toString(36),
    planId,
    scope,
    at,
    state: 'prepared',
    total,
    steps: [],
  };
}

/** 追加一批步骤（每步：{ id, fromFolderId, fromIndex, toFolderId, code }） */
export function appendSteps(wal, steps = []) {
  if (!wal) return wal;
  return { ...wal, steps: [...(wal.steps || []), ...steps] };
}

/** 给界面看的摘要：不带每步明细 */
export function walSummary(wal) {
  if (!wal) return null;
  return {
    id: wal.id,
    planId: wal.planId || '',
    scope: wal.scope || '',
    at: wal.at,
    state: wal.state || 'prepared',
    count: (wal.steps || []).length,
    total: wal.total || 0,
  };
}

/** 回滚顺序：后进先出，且只保留有原位置的步骤 */
export function rollbackSteps(wal) {
  return [...((wal && wal.steps) || [])]
    .filter((s) => s && s.id && s.fromFolderId)
    .reverse();
}

/** 一次提交完成后，把 WAL 转成 journal 条目（两者字段不同，转换放这里） */
export function walToJournal(wal, { id, at = Date.now(), failed = 0, stopped = false } = {}) {
  return {
    id: id || 'j' + at.toString(36),
    at,
    planId: (wal && wal.planId) || '',
    scope: (wal && wal.scope) || 'inbox',
    applied: (wal && wal.steps ? wal.steps.length : 0),
    failed,
    stopped: Boolean(stopped),
    ops: ((wal && wal.steps) || []).map((s) => ({
      id: s.id, fromFolderId: s.fromFolderId, fromIndex: s.fromIndex, toFolderId: s.toFolderId, code: s.code,
    })),
  };
}
