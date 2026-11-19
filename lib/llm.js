/**
 * 归类：优先用大模型（任何 OpenAI 兼容的 /chat/completions），
 * 没配 key 时退化为本地关键词规则，功能不至于不可用。
 *
 * 本地规则刻意把置信度压在 0.65 以下——它本来就不该被当成“模型说的”。
 */

const BATCH = 24;
const REASON_MAX = 24;

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  maxTokens: 3000,
  timeout: 8000,
  concurrency: 4,
  checkLimit: 60,
  schemeId: '', // 已安装的整理方案；空字符串 = 只认数字编码（0.4.x 行为）
};

const SYSTEM = `你是一位中文用户的书签归档助手。用户用一套固定的十进分类管理收藏，每个类目有 code、名称和一句说明。

为每条书签选出最合适的类目 code。规则：
1. 只能从给定类目中选择，返回的 code 必须原样抄自类目列表。
2. 只能依据标题、域名和 URL 路径判断，不要臆测页面内容。
3. 两个类目都说得通时，选择更贴近「实际用途」的那个，并在 reason 里点明取舍。
4. conf 是把握程度，0–1。拿不准就给 0.5–0.7，不要为了好看写高。
5. reason 不超过 ${REASON_MAX} 个字，说清依据，例如「官方文档，属前端框架」。
6. 每条书签都必须出现一次，id 原样返回。

只输出 JSON，不要前后解释：
{"items":[{"id":"书签id","code":"类目code","conf":0.9,"reason":"依据"}]}`;

export function buildMessages(items, scheme) {
  const cats = scheme
    .map((f) => `${f.code} ${f.name}${f.hint ? ' — ' + f.hint : ''}`)
    .join('\n');
  const rows = items.map((it) => ({
    id: it.id,
    title: it.title,
    host: it.host,
    path: safePath(it.url),
    current: it.code || null,
  }));
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `分类体系：\n${cats}\n\n待归类书签：\n${JSON.stringify(rows)}`,
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

export async function callModel(settings, messages, { maxTokens } = {}) {
  const base = (settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(20000, (settings.timeout || 8000) * 6));

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
    throw new Error('连不上模型服务：' + (e && e.message ? e.message : e));
  }

  try {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`模型返回 ${res.status}：${body.slice(0, 180) || res.statusText}`);
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

export async function classifyWithModel(items, scheme, settings, onBatch) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const content = await callModel(settings, buildMessages(chunk, scheme));
    const parsed = pickJson(content);
    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error('模型没有返回可解析的 JSON：' + String(content).slice(0, 120));
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
      });
    }
    if (onBatch) onBatch(Math.min(items.length, i + chunk.length), items.length);
  }
  return out;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/* ── 本地兜底规则 ─────────────────────────────── */

const RULES = {
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

export function classifyHeuristic(items, scheme) {
  const codes = new Set(scheme.map((f) => f.code));
  return items.map((it) => {
    const title = String(it.title || '').toLowerCase();
    const hostPath = (String(it.host || '') + ' ' + safePath(it.url)).toLowerCase();

    let best = null;
    for (const [code, words] of Object.entries(RULES)) {
      if (!codes.has(code)) continue;
      let score = 0;
      for (const w of words) {
        // 标题里命中比域名里命中更有说服力
        if (matcherFor(w)(title)) score += 2;
        else if (matcherFor(w)(hostPath)) score += 1;
        else if (w.length >= 3 && /^[a-z0-9]+$/i.test(w)) {
          // 粘连写法兜底：nanoGPT、chatGPT 这类词里带着关键词，但不成独立单词
          if (title.includes(w)) score += 1;
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { code, score };
    }

    const fallback = codes.has('000') ? '000' : scheme[0]?.code || '';
    // 没命中任何关键词时不要乱搬：已归好类的保持原样，未归类的才丢进通用类
    const current = it.code || '';
    const code = best ? best.code : (current || fallback);
    const conf = best ? clamp(0.42 + best.score * 0.035, 0.42, 0.66) : 0.3;
    return {
      id: it.id,
      code,
      conf,
      reason: best
        ? '关键词命中的本地规则，未经模型确认'
        : current
          ? '没有命中关键词，保持原分类'
          : '没有命中关键词，暂放通用类',
      source: 'heuristic',
    };
  });
}

export function hasModel(settings) {
  return Boolean(settings && settings.apiKey && settings.model);
}

export async function classify(items, scheme, settings, onBatch) {
  const list = hasModel(settings)
    ? await classifyWithModel(items, scheme, settings, onBatch)
    : classifyHeuristic(items, scheme);
  if (onBatch && !hasModel(settings)) onBatch(items.length, items.length);

  // 建议归到它已经在的类目=没有动作，直接丢掉，别让用户确认空气
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  return list.filter((s) => (byId[s.id] ? byId[s.id].code || '' : '') !== s.code);
}
