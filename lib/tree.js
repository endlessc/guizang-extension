import { DEWEY_HINTS } from './schemes.js';

/**
 * 书签树 → 扁平列表，并识别用户已有的分类体系。
 *
 * 三条规则：
 * 1. 标题形如「000 综合与工具」或「T 工业技术」的文件夹是类目，前缀即 code。
 *    数字编码始终生效；字母编码只在传了 opts.letterSet（已安装字母方案）时才认，
 *    否则「B 站」「AI 工具」这种普通文件夹会被误判成类目。
 * 2. 名字叫「待归类」的文件夹是收件箱：它不是类目，也不能被当成归类目标，
 *    里面的书签一律 code = ''（待归类）。
 * 3. 书签栏、其他书签、移动设备书签这几个根下面的散条目同样没有分类，
 *    也归入「待归类」——Chrome 自己的默认位置不需要用户再搬一次。
 *
 * 一个类目都没有时，才退化成「一级文件夹当类目」，用 F1…Fn 编号。
 *
 * @param {Array} tree Chrome 的书签树（[root]）
 * @param {{letterSet?: Set<string>, order?: string[], hintMap?: Record<string,string>}} [opts]
 *        letterSet 字母编码白名单；order 期望的类目顺序；hintMap code → 语义说明。
 *        不传时行为与 0.4.x 完全一致（有解析基线兜底，见 dev/parse-golden.mjs）。
 */

const CODE_RE = /^([A-Za-z]{1,3}|\d{1,3})[\s.·、_-]+(.+)$/;
const DIGIT_RE = /^\d+$/;

export const INBOX_TITLE = '待归类';
const INBOX_ALIASES = ['待归类', '未分类', 'inbox', 'Inbox', 'Inbox '];

/** 数字编码补零到三位（0 → 000），字母编码转大写（tp → TP） */
function normCode(raw) {
  return DIGIT_RE.test(raw) ? raw.padStart(3, '0') : raw.toUpperCase();
}

const isInboxTitle = (t) => INBOX_ALIASES.includes(String(t || '').trim());

function safeHost(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * @returns {{items:Array, folders:Array, folderScheme:Array, scheme:Array, inboxId:string|null}}
 *   folderScheme = 目录投影（书签栏里**已经存在**的类目目录）；
 *   scheme 是它的兼容别名，下一版移除——「分类法（scheme）」请用 getScheme()。
 */
export function parseTree(tree, opts = {}) {
  const items = [];
  const folders = [];
  const root = tree[0];
  const bars = (root.children || []).filter((n) => !n.url);

  const letterSet = opts.letterSet instanceof Set ? opts.letterSet : null;
  const hintMap = opts.hintMap || null;
  const order = Array.isArray(opts.order) ? opts.order.map(normCode) : null;
  const hintOf = (code) => (hintMap && hintMap[code]) || DEWEY_HINTS[code] || '';

  /** 标题 → { code, name }；不认的返回 null */
  function matchTitle(title) {
    const m = CODE_RE.exec(title);
    if (!m) return null;
    const raw = m[1];
    if (!DIGIT_RE.test(raw)) {
      if (!letterSet) return null;
      const up = raw.toUpperCase();
      if (!letterSet.has(up)) return null;
      return { code: up, name: m[2].trim() };
    }
    return { code: normCode(raw), name: m[2].trim() };
  }

  // 先看一眼有没有可识别的类目：一个都没有的话，一级文件夹就是类目
  let hasCode = false;
  (function scan(n) {
    for (const c of n.children || []) {
      if (c.url) continue;
      if (matchTitle(String(c.title || '').trim())) { hasCode = true; return; }
      scan(c);
    }
  })(root);

  let inboxId = null;
  let synthetic = 0;

  function walk(node, parentCode, depth, inInbox) {
    for (const child of node.children || []) {
      if (child.url) {
        items.push({
          id: child.id,
          title: child.title || child.url,
          url: child.url,
          host: safeHost(child.url),
          folderId: node.id,
          code: inInbox ? '' : parentCode,
          inbox: inInbox,
          added: child.dateAdded || 0,
          index: child.index || 0,
        });
        continue;
      }

      const title = String(child.title || '').trim() || '未命名文件夹';
      let code = parentCode;
      let nextInbox = inInbox;

      if (!inInbox && isInboxTitle(title)) {
        if (!inboxId) inboxId = child.id;
        nextInbox = true;
        code = '';
      } else if (!inInbox) {
        const hit = matchTitle(title);
        if (hit) {
          code = hit.code;
          folders.push({
            id: child.id,
            code,
            name: hit.name,
            path: title,
            depth,
            hint: hintOf(code),
          });
        } else if (!hasCode && depth <= 1) {
          code = 'F' + (++synthetic);
          folders.push({ id: child.id, code, name: title, path: title, depth, hint: '' });
        }
      }

      walk(child, code, depth + 1, nextInbox);
    }
  }

  for (const bar of bars) {
    const title = String(bar.title || '').trim();
    const hit = matchTitle(title);
    if (hit) {
      const code = hit.code;
      folders.push({
        id: bar.id,
        code,
        name: hit.name,
        path: title,
        depth: 0,
        hint: hintOf(code),
      });
      walk(bar, code, 1, false);
    } else if (isInboxTitle(title)) {
      if (!inboxId) inboxId = bar.id;
      walk(bar, '', 0, true);
    } else {
      walk(bar, '', 0, false);
    }
  }

  items.sort((a, b) => (b.added || 0) - (a.added || 0));

  const seen = new Set();
  // 传了 order 就按方案定义的顺序排；否则沿用数字升序 / 字母字典序
  const rank = order ? new Map(order.map((c, i) => [c, i])) : null;
  const rankOf = (code) => (rank && rank.has(code) ? rank.get(code) : Number.MAX_SAFE_INTEGER);
  const scheme = folders
    .filter((f) => {
      if (!f.code || seen.has(f.code)) return false;
      seen.add(f.code);
      return true;
    })
    .sort((a, b) => {
      if (rank) {
        const ra = rankOf(a.code);
        const rb = rankOf(b.code);
        if (ra !== rb) return ra - rb;
      }
      if (DIGIT_RE.test(a.code) && DIGIT_RE.test(b.code)) return Number(a.code) - Number(b.code);
      return a.code.localeCompare(b.code);
    });

  // folderScheme 才是这批书签里"现存目录"的投影；scheme 仅作为旧名字保留
  return { items, folders, folderScheme: scheme, scheme, inboxId };
}

export function countByCode(items) {
  const counts = {};
  for (const it of items) {
    const k = it.code || 'none';
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

export function groupByCode(items, scheme) {
  const byCode = new Map();
  for (const it of items) {
    const k = it.code || 'none';
    if (!byCode.has(k)) byCode.set(k, []);
    byCode.get(k).push(it);
  }
  const order = [];
  if (byCode.has('none')) {
    order.push({ code: '—', key: 'none', name: INBOX_TITLE, rows: byCode.get('none') });
  }
  for (const f of scheme) {
    if (byCode.has(f.code)) {
      order.push({ code: f.code, key: f.code, name: f.name, rows: byCode.get(f.code) });
    }
  }
  for (const [k, rows] of byCode) {
    if (k !== 'none' && !scheme.some((f) => f.code === k)) {
      order.push({ code: k, key: k, name: '未在体系中', rows });
    }
  }
  return order;
}
