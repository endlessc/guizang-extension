/**
 * 书目导出（纯函数）：
 *   1. Obsidian / Markdown 典藏书目（按分类编号分卷，可选剔除失效链接，含标签与批注）
 *   2. 精选书单 Markdown（适合多选复制分享）
 *   3. 标准 Netscape Bookmark HTML（可直接导回 Chrome / Firefox / Safari）
 */

import { groupByCode } from './tree.js';

const DEAD = new Set(['dead', 'error', 'timeout', 'unreachable']);

function mdEsc(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/([\[\]])/g, '\\$1').trim();
}

function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 导出整库 / 当前视图为 Markdown 书目（适配 Obsidian / Notion） */
export function toMarkdown(items, scheme, opts = {}) {
  const {
    health = {},
    meta = {},
    excludeDead = true,
    title = '归藏 · 典藏书目',
    now = Date.now(),
  } = opts;

  const list = excludeDead
    ? (items || []).filter((it) => !DEAD.has((health[it.id] || {}).status))
    : (items || []);

  const groups = groupByCode(list, scheme || []);
  const dateStr = new Date(now).toISOString().slice(0, 10);
  const lines = [
    `# ${title}`,
    '',
    `> 导出日期：${dateStr} · 共 ${list.length} 卷（${groups.length} 个分卷）${excludeDead ? ' · 已自动剔除失效链接' : ''}`,
    '',
  ];

  for (const g of groups) {
    lines.push(`## ${g.code} ${g.name} (${g.rows.length})`);
    lines.push('');
    for (const it of g.rows) {
      const m = meta[it.id] || {};
      const star = m.star ? '★ ' : '';
      const tags = Array.isArray(m.tags) && m.tags.length
        ? ' ' + m.tags.map((t) => `#${t}`).join(' ')
        : '';
      lines.push(`- ${star}[${mdEsc(it.title)}](${it.url}) — \`${it.host}\`${tags}`);
      if (m.note && String(m.note).trim()) {
        lines.push(`  > ${String(m.note).trim().replace(/\n+/g, ' ')}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

/** 多选导出为紧凑分享书单 */
export function toSelectionMarkdown(items, scheme, { meta = {} } = {}) {
  const nameByCode = new Map((scheme || []).map((f) => [f.code, f.name]));
  const lines = [`### 精选书单（${(items || []).length} 条）`, ''];
  for (const it of items || []) {
    const m = meta[it.id] || {};
    const cat = it.code ? `${it.code} ${nameByCode.get(it.code) || ''}`.trim() : '待归类';
    const note = m.note ? ` —— ${String(m.note).trim()}` : '';
    lines.push(`- [${mdEsc(it.title)}](${it.url}) \`${cat}\`${note}`);
  }
  return lines.join('\n');
}

/** 导出为标准 Netscape Bookmark HTML 1.0 */
export function toNetscapeHtml(items, scheme, { title = '归藏书库导出', now = Date.now() } = {}) {
  const groups = groupByCode(items || [], scheme || []);
  const stamp = Math.floor(now / 1000);
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${htmlEsc(title)}</TITLE>`,
    `<H1>${htmlEsc(title)}</H1>`,
    '<DL><p>',
  ];

  for (const g of groups) {
    const folderTitle = g.key === 'none' ? '待归类' : `${g.code} ${g.name}`;
    lines.push(`  <DT><H3 ADD_DATE="${stamp}" LAST_MODIFIED="${stamp}">${htmlEsc(folderTitle)}</H3>`);
    lines.push('  <DL><p>');
    for (const it of g.rows) {
      const addSec = it.added ? Math.floor(it.added / 1000) : stamp;
      lines.push(`    <DT><A HREF="${htmlEsc(it.url)}" ADD_DATE="${addSec}">${htmlEsc(it.title)}</A>`);
    }
    lines.push('  </DL><p>');
  }

  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}
