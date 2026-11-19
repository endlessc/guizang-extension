/**
 * 书签树 → 扁平列表，并识别用户已有的分类体系。
 *
 * 三条规则：
 * 1. 标题形如「000 综合与工具」的文件夹是类目，前三位数字即 code。
 * 2. 名字叫「待归类」的文件夹是收件箱：它不是类目，也不能被当成归类目标，
 *    里面的书签一律 code = ''（待归类）。
 * 3. 书签栏、其他书签、移动设备书签这几个根下面的散条目同样没有分类，
 *    也归入「待归类」——Chrome 自己的默认位置不需要用户再搬一次。
 *
 * 一个 000–900 都没有时，才退化成「一级文件夹当类目」，用 F1…Fn 编号。
 */

const DEWEY_RE = /^(\d{1,3})[\s.·、_-]+(.+)$/;

export const INBOX_TITLE = '待归类';
const INBOX_ALIASES = ['待归类', '未分类', 'inbox', 'Inbox', 'Inbox '];

const KIND_HINT = {
  '000': '通用、效率、工具箱、引擎入口',
  '100': '编程语言、后端服务、框架、面试',
  '200': '数据库、消息队列、搜索、数据工程',
  '300': '网络协议、代理、路由设备、抓包',
  '400': '操作系统、内核、容器、部署运维',
  '500': '模型、论文、智能体、提示工程',
  '600': 'Web、前端框架、CSS、构建工具',
  '700': '图书、论文、课程、方法论',
  '800': '资讯、社区、论坛、周刊',
  '900': '影音、游戏、生活、娱乐',
};

const isInboxTitle = (t) => INBOX_ALIASES.includes(String(t || '').trim());

function safeHost(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * @returns {{items:Array, folders:Array, scheme:Array, inboxId:string|null}}
 */
export function parseTree(tree) {
  const items = [];
  const folders = [];
  const root = tree[0];
  const bars = (root.children || []).filter((n) => !n.url);

  // 先看一眼有没有数字类目：没有的话，一级文件夹就是类目
  let hasDewey = false;
  (function scan(n) {
    for (const c of n.children || []) {
      if (c.url) continue;
      if (DEWEY_RE.test(String(c.title || '').trim())) { hasDewey = true; return; }
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
        const m = DEWEY_RE.exec(title);
        if (m) {
          code = m[1].padStart(3, '0');
          folders.push({
            id: child.id,
            code,
            name: m[2].trim(),
            path: title,
            depth,
            hint: KIND_HINT[code] || '',
          });
        } else if (!hasDewey && depth <= 1) {
          code = 'F' + (++synthetic);
          folders.push({ id: child.id, code, name: title, path: title, depth, hint: '' });
        }
      }

      walk(child, code, depth + 1, nextInbox);
    }
  }

  for (const bar of bars) {
    const title = String(bar.title || '').trim();
    const m = DEWEY_RE.exec(title);
    if (m) {
      const code = m[1].padStart(3, '0');
      folders.push({
        id: bar.id,
        code,
        name: m[2].trim(),
        path: title,
        depth: 0,
        hint: KIND_HINT[code] || '',
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
  const scheme = folders
    .filter((f) => {
      if (!f.code || seen.has(f.code)) return false;
      seen.add(f.code);
      return true;
    })
    .sort((a, b) => {
      if (/^\d+$/.test(a.code) && /^\d+$/.test(b.code)) return Number(a.code) - Number(b.code);
      return a.code.localeCompare(b.code);
    });

  return { items, folders, scheme, inboxId };
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
