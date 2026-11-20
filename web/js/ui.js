// Overlays: toasts, dialogs, menus and the command palette.
import { h, icon, keyLabel } from './dom.js';

const layer = () => document.getElementById('layer');

let toastBox = null;
export function toast(msg, kind = 'info', ms = 2800) {
  if (!toastBox) { toastBox = h('div.toasts'); layer().appendChild(toastBox); }
  const ic = { info: 'circle-check', error: 'circle-x', warn: 'triangle-alert' }[kind] || 'info';
  const t = h('div.toast.' + kind, icon(ic), h('span', msg));
  toastBox.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, ms);
  return t;
}

// A modal dialog. Returns {el, close}. Escape and the scrim close it.
export function modal({ title, body, foot, wide, onClose, iconName }) {
  const scrim = h('div.scrim');
  const box = h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-head', iconName ? icon(iconName) : null, h('h3', title), h('button.mini', { title: 'Close', onclick: () => close() }, icon('x'))),
    h('div.modal-body', body),
    foot && foot.length ? h('div.modal-foot', foot) : null);
  const prevFocus = document.activeElement;
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  let closed = false;
  function close(v) {
    if (closed) return;
    closed = true;
    scrim.remove(); box.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && prevFocus.focus && !prevFocus.matches('button')) prevFocus.focus();
    onClose && onClose(v);
  }
  scrim.addEventListener('mousedown', () => close());
  document.addEventListener('keydown', onKey, true);
  layer().append(scrim, box);
  setTimeout(() => { const f = box.querySelector('input,select,textarea,.btn.primary'); f && f.focus(); if (f && f.select) f.select(); }, 0);
  return { el: box, close };
}

export function promptDialog({ title, label, value = '', placeholder = '', okText = 'OK', validate, selectStem }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder, spellcheck: 'false', autocomplete: 'off' });
    const err = h('div.err');
    const ok = h('button.btn.primary', { onclick: submit }, okText);
    const m = modal({
      title, body: [label ? h('p', label) : null, input, err],
      foot: [h('button.btn', { onclick: () => m.close(null) }, 'Cancel'), ok],
      onClose: (v) => resolve(v ?? null),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    setTimeout(() => {
      input.focus();
      if (selectStem) { const dot = value.lastIndexOf('.'); const slash = value.lastIndexOf('/'); input.setSelectionRange(slash + 1, dot > slash ? dot : value.length); }
      else input.select();
    }, 0);
    function submit() {
      const v = input.value.trim();
      const problem = validate ? validate(v) : (!v ? 'Type a name' : null);
      if (problem) { err.textContent = problem; return; }
      m.close(v);
    }
  });
}

export function confirmDialog({ title, message, okText = 'OK', danger }) {
  return new Promise((resolve) => {
    const ok = h('button.btn.' + (danger ? 'danger' : 'primary'), { onclick: () => m.close(true) }, okText);
    const m = modal({ title, body: h('p', message), foot: [h('button.btn', { onclick: () => m.close(false) }, 'Cancel'), ok], onClose: (v) => resolve(!!v) });
    setTimeout(() => ok.focus(), 0);
  });
}

// A context menu at (x, y). items: {label, icon, kbd, danger, check, run} or '-'
let openMenu = null;
export function menu(x, y, items) {
  closeMenu();
  const el = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { el.appendChild(h('div.msep')); continue; }
    el.appendChild(h('div.mitem' + (it.danger ? '.danger' : ''), {
      role: 'menuitem',
      onclick: () => { closeMenu(); it.run && it.run(); },
    }, it.icon ? icon(it.icon) : h('span', { style: { width: '15px' } }), h('span', it.label),
    it.check !== undefined ? h('span.check', it.check ? '✓' : '') : it.kbd ? h('span.k', keyLabel(it.kbd)) : null));
  }
  layer().appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  openMenu = el;
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc, true);
  }, 0);
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }
export function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', esc, true);
}

// The palette: one input, a list that a source function fills for each query.
// source(query) -> [{icon, html, detail, kbd, run}]
let openPalette = null;
export function palette({ initial = '', placeholder = '', source, hint }) {
  if (openPalette) openPalette.close();
  const scrim = h('div.scrim');
  const input = h('input', { placeholder, spellcheck: 'false', autocomplete: 'off', value: initial });
  const list = h('div.list');
  const box = h('div.palette', input, hint ? h('div.hint', { html: hint }) : null, list);
  let items = [], sel = 0;
  const prevFocus = document.activeElement;
  function render() {
    items = source(input.value) || [];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...(items.length ? items.slice(0, 200).map((it, i) => h('div.pitem' + (i === sel ? '.on' : ''), {
      onmousemove: () => { if (sel !== i) { sel = i; mark(); } },
      onclick: () => run(i),
    }, it.icon ? icon(it.icon) : null, h('span.pl', { html: it.html }), it.detail ? h('span.pd', it.detail) : null, it.kbd ? h('span.pd', keyLabel(it.kbd)) : null))
      : [h('div.none', 'Nothing matches')]));
  }
  function mark() {
    [...list.children].forEach((c, i) => c.classList.toggle('on', i === sel));
    const c = list.children[sel];
    c && c.scrollIntoView({ block: 'nearest' });
  }
  function run(i) {
    const it = items[i];
    if (!it) return;
    if (it.keep) { it.run(input); render(); return; }
    close();
    it.run();
  }
  function close() {
    scrim.remove(); box.remove();
    openPalette = null;
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
  }
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); mark(); e.preventDefault(); }
    else if (e.key === 'PageDown') { sel = Math.min(items.length - 1, sel + 10); mark(); e.preventDefault(); }
    else if (e.key === 'PageUp') { sel = Math.max(0, sel - 10); mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { run(sel); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }
  });
  scrim.addEventListener('mousedown', close);
  layer().append(scrim, box);
  render();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  openPalette = { close, input, render };
  return openPalette;
}
export function paletteOpen() { return !!openPalette; }
