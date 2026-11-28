/**
 * 分类法（taxonomy）：一次语料分析产出的树，和「方案（scheme）」是两层东西。
 *
 *   taxonomy  —— 候选结构，带成员、统计、受控词表，可能被剪枝、被审定
 *   scheme    —— 装进书签栏的扁平目录表，parseTree / classify / moveToCode 只认它
 *
 * toScheme() 负责把前者折成后者，所以归类链路一行都不用改。
 *
 * 本文件全部是纯函数：不碰 chrome、不碰 DOM、不改入参，可直接在 Node 里测。
 * 剪枝只回答「哪些类目不该存在」，落成目录、移动书签都在别的层。
 */

// maxTop 受三位编码限制：只有 000–900 十个槽，再多就得换编码体系
export const DEFAULT_PARAMS = { maxDepth: 2, maxTop: 10, minPerCategory: 5 };
export const TOP_LIMIT = 10;

const cloneNode = (n) => ({
  code: n.code,
  name: n.name || n.code,
  hint: n.hint || '',
  parent: n.parent || null,
  members: Array.isArray(n.members) ? [...n.members] : [],
});

/** 校验：编码唯一、父节点存在、没有环。有问题直接抛，别让脏数据流进 toScheme */
export function validateTaxonomy(nodes) {
  const byCode = new Map();
  for (const n of nodes) {
    if (!n.code) throw new Error('类目缺少编码');
    if (byCode.has(n.code)) throw new Error(`编码重复：${n.code}`);
    byCode.set(n.code, n);
  }
  for (const n of nodes) {
    if (n.parent && !byCode.has(n.parent)) throw new Error(`父类目不存在：${n.code} → ${n.parent}`);
    let cur = n;
    let hop = 0;
    while (cur && cur.parent) {
      cur = byCode.get(cur.parent);
      hop += 1;
      if (hop > nodes.length) throw new Error(`类目成环：${n.code}`);
    }
  }
  return true;
}

export function createTaxonomy({
  id,
  name = '',
  parentSchemeId = '',
  nodes = [],
  vocab = {},
  params = {},
  source = {},
  now = Date.now(),
} = {}) {
  const normalized = nodes.map(cloneNode);
  validateTaxonomy(normalized);
  return recount({
    id: id || 'tx' + now.toString(36),
    name,
    parentSchemeId,
    vocab: { ...vocab },
    params: { ...DEFAULT_PARAMS, ...params },
    source: { ...source, at: source.at || now },
    nodes: normalized,
  });
}

/** 重算 count（直属成员）/ total（含子类）/ depth / stats，返回新对象 */
export function recount(taxonomy) {
  const nodes = taxonomy.nodes.map(cloneNode);
  const byCode = new Map(nodes.map((n) => [n.code, n]));
  const childrenOf = new Map();
  for (const n of nodes) {
    const key = n.parent || '';
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n);
  }

  const depth = new Map();
  const total = new Map();
  const walk = (node, d) => {
    depth.set(node.code, d);
    let sum = node.members.length;
    for (const child of childrenOf.get(node.code) || []) sum += walk(child, d + 1);
    total.set(node.code, sum);
    return sum;
  };
  for (const root of childrenOf.get('') || []) walk(root, 0);

  for (const n of nodes) {
    n.count = n.members.length;
    n.total = total.get(n.code) || n.members.length;
    n.depth = depth.get(n.code) || 0;
  }

  const stats = computeStats({ ...taxonomy, nodes });
  return { ...taxonomy, nodes, stats };
}

export function computeStats(taxonomy) {
  const nodes = taxonomy.nodes;
  const tops = nodes.filter((n) => !n.parent);
  return {
    categories: nodes.length,
    topCount: tops.length,
    maxDepth: nodes.reduce((m, n) => Math.max(m, n.depth || 0), 0),
    singles: nodes.filter((n) => (n.total || 0) <= 1).length,
    members: tops.reduce((sum, n) => sum + (n.total || 0), 0),
  };
}

/**
 * 剪枝：太小的类目不留、太深的层级折上来。
 *
 * 规则（全部只作用于副本）：
 * 1. 深度 > maxDepth 的节点，成员并入 maxDepth 层的祖先，节点本身删除
 * 2. 自底向上，total < minPerCategory 的节点删除，**成员并入父类目**
 * 3. 顶层节点也过不了阈值时，整枝删除，成员进 dropped（调用方决定重新归位）
 *
 * @returns {{taxonomy: object, removed: string[], dropped: string[]}}
 */
export function pruneTaxonomy(taxonomy, opts = {}) {
  const min = opts.minPerCategory ?? taxonomy.params?.minPerCategory ?? DEFAULT_PARAMS.minPerCategory;
  const maxDepth = opts.maxDepth ?? taxonomy.params?.maxDepth ?? DEFAULT_PARAMS.maxDepth;

  let nodes = taxonomy.nodes.map(cloneNode);
  const removed = [];

  // 1) 深度控制：把深处的成员提上来
  {
    const byCode = new Map(nodes.map((n) => [n.code, n]));
    const depthOf = (n) => {
      let d = 0;
      let cur = n;
      while (cur && cur.parent) { cur = byCode.get(cur.parent); d += 1; }
      return d;
    };
    for (const n of nodes) {
      const d = depthOf(n);
      if (d <= maxDepth) continue;
      let anc = n;
      while (anc && depthOf(anc) > maxDepth) anc = byCode.get(anc.parent);
      if (anc) {
        anc.members.push(...n.members);
        n.members = [];
        n.droppedByDepth = true;
        removed.push(n.code);
      }
    }
    nodes = nodes.filter((n) => !n.droppedByDepth);
  }

  // 2) 按 total 自底向上剪掉小类目
  let current = recount({ ...taxonomy, nodes });
  const dropped = [];
  const order = [...current.nodes].sort((a, b) => b.depth - a.depth);
  for (const node of order) {
    const live = current.nodes.find((n) => n.code === node.code);
    if (!live) continue;
    if (live.total >= min) continue;

    const parent = live.parent ? current.nodes.find((n) => n.code === live.parent) : null;
    if (parent) {
      parent.members.push(...live.members);
    } else {
      dropped.push(...live.members);
    }
    current = recount({
      ...current,
      nodes: current.nodes.filter((n) => n.code !== live.code),
    });
    removed.push(live.code);
  }

  return { taxonomy: current, removed, dropped };
}

/** 顶层类目超限：按 total 排序取前 maxTop，其余进 overflow（不改树） */
export function limitTop(taxonomy, maxTop = taxonomy.params?.maxTop ?? DEFAULT_PARAMS.maxTop) {
  const tops = taxonomy.nodes.filter((n) => !n.parent).sort((a, b) => b.total - a.total);
  if (tops.length <= maxTop) return { kept: taxonomy, overflow: [] };
  const keep = new Set(tops.slice(0, maxTop).map((n) => n.code));
  // 连同子树一起丢
  const under = (node) => {
    let cur = node;
    while (cur && cur.parent) cur = taxonomy.nodes.find((n) => n.code === cur.parent);
    return cur ? keep.has(cur.code) : true;
  };
  const kept = recount({
    ...taxonomy,
    nodes: taxonomy.nodes.filter((n) => under(n)),
  });
  return { kept, overflow: tops.slice(maxTop).map((n) => n.code) };
}

/** 把指定的顶层类目并进一个兜底类目（默认 900 其他），成员一并带走 */
export function foldOverflow(taxonomy, overflowCodes = [], { code = '900', name = '其他' } = {}) {
  if (!overflowCodes.length) return taxonomy;
  const set = new Set(overflowCodes);
  const keep = [];
  const moved = [];
  for (const n of taxonomy.nodes) {
    let cur = n;
    let inside = false;
    while (cur) {
      if (set.has(cur.code)) { inside = true; break; }
      cur = cur.parent ? taxonomy.nodes.find((x) => x.code === cur.parent) : null;
    }
    if (inside) moved.push(...n.members);
    else keep.push(n);
  }
  const existing = keep.find((n) => n.code === code);
  if (existing) existing.members.push(...moved);
  else keep.push({ code, name, hint: '放不进具体类目的，统一收在这里', parent: null, members: moved });
  return recount({ ...taxonomy, nodes: keep });
}

/** 受控词表：同义词 → 优选词（大小写不敏感） */
export function normalizeName(name, vocab = {}) {
  const raw = String(name || '').trim();
  const key = raw.toLowerCase();
  return vocab[key] || vocab[raw] || raw;
}

/** 把词表套到所有节点名上；同父下重名的合并成员 */
export function normalizeNames(taxonomy) {
  const renamed = taxonomy.nodes.map((n) => ({ ...cloneNode(n), name: normalizeName(n.name, taxonomy.vocab) }));
  const seen = new Map();
  const out = [];
  for (const n of renamed) {
    const key = (n.parent || '') + '::' + n.name;
    const prev = seen.get(key);
    if (prev) { prev.members.push(...n.members); continue; }
    seen.set(key, n);
    out.push(n);
  }
  return { ...taxonomy, nodes: out };
}

/** 树 → 扁平方案（父在前、子在后），可直接塞进 customSchemes 走现有链路 */
export function toScheme(taxonomy) {
  const byParent = new Map();
  for (const n of taxonomy.nodes) {
    const key = n.parent || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(n);
  }
  const folders = [];
  const walk = (parent) => {
    for (const n of byParent.get(parent) || []) {
      folders.push({ code: n.code, name: n.name, hint: n.hint || '', parent: n.parent || null });
      walk(n.code);
    }
  };
  walk('');

  // 数字编码走 digit，混进字母就必须按 letter 处理，否则字母类目会认不出来
  const kind = folders.some((f) => !/^\d+$/.test(f.code)) ? 'letter' : 'digit';
  return {
    id: taxonomy.id,
    name: taxonomy.name || '自定义分类法',
    kind,
    desc: `由收藏语料归纳：${folders.length} 个类目，最深 ${taxonomy.stats?.maxDepth ?? 0} 层`,
    folders,
    custom: true,
    parentSchemeId: taxonomy.parentSchemeId || '',
  };
}

/** 每个类目名 → 成员，给界面预览与人工审定用 */
export function groupMembers(taxonomy) {
  return taxonomy.nodes
    .slice()
    .sort((a, b) => (a.code > b.code ? 1 : -1))
    .map((n) => ({ code: n.code, name: n.name, parent: n.parent, count: n.count, total: n.total, members: [...n.members] }));
}

/* ── 从骨架到树：抽样、建码、按规则铺全量 ──────────── */

/**
 * 抽样：按域名分层轮转，避免 200 条里 80 条来自同一个站。
 * 纯函数、结果确定（同输入同输出），便于复现与测试。
 */
export function sampleForSkeleton(items, size = 200) {
  const byHost = new Map();
  for (const it of items) {
    if (!it || !it.url) continue;
    const host = it.host || '';
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(it);
  }
  const hosts = [...byHost.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([host, list]) => [host, list.slice().sort((x, y) => (y.added || 0) - (x.added || 0))]);

  const out = [];
  let round = 0;
  while (out.length < size) {
    let progressed = false;
    for (const [, list] of hosts) {
      if (round >= list.length) continue;
      out.push(list[round]);
      progressed = true;
      if (out.length >= size) break;
    }
    if (!progressed) break;
    round += 1;
  }
  return out;
}

/**
 * 骨架 → 节点表。顶层编码按 000/100/200… 分配，子类按「父首位 + 10n」。
 * 顶层最多 10 个（三位编码的物理上限），每父最多 9 个（010–090）。
 */
export function buildTaxonomyFromSkeleton(skeleton, { parentSchemeId = '', params = {}, vocab = {} } = {}) {
  const merged = { ...DEFAULT_PARAMS, ...params };
  const nodes = [];
  (skeleton || []).slice(0, TOP_LIMIT).forEach((top, i) => {
    if (!top || !top.name) return;
    const code = top.code || String(i * 100).padStart(3, '0');
    nodes.push({ code, name: String(top.name).trim(), hint: top.hint || '', parent: null });
    (top.children || []).filter((k) => k && k.name).slice(0, 9).forEach((kid, j) => {
      const childCode = code[0] + String((j + 1) * 10).padStart(2, '0');
      nodes.push({ code: childCode, name: String(kid.name).trim(), hint: kid.hint || '', parent: code });
    });
  });
  return { nodes, params: merged, parentSchemeId, vocab };
}

/**
 * 方案 → 节点表：原样保留方案里的编码与层级，等规则把成员填进来。
 * 用于「按选定方案 + 真实收藏生目录」——类名来自方案（不让模型发明），
 * 但哪些类目最终留下，由你自己收藏里有没有东西决定。
 */
export function nodesFromScheme(scheme) {
  const folders = (scheme && scheme.folders) || [];
  return folders
    .filter((f) => f && f.code && f.name)
    .map((f) => ({
      code: String(f.code),
      name: String(f.name).trim(),
      hint: f.hint || '',
      parent: f.parent || null,
      members: [],
    }));
}

const STOP_TOKENS = new Set(['的', '和', '与', '及', '或', '在', '是', '了', '一个', '我们', '你', '我']);

function tokensOf(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  // 先把非字母数字切掉：域名要拆成 java / example / com，不能整串当一个词元
  for (const w of s.replace(/[^a-z0-9+#-]+/g, ' ').match(/[a-z][a-z0-9+#-]{1,}/g) || []) {
    if (w.length >= 2 && !STOP_TOKENS.has(w)) out.add(w);
  }
  // 中文按二元组切，够粗也够稳
  for (const seg of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i < seg.length - 1; i += 1) {
      const bg = seg.slice(i, i + 2);
      if (!STOP_TOKENS.has(bg)) out.add(bg);
    }
  }
  return out;
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname || '');
  } catch (e) {
    return '';
  }
}

/**
 * 覆盖率：多少条已经归入类目、多少条还没归。
 * 全流程只认这一个口径——剪枝剪掉的成员也算「还没归」，否则覆盖数涨、未覆盖数不动，自相矛盾。
 */
export function coverageOf(taxonomy, items) {
  const withUrl = (items || []).filter((it) => it && it.url);
  const known = new Set(withUrl.map((it) => it.id));
  const covered = new Set(((taxonomy && taxonomy.nodes) || [])
    .flatMap((n) => n.members || [])
    .filter((id) => known.has(id)));
  return { items: known.size, covered: covered.size, uncovered: known.size - covered.size };
}

/**
 * 规则铺全量：用类目名 + hint 的词元给每条书签打分，落不到任何类目的进 unmatched。
 * 命中标题权 3、命中域名/路径权 1；同分时取更深的节点（更具体）。
 */
export function assignByRules(items, nodes, { minScore = 1 } = {}) {
  const prepared = nodes.map((n) => ({
    code: n.code,
    depth: n.parent ? 1 : 0,
    tokens: tokensOf(`${n.name} ${n.hint || ''}`),
  }));
  const map = {};
  const unmatched = [];
  for (const it of items) {
    if (!it || !it.url) continue;
    const title = tokensOf(it.title);
    const hostPath = tokensOf(`${it.host || ''} ${pathOf(it.url)}`);
    let best = null;
    for (const n of prepared) {
      let score = 0;
      for (const t of n.tokens) {
        if (title.has(t)) score += 3;
        else if (hostPath.has(t)) score += 1;
      }
      if (score < minScore) continue;
      if (!best || score > best.score || (score === best.score && n.depth > best.depth)) {
        best = { code: n.code, score, depth: n.depth };
      }
    }
    if (best) {
      if (!map[best.code]) map[best.code] = [];
      map[best.code].push(it.id);
    } else {
      unmatched.push(it.id);
    }
  }
  return { map, unmatched };
}

/* ── 审定：改名、删类、状态流转 ──────────────── */

/** 批量改名（按 code 映射），成员与层级不动 */
export function renameNodes(taxonomy, renames = {}) {
  const nodes = taxonomy.nodes.map((n) => {
    const next = cloneNode(n);
    if (renames[n.code]) next.name = String(renames[n.code]).trim().slice(0, 20);
    return next;
  });
  return recount({ ...taxonomy, nodes });
}

/** 删类：连同子孙一起删，剩下的成员不会凭空转移 */
export function removeNodes(taxonomy, codes = []) {
  if (!codes.length) return taxonomy;
  const drop = new Set(codes);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of taxonomy.nodes) {
      if (!drop.has(n.code) && n.parent && drop.has(n.parent)) {
        drop.add(n.code);
        grew = true;
      }
    }
  }
  return recount({ ...taxonomy, nodes: taxonomy.nodes.filter((n) => !drop.has(n.code)).map(cloneNode) });
}

/** draft → approved：先改名再删类，最后标状态 */
export function approveTaxonomy(taxonomy, { renames = {}, removed = [], now = Date.now() } = {}) {
  const cleaned = removeNodes(renameNodes(taxonomy, renames), removed);

  // 删类会把这些成员退成「还没归」，未覆盖数跟着涨，否则状态行又对不上
  const before = new Set(taxonomy.nodes.flatMap((n) => n.members));
  const after = new Set(cleaned.nodes.flatMap((n) => n.members));
  const lost = [...before].filter((id) => !after.has(id)).length;
  const source = taxonomy.source && Number.isFinite(taxonomy.source.unmatched)
    ? { ...taxonomy.source, unmatched: taxonomy.source.unmatched + lost }
    : taxonomy.source;

  return { ...cleaned, source, status: 'approved', approvedAt: now };
}

/* ── 增量扩展：新条目只归类，不动结构 ──────────── */

const TLDS = new Set(['com', 'cn', 'net', 'org', 'io', 'dev', 'me', 'co', 'tv', 'info', 'xyz', 'site', 'top', 'ai', 'cc', 'us', 'uk', 'jp', 'edu', 'gov', 'cloud', 'app']);
// 门户站用二级域名做标识（mp.weixin.qq.com 想叫 Weixin 而不是 Qq）
const PORTALS = new Set(['qq', '163', 'sina', 'sohu', 'baidu', 'taobao', 'jd', 'weibo', 'ali', 'tmall', '126']);

/**
 * 域名 → 站点标签：blog.csdn.net → Csdn；mp.weixin.qq.com → Weixin。
 * 只做启发式：取可注册域名的那个 label，门户站往前再退一级。
 */
export function siteLabel(host) {
  const raw = String(host || '').toLowerCase().replace(/^www\./, '');
  const labels = raw.split('.').filter(Boolean);
  if (labels.length <= 1) return raw.slice(0, 12);
  while (labels.length > 1 && TLDS.has(labels[labels.length - 1])) labels.pop();
  let base = labels[labels.length - 1] || labels[0];
  if (PORTALS.has(base) && labels.length >= 2) base = labels[labels.length - 2];
  base = base.slice(0, 12);
  return base === 'localhost' ? base : base.charAt(0).toUpperCase() + base.slice(1);
}

/** 把一批条目的归属投成「父类目」：多数条目的顶层祖先是谁，就挂谁 */
function voteParent(taxonomy, ids, byId) {
  const byCode = new Map(taxonomy.nodes.map((n) => [n.code, n]));
  const topOf = (code) => {
    let cur = byCode.get(code);
    while (cur && cur.parent) cur = byCode.get(cur.parent);
    return cur ? cur.code : null;
  };
  const votes = new Map();
  for (const id of ids) {
    const it = byId.get(id);
    if (!it) continue;
    // 这里用 1 分阈值：标题没信号、但域名指向某类的条目（如 java.example.com）
    // 归不进现有节点（归类要 3 分），却能用来投票决定「建议挂在哪个父类下」
    const { map } = assignByRules([it], taxonomy.nodes, { minScore: 1 });
    const code = Object.keys(map)[0];
    if (!code) continue;
    const top = topOf(code);
    if (top) votes.set(top, (votes.get(top) || 0) + 1);
  }
  let best = null;
  for (const [code, n] of votes) if (!best || n > best.n) best = { code, n };
  return best ? best.code : null;
}

/**
 * 增量扩展的计划（纯函数，不动结构）：
 * 1. 未归入任何类目的条目，先按规则试着塞进现有节点
 * 2. 仍然塞不进去的，按站点聚成簇；簇够大才提「新建子类」的建议
 * 3. 建议只是建议：要经过 acceptProposals → 审定 → 落成目录 才会变成真实目录
 *
 * @returns {{assign: Object, proposals: Array, unmatched: string[]}}
 */
export function planExtend(taxonomy, items, { minScore = 3, minCluster = 8, maxProposals = 5 } = {}) {
  const assigned = new Set(taxonomy.nodes.flatMap((n) => n.members));
  const candidates = (items || []).filter((it) => it && it.url && !assigned.has(it.id));
  const { map, unmatched } = assignByRules(candidates, taxonomy.nodes, { minScore });

  const byId = new Map(candidates.map((it) => [it.id, it]));
  const byHost = new Map();
  for (const id of unmatched) {
    const host = (byId.get(id) || {}).host || '';
    if (!host) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(id);
  }

  const proposals = [];
  for (const [host, ids] of [...byHost.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (ids.length < minCluster) continue;
    const parent = voteParent(taxonomy, ids, byId);
    if (!parent) continue; // 连父类目都投不出来，说明这批跟现有结构无关，先不动
    proposals.push({
      key: 'p_' + host,
      name: siteLabel(host),
      host,
      parent,
      members: ids,
      reason: host + ' 下 ' + ids.length + ' 条',
    });
    if (proposals.length >= maxProposals) break;
  }

  const leftover = unmatched.filter((id) => !proposals.some((p) => p.members.includes(id)));

  // pending = 这次归完之后真正还没归入任何类目的条数（建议还是建议，不算已归）
  const pending = coverageOf(
    { nodes: [...taxonomy.nodes, { members: Object.values(map).flat() }] },
    items,
  ).uncovered;

  return { assign: map, proposals, pending, leftover };
}

/** 把规则分好的条目并进节点成员（结构不变） */
export function applyExtend(taxonomy, assign = {}) {
  const nodes = taxonomy.nodes.map((n) => ({
    ...cloneNode(n),
    members: [...n.members, ...((assign && assign[n.code]) || [])],
  }));
  return recount({ ...taxonomy, nodes });
}

/**
 * 接受建议 → 变成正式节点（状态回 draft，还要再审定才能落成目录）。
 * 父类没有空位时跳过，不硬塞。
 */
export function acceptProposals(taxonomy, keys = []) {
  const wanted = new Set(keys);
  const props = (taxonomy.proposals || []).filter((p) => wanted.has(p.key));
  if (!props.length) return taxonomy;

  const nodes = taxonomy.nodes.map(cloneNode);
  const byCode = new Map(nodes.map((n) => [n.code, n]));
  const accepted = new Set();

  for (const p of props) {
    const parent = p.parent ? byCode.get(p.parent) : null;
    if (!parent) continue;
    const used = new Set(nodes.filter((n) => n.parent === parent.code).map((n) => n.code));
    let slot = '';
    for (let i = 1; i <= 9; i += 1) {
      const code = parent.code[0] + String(i * 10).padStart(2, '0');
      if (!used.has(code)) { slot = code; break; }
    }
    if (!slot) continue;
    nodes.push({
      code: slot,
      name: p.name,
      hint: p.reason || '',
      parent: parent.code,
      members: [...(p.members || [])],
    });
    accepted.add(p.key);
  }
  if (!accepted.size) return taxonomy;

  // 建议转正后这些条目就算归入了，未覆盖数跟着减（减的是真新增覆盖的，不是成员总数）
  const before = new Set(taxonomy.nodes.flatMap((n) => n.members));
  const gained = new Set(nodes.flatMap((n) => n.members).filter((id) => !before.has(id)));
  const source = taxonomy.source && Number.isFinite(taxonomy.source.unmatched)
    ? { ...taxonomy.source, unmatched: Math.max(0, taxonomy.source.unmatched - gained.size) }
    : taxonomy.source;

  return recount({
    ...taxonomy,
    source,
    nodes,
    proposals: (taxonomy.proposals || []).filter((p) => !accepted.has(p.key)),
    status: 'draft',
  });
}
