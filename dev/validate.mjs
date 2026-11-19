#!/usr/bin/env node
/**
 * 装载前自检：不依赖 Chrome，把能查的都查一遍。
 *   node dev/validate.mjs
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const exists = async (p) => {
  try { await access(join(ROOT, p)); return true; } catch { return false; }
};

const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));

/* 1. 清单必填项与文件存在性 */
if (manifest.manifest_version !== 3) problems.push('manifest_version 必须是 3');
if (!manifest.name) problems.push('缺少 name');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) problems.push('version 格式不对');

const refs = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.side_panel?.default_path,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean);

for (const r of refs) {
  if (!(await exists(r))) problems.push(`清单引用的文件不存在：${r}`);
}

/* 2. HTML 里引用的本地资源 */
const htmls = (await readdir(join(ROOT, 'ui'))).filter((f) => f.endsWith('.html'));
for (const h of htmls) {
  const html = await readFile(join(ROOT, 'ui', h), 'utf8');
  const local = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1].split('?')[0])
    .filter((u) => !/^(https?:|data:|#)/.test(u));
  for (const u of local) {
    const p = join('ui', u);
    if (!(await exists(p))) problems.push(`${h} 引用的资源不存在：${u}`);
  }
  // MV3 的 CSP 会拦掉内联脚本与内联事件
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    problems.push(`${h} 含内联脚本，MV3 CSP 会拒绝执行`);
  }
  if (/\son[a-z]+\s*=/i.test(html)) {
    problems.push(`${h} 含内联事件属性（onclick 之类），MV3 CSP 会拒绝执行`);
  }
}

/* 3. JS 里的危险写法 */
const jsFiles = [];
async function walk(dir) {
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) await walk(p);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) jsFiles.push(p.replace(/^\//, ''));
  }
}
await walk('.');
for (const f of jsFiles) {
  const src = await readFile(join(ROOT, f), 'utf8');
  // 模板字符串里拼出来的 HTML 同样受 CSP 管辖，内联事件会静默失效
  if (/\son(?:load|error|click|change|input|submit)\s*=/.test(src)) {
    problems.push(`${f} 在拼接的 HTML 里用了内联事件，MV3 CSP 会拦掉`);
  }
  if (/\beval\s*\(/.test(src)) problems.push(`${f} 用了 eval，MV3 不允许`);
  if (/new\s+Function\s*\(/.test(src)) problems.push(`${f} 用了 new Function，MV3 不允许`);
  if (/document\.write\s*\(/.test(src)) problems.push(`${f} 用了 document.write`);
}

/* 4. 用到的 chrome.* API 是否都在权限里 */
const PERM_OF_API = {
  bookmarks: 'bookmarks',
  storage: 'storage',
  tabs: 'tabs',
  sidePanel: 'sidePanel',
  alarms: 'alarms',
  scripting: 'scripting',
  history: 'history',
};
const usedApis = new Set();
for (const f of jsFiles.filter((x) => !x.includes('dev/'))) {
  const src = await readFile(join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/\bchrome\.([a-zA-Z]+)\./g)) usedApis.add(m[1]);
}
const declared = new Set([
  ...(manifest.permissions || []),
  ...(manifest.host_permissions || []),
  'runtime', 'i18n', 'extension',
]);
for (const api of usedApis) {
  const need = PERM_OF_API[api];
  if (need && !declared.has(need)) problems.push(`用了 chrome.${api} 但清单里没有 "${need}" 权限`);
}
notes.push('用到的 chrome API：' + [...usedApis].sort().join(', '));

/* 5. host_permissions 是否覆盖检测与模型调用 */
if (!(manifest.host_permissions || []).some((h) => h.includes('http'))) {
  problems.push('没有 http/https 的 host_permissions，跨域检测和调用模型都会失败');
}

/* 6. mock 层不应被生产路径静态引用 */
const uiFiles = jsFiles.filter((f) => f.startsWith('ui/'));
for (const f of uiFiles) {
  const src = await readFile(join(ROOT, f), 'utf8');
  if (/from\s+['"][^'"]*dev\/mock-api/.test(src)) {
    problems.push(`${f} 静态引入了 mock 层，应该只在 http 预览时动态 import`);
  }
}

console.log(`检查了 ${jsFiles.length} 个 JS、${htmls.length} 个 HTML、${refs.length} 个清单引用\n`);
for (const n of notes) console.log('· ' + n);
if (problems.length) {
  console.log('\n❌ 发现 ' + problems.length + ' 个问题：');
  problems.forEach((p) => console.log('  - ' + p));
  process.exit(1);
} else {
  console.log('\n✅ 全部通过，可以 chrome://extensions → 加载已解压的扩展程序');
}
