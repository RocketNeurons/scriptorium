// Small DOM helpers and the icon set (Lucide, ISC licence, served from the local cache).

const SPRITE = '/lib/npm/lucide-static@0.460.0/sprite.svg';
const NS = 'http://www.w3.org/2000/svg';

export function icon(name, cls = '') {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', ('i ' + cls).trim());
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', SPRITE + '#' + name);
  s.appendChild(u);
  return s;
}

export function setIcon(svg, name) {
  svg.firstChild.setAttribute('href', SPRITE + '#' + name);
}

// h('div.row.on', {onclick, title}, child, 'text', ...)
export function h(sel, props, ...kids) {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-i]')) {
    const svg = icon(el.dataset.i, el.className);
    if (el.id) svg.id = el.id;
    el.replaceWith(svg);
  }
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem('scriptorium.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('scriptorium.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => { clearTimeout(t); t = null; fn(...a); };
  return d;
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1 << 20) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / (1 << 20)).toFixed(1) + ' MB';
}

export function isMac() { return /Mac|iPhone|iPad/.test(navigator.platform); }
export function keyLabel(k) {
  return k.replace(/Mod/g, isMac() ? '⌘' : 'Ctrl').replace(/Shift/g, isMac() ? '⇧' : 'Shift').replace(/Alt/g, isMac() ? '⌥' : 'Alt');
}
export function kbd(k) {
  return h('span.k', ...keyLabel(k).split('+').map((p) => h('kbd', p)));
}
