/**
 * 本地预览用的 chrome.* 模拟层。
 *
 * 只在非 chrome-extension:// 页面生效（见 ui/env.js）。
 * 书签树、分类识别、关键词归类都复用 lib/ 里的真实实现，
 * 只有网络请求（模型、链接体检）是假的。
 */

import { parseTree } from '../lib/tree.js';
import { parseOptsOf, listSchemes, getScheme, sanitizeCustomScheme } from '../lib/schemes.js';
import { planInstall } from '../lib/scheme-install.js';
import { flattenTree, checkBackupReady, validateSnapshot, rebuildSubtree } from '../lib/backup.js';
import { PROTO } from '../lib/version.js';
import { classify, classifyHeuristic, cleanTitles, DEFAULT_SETTINGS } from '../lib/llm.js';
import { runAccept } from '../lib/pending.js';
import { DEWEY_HINTS } from '../lib/schemes.js';
import {
  createTaxonomy, pruneTaxonomy, buildTaxonomyFromSkeleton, assignByRules, approveTaxonomy, toScheme,
  planExtend, applyExtend, acceptProposals, coverageOf,
} from '../lib/taxonomy.js';
import { buildPlan, dropOp, overrideOp, readyOps } from '../lib/organize.js';
import { normalizeUrl, findDuplicates } from '../lib/dedup.js';
import {
  normalizeMeta, emptyLearned, recordOverride, removeLearnedDomain,
  pickSerendipity, analyzeUsage,
} from '../lib/meta.js';

const FOLDERS = [
  ['000', '综合与工具'],
  ['100', '编程与后端'],
  ['200', '数据与中间件'],
  ['300', '网络与通信'],
  ['400', '系统与运维'],
  ['500', '人工智能'],
  ['600', 'Web 与前端'],
  ['700', '学习与文献'],
  ['800', '资讯与社区'],
  ['900', '娱乐与生活'],
];

/** [标题, 地址, 分类, 添加日期, 预置状态] */
const ROWS = [
  ['杜威十进分类法 · 维基百科', 'https://zh.wikipedia.org/wiki/杜威十进图书分类法', '000', '2026-03-11', 'ok'],
  ['Excalidraw · 手绘风白板', 'https://excalidraw.com', '000', '2026-02-18', 'ok'],
  ['Raycast · 启动器手册', 'https://manual.raycast.com', '000', '2025-12-04', '301', 'https://www.raycast.com/core-features/quicklinks'],
  ['GitHub · Personal Access Tokens', 'https://github.com/settings/tokens', '000', '2026-09-22', 'ok'],
  ['我的信息整理系统 · 少数派', 'https://sspai.com/post/58921', '000', '2024-11-07', '404'],

  ['Rust 程序设计语言 · 中文版', 'https://doc.rust-lang.org/book/zh-CN/', '100', '2026-10-30', 'ok'],
  ['Go by Example', 'https://gobyexample.com', '100', '2026-08-14', 'ok'],
  ['TypeScript 手册 · Everyday Types', 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html', '100', '2026-07-02', 'ok'],
  ['深入理解 JVM · 读书笔记', 'https://blog.csdn.net/dev_note/article/details/118822', '100', '2025-06-19', '403'],
  ['Effective Java 第三版 · 笔记', 'https://notes.old-blog.cn/effective-java', '100', '2024-03-02', '超时'],
  ['Node.js 文档 · Stream 模块', 'https://nodejs.org/api/stream.html', '100', '2026-05-21', 'ok'],

  ['PostgreSQL 18 · Indexes 章节', 'https://www.postgresql.org/docs/18/indexes.html', '200', '2026-11-09', 'ok'],
  ['Redis 设计与实现 · 全书', 'https://redisbook.com', '200', '2026-01-16', 'ok'],
  ['Kafka 权威指南 · 第 4 章', 'https://developer.confluent.io/courses/kafka-101/', '200', '2026-04-08', 'ok'],
  ['ClickHouse · 中文文档', 'https://clickhouse.com/docs/zh', '200', '2026-06-25', 'ok'],
  ['Elasticsearch 8.x · 查询 DSL 备忘', 'https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl.html', '200', '2025-10-13', 'ok'],

  ['HTTP/3 Explained · 中文版', 'https://http3-explained.haxx.se/zh', '300', '2026-09-05', 'ok'],
  ['RFC 9110 · HTTP Semantics', 'https://www.rfc-editor.org/rfc/rfc9110.html', '300', '2026-02-27', 'ok'],
  ['Cloudflare Learning · DNS 原理', 'https://www.cloudflare.com/learning/dns/what-is-dns/', '300', '2025-11-30', 'ok'],
  ['图解 TCP/IP · 第 5 章笔记', 'https://juejin.cn/post/6844903612345678', '300', '2025-03-17', '410'],
  ['Wireshark 抓包实战', 'https://lab.net-study.cn/wireshark', '300', '2025-01-09', '拒连'],

  ['Docker · Compose 文件规范', 'https://docs.docker.com/compose/compose-file/', '400', '2026-10-11', 'ok'],
  ['Kubernetes · Pod 生命周期', 'https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/', '400', '2026-08-30', 'ok'],
  ['systemd.service 手册页', 'https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html', '400', '2026-05-07', 'ok'],
  ['Nginx · 配置速查表', 'https://nginx.org/en/docs/dirindex.html', '400', '2026-03-28', 'ok'],
  ['tmux 快捷键速查卡', 'https://tmuxcheatsheet.com', '400', '2025-09-14', '301', 'https://tmuxguide.dev/cheatsheet'],

  ['Attention Is All You Need · arXiv', 'https://arxiv.org/abs/1706.03762', '500', '2026-11-02', 'ok'],
  ['Anthropic · Claude API 文档', 'https://docs.anthropic.com/en/api/getting-started', '500', '2026-10-27', 'ok'],
  ['Model Context Protocol · 规范', 'https://modelcontextprotocol.io/specification', '500', '2026-09-18', 'ok'],
  ['LangChain · Memory 模块', 'https://python.langchain.com/docs/modules/memory/', '500', '2026-07-24', 'ok'],
  ['nanoGPT · 从零实现 Transformer', 'https://github.com/karpathy/nanoGPT', '500', '2026-06-12', 'ok'],
  ['大模型推理优化 · vLLM 笔记', 'https://zhuanlan.zhihu.com/p/639341234', '500', '2025-12-21', '404'],

  ['React 19 · Server Components', 'https://react.dev/reference/rsc/server-components', '600', '2026-11-06', 'ok'],
  ['Tailwind CSS v4 · 主题变量', 'https://tailwindcss.com/docs/theme', '600', '2026-10-02', 'ok'],
  ['MDN · CSS Grid 布局指南', 'https://developer.mozilla.org/zh-CN/docs/Web/CSS/CSS_grid_layout', '600', '2026-04-19', 'ok'],
  ['web.dev · Core Web Vitals', 'https://web.dev/articles/vitals', '600', '2026-01-30', 'ok'],
  ['CSS 动画性能优化 · 旧笔记', 'https://css-tricks.com/using-requestanimationframe/', '600', '2024-08-23', '404'],

  ['中国哲学书电子化计划', 'https://ctext.org/zh', '700', '2025-05-11', 'ok'],
  ['豆瓣 ·《如何阅读一本书》笔记', 'https://book.douban.com/review/1021/', '700', '2024-12-06', 'ok'],
  ['Semantic Scholar · 论文检索', 'https://www.semanticscholar.org', '700', '2026-02-09', 'ok'],
  ['数学之美 · 第 2 版', 'https://pan.baidu.com/s/1kQ7x2mZ', '700', '2025-02-15', '403'],

  ['Hacker News', 'https://news.ycombinator.com', '800', '2026-11-10', 'ok'],
  ['V2EX · 酷工作', 'https://www.v2ex.com/?tab=jobs', '800', '2026-07-11', 'ok'],
  ['掘金 · 前端周刊', 'https://juejin.cn/frontend', '800', '2026-03-05', 'ok'],
  ['即刻 · AI 探索站', 'https://web.okjike.com/topic/ai', '800', '2025-08-08', '410'],

  ['豆瓣电影 · 2026 年度榜单', 'https://movie.douban.com/annual/2026', '900', '2026-01-02', 'ok'],
  ['Bilibili · 我的收藏夹', 'https://space.bilibili.com/favlist', '900', '2026-02-14', 'ok'],
  ['Spotify · Focus 歌单', 'https://open.spotify.com/playlist/focus', '900', '2025-11-19', 'ok'],

  ['用 eBPF 观测内核网络栈', 'https://blog.cloudflare.com/ebpf-network-observability/', null, '2026-11-11', 'ok'],
  ['Bun 1.2 发布说明', 'https://bun.sh/blog/bun-v1.2', null, '2026-11-11', 'ok'],
  ['向量数据库选型 · Milvus / Qdrant', 'https://zilliz.com/blog/vector-database-comparison', null, '2026-11-10', 'ok'],
  ['A2A 协议白皮书', 'https://a2a-protocol.org/whitepaper', null, '2026-11-10', 'ok'],
  ['OpenWrt 路由器固件刷写指南', 'https://openwrt.org/docs/guide-user/installation', null, '2026-11-09', 'ok'],
  ['后端面试八股清单 · 2026 版', 'https://github.com/backend-interview/notes', null, '2026-11-08', 'ok'],
  ['(3) Attention Is All You Need · 重复收藏示例', 'https://arxiv.org/abs/1706.03762?utm_source=twitter', null, '2026-11-12', 'ok'],
  ['Excalidraw 白板（旧链重复）', 'http://www.excalidraw.com/#board', null, '2025-04-02', 'ok'],
];

/**
 * 归纳完成之后才存进来的几条收藏（预览用，?new=1 时注入）。
 * 标题里带现有类目的中文词元，扩展阶段规则能命中，用来验证「归入 > 0 且未覆盖同步下降」。
 */
const LATE_ROWS = [
  ['编程语言内存模型清单', 'https://rust-book.example.org/memory-model', '2026-11-20'],
  ['网络抓包排障手记', 'https://net.example.net/tcpdump-notes', '2026-11-21'],
  ['人工智能模型微调笔记', 'https://llm.example.dev/finetune', '2026-11-22'],
  ['前端构建工具踩坑记录', 'https://fe.example.dev/build-notes', '2026-11-23'],
];

const STATUS = {
  ok: { status: 'ok', code: '200' },
  301: { status: 'moved', code: '301' },
  404: { status: 'dead', code: '404' },
  410: { status: 'dead', code: '410' },
  403: { status: 'blocked', code: '403' },
  超时: { status: 'timeout', code: '超时' },
  拒连: { status: 'unreachable', code: '拒连' },
};

let root;
let health = {};
let pending = {};
let meta = {
  b06: { tags: ['rust', '语言'], note: '官方圣经，常翻常新', star: true, readState: 'read', updatedAt: Date.now() },
  b27: { tags: ['transformer', '论文'], note: '精读 Attention 机制必看', star: true, readState: 'unread', updatedAt: Date.now() },
  b29: { tags: ['mcp', 'agent'], note: '工具协议规范参考', star: false, readState: 'unread', updatedAt: Date.now() },
  b49: { tags: ['ebpf', '内核'], note: '周末精读', star: false, readState: 'unread', updatedAt: Date.now() },
};
let learned = {
  domains: {
    'doc.rust-lang.org': { code: '100', count: 3, at: Date.now() - 86400000 * 2 },
    'arxiv.org': { code: '500', count: 2, at: Date.now() - 86400000 * 5 },
  },
};
let usageCache = null;
let mockTheme = 'system';
let settings = { ...DEFAULT_SETTINGS };
let taxoDraft = null;      // 分类法草稿（本地预览内存态）
let plan = null;           // 整理计划（本地预览内存态）
let journal = [];          // 整理日志
let backups = [];          // 只存索引（本地预览用，刷新即重置）
let backupNodes = {};      // id → 完整快照
let backupSeq = 0;
const listeners = [];

function buildTree() {
  root = { id: '0', title: '', children: [] };
  const bar = { id: '1', title: '书签栏', parentId: '0', children: [] };
  root.children.push(bar, { id: '2', title: '其他书签', parentId: '0', children: [] });

  const byCode = new Map();
  for (const [code, name] of FOLDERS) {
    const node = { id: 'f' + code, title: `${code} ${name}`, parentId: '1', children: [] };
    bar.children.push(node);
    byCode.set(code, node);
  }

  const inbox = { id: 'finbox', title: '待归类', parentId: '1', children: [] };
  bar.children.push(inbox);
  byCode.set('inbox', inbox);

  ROWS.forEach(([title, url, code, added, mark, finalUrl], i) => {
    const id = 'b' + String(i + 1).padStart(2, '0');
    const parent = code ? byCode.get(code) : inbox;
    parent.children.push({
      id, title, url,
      parentId: parent.id,
      dateAdded: Date.parse(added + 'T09:00:00'),
    });
    const s = STATUS[mark];
    if (s) {
      health[id] = { ...s, at: Date.parse('2026-11-12T13:40:00'), ms: 180 + i * 7 };
      if (finalUrl) health[id].finalUrl = finalUrl;
    }
  });
}

/** ?new=1 用：把「归纳之后才存的」几条塞进待归类，模拟用户又存了新链接 */
let lateInjected = false;
function injectLateRows() {
  const inbox = findNode('finbox');
  if (!inbox) return 0;
  LATE_ROWS.forEach(([title, url, added], i) => {
    const id = 'bl' + String(i + 1).padStart(2, '0');
    inbox.children.push({
      id, title, url, parentId: inbox.id, dateAdded: Date.parse(added + 'T09:00:00'),
    });
    health[id] = { status: 'ok', code: '200', at: Date.parse('2026-11-22T10:00:00'), ms: 150 + i * 9 };
  });
  lateInjected = true;
  return LATE_ROWS.length;
}

function walk(node, fn) {
  fn(node);
  (node.children || []).forEach((c) => walk(c, fn));
}

function findNode(id) {
  let hit = null;
  walk(root, (n) => { if (n.id === id) hit = n; });
  return hit;
}

function detach(node) {
  const parent = findNode(node.parentId || '');
  if (parent && parent.children) {
    parent.children = parent.children.filter((c) => c.id !== node.id);
  }
}

function emit(msg) {
  listeners.forEach((fn) => { try { fn(msg); } catch (e) { console.warn(e); } });
}

function stateLoad() {
  const { items, folders, scheme, inboxId } = parseTree(
    [JSON.parse(JSON.stringify(root))],
    parseOptsOf(settings.schemeId, settings.customSchemes || []),
  );
  // 与真实后台一致：目标编码已不存在的建议直接剔除
  const codes = new Set(scheme.map((f) => f.code));
  let pendingDropped = 0;
  for (const [id, p] of Object.entries(pending)) {
    if (!p || !p.code || !codes.has(p.code)) { delete pending[id]; pendingDropped += 1; }
  }
  return {
    items, folders, scheme, inboxId,
    health: JSON.parse(JSON.stringify(health)),
    pending: JSON.parse(JSON.stringify(pending)),
    pendingDropped,
    meta: JSON.parse(JSON.stringify(meta)),
    learned: JSON.parse(JSON.stringify(learned)),
    usageCache: usageCache ? JSON.parse(JSON.stringify(usageCache)) : null,
    settings: { ...settings },
    aiReady: Boolean(settings.apiKey && settings.model),
    scan: { running: false, done: 0, total: 0 },
  };
}

function summaryLoad() {
  const { items, scheme, inboxId } = parseTree(
    [JSON.parse(JSON.stringify(root))],
    parseOptsOf(settings.schemeId, settings.customSchemes || []),
  );
  let dead = 0, susp = 0, moved = 0, unchecked = 0, inbox = 0;
  for (const it of items) {
    if (!it.code) inbox += 1;
    const h = health[it.id];
    if (!h) unchecked++;
    else if (['dead', 'error', 'timeout', 'unreachable'].includes(h.status)) dead++;
    else if (h.status === 'blocked') susp++;
    else if (h.status === 'moved') moved++;
  }
  const dups = findDuplicates(items);
  const serendipity = pickSerendipity(items, { health, meta, count: 3, seed: 42 })
    .map((it) => ({ id: it.id, title: it.title, url: it.url, host: it.host, code: it.code, added: it.added }));
  return {
    scheme, inboxId, settings, meta: JSON.parse(JSON.stringify(meta)), aiReady: Boolean(settings.apiKey && settings.model),
    counts: {
      all: items.length, dead, susp, moved, dups: dups.length, unchecked, inbox,
      pending: Object.keys(pending).length,
    },
    serendipity,
    recent: items.slice(0, 8).map((it) => ({
      id: it.id, title: it.title, url: it.url, host: it.host, code: it.code,
      added: it.added, health: health[it.id] ? { ...health[it.id] } : null,
    })),
    scan: { running: false, done: 0, total: 0 },
  };
}

async function handle(msg) {
  const { type } = msg;

  if (type === 'state:load') return stateLoad();
  if (type === 'summary:load') return summaryLoad();
  if (type === 'theme:get') return { theme: mockTheme };
  if (type === 'theme:set') {
    mockTheme = msg.theme;
    emit({ type: 'theme:changed', theme: mockTheme });
    return { theme: mockTheme };
  }

  if (type === 'bookmarks:move' || type === 'bookmarks:moveCode') {
    const target = type === 'bookmarks:move'
      ? findNode(msg.folderId)
      : [...findNode('1').children].find((n) => n.title.startsWith(msg.code + ' '));
    if (!target) throw new Error('目标分类不存在');
    let moved = 0;
    for (const id of msg.ids) {
      const n = findNode(id);
      if (!n) continue;
      detach(n);
      n.parentId = target.id;
      target.children.push(n);
      if (msg.learn && msg.code && n.url) {
        try {
          const host = new URL(n.url).host.replace(/^www\./, '');
          learned = recordOverride(learned, { host }, msg.code);
        } catch {}
      }
      moved++;
    }
    emit({ type: 'state:changed' });
    return { moved, code: msg.code, name: target.title.replace(/^\S+\s*/, '') };
  }

  if (type === 'bookmarks:batchRename') {
    let renamed = 0;
    const prev = [];
    for (const c of msg.changes || []) {
      const n = findNode(c.id);
      if (!n || !c.title) continue;
      prev.push({ id: n.id, title: n.title });
      n.title = c.title;
      renamed += 1;
    }
    emit({ type: 'state:changed' });
    return { renamed, prev };
  }

  if (type === 'tabs:stashWindow') {
    const tabs = [
      { title: 'HTTP 缓存 · MDN Web 文档', url: 'https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Caching' },
      { title: 'SQLite Query Planner', url: 'https://www.sqlite.org/queryplanner.html' },
    ];
    const st = stateLoad();
    const seen = new Set(st.items.map((it) => normalizeUrl(it.url)));
    let saved = 0, skipped = 0;
    for (const t of tabs) {
      if (seen.has(normalizeUrl(t.url))) { skipped += 1; continue; }
      seen.add(normalizeUrl(t.url));
      buildSave({ url: t.url, title: t.title, folderId: msg.folderId || st.inboxId });
      saved += 1;
    }
    emit({ type: 'state:changed' });
    return { saved, skipped, closed: 0 };
  }

  if (type === 'health:applyRedirects') {
    const targetIds = (msg.ids && msg.ids.length)
      ? msg.ids
      : Object.entries(health).filter(([, h]) => h && h.status === 'moved' && h.finalUrl).map(([id]) => id);
    const prev = [];
    let updated = 0;
    for (const id of targetIds) {
      const h = health[id];
      const n = findNode(id);
      if (!h || !h.finalUrl || !n) continue;
      prev.push({ id, oldUrl: n.url });
      n.url = h.finalUrl;
      delete health[id];
      updated += 1;
    }
    emit({ type: 'state:changed' });
    return { updated, prev };
  }

  if (type === 'wayback:lookup') {
    return {
      available: true,
      url: `https://web.archive.org/web/20241101120000/${msg.url}`,
      timestamp: '20241101120000',
      dateLabel: '2024-11-01',
      browseUrl: `https://web.archive.org/web/*/${msg.url}`,
    };
  }

  if (type === 'meta:set') {
    const next = normalizeMeta(msg.patch, meta[msg.id]);
    if (next) meta[msg.id] = next;
    else delete meta[msg.id];
    emit({ type: 'state:changed' });
    return { id: msg.id, entry: next };
  }

  if (type === 'meta:batchTag') {
    const clean = String(msg.tag || '').trim().replace(/^#+/, '');
    if (!clean) throw new Error('标签不能为空');
    let count = 0;
    for (const id of msg.ids || []) {
      const prev = meta[id] || {};
      const next = normalizeMeta({ tags: [...(prev.tags || []), clean] }, prev);
      if (next) { meta[id] = next; count += 1; }
    }
    emit({ type: 'state:changed' });
    return { count, tag: clean };
  }

  if (type === 'learned:list') return JSON.parse(JSON.stringify(learned));
  if (type === 'learned:remove') {
    learned = removeLearnedDomain(learned, msg.host);
    emit({ type: 'state:changed' });
    return JSON.parse(JSON.stringify(learned));
  }
  if (type === 'learned:clear') {
    learned = emptyLearned();
    emit({ type: 'state:changed' });
    return JSON.parse(JSON.stringify(learned));
  }

  if (type === 'history:analyze') {
    const st = stateLoad();
    const now = Date.now();
    const fakeHistory = [
      { url: 'https://doc.rust-lang.org/book/zh-CN/', visitCount: 18, lastVisitTime: now - 86400000 * 2 },
      { url: 'https://github.com/settings/tokens', visitCount: 9, lastVisitTime: now - 86400000 * 4 },
      { url: 'https://react.dev/reference/rsc/server-components', visitCount: 6, lastVisitTime: now - 86400000 * 6 },
      { url: 'https://docs.anthropic.com/en/api/getting-started', visitCount: 12, lastVisitTime: now - 86400000 * 1 },
    ];
    usageCache = analyzeUsage(st.items, fakeHistory, { now });
    emit({ type: 'state:changed' });
    return usageCache;
  }

  if (type === 'ai:cleanTitles') {
    const st = stateLoad();
    const set = new Set(msg.ids || []);
    const targets = set.size ? st.items.filter((it) => set.has(it.id)) : st.items;
    const items = await cleanTitles(targets, settings);
    return { items };
  }

  if (type === 'bookmarks:remove') {
    let removed = 0;
    for (const id of msg.ids) {
      const n = findNode(id);
      if (!n) continue;
      detach(n);
      delete health[id];
      delete pending[id];
      removed++;
    }
    emit({ type: 'state:changed' });
    return { removed };
  }

  if (type === 'bookmark:save') {
    buildSave(msg);
    emit({ type: 'state:changed' });
    return { id: 'new' };
  }

  if (type === 'health:run') {
    const ids = msg.ids.slice(0, settings.checkLimit || 60);
    emit({ type: 'scan:start', total: ids.length });
    ids.forEach((id, i) => {
      setTimeout(() => {
        const r = health[id] || { status: 'ok', code: '200', at: 0, ms: 120 };
        health[id] = { ...r, at: Date.now() };
        emit({ type: 'scan:progress', done: i + 1, total: ids.length, id, result: health[id] });
        if (i === ids.length - 1) {
          setTimeout(() => emit({ type: 'scan:done', total: ids.length }), 120);
        }
      }, 60 * (i + 1));
    });
    return { started: true };
  }

  if (type === 'health:runUnchecked') {
    const { items } = parseTree([JSON.parse(JSON.stringify(root))], parseOptsOf(settings.schemeId));
    const ids = items.filter((it) => !health[it.id]).map((it) => it.id);
    if (!ids.length) return { started: false, total: 0 };
    return handle({ type: 'health:run', ids });
  }

  if (type === 'health:stop') return { stopped: true };
  if (type === 'health:clear') { health = {}; emit({ type: 'state:changed' }); return { ok: true }; }

  if (type === 'ai:run') {
    const st = stateLoad();
    const set = new Set(msg.ids);
    const targets = st.items.filter((it) => set.has(it.id)).slice(0, 80);
    emit({ type: 'ai:start', total: targets.length });
    const list = await classify(targets, st.scheme, settings);
    await new Promise((r) => setTimeout(r, 420));
    list.forEach((s) => { pending[s.id] = { ...s, at: Date.now() }; });
    emit({ type: 'ai:progress', done: targets.length, total: targets.length });
    emit({ type: 'state:changed' });
    return { suggestions: list, source: 'heuristic' };
  }

  if (type === 'ai:accept') {
    // 与真实后台一致：逐组执行，某组的目标类目找不到不影响其它组
    const r = await runAccept({
      pending,
      ids: msg.ids.filter((id) => pending[id]),
      move: (code, group) => handle({ type: 'bookmarks:moveCode', ids: group, code }),
    });
    for (const id of Object.keys(pending)) {
      if (!Object.prototype.hasOwnProperty.call(r.pending, id)) delete pending[id];
    }
    emit({ type: 'state:changed' });
    return { moved: r.moved, movedIds: r.ops.map((o) => o.id), failed: r.failed, missing: r.missing };
  }

  if (type === 'ai:ignore') {
    msg.ids.forEach((id) => delete pending[id]);
    emit({ type: 'state:changed' });
    return { ok: true };
  }

  if (type === 'ai:ignoreAll') { pending = {}; emit({ type: 'state:changed' }); return { ok: true }; }

  if (type === 'ai:suggestOne') {
    const st = stateLoad();
    const fake = [{
      id: 'tmp', title: msg.title || msg.url, url: msg.url,
      host: (() => { try { return new URL(msg.url).host.replace(/^www\./, ''); } catch { return ''; } })(),
      code: '',
    }];
    const list = await classify(fake, st.scheme, settings);
    const s = list[0] || { code: '', conf: 0, reason: '没有可用的分类', source: 'heuristic' };
    const f = st.scheme.find((x) => x.code === s.code);
    return { ...s, folderId: f ? f.id : null };
  }

  if (type === 'bookmarks:update') {
    const n = findNode(msg.id);
    if (!n) throw new Error('找不到节点');
    const before = n.url;
    if (msg.title != null) n.title = msg.title;
    if (msg.url != null) n.url = msg.url;
    const urlChanged = msg.url != null && msg.url !== before;
    // 地址变了，旧结论描述的是另一个页面
    if (urlChanged && health[n.id]) delete health[n.id];
    emit({ type: 'state:changed' });
    return { id: n.id, title: n.title, url: n.url, urlChanged };
  }

  if (type === 'ping') return { proto: PROTO, version: 'mock' };

  if (type === 'bookmark:check') {
    const hits = [];
    walk(root, (n) => {
      if (n.url && n.url === msg.url) hits.push(n);
    });
    return { exists: hits.length > 0, items: hits };
  }

  if (type === 'bookmarks:restore') {
    for (const it of msg.items || []) {
      if (it.type === 'move') {
        const n = findNode(it.id);
        const parent = findNode(it.oldParentId);
        if (n && parent) {
          detach(n);
          n.parentId = parent.id;
          parent.children.push(n);
        }
      } else if (it.type === 'delete') {
        const parent = findNode(it.parentId) || findNode('1');
        parent.children.push({
          id: it.id || ('n' + Math.random().toString(36).slice(2, 7)),
          title: it.title,
          url: it.url,
          parentId: parent.id,
          dateAdded: Date.now(),
        });
      } else if (it.type === 'url') {
        const n = findNode(it.id);
        if (n) n.url = it.oldUrl;
      } else if (it.type === 'title') {
        const n = findNode(it.id);
        if (n) n.title = it.title;
      }
    }
    emit({ type: 'state:changed' });
    return { restored: (msg.items || []).length };
  }

  if (type === 'taxonomy:design') {
    // 预览层不调模型：直接拿现有方案当骨架，验证「抽样→铺全量→剪枝」这条链路
    const st = stateLoad();
    const skeleton = st.scheme.map((f) => ({ name: f.name, hint: f.hint || DEWEY_HINTS[f.code] || '', children: [] }));
    const built = buildTaxonomyFromSkeleton(skeleton, {});
    const { map, unmatched } = assignByRules(st.items, built.nodes);
    const nodes = built.nodes.map((n) => ({ ...n, members: map[n.code] || [] }));
    const draft = createTaxonomy({
      name: 'mock 归纳',
      nodes,
      params: built.params,
      source: { items: st.items.length, sampled: 0, unmatched: unmatched.length },
    });
    const pruned = pruneTaxonomy(draft, { minPerCategory: 2 });
    taxoDraft = { ...pruned.taxonomy, status: 'draft' };
    taxoDraft.source = { ...taxoDraft.source, unmatched: coverageOf(taxoDraft, st.items).uncovered };
    // 预览专用：?new=1 时归纳完再存几条新收藏，扩展阶段才有东西可归
    if (!lateInjected && typeof location !== 'undefined' && location.search.includes('new')) {
      injectLateRows();
      const cov = coverageOf(taxoDraft, stateLoad().items);
      taxoDraft.source = { ...taxoDraft.source, items: cov.items, unmatched: cov.uncovered };
    }
    // 预览专用：?props=1 时挂一条假建议，用来检查建议清单的渲染
    if (typeof location !== 'undefined' && location.search.includes('props')) {
      const top = taxoDraft.nodes.find((n) => !n.parent);
      if (top) {
        const ids = st.items.slice(0, 5).map((it) => it.id);
        taxoDraft.proposals = [{
          key: 'p_preview.example.com',
          name: 'Preview',
          host: 'preview.example.com',
          parent: top.code,
          members: ids,
          reason: 'preview.example.com 下 5 条',
        }];
      }
    }
    emit({ type: 'taxonomy:start' });
    emit({ type: 'taxonomy:done', draft: taxoDraft });
    return { started: true };
  }
  if (type === 'taxonomy:load') return { draft: taxoDraft, running: false };

  if (type === 'taxonomy:extend') {
    if (!taxoDraft) throw new Error('还没有分类法草稿');
    const st = stateLoad();
    const plan = planExtend(taxoDraft, st.items, { minCluster: msg.minCluster || 8 });
    const assigned = Object.values(plan.assign).reduce((n, ids) => n + ids.length, 0);
    const next = applyExtend(taxoDraft, plan.assign);
    taxoDraft = {
      ...next,
      source: { ...taxoDraft.source, unmatched: plan.pending },
      proposals: [...(taxoDraft.proposals || []), ...plan.proposals],
      lastExtend: { assigned, proposals: plan.proposals.length, unmatched: plan.pending },
    };
    emit({ type: 'taxonomy:done', draft: taxoDraft });
    return { assigned, proposals: plan.proposals.length, unmatched: plan.pending };
  }

  if (type === 'taxonomy:acceptProposals') {
    if (!taxoDraft) throw new Error('还没有分类法草稿');
    const next = acceptProposals(taxoDraft, msg.keys || []);
    if (next === taxoDraft) throw new Error('没有可接受的建议，或父类目已满');
    taxoDraft = next;
    emit({ type: 'taxonomy:done', draft: taxoDraft });
    return next;
  }

  if (type === 'taxonomy:approve') {
    if (!taxoDraft) throw new Error('还没有分类法草稿');
    taxoDraft = approveTaxonomy(taxoDraft, { renames: msg.renames || {}, removed: msg.removed || [] });
    if (!taxoDraft.nodes.length) throw new Error('类目全被删掉了，至少留一个');
    emit({ type: 'taxonomy:done', draft: taxoDraft });
    return taxoDraft;
  }

  if (type === 'taxonomy:install') {
    if (!taxoDraft) throw new Error('还没有分类法草稿');
    if (taxoDraft.status !== 'approved') throw new Error('先审定，再落成目录');
    const scheme = toScheme(taxoDraft);
    const plan = planInstall([JSON.parse(JSON.stringify(root))], scheme);
    if (plan.conflict.length) return { installed: false, conflict: plan.conflict };
    const created = new Map();
    for (const f of plan.missing) {
      const parentId = f.parent
        ? (created.get(f.parent) || (plan.exists.find((e) => e.code === f.parent) || {}).folderId)
        : plan.barId;
      const parent = parentId ? findNode(parentId) : null;
      if (!parent) continue;
      const node = { id: 'f' + scheme.id + f.code, title: `${f.code} ${f.name}`, parentId: parent.id, children: [] };
      parent.children.push(node);
      created.set(f.code, node.id);
    }
    taxoDraft = { ...taxoDraft, status: 'installed', schemeId: scheme.id, installedAt: Date.now() };
    settings = {
      ...settings,
      schemeId: scheme.id,
      customSchemes: [...(settings.customSchemes || []).filter((x) => x.id !== scheme.id), scheme],
    };
    emit({ type: 'taxonomy:done', draft: taxoDraft });
    emit({ type: 'state:changed' });
    return { installed: true, created: created.size, reused: plan.exists.length, schemeId: scheme.id };
  }
  if (type === 'taxonomy:cancel') {
    taxoDraft = null;
    emit({ type: 'taxonomy:done', draft: null });
    return { ok: true };
  }

  if (type === 'organize:plan') {
    const st = stateLoad();
    const scope = msg.scope || 'inbox';
    const picked = scope === 'all' ? st.items : st.items.filter((it) => !it.code);
    emit({ type: 'organize:start' });
    const suggestions = {};
    for (const s of classifyHeuristic(picked, st.scheme, { schemeId: settings.schemeId, learned })) suggestions[s.id] = s;
    plan = buildPlan({ items: st.items, scheme: st.scheme, scope, folderCode: msg.folderCode || '', suggestions });
    emit({ type: 'organize:progress', stage: 'preselect', done: picked.length, total: picked.length });
    emit({ type: 'organize:done', plan });
    return { started: true };
  }
  if (type === 'organize:load') return { plan, running: false, applying: false };

  if (type === 'organize:apply') {
    if (!plan) throw new Error('还没有整理计划');
    const ops = readyOps(plan);
    if (!ops.length) throw new Error('计划里没有可执行的条目');
    // 真实后台在这里会先补一份备份，本地预览照做，避免预览和真机行为不一致
    if (!backups.length) {
      const meta = await handle({ type: 'backup:run', planId: plan.id });
      emit({ type: 'organize:backup-made', meta });
    }
    emit({ type: 'organize:apply-start', total: ops.length });
    const done = [];
    let failed = 0;
    for (const op of ops) {
      const node = findNode(op.id);
      const target = [...findNode('1').children].find((c) => !c.url && String(c.title).startsWith(op.to.code + ' '));
      if (!node || !target) { failed += 1; continue; }
      const fromFolderId = node.parentId;
      const fromIndex = node.index || 0;
      detach(node);
      node.parentId = target.id;
      target.children.push(node);
      done.push({ id: op.id, fromFolderId, fromIndex, toFolderId: target.id, code: op.to.code });
    }
    const entry = {
      id: 'j' + Date.now().toString(36), at: Date.now(), planId: plan.id,
      applied: done.length, failed, ops: done,
    };
    journal = [entry, ...journal].slice(0, 3);
    plan = null;
    emit({ type: 'organize:applied', entry: { ...entry, ops: undefined, count: done.length }, failed, total: ops.length, stopped: false });
    emit({ type: 'organize:done', plan: null });
    emit({ type: 'state:changed' });
    return { applied: done.length, failed, journalId: entry.id };
  }

  if (type === 'organize:stop') return { stopping: true };

  if (type === 'organize:undo') {
    const entry = msg.journalId ? journal.find((e) => e.id === msg.journalId) : journal.find((e) => !e.undoneAt);
    if (!entry) throw new Error('没有可撤销的整理记录');
    let restored = 0;
    for (const rec of [...entry.ops].reverse()) {
      const node = findNode(rec.id);
      const parent = findNode(rec.fromFolderId);
      if (!node || !parent) continue;
      detach(node);
      node.parentId = parent.id;
      parent.children.splice(Math.min(rec.fromIndex, parent.children.length), 0, node);
      restored += 1;
    }
    entry.undoneAt = Date.now();
    emit({ type: 'state:changed' });
    return { restored, total: entry.ops.length };
  }

  if (type === 'organize:journal') {
    return {
      latest: journal.find((e) => !e.undoneAt) || null,
      list: journal.map(({ ops, ...rest }) => ({ ...rest, count: (ops || []).length })),
    };
  }
  if (type === 'organize:cancel') {
    plan = null;
    emit({ type: 'organize:done', plan: null });
    return { ok: true };
  }
  if (type === 'organize:drop') {
    if (!plan) throw new Error('还没有整理计划');
    plan = dropOp(plan, msg.id);
    emit({ type: 'organize:done', plan });
    return plan;
  }
  if (type === 'organize:override') {
    if (!plan) throw new Error('还没有整理计划');
    plan = overrideOp(plan, msg.id, msg.code);
    emit({ type: 'organize:done', plan });
    return plan;
  }

  if (type === 'backup:run') {
    const { nodes, counts } = flattenTree([JSON.parse(JSON.stringify(root))]);
    const id = 'b' + (++backupSeq);
    const at = Date.now();
    const item = { id, at, planId: msg.planId || '', schemeId: settings.schemeId || '', counts, nodes };
    const bytes = new TextEncoder().encode(JSON.stringify(item)).length;
    backups.unshift({ id, at, planId: item.planId, schemeId: item.schemeId, counts, bytes });
    backupNodes[id] = item;
    backups = backups.slice(0, 3);
    return backups[0];
  }
  if (type === 'backup:list') return backups;
  if (type === 'backup:export') {
    const id = msg.id || (backups[0] && backups[0].id);
    if (!id || !backupNodes[id]) throw new Error('还没有备份可导出');
    return JSON.stringify(backupNodes[id], null, 2);
  }
  if (type === 'backup:restore') {
    const raw = msg.snapshotJson ? validateSnapshot(msg.snapshotJson) : backupNodes[msg.id];
    if (!raw) throw new Error('这份备份不存在');
    const bar = findNode('1');
    const folder = { id: 'rest' + Date.now().toString(36), title: '归藏恢复快照', parentId: bar.id, children: [] };
    bar.children.push(folder);
    const roots = rebuildSubtree(raw.nodes);
    let bookmarks = 0;
    const addRec = (node, p) => {
      if (node.url) {
        p.children.push({ id: 'rn' + (++bookmarks), title: node.title, url: node.url, parentId: p.id, dateAdded: Date.now() });
        return;
      }
      const sub = { id: 'rf' + Math.random().toString(36).slice(2, 6), title: node.title || '恢复目录', parentId: p.id, children: [] };
      p.children.push(sub);
      (node.children || []).forEach((c) => addRec(c, sub));
    };
    roots.forEach((r) => addRec(r, folder));
    emit({ type: 'state:changed' });
    return { folderId: folder.id, label: folder.title, bookmarks };
  }
  if (type === 'backup:clear') {
    const removed = backups.length;
    backups = [];
    backupNodes = {};
    return { removed };
  }
  if (type === 'backup:check') return checkBackupReady(backups, { id: msg.planId || '', at: msg.planAt || 0 });

  if (type === 'schemes:list') return { schemes: listSchemes(settings.customSchemes || []), current: settings.schemeId || '' };

  if (type === 'scheme:saveCustom') {
    const clean = sanitizeCustomScheme(msg.scheme);
    const list = [...(settings.customSchemes || [])].filter((s) => s.id !== clean.id);
    list.push(clean);
    settings = { ...settings, customSchemes: list };
    emit({ type: 'state:changed' });
    return { scheme: clean, schemes: listSchemes(list) };
  }

  if (type === 'scheme:deleteCustom') {
    const list = (settings.customSchemes || []).filter((s) => s.id !== msg.schemeId);
    settings = { ...settings, customSchemes: list, schemeId: settings.schemeId === msg.schemeId ? '' : settings.schemeId };
    emit({ type: 'state:changed' });
    return { schemes: listSchemes(list) };
  }

  if (type === 'scheme:preview') {
    const scheme = getScheme(msg.schemeId, settings.customSchemes || []);
    if (!scheme) throw new Error('没有这个方案');
    return planInstall([JSON.parse(JSON.stringify(root))], scheme);
  }

  if (type === 'scheme:install') {
    const scheme = getScheme(msg.schemeId, settings.customSchemes || []);
    if (!scheme) throw new Error('没有这个方案');
    const plan = planInstall([JSON.parse(JSON.stringify(root))], scheme);
    if (plan.conflict.length) return { installed: false, conflict: plan.conflict, plan };
    const bar = findNode(plan.barId);
    for (const f of plan.missing) {
      bar.children.push({ id: 'f' + scheme.id + f.code, title: `${f.code} ${f.name}`, parentId: bar.id, children: [] });
    }
    let dropped = 0;
    if ((settings.schemeId || '') !== msg.schemeId) {
      dropped = Object.keys(pending).length;
      if (dropped) for (const k of Object.keys(pending)) delete pending[k];
    }
    settings = { ...settings, schemeId: msg.schemeId };
    emit({ type: 'state:changed' });
    return { installed: true, created: plan.missing.length, reused: plan.exists.length, schemeId: msg.schemeId, dropped };
  }

  if (type === 'settings:save') { settings = { ...settings, ...msg.settings }; return { settings }; }
  if (type === 'settings:test') throw new Error('本地预览没有真的模型服务');
  if (type === 'open:manager') {
    let target = 'manager.html';
    const hash = msg.hash || (msg.view ? `view=${encodeURIComponent(msg.view)}` : '');
    if (hash) target += '#' + hash;
    location.href = target;
    return { ok: true };
  }

  throw new Error('mock 不认识的指令：' + type);
}

function buildSave(msg) {
  const parent = findNode(msg.folderId) || findNode('finbox') || findNode('1');
  const id = 'n' + Math.random().toString(36).slice(2, 7);
  parent.children.push({
    id, title: msg.title, url: msg.url, parentId: parent.id, dateAdded: Date.now(),
  });
}

/**
 * 本地预览专用：?scheme=clc12 直接把方案装进内存树。
 * 每个页面各有一份 mock 实例，options 页里装的不会自动出现在 manager 页，
 * 所以想看字母类目的渲染效果就用这个参数。
 */
function seedSchemeFromQuery() {
  if (typeof location === 'undefined') return;
  const id = new URLSearchParams(location.search).get('scheme');
  const scheme = id ? getScheme(id) : null;
  if (!scheme) return;
  const bar = findNode('1');
  if (!bar) return;
  for (const f of scheme.folders) {
    const title = `${f.code} ${f.name}`;
    if (!bar.children.some((c) => !c.url && c.title === title)) {
      bar.children.push({ id: 'seed' + scheme.id + f.code, title, parentId: bar.id, children: [] });
    }
  }
  settings = { ...settings, schemeId: scheme.id };
}

export async function install() {
  buildTree();
  seedSchemeFromQuery();

  const api = {
    runtime: {
      async sendMessage(msg) {
        try {
          const data = await handle(msg);
          return { ok: true, data };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        }
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (p) => p,
      getManifest: () => ({ version: '0.7.0-mock' }),
      openOptionsPage: () => { location.href = 'options.html'; },
      lastError: null,
    },
    storage: {
      local: {
        async get(keys) {
          const all = { health, pending, settings };
          if (keys == null) return { ...all };
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((k) => { if (k in all) out[k] = all[k]; });
          return out;
        },
        async set(obj) {
          if ('health' in obj) health = obj.health;
          if ('pending' in obj) pending = obj.pending;
          if ('settings' in obj) settings = obj.settings;
        },
      },
    },
    bookmarks: {
      async getTree() { return [JSON.parse(JSON.stringify(root))]; },
      async search(q) {
        const hits = [];
        walk(root, (n) => {
          if (!n.url) return;
          if (q.url && n.url === q.url) hits.push(n);
          else if (q.query && (n.title.includes(q.query) || n.url.includes(q.query))) hits.push(n);
        });
        return hits.map((n) => ({ ...n }));
      },
      async create({ parentId, title, url }) {
        const parent = findNode(parentId) || findNode('1');
        const node = {
          id: 'n' + Math.random().toString(36).slice(2, 7),
          title, url, parentId: parent.id, dateAdded: Date.now(),
        };
        parent.children.push(node);
        emit({ type: 'state:changed' });
        return { ...node };
      },
      async move(id, { parentId }) {
        const n = findNode(id);
        const parent = findNode(parentId);
        if (!n || !parent) throw new Error('找不到节点');
        detach(n);
        n.parentId = parent.id;
        parent.children.push(n);
        emit({ type: 'state:changed' });
        return { ...n };
      },
      async remove(id) {
        const n = findNode(id);
        if (n) detach(n);
        emit({ type: 'state:changed' });
      },
      async update(id, changes) {
        const n = findNode(id);
        if (!n) throw new Error('找不到节点');
        if (changes.title != null) n.title = changes.title;
        if (changes.url != null) n.url = changes.url;
        emit({ type: 'state:changed' });
        return { ...n };
      },
      onCreated: { addListener() {} },
      onRemoved: { addListener() {} },
      onChanged: { addListener() {} },
    },
    tabs: {
      async query() {
        return [{
          id: 1,
          active: true,
          url: 'https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Caching',
          title: 'HTTP 缓存 · MDN Web 文档',
        }];
      },
      async create({ url }) { window.open(url, '_blank'); },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    permissions: {
      async contains() { return true; },
      async request() { return true; },
      async remove() { return true; },
    },
    sidePanel: { async setPanelBehavior() {} },
  };

  const chromeObj = globalThis.chrome || {};
  for (const key of Object.keys(api)) {
    try {
      chromeObj[key] = api[key];
    } catch (e) {
      console.warn('[mock] 无法覆盖 chrome.' + key, e);
    }
  }
  globalThis.chrome = chromeObj;
  console.info('%c归藏 · 本地预览模式（数据是假的，逻辑是真的）', 'color:#22496E;font-weight:600');
}
