// The PDF pane: pdf.js pages rendered as they come into view, zoom, selectable text, links, SyncTeX highlights.
const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/cdnjs/pdf.js/3.11.174/pdf.worker.min.js';
const CSS_PER_PT = 96 / 72;

export class PdfView {
  constructor({ scroll, pages, empty, onPage, onDblClick, onZoom }) {
    this.scroll = scroll;
    this.pagesEl = pages;
    this.empty = empty;
    this.onPage = onPage || (() => {});
    this.onDblClick = onDblClick || (() => {});
    this.onZoom = onZoom || (() => {});
    this.doc = null;
    this.items = [];
    this.mode = 'width';
    this.scale = 1;
    this.current = 1;
    this.lastPoint = null;
    this.loading = null;
    this.io = new IntersectionObserver((es) => this.onIntersect(es), { root: scroll, rootMargin: '150% 0px' });
    this.visible = new Set();
    scroll.addEventListener('scroll', () => this.trackPage(), { passive: true });
    scroll.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !this.doc) return;
      e.preventDefault();
      this.zoomAt(this.scale * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
    }, { passive: false });
    scroll.addEventListener('dblclick', (e) => {
      const hit = this.pointAt(e.clientX, e.clientY);
      if (!hit) return;
      window.getSelection()?.removeAllRanges();
      this.onDblClick(hit);
    });
    scroll.addEventListener('mousemove', (e) => { const p = this.pointAt(e.clientX, e.clientY); if (p) this.lastPoint = { ...p, t: Date.now() }; }, { passive: true });
    new ResizeObserver(() => {
      if (!this.doc || typeof this.mode === 'number') return;
      clearTimeout(this.resizeT);
      this.resizeT = setTimeout(() => this.applyScale(this.fitScale(), null), 80);
    }).observe(scroll);
  }

  get pageCount() { return this.items.length; }

  // Load (or reload after a compile) without flashing: the new pages replace the old ones once the visible ones are drawn.
  async load(url) {
    const token = {};
    this.loading = token;
    let doc;
    try {
      doc = await pdfjsLib.getDocument({ url, isEvalSupported: false, disableAutoFetch: false }).promise;
    } catch (e) {
      if (this.loading === token) this.loading = null;
      if (!this.doc) this.empty.hidden = false;
      return false;
    }
    if (this.loading !== token) { doc.destroy(); return false; }
    const items = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [x0, y0, x1, y1] = page.view;
      items.push({ n, page, view: page.view, w: x1 - x0, h: y1 - y0, div: null, canvas: null, scale: 0, task: null, text: null, links: null });
    }
    if (this.loading !== token) { doc.destroy(); return false; }
    const anchor = this.anchor();
    const old = { doc: this.doc, items: this.items };
    this.doc = doc;
    this.items = items;
    this.scale = this.fitScale();
    const frag = document.createDocumentFragment();
    for (const it of items) {
      it.div = document.createElement('div');
      it.div.className = 'page';
      it.div.dataset.n = it.n;
      this.sizeDiv(it);
      frag.appendChild(it.div);
    }
    // draw the pages that will be on screen before swapping, so the view does not flash white
    const first = anchor ? Math.min(items.length - 1, anchor.index) : 0;
    const pre = [items[first], items[first + 1]].filter(Boolean);
    await Promise.all(pre.map((it) => this.renderPage(it).catch(() => {})));
    if (this.loading !== token) return false;
    for (const it of old.items) { if (it.task) it.task.cancel(); this.io.unobserve(it.div); }
    this.visible.clear();
    this.pagesEl.replaceChildren(frag);
    this.empty.hidden = true;
    for (const it of items) this.io.observe(it.div);
    if (anchor) this.restore(anchor); else this.scroll.scrollTop = 0;
    if (old.doc) setTimeout(() => old.doc.destroy(), 1000);
    this.loading = null;
    this.trackPage();
    this.onZoom(this.scale);
    return true;
  }

  sizeDiv(it) {
    it.div.style.width = Math.floor(it.w * this.scale) + 'px';
    it.div.style.height = Math.floor(it.h * this.scale) + 'px';
    if (it.text) it.text.style.setProperty('--scale-factor', this.scale);
  }

  fitScale() {
    if (typeof this.mode === 'number') return this.mode * CSS_PER_PT;
    if (!this.items.length) return 1;
    const maxW = Math.max(...this.items.map((i) => i.w));
    const avail = this.scroll.clientWidth - 34;
    const sw = Math.max(0.2, avail / maxW);
    if (this.mode === 'width') return sw;
    const it = this.items[Math.max(0, this.current - 1)] || this.items[0];
    return Math.max(0.2, Math.min(sw, (this.scroll.clientHeight - 36) / it.h));
  }

  setMode(mode) {
    this.mode = mode;
    if (!this.doc) return;
    this.applyScale(this.fitScale(), null);
  }

  zoomBy(f) {
    if (!this.doc) return;
    const r = this.scroll.getBoundingClientRect();
    this.zoomAt(this.scale * f, r.left + r.width / 2, r.top + r.height / 2);
  }

  zoomAt(scale, cx, cy) {
    scale = Math.min(6, Math.max(0.25, scale));
    this.mode = scale / CSS_PER_PT;
    this.applyScale(scale, { cx, cy });
  }

  applyScale(scale, at) {
    if (Math.abs(scale - this.scale) < 1e-4) return;
    const r = this.scroll.getBoundingClientRect();
    const cx = at ? at.cx - r.left : r.width / 2;
    const cy = at ? at.cy - r.top : 0;
    const ratio = scale / this.scale;
    const left = (this.scroll.scrollLeft + cx), top = (this.scroll.scrollTop + cy);
    const padTop = 16;
    this.scale = scale;
    for (const it of this.items) this.sizeDiv(it);
    this.scroll.scrollTop = (top - padTop) * ratio + padTop - cy;
    this.scroll.scrollLeft = left * ratio - cx;
    clearTimeout(this.rerenderT);
    this.rerenderT = setTimeout(() => { for (const n of this.visible) this.renderPage(this.items[n - 1]); }, 120);
    this.onZoom(this.scale);
  }

  onIntersect(entries) {
    for (const e of entries) {
      const n = +e.target.dataset.n;
      const it = this.items[n - 1];
      if (!it || it.div !== e.target) continue;
      if (e.isIntersecting) { this.visible.add(n); this.renderPage(it); }
      else {
        this.visible.delete(n);
        if (this.items.length > 30 && it.canvas) { it.canvas.remove(); it.canvas = null; it.scale = 0; }
      }
    }
  }

  async renderPage(it) {
    if (!it || (it.canvas && Math.abs(it.scale - this.scale) < 1e-4)) return;
    if (it.task) { it.task.cancel(); it.task = null; }
    const scale = this.scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = it.page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = it.page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });
    it.task = task;
    try { await task.promise; } catch (e) { return; }
    if (it.task !== task) return;
    it.task = null;
    if (it.canvas) it.canvas.replaceWith(canvas); else it.div.prepend(canvas);
    it.canvas = canvas;
    it.scale = scale;
    if (!it.text) this.renderText(it);
    if (!it.links) this.renderLinks(it);
  }

  async renderText(it) {
    const div = document.createElement('div');
    div.className = 'textLayer';
    div.style.setProperty('--scale-factor', this.scale);
    it.text = div;
    it.div.appendChild(div);
    try {
      await pdfjsLib.renderTextLayer({ textContentSource: it.page.streamTextContent(), container: div, viewport: it.page.getViewport({ scale: this.scale }), textDivs: [] }).promise;
    } catch (e) { /* text layer is optional */ }
  }

  async renderLinks(it) {
    const box = document.createElement('div');
    box.className = 'links';
    it.links = box;
    it.div.appendChild(box);
    let anns = [];
    try { anns = await it.page.getAnnotations({ intent: 'display' }); } catch (e) { return; }
    const [x0, , x1, y1] = it.view;
    const W = x1 - x0, H = it.h;
    for (const a of anns) {
      if (a.subtype !== 'Link' || !a.rect) continue;
      const ax0 = Math.min(a.rect[0], a.rect[2]), ax1 = Math.max(a.rect[0], a.rect[2]);
      const ay0 = Math.min(a.rect[1], a.rect[3]), ay1 = Math.max(a.rect[1], a.rect[3]);
      const el = document.createElement('a');
      el.style.left = ((ax0 - x0) / W) * 100 + '%';
      el.style.top = ((y1 - ay1) / H) * 100 + '%';
      el.style.width = ((ax1 - ax0) / W) * 100 + '%';
      el.style.height = ((ay1 - ay0) / H) * 100 + '%';
      if (a.url) { el.href = a.url; el.target = '_blank'; el.rel = 'noopener'; el.title = a.url; }
      else if (a.dest) { el.href = '#'; el.addEventListener('click', (e) => { e.preventDefault(); this.goToDest(a.dest); }); }
      else continue;
      box.appendChild(el);
    }
  }

  async goToDest(dest) {
    try {
      const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!explicit) return;
      const idx = await this.doc.getPageIndex(explicit[0]);
      const it = this.items[idx];
      const kind = explicit[1] && explicit[1].name;
      const y = kind === 'XYZ' ? explicit[3] : (kind === 'FitH' || kind === 'FitBH') ? explicit[2] : null;
      const off = y == null ? 0 : (it.view[3] - y) * this.scale;
      this.scrollTo(it.div.offsetTop + off - 24);
    } catch (e) { /* broken link */ }
  }

  scrollTo(top, left) {
    const far = Math.abs(top - this.scroll.scrollTop) > this.scroll.clientHeight * 3;
    this.scroll.scrollTo({ top, left: left ?? this.scroll.scrollLeft, behavior: far ? 'auto' : 'smooth' });
  }

  goToPage(n) {
    const it = this.items[Math.max(0, Math.min(this.items.length - 1, n - 1))];
    if (it) this.scrollTo(it.div.offsetTop - 12);
  }

  anchor() {
    if (!this.items.length) return null;
    const top = this.scroll.scrollTop;
    for (let i = 0; i < this.items.length; i++) {
      const d = this.items[i].div;
      if (d.offsetTop + d.offsetHeight > top) return { index: i, frac: (top - d.offsetTop) / d.offsetHeight, left: this.scroll.scrollLeft };
    }
    return { index: this.items.length - 1, frac: 0, left: 0 };
  }

  restore(a) {
    const it = this.items[Math.min(a.index, this.items.length - 1)];
    if (!it) return;
    this.scroll.scrollTop = it.div.offsetTop + a.frac * it.div.offsetHeight;
    this.scroll.scrollLeft = a.left;
  }

  trackPage() {
    if (!this.items.length) return;
    const mid = this.scroll.scrollTop + this.scroll.clientHeight * 0.4;
    let lo = 0, hi = this.items.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.items[m].div.offsetTop <= mid) lo = m; else hi = m - 1;
    }
    if (this.current !== lo + 1) { this.current = lo + 1; }
    this.onPage(this.current, this.items.length);
  }

  // A screen point -> {page, x, y} in PDF points from the page's top-left corner (what SyncTeX uses).
  pointAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const div = el && el.closest && el.closest('.page');
    if (!div || !this.pagesEl.contains(div)) return null;
    const it = this.items[+div.dataset.n - 1];
    if (!it) return null;
    const r = div.getBoundingClientRect();
    return { page: it.n, x: (clientX - r.left) / this.scale + it.view[0], y: (clientY - r.top) / this.scale };
  }

  // The point the reader is probably looking at: the last place the mouse was on, or the upper part of the view.
  focusPoint() {
    if (this.lastPoint && Date.now() - this.lastPoint.t < 60000) {
      const it = this.items[this.lastPoint.page - 1];
      if (it) {
        const top = it.div.offsetTop + this.lastPoint.y * this.scale;
        if (top >= this.scroll.scrollTop && top <= this.scroll.scrollTop + this.scroll.clientHeight) return this.lastPoint;
      }
    }
    const r = this.scroll.getBoundingClientRect();
    for (const fy of [0.33, 0.5, 0.2, 0.7]) {
      for (const fx of [0.3, 0.7, 0.5]) {
        const p = this.pointAt(r.left + r.width * fx, r.top + r.height * fy);
        if (p) return p;
      }
    }
    return null;
  }

  // Highlight the typeset lines that SyncTeX says a source line made, and scroll to them.
  show(page, rects) {
    const it = this.items[page - 1];
    if (!it || !rects.length) return;
    for (const old of this.pagesEl.querySelectorAll('.hl')) old.remove();
    const [x0] = it.view;
    const W = it.w, H = it.h;
    const keep = rects.filter((r, i) => !rects.some((o, j) => j !== i && o[2] * o[3] > r[2] * r[3] && r[0] >= o[0] - 0.5 && r[1] >= o[1] - 0.5 && r[0] + r[2] <= o[0] + o[2] + 0.5 && r[1] + r[3] <= o[1] + o[3] + 0.5));
    for (const [x, y, w, h] of keep) {
      const d = document.createElement('div');
      d.className = 'hl';
      d.style.left = ((x - x0 - 1.5) / W) * 100 + '%';
      d.style.top = ((y - 1.5) / H) * 100 + '%';
      d.style.width = ((w + 3) / W) * 100 + '%';
      d.style.height = ((h + 3) / H) * 100 + '%';
      it.div.appendChild(d);
      setTimeout(() => d.remove(), 2800);
    }
    const y = Math.min(...keep.map((r) => r[1]));
    const x = Math.min(...keep.map((r) => r[0]));
    const top = it.div.offsetTop + y * this.scale - this.scroll.clientHeight * 0.3;
    const left = it.div.offsetLeft + (x - x0) * this.scale - 40;
    this.scrollTo(Math.max(0, top), this.scroll.scrollWidth > this.scroll.clientWidth ? Math.max(0, left) : undefined);
  }

  setDark(on) { this.pagesEl.classList.toggle('dark-pages', on); }

  async textOfAll() {
    if (!this.doc) return '';
    const out = [];
    for (const it of this.items) {
      const tc = await it.page.getTextContent();
      out.push(tc.items.map((i) => i.str).join(' '));
    }
    return out.join('\n');
  }
}

// Render page 1 of a PDF file (a figure) into a canvas no wider than maxW CSS pixels.
export async function renderPdfThumb(url, maxW, maxH = maxW * 1.4) {
  const doc = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const v1 = page.getViewport({ scale: 1 });
  const s = Math.min(maxW / v1.width, maxH / v1.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: s * dpr });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  c.style.width = Math.floor(vp.width / dpr) + 'px';
  c.style.height = Math.floor(vp.height / dpr) + 'px';
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const info = { width: v1.width, height: v1.height, pages: doc.numPages };
  doc.destroy();
  return { canvas: c, info };
}
