/**
 * 链接体检。
 *
 * 在扩展的 service worker 里发请求，配合 host_permissions 可以跨域读到状态码，
 * 这是网页里做不到的，也是这个功能必须放在扩展里的原因。
 *
 * 结论分五档，刻意把「403 / 429」单独拎出来：
 * 反爬和需要登录经常返回它们，删掉就误伤了。
 */

export const VERDICT = {
  ok: { label: '正常', tone: 'ok' },
  moved: { label: '已跳转', tone: 'mute' },
  dead: { label: '已失效', tone: 'dead' },
  blocked: { label: '疑似失效', tone: 'warn' },
  error: { label: '服务器错误', tone: 'dead' },
  timeout: { label: '超时', tone: 'dead' },
  unreachable: { label: '无法访问', tone: 'dead' },
  invalid: { label: '不可检测', tone: 'mute' },
};

const SKIP = /^(chrome|chrome-extension|edge|about|file|javascript|data|view-source):/i;

function verdictFromStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'moved';
  if (status === 404 || status === 410) return 'dead';
  if (status === 401 || status === 403 || status === 405 || status === 429 || status === 999) return 'blocked';
  if (status >= 500) return 'error';
  return 'blocked';
}

export async function checkOne(url, { timeout = 8000 } = {}) {
  if (SKIP.test(url)) return { status: 'invalid', code: '—', at: Date.now() };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'invalid', code: '—', at: Date.now() };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { status: 'invalid', code: '—', at: Date.now() };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    // 只要响应头，正文立刻掐掉，避免下载整个页面
    try {
      await res.body?.cancel();
    } catch {}

    let finalUrl = res.url || url;
    let status = res.status;
    let verdict = verdictFromStatus(status);

    const sameDoc = stripHash(finalUrl) !== stripHash(url);
    if (verdict === 'ok' && sameDoc) verdict = 'moved';

    return {
      status: verdict,
      code: String(status),
      at: Date.now(),
      ms: Date.now() - started,
      finalUrl: sameDoc ? finalUrl : undefined,
    };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || ctrl.signal.aborted);
    return {
      status: aborted ? 'timeout' : 'unreachable',
      code: aborted ? '超时' : '拒连',
      at: Date.now(),
      ms: Date.now() - started,
      detail: aborted ? `超过 ${timeout}ms 未响应` : String(err && err.message || err).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

function stripHash(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.toString().replace(/\/$/, '');
  } catch {
    return u;
  }
}

/**
 * 并发池。用固定数量的 worker 从队列里取，避免一次性打开几百个连接。
 * onProgress 每完成一条回调一次，用于节流推送进度。
 */
export async function checkMany(urls, { concurrency = 4, timeout = 8000, onProgress, signal } = {}) {
  const queue = urls.slice();
  const results = {};
  let done = 0;

  async function worker() {
    while (queue.length) {
      if (signal && signal.aborted) return;
      const job = queue.shift();
      const r = await checkOne(job.url, { timeout });
      results[job.id] = r;
      done += 1;
      if (onProgress) onProgress(done, urls.length, job.id, r);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length || 1) }, worker);
  await Promise.all(workers);
  return results;
}
