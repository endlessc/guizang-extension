/* 操作手册阅读页：运行时读取 docs/操作手册.md 并渲染
 *
 * 为什么不复制一份 HTML 进仓库：手册会改，复制必然漂移。
 * 这里只有一个源（docs/操作手册.md），页面负责把它画出来；
 * 打包后 .md 也在扩展里，不需要联网。
 */

const SOURCE = '../docs/操作手册.md';

/* ── 极简 Markdown 渲染（只覆盖手册用到的语法） ─────────────
 * 标题 / 段落 / 粗体 / 行内代码 / 链接 / 有序无序列表 / 表格 / 引用 / 分割线
 */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** GitHub 风格的锚点：去掉标点、空格转 -，中文保留 */
function slug(text) {
  return String(text).trim().toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** 行内元素：先抹掉代码片段，处理完粗体/链接再放回来 */
function inline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = /^(https?:|#|\.{0,2}\/)/.test(href) ? href : '#';
    return `<a href="${safe}">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

function renderTable(rows) {
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return `<div class="md-table-wrap"><table><thead><tr>${
    head.map((c) => `<th>${inline(c)}</th>`).join('')
  }</tr></thead><tbody>${
    body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const isTable = (n) => /^\|/.test(lines[n] || '') && /^\|[\s:|-]+\|?$/.test((lines[n + 1] || '').trim());
  const isList = (n) => /^\s*([-*]|\d+\.)\s+/.test(lines[n] || '');

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // 分割线
    if (/^\s*---+\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level} id="${slug(h[2])}">${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 表格
    if (isTable(i)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows));
      continue;
    }

    // 列表（缩进只做一层视觉缩进，不嵌套）
    if (isList(i)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && isList(i)) {
        const m = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        const indent = m[1].length;
        items.push(`<li${indent >= 2 ? ' class="md-sub"' : ''}>${inline(m[2])}</li>`);
        i += 1;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // 段落
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\||\s*---+\s*$)/.test(lines[i]) && !isList(i)) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

async function boot() {
  const box = document.getElementById('doc');
  try {
    const res = await fetch(SOURCE, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    box.innerHTML = render(await res.text());
    // 锚点跳转：滚动到对应标题
    box.querySelectorAll('a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const target = document.getElementById(a.getAttribute('href').slice(1));
        if (!target) return;
        e.preventDefault();
        // 用即时滚动：某些环境（含无动画的嵌入式浏览器）会忽略 behavior:'smooth'
        target.scrollIntoView({ block: 'start' });
        history.replaceState(null, '', a.getAttribute('href'));
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="md-fail">
      <p>手册没读出来：${esc(err.message)}</p>
      <p>可以直接打开源文件：<a href="${SOURCE}">docs/操作手册.md</a></p>
      <p class="hint">在扩展里打开时若仍失败，多半是文件没被打包；在预览里则是本地服务没起。</p>
    </div>`;
  }
}

boot();
