// Scriptorium: the application. Files, tabs, outline, search, git, compiling, the PDF and SyncTeX, settings.
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { snippet } from '@codemirror/autocomplete';
import { foldAll, unfoldAll } from '@codemirror/language';
import { MergeView } from '@codemirror/merge';
import { h, icon, setIcon, $, $$, fillIcons, store, debounce, fmtBytes, kbd } from './dom.js';
import { toast, modal, promptDialog, confirmDialog, menu, palette } from './ui.js';
import { createEditor, setCompileMarks, compileMarksOf, renderMath, external, pathFacet, forceLinting, viewerExtensions, contextAt, setGitBase, regionsOf } from './editor.js';
import {
  scanTex, parseBib, envProblems, openEnvAt, documentOutline, wordsBySection, countWords, katexMacros, resolveInput,
  dirname, joinPath, fuzzy, highlight, esc, IMAGE_EXTS, mathRegions, regionAt, CITE_CMDS, REF_CMDS,
} from './latex.js';
import { PdfView, renderPdfThumb } from './pdfview.js';
import { buildSymbolPanel } from './symbols.js';
import { diffStats, mapLine } from './compare.js';
import { markdown } from './markdown.js';

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  theme: 'system', fontSize: 14, wrap: true, spell: true, spellLang: 'en-US', autosave: true, compileOnSave: true,
  autoCompile: false, mathPreview: true, lintRefs: true, showBoxes: false, followCursor: false, pdfDark: false, showFloats: false,
  gitMarks: true,
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

// ------------------------------------------------------------------ state
const S = {
  project: null,
  files: [], fileMap: new Map(),
  texts: new Map(),     // path -> {text, mtime}: what is on disk, as far as we know
  states: new Map(),    // path -> EditorState of files opened in this session
  saved: new Map(),     // path -> the Text that is on disk
  dirty: new Set(),
  saving: new Set(), saveQ: new Map(),
  conflicts: new Map(), // path -> disk text that differs from unsaved edits
  scans: new Map(), bibs: new Map(), bib: new Map(), labels: new Map(), macros: {}, outline: [],
  tabs: [], active: null, scroll: new Map(), heads: new Map(), gitHead: null,
  issues: [], lastCompile: null, compiling: false, queued: false, pdfMtime: null,
  git: null, openDirs: new Set(), view: 'files', layout: 'split', drawer: false, dtab: 'problems',
  kinds: new Set(['error', 'warning']),
};
let editor, pdf, mergeView = null;
const enc = encodeURIComponent;

async function api(path, body, opts = {}) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scriptorium': '1' }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty */ }
  if (opts.allow) return { status: r.status, data };
  if (!r.ok) throw Object.assign(new Error((data && data.error) || r.statusText), { status: r.status, data });
  return data;
}

// ------------------------------------------------------------------ text access
const docText = new WeakMap();
function textOfState(st) { let t = docText.get(st.doc); if (t == null) { t = st.doc.toString(); docText.set(st.doc, t); } return t; }
function currentText(path) {
  const st = S.states.get(path);
  if (st) return textOfState(st);
  const t = S.texts.get(path);
  return t ? t.text : null;
}
const textsView = { get: (p) => currentText(p) };
const has = (p) => S.fileMap.has(p);
const mainPath = () => S.project.main;
const mainDir = () => dirname(S.project.main);
const kindOf = (p) => (S.fileMap.get(p) || {}).kind;
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const isTex = (p) => /\.(tex|ltx)$/i.test(p);

function relFromMain(p) {
  const d = mainDir();
  if (!d) return p;
  if (p.startsWith(d + '/')) return p.slice(d.length + 1);
  const up = d.split('/').map(() => '..').join('/');
  return up + '/' + p;
}

function graphicsDirs() {
  const t = currentText(mainPath()) || '';
  const m = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(t);
  const dirs = [''];
  if (m) for (const d of m[1].match(/\{([^}]*)\}/g) || []) dirs.push(d.slice(1, -1));
  return dirs;
}
function resolveGraphic(name) {
  for (const d of graphicsDirs()) {
    const stem = joinPath(mainDir(), joinPath(d, name));
    if (has(stem) && kindOf(stem) !== 'dir') return stem;
    for (const e of IMAGE_EXTS) if (has(stem + e)) return stem + e;
  }
  return null;
}

// ------------------------------------------------------------------ the project index
function rescan(path) {
  const text = currentText(path);
  if (text == null) return;
  if (/\.bib$/i.test(path)) S.bibs.set(path, parseBib(text));
  else if (isTex(path)) S.scans.set(path, scanTex(text));
}
function rebuildLabels() {
  S.labels = new Map();
  for (const [f, sc] of S.scans) for (const l of sc.labels) {
    if (!S.labels.has(l.name)) S.labels.set(l.name, []);
    S.labels.get(l.name).push({ ...l, file: f });
  }
  labelOptionsCache = null;
}
function rebuildIndex() {
  S.bib = new Map();
  for (const [f, list] of S.bibs) for (const e of list) if (!S.bib.has(e.key)) S.bib.set(e.key, { ...e, file: f });
  citeOptionsCache = null;
  rebuildLabels();
  S.macros = katexMacros(S.scans);
  macroOptionsCache = null;
  S.outline = has(mainPath()) ? documentOutline(mainPath(), S.scans, textsView, has, settings.showFloats) : [];
  renderOutline();
  wordsSoon();
}
const indexSoon = debounce((path) => { rescan(path); rebuildIndex(); renderTree(); }, 300);

function labelInfo(def) {
  const sc = S.scans.get(def.file);
  const fl = sc && sc.floats.find((f) => def.pos >= f.pos && def.pos <= (f.endPos ?? Infinity));
  if (fl) return { kind: fl.type, title: fl.caption, float: fl };
  const text = currentText(def.file) || '';
  const reg = regionAt(mathRegions(text), def.pos);
  if (reg && !reg.verbatim) return { kind: 'equation', title: '', region: reg, text };
  const sec = sc && sc.sections.filter((s) => s.pos <= def.pos).pop();
  if (sec && def.line - sec.line <= 3) return { kind: sec.cmd, title: sec.title };
  const pre = def.name.split(':')[0];
  return { kind: { fig: 'figure', tab: 'table', eq: 'equation', sec: 'section', alg: 'algorithm', app: 'appendix', lem: 'lemma', thm: 'theorem' }[pre] || 'label', title: '' };
}

// ------------------------------------------------------------------ editor hooks
let labelOptionsCache = null, citeOptionsCache = null, macroOptionsCache = null;
const hooks = {
  labelOptions() {
    if (!labelOptionsCache) labelOptionsCache = [...S.labels.entries()].map(([name, defs]) => {
      const info = labelInfo(defs[0]);
      return { label: name, type: 'variable', detail: info.kind, info: () => labelCard(name, defs, info, true) };
    });
    return labelOptionsCache;
  },
  citeOptions() {
    if (!citeOptionsCache) citeOptionsCache = [...S.bib.values()].map((e) => ({
      label: e.key, type: 'text', detail: [e.author.split(',')[0], e.year].filter(Boolean).join(' '), info: () => bibCard(e, true),
    }));
    return citeOptionsCache;
  },
  macroOptions() {
    if (!macroOptionsCache) {
      const seen = new Set();
      macroOptionsCache = [];
      for (const sc of S.scans.values()) for (const m of sc.macros) {
        if (seen.has(m.name)) continue;
        seen.add(m.name);
        const tpl = m.name + '{${}}'.repeat(m.nargs);
        macroOptionsCache.push({ label: m.name, type: 'function', detail: 'your command', info: m.def.slice(0, 200), apply: m.nargs ? snippet(tpl) : m.name, boost: 1 });
      }
    }
    return macroOptionsCache;
  },
  fileOptions(kind) {
    const out = [];
    for (const f of S.files) {
      if (kind === 'tex' && isTex(f.path) && f.path !== mainPath()) out.push({ label: relFromMain(f.path).replace(/\.tex$/, ''), type: 'namespace', detail: 'file' });
      if (kind === 'image' && (f.kind === 'image' || f.kind === 'pdf')) out.push({ label: relFromMain(f.path), type: 'namespace', detail: f.kind === 'pdf' ? 'PDF' : 'image' });
      if (kind === 'bib' && /\.bib$/.test(f.path)) out.push({ label: relFromMain(f.path).replace(/\.bib$/, ''), type: 'namespace', detail: 'bibliography' });
    }
    return out;
  },
  usedEnvironments() {
    const s = new Set();
    for (const sc of S.scans.values()) for (const e of sc.envs) if (e.begin) s.add(e.name);
    return [...s];
  },
  openEnvironment(state, pos) { return openEnvAt(scanTex(state.doc.toString()), pos); },
  macros: () => S.macros,
  diagnostics,
  hoverCard,
  goto,
  gotoDefinition(view) {
    const c = contextAtCursor(view);
    return c ? goto(c) : false;
  },
  compile: () => compile(),
  save: () => ctrlS(),
  pasteFiles: (files, view) => uploadImages(files, view, view.state.selection.main.head, true),
  dropFiles: (files, view, pos) => uploadImages(files, view, pos ?? view.state.selection.main.head, false),
  onUpdate,
};

function contextAtCursor(view) { return contextAt(view.state, view.state.selection.main.head); }

function diag(from, to, severity, message, source = 'Scriptorium') { return { from, to: Math.max(from, to), severity, message, source }; }

function diagnostics(state) {
  const path = state.facet(pathFacet);
  if (!path) return [];
  const out = [];
  if (isTex(path)) {
    const scan = scanTex(textOfState(state));
    S.scans.set(path, scan);
    rebuildLabels();
    if (settings.lintRefs) {
      for (const r of scan.refs) if (!S.labels.has(r.key) && !/[\\#]/.test(r.key)) out.push(diag(r.from, r.to, 'warning', `There is no \\label{${r.key}} in the project.`));
      if (S.bibs.size) for (const c of scan.cites) if (c.key !== '*' && !S.bib.has(c.key) && !/[\\#]/.test(c.key)) out.push(diag(c.from, c.to, 'warning', `"${c.key}" is not in the bibliography.`));
      for (const l of scan.labels) {
        const defs = S.labels.get(l.name) || [];
        if (defs.length > 1) {
          const other = defs.find((d) => d.file !== path || d.pos !== l.pos);
          out.push(diag(l.from, l.to, 'warning', `\\label{${l.name}} is defined ${defs.length} times${other ? ` (also in ${other.file}, line ${other.line})` : ''}.`));
        }
      }
      for (const i of scan.inputs) if (i.cmd !== 'includeonly' && !/[\\#]/.test(i.path) && !resolveInput(i.path, mainDir(), has)) out.push(diag(i.from, i.to, 'warning', `There is no file "${i.path}" in the project.`));
      for (const g of scan.graphics) if (!/[\\#]/.test(g.path) && !resolveGraphic(g.path)) out.push(diag(g.from, g.to, 'warning', `There is no image "${g.path}" in the project.`));
    }
    for (const p of envProblems(scan)) out.push(diag(p.from, p.to, 'error', p.message));
  }
  for (const d of compileMarksOf(state)) {
    if (d.kind === 'box' && !settings.showBoxes) continue;
    out.push(diag(d.from, d.to, d.kind === 'error' ? 'error' : d.kind === 'warning' ? 'warning' : 'info', d.msg + (d.hint ? '\n' + d.hint : ''), 'LaTeX'));
  }
  return out;
}

// ------------------------------------------------------------------ hover cards
const thumbs = new Map();
function figureThumb(path, maxW = 300) {
  const f = S.fileMap.get(path);
  if (!f) return null;
  if (f.kind === 'image') return h('img', { src: '/raw/' + path.split('/').map(enc).join('/') + '?v=' + f.mtime, alt: '' });
  if (f.kind === 'pdf') {
    const box = h('div');
    const key = path + '@' + f.mtime;
    const put = (c) => { const k = c.cloneNode(); k.getContext('2d').drawImage(c, 0, 0); k.style.cssText = c.style.cssText; box.replaceChildren(k); };
    if (thumbs.has(key)) put(thumbs.get(key));
    else renderPdfThumb('/raw/' + path.split('/').map(enc).join('/') + '?v=' + f.mtime, maxW, 220).then(({ canvas }) => { thumbs.set(key, canvas); put(canvas); }).catch(() => {});
    return box;
  }
  return null;
}

function bibCard(e, compact) {
  return h('div.card', h('div.k', '@' + e.type + ' · ' + e.key), h('div.t', e.title || '(no title)'),
    h('div.a', [e.author, e.year].filter(Boolean).join(' · ')), e.venue ? h('div.v', e.venue) : null,
    compact ? null : h('div.go', 'Ctrl+click opens the entry in ' + e.file));
}

function labelCard(name, defs, info, compact) {
  const d = defs[0];
  const card = h('div.card', h('div.k', `\\label{${name}} · ${d.file}:${d.line}`),
    h('div.t', info.kind[0].toUpperCase() + info.kind.slice(1) + (info.title ? ': ' + info.title : '')));
  if (info.region) {
    const m = h('div.math-tip', { style: { padding: '6px 0 0', background: 'none' } });
    renderMath(m, info.region, info.text, S.macros);
    card.appendChild(m);
  }
  if (info.float) {
    const sc = S.scans.get(d.file);
    const g = sc && sc.graphics.find((x) => x.pos > info.float.pos && x.pos < (info.float.endPos ?? Infinity));
    const p = g && resolveGraphic(g.path);
    const th = p && figureThumb(p);
    if (th) card.appendChild(th);
  }
  if (defs.length > 1) card.appendChild(h('div.v', `Defined ${defs.length} times`));
  if (!compact) card.appendChild(h('div.go', 'Ctrl+click goes to the label'));
  return card;
}

function hoverCard(c, state) {
  if (c.type === 'cite') {
    const e = S.bib.get(c.key);
    if (e) return bibCard(e);
    if (!c.key) return null;
    return h('div.card', h('div.k', c.key), h('div.t', 'Not in the bibliography'), h('div.v', S.bibs.size ? 'Check the key, or add the entry to ' + [...S.bibs.keys()][0] : 'This project has no .bib file'));
  }
  if (c.type === 'ref') {
    const defs = S.labels.get(c.key);
    if (defs) return labelCard(c.key, defs, labelInfo(defs[0]));
    return c.key ? h('div.card', h('div.k', c.key), h('div.t', 'No \\label with this name'), h('div.v', 'Labels in the project appear when you type \\ref{')) : null;
  }
  if (c.type === 'label') {
    let n = 0;
    for (const sc of S.scans.values()) for (const r of sc.refs) if (r.key === c.key) n++;
    return h('div.card', h('div.k', `\\label{${c.key}}`), h('div.t', n ? `Referenced ${n} time${n > 1 ? 's' : ''}` : 'Not referenced anywhere'), n ? h('div.go', 'Ctrl+click lists the references') : null);
  }
  if (c.type === 'graphics') {
    const p = resolveGraphic(c.key);
    if (!p) return h('div.card', h('div.k', c.key), h('div.t', 'Image not found'));
    const f = S.fileMap.get(p);
    return h('div.card', h('div.k', p + ' · ' + fmtBytes(f.size)), figureThumb(p), h('div.go', 'Ctrl+click opens the image'));
  }
  if (c.type === 'input') {
    const p = resolveInput(c.key, mainDir(), has);
    if (!p) return h('div.card', h('div.k', c.key), h('div.t', 'File not found'));
    const t = currentText(p) || '';
    const sc = S.scans.get(p);
    const words = countWords(t);
    return h('div.card', h('div.k', p), h('div.t', (sc && sc.sections[0] ? sc.sections[0].title : base(p))),
      h('div.v', `${t.split('\n').length} lines · ${words.toLocaleString()} words`), h('div.go', 'Ctrl+click opens the file'));
  }
  if (c.type === 'bib') {
    const p = resolveInput(c.key, mainDir(), has, ['.bib', '']);
    return h('div.card', h('div.k', p || c.key), h('div.t', p ? `${(S.bibs.get(p) || []).length} entries` : 'File not found'));
  }
  if (c.type === 'math') {
    const el = h('div.math-tip');
    renderMath(el, c.region, textOfState(state), S.macros);
    return el;
  }
  if (c.type === 'macro') {
    for (const [f, sc] of S.scans) {
      const m = sc.macros.find((x) => x.name === c.name);
      if (m) return h('div.card', h('div.k', `${m.name}${m.nargs ? ` [${m.nargs}]` : ''} · ${f}:${m.line}`), h('div.ctx', m.def.slice(0, 300)), h('div.go', 'Ctrl+click goes to the definition'));
    }
  }
  return null;
}

function goto(c) {
  if (c.type === 'ref') {
    const defs = S.labels.get(c.key);
    if (!defs) return false;
    openFile(defs[0].file, { pos: defs[0].pos, flash: true });
    return true;
  }
  if (c.type === 'label') { showView('search', false); $('#searchInput').value = c.key; S.searchOpts = { ...S.searchOpts, regex: false, word: false }; syncSearchToggles(); runSearch(); return true; }
  if (c.type === 'cite') {
    const e = S.bib.get(c.key);
    if (!e) return false;
    openFile(e.file, { pos: e.pos, flash: true });
    return true;
  }
  if (c.type === 'input' || c.type === 'bib') {
    const p = resolveInput(c.key, mainDir(), has, c.type === 'bib' ? ['.bib', ''] : ['.tex', '']);
    if (!p) return false;
    openFile(p);
    return true;
  }
  if (c.type === 'graphics') {
    const p = resolveGraphic(c.key);
    if (!p) return false;
    openFile(p);
    return true;
  }
  if (c.type === 'macro') {
    for (const [f, sc] of S.scans) { const m = sc.macros.find((x) => x.name === c.name); if (m) { openFile(f, { pos: m.pos, flash: true }); return true; } }
  }
  return false;
}

// ------------------------------------------------------------------ editor state per file
function stateFor(path) {
  let st = S.states.get(path);
  if (st) return st;
  const t = S.texts.get(path);
  st = editor.makeState(t ? t.text : '', path);
  const marks = marksFor(path, st.doc);
  if (marks.length) st = st.update({ effects: setCompileMarks.of(marks) }).state;
  S.states.set(path, st);
  S.saved.set(path, st.doc);
  return st;
}

function onUpdate(u) {
  const path = u.state.facet(pathFacet);
  if (!path) return;
  S.states.set(path, u.state);
  if (u.docChanged) {
    const fromDisk = u.transactions.some((t) => t.annotation(external));
    updateDirty(path);
    if (!fromDisk) {
      if (settings.autosave) autosave();
      if (settings.autoCompile) autoCompile();
    }
    indexSoon(path);
  }
  if (u.docChanged || u.selectionSet) cursorMoved();
  if (C.ref && (u.docChanged || u.selectionSet)) cmpBarSoon();
}

function updateDirty(path) {
  const st = S.states.get(path);
  const saved = S.saved.get(path);
  const dirty = !!st && !(saved && (st.doc === saved || (st.doc.length === saved.length && st.doc.eq(saved))));
  if (dirty === S.dirty.has(path)) return;
  if (dirty) S.dirty.add(path); else S.dirty.delete(path);
  renderTabs();
  renderTree();
}

function replaceDoc(path, text) {
  const apply = (st) => {
    const old = textOfState(st);
    let a = 0;
    while (a < old.length && a < text.length && old.charCodeAt(a) === text.charCodeAt(a)) a++;
    let b = 0;
    while (b < old.length - a && b < text.length - a && old.charCodeAt(old.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
    return { changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, annotations: external.of(true) };
  };
  const st = S.states.get(path);
  if (!st) return;
  if (S.active === path && editor.view.state === st) editor.view.dispatch(apply(st));
  else S.states.set(path, st.update(apply(st)).state);
  S.saved.set(path, S.states.get(path).doc);
  updateDirty(path);
}

// ------------------------------------------------------------------ saving
const autosave = debounce(() => saveAll(), 900);
const autoCompile = debounce(() => { saveAll().then((ok) => ok && compile()); }, 2200);

function saveFile(path, force = false) {
  const prev = S.saveQ.get(path) || Promise.resolve();
  const p = prev.then(() => doSave(path, force));
  S.saveQ.set(path, p.catch(() => {}));
  return p;
}
async function doSave(path, force) {
  const st = S.states.get(path);
  if (!st) return true;
  if (!force && !S.dirty.has(path)) return true;
  const doc = st.doc;
  const text = textOfState(st);
  const meta = S.texts.get(path);
  S.saving.add(path);
  try {
    const r = await api('/api/save', { path, text, mtime: meta ? meta.mtime : 0, force }, { allow: [409] });
    if (r.status === 409) {
      S.conflicts.set(path, r.data.text);
      S.texts.set(path, { text: r.data.text, mtime: r.data.mtime });
      renderBanner();
      return false;
    }
    if (r.status !== 200) throw new Error((r.data && r.data.error) || 'save failed');
    S.texts.set(path, { text, mtime: r.data.mtime });
    S.saved.set(path, doc);
    S.conflicts.delete(path);
    updateDirty(path);
    $('#sbSaved').textContent = 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    gitSoon();
    return true;
  } catch (e) {
    toast(`Could not save ${path}: ${e.message}`, 'error');
    return false;
  } finally {
    S.saving.delete(path);
  }
}
async function saveAll() {
  autosave.cancel();
  let ok = true;
  for (const p of [...S.dirty]) ok = (await saveFile(p)) && ok;
  return ok;
}
async function ctrlS() {
  const ok = await saveAll();
  if (ok && settings.compileOnSave) compile();
  else if (ok) toast('Saved');
}

// ------------------------------------------------------------------ compiling
const HINTS = [
  [/Undefined control sequence/, 'A command is misspelled, or the package that defines it is not loaded.'],
  [/Missing \$ inserted/, 'Something that only works in math (like _ or ^ or a Greek letter) is outside $…$.'],
  [/File `([^']+)' not found/, 'The file is not in the project, or the name or folder is wrong.'],
  [/Missing \\begin\{document\}/, 'Text appears before \\begin{document}, or the preamble has a stray character.'],
  [/Environment (\S+) undefined/, 'The environment is misspelled, or its package is not loaded.'],
  [/Missing \} inserted|Extra \}|Missing \{ inserted/, 'The braces do not balance: a { or } is missing or extra.'],
  [/Extra alignment tab/, 'A table row has more & than the column specification allows.'],
  [/Misplaced alignment tab/, 'An & is outside a table or alignment. Write \\& for a literal ampersand.'],
  [/There's no line here to end/, 'A \\\\ appears where no line has started (for example right after a paragraph break).'],
  [/Too many \}'s/, 'There is a } without a matching {.'],
  [/LaTeX Error: \\begin\{(\S+)\} on input line \d+ ended by \\end\{(\S+)\}/, 'An environment is closed with the wrong \\end.'],
  [/Citation .* undefined/, 'The key is not in the bibliography, or BibTeX has not run since it was added.'],
  [/Reference .* undefined/, 'There is no \\label with this name, or the document needs another compile.'],
  [/Paragraph ended before .* was complete/, 'A command argument runs across a blank line: a } is probably missing.'],
  [/Double subscript|Double superscript/, 'Two _ or two ^ in a row: group them with braces, like x_{a_b}.'],
  [/Illegal unit of measure/, 'A length is missing its unit (pt, cm, em, \\linewidth).'],
];
function hintFor(msg) { for (const [re, t] of HINTS) if (re.test(msg)) return t; return ''; }

// Where on its line a compile message points: the undefined key, the command TeX stopped at, or else the whole line.
function issueRange(i, ln) {
  const key = /(?:Reference|Citation) [`'‘]([^'’]+)['’]/.exec(i.msg);
  if (key) {
    const k = ln.text.indexOf(key[1]);
    if (k >= 0) return [ln.from + k, ln.from + k + key[1].length];
  }
  if (i.context && i.context[0]) {
    const tail = i.context[0].slice(-40);
    const k = ln.text.indexOf(tail);
    if (k >= 0) {
      const end = k + tail.length;
      const cmd = /\\[a-zA-Z@]+\*?$|\S$/.exec(tail);
      return [ln.from + end - (cmd ? cmd[0].length : 1), ln.from + end];
    }
  }
  const lead = ln.text.length - ln.text.trimStart().length;
  return [ln.from + lead, ln.to];
}

function marksFor(path, doc) {
  const out = [];
  for (const i of S.issues) {
    if (i.file !== path || !i.line || i.line > doc.lines) continue;
    if (settings.lintRefs && /^(Reference|Citation) .* undefined/.test(i.msg)) continue;  // the live check marks these already
    const [from, to] = issueRange(i, doc.line(i.line));
    out.push({ from, to, kind: i.kind, msg: i.msg, hint: hintFor(i.msg) });
  }
  return out;
}

function applyCompileMarks() {
  for (const [path, st] of [...S.states]) {
    const marks = marksFor(path, st.doc);
    if (S.active === path && editor.view.state === st) editor.view.dispatch({ effects: setCompileMarks.of(marks) });
    else S.states.set(path, st.update({ effects: setCompileMarks.of(marks) }).state);
  }
  forceLinting(editor.view);
}

let compileTimer = null;
async function compile() {
  if (S.compiling) { S.queued = true; return; }
  const ok = await saveAll();
  if (!ok && S.conflicts.size) { toast('Resolve the file conflict first', 'warn'); return; }
  S.compiling = true;
  const t0 = Date.now();
  setChip('busy', 'Compiling…');
  $('#compileBtn').classList.add('busy');
  setIcon($('#compileIcon'), 'loader-circle');
  compileTimer = setInterval(() => setChip('busy', `Compiling… ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
  let r;
  try {
    r = await api('/api/compile', {});
  } catch (e) {
    r = { ok: false, seconds: 0, issues: [{ kind: 'error', file: null, line: null, msg: 'The Scriptorium server did not answer: ' + e.message }], log: '' };
  }
  clearInterval(compileTimer);
  S.compiling = false;
  $('#compileBtn').classList.remove('busy');
  setIcon($('#compileIcon'), 'play');
  if (r.no_tectonic) {
    // first run on a new computer: show how to install the LaTeX engine where the PDF would be
    setChip('err', 'Install Tectonic');
    const empty = $('#pdfEmpty');
    empty.hidden = false;
    empty.replaceChildren(h('div.tecto-wrap', tectonicCard(S.project, () => { location.reload(); })));
    S.queued = false;
    return;
  }
  await applyCompileResult(r);
  if (S.queued) { S.queued = false; compile(); }
}

// Show a compile result: problems, marks in the editor, the status chip, the new PDF. Also used for compiles an
// agent starts through the door.
async function applyCompileResult(r) {
  S.lastCompile = r;
  S.issues = r.issues.map((i) => ({ ...i, hint: i.kind === 'error' || i.kind === 'warning' ? hintFor(i.msg) : '' }));
  applyCompileMarks();
  renderProblems();
  renderTree();
  const ne = S.issues.filter((i) => i.kind === 'error').length;
  const nw = S.issues.filter((i) => i.kind === 'warning').length;
  if (r.ok) setChip(nw ? 'warn' : 'ok', `Compiled · ${r.seconds} s` + (nw ? ` · ${nw} warning${nw > 1 ? 's' : ''}` : ''));
  else setChip('err', ne ? `${ne} error${ne > 1 ? 's' : ''}` : 'Compile failed');
  if (!r.ok && ne && !S.drawer) { toggleDrawer(true); S.drawerAuto = true; }
  else if (!ne && S.drawer && S.drawerAuto) { toggleDrawer(false); S.drawerAuto = false; }
  if (r.pdf_mtime && r.pdf_mtime !== S.pdfMtime) {
    S.pdfMtime = r.pdf_mtime;
    await pdf.load('/pdf?v=' + r.pdf_mtime);
    if (settings.followCursor) syncToPdf(true);
  }
}

function setChip(kind, text) {
  const c = $('#statusChip');
  c.className = 'chip ' + kind;
  $('#statusText').textContent = text;
}

// ------------------------------------------------------------------ SyncTeX
async function syncToPdf(quiet) {
  if (!S.active || activeKind() !== 'text') return;
  if (!S.pdfMtime) { if (!quiet) toast('Compile first, then the PDF can follow the source.', 'warn'); return; }
  const v = editor.view;
  const line = v.state.doc.lineAt(v.state.selection.main.head).number;
  syncRefToLine(S.active, line, quiet);
  try {
    const r = await api('/api/synctex/view', { file: S.active, line });
    if (r.page) {
      if (S.layout === 'editor') setLayout('split');
      pdf.show(r.page, r.rects);
    } else if (!quiet) toast('This part is not in the PDF. Is the file part of the document?', 'warn');
  } catch (e) { if (!quiet) toast('SyncTeX: ' + e.message, 'error'); }
}
async function syncToCode(point) {
  const p = point || pdf.focusPoint();
  if (!p) return;
  try {
    const r = await api('/api/synctex/edit', { page: p.page, x: p.x, y: p.y });
    if (r.file) {
      if (S.layout === 'pdf') setLayout('split');
      openFile(r.file, { line: r.line, flash: true });
      syncRefToLine(r.file, r.line, true);
    } else toast('No source for that spot (it may come from a package or the class).', 'warn');
  } catch (e) { toast('SyncTeX: ' + e.message, 'error'); }
}
const followSoon = debounce(() => syncToPdf(true), 700);

// ------------------------------------------------------------------ opening files and tabs
const activeTab = () => S.tabs.find((t) => tabKey(t) === S.active);
const activeKind = () => { const t = activeTab(); return t ? t.kind : null; };
const tabKey = (t) => (t.kind === 'diff' ? 'diff:' + t.path : t.kind === 'ref' ? 'ref:' + t.path : t.path);

function addTab(tab) {
  if (!S.tabs.some((t) => tabKey(t) === tabKey(tab))) {
    const i = S.tabs.findIndex((t) => tabKey(t) === S.active);
    S.tabs.splice(i < 0 ? S.tabs.length : i + 1, 0, tab);
  }
}

async function openFile(path, opts = {}) {
  const f = S.fileMap.get(path);
  if (!f) { toast(`${path} is not in the project`, 'warn'); return; }
  if (f.kind !== 'text') { addTab({ path, kind: f.kind }); activate(path); return; }
  if (!S.texts.has(path)) {
    try { S.texts.set(path, await api('/api/file?path=' + enc(path))); } catch (e) { toast(e.message, 'error'); return; }
  }
  addTab({ path, kind: 'text' });
  activate(path, opts.pos != null || opts.line != null);
  const view = editor.view;
  let pos = opts.pos;
  if (opts.line != null) pos = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, opts.line))).from;
  if (pos != null) {
    pos = Math.min(pos, view.state.doc.length);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    if (opts.flash) flashLine(pos);
  }
  if (opts.focus !== false) view.focus();
}

function flashLine(pos) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      const { node } = editor.view.domAtPos(pos);
      const el = (node.nodeType === 1 ? node : node.parentElement).closest('.cm-line');
      if (el) { el.classList.remove('cm-flash'); void el.offsetWidth; el.classList.add('cm-flash'); setTimeout(() => el.classList.remove('cm-flash'), 1700); }
    } catch (e) { /* off screen */ }
  }));
}

function activate(key, keepScroll) {
  const prev = activeTab();
  if (prev && prev.kind === 'text' && S.states.has(prev.path)) S.scroll.set(prev.path, editor.view.scrollDOM.scrollTop);
  S.active = key;
  const t = activeTab();
  $('#cmHost').hidden = !t || t.kind !== 'text';
  $('#preview').hidden = !t || !['image', 'pdf', 'other'].includes(t.kind);
  $('#diffHost').hidden = !t || (t.kind !== 'diff' && t.kind !== 'ref');
  $('#editorEmpty').hidden = !!t;
  if (mergeView && (!t || t.kind !== 'diff')) { mergeView.destroy(); mergeView = null; }
  if (refView && (!t || t.kind !== 'ref')) { refView.destroy(); refView = null; }
  if (!t || t.kind !== 'text') renderCmpBar();
  if (t && t.kind === 'text') {
    const st = stateFor(t.path);
    if (editor.view.state !== st) {
      editor.view.setState(st);
      editor.configure(settings);
      S.states.set(t.path, editor.view.state);
    }
    loadGitBase(t.path);
    applyCompare(t.path);
    if (!keepScroll) {
      let top = S.scroll.get(t.path);
      if (top == null) {
        // first time this session: where the cursor was last time
        const saved = (store.get('cursor', {})[S.project.root] || {})[t.path];
        top = 0;
        if (saved) {
          editor.view.dispatch({ selection: { anchor: Math.min(saved[0], editor.view.state.doc.length) } });
          top = saved[1] || 0;
        }
      }
      requestAnimationFrame(() => { editor.view.scrollDOM.scrollTop = top; });
    }
  } else if (t && t.kind === 'diff') renderDiff(t.path);
  else if (t && t.kind === 'ref') renderRefOnly(t.path);
  else if (t) renderPreview(t.path, t.kind);
  renderTabs();
  renderTree();
  renderBanner();
  cursorMoved();
  pushContext();
  persistTabs();
}

function closeTab(key) {
  const i = S.tabs.findIndex((t) => tabKey(t) === key);
  if (i < 0) return;
  const t = S.tabs[i];
  if (t.kind === 'text' && S.dirty.has(t.path)) saveFile(t.path);
  if (t.kind === 'text' && S.active === key) S.scroll.set(t.path, editor.view.scrollDOM.scrollTop);
  S.tabs.splice(i, 1);
  if (S.active === key) {
    const next = S.tabs[i] || S.tabs[i - 1];
    if (next) activate(tabKey(next)); else { S.active = null; activate(null); }
  } else { renderTabs(); persistTabs(); }
}

function persistTabs() {
  if (!S.project) return;
  const all = store.get('tabs', {});
  all[S.project.root] = { tabs: S.tabs.filter((t) => t.kind !== 'diff' && t.kind !== 'ref'), active: S.active };
  store.set('tabs', all);
}

function fileIconName(path, kind) {
  if (kind === 'dir') return 'folder';
  if (kind === 'diff') return 'git-compare';
  if (kind === 'ref') return 'file-text';
  if (/\.bib$/i.test(path)) return 'book-marked';
  if (/\.(cls|sty|bst|clo|def|cfg|bbx|cbx)$/i.test(path)) return 'file-cog';
  if (kind === 'image') return 'image';
  if (kind === 'pdf') return 'file-image';
  if (isTex(path)) return 'file-text';
  return 'file';
}

function renderTabs() {
  const box = $('#tabs');
  const names = new Map();
  for (const t of S.tabs) names.set(base(t.path), (names.get(base(t.path)) || 0) + 1);
  box.replaceChildren(...S.tabs.map((t) => {
    const key = tabKey(t);
    const dup = names.get(base(t.path)) > 1;
    const el = h('div.tab' + (key === S.active ? '.on' : '') + (t.kind === 'text' && S.dirty.has(t.path) ? '.dirty' : ''), {
      title: t.path,
      onclick: () => activate(key),
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(key); } },
      oncontextmenu: (e) => { e.preventDefault(); menu(e.clientX, e.clientY, [
        { label: 'Close', icon: 'x', run: () => closeTab(key) },
        { label: 'Close others', run: () => { S.tabs.filter((x) => tabKey(x) !== key).forEach((x) => closeTab(tabKey(x))); } },
        { label: 'Close all', run: () => { [...S.tabs].forEach((x) => closeTab(tabKey(x))); } },
        '-', { label: 'Reveal in files', icon: 'folder-open', run: () => revealInTree(t.path) },
      ]); },
    }, icon(fileIconName(t.path, t.kind === 'ref' ? 'text' : t.kind)), h('span.tname', t.kind === 'diff' ? base(t.path) + ' (changes)' : t.kind === 'ref' ? base(t.path) + ` (${C.ref ? C.ref.name : 'other'})` : base(t.path)),
    dup ? h('span.tdir', dirname(t.path)) : null,
    h('button.tclose', { title: 'Close', onclick: (e) => { e.stopPropagation(); closeTab(key); } }, icon('x')));
    return el;
  }));
  const on = box.querySelector('.tab.on');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ------------------------------------------------------------------ previews and diffs
async function renderPreview(path, kind) {
  const host = $('#preview');
  const f = S.fileMap.get(path);
  if (!f) { host.replaceChildren(); return; }
  const url = '/raw/' + path.split('/').map(enc).join('/') + '?v=' + f.mtime;
  const meta = h('span.meta', fmtBytes(f.size));
  const canInsert = kind === 'image' || kind === 'pdf';
  const bar = h('div.preview-bar', icon(fileIconName(path, kind)), h('b', path), meta, h('div.spacer'),
    canInsert ? h('button.btn', { onclick: () => insertFigureFromTree(path) }, icon('image'), 'Insert as figure') : null,
    h('a.btn', { href: url, target: '_blank', rel: 'noopener' }, icon('external-link'), 'Open'));
  const stage = h('div.preview-stage');
  host.replaceChildren(bar, stage);
  if (kind === 'image') {
    const img = h('img', { src: url, alt: path, onload: () => { meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${fmtBytes(f.size)}`; } });
    stage.appendChild(img);
  } else if (kind === 'pdf') {
    try {
      const { canvas, info } = await renderPdfThumb(url, Math.max(300, stage.clientWidth - 60), Math.max(300, stage.clientHeight - 60));
      stage.appendChild(canvas);
      meta.textContent = `${Math.round(info.width)} × ${Math.round(info.height)} pt · ${info.pages} page${info.pages > 1 ? 's' : ''} · ${fmtBytes(f.size)}`;
    } catch (e) { stage.appendChild(h('p', 'Could not read this PDF.')); }
  } else {
    stage.appendChild(h('div.empty-card', icon('file'), h('p', 'Scriptorium does not open this kind of file.')));
  }
}

async function renderDiff(path) {
  const host = $('#diffHost');
  if (mergeView) { mergeView.destroy(); mergeView = null; }
  let head = '';
  try { head = (await api('/api/git/head?path=' + enc(path))).text; } catch (e) { /* new file */ }
  const cur = currentText(path) ?? (S.texts.get(path) || {}).text ?? '';
  const body = h('div.diff-body');
  host.replaceChildren(
    h('div.diff-bar', icon('git-compare'), h('b', path), h('span.meta', 'last commit on the left, the file now on the right'), h('div.spacer'),
      kindOf(path) === 'text' ? h('button.btn', { onclick: () => openFile(path) }, icon('file-pen-line'), 'Edit') : null),
    h('div.diff-cols', h('div', 'Last commit'), h('div', 'Now')), body);
  if (head === cur) { body.appendChild(h('div.empty', { style: { position: 'static', padding: '40px' } }, h('div.empty-card', icon('circle-check'), h('p', 'No changes since the last commit.')))); return; }
  mergeView = new MergeView({
    a: { doc: head, extensions: viewerExtensions(settings) },
    b: { doc: cur, extensions: viewerExtensions(settings) },
    parent: body, collapseUnchanged: { margin: 3, minSize: 6 }, highlightChanges: true, gutter: true,
  });
}

// ------------------------------------------------------------------ file tree
function buildTree() {
  const root = { name: '', path: '', kind: 'dir', kids: [] };
  const dirs = new Map([['', root]]);
  const ensure = (p) => {
    if (dirs.has(p)) return dirs.get(p);
    const parent = ensure(dirname(p));
    const n = { name: base(p), path: p, kind: 'dir', kids: [] };
    parent.kids.push(n);
    dirs.set(p, n);
    return n;
  };
  for (const f of S.files) {
    if (f.kind === 'dir') ensure(f.path);
    else ensure(dirname(f.path)).kids.push({ ...f, name: base(f.path) });
  }
  const sort = (n) => { n.kids.sort((a, b) => (a.kind === 'dir') - (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })); n.kids.forEach((k) => k.kind === 'dir' && sort(k)); };
  sort(root);
  return root;
}

const errCount = () => { const m = new Map(); for (const i of S.issues) if (i.kind === 'error' && i.file) m.set(i.file, (m.get(i.file) || 0) + 1); return m; };

function renderTree() {
  const box = $('#tree');
  if (!S.project) return;
  const git = new Map((S.git ? S.git.changes : []).map((c) => [c.path, c.status]));
  const errs = errCount();
  const rows = [];
  const walk = (n, depth) => {
    for (const k of n.kids) {
      if (k.kind === 'dir') {
        const open = S.openDirs.has(k.path);
        rows.push(h('div.row' + (open ? '.open' : ''), {
          style: { '--depth': depth }, dataset: { path: k.path, dir: '1' }, draggable: true,
          onclick: () => { if (open) S.openDirs.delete(k.path); else S.openDirs.add(k.path); persistDirs(); renderTree(); },
          oncontextmenu: (e) => treeMenu(e, k.path, true),
        }, h('span.twisty', icon('chevron-right')), h('span.row-icon', icon(open ? 'folder-open' : 'folder')), h('span.name', k.name)));
        if (open) walk(k, depth + 1);
      } else {
        const g = git.get(k.path);
        const ne = errs.get(k.path);
        rows.push(h('div.row' + (k.path === (activeTab() || {}).path ? '.on' : '') + (k.kind === 'other' ? '.dim' : ''), {
          style: { '--depth': depth }, dataset: { path: k.path }, draggable: true, title: k.path,
          onclick: () => openFile(k.path),
          oncontextmenu: (e) => treeMenu(e, k.path, false),
        }, h('span.twisty'), h('span.row-icon', icon(fileIconName(k.path, k.kind))), h('span.name', k.name),
        k.path === mainPath() ? h('span.tag.main', { title: 'Main document' }, 'main') : null,
        A.reviews.has(k.path) ? h('span.tag.review', { title: 'An agent changed this file: keep or undo' }, 'review') : null,
        ne ? h('span.errs', { title: `${ne} error${ne > 1 ? 's' : ''}` }, ne) : null,
        S.dirty.has(k.path) ? h('span.dirty', { title: 'Unsaved' }) : null,
        g ? h('span.git.git-' + g, { title: { M: 'Modified', U: 'New, not in git', A: 'Added', D: 'Deleted', R: 'Renamed' }[g] }, g) : null));
      }
    }
  };
  walk(buildTree(), 0);
  if (!rows.length) rows.push(h('div.side-empty', 'No files yet.'));
  box.replaceChildren(...rows);
}

function persistDirs() {
  const all = store.get('dirs', {});
  all[S.project.root] = [...S.openDirs];
  store.set('dirs', all);
}

function revealInTree(path) {
  let d = dirname(path);
  while (d) { S.openDirs.add(d); d = dirname(d); }
  persistDirs();
  showView('files');
  renderTree();
  const el = $(`#tree .row[data-path="${CSS.escape(path)}"]`);
  if (el) el.scrollIntoView({ block: 'center' });
}

function treeMenu(e, path, isDir) {
  e.preventDefault();
  const dir = isDir ? path : dirname(path);
  const k = kindOf(path);
  menu(e.clientX, e.clientY, [
    !isDir ? { label: 'Open', icon: 'file', run: () => openFile(path) } : null,
    !isDir && isTex(path) && path !== mainPath() ? { label: 'Set as main document', icon: 'house', run: () => setMain(path) } : null,
    !isDir && (k === 'image' || k === 'pdf') ? { label: 'Insert as figure', icon: 'image', run: () => insertFigureFromTree(path) } : null,
    !isDir && isTex(path) && path !== mainPath() ? { label: 'Insert \\input here', icon: 'file-down', run: () => insertAtCursor(`\\input{${relFromMain(path).replace(/\.tex$/, '')}}`) } : null,
    S.git && S.git.changes.some((c) => c.path === path) && !isDir ? { label: 'Show changes', icon: 'git-compare', run: () => openDiff(path) } : null,
    !isDir ? '-' : null,
    { label: 'New file here', icon: 'file-plus', run: () => newFile(dir) },
    { label: 'New folder here', icon: 'folder-plus', run: () => newDir(dir) },
    { label: 'Upload here', icon: 'upload', run: () => pickUpload(dir) },
    '-',
    { label: 'Rename…', icon: 'pencil', run: () => renamePath(path) },
    { label: 'Copy path', icon: 'copy', run: () => navigator.clipboard.writeText(path).then(() => toast('Copied ' + path)) },
    { label: 'Delete', icon: 'trash-2', danger: true, run: () => deletePath(path) },
  ]);
}

// drag and drop in the tree: move files, or upload from the desktop
function bindTreeDnD() {
  const tree = $('#tree');
  let dragPath = null;
  const targetDir = (e) => {
    const row = e.target.closest('.row');
    if (!row) return '';
    return row.dataset.dir ? row.dataset.path : dirname(row.dataset.path);
  };
  const mark = (e) => {
    $$('#tree .row.drop').forEach((r) => r.classList.remove('drop'));
    const d = targetDir(e);
    const row = d ? $(`#tree .row[data-path="${CSS.escape(d)}"]`) : null;
    if (row) row.classList.add('drop');
  };
  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    dragPath = row.dataset.path;
    e.dataTransfer.setData('text/plain', dragPath);
    e.dataTransfer.effectAllowed = 'move';
  });
  tree.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); mark(e); });
  tree.addEventListener('dragleave', () => $$('#tree .row.drop').forEach((r) => r.classList.remove('drop')));
  tree.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    $$('#tree .row.drop').forEach((r) => r.classList.remove('drop'));
    hideVeil();
    const dir = targetDir(e);
    if (e.dataTransfer.files.length) { await uploadFiles([...e.dataTransfer.files], dir); return; }
    if (dragPath) {
      const to = (dir ? dir + '/' : '') + base(dragPath);
      const from = dragPath;
      dragPath = null;
      if (to !== from && !to.startsWith(from + '/')) await movePath(from, to);
    }
  });
  tree.addEventListener('dragend', () => { dragPath = null; });
}

// ------------------------------------------------------------------ outline
function wcText(it) {
  const w = S.secWords && S.secWords.get(it.file + ':' + it.line);
  return w == null ? '' : w >= 1000 ? (w / 1000).toFixed(1) + 'k' : String(w);
}

function renderOutline() {
  const box = $('#outline');
  if (!S.outline.length) { box.replaceChildren(h('div.outline-empty', has(mainPath()) ? 'No sections yet.' : `The main document ${mainPath()} is missing.`)); return; }
  const secs = S.outline.filter((i) => i.kind === 'section');
  const top = Math.min(...secs.map((i) => i.level), 9);
  box.replaceChildren(...S.outline.map((it, idx) => {
    const depth = it.kind === 'float' ? Math.max(0, lastLevel(idx) - top + 1) : it.level - top;
    return h('div.orow' + (it.kind === 'float' ? '.float' : '.l' + Math.max(0, it.level - top)), {
      style: { '--depth': Math.max(0, depth) }, dataset: { idx },
      title: `${it.file}:${it.line}`,
      onclick: () => openFile(it.file, { pos: it.pos, flash: true }),
    }, it.kind === 'float' ? icon(it.type === 'table' ? 'list' : 'image') : h('span.num', it.num || ''), h('span.t', it.title || '(untitled)'),
    it.kind === 'section' ? h('span.wc', { dataset: { key: it.file + ':' + it.line }, title: 'Words in this section' }, wcText(it)) : null);
  }));
  markOutline();
  function lastLevel(i) { for (let k = i; k >= 0; k--) if (S.outline[k].kind === 'section') return S.outline[k].level; return top; }
}

function markOutline() {
  const t = activeTab();
  let cur = -1;
  if (t && t.kind === 'text') {
    const head = editor.view.state.selection.main.head;
    S.outline.forEach((it, i) => { if (it.kind === 'section' && it.file === t.path && it.pos <= head) cur = i; });
    if (cur < 0) {
      const first = S.outline.findIndex((it) => it.file === t.path);
      if (first > 0) for (let k = first - 1; k >= 0; k--) if (S.outline[k].kind === 'section') { cur = k; break; }
    }
  }
  $$('#outline .orow').forEach((el) => el.classList.toggle('on', +el.dataset.idx === cur));
  const on = $('#outline .orow.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------ cursor, status bar, words
const cursorMoved = debounce(() => {
  const t = activeTab();
  if (t && t.kind === 'text') {
    const st = editor.view.state;
    const sel = st.selection.main;
    const ln = st.doc.lineAt(sel.head);
    const n = Math.abs(sel.to - sel.from);
    $('#sbPos').textContent = `Ln ${ln.number}, Col ${sel.head - ln.from + 1}` + (n ? ` · ${n} selected` : '');
    if (settings.followCursor) followSoon();
    rememberCursor();
    pushContext();
  } else $('#sbPos').textContent = '';
  markOutline();
}, 60);

const rememberCursor = debounce(() => {
  const t = activeTab();
  if (!t || t.kind !== 'text' || !S.project) return;
  const all = store.get('cursor', {});
  const mine = all[S.project.root] || {};
  delete mine[t.path];
  mine[t.path] = [editor.view.state.selection.main.head, Math.round(editor.view.scrollDOM.scrollTop)];
  const keys = Object.keys(mine);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete mine[k];
  all[S.project.root] = mine;
  store.set('cursor', all);
}, 800);

const wordsSoon = debounce(() => {
  if (!S.project || !has(mainPath())) { $('#sbWords').textContent = ''; return; }
  const { rows, total } = wordsBySection(mainPath(), S.scans, textsView, has);
  $('#sbWords').textContent = total.toLocaleString() + ' words';
  // each section's words including its subsections, beside it in the outline
  S.secWords = new Map();
  rows.forEach((r, i) => {
    let w = r.words;
    for (let k = i + 1; k < rows.length && rows[k].level > r.level; k++) w += rows[k].words;
    S.secWords.set(r.file + ':' + r.line, w);
  });
  for (const el of $$('#outline .orow .wc')) {
    const w = S.secWords.get(el.dataset.key);
    el.textContent = w == null ? '' : w >= 1000 ? (w / 1000).toFixed(1) + 'k' : String(w);
  }
}, 1200);

function renderStatus() {
  if (!S.project) return;
  $('#sbMain').lastChild.textContent = mainPath() || '';
  $('#sbSpell').textContent = settings.spell ? 'Spelling: ' + settings.spellLang : 'Spelling off';
  const b = $('#sbBranch');
  if (S.git) { b.hidden = false; b.lastChild.textContent = S.git.branch; } else b.hidden = true;
}

// ------------------------------------------------------------------ problems drawer
function renderProblems() {
  const counts = { error: 0, warning: 0, box: 0 };
  for (const i of S.issues) counts[i.kind] = (counts[i.kind] || 0) + 1;
  $('#nErr').textContent = counts.error;
  $('#nWarn').textContent = counts.warning;
  $('#nBox').textContent = counts.box;
  $('#sbErr').textContent = counts.error;
  $('#sbWarn').textContent = counts.warning;
  $('#sbProblems').classList.toggle('has-err', counts.error > 0);
  const list = S.issues.filter((i) => S.kinds.has(i.kind));
  $('#probCount').textContent = list.length;
  const box = $('#problems');
  if (!S.lastCompile) { box.replaceChildren(h('div.none', 'Compile to see errors and warnings here.')); }
  else if (!list.length) box.replaceChildren(h('div.none', icon('circle-check'), counts.box && !S.kinds.has('box') ? `No errors or warnings. ${counts.box} box warnings are hidden.` : 'No errors or warnings.'));
  else {
    const order = { error: 0, warning: 1, box: 2 };
    box.replaceChildren(...[...list].sort((a, b) => order[a.kind] - order[b.kind]).map((i) => {
      const ctx = i.context ? h('div.ctx', h('span', i.context[0]), h('b', ' ⟵ '), h('span', i.context[1])) : null;
      return h('div.prob.' + i.kind, { onclick: () => i.file && has(i.file) && openFile(i.file, { line: i.line || 1, flash: true }) },
        icon(i.kind === 'error' ? 'circle-x' : i.kind === 'warning' ? 'triangle-alert' : 'text-cursor-input'),
        h('span.msg', i.msg), h('span.where', i.file ? `${i.file}${i.line ? ':' + i.line : ''}` : ''),
        ctx, i.hint ? h('div.src', i.hint) : null);
    }));
  }
  $('#log').textContent = S.lastCompile ? S.lastCompile.log : '';
}

function toggleDrawer(force) {
  S.drawer = force ?? !S.drawer;
  S.drawerAuto = false;
  $('#drawer').hidden = !S.drawer;
}

// ------------------------------------------------------------------ search across files
S.searchOpts = store.get('searchOpts', { case: false, word: false, regex: false });
function syncSearchToggles() {
  $('#searchCase').classList.toggle('on', S.searchOpts.case);
  $('#searchWord').classList.toggle('on', S.searchOpts.word);
  $('#searchRegex').classList.toggle('on', S.searchOpts.regex);
  store.set('searchOpts', S.searchOpts);
}
function searchRegex() {
  const q = $('#searchInput').value;
  if (!q) return null;
  let src = S.searchOpts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (S.searchOpts.word) src = '\\b' + src + '\\b';
  try { return new RegExp(src, 'g' + (S.searchOpts.case ? '' : 'i') + 'm'); } catch (e) { return 'bad'; }
}
const runSearch = debounce(() => {
  const re = searchRegex();
  const box = $('#searchResults');
  const sum = $('#searchSummary');
  if (!re) { box.replaceChildren(); sum.textContent = ''; return; }
  if (re === 'bad') { sum.textContent = 'That regular expression does not parse.'; box.replaceChildren(); return; }
  const groups = [];
  let total = 0;
  for (const f of S.files) {
    if (f.kind !== 'text') continue;
    const text = currentText(f.path);
    if (text == null) continue;
    const hits = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) && total < 3000) {
      if (m[0] === '') { re.lastIndex++; continue; }
      hits.push({ from: m.index, to: m.index + m[0].length });
      total++;
    }
    if (hits.length) groups.push({ path: f.path, text, hits });
  }
  sum.textContent = total ? `${total}${total >= 3000 ? '+' : ''} result${total > 1 ? 's' : ''} in ${groups.length} file${groups.length > 1 ? 's' : ''}` : 'No results';
  const rows = [];
  for (const g of groups) {
    rows.push(h('div.sfile', { onclick: () => openFile(g.path) }, icon(fileIconName(g.path, 'text')), h('span', g.path), h('span.n', g.hits.length)));
    for (const hit of g.hits.slice(0, 200)) {
      const ls = g.text.lastIndexOf('\n', hit.from - 1) + 1;
      let le = g.text.indexOf('\n', hit.to);
      if (le < 0) le = g.text.length;
      const line = g.text.slice(0, ls).split('\n').length;
      const a = Math.max(ls, hit.from - 14);
      const pre = (a > ls ? '…' : '') + g.text.slice(a, hit.from);
      rows.push(h('div.shit', { onclick: () => openFile(g.path, { pos: hit.from, flash: false }).then(() => { const v = editor.view; v.dispatch({ selection: { anchor: hit.from, head: hit.to }, effects: EditorView.scrollIntoView(hit.from, { y: 'center' }) }); }) },
        h('span.ln', line), h('span.tx', { html: esc(pre) + '<mark>' + esc(g.text.slice(hit.from, hit.to)) + '</mark>' + esc(g.text.slice(hit.to, Math.min(le, hit.to + 80))) })));
    }
  }
  box.replaceChildren(...rows);
}, 180);

async function replaceAll() {
  const re = searchRegex();
  if (!re || re === 'bad') return;
  const rep = $('#replaceInput').value;
  const plan = [];
  let n = 0;
  for (const f of S.files) {
    if (f.kind !== 'text') continue;
    const text = currentText(f.path);
    if (text == null) continue;
    re.lastIndex = 0;
    const c = (text.match(re) || []).length;
    if (c) { plan.push(f.path); n += c; }
  }
  if (!n) return;
  if (!(await confirmDialog({ title: 'Replace in the project', message: `Replace ${n} match${n > 1 ? 'es' : ''} in ${plan.length} file${plan.length > 1 ? 's' : ''}? Each file can be undone with Ctrl+Z.`, okText: 'Replace all' }))) return;
  for (const p of plan) {
    if (!S.texts.has(p)) S.texts.set(p, await api('/api/file?path=' + enc(p)));
    const st = stateFor(p);
    const text = textOfState(st);
    re.lastIndex = 0;
    const changes = [];
    let m;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      changes.push({ from: m.index, to: m.index + m[0].length, insert: S.searchOpts.regex ? m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), rep) : rep });
    }
    if (S.active === p && editor.view.state === st) editor.view.dispatch({ changes });
    else { S.states.set(p, st.update({ changes }).state); updateDirty(p); }
  }
  await saveAll();
  runSearch();
  toast(`Replaced ${n} in ${plan.length} file${plan.length > 1 ? 's' : ''}`);
}

// ------------------------------------------------------------------ git
const gitSoon = debounce(() => refreshGit(), 1200);
async function refreshGit() {
  try { S.git = await api('/api/git'); } catch (e) { S.git = null; }
  const head = S.git && S.git.log[0] ? S.git.log[0].hash : null;
  if (head !== S.gitHead) { S.gitHead = head; S.heads.clear(); }
  const at = activeTab();
  if (at && at.kind === 'text') loadGitBase(at.path);
  const badge = $('#gitBadge');
  const n = S.git ? S.git.changes.length : 0;
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : n;
  renderStatus();
  renderTree();
  if (S.view === 'git') renderGit();
}

function renderGit() {
  const box = $('#gitBody');
  $('#gitBranch').textContent = '';
  if (!S.git) { box.replaceChildren(h('div.side-empty', 'This folder is not in a git repository, so there is nothing to commit.')); return; }
  const g = S.git;
  const added = g.changes.filter((c) => c.status === 'U').length;
  const edited = g.changes.length - added;
  const what = [edited ? `${edited} change${edited > 1 ? 's' : ''}` : '', added ? `${added} new file${added > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  const msg = h('textarea', { placeholder: 'What changed? (commit message)', spellcheck: 'true' });
  const btn = h('button.btn.primary', {
    disabled: !g.changes.length,
    onclick: async () => {
      const m = msg.value.trim();
      if (!m) { msg.focus(); toast('Write a short message first', 'warn'); return; }
      if (added && !(await confirmDialog({
        title: 'Commit new files',
        message: `This commits ${what} into the git repository "${g.repo}" (${g.repo_path}), branch ${g.branch}. ${g.remote ? 'It stays local until you push.' : 'That repository has no remote, so it stays on this machine.'}`,
        okText: 'Commit',
      }))) return;
      await saveAll();
      btn.disabled = true;
      const r = await api('/api/git/commit', { message: m }, { allow: [400] });
      if (r.data && r.data.ok) { toast('Committed'); msg.value = ''; S.heads.clear(); const t = activeTab(); if (t && t.kind === 'text') loadGitBase(t.path); } else toast('Commit failed: ' + ((r.data && (r.data.output || r.data.error)) || ''), 'error', 6000);
      refreshGit();
    },
  }, icon('git-commit-horizontal'), g.changes.length ? 'Commit ' + what : 'Nothing to commit');
  msg.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); btn.click(); } });
  const changes = S.git.changes.map((c) => h('div.row', { style: { '--depth': 0 }, title: c.path, onclick: () => (c.status === 'D' ? toast('Deleted file') : openDiff(c.path)) },
    h('span.row-icon', icon(fileIconName(c.path, kindOf(c.path) || 'text'))), h('span.name', c.path), h('span.git.git-' + c.status, c.status)));
  const log = S.git.log.map((c) => h('div.crow', { title: `${c.hash} · ${c.author}` }, h('span.h', c.hash), h('span.s', c.subject), h('span.w', c.when.replace(/ ago$/, ''))));
  const where = h('div.git-where', icon('git-branch'), h('span', h('b', g.repo), ' · ', g.branch), h('span.p', g.repo_path + (g.remote ? '' : ' · no remote')));
  const notice = !g.tracked
    ? h('div.git-notice', icon('info'), h('span', `This folder is not in git yet. Its files are new to "${g.repo}", and committing adds them there.`))
    : null;
  box.replaceChildren(
    ...[where, notice].filter(Boolean),
    h('div.commit-box', msg, btn),
    h('div.git-section', h('h4', 'Changed files'), ...(changes.length ? changes : [h('div.side-empty', 'Everything is committed.')])),
    h('div.git-section', h('h4', 'History'), ...(log.length ? log : [h('div.side-empty', 'No commits yet.')])));
}

function openDiff(path) {
  addTab({ path, kind: 'diff' });
  activate('diff:' + path);
}

// ------------------------------------------------------------------ file operations
async function refreshProject() {
  const p = await api('/api/project');
  S.project = p;
  S.files = p.files;
  S.fileMap = new Map(p.files.map((f) => [f.path, f]));
  for (const k of [...S.texts.keys()]) if (!S.fileMap.has(k)) { S.texts.delete(k); S.scans.delete(k); S.bibs.delete(k); }
  for (const f of p.files) if (f.kind === 'text' && !S.texts.has(f.path) && (isTex(f.path) || /\.bib$/.test(f.path))) {
    try { S.texts.set(f.path, await api('/api/file?path=' + enc(f.path))); rescan(f.path); } catch (e) { /* unreadable */ }
  }
  S.tabs = S.tabs.filter((t) => S.fileMap.has(t.path) || t.kind === 'diff' || t.kind === 'ref');
  if (S.active && !S.tabs.some((t) => tabKey(t) === S.active)) activate(S.tabs[0] ? tabKey(S.tabs[0]) : null);
  rebuildIndex();
  renderTree();
  renderTabs();
  renderStatus();
  gitSoon();
}

const validName = (v) => (!v ? 'Type a name' : /(^|\/)\.\.(\/|$)/.test(v) || v.startsWith('/') ? 'Stay inside the project' : has(v) ? 'That name is taken' : null);

async function newFile(dir) {
  const v = await promptDialog({ title: 'New file', label: 'Name, with a folder if you like (for example Sections/method.tex).', value: (dir ? dir + '/' : '') + 'untitled.tex', okText: 'Create', validate: validName, selectStem: true });
  if (!v) return;
  const text = /\.tex$/.test(v) && !/main/.test(v) ? `\\section{${base(v).replace(/\.tex$/, '').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase())}}\n\n` : '';
  try {
    await api('/api/new', { path: v, kind: 'file', text });
    await refreshProject();
    revealInTree(v);
    await openFile(v, { line: 3 });
  } catch (e) { toast(e.message, 'error'); }
}
async function newDir(dir) {
  const v = await promptDialog({ title: 'New folder', value: (dir ? dir + '/' : '') + 'folder', okText: 'Create', validate: validName, selectStem: true });
  if (!v) return;
  try { await api('/api/new', { path: v, kind: 'dir' }); S.openDirs.add(v); persistDirs(); await refreshProject(); } catch (e) { toast(e.message, 'error'); }
}
async function renamePath(path) {
  const v = await promptDialog({ title: 'Rename', label: 'New name. Change the folder part to move it.', value: path, okText: 'Rename', validate: (x) => (x === path ? 'Type a different name' : validName(x)), selectStem: true });
  if (v) await movePath(path, v);
}
async function movePath(from, to) {
  if (S.dirty.has(from)) await saveFile(from);
  try { await api('/api/rename', { from, to }); } catch (e) { toast(e.message, 'error'); return; }
  const remap = (p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  for (const m of [S.texts, S.saved, S.scans, S.bibs, S.scroll]) for (const k of [...m.keys()]) { const n = remap(k); if (n !== k) { m.set(n, m.get(k)); m.delete(k); } }
  for (const k of [...S.states.keys()]) {
    const n = remap(k);
    if (n === k) continue;
    const old = S.states.get(k);
    S.states.delete(k);
    S.states.set(n, editor.makeState(textOfState(old), n));
    S.saved.set(n, S.states.get(n).doc);
  }
  S.tabs = S.tabs.map((t) => ({ ...t, path: remap(t.path) }));
  if (S.active) S.active = S.active.startsWith('diff:') ? 'diff:' + remap(S.active.slice(5)) : remap(S.active);
  const wasActive = S.active;
  S.active = null;
  await refreshProject();
  activate(wasActive);
  toast(`Renamed to ${to}`);
}
async function deletePath(path) {
  const isDir = kindOf(path) === 'dir';
  if (!(await confirmDialog({ title: 'Delete', message: `Move ${path}${isDir ? ' and everything in it' : ''} to the Scriptorium trash? You can get it back from there.`, okText: 'Delete', danger: true }))) return;
  try {
    const r = await api('/api/delete', { path });
    for (const t of [...S.tabs]) if (t.path === path || t.path.startsWith(path + '/')) closeTab(tabKey(t));
    for (const m of [S.texts, S.saved, S.states, S.scans, S.bibs]) for (const k of [...m.keys()]) if (k === path || k.startsWith(path + '/')) m.delete(k);
    S.dirty.delete(path);
    await refreshProject();
    toast(`Moved ${base(path)} to the trash: ${r.trash}`, 'info', 6000);
  } catch (e) { toast(e.message, 'error'); }
}

async function uploadOne(file, path) {
  let r = await fetch('/api/upload?path=' + enc(path), { method: 'POST', headers: { 'X-Scriptorium': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  if (r.status === 409) {
    if (!(await confirmDialog({ title: 'Replace file', message: `${path} already exists. Replace it?`, okText: 'Replace' }))) return null;
    r = await fetch('/api/upload?overwrite=1&path=' + enc(path), { method: 'POST', headers: { 'X-Scriptorium': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  }
  if (!r.ok) { toast('Upload failed: ' + path, 'error'); return null; }
  return path;
}
async function uploadFiles(files, dir) {
  const done = [];
  for (const f of files) { const p = await uploadOne(f, (dir ? dir + '/' : '') + f.name); if (p) done.push(p); }
  if (done.length) {
    if (dir) S.openDirs.add(dir);
    await refreshProject();
    toast(done.length === 1 ? `Added ${done[0]}` : `Added ${done.length} files`);
  }
  return done;
}
function pickUpload(dir) {
  const inp = $('#fileInput');
  inp.value = '';
  inp.onchange = () => uploadFiles([...inp.files], dir);
  inp.click();
}

function figuresDir() {
  const md = mainDir();
  for (const d of ['Figures', 'figures', 'images', 'img', 'figs', 'fig', 'graphics']) {
    const p = joinPath(md, d);
    if (kindOf(p) === 'dir') return p;
  }
  for (const d of graphicsDirs()) if (d && kindOf(joinPath(md, d.replace(/\/$/, ''))) === 'dir') return joinPath(md, d.replace(/\/$/, ''));
  return joinPath(md, 'figures');
}

function figureSnippet(imgPath) {
  const rel = relFromMain(imgPath);
  const slug = base(imgPath).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'figure';
  return `\\begin{figure}[t]\n\t\\centering\n\t\\includegraphics[width=\\linewidth]{${rel}}\n\t\\caption{\${}}\n\t\\label{fig:${slug}}\n\\end{figure}\n`;
}

// ------------------------------------------------------------------ symbols and tables
async function ensureTexEditor() {
  const t = activeTab();
  if (t && t.kind === 'text' && isTex(t.path)) return true;
  const target = lastTexTab();
  if (!has(target)) { toast('Open a .tex file first', 'warn'); return false; }
  await openFile(target);
  return true;
}

async function insertSymbol(tpl) {
  if (!(await ensureTexEditor())) return;
  const v = editor.view;
  const sel = v.state.selection.main;
  const r = regionAt(regionsOf(v.state), sel.head);
  const inMath = r && !r.verbatim && sel.head > r.from && sel.head < r.to;
  let t = tpl;
  // put the selected text in the first field
  if (!sel.empty && t.includes('${')) {
    // keep the selection literal inside the snippet: protect \{ \} and ${ #{
    const lit = v.state.sliceDoc(sel.from, sel.to).replace(/\\([{}])/g, '\\\\$1').replace(/([$#])\{/g, '$1\\{');
    t = t.replace(/\$\{[^}]*\}/, () => lit);
  }
  if (!inMath) t = t.includes('\n') ? '\\[\n\t' + t.replace(/\n/g, '\n\t') + '\n\\]' : '$' + t + '$';
  else if (/\\[a-zA-Z]+$/.test(t) && /[a-zA-Z]/.test(v.state.sliceDoc(sel.to, sel.to + 1))) t += ' ';  // \beta x, not \betax
  if (!t.includes('${')) {
    v.dispatch({ changes: { from: sel.from, to: sel.to, insert: t }, selection: { anchor: sel.from + t.length } });
  } else snippet(t)(v, null, sel.from, sel.to);
  v.focus();
}

async function insertTable() {
  const v0 = await promptDialog({
    title: 'Insert a table', okText: 'Insert', value: '3x4',
    label: 'Columns × rows of data, for example 3x4. A header row comes on top.',
    validate: (x) => (/^\s*\d+\s*[x×*]\s*\d+\s*$/i.test(x) ? null : 'Write it like 3x4'),
  });
  if (!v0 || !(await ensureTexEditor())) return;
  const [c, r] = v0.split(/[x×*]/i).map((n) => Math.max(1, Math.min(20, parseInt(n, 10))));
  const booktabs = /\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bbooktabs\b/.test(currentText(mainPath()) || '');
  const [top, mid, bot] = booktabs ? ['\\toprule', '\\midrule', '\\bottomrule'] : ['\\hline', '\\hline', '\\hline'];
  const head = Array.from({ length: c }, () => '${}').join(' & ') + ' \\\\';
  const row = Array.from({ length: c }, () => '').join(' & ').trim() + ' \\\\';
  const tpl = ['\\begin{table}[t]', '\t\\centering', '\t\\caption{${}}', '\t\\label{tab:${}}',
    `\t\\begin{tabular}{l${'c'.repeat(c - 1)}}`, '\t\t' + top, '\t\t' + head, '\t\t' + mid,
    ...Array.from({ length: r }, () => '\t\t' + row), '\t\t' + bot, '\t\\end{tabular}', '\\end{table}', ''].join('\n');
  const v = editor.view;
  insertSnippetAt(v, v.state.selection.main.head, tpl);
  if (!booktabs) toast('Tip: \\usepackage{booktabs} gives nicer table rules', 'info', 4000);
}

// ------------------------------------------------------------------ references from a DOI or arXiv
function targetBib() {
  const sc = S.scans.get(mainPath());
  for (const b of (sc ? sc.bibs : [])) { const p = resolveInput(b.path, mainDir(), has, ['.bib', '']); if (p) return p; }
  const any = S.files.find((f) => /\.bib$/i.test(f.path));
  return any ? any.path : joinPath(mainDir(), 'references.bib');
}

function insertCite(key) {
  const v = editor.view;
  const pos = v.state.selection.main.head;
  const before = v.state.sliceDoc(Math.max(0, pos - 300), pos);
  const inside = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(\[[^\]]*\])*\{[^{}]*$/.test(before);
  let text;
  if (inside) text = /[{,]\s*$/.test(before) ? key : ',' + key;
  else {
    const after = v.state.sliceDoc(pos, pos + 1);
    text = (/\S$/.test(before) && !/~$/.test(before) ? '~' : '') + `\\cite{${key}}` + (/[\p{L}\p{N}]/u.test(after) ? ' ' : '');
  }
  v.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
  v.focus();
}

async function addReference() {
  const target = targetBib();
  const id = await promptDialog({
    title: 'Add a reference', okText: 'Add',
    label: `Paste a DOI (10.1038/…), a doi.org link, an arXiv identifier or an arXiv link. The entry goes into ${target}${activeKind() === 'text' && isTex(S.active) ? ' and \\cite goes at the cursor' : ''}.`,
    placeholder: '10.1038/nature14539  or  2401.12345',
    validate: (v) => (v ? null : 'Paste an identifier'),
  });
  if (!id) return;
  const wait = toast('Looking it up…', 'info', 30000);
  let r;
  try { r = await api('/api/reference', { id, keys: [...S.bib.keys()] }); } catch (e) { wait.remove(); toast(e.message, 'error', 7000); return; }
  wait.remove();
  const writing = activeKind() === 'text' && isTex(S.active) ? S.active : null;
  if (!has(target)) { await api('/api/new', { path: target, kind: 'file', text: '' }); await refreshProject(); }
  if (!S.texts.has(target)) S.texts.set(target, await api('/api/file?path=' + enc(target)));
  const st = stateFor(target);
  const text = textOfState(st);
  const insert = (text.trim() ? (text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n') : '') + r.bibtex;
  const tr = { changes: { from: st.doc.length, insert } };
  if (S.active === target && editor.view.state === st) editor.view.dispatch(tr);
  else { S.states.set(target, st.update(tr).state); updateDirty(target); }
  await saveFile(target);
  rescan(target);
  rebuildIndex();
  if (writing && S.active === writing) insertCite(r.key);
  forceLinting(editor.view);
  toast(`Added ${r.key} to ${target}`);
}

// ------------------------------------------------------------------ the Assistant: the user's own agent, through the door
// Scriptorium runs no model. An agent (Claude Code, Codex, any MCP client or script) connects to the door with the
// token, waits for the messages written here, answers, and edits files. Its edits show as changes to keep or undo.
const A = { chat: [], agents: [], since: 0, door: null, reviews: new Map(), unread: 0, loop: false };

async function startAssistant() {
  try {
    const r = await api('/api/chat');
    A.chat = r.chat;
    A.agents = r.agents;
    A.since = r.last;
    A.door = r.door;
  } catch (e) { return; }
  renderAssistant();
  if (!A.loop) { A.loop = true; assistantLoop(); }
}

async function assistantLoop() {
  for (;;) {
    try {
      const r = await api(`/api/chat/events?since=${A.since}&timeout=20`);
      A.agents = r.agents;
      for (const e of r.events) { A.since = Math.max(A.since, e.id); await assistantEvent(e); }
      renderPresence();
    } catch (e) {
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

async function assistantEvent(e) {
  if (e.type === 'chat') {
    A.chat.push(e.message);
    appendMessage(e.message);
    if (e.message.role !== 'user' && !assistantVisible()) {
      A.unread++;
      const b = $('#asstBadge');
      b.hidden = false;
      b.textContent = A.unread;
      if (e.message.role === 'agent') toast(`${e.message.agent}: ${e.message.text.split('\n')[0].slice(0, 90)}`, 'info', 4500);
    }
  } else if (e.type === 'taken') {
    const m = A.chat.find((x) => x.mid === e.mid);
    if (m) { m.taken_by = e.agent; const el = $(`#asstBody .msg[data-mid="${e.mid}"] .seen`); if (el) el.textContent = `read by ${e.agent}`; }
  } else if (e.type === 'presence' && e.joined) {
    toast(`${e.joined} connected to Scriptorium`);
  } else if (e.type === 'edit') {
    await agentEdited(e);
  } else if (e.type === 'compiled') {
    await applyCompileResult(e.result);
  } else if (e.type === 'show') {
    if (has(e.path)) { await openFile(e.path, { line: e.line, flash: true }); syncToPdf(true); }
  } else if (e.type === 'cleared') {
    A.chat = [];
    renderAssistant();
  }
}

function assistantVisible() { return S.view === 'assistant' && !$('#sidebar').classList.contains('collapsed'); }

// An agent changed a file: load the new text and show the change for review (keep or undo).
async function agentEdited(e) {
  if (!A.reviews.has(e.path)) A.reviews.set(e.path, { base: e.before, agent: e.agent, note: e.note });
  else if (e.note) A.reviews.get(e.path).note = e.note;
  if (e.created || !S.fileMap.has(e.path)) await refreshProject();
  if (S.texts.has(e.path)) await diskChanged(e.path);
  const t = activeTab();
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.cm-content');
  if (t && t.kind === 'text' && t.path === e.path) applyCompare(e.path);
  else if (!typing) await openFile(e.path, { line: e.line, flash: true, focus: false });
  renderTree();
  renderReviews();
}

function applyUserText(path, text) {
  const st = S.states.get(path);
  if (!st) return;
  const old = textOfState(st);
  if (old === text) return;
  const tr = { changes: { from: 0, to: old.length, insert: text } };
  if (S.active === path && editor.view.state === st) editor.view.dispatch(tr);
  else { S.states.set(path, st.update(tr).state); updateDirty(path); autosave(); }
}

async function finishReview(path, how) {
  const rv = A.reviews.get(path);
  if (!rv) return;
  if (how === 'undo') {
    if (!S.states.has(path)) await openFile(path, { focus: false });
    A.reviews.delete(path);
    applyUserText(path, rv.base);
    toast(`Undid ${rv.agent}'s changes in ${base(path)} (Ctrl+Z brings them back)`);
  } else {
    A.reviews.delete(path);
    toast(`Kept ${rv.agent}'s changes in ${base(path)}`);
  }
  const t = activeTab();
  if (t && t.kind === 'text' && t.path === path) { applyCompare(path); loadGitBase(path); }
  renderTree();
  renderReviews();
}

// What the user is looking at, sent with each message and kept fresh for the agent's get_context.
function currentContext() {
  const c = { open_tabs: S.tabs.filter((x) => x.kind === 'text').map((x) => x.path) };
  const t = activeTab();
  if (t && t.kind === 'text') {
    const st = editor.view.state;
    const sel = st.selection.main;
    const ln = st.doc.lineAt(sel.head);
    c.file = t.path;
    c.line = ln.number;
    c.column = sel.head - ln.from + 1;
    if (!sel.empty) {
      c.selection = st.sliceDoc(sel.from, sel.to).slice(0, 8000);
      c.selection_lines = [st.doc.lineAt(sel.from).number, st.doc.lineAt(sel.to).number];
    }
  }
  const errs = S.issues.filter((i) => i.kind === 'error').slice(0, 12).map((i) => `${i.file || '?'}:${i.line || '?'}: ${i.msg}`);
  if (errs.length) c.compile_errors = errs;
  if (C.ref) c.comparing_with = C.ref.root;
  return c;
}
const pushContext = debounce(() => { if (S.project) api('/api/chat/context', { context: currentContext() }).catch(() => {}); renderCtxChip(); }, 600);

function renderCtxChip() {
  const box = $('#asstCtx');
  if (!box) return;
  const c = currentContext();
  box.replaceChildren(...(c.file ? [icon('file-text'), h('span', c.selection ? `${base(c.file)}: lines ${c.selection_lines[0]}–${c.selection_lines[1]} selected` : `${base(c.file)}, line ${c.line}`)] : [h('span', 'No file open')]),
    h('span.muted', ' · sent with your message'));
}

async function sendChat() {
  const ta = $('#chatInput');
  const text = ta.value.trim();
  if (!text) return;
  ta.value = '';
  autosizeChat();
  await saveAll();  // the agent reads files from disk: give it what is on screen
  try { await api('/api/chat/send', { text, context: currentContext() }); }
  catch (e) { ta.value = text; toast('Not sent: ' + e.message, 'error'); }
}

function autosizeChat() {
  const ta = $('#chatInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(200, ta.scrollHeight + 2) + 'px';
}

function agentState() {
  const a = A.agents[0];
  if (!a) return null;
  return { name: a.name, text: a.waiting ? 'listening' : a.status ? a.status : a.seen < 90 ? 'working…' : 'connected', busy: !a.waiting, more: A.agents.length - 1 };
}

function renderPresence() {
  const st = agentState();
  const who = $('#asstWho');
  const pres = $('#asstPresence');
  if (!who) return;
  who.textContent = st ? st.name : '';
  pres.replaceChildren(st
    ? h('span.pres' + (st.busy ? '.busy' : '.on'), h('span.dot'), h('b', st.name), ' ', st.text, st.busy ? h('span.dots', h('i'), h('i'), h('i')) : null, st.more > 0 ? ` (+${st.more} more)` : '')
    : h('span.pres.off', h('span.dot'), 'No agent connected. ', h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); showConnect(); } }, 'Connect one')));
}

function connectCard() {
  const d = A.door || {};
  const snip = (label, text, sub) => h('div.snip', h('div.snip-l', label), sub ? h('div.snip-s', sub) : null,
    h('div.snip-b', h('code', text), h('button.mini', { title: 'Copy', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied')) }, icon('copy'))));
  return h('div.connect',
    h('div.t', icon('plug'), 'Connect your AI agent'),
    h('p', 'Scriptorium does not run a model or need an API key. Your own agent connects to it here, on this computer, with its own login. It then sees what you are looking at, answers here and edits the document. You keep or undo every change.'),
    snip('Claude Code: run once in a terminal', `claude mcp add --transport http --scope user scriptorium "${d.mcp}"`),
    snip('Codex, Cursor and other MCP apps: add this server URL', d.mcp || '', 'MCP over streamable HTTP'),
    snip('Any agent with a terminal: paste this to it', `Read the instructions at ${d.manual} (use curl) and follow them to work with me in Scriptorium.`),
    h('p.after', 'Then tell your agent: ', h('b', '“Listen to me in Scriptorium.”'), ' It waits for what you write below, and works on the document you have open.'),
    h('p.after.muted', 'The address contains a private key for this computer. Share it only with your own agents.'));
}

function showConnect() {
  showView('assistant');
  const body = $('#asstBody');
  const card = connectCard();
  body.prepend(card);
  card.scrollIntoView({ block: 'start' });
}

function messageEl(m) {
  if (m.role === 'user') {
    const c = m.context || {};
    const where = c.file ? (c.selection ? `${base(c.file)}: lines ${c.selection_lines ? c.selection_lines.join('–') : ''} selected` : `${base(c.file)}, line ${c.line}`) : '';
    return h('div.msg.user', { dataset: { mid: m.mid } }, h('div.bubble', m.text),
      h('div.meta', where ? h('span', where) : null, h('span.seen', m.taken_by ? `read by ${m.taken_by}` : 'waiting for an agent')));
  }
  if (m.role === 'activity') {
    const ic = { edit: 'pencil-line', compile: 'play', show: 'crosshair' }[m.kind] || 'circle-dot';
    const pending = m.kind === 'edit' && m.path && A.reviews.has(m.path);
    return h('div.msg.act' + (pending ? '.pending' : ''), { dataset: m.kind === 'edit' && m.path ? { mid: m.mid, path: m.path } : { mid: m.mid } },
      icon(ic), h('span.what', h('b', m.agent), ' ', m.text.replace(/^./, (x) => x.toLowerCase())),
      m.kind === 'edit' ? h('span.tag', 'to review') : null,
      m.path && has(m.path) ? h('button.mini.go', { title: 'Open', onclick: () => openFile(m.path, { line: m.line || 1, flash: true }) }, icon('arrow-right')) : null);
  }
  const body = h('div.bubble.md');
  body.innerHTML = markdown(m.text);
  for (const a of body.querySelectorAll('code')) {
    // a file:line in an answer opens it
    const mm = /^([\w./-]+\.(?:tex|bib|sty|cls)):(\d+)$/.exec(a.textContent);
    if (mm && has(mm[1])) { a.classList.add('link'); a.addEventListener('click', () => openFile(mm[1], { line: +mm[2], flash: true })); }
  }
  return h('div.msg.agent', { dataset: { mid: m.mid } }, h('div.who', icon('bot'), m.agent), body);
}

function appendMessage(m) {
  const box = $('#asstBody');
  if (!box) return;
  const empty = box.querySelector('.asst-empty');
  if (empty) empty.remove();
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.appendChild(messageEl(m));
  if (near || m.role === 'user') box.scrollTop = box.scrollHeight;
}

function renderAssistant() {
  const box = $('#asstBody');
  if (!box) return;
  const rows = A.chat.map(messageEl);
  if (!A.chat.length) {
    if (!A.agents.length) rows.push(connectCard());
    else rows.push(h('div.asst-empty', icon('bot'), h('p', `${A.agents[0].name} is connected. Ask about the paper, or select a passage and ask for a change.`)));
  }
  box.replaceChildren(...rows);
  box.scrollTop = box.scrollHeight;
  renderReviews();
  renderPresence();
  renderCtxChip();
}

// Files an agent changed that still wait for keep or undo, listed above the input.
function renderReviews() {
  const box = $('#asstReviews');
  if (!box) return;
  const pend = [...A.reviews.entries()];
  box.hidden = !pend.length;
  box.replaceChildren(...(pend.length ? [h('h4', 'Changes to review'), ...pend.map(([p, rv]) => h('div.cmp-row', { title: `Open ${p} to keep or undo`, onclick: () => openFile(p) },
    icon('pencil-line'), h('span.name', p), h('span.tag', rv.agent)))] : []));
  for (const el of $$('#asstBody .msg.act[data-path]')) el.classList.toggle('pending', A.reviews.has(el.dataset.path));
}

// ------------------------------------------------------------------ comparing with another version of the paper
// The other version is a second folder, read-only. Its text shows inline in the editor where it differs, its PDF
// below yours. Files are matched by their path inside each folder.
const C = { ref: null, texts: new Map(), pdf: null, pdfMtime: null, stats: new Map(), showDiff: true, showPdf: true };
const cmpSaved = () => (S.project ? store.get('compare', {})[S.project.root] : null);
function cmpRemember() {
  const all = store.get('compare', {});
  if (C.ref) all[S.project.root] = { root: C.ref.root, showDiff: C.showDiff, showPdf: C.showPdf };
  else delete all[S.project.root];
  store.set('compare', all);
}
function comparingFile(path) { return !!((C.ref && C.showDiff && C.texts.has(path)) || A.reviews.has(path)); }
const compareKinds = (p) => /\.(tex|ltx|bib|cls|sty|bst|txt|md)$/i.test(p);

function applyCompare(path) {
  const t = activeTab();
  if (!editor || !t || t.kind !== 'text' || t.path !== path) return;
  const rv = A.reviews.get(path);
  if (rv) editor.setCompare(rv.base, rv.agent, { accept: 'Keep', reject: 'Undo' });   // an agent's changes come first
  else editor.setCompare(C.ref && C.showDiff && C.texts.has(path) ? C.texts.get(path) : null, C.ref ? C.ref.name : '');
  renderCmpBar();
}

function statsFor(path) {
  const mine = currentText(path), theirs = C.texts.get(path);
  if (mine == null && theirs == null) return null;
  if (mine == null) return { status: 'theirs' };
  if (theirs == null) return { status: 'mine' };
  if (mine === theirs) return { status: 'same', added: 0, removed: 0 };
  const d = diffStats(theirs.split('\n'), mine.split('\n'));
  return { status: d.same ? 'same' : 'changed', added: d.added, removed: d.removed };
}
function computeCmpStats() {
  C.stats = new Map();
  const paths = new Set([...S.files.filter((f) => f.kind === 'text' && compareKinds(f.path)).map((f) => f.path), ...[...C.texts.keys()].filter(compareKinds)]);
  for (const p of paths) { const s = statsFor(p); if (s) C.stats.set(p, s); }
}

async function openCompare(root, quiet) {
  let info;
  try { info = await api('/api/compare/open', { root }); } catch (e) { toast(e.message, 'error', 6000); return false; }
  let texts = {};
  try { texts = await api('/api/compare/texts'); } catch (e) { /* empty */ }
  C.ref = info;
  C.texts = new Map(Object.entries(texts).map(([k, v]) => [k, v.text]));
  C.pdfMtime = null;
  computeCmpStats();
  cmpRemember();
  $('#cmpBadge').hidden = false;
  $('#pdfMainLabel').hidden = false;
  $('#pdfMainLabel').textContent = S.project.name;
  $('#pdfMainLabel').title = 'Your version: ' + S.project.root;
  $('#pdfRefLabel').textContent = info.name;
  $('#pdfRefLabel').title = 'The other version (read-only): ' + info.root;
  setRefPdfVisible(C.showPdf, true);
  const t = activeTab();
  if (t && t.kind === 'text') { applyCompare(t.path); loadGitBase(t.path); }
  renderCompare();
  if (!quiet) toast(`Comparing with ${info.name}`);
  loadRefPdf(false);
  return true;
}

async function closeCompare() {
  try { await api('/api/compare/close', {}); } catch (e) { /* server gone */ }
  C.ref = null;
  C.texts = new Map();
  C.stats = new Map();
  C.pdfMtime = null;
  cmpRemember();
  $('#cmpBadge').hidden = true;
  $('#pdfMainLabel').hidden = true;
  setRefPdfVisible(false, true);
  for (const t of [...S.tabs]) if (t.kind === 'ref') closeTab(tabKey(t));
  const t = activeTab();
  if (t && t.kind === 'text') { editor.setCompare(null); loadGitBase(t.path); }
  renderCompare();
  renderCmpBar();
}

function setRefPdfVisible(on, quiet) {
  C.showPdf = on;
  const show = on && !!C.ref;
  $('#pdfRef').hidden = !show;
  $('#pdfSplit').hidden = !show;
  if (show && S.layout === 'editor') setLayout('split');
  if (!quiet) { cmpRemember(); renderCompare(); }
}

function ensureRefPdf() {
  if (C.pdf) return C.pdf;
  C.pdf = new PdfView({
    scroll: $('#pdfRefScroll'), pages: $('#pdfRefPages'), empty: $('#pdfRefEmpty'),
    onPage: (n, total) => { if (document.activeElement !== $('#refPageInput')) $('#refPageInput').value = n; $('#refPageCount').textContent = '/ ' + total; },
    onDblClick: (p) => refToCode(p),
  });
  C.pdf.setDark(settings.pdfDark);
  return C.pdf;
}

async function loadRefPdf(force) {
  if (!C.ref) return;
  const view = ensureRefPdf();
  const ref = C.ref;
  const empty = $('#pdfRefEmpty');
  const waiting = () => empty.replaceChildren(h('div.empty-card', icon('loader-circle', 'spin'), h('p', `Compiling ${ref.name}…`)));
  if (!view.doc) { empty.hidden = false; waiting(); }
  if (ref.pdf_mtime && !force && C.pdfMtime !== ref.pdf_mtime) { C.pdfMtime = ref.pdf_mtime; await view.load('/pdf?ref=1&v=' + ref.pdf_mtime); }
  if (force) toast(`Compiling ${ref.name}…`);
  let r;
  try { r = await api('/api/compare/compile', { force: !!force }); } catch (e) { r = { ok: false, issues: [{ kind: 'error', msg: e.message }] }; }
  if (C.ref !== ref) return;
  if (r.pdf_mtime && r.pdf_mtime !== C.pdfMtime) { C.pdfMtime = r.pdf_mtime; await view.load('/pdf?ref=1&v=' + r.pdf_mtime); }
  if (!r.pdf_mtime && !view.doc) {
    const err = (r.issues || []).find((i) => i.kind === 'error');
    empty.hidden = false;
    empty.replaceChildren(h('div.empty-card', icon('circle-x'), h('p', `${ref.name} did not compile.`), err ? h('p', { style: { fontSize: '12px' } }, err.msg + (err.file ? ` (${err.file}:${err.line})` : '')) : null,
      h('button.btn', { onclick: () => loadRefPdf(true) }, icon('refresh-cw'), 'Try again')));
  } else if (force && r.ok) toast(`${ref.name} compiled`);
}

// The cursor's line, carried over to the other version and shown in its PDF.
async function syncRefToLine(path, line, quiet) {
  if (!C.ref || !C.showPdf || !C.pdfMtime || !C.texts.has(path) || !C.pdf) return;
  const refLine = mapLine(currentText(path) || '', C.texts.get(path), line);
  try {
    const r = await api('/api/synctex/view', { file: path, line: refLine, ref: true });
    if (r.page) C.pdf.show(r.page, r.rects);
    else if (!quiet) toast(`That part is not in ${C.ref.name}'s PDF`, 'warn');
  } catch (e) { /* no synctex yet */ }
}

// A spot in the other version's PDF -> the matching line of your file.
async function refToCode(point) {
  const p = point || (C.pdf && C.pdf.focusPoint());
  if (!p || !C.ref) return;
  try {
    const r = await api('/api/synctex/edit', { page: p.page, x: p.x, y: p.y, ref: true });
    if (!r.file) { toast('No source for that spot (it may come from the class or a package).', 'warn'); return; }
    if (!has(r.file)) { toast(`${r.file} is only in ${C.ref.name}`, 'warn'); openRefFile(r.file, r.line); return; }
    const line = mapLine(C.texts.get(r.file) || '', currentText(r.file) || '', r.line);
    if (S.layout === 'pdf') setLayout('split');
    await openFile(r.file, { line, flash: true });
    syncToPdf(true);
  } catch (e) { toast('SyncTeX: ' + e.message, 'error'); }
}

// A file that only the other version has: read-only, with a button to copy it over.
function openRefFile(path, line) {
  addTab({ path, kind: 'ref' });
  activate('ref:' + path);
  if (line && refView) {
    const ln = refView.state.doc.line(Math.min(refView.state.doc.lines, line));
    refView.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: 'center' }) });
  }
}
let refView = null;
function renderRefOnly(path) {
  const host = $('#diffHost');
  if (refView) { refView.destroy(); refView = null; }
  const text = C.texts.get(path);
  const body = h('div.diff-body');
  host.replaceChildren(
    h('div.diff-bar', icon('file-text'), h('b', path), h('span.meta', `only in ${C.ref ? C.ref.name : 'the other version'}, read-only`), h('div.spacer'),
      text != null && !has(path) ? h('button.btn', { onclick: () => copyRefFile(path) }, icon('copy'), 'Copy into my version') : null),
    body);
  if (text == null) { body.appendChild(h('div.side-empty', 'This file is not in the other version.')); return; }
  refView = new EditorView({ parent: body, state: EditorState.create({ doc: text, extensions: viewerExtensions(settings) }) });
}
async function copyRefFile(path) {
  try {
    await api('/api/new', { path, kind: 'file', text: C.texts.get(path) });
    closeTab('ref:' + path);
    await refreshProject();
    computeCmpStats();
    renderCompare();
    await openFile(path);
    toast(`Copied ${path} from ${C.ref.name}`);
  } catch (e) { toast(e.message, 'error'); }
}

const cmpBarSoon = debounce(() => {
  const t = activeTab();
  // a review is done when every change has been kept or undone
  if (t && t.kind === 'text' && A.reviews.has(t.path)) {
    const info = editor.compareInfo();
    if (info && info.count === 0) finishReview(t.path, 'kept');
  }
  if (t && t.kind === 'text' && C.ref) {
    const s = statsFor(t.path);
    if (s) C.stats.set(t.path, s);
    const row = $(`#cmpBody .cmp-row[data-path="${CSS.escape(t.path)}"]`);
    if (row) renderCompare();
  }
  renderCmpBar();
}, 250);

function renderCmpBar() {
  const bar = $('#cmpBar');
  const t = activeTab();
  const rv = t && t.kind === 'text' ? A.reviews.get(t.path) : null;
  if (rv) {
    const info = editor.compareInfo();
    const n = info ? info.count : 0;
    bar.hidden = false;
    bar.classList.add('review');
    bar.replaceChildren(icon('bot'), h('span', h('b', rv.agent), ' changed this file', rv.note ? ' · ' + rv.note : ''),
      h('div.spacer'), h('span.count', n ? (info.index ? `change ${info.index} of ${n}` : `${n} change${n > 1 ? 's' : ''}`) : 'no changes left'),
      h('button.mini', { title: 'Previous change (Shift+F7)', disabled: !n, onclick: () => { editor.prevChange(); editor.view.focus(); } }, icon('chevron-up')),
      h('button.mini', { title: 'Next change (F7)', disabled: !n, onclick: () => { editor.nextChange(); editor.view.focus(); } }, icon('chevron-down')),
      h('button.btn', { title: 'Undo everything the agent changed in this file', onclick: () => finishReview(t.path, 'undo') }, icon('undo-2'), 'Undo all'),
      h('button.btn.primary', { title: 'Keep the changes', onclick: () => finishReview(t.path, 'kept') }, icon('check'), 'Keep all'));
    return;
  }
  bar.classList.remove('review');
  if (!C.ref || !t || t.kind !== 'text') { bar.hidden = true; return; }
  bar.hidden = false;
  const name = C.ref.name;
  if (!C.texts.has(t.path)) {
    bar.replaceChildren(icon('git-compare'), h('span', `This file is not in `, h('b', name), '.'), h('div.spacer'));
    return;
  }
  if (!C.showDiff) {
    bar.replaceChildren(icon('git-compare'), h('span', 'Comparing with ', h('b', name), ' · differences hidden'), h('div.spacer'),
      h('button.btn', { onclick: () => { C.showDiff = true; cmpRemember(); applyCompare(t.path); loadGitBase(t.path); renderCompare(); } }, icon('eye'), 'Show'));
    return;
  }
  const info = editor.compareInfo();
  const n = info ? info.count : 0;
  const where = !n ? 'no differences' : info.index ? `change ${info.index} of ${n}` : `${n} change${n > 1 ? 's' : ''}`;
  bar.replaceChildren(icon('git-compare'), h('span', 'Comparing with ', h('b', name)),
    h('span.legend', h('span.sw.mine'), 'yours', h('span.sw.theirs'), name),
    h('div.spacer'), h('span.count', where),
    h('button.mini', { title: 'Previous change (Shift+F7)', disabled: !n, onclick: () => { editor.prevChange(); editor.view.focus(); } }, icon('chevron-up')),
    h('button.mini', { title: 'Next change (F7)', disabled: !n, onclick: () => { editor.nextChange(); editor.view.focus(); } }, icon('chevron-down')),
    h('button.btn', { title: 'Hide the other version in the editor', onclick: () => { C.showDiff = false; cmpRemember(); applyCompare(t.path); loadGitBase(t.path); renderCompare(); } }, icon('eye-off'), 'Hide'));
}

async function renderCompare() {
  const box = $('#cmpBody');
  if (!box) return;
  if (!C.ref) {
    const input = h('input', { type: 'text', placeholder: '~/papers/other-version', spellcheck: 'false' });
    const go = () => input.value.trim() && openCompare(input.value.trim().replace(/^~/, S.project.home));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    const pick = h('div.cmp-pick', h('div.side-empty', 'Looking for other versions…'));
    box.replaceChildren(
      h('div.cmp-card', h('div.t', icon('git-compare'), 'Compare with another version'),
        h('p', { style: { margin: '6px 0 0', color: 'var(--text-2)', lineHeight: '1.5' } },
          'Pick another folder of this paper. You keep editing your files. The other version shows in the editor where it differs, and its PDF opens below yours.')),
      pick,
      h('div.field', input), h('button.btn', { onclick: go }, icon('folder-open'), 'Compare with this folder'));
    let folders = [];
    try { folders = (await api('/api/compare/candidates')).folders; } catch (e) { /* none */ }
    if (C.ref) return;
    pick.replaceChildren(...(folders.length ? folders.map((f) => h('div.cmp-row', { title: f.root, onclick: () => openCompare(f.root) },
      icon('folder'), h('div', { style: { minWidth: 0 } }, h('div.name', f.name), h('div.p', f.show))))
      : [h('div.side-empty', 'No other paper folders next to this one. Type a folder below.')]));
    return;
  }
  const rows = [...C.stats.entries()].sort((a, b) => {
    const order = { changed: 0, mine: 1, theirs: 2, same: 3 };
    return order[a[1].status] - order[b[1].status] || a[0].localeCompare(b[0], undefined, { numeric: true });
  });
  const count = (s) => rows.filter(([, x]) => x.status === s).length;
  const active = (activeTab() || {}).path;
  const sw = (label, on, set) => {
    const inp = h('input', { type: 'checkbox', checked: on, onchange: () => set(inp.checked) });
    return h('label.set', { style: { padding: '6px 0', borderBottom: '0' } }, h('div.lbl', h('div', label)), h('span.switch', inp, h('span')));
  };
  box.replaceChildren(
    h('div.cmp-card',
      h('div.t', icon('git-compare'), 'Comparing with ', h('span', { style: { color: 'var(--danger)' } }, C.ref.name)),
      h('div.p', C.ref.root.replace(S.project.home, '~') + ' · read-only'),
      sw('Show it in the editor', C.showDiff, (v) => { C.showDiff = v; cmpRemember(); const t = activeTab(); if (t && t.kind === 'text') { applyCompare(t.path); loadGitBase(t.path); } }),
      sw('Show its PDF below mine', C.showPdf, (v) => { setRefPdfVisible(v); if (v) loadRefPdf(false); }),
      h('div.row-btns',
        h('button.btn', { onclick: () => { closeCompare(); } }, icon('x'), 'Stop comparing'),
        h('button.btn', { onclick: async () => { await closeCompare(); showView('compare'); } }, icon('folder-open'), 'Another folder'))),
    h('div.cmp-sum', h('span', h('b', count('changed')), ' differ'), h('span', h('b', count('same')), ' same'),
      count('mine') ? h('span', h('b', count('mine')), ' only mine') : null, count('theirs') ? h('span', h('b', count('theirs')), ' only theirs') : null),
    h('div', ...rows.map(([p, s]) => h('div.cmp-row.' + s.status + (p === active ? '.on' : ''), {
      dataset: { path: p }, title: p,
      onclick: () => (s.status === 'theirs' ? openRefFile(p) : openFile(p)),
    }, icon(fileIconName(p, 'text')), h('span.name', p),
    s.status === 'changed' ? [s.added ? h('span.plus', '+' + s.added) : null, s.removed ? h('span.minus', '−' + s.removed) : null]
      : s.status === 'mine' ? h('span.tag', 'only mine') : s.status === 'theirs' ? h('span.tag', 'only theirs') : h('span.tag', 'same')))));
}

// ------------------------------------------------------------------ the file at the last commit, for the margin markers
async function loadGitBase(path) {
  // while comparing with another version, its colours take the margin
  if (!settings.gitMarks || !S.git || comparingFile(path)) { editor.view.dispatch({ effects: setGitBase.of(null) }); return; }
  const status = (S.git.changes.find((c) => c.path === path) || {}).status;
  let base = S.heads.get(path);
  if (base === undefined) {
    if (status === 'U' || status === 'A') base = '';
    else { try { base = (await api('/api/git/head?path=' + enc(path))).text; } catch (e) { base = null; } }
    S.heads.set(path, base);
  }
  if (S.active === path && editor.view.state.facet(pathFacet) === path) editor.view.dispatch({ effects: setGitBase.of(base) });
}

function insertSnippetAt(view, pos, tpl) {
  const line = view.state.doc.lineAt(pos);
  let at = pos;
  let lead = '';
  if (line.text.trim()) { at = line.to; lead = '\n'; }
  snippet(lead + tpl)(view, null, at, at);
  view.focus();
}

async function uploadImages(files, view, pos, pasted) {
  const dir = figuresDir();
  const out = [];
  for (const f of files) {
    let name = f.name;
    if (pasted || !name || name === 'image.png') {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const v = await promptDialog({ title: 'Paste image', label: `Saved in ${dir}/ and inserted as a figure.`, value: `figure-${stamp}.png`, okText: 'Insert', selectStem: true, validate: (x) => (!x ? 'Type a name' : /[/\\]/.test(x) ? 'Just a file name' : null) });
      if (!v) return;
      name = /\.[a-z0-9]+$/i.test(v) ? v : v + '.png';
    }
    const p = await uploadOne(f, dir + '/' + name);
    if (p) out.push(p);
  }
  if (!out.length) return;
  S.openDirs.add(dir);
  await refreshProject();
  const images = out.filter((p) => kindOf(p) === 'image' || kindOf(p) === 'pdf');
  if (images.length && kindOf(S.active) === 'text' && isTex(S.active)) insertSnippetAt(view, pos, images.map(figureSnippet).join('\n'));
  else toast(`Added ${out.join(', ')}`);
}

function lastTexTab() {
  const t = activeTab();
  if (t && t.kind === 'text' && isTex(t.path)) return t.path;
  for (let i = S.tabs.length - 1; i >= 0; i--) if (S.tabs[i].kind === 'text' && isTex(S.tabs[i].path)) return S.tabs[i].path;
  return mainPath();
}
async function insertFigureFromTree(path) {
  const target = lastTexTab();
  await openFile(target);
  insertSnippetAt(editor.view, editor.view.state.selection.main.head, figureSnippet(path));
}
async function insertAtCursor(text) {
  const target = lastTexTab();
  await openFile(target);
  const v = editor.view;
  const pos = v.state.selection.main.head;
  v.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
}

async function setMain(path) {
  try {
    await api('/api/main', { main: path });
    await refreshProject();
    toast(`Main document: ${path}`);
    compile();
  } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ files changed on disk
let polling = false;
async function poll() {
  if (polling || document.visibilityState !== 'visible' || !S.project) return;
  polling = true;
  try {
    const r = await api('/api/stat');
    if (r.root !== S.project.root) { location.reload(); return; }
    const paths = Object.keys(r.files);
    if (paths.length !== S.files.length || paths.some((p) => !S.fileMap.has(p)) || r.main !== S.project.main) await refreshProject();
    for (const [p, mt] of Object.entries(r.files)) {
      const meta = S.texts.get(p);
      if (!meta || mt == null || S.saving.has(p) || Math.abs(mt - meta.mtime) < 1e-3) continue;
      await diskChanged(p);
    }
  } catch (e) { /* server restarting */ } finally { polling = false; }
}

async function diskChanged(path) {
  let r;
  try { r = await api('/api/file?path=' + enc(path)); } catch (e) { return; }
  const cur = currentText(path);
  S.texts.set(path, r);
  if (cur === r.text) { S.conflicts.delete(path); renderBanner(); return; }
  if (!S.states.has(path)) { rescan(path); rebuildIndex(); return; }
  if (!S.dirty.has(path)) {
    replaceDoc(path, r.text);
    indexSoon(path);
    if (!A.reviews.has(path)) toast(`${base(path)} changed on disk and was reloaded`);
  } else {
    S.conflicts.set(path, r.text);
    renderBanner();
  }
}

function renderBanner() {
  const b = $('#banner');
  const t = activeTab();
  if (!t || !S.conflicts.has(t.path)) { b.hidden = true; return; }
  b.hidden = false;
  b.replaceChildren(icon('triangle-alert'), h('span', `${t.path} changed on disk while you were editing it.`), h('div.spacer'),
    h('button.btn', { onclick: () => { const disk = S.conflicts.get(t.path); S.conflicts.delete(t.path); replaceDoc(t.path, disk); renderBanner(); } }, 'Use the disk version'),
    h('button.btn.primary', { onclick: async () => { S.conflicts.delete(t.path); S.dirty.add(t.path); await saveFile(t.path, true); renderBanner(); } }, 'Keep mine'));
}

// ------------------------------------------------------------------ palette
function commandList() {
  const on = (b) => (b ? ' (on)' : ' (off)');
  return [
    { label: 'Compile', icon: 'play', kbd: 'Mod+Enter', run: compile },
    { label: 'Save all', icon: 'save', kbd: 'Mod+S', run: ctrlS },
    { label: 'Show the cursor in the PDF', icon: 'arrow-right', kbd: 'Mod+J', run: () => syncToPdf() },
    { label: 'Show this part of the PDF in the source', icon: 'arrow-left', run: () => syncToCode() },
    { label: 'Go to file…', icon: 'file', kbd: 'Mod+P', run: () => openQuick('') },
    { label: 'Go to section…', icon: 'list-tree', kbd: 'Mod+Shift+O', run: () => openQuick('@') },
    { label: 'Go to label…', icon: 'hash', run: () => openQuick('#') },
    { label: 'Insert a citation…', icon: 'quote', run: () => openQuick('&') },
    { label: 'Add a reference from a DOI or arXiv ID…', icon: 'book-marked', run: addReference },
    { label: 'Search in all files', icon: 'search', kbd: 'Mod+Shift+F', run: () => showView('search', true) },
    { label: 'Problems panel', icon: 'triangle-alert', kbd: 'Mod+Shift+M', run: () => toggleDrawer() },
    { label: 'Word count by section', icon: 'hash', run: showWords },
    { label: 'New file', icon: 'file-plus', run: () => newFile('') },
    { label: 'New folder', icon: 'folder-plus', run: () => newDir('') },
    { label: 'Upload files', icon: 'upload', run: () => pickUpload('') },
    { label: 'Insert figure from a file…', icon: 'image', run: pickFigure },
    { label: 'Insert a table…', icon: 'list', run: insertTable },
    { label: 'Math symbols', icon: 'sigma', run: () => showView('symbols') },
    { label: 'Set the main document…', icon: 'house', run: pickMain },
    { label: 'Open another project…', icon: 'folder-open', run: openProjectDialog },
    { label: 'Changes and history', icon: 'git-branch', run: () => showView('git') },
    { label: 'Compare with another version…', icon: 'git-compare', run: () => showView('compare') },
    { label: 'Assistant: talk to your AI agent', icon: 'bot', kbd: 'Mod+Shift+A', run: () => showView('assistant', true) },
    { label: 'Connect an AI agent…', icon: 'plug', run: showConnect },
    C.ref ? { label: 'Stop comparing', icon: 'x', run: closeCompare } : null,
    C.ref ? { label: 'Next difference', icon: 'chevron-down', kbd: 'F7', run: () => { editor.nextChange(); editor.view.focus(); } } : null,
    C.ref ? { label: 'Previous difference', icon: 'chevron-up', kbd: 'Shift+F7', run: () => { editor.prevChange(); editor.view.focus(); } } : null,
    C.ref ? { label: `Show ${C.ref.name}'s PDF below mine` + (C.showPdf ? ' (on)' : ' (off)'), icon: 'columns-2', run: () => { setRefPdfVisible(!C.showPdf); if (C.showPdf) loadRefPdf(false); } } : null,
    { label: 'Layout: editor and PDF', icon: 'columns-2', run: () => setLayout('split') },
    { label: 'Layout: editor only', icon: 'file-pen-line', run: () => setLayout('editor') },
    { label: 'Layout: PDF only', icon: 'file-text', run: () => setLayout('pdf') },
    { label: 'Toggle the sidebar', icon: 'panel-left', run: () => $('#sidebar').classList.toggle('collapsed') },
    { label: 'Dark theme' + on(document.documentElement.dataset.theme === 'dark'), icon: 'moon', run: toggleTheme },
    { label: 'Dark PDF pages' + on(settings.pdfDark), icon: 'moon-star', run: () => setSetting('pdfDark', !settings.pdfDark) },
    { label: 'Auto compile while typing' + on(settings.autoCompile), icon: 'refresh-cw', run: () => setSetting('autoCompile', !settings.autoCompile) },
    { label: 'Spell checking' + on(settings.spell), icon: 'type', run: () => setSetting('spell', !settings.spell) },
    { label: 'Line wrapping' + on(settings.wrap), icon: 'text-cursor-input', run: () => setSetting('wrap', !settings.wrap) },
    { label: 'Math preview' + on(settings.mathPreview), icon: 'sigma', run: () => setSetting('mathPreview', !settings.mathPreview) },
    { label: 'PDF follows the cursor' + on(settings.followCursor), icon: 'locate-fixed', run: () => setSetting('followCursor', !settings.followCursor) },
    { label: 'Fold all', icon: 'chevron-right', run: () => { foldAll(editor.view); } },
    { label: 'Unfold all', icon: 'chevron-down', run: () => { unfoldAll(editor.view); } },
    { label: 'Download the PDF', icon: 'download', run: () => { location.href = '/pdf?download=1'; } },
    { label: 'Settings', icon: 'settings', kbd: 'Mod+,', run: showSettings },
    { label: 'Keyboard shortcuts', icon: 'keyboard', run: showKeys },
  ];
}

function openQuick(prefix) {
  palette({
    initial: prefix,
    placeholder: 'Go to a file',
    hint: '<span><b>&gt;</b> commands</span><span><b>@</b> sections</span><span><b>#</b> labels</span><span><b>&amp;</b> citations</span>',
    source: (q) => {
      const pick = (list, text, mk) => {
        const out = [];
        for (const x of list) { const m = fuzzy(q.slice(1).trim(), text(x)); if (m) out.push({ x, m }); }
        out.sort((a, b) => b.m.score - a.m.score);
        return out.slice(0, 120).map(({ x, m }) => mk(x, m));
      };
      if (q.startsWith('>')) return pick(commandList().filter(Boolean), (c) => c.label, (c, m) => ({ icon: c.icon, html: highlight(c.label, m.hits), kbd: c.kbd, run: c.run }));
      if (q.startsWith('@')) return pick(S.outline.filter((i) => i.kind === 'section'), (i) => i.title, (i, m) => ({ icon: 'list-tree', html: (i.num ? `<span style="color:var(--faint)">${i.num}</span>&nbsp; ` : '') + highlight(i.title, m.hits), detail: `${i.file}:${i.line}`, run: () => openFile(i.file, { pos: i.pos, flash: true }) }));
      if (q.startsWith('#')) return pick([...S.labels.entries()], ([n]) => n, ([n, defs], m) => ({ icon: 'hash', html: highlight(n, m.hits), detail: labelInfo(defs[0]).kind + ' · ' + defs[0].file, run: () => openFile(defs[0].file, { pos: defs[0].pos, flash: true }) }));
      if (q.startsWith('&')) {
        const add = { icon: 'book-marked', html: '<b>Add a reference from a DOI or arXiv ID…</b>', run: addReference };
        const writing = activeKind() === 'text' && isTex(S.active);
        return [...pick([...S.bib.values()], (e) => e.key + ' ' + e.author + ' ' + e.year + ' ' + e.title, (e) => ({
          icon: 'quote', html: esc(e.key) + ' <span style="color:var(--muted)">' + esc(e.title.slice(0, 80)) + '</span>',
          detail: [e.author, e.year].filter(Boolean).join(' '),
          run: () => (writing ? insertCite(e.key) : openFile(e.file, { pos: e.pos, flash: true })),
        })), add];
      }
      const files = S.files.filter((f) => f.kind !== 'dir');
      if (!q.trim()) {
        const recent = S.tabs.map((t) => t.path).filter((p, i, a) => a.indexOf(p) === i && S.fileMap.has(p));
        const rest = files.filter((f) => !recent.includes(f.path)).map((f) => f.path);
        return [...recent, ...rest].slice(0, 120).map((p) => ({ icon: fileIconName(p, kindOf(p)), html: esc(base(p)), detail: dirname(p), run: () => openFile(p) }));
      }
      const out = [];
      for (const f of files) { const m = fuzzy(q.trim(), f.path); if (m) out.push({ f, m }); }
      out.sort((a, b) => b.m.score - a.m.score);
      return out.slice(0, 120).map(({ f, m }) => ({ icon: fileIconName(f.path, f.kind), html: highlight(f.path, m.hits), run: () => openFile(f.path) }));
    },
  });
}

function pickFigure() {
  palette({
    placeholder: 'Choose an image to insert as a figure',
    source: (q) => S.files.filter((f) => f.kind === 'image' || f.kind === 'pdf').map((f) => ({ f, m: fuzzy(q, f.path) })).filter((x) => x.m)
      .sort((a, b) => b.m.score - a.m.score).map(({ f, m }) => ({ icon: fileIconName(f.path, f.kind), html: highlight(f.path, m.hits), run: () => insertFigureFromTree(f.path) })),
  });
}

function pickMain() {
  const docs = S.files.filter((f) => isTex(f.path) && /\\documentclass/.test(currentText(f.path) || ''));
  const all = docs.length ? docs : S.files.filter((f) => isTex(f.path));
  palette({
    placeholder: 'Choose the main document (the file you compile)',
    source: (q) => all.map((f) => ({ f, m: fuzzy(q, f.path) })).filter((x) => x.m).map(({ f, m }) => ({ icon: 'house', html: highlight(f.path, m.hits), detail: f.path === mainPath() ? 'current' : '', run: () => setMain(f.path) })),
  });
}

function openProjectDialog() { showWelcome(true); }

// ------------------------------------------------------------------ welcome: start from a template, or open a folder
function logoSvg() { return $('.brand .logo').cloneNode(true); }

// How to install Tectonic on this system, with copy buttons. onReady runs once it is found.
function tectonicCard(info, onReady) {
  const dir = info.app_dir;
  const curl = `cd "${dir}" && curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh`;
  const steps = info.system === 'windows'
    ? [['In PowerShell', `cd "${dir}"\n[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072\niex ((New-Object System.Net.WebClient).DownloadString('https://drop-ps1.fullyjustified.net'))`]]
    : info.system === 'mac' ? [['In Terminal, with Homebrew', 'brew install tectonic'], ['or without Homebrew', curl]]
      : [['In a terminal', curl]];
  const check = h('button.btn.primary', {
    onclick: async () => {
      try {
        const w = await api('/api/welcome');
        if (w.tectonic) { toast('Tectonic is ready'); onReady && onReady(); } else toast('Not found yet. Run the command, then check again.', 'warn');
      } catch (e) { toast(e.message, 'error'); }
    },
  }, icon('refresh-cw'), 'Check again');
  return h('div.tecto',
    h('div.t', icon('triangle-alert'), 'One more step: install Tectonic'),
    h('p', 'Scriptorium compiles with Tectonic, a small LaTeX engine that downloads the packages a document needs by itself. Run this once. It puts Tectonic next to Scriptorium, where it is found automatically.'),
    ...steps.map(([label, cmd]) => h('div.cmd', h('span.lbl', label), h('pre', cmd),
      h('button.mini', { title: 'Copy', onclick: () => navigator.clipboard.writeText(cmd).then(() => toast('Copied')) }, icon('copy')))),
    h('div.row-btns', check, h('a.btn', { href: 'https://tectonic-typesetting.github.io/book/latest/installation/', target: '_blank', rel: 'noopener' }, icon('external-link'), 'Other ways to install')));
}

// A folder picker over the server's file system (it runs on this computer).
function pickFolder(start, title, okText) {
  return new Promise((resolve) => {
    let cur = null, parent = null;
    const list = h('div.fb-list');
    const where = h('div.fb-path');
    const ok = h('button.btn.primary', { onclick: () => m.close(cur) }, okText);
    const up = h('button.btn', { title: 'Up one folder', onclick: () => parent && go(parent) }, icon('chevron-up'), 'Up');
    async function go(p) {
      let r;
      try { r = await api('/api/browse?path=' + enc(p)); } catch (e) { list.replaceChildren(h('div.side-empty', e.message)); return; }
      cur = r.path;
      parent = r.parent;
      up.disabled = !parent;
      where.replaceChildren(...[icon('folder-open'), h('span', r.show), r.tex ? h('span.tag', 'has .tex files') : null].filter(Boolean));
      list.replaceChildren(...(r.dirs.length ? r.dirs.map((d) => h('div.cmp-row', { title: d.path, onclick: () => go(d.path) },
        icon('folder'), h('span.name', d.name), d.tex ? h('span.tag', 'LaTeX') : null, icon('chevron-right')))
        : [h('div.side-empty', 'No folders inside.')]));
      list.scrollTop = 0;
    }
    const m = modal({
      title, iconName: 'folder-open', wide: true,
      body: [h('div.fb-bar', up, where), list],
      foot: [h('button.btn', { onclick: () => m.close(null) }, 'Cancel'), ok],
      onClose: (v) => resolve(v ?? null),
    });
    go(start || '~');
  });
}

async function showWelcome(closable) {
  let w;
  try { w = await api('/api/welcome'); } catch (e) { toast('The Scriptorium server did not answer: ' + e.message, 'error'); return; }
  let tpl = (w.templates.find((t) => t.id === 'article') || w.templates[0] || {}).id;
  const nameIn = h('input', { type: 'text', value: 'my-paper', spellcheck: 'false' });
  const whereIn = h('input', { type: 'text', value: w.parent, spellcheck: 'false' });
  const err = h('div.err');
  const pathIn = h('input', { type: 'text', placeholder: '~/papers/my-paper', spellcheck: 'false' });
  const err2 = h('div.err');
  const cards = w.templates.map((t) => h('button.tpl' + (t.id === tpl ? '.on' : ''), {
    dataset: { id: t.id },
    onclick: () => { tpl = t.id; cards.forEach((c) => c.classList.toggle('on', c.dataset.id === t.id)); },
  }, h('span.tpl-ic', icon(t.icon)), h('b', t.name), h('span.d', t.description)));
  const create = async () => {
    err.textContent = '';
    try { await api('/api/create', { template: tpl, parent: whereIn.value, name: nameIn.value }); location.reload(); }
    catch (e) { err.textContent = e.message; }
  };
  const open = async (root) => {
    err2.textContent = '';
    try { await api('/api/open', { root }); location.reload(); } catch (e) { err2.textContent = e.message; }
  };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  pathIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && pathIn.value.trim()) { e.preventDefault(); open(pathIn.value.trim()); } });
  const recent = w.recent.filter((r) => !S.project || r.root !== S.project.root).slice(0, 8);
  const scrim = closable ? h('div.scrim', { onmousedown: () => close() }) : null;
  const page = h('div.welcome' + (closable ? '.floating' : ''), { role: 'dialog' },
    h('div.wl-head', logoSvg(), h('div', h('h1', 'Scriptorium'), h('p', 'A LaTeX writing room on your own machine.')),
      closable ? h('button.mini', { title: 'Close', onclick: () => close() }, icon('x')) : null),
    w.tectonic ? null : tectonicCard(w, () => location.reload()),
    h('div.wl-grid',
      h('section.wl-new',
        h('h2', 'Start a new project'),
        h('div.tpls', ...cards),
        h('div.wl-form',
          h('label', h('span', 'Folder name'), nameIn),
          h('label', h('span', 'Inside'), h('div.wl-where', whereIn,
            h('button.btn', { onclick: async () => { const p = await pickFolder(whereIn.value, 'Where should the new project go?', 'Put it here'); if (p) whereIn.value = p; } }, icon('folder-open'), 'Browse')))),
        err,
        h('button.btn.primary.big', { onclick: create }, icon('file-plus'), 'Create the project')),
      h('section.wl-open',
        h('h2', 'Open a folder'),
        recent.length ? h('div.wl-recent', h('h4', 'Recent'), ...recent.map((r) => h('div.cmp-row', { title: r.root, onclick: () => open(r.root) },
          icon('folder'), h('div', { style: { minWidth: 0 } }, h('div.name', r.name), h('div.p', r.show))))) : h('p.hint', 'Any folder with your .tex files is a project. Scriptorium finds the main file by itself.'),
        h('button.btn.wide', { onclick: async () => { const p = await pickFolder('~', 'Open a folder with your .tex files', 'Open this folder'); if (p) open(p); } }, icon('folder-open'), 'Browse for a folder…'),
        h('div.wl-path', pathIn, h('button.btn', { onclick: () => pathIn.value.trim() && open(pathIn.value.trim()) }, 'Open')),
        err2)),
    h('div.wl-foot', `Scriptorium ${w.version} · your files stay on this computer`));
  const onKey = (e) => { if (e.key === 'Escape' && closable && !document.querySelector('.modal')) close(); };
  function close() { page.remove(); if (scrim) scrim.remove(); document.removeEventListener('keydown', onKey, true); }
  document.addEventListener('keydown', onKey, true);
  const layerEl = $('#layer');
  if (scrim) layerEl.appendChild(scrim);
  layerEl.appendChild(page);
  setTimeout(() => (recent.length || !closable ? nameIn : pathIn).focus(), 50);
}

// ------------------------------------------------------------------ settings, words, keys
function setSetting(k, v) {
  settings[k] = v;
  saveSettings();
  applySettings();
}
function applySettings() {
  document.documentElement.style.setProperty('--editor-size', settings.fontSize + 'px');
  if (editor) editor.configure(settings);
  if (pdf) pdf.setDark(settings.pdfDark);
  if (C.pdf) C.pdf.setDark(settings.pdfDark);
  $('#pdfDark').classList.toggle('on', settings.pdfDark);
  applyTheme();
  renderStatus();
  if (editor) forceLinting(editor.view);
  const at = S.project && activeTab();
  if (at && at.kind === 'text') loadGitBase(at.path);
}

function effectiveTheme() {
  return settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme;
}
function applyTheme() {
  const t = effectiveTheme();
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('scriptorium.theme', settings.theme); } catch (e) { /* private mode */ }
  const ic = $('#themeIcon');
  if (ic) setIcon(ic, t === 'dark' ? 'sun' : 'moon');
  // the title bar of the installed app follows the theme
  for (const m of $$('meta[name="theme-color"]')) { m.removeAttribute('media'); m.content = t === 'dark' ? '#141518' : '#f5f4f1'; }
}
function toggleTheme() { setSetting('theme', effectiveTheme() === 'dark' ? 'light' : 'dark'); }

function showSettings() {
  const sw = (k, label, sub) => {
    const inp = h('input', { type: 'checkbox', checked: !!settings[k], onchange: () => setSetting(k, inp.checked) });
    return h('label.set', h('div.lbl', h('div', label), sub ? h('div', sub) : null), h('span.switch', inp, h('span')));
  };
  const sel = (k, label, opts, sub) => {
    const s = h('select', { onchange: () => setSetting(k, s.value) }, ...opts.map(([v, t]) => h('option', { value: v, selected: settings[k] === v }, t)));
    return h('div.set', h('div.lbl', h('div', label), sub ? h('div', sub) : null), s);
  };
  const size = h('input', { type: 'range', min: 11, max: 22, value: settings.fontSize, oninput: () => { out.textContent = size.value + ' px'; setSetting('fontSize', +size.value); } });
  const out = h('output', settings.fontSize + ' px');
  const mains = S.files.filter((f) => isTex(f.path) && /\\documentclass/.test(currentText(f.path) || ''));
  const mainSel = h('select', { onchange: () => setMain(mainSel.value) }, ...(mains.length ? mains : [{ path: mainPath() }]).map((f) => h('option', { value: f.path, selected: f.path === mainPath() }, f.path)));
  modal({
    title: 'Settings', iconName: 'settings',
    body: h('div.settings',
      h('div.set-group', h('h4', 'Appearance'),
        sel('theme', 'Theme', [['system', 'Same as Windows'], ['light', 'Light'], ['dark', 'Dark']]),
        h('div.set', h('div.lbl', h('div', 'Editor text size')), h('div.range', size, out)),
        sw('wrap', 'Wrap long lines'),
        sw('pdfDark', 'Dark PDF pages', 'Inverts the page colours for night work. Only the view changes.')),
      h('div.set-group', h('h4', 'Writing'),
        sw('spell', 'Check spelling', 'Uses the browser’s dictionary. Commands, math and labels are skipped.'),
        sel('spellLang', 'Spelling language', [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-PT', 'Portuguese']]),
        sw('mathPreview', 'Preview math while typing', 'Shows the equation under the cursor, rendered.'),
        sw('lintRefs', 'Check references, citations and files', 'Marks \\ref, \\cite, \\input and \\includegraphics that point at nothing.'),
        sw('gitMarks', 'Mark changes since the last commit', 'A coloured bar beside the lines you added or changed (projects in git).')),
      h('div.set-group', h('h4', 'Saving and compiling'),
        sw('autosave', 'Save automatically', 'Writes your changes to disk a second after you stop typing.'),
        sw('compileOnSave', 'Compile on Ctrl+S'),
        sw('autoCompile', 'Compile while typing', 'Compiles a couple of seconds after you stop typing.'),
        sw('followCursor', 'PDF follows the cursor', 'Scrolls the PDF to the part you are editing.'),
        sw('showBoxes', 'Show overfull and underfull boxes', 'Lines that stick out into the margin, or are too loose.')),
      h('div.set-group', h('h4', 'Project'),
        h('div.set', h('div.lbl', h('div', 'Main document'), h('div', 'The file that is compiled.')), mainSel),
        h('div.set', h('div.lbl', h('div', 'Folder'), h('div', S.project.root)), h('button.btn', { onclick: openProjectDialog }, 'Open another…')))),
  });
}

function showWords() {
  if (!has(mainPath())) { toast('The main document is missing', 'warn'); return; }
  const { rows, total } = wordsBySection(mainPath(), S.scans, textsView, has);
  const max = Math.max(1, ...rows.map((r) => r.words));
  const top = Math.min(...rows.map((r) => r.level));
  const cur = activeTab() && activeTab().kind === 'text' ? countWords(currentText(activeTab().path) || '') : null;
  const body = h('div.words',
    h('div.total', h('div', h('b', total.toLocaleString()), h('span', 'words in the document')),
      cur != null ? h('div', h('b', cur.toLocaleString()), h('span', 'in ' + base(activeTab().path))) : null,
      pdf.pageCount ? h('div', h('b', pdf.pageCount), h('span', 'pages')) : null),
    h('table', h('tbody', ...rows.map((r) => h('tr.l' + Math.min(2, Math.max(0, r.level - top)), { style: { cursor: 'pointer' }, onclick: () => { m.close(); openFile(r.file, { line: r.line, flash: true }); } },
      h('td', r.title), h('td.bar', h('div', { style: { width: (r.words / max) * 100 + '%' } })), h('td.n', r.words.toLocaleString()))))),
    h('p', { style: { marginTop: '12px', color: 'var(--muted)', fontSize: '12px' } }, 'Counts the text of the body, without commands, labels, citations or display math. Inline math counts as one word.'));
  const m = modal({ title: 'Word count', iconName: 'hash', body, wide: true });
}

function showKeys() {
  const K = [
    ['Writing', [['Save (and compile)', 'Mod+S'], ['Compile', 'Mod+Enter'], ['Bold', 'Mod+B'], ['Italic (emph)', 'Mod+I'], ['Comment lines', 'Mod+/'], ['Complete a command, label or citation', 'Mod+Space'], ['Next field in a snippet', 'Tab'], ['Indent / outdent', 'Tab'], ['Add a cursor', 'Alt+Click'], ['Select next match', 'Mod+D']]],
    ['Finding', [['Go to file', 'Mod+P'], ['Commands', 'Mod+Shift+P'], ['Go to section', 'Mod+Shift+O'], ['Find in file', 'Mod+F'], ['Replace in file', 'Mod+H'], ['Search all files', 'Mod+Shift+F'], ['Go to line', 'Mod+G'], ['Go to definition', 'F12'], ['Follow a \\ref or \\cite', 'Mod+Click']]],
    ['PDF', [['Show the cursor in the PDF', 'Mod+J'], ['Show a PDF spot in the source', 'Double-click'], ['Zoom', 'Mod+Wheel']]],
    ['Panels', [['Problems', 'Mod+Shift+M'], ['Files and outline', 'Mod+Shift+E'], ['Settings', 'Mod+,']]],
  ];
  modal({
    title: 'Keyboard shortcuts', iconName: 'keyboard',
    body: h('div.keys', ...K.flatMap(([g, rows]) => [h('h4', g), ...rows.flatMap(([l, k]) => [h('span', l), kbd(k)])])),
  });
}

// ------------------------------------------------------------------ layout
function setLayout(mode) {
  S.layout = mode;
  const w = $('#workspace');
  w.classList.remove('layout-editor', 'layout-pdf', 'layout-split');
  w.classList.add('layout-' + mode);
  $$('#layoutSeg button').forEach((b) => b.classList.toggle('on', b.dataset.layout === mode));
  store.set('layout', mode);
  if (mode !== 'pdf') requestAnimationFrame(() => editor.view.requestMeasure());
}

function showView(name, focus, toggle = false) {
  const sb = $('#sidebar');
  if (toggle && S.view === name && !sb.classList.contains('collapsed')) { sb.classList.add('collapsed'); $$('.activity [data-view]').forEach((b) => b.classList.remove('on')); store.set('sidebar', false); return; }
  sb.classList.remove('collapsed');
  store.set('sidebar', true);
  S.view = name;
  $$('.activity [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  $$('.sidebar .view').forEach((v) => v.classList.toggle('on', v.dataset.view === name));
  if (name === 'search' && focus !== false) { const i = $('#searchInput'); i.focus(); i.select(); const sel = editor.view.state.selection.main; if (!sel.empty && sel.to - sel.from < 80 && activeKind() === 'text') { i.value = editor.view.state.sliceDoc(sel.from, sel.to); runSearch(); } }
  if (name === 'git') { renderGit(); refreshGit(); }
  if (name === 'symbols' && !$('#symHost').firstChild) $('#symHost').appendChild(buildSymbolPanel(insertSymbol));
  if (name === 'compare') renderCompare();
  if (name === 'assistant') {
    A.unread = 0;
    $('#asstBadge').hidden = true;
    if (sb.offsetWidth < 340) sb.style.width = '360px';
    renderCtxChip();
    if (focus !== false) setTimeout(() => $('#chatInput').focus(), 0);
  }
}

function dragger(handle, onMove, onEnd) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('drag');
    document.body.style.cursor = getComputedStyle(handle).cursor;
    const move = (ev) => onMove(ev);
    const up = () => {
      handle.classList.remove('drag');
      document.body.style.cursor = '';
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      onEnd && onEnd();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

function bindLayout() {
  const sb = $('#sidebar');
  const w0 = store.get('sidebarWidth', 260);
  sb.style.width = w0 + 'px';
  if (store.get('sidebar', true) === false) sb.classList.add('collapsed');
  dragger($('#sideSplit'), (e) => { const x = e.clientX - sb.getBoundingClientRect().left; sb.style.width = Math.max(170, Math.min(560, x)) + 'px'; }, () => store.set('sidebarWidth', parseInt(sb.style.width)));
  const ed = $('#editorCol'), pc = $('#pdfCol');
  // flex-grow below 1 leaves space empty when the other pane is hidden, so the ratios are scaled up
  const grow = (r) => `${Math.round(r * 1000)} 1 0`;
  const setRatio = (r) => { ed.style.flex = grow(r); pc.style.flex = grow(1 - r); };
  setRatio(store.get('split', 0.5));
  dragger($('#divider'), (e) => {
    const a = ed.getBoundingClientRect().left, b = pc.getBoundingClientRect().right;
    const r = Math.max(0.2, Math.min(0.8, (e.clientX - a) / (b - a)));
    setRatio(r);
    S.splitRatio = r;
  }, () => { if (S.splitRatio) store.set('split', S.splitRatio); });
  const fp = $('#filesPane'), op = $('#outlinePane');
  const setV = (r) => { fp.style.flex = grow(r); op.style.flex = grow(1 - r); };
  setV(store.get('vsplit', 0.5));
  dragger($('#outlineSplit'), (e) => {
    const box = fp.parentElement.getBoundingClientRect();
    const r = Math.max(0.15, Math.min(0.85, (e.clientY - box.top) / box.height));
    setV(r);
    S.vRatio = r;
  }, () => { if (S.vRatio) store.set('vsplit', S.vRatio); });
  // your PDF on top, the other version's below
  const pm = $('#pdfMain'), pr = $('#pdfRef');
  const setP = (r) => { pm.style.flex = grow(r); pr.style.flex = grow(1 - r); };
  setP(store.get('pdfSplit', 0.5));
  dragger($('#pdfSplit'), (e) => {
    const box = $('#pdfCol').getBoundingClientRect();
    const r = Math.max(0.12, Math.min(0.88, (e.clientY - box.top) / box.height));
    setP(r);
    S.pRatio = r;
  }, () => { if (S.pRatio) store.set('pdfSplit', S.pRatio); });
  setLayout(store.get('layout', 'split'));
}

// ------------------------------------------------------------------ drag from the desktop
let veil = null;
function showVeil(text) { if (!veil) { veil = h('div.drop-veil'); document.body.appendChild(veil); } veil.textContent = text; }
function hideVeil() { if (veil) { veil.remove(); veil = null; } }
function bindDesktopDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; depth++; showVeil('Drop on the editor to insert a figure, or on a folder to add the files'); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hideVeil(); });
  window.addEventListener('drop', (e) => { depth = 0; hideVeil(); if (e.dataTransfer.files.length && !e.defaultPrevented) { e.preventDefault(); uploadFiles([...e.dataTransfer.files], ''); } });
  window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  $('#cmHost').addEventListener('drop', () => { depth = 0; hideVeil(); }, true);
}

// ------------------------------------------------------------------ wiring
function bindUI() {
  $('#compileBtn').onclick = () => compile();
  $('#pdfEmptyCompile').onclick = () => compile();
  $('#compileMenuBtn').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.right - 240, r.bottom + 6, [
      { label: 'Compile now', icon: 'play', kbd: 'Mod+Enter', run: compile },
      '-',
      { label: 'Compile on Ctrl+S', check: settings.compileOnSave, run: () => setSetting('compileOnSave', !settings.compileOnSave) },
      { label: 'Compile while typing', check: settings.autoCompile, run: () => setSetting('autoCompile', !settings.autoCompile) },
      { label: 'Show box warnings', check: settings.showBoxes, run: () => { setSetting('showBoxes', !settings.showBoxes); S.kinds[settings.showBoxes ? 'add' : 'delete']('box'); renderProblems(); $$('.filter[data-kind="box"]').forEach((b) => b.classList.toggle('on', settings.showBoxes)); } },
      '-',
      { label: 'Problems panel', icon: 'triangle-alert', kbd: 'Mod+Shift+M', run: () => toggleDrawer(true) },
      { label: 'Raw log', icon: 'file-text', run: () => { toggleDrawer(true); setDtab('log'); } },
      { label: 'Set the main document…', icon: 'house', run: pickMain },
    ]);
  };
  $('#statusChip').onclick = () => toggleDrawer();
  $('#sbProblems').onclick = () => toggleDrawer();
  $('#drawerClose').onclick = () => toggleDrawer(false);
  $$('.dtab').forEach((b) => (b.onclick = () => setDtab(b.dataset.dtab)));
  if (settings.showBoxes) S.kinds.add('box');
  $$('.filter').forEach((b) => {
    b.classList.toggle('on', S.kinds.has(b.dataset.kind));
    b.onclick = () => { const k = b.dataset.kind; if (S.kinds.has(k)) S.kinds.delete(k); else S.kinds.add(k); b.classList.toggle('on', S.kinds.has(k)); if (k === 'box') setSetting('showBoxes', S.kinds.has('box')); renderProblems(); };
  });
  $('#paletteBtn').onclick = () => openQuick('>');
  $('#themeBtn').onclick = toggleTheme;
  $('#settingsBtn').onclick = showSettings;
  $('#projectBtn').onclick = openProjectDialog;
  $('#keysBtn').onclick = showKeys;
  $('#wordsBtn').onclick = showWords;
  $('#sbWords').onclick = showWords;
  $('#sbSpell').onclick = () => setSetting('spell', !settings.spell);
  $('#sbMain').onclick = pickMain;
  $$('#layoutSeg button').forEach((b) => (b.onclick = () => setLayout(b.dataset.layout)));
  $$('.activity [data-view]').forEach((b) => (b.onclick = () => showView(b.dataset.view, undefined, true)));
  $('#newFileBtn').onclick = () => newFile('');
  $('#newDirBtn').onclick = () => newDir('');
  $('#uploadBtn').onclick = () => pickUpload('');
  $('#floatsBtn').onclick = () => { settings.showFloats = !settings.showFloats; saveSettings(); $('#floatsBtn').classList.toggle('on', settings.showFloats); rebuildIndex(); };
  $('#floatsBtn').classList.add('tog');
  $('#floatsBtn').classList.toggle('on', settings.showFloats);
  $('#syncToPdf').onclick = () => syncToPdf();
  $('#syncToCode').onclick = () => syncToCode();
  $('#searchInput').addEventListener('input', runSearch);
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch.flush(); });
  $('#searchCase').onclick = () => { S.searchOpts.case = !S.searchOpts.case; syncSearchToggles(); runSearch(); };
  $('#searchWord').onclick = () => { S.searchOpts.word = !S.searchOpts.word; syncSearchToggles(); runSearch(); };
  $('#searchRegex').onclick = () => { S.searchOpts.regex = !S.searchOpts.regex; syncSearchToggles(); runSearch(); };
  $('#replaceAllBtn').onclick = replaceAll;
  $('#gitRefresh').onclick = refreshGit;
  // the Assistant
  $('#chatSend').onclick = sendChat;
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); } });
  $('#chatInput').addEventListener('input', autosizeChat);
  $('#asstConnect').onclick = showConnect;
  $('#asstClear').onclick = async () => { if (await confirmDialog({ title: 'Clear the conversation', message: 'Remove all messages from the Assistant panel? Your agent keeps its own memory of them.', okText: 'Clear' })) api('/api/chat/clear', {}); };
  // the other version's PDF
  $('#refZoomIn').onclick = () => C.pdf && C.pdf.zoomBy(1.15);
  $('#refZoomOut').onclick = () => C.pdf && C.pdf.zoomBy(1 / 1.15);
  $('#refZoomFit').onclick = () => C.pdf && C.pdf.setMode('width');
  $('#refSync').onclick = () => refToCode();
  $('#refRecompile').onclick = () => loadRefPdf(true);
  $('#refHide').onclick = () => { setRefPdfVisible(false); toast('The comparison stays on. Show the PDF again from the Compare panel.'); };
  const rpin = $('#refPageInput');
  rpin.addEventListener('keydown', (e) => { if (e.key === 'Enter' && C.pdf) { C.pdf.goToPage(parseInt(rpin.value, 10) || 1); rpin.blur(); } });
  rpin.addEventListener('focus', () => rpin.select());
  $('#cmpRefresh').onclick = async () => { if (C.ref) { const root = C.ref.root; await openCompare(root, true); toast('Reloaded ' + C.ref.name); } };
  syncSearchToggles();

  // PDF toolbar
  const zs = $('#zoomSelect');
  const mode0 = store.get('zoom', 'width');
  pdf.mode = typeof mode0 === 'number' ? mode0 : mode0;
  zs.value = typeof mode0 === 'number' ? String(mode0) : mode0;
  zs.onchange = () => {
    const v = zs.value;
    const mode = v === 'width' || v === 'page' ? v : parseFloat(v);
    pdf.setMode(mode);
    store.set('zoom', mode);
  };
  $('#zoomIn').onclick = () => pdf.zoomBy(1.15);
  $('#zoomOut').onclick = () => pdf.zoomBy(1 / 1.15);
  $('#pdfDark').onclick = () => setSetting('pdfDark', !settings.pdfDark);
  const pin = $('#pageInput');
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { pdf.goToPage(parseInt(pin.value) || 1); pin.blur(); } });
  pin.addEventListener('focus', () => pin.select());

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });
  window.addEventListener('focus', () => poll());
  window.addEventListener('beforeunload', (e) => { if (S.dirty.size) { saveAll(); e.preventDefault(); e.returnValue = ''; } });

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let done = true;
    if (mod && !e.shiftKey && !e.altKey && k === 's') ctrlS();
    else if (mod && k === 'enter' && !e.target.closest('textarea')) compile();
    else if (mod && !e.shiftKey && k === 'p') openQuick('');
    else if ((mod && e.shiftKey && k === 'p') || e.key === 'F1') openQuick('>');
    else if (mod && e.shiftKey && k === 'f') showView('search', true);
    else if (mod && e.shiftKey && k === 'o') openQuick('@');
    else if (mod && e.shiftKey && k === 'e') showView('files', true);
    else if (mod && e.shiftKey && k === 'm') toggleDrawer();
    else if (mod && e.shiftKey && k === 'a') showView('assistant', true);
    else if (mod && !e.shiftKey && k === 'j') syncToPdf();
    else if (e.key === 'F7' && C.ref && activeKind() === 'text') { if (e.shiftKey) editor.prevChange(); else editor.nextChange(); }
    else if (mod && k === ',') showSettings();
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

function setDtab(name) {
  S.dtab = name;
  $$('.dtab').forEach((b) => b.classList.toggle('on', b.dataset.dtab === name));
  $('#problems').hidden = name !== 'problems';
  $('#log').hidden = name !== 'log';
  $('#probFilters').style.visibility = name === 'problems' ? 'visible' : 'hidden';
}

// ------------------------------------------------------------------ start
async function loadProject() {
  const p = await api('/api/project');
  S.project = p;
  S.files = p.files;
  S.fileMap = new Map(p.files.map((f) => [f.path, f]));
  const texts = await api('/api/texts');
  for (const [k, v] of Object.entries(texts)) S.texts.set(k, v);
  for (const k of S.texts.keys()) rescan(k);
  const savedDirs = store.get('dirs', {})[p.root];
  if (savedDirs) S.openDirs = new Set(savedDirs);
  else {
    const dirs = p.files.filter((f) => f.kind === 'dir');
    if (p.files.length < 80) dirs.forEach((d) => S.openDirs.add(d.path));
    let d = dirname(p.main);
    while (d) { S.openDirs.add(d); d = dirname(d); }
  }
  document.title = `${p.name} · Scriptorium`;
  $('#projectName').textContent = p.name;
  $('#projectBtn').title = p.root + ' (open another project)';
  rebuildIndex();
  renderTree();
  renderProblems();
  renderStatus();
  refreshGit();
}

async function boot() {
  fillIcons();
  applyTheme();
  document.documentElement.style.setProperty('--editor-size', settings.fontSize + 'px');
  let first = null;
  try { first = await api('/api/project'); } catch (e) { /* shown below */ }
  if (!first) { document.title = 'Scriptorium'; showWelcome(false); return; }
  editor = createEditor($('#cmHost'), hooks, settings);
  pdf = new PdfView({
    scroll: $('#pdfScroll'), pages: $('#pdfPages'), empty: $('#pdfEmpty'),
    onPage: (n, total) => { if (document.activeElement !== $('#pageInput')) $('#pageInput').value = n; $('#pageCount').textContent = '/ ' + total; },
    onDblClick: (p) => syncToCode(p),
    onZoom: (scale) => {
      const zs = $('#zoomSelect');
      if (typeof pdf.mode === 'number') {
        const v = String(Math.round(pdf.mode * 100) / 100);
        if ([...zs.options].some((o) => o.value === v)) zs.value = v;
        else { const c = zs.querySelector('option[value="custom"]'); c.hidden = false; c.textContent = Math.round(pdf.mode * 100) + '%'; zs.value = 'custom'; }
      }
      void scale;
    },
  });
  pdf.setDark(settings.pdfDark);
  bindUI();
  bindLayout();
  bindTreeDnD();
  bindDesktopDrop();
  setDtab('problems');
  applySettings();
  await loadProject();
  startAssistant();
  const saved = store.get('tabs', {})[S.project.root];
  if (saved && saved.tabs.length) {
    S.tabs = saved.tabs.filter((t) => S.fileMap.has(t.path));
    const act = S.tabs.find((t) => tabKey(t) === saved.active) || S.tabs[0];
    if (act) await openFile(act.path, { focus: true });
  }
  if (!S.tabs.length && has(mainPath())) await openFile(mainPath());
  if (!S.tabs.length) activate(null);
  const cmp = cmpSaved();
  if (cmp) { C.showDiff = cmp.showDiff !== false; C.showPdf = cmp.showPdf !== false; openCompare(cmp.root, true); }
  if (S.project.pdf_mtime) {
    S.pdfMtime = S.project.pdf_mtime;
    setChip('', 'PDF from the last session');
    await pdf.load('/pdf?v=' + S.pdfMtime);
  }
  if (has(mainPath())) compile();
  window.scriptorium = { S, editor, pdf };
  setInterval(poll, 2500);
  setInterval(() => { if (S.view === 'git' && document.visibilityState === 'visible') refreshGit(); }, 15000);
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:auto 16px 40px auto;padding:12px 16px;background:#c8321f;color:#fff;border-radius:8px;z-index:999">Scriptorium could not start: ${esc(e.message)}</div>`);
});

void EditorState; void CITE_CMDS; void REF_CMDS;
