/**
 * 归类：优先用大模型（任何 OpenAI 兼容的 /chat/completions），
 * 没配 key 时退化为本地关键词规则，功能不至于不可用。
 *
 * 优先级：
 *   1. 用户历史改判记忆（learned 域名偏好）→ 直接复用个人习惯
 *   2. 模型推理（可选附带低信息量页面的 <head> 摘要与 Few-shot 偏好）
 *   3. 按方案适配的本地关键词规则（支持杜威 / 精简五类 / PARA / 中图法 / 自定义方案）
 */

import { matchLearned, formatLearnedExamples } from './meta.js';
import { cleanTitleLocal } from './head.js';

const BATCH = 24;
const REASON_MAX = 24;

/** 提示词版本：改 SYSTEM / SKELETON_SYSTEM / 拆分提示词时手动 +1，建议带上 model 一起做血缘 */
export const PROMPT_VERSION = 'p2';

/** 选择性分类统一拒判阈值：本地规则低于此值送模型，最终低于此值标「拿不准」 */
export const SELECTIVE_THRESHOLD = 0.65;

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  maxTokens: 3000,
  timeout: 8000,
  modelTimeout: 120,     // 模型单批超时（秒）：一批 24 条经常要几十秒，旧的 48 秒口径会把正常请求掐断
  modelBatch: 24,        // 每批送多少条给模型：受 max_tokens 限制，每条约 40–60 个输出 token
  concurrency: 4,
  checkLimit: 60,
  schemeId: '',          // 已安装的整理方案；空字符串 = 只认数字编码（0.4.x 行为）
  fetchHeadOnAi: true,   // 低信息量书签自动流式拉取 <head> 摘要辅助判断
  autoCheckWeekly: false, // 可选 alarms 权限：每周静默体检 60 条
  customSchemes: [],     // 用户自定义分类方案
};

const SYSTEM = `你是一位中文用户的书签归档助手。用户用一套固定的编码分类体系管理收藏，每个类目有 code、名称和一句说明。

为每条书签选出最合适的类目 code。规则：
1. 只能从给定类目中选择，返回的 code 必须原样抄自类目列表。
2. 只能依据标题、域名、URL 路径和提供的页面摘要（如有）判断，不要臆测页面内容。
3. 两个类目都说得通时，选择更贴近「实际用途」的那个，并在 reason 里点明取舍。
4. conf 是把握程度，0–1。拿不准就给 0.35–0.60（低于 ${SELECTIVE_THRESHOLD} 会标为「拿不准」交由用户审阅），不要为了好看写高。
5. reason 不超过 ${REASON_MAX} 个字，说清依据，例如「官方文档，属前端框架」。
6. 每条书签都必须出现一次，id 原样返回。

只输出 JSON，不要前后解释：
{"items":[{"id":"书签id","code":"类目code","conf":0.9,"reason":"依据"}]}`;

export function buildMessages(items, scheme, opts = {}) {
  const { learned = null, pageMeta = {}, ignoreCurrent = false } = opts;
  const cats = scheme
    .map((f) => `${f.code} ${f.name}${f.hint ? ' — ' + f.hint : ''}`)
    .join('\n');
  const rows = items.map((it) => {
    const pm = pageMeta[it.id];
    const row = {
      id: it.id,
      title: it.title,
      host: it.host,
      path: safePath(it.url),
      current: ignoreCurrent ? null : (it.code || null),
    };
    if (pm && pm.desc) row.desc = pm.desc.slice(0, 120);
    return row;
  });
  const examples = formatLearnedExamples(learned, scheme, 10);
  const prefBlock = examples ? `\n\n用户历史偏好（仅供参考）：\n${examples}` : '';
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `分类体系：\n${cats}${prefBlock}\n\n待归类书签：\n${JSON.stringify(rows)}`,
    },
  ];
}

function safePath(url) {
  try {
    const u = new URL(url);
    const p = u.pathname === '/' ? '' : u.pathname;
    return decodeURIComponent(p).slice(0, 80);
  } catch {
    return '';
  }
}

function pickJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * 归一化 Base URL：只给域名（没有路径）时补 /v1。
 * 兼容 OpenAI 的网关几乎都在 /v1 下；用户写 https://api.siliconflow.cn 时
 * 直接拼 /chat/completions 会 404，这里替他补上。
 */
export function normalizeBase(base) {
  const raw = String(base || DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_SETTINGS.baseUrl;
  try {
    const u = new URL(raw);
    if (u.pathname === '' || u.pathname === '/') u.pathname = '/v1';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

export async function callModel(settings, messages, { maxTokens } = {}) {
  const base = normalizeBase(settings.baseUrl);
  const url = base + '/chat/completions';
  // 一批 24 条通常要几十秒，推理模型更久；这里单独给预算，别再复用「单条检测超时」
  const budgetMs = (Number(settings.modelTimeout) > 0 ? Number(settings.modelTimeout) : 120) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (settings.apiKey || ''),
      },
      body: JSON.stringify({
        model: settings.model || DEFAULT_SETTINGS.model,
        messages,
        temperature: 0.1,
        max_tokens: maxTokens || settings.maxTokens || DEFAULT_SETTINGS.maxTokens,
        stream: false,
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted) {
      throw new Error(`模型请求超时（${Math.round(budgetMs / 1000)} 秒没返回）：换更快的模型，或在设置里调大「模型单批超时」`);
    }
    throw new Error('连不上模型服务：' + (e && e.message ? e.message : e));
  }

  try {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint = res.status === 404
        ? '（检查 Base URL：多数服务需要以 /v1 结尾，例如 https://api.siliconflow.cn/v1）'
        : '';
      throw new Error(`模型返回 ${res.status}${hint}：${body.slice(0, 180) || res.statusText}`);
    }
    const data = await res.json();
    const choice = (data.choices || [])[0] || {};
    const msg = choice.message || {};
    const content = msg.content || '';
    if (!content) {
      if (choice.finish_reason === 'length') {
        throw new Error('模型输出被截断（finish_reason=length），把 max_tokens 调大，或换一个非推理模型。');
      }
      throw new Error('模型返回了空内容。');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** 用一小组数据验证配置是否可用 */
export async function testConnection(settings) {
  const content = await callModel(
    settings,
    [
      { role: 'system', content: '只回答 JSON，不要解释。' },
      { role: 'user', content: '输出 {"ok":true}' },
    ],
    { maxTokens: 200 }
  );
  return content.trim();
}

export async function classifyWithModel(items, scheme, settings, onBatch, opts = {}) {
  const {
    learned = null, pageMeta = {}, ignoreCurrent = false, call = callModel, retries = 1, stats = null,
    shouldStop = null, onBatchStart = null,
  } = opts;
  // 每批条数可配：太小请求多、太大容易让输出撞 max_tokens
  const batchSize = Math.max(4, Math.min(200, Number(opts.batchSize || settings.modelBatch) || BATCH));
  const out = [];
  const fail = (from, size, error) => {
    if (!stats) return;
    if (!stats.failed) stats.failed = [];
    stats.failed.push({ from, size, error: String((error && error.message) || error) });
  };

  const batches = Math.ceil(items.length / batchSize);
  for (let i = 0; i < items.length; i += batchSize) {
    if (shouldStop && shouldStop()) break;   // 用户中途停止：已拿到的结果照常返回
    const chunk = items.slice(i, i + batchSize);
    // 每批开始时先报一次：模型很慢时界面不至于一直停在 0
    if (onBatchStart) onBatchStart(Math.floor(i / batchSize) + 1, batches, chunk.length);
    let content = '';
    let lastError = null;
    // 一批失败只丢这一批：先前跑完的批次留着，别让用户重头再来
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        content = await call(settings, buildMessages(chunk, scheme, { learned, pageMeta, ignoreCurrent }));
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (lastError) {
      fail(i, chunk.length, lastError);
      // 失败的批次也要把进度推过去，否则界面会永远停在上一批
      if (onBatch) onBatch(Math.min(items.length, i + chunk.length), items.length);
      continue;
    }

    const parsed = pickJson(content);
    if (!parsed || !Array.isArray(parsed.items)) {
      fail(i, chunk.length, new Error('模型没有返回可解析的 JSON：' + String(content).slice(0, 120)));
      if (onBatch) onBatch(Math.min(items.length, i + chunk.length), items.length);
      continue;
    }
    const valid = new Set(scheme.map((f) => f.code));
    for (const r of parsed.items) {
      if (!r || !r.id || !valid.has(String(r.code))) continue;
      if (!chunk.some((c) => c.id === r.id)) continue;
      out.push({
        id: r.id,
        code: String(r.code),
        conf: clamp(Number(r.conf) || 0.6, 0, 1),
        reason: String(r.reason || '').slice(0, REASON_MAX),
        source: 'model',
        model: String(settings.model || ''),
        promptVersion: PROMPT_VERSION,
      });
    }
    if (onBatch) onBatch(Math.min(items.length, i + chunk.length), items.length);
  }
  if (stats) stats.batches = batches;
  return out;
}

/** AI 标题洗白：对噪声标题（未读角标、纯 URL、站名冗长等）产出干净可读的书目标题建议 */
export async function cleanTitles(items, settings, pageMeta = {}) {
  const localOut = [];
  for (const it of items) {
    const pm = pageMeta[it.id];
    const base = (pm && pm.title && (it.title === it.url || it.title.length < 5)) ? pm.title : it.title;
    const cleaned = cleanTitleLocal(base, it.host);
    if (cleaned && cleaned !== it.title) {
      localOut.push({ id: it.id, from: it.title, to: cleaned, source: 'local' });
    }
  }
  if (!hasModel(settings) || !items.length) return localOut;

  const chunk = items.slice(0, 30);
  const rows = chunk.map((it) => ({
    id: it.id,
    title: it.title,
    host: it.host,
    pageTitle: pageMeta[it.id]?.title || '',
  }));
  const messages = [
    {
      role: 'system',
      content: `你是中文书签标题整理助手。去掉未读角标（如 (3)）、冗余站点后缀、登录提示噪音，将裸网址或晦涩标题整理为简洁优雅的书目名称（10-32字，保持原语言核心术语）。本身已干净的不要改。
只输出 JSON：{"items":[{"id":"书签id","title":"洗白后的新标题"}]}`,
    },
    { role: 'user', content: JSON.stringify(rows) },
  ];
  try {
    const content = await callModel(settings, messages);
    const parsed = pickJson(content);
    if (!parsed || !Array.isArray(parsed.items)) return localOut;
    const byId = new Map(chunk.map((x) => [x.id, x]));
    const out = [];
    for (const r of parsed.items) {
      const it = byId.get(r && r.id);
      const next = String((r && r.title) || '').trim();
      if (it && next && next !== it.title) {
        out.push({ id: it.id, from: it.title, to: next.slice(0, 80), source: 'model' });
      }
    }
    return out;
  } catch {
    return localOut;
  }
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/* ── 本地兜底规则（按方案感知，避免非杜威方案错配） ── */

const DEWEY_RULES = {
  '100': ['rust', 'golang', 'java', 'python', 'node', 'nodejs', 'typescript', 'javascript', '编程', '后端', 'api', 'sdk', '框架', '面试', '编译器', 'spring', 'django', 'gobyexample', 'lang'],
  '200': ['sql', 'postgresql', 'postgres', 'mysql', 'redis', 'kafka', 'mongodb', 'clickhouse', 'elasticsearch', '数据库', '消息队列', '索引', '数据仓库', 'etl', '向量库', 'vector', 'zilliz'],
  '300': ['rfc', 'http', 'quic', 'tcp', 'dns', 'nginx', 'openwrt', '路由', '代理', '抓包', 'wireshark', '网络', 'proxy', 'cdn', 'cloudflare'],
  '400': ['docker', 'kubernetes', 'k8s', 'systemd', 'linux', '内核', 'kernel', 'ebpf', '容器', '运维', '部署', 'shell', 'tmux', 'ansible'],
  '500': ['ai', 'gpt', 'llm', '大模型', 'prompt', '提示词', 'agent', '智能体', 'mcp', 'claude', 'openai', 'langchain', 'transformer', 'diffusion', 'embedding', 'vllm', 'rag', '微调', 'arxiv', 'a2a'],
  '600': ['react', 'vue', 'svelte', 'css', 'tailwind', 'html', '前端', 'browser', 'webpack', 'vite', 'bun', 'deno', 'xstate', 'mdn', '设计系统', 'design', 'figma'],
  '700': ['图书', '论文', '课程', '教程', '笔记', '读书', 'ctext', 'douban', 'semantic', '教材', '方法论', 'pdf', 'book'],
  '800': ['news', 'ycombinator', 'v2ex', 'juejin', '掘金', '社区', '论坛', '周刊', '资讯', 'hacker', '即刻', 'reddit'],
  '900': ['movie', 'music', 'spotify', 'bilibili', '游戏', '电影', '音乐', '番剧', 'netflix', 'steam', '娱乐'],
};

const SCHEME_RULES = {
  dewey: DEWEY_RULES,
  lite5: {
    '100': ['jira', 'confluence', 'feishu', '飞书', '钉钉', 'slack', 'linear', 'okr', '周报', '会议', '内网', '协作', '工作'],
    '200': ['文档', '手册', '教程', '课程', '论文', 'arxiv', 'mdn', 'book', '读书', '笔记', '学习', '教材', '方法论', 'guide', 'tutorial'],
    '300': ['tool', '工具', '在线', '生成器', '转换', 'excalidraw', 'figma', 'raycast', 'github', 'vercel', 'cloudflare', 'docker', 'api', 'sdk'],
    '400': ['news', '周刊', '资讯', '社区', '论坛', '博客', 'blog', 'v2ex', 'juejin', '掘金', 'hacker', 'reddit', '即刻', 'zhihu', '知乎'],
    '500': ['movie', 'music', 'spotify', 'bilibili', '游戏', '电影', '音乐', '番剧', 'netflix', 'steam', '购物', '旅行', '生活', '娱乐', '豆瓣电影'],
  },
  para: {
    '100': ['sprint', 'milestone', 'pr', 'issue', '任务', '项目', '上线', '排期', '需求', 'prd', 'roadmap'],
    '200': ['架构', '管理', '运维', '健康', '理财', '家庭', '职业', '复盘', '领域', '规范'],
    '300': ['docs', '文档', '手册', '教程', '工具', 'api', 'sdk', 'cheatsheet', '速查', '白皮书', '论文', '库', '素材', '模板', 'reference'],
    '400': ['archive', '归档', '旧笔记', '历史', '2021', '2022', '2023', 'deprecated'],
  },
  clc12: {
    B: ['哲学', '宗教', '心理', '认知', '伦理', '思想', 'ctext', '佛学', '逻辑'],
    C: ['社会学', '统计', '管理', '组织', '人口', '人类学'],
    D: ['政策', '法律', '合规', '法规', '政府', 'gov', '合同', '法务'],
    F: ['经济', '财经', '金融', '投资', '股票', '财报', '商业', '创业', '研报', 'finance'],
    G: ['教育', '课程', '考试', '图书馆', '博物馆', '教程', '百科', 'wikipedia', 'coursera'],
    H: ['英语', '日语', '翻译', '词典', '写作', '语法', '语言', 'dictionary'],
    I: ['文学', '小说', '散文', '诗歌', '书评', '豆瓣读书', 'book.douban'],
    J: ['艺术', '设计', '音乐', '电影', '摄影', 'figma', 'design', 'dribbble', 'spotify', 'movie', '影视'],
    K: ['历史', '传记', '地理', '旅行', '地图', '地方志'],
    N: ['数学', '物理', '化学', '生物', '天文', '科研', 'arxiv', 'nature', 'science', '科学'],
    T: ['rust', 'golang', 'java', 'python', 'node', 'typescript', 'javascript', 'sql', 'redis', 'docker', 'kubernetes', 'k8s', 'linux', 'ebpf', 'ai', 'gpt', 'llm', 'agent', 'mcp', 'react', 'vue', 'css', 'html', 'http', 'tcp', 'nginx', 'openwrt', 'github', '编程', '数据库', '网络', '人工智能', '前端', '算法', '工程'],
    Z: ['工具', '搜索', '效率', 'raycast', 'excalidraw', '综合', '导航'],
  },
};
SCHEME_RULES.clc22 = {
  ...SCHEME_RULES.clc12,
  O: ['数学', '物理', '化学', '微积分', '线性代数', '概率', 'math', 'physics'],
  P: ['天文', '地球', '地质', '气象', '海洋', '地图'],
  Q: ['生物', '基因', '生态', '遗传', '生命科学'],
  R: ['医学', '医疗', '健康', '药学', '营养', '卫生'],
  U: ['交通', '铁路', '航空', '汽车', '出行'],
  X: ['环境', '碳中和', '能源', '安全'],
};

function looksLikeDewey(scheme) {
  const codes = new Set((scheme || []).map((f) => f.code));
  if (!codes.has('100') || !codes.has('500')) return false;
  const f100 = scheme.find((f) => f.code === '100');
  const f500 = scheme.find((f) => f.code === '500');
  return Boolean(f100 && /编程|后端|代码|程序/.test(f100.name + (f100.hint || '')) && f500 && /人工|智能|AI|模型/i.test(f500.name + (f500.hint || '')));
}

function buildDynamicRules(scheme, schemeId) {
  const id = schemeId || (looksLikeDewey(scheme) ? 'dewey' : '');
  const preset = SCHEME_RULES[id] || null;
  const rules = {};

  for (const f of scheme || []) {
    const words = new Set();
    if (preset && preset[f.code]) {
      for (const w of preset[f.code]) words.add(w);
    }
    // 把类目名称和 hint 里的中英文词也拆进来，自定义方案同样能命中本地规则
    const rawText = `${f.name || ''} ${f.hint || ''}`;
    for (const seg of rawText.split(/[\s、，,。·/—\-（）()：:]+/)) {
      const w = seg.trim().toLowerCase();
      if (w.length >= 2) words.add(w);
    }
    if (words.size) rules[f.code] = [...words];
  }
  return rules;
}

const MATCHERS = {};
function matcherFor(word) {
  if (MATCHERS[word]) return MATCHERS[word];
  let fn;
  if (/^[\x20-\x7e]+$/.test(word)) {
    // 英文按词边界匹配：sspai.com 里的 ai、tailwind 里的 ai 都不算命中
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^a-z0-9])' + esc + '(?![a-z0-9])', 'i');
    fn = (hay) => re.test(hay);
  } else {
    fn = (hay) => hay.includes(word);
  }
  MATCHERS[word] = fn;
  return fn;
}

export function classifyHeuristic(items, scheme, opts = {}) {
  const { schemeId = '', learned = null } = opts;
  const codes = new Set(scheme.map((f) => f.code));
  const rules = buildDynamicRules(scheme, schemeId);

  return items.map((it) => {
    // 1. 优先命中用户历史改判偏好
    const learnedHit = matchLearned(learned, it, codes);
    if (learnedHit) {
      return { id: it.id, ...learnedHit };
    }

    const title = String(it.title || '').toLowerCase();
    const hostPath = (String(it.host || '') + ' ' + safePath(it.url)).toLowerCase();

    let best = null;
    for (const [code, words] of Object.entries(rules)) {
      if (!codes.has(code)) continue;
      let score = 0;
      for (const w of words) {
        if (matcherFor(w)(title)) score += 2;
        else if (matcherFor(w)(hostPath)) score += 1;
        else if (w.length >= 3 && /^[a-z0-9]+$/i.test(w)) {
          if (title.includes(w)) score += 1;
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { code, score };
    }

    // 零命中显式拒判（code=''）：不强塞默认通用类，交由模型或人工判定
    if (!best) {
      return {
        id: it.id,
        code: '',
        conf: 0,
        model: '',
        promptVersion: '',
        reason: '未命中本地关键词规则，待模型或人工判定',
        source: 'heuristic',
      };
    }

    const conf = clamp(0.45 + best.score * 0.05, 0.45, 0.68);
    return {
      id: it.id,
      code: best.code,
      conf,
      model: '',
      promptVersion: '',
      reason: '关键词命中的本地规则，未经模型确认',
      source: 'heuristic',
    };
  });
}

export function hasModel(settings) {
  return Boolean(settings && settings.apiKey && settings.model);
}

export async function classify(items, scheme, settings, onBatch, opts = {}) {
  const { learned = null } = opts;
  const schemeId = settings?.schemeId || '';
  const list = hasModel(settings)
    ? await classifyWithModel(items, scheme, settings, onBatch, opts)
    : classifyHeuristic(items, scheme, { schemeId, learned });
  if (onBatch && !hasModel(settings)) onBatch(items.length, items.length);

  // 拒判（空编码）与「建议归到它已经在的类目」直接过滤掉，别让用户确认空气
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  return list.filter((s) => s.code && (byId[s.id] ? byId[s.id].code || '' : '') !== s.code);
}

/** 第一批：只定子类名（不带条目分配），输入用抽样，输出很小 */
export function buildSubNamesMessages(topName, sampleOps) {
  const rows = (sampleOps || []).map((o) => ({
    id: o.id, title: String(o.title || '').slice(0, 50), host: String(o.url || '').slice(0, 40),
  }));
  return [
    {
      role: 'system',
      content: `你在给中文书签类目「${topName}」设计二级子类。只返回 JSON：
{"subs":[{"name":"2-6个字","hint":"一句说明"}]}
规则：2–5 个；按实际内容分，不要套模板；不要「其他/杂项」这类兜底类（最多允许一个）。`,
    },
    { role: 'user', content: JSON.stringify(rows) },
  ];
}

export function parseSubNames(content, { maxSubs = 5 } = {}) {
  const parsed = pickJson(content);
  const list = parsed && Array.isArray(parsed.subs) ? parsed.subs : null;
  if (!list) throw new Error('模型没有返回可用的二级类名：' + String(content).slice(0, 120));
  return list
    .filter((x) => x && String(x.name || '').trim())
    .slice(0, maxSubs)
    .map((x) => ({ name: String(x.name).trim().slice(0, 20), hint: String(x.hint || '').trim().slice(0, 60) }));
}

/** 第二批：子类名已定，把这一块的条目分到某个下标上（输出 = 每条一个 id+index） */
export function buildSubAssignMessages(topName, subs, ops) {
  const rows = (ops || []).map((o) => ({
    id: o.id, title: String(o.title || '').slice(0, 50), host: String(o.url || '').slice(0, 40),
  }));
  const cats = subs.map((x, i) => `${i}. ${x.name}${x.hint ? ' — ' + x.hint : ''}`).join('\n');
  return [
    {
      role: 'system',
      content: `把书签分到类目「${topName}」下的固定子类里。子类：\n${cats}\n
只返回 JSON：{"items":[{"id":"书签id","sub":0}]}；sub 是上面的下标；每条都必须出现一次。`,
    },
    { role: 'user', content: JSON.stringify(rows) },
  ];
}

export function parseSubAssign(content, ops, subCount) {
  const parsed = pickJson(content);
  const list = parsed && Array.isArray(parsed.items) ? parsed.items : null;
  if (!list) throw new Error('模型没有返回分配结果：' + String(content).slice(0, 120));
  const ids = new Set((ops || []).map((o) => o.id));
  const assign = {};
  for (const it of list) {
    if (!it || !ids.has(it.id)) continue;
    const idx = Number(it.sub);
    if (!Number.isInteger(idx) || idx < 0 || idx >= subCount) continue;
    assign[it.id] = idx;
  }
  return assign;
}

/* ── 分类法归纳：从样本里长出一棵骨架 ────────────── */

const SKELETON_SYSTEM = `你是中文用户的收藏整理助手。用户会给你一批书签（标题、域名、路径），
请你**只依据这些条目本身**归纳出一套两级分类骨架。

规则：
1. 顶层 5–10 个，按实际出现的内容分，不要套用杜威/中图法之类的现成体系。
2. 二级只在某一类里明显还能再分时才给，0–4 个；分不出来就不给。
3. 类名 2–8 个汉字，不要带编号（编号由程序分配）。
4. 不要写「其他」「杂项」这类兜底类，最多允许一个。
5. 每类给一句 hint（不超过 20 字），写清「什么该放进来」，后续要用它做匹配。

只返回 JSON：
{"categories":[{"name":"开发工具","hint":"IDE、命令行、代码编辑器","children":[{"name":"编辑器","hint":"VS Code、Vim"}]}]}`;

/**
 * 从样本归纳两级骨架。只产出结构，不碰书签、不写存储。
 * @param {Array} samples 抽样条目（含 id/title/host/url）
 * @returns {Promise<Array<{name,hint,children:Array<{name,hint}>}>>}
 */
export async function designSkeleton(samples, settings, { maxTop = 10, maxPerTop = 4 } = {}) {
  const rows = samples.map((it) => ({
    id: it.id,
    title: String(it.title || '').slice(0, 60),
    host: it.host || '',
    path: safePath(it.url),
  }));
  const messages = [
    { role: 'system', content: SKELETON_SYSTEM },
    {
      role: 'user',
      content: `下面是按域名分层抽出的 ${rows.length} 条收藏：\n${JSON.stringify(rows)}\n\n`
        + `请归纳分类骨架：顶层不超过 ${maxTop} 个，每个顶层下的二级不超过 ${maxPerTop} 个。只返回 JSON。`,
    },
  ];
  const content = await callModel(settings, messages, { maxTokens: 3000 });
  return parseSkeleton(content, { maxTop, maxPerTop });
}

/**
 * 把模型回复解析成骨架（纯函数，便于对脏输出做断言）。
 * 容忍 ```json 围栏与前后废话；结构不对直接抛，不静默返回半个结果。
 */
export function parseSkeleton(content, { maxTop = 10, maxPerTop = 4 } = {}) {
  const parsed = pickJson(content);
  if (!parsed || !Array.isArray(parsed.categories)) {
    throw new Error('模型没有返回可解析的分类骨架：' + String(content).slice(0, 120));
  }
  const skeleton = parsed.categories
    .filter((c) => c && typeof c === 'object' && c.name)
    .slice(0, maxTop)
    .map((c) => ({
      name: String(c.name).trim().slice(0, 12),
      hint: String(c.hint || '').trim().slice(0, 40),
      children: (Array.isArray(c.children) ? c.children : [])
        .filter((k) => k && typeof k === 'object' && k.name)
        .slice(0, maxPerTop)
        .map((k) => ({ name: String(k.name).trim().slice(0, 12), hint: String(k.hint || '').trim().slice(0, 40) })),
    }))
    .filter((c) => c.name);
  if (!skeleton.length) throw new Error('模型返回的分类骨架是空的');
  return skeleton;
}
