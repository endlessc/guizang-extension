/**
 * 「逐卷审定」禅意归档模式（Inbox Zero Triage）。
 *
 * 居中单卡呈现，键盘 0–9 一键归入对应类目、Enter 接受 AI 建议、
 * S 星标、Space 预览、→ 跳过、Backspace 删除、Esc 退出。
 * 归类瞬间落下一枚朱砂方印「已归」并弹性滑出。
 */

import { $, esc, icon, send, toast, faviconMark, wireFavicons } from './shared.js';

export function createTriageController({ getState, folderName, onReload }) {
  let active = false;
  let queue = [];
  let index = 0;
  let doneCount = 0;
  let suggestions = {};
  let busy = false;
  let lastAction = null;

  const host = () => $('#triageOverlay');

  function isOpen() {
    return active;
  }

  function close() {
    if (!active) return;
    active = false;
    const el = host();
    if (el) { el.hidden = true; el.innerHTML = ''; }
    onReload();
  }

  async function open(items) {
    const S = getState();
    const pool = (items && items.length)
      ? items
      : S.items.filter((it) => !it.code || S.pending[it.id]);
    if (!pool.length) {
      toast('当前没有待审定的书签，书库已整洁');
      return;
    }
    queue = pool.slice();
    index = 0;
    doneCount = 0;
    suggestions = {};
    lastAction = null;
    active = true;
    host().hidden = false;
    render();
    prefetchSuggestion(queue[0]);
  }

  async function prefetchSuggestion(it) {
    if (!it) return;
    const S = getState();
    if (S.pending[it.id]) {
      suggestions[it.id] = S.pending[it.id];
      render();
      return;
    }
    if (suggestions[it.id]) return;
    try {
      const s = await send('ai:suggestOne', { url: it.url, title: it.title, fast: true });
      if (s && s.code) {
        suggestions[it.id] = s;
        if (active && queue[index] && queue[index].id === it.id) render();
      }
    } catch {}
  }

  function currentItem() {
    return queue[index] || null;
  }

  function animateOut(stampText, dir = 'right', nextFn) {
    const card = host()?.querySelector('.triage-card');
    if (!card) { nextFn(); return; }
    if (stampText) {
      const slot = card.querySelector('.triage-stamp-slot');
      if (slot) slot.innerHTML = `<span class="seal-stamp seal-stamp-lg">${esc(stampText)}</span>`;
    }
    setTimeout(() => {
      card.classList.add(dir === 'left' ? 'is-exit-left' : 'is-exit-right');
      setTimeout(nextFn, 200);
    }, stampText ? 170 : 10);
  }

  async function assignToCode(code) {
    const it = currentItem();
    if (!it || busy || !code) return;
    busy = true;
    try {
      const oldParentId = it.parentId || '1';
      await send('bookmarks:moveCode', { ids: [it.id], code, learn: true });
      await send('ai:ignore', { ids: [it.id] }).catch(() => {});
      lastAction = { type: 'move', item: it, oldParentId, idx: index };
      doneCount += 1;
      animateOut('已归', 'right', () => {
        index += 1;
        busy = false;
        render();
        prefetchSuggestion(queue[index]);
      });
    } catch (e) {
      busy = false;
      toast(e.message);
    }
  }

  async function deleteCurrent() {
    const it = currentItem();
    if (!it || busy) return;
    busy = true;
    try {
      await send('bookmarks:remove', { ids: [it.id] });
      lastAction = { type: 'delete', item: { ...it }, idx: index };
      doneCount += 1;
      animateOut('已删', 'left', () => {
        index += 1;
        busy = false;
        render();
        prefetchSuggestion(queue[index]);
      });
    } catch (e) {
      busy = false;
      toast(e.message);
    }
  }

  function skipCurrent() {
    if (!currentItem() || busy) return;
    busy = true;
    animateOut('', 'left', () => {
      index += 1;
      busy = false;
      render();
      prefetchSuggestion(queue[index]);
    });
  }

  async function undoLast() {
    if (!lastAction || busy) return;
    const act = lastAction;
    lastAction = null;
    busy = true;
    try {
      if (act.type === 'move') {
        await send('bookmarks:restore', { items: [{ type: 'move', id: act.item.id, oldParentId: act.oldParentId }] });
      } else if (act.type === 'delete') {
        await send('bookmarks:restore', { items: [{ type: 'delete', ...act.item }] });
      }
      doneCount = Math.max(0, doneCount - 1);
      index = act.idx;
      toast('已撤销上一卷审定');
    } catch (e) {
      toast(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    const el = host();
    if (!el || !active) return;
    const S = getState();
    const total = queue.length;
    const it = currentItem();
    const pct = total ? Math.round((Math.min(index, total) / total) * 100) : 100;

    if (!it) {
      el.innerHTML = `
        <div class="triage-top">
          <span class="triage-kicker">${icon('triage', 16)} 逐卷审定</span>
          <div class="triage-progress-wrap">
            <div class="triage-progress-bar"><div class="triage-progress-fill" style="width:100%"></div></div>
            <span class="triage-count">${total} / ${total}</span>
          </div>
          <button type="button" class="ibtn" id="trClose" title="退出 (Esc)">${icon('x', 15)}</button>
        </div>
        <div class="triage-card">
          <div class="triage-done">
            <span class="seal-stamp seal-stamp-lg">卷清</span>
            <div class="triage-title">本批 ${total} 卷已全部审定完毕</div>
            <div class="triage-sug-why">共归档或清理 ${doneCount} 卷，书库焕然一新。</div>
            <button type="button" class="btn btn-primary btn-md" id="trDoneClose">回到书库</button>
          </div>
        </div>`;
      el.querySelector('#trClose')?.addEventListener('click', close);
      el.querySelector('#trDoneClose')?.addEventListener('click', close);
      return;
    }

    const sug = suggestions[it.id] || S.pending[it.id] || null;
    const m = S.meta[it.id] || {};
    const dockSchemes = S.scheme.slice(0, 10);

    el.innerHTML = `
      <div class="triage-top">
        <span class="triage-kicker">${icon('triage', 16)} 逐卷审定</span>
        <div class="triage-progress-wrap">
          <div class="triage-progress-bar"><div class="triage-progress-fill" style="width:${pct}%"></div></div>
          <span class="triage-count">第 ${index + 1} / ${total} 卷 · 已处置 ${doneCount}</span>
        </div>
        <button type="button" class="ibtn" id="trClose" title="退出 (Esc)">${icon('x', 15)}</button>
      </div>
      <div class="triage-card">
        <div class="triage-stamp-slot"></div>
        <div class="triage-card-head">
          ${faviconMark(it.host, false, it.url)}
          <span class="triage-host">${esc(it.host)}</span>
          <button type="button" class="ibtn${m.star ? ' is-starred' : ''}" id="trStar" title="加星标 (S)">${icon('star', 14)}</button>
          <button type="button" class="ibtn" id="trOpen" title="新标签预览 (Space)">${icon('external', 14)}</button>
        </div>
        <div class="triage-title">${esc(it.title)}</div>
        <div class="triage-url">${esc(it.url)}</div>
        ${sug && sug.code ? `
          <div class="triage-sug">
            <div class="triage-sug-info">
              <div class="triage-sug-cat">${icon('sparkle', 13)} 建议归入 <span class="tnum">${esc(sug.code)}</span> ${esc(folderName(sug.code))}</div>
              <div class="triage-sug-why">${esc(sug.reason || '按现有目录匹配')}${sug.conf ? ` · 把握 ${Number(sug.conf).toFixed(2)}` : ''}</div>
            </div>
            <button type="button" class="btn btn-primary btn-sm" id="trAccept">${icon('check', 12)}<span>采纳</span> <kbd style="background:rgba(255,255,255,.18);border:0;color:inherit;box-shadow:none">↵</kbd></button>
          </div>
        ` : ''}
        <div class="triage-dock">
          ${dockSchemes.map((f, i) => `
            <button type="button" class="triage-cat-btn${sug && sug.code === f.code ? ' is-suggested' : ''}" data-tr-code="${esc(f.code)}" title="快捷键 ${i}：${esc(f.code)} ${esc(f.name)}">
              <span class="triage-cat-key">${i}</span>
              <span>${esc(f.name)}</span>
            </button>`).join('')}
        </div>
        <div class="triage-foot">
          <button type="button" class="btn btn-danger-ghost btn-sm" id="trDel">${icon('trash', 12)}<span>删除</span> <kbd>⌫</kbd></button>
          ${lastAction ? `<button type="button" class="btn btn-ghost btn-sm" id="trUndo">${icon('undo', 12)}<span>撤销上一卷</span></button>` : ''}
          <div class="triage-foot-right">
            <button type="button" class="btn btn-line btn-sm" id="trSkip"><span>跳过</span> <kbd>→</kbd></button>
          </div>
        </div>
      </div>`;

    wireFavicons(el);
    el.querySelector('#trClose')?.addEventListener('click', close);
    el.querySelector('#trAccept')?.addEventListener('click', () => sug && assignToCode(sug.code));
    el.querySelector('#trDel')?.addEventListener('click', deleteCurrent);
    el.querySelector('#trSkip')?.addEventListener('click', skipCurrent);
    el.querySelector('#trUndo')?.addEventListener('click', undoLast);
    el.querySelector('#trOpen')?.addEventListener('click', () => chrome.tabs.create({ url: it.url, active: false }));
    el.querySelector('#trStar')?.addEventListener('click', async () => {
      const next = !m.star;
      const r = await send('meta:set', { id: it.id, patch: { star: next } });
      if (r.entry) S.meta[it.id] = r.entry; else delete S.meta[it.id];
      render();
      toast(next ? '已加星标' : '已取消星标');
    });
    el.querySelectorAll('[data-tr-code]').forEach((btn) => {
      btn.addEventListener('click', () => assignToCode(btn.dataset.trCode));
    });
  }

  function handleKeydown(e) {
    if (!active) return false;
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    const it = currentItem();
    if (!it) return true;
    const S = getState();
    const sug = suggestions[it.id] || S.pending[it.id] || null;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLast();
      return true;
    }
    if (e.key === 'Enter' && sug && sug.code) {
      e.preventDefault();
      assignToCode(sug.code);
      return true;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      skipCurrent();
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      deleteCurrent();
      return true;
    }
    if (e.key === ' ') {
      e.preventDefault();
      chrome.tabs.create({ url: it.url, active: false });
      return true;
    }
    if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      host()?.querySelector('#trStar')?.click();
      return true;
    }
    if (/^[0-9]$/.test(e.key)) {
      const target = S.scheme[Number(e.key)];
      if (target) {
        e.preventDefault();
        assignToCode(target.code);
        return true;
      }
    }
    return true;
  }

  host()?.addEventListener('click', (e) => {
    if (e.target.id === 'triageOverlay') close();
  });

  return { open, close, isOpen, handleKeydown };
}
