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
      folders.push({ code: n.code, name: n.name, hint: n.hint || '' });
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

const STOP_TOKENS = new Set(['的', '和', '与', '及', '或', '在', '是', '了', '一个', '我们', '你', '我']);

function tokensOf(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z][a-z0-9.+#-]{1,}/g) || []) {
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
