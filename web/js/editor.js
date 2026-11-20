// The source editor: CodeMirror 6 with a LaTeX mode, completion, hover cards, live math preview and diagnostics.
import { EditorState, Compartment, StateField, StateEffect, Facet, Prec, Annotation, EditorSelection, RangeSet } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, ViewPlugin, hoverTooltip, showTooltip,
  gutter, GutterMarker,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, foldKeymap, foldService,
  indentOnInput, indentService, indentUnit,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippet, startCompletion } from '@codemirror/autocomplete';
import { linter, lintGutter, lintKeymap, forceLinting } from '@codemirror/lint';
import { Tag } from '@lezer/highlight';
import { SECTION_LEVELS, REF_CMDS, CITE_CMDS, INPUT_CMDS, GRAPHICS_CMDS, BIB_CMDS, MATH_ENVS, VERBATIM_ENVS, mathRegions, regionAt, braceArg } from './latex.js';
import { COMMANDS, ENVIRONMENTS } from './commands.js';
import { icon } from './dom.js';
import { unifiedMergeView, getChunks, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';

export { forceLinting };
export const external = Annotation.define(); // marks changes that came from disk, not from typing
export const pathFacet = Facet.define({ combine: (v) => v[0] || null });

// ------------------------------------------------------------------ highlighting
const NAMES = ['cmd', 'sec', 'h1', 'h2', 'h3', 'env', 'envname', 'key', 'math', 'mathcmd', 'mathdelim', 'comment', 'brace', 'special', 'verb', 'opt'];
const T = Object.fromEntries(NAMES.map((n) => [n, Tag.define()]));
const CLASS = { cmd: 'tx-cmd', sec: 'tx-sec', h1: 'tx-h1', h2: 'tx-h2', h3: 'tx-h3', env: 'tx-env', envname: 'tx-envname', key: 'tx-key', math: 'tx-math', mathcmd: 'tx-mathcmd', mathdelim: 'tx-mathdelim', comment: 'tx-comment', brace: 'tx-brace', special: 'tx-special', verb: 'tx-verb', opt: 'tx-brace' };
const highlight = HighlightStyle.define(NAMES.map((n) => ({ tag: T[n], class: CLASS[n] })));

const KEYCMDS = new Set([...REF_CMDS, ...CITE_CMDS, ...INPUT_CMDS, ...GRAPHICS_CMDS, ...BIB_CMDS, 'label', 'usepackage', 'RequirePackage', 'documentclass', 'bibliographystyle', 'url', 'graphicspath']);
const HEAD_LEVEL = (name) => (SECTION_LEVELS[name] <= 1 ? 1 : SECTION_LEVELS[name] === 2 ? 2 : 3);

const latexMode = {
  name: 'latex',
  startState: () => ({ math: null, verb: null, pending: null, arg: null, depth: 0, level: 1, envBegin: false, envName: '' }),
  token(stream, s) {
    if (s.verb) {
      const endStr = '\\end{' + s.verb + '}';
      if (stream.match(endStr)) { s.verb = null; return 'env'; }
      const idx = stream.string.indexOf(endStr, stream.pos);
      if (idx > stream.pos) stream.pos = idx; else stream.skipToEnd();
      return 'verb';
    }
    if (s.arg === 'key' || s.arg === 'env') {
      if (stream.eat('}')) {
        const was = s.arg;
        s.arg = null;
        if (was === 'env' && s.envBegin) {
          const name = s.envName.trim();
          if (MATH_ENVS.has(name) && !s.math) s.math = 'env:' + name;
          else if (VERBATIM_ENVS.has(name)) s.verb = name;
        }
        return 'brace';
      }
      if (stream.match(/^[^}%]+/)) { if (s.arg === 'env') s.envName += stream.current(); return s.arg === 'env' ? 'envname' : 'key'; }
      if (stream.peek() === '%') { stream.skipToEnd(); return 'comment'; }
      stream.next();
      return 'key';
    }
    if (s.pending) {
      if (stream.eatSpace()) return null;
      const c = stream.peek();
      if (c === '*') { stream.next(); return s.pending === 'heading' ? 'sec' : 'cmd'; }
      if (c === '[' && stream.match(/^\[[^\]\n]*\]?/)) return 'opt';
      if (c === '{') {
        stream.next();
        if (s.pending === 'heading') { s.arg = 'heading'; s.depth = 1; } else { s.arg = s.pending; s.envName = ''; }
        s.pending = null;
        return 'brace';
      }
      s.pending = null;
    }
    const ch = stream.peek();
    if (ch === '%') { stream.skipToEnd(); return 'comment'; }
    if (ch === '\\') {
      if (stream.match(/^\\[a-zA-Z@]+/)) {
        const name = stream.current().slice(1);
        if (name === 'verb' || name === 'lstinline') {
          const d = stream.next();
          if (d) { const close = d === '{' ? '}' : d; while (!stream.eol() && stream.next() !== close); }
          return 'verb';
        }
        if (s.math) {
          if (name === 'end' && s.math.startsWith('env:')) {
            const env = s.math.slice(4);
            if (stream.match('{' + env + '}')) { s.math = null; return 'env'; }
          }
          return 'mathcmd';
        }
        if (name in SECTION_LEVELS) { s.pending = 'heading'; s.level = HEAD_LEVEL(name); return 'sec'; }
        if (name === 'begin' || name === 'end') { s.pending = 'env'; s.envBegin = name === 'begin'; return 'env'; }
        if (KEYCMDS.has(name)) { s.pending = 'key'; return 'cmd'; }
        return 'cmd';
      }
      if (stream.match('\\[')) { if (!s.math) { s.math = '\\]'; return 'mathdelim'; } return 'mathcmd'; }
      if (stream.match('\\(')) { if (!s.math) { s.math = '\\)'; return 'mathdelim'; } return 'mathcmd'; }
      if (stream.match('\\]')) { if (s.math === '\\]') { s.math = null; return 'mathdelim'; } return s.math ? 'mathcmd' : 'special'; }
      if (stream.match('\\)')) { if (s.math === '\\)') { s.math = null; return 'mathdelim'; } return s.math ? 'mathcmd' : 'special'; }
      stream.next(); stream.next();
      return s.math ? 'mathcmd' : 'special';
    }
    if (ch === '$') {
      if (stream.match('$$')) {
        if (!s.math) { s.math = '$$'; return 'mathdelim'; }
        if (s.math === '$$') { s.math = null; return 'mathdelim'; }
        if (s.math === '$') { s.math = null; stream.backUp(1); return 'mathdelim'; }
        return 'math';
      }
      stream.next();
      if (!s.math) { s.math = '$'; return 'mathdelim'; }
      if (s.math === '$') { s.math = null; return 'mathdelim'; }
      return 'math';
    }
    if (ch === '{' || ch === '}') {
      stream.next();
      if (s.arg === 'heading') { s.depth += ch === '{' ? 1 : -1; if (s.depth <= 0) s.arg = null; }
      return 'brace';
    }
    if (s.math) {
      if (stream.match(/^[\^_&]/)) return 'mathcmd';
      if (stream.match(/^[^\\%${}^_&]+/)) return 'math';
      stream.next();
      return 'math';
    }
    if (ch === '&' || ch === '~' || ch === '#' || ch === '^' || ch === '_') { stream.next(); return 'special'; }
    if (stream.match(/^[^\\%${}&~#^_]+/)) return s.arg === 'heading' ? 'h' + s.level : null;
    stream.next();
    return s.arg === 'heading' ? 'h' + s.level : null;
  },
  blankLine(s) { if (s.math === '$') s.math = null; s.pending = null; if (s.arg === 'heading') s.arg = null; },
  tokenTable: T,
  languageData: { commentTokens: { line: '%' }, closeBrackets: { brackets: ['(', '[', '{', '$'] }, indentOnInput: /^\s*\\end\s*\{[^}]*\}$/ },
};
export const latexLanguage = StreamLanguage.define(latexMode);

// ------------------------------------------------------------------ shared per-document analysis
const regionCache = new WeakMap();
export function regionsOf(state) {
  let r = regionCache.get(state.doc);
  if (!r) { r = mathRegions(state.doc.toString()); regionCache.set(state.doc, r); }
  return r;
}

// What is under a position: a \ref/\cite key, a file, an environment, a math region, a command.
export function contextAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  const off = pos - line.from;
  const re = /\\([a-zA-Z]+)\*?((?:\[[^\]]*\])*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (off < m.index || off > end) continue;
    const name = m[1];
    const type = REF_CMDS.has(name) ? 'ref' : CITE_CMDS.has(name) ? 'cite' : name === 'label' ? 'label' : INPUT_CMDS.has(name) ? 'input'
      : GRAPHICS_CMDS.has(name) ? 'graphics' : BIB_CMDS.has(name) ? 'bib' : null;
    if (!type) continue;
    const argFrom = end - 1 - m[3].length;
    let s = argFrom;
    for (const part of m[3].split(',')) {
      const e = s + part.length;
      if (off >= s && off <= e && off >= argFrom) {
        const lead = part.length - part.trimStart().length;
        const key = part.trim();
        return { type, cmd: name, key, from: line.from + s + lead, to: line.from + s + lead + key.length };
      }
      s = e + 1;
    }
    const keys = m[3].split(',').map((x) => x.trim()).filter(Boolean);
    return { type, cmd: name, key: keys[0] || '', keys, from: line.from + m.index, to: line.from + end };
  }
  const r = regionAt(regionsOf(state), pos);
  if (r && !r.verbatim && r.innerTo > r.innerFrom && pos >= r.from && pos <= r.to) return { type: 'math', region: r, from: r.from, to: r.to };
  const w = /\\[a-zA-Z@]+/g;
  while ((m = w.exec(text))) if (off >= m.index && off <= m.index + m[0].length) return { type: 'macro', name: m[0], from: line.from + m.index, to: line.from + m.index + m[0].length };
  return null;
}

// ------------------------------------------------------------------ math rendering (KaTeX)
const ENV_FOR_KATEX = { eqnarray: 'align', 'eqnarray*': 'align*', multline: 'gather', 'multline*': 'gather*', flalign: 'align', 'flalign*': 'align*', dmath: null, 'dmath*': null, displaymath: null, math: null };
export function renderMath(el, r, text, macros) {
  let src = text.slice(r.innerFrom, r.innerTo).replace(/\\label\s*\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '').replace(/\\intertext\{[^}]*\}/g, '');
  if (r.env) {
    const e = r.env in ENV_FOR_KATEX ? ENV_FOR_KATEX[r.env] : r.env;
    if (e) src = `\\begin{${e}}${src}\\end{${e}}`;
  }
  if (!window.katex) { el.textContent = src; return; }
  try {
    window.katex.render(src, el, { displayMode: r.display, throwOnError: false, strict: 'ignore', trust: false, macros: { ...macros }, errorColor: 'currentColor', output: 'htmlAndMathml' });
  } catch (e) {
    el.textContent = String(e.message || e);
  }
}

// ------------------------------------------------------------------ the extensions

const wrapComp = new Compartment();
const spellComp = new Compartment();
const mathTipComp = new Compartment();
export const setCompileMarks = StateEffect.define();

const compileMarks = StateField.define({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setCompileMarks)) return e.value;
    if (tr.docChanged && v.length) {
      const len = tr.state.doc.length;
      return v.map((d) => {
        const from = Math.min(len, tr.changes.mapPos(d.from, 1));
        return { ...d, from, to: Math.max(from, Math.min(len, tr.changes.mapPos(d.to, -1))) };
      });
    }
    return v;
  },
});
export function compileMarksOf(state) { return state.field(compileMarks, false) || []; }

// ------------------------------------------------------------------ changes since the last commit, in the margin
export const setGitBase = StateEffect.define();   // the file's text at HEAD, or null when not in git
const setGitMarks = StateEffect.define();
const gitBase = StateField.define({
  create: () => null,
  update(v, tr) { for (const e of tr.effects) if (e.is(setGitBase)) return e.value; return v; },
});
const gitMarks = StateField.define({
  create: () => RangeSet.empty,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setGitMarks)) return e.value;
    return tr.docChanged ? v.map(tr.changes) : v;
  },
});
class GitMarker extends GutterMarker {
  constructor(kind) { super(); this.kind = kind; }
  eq(o) { return o.kind === this.kind; }
  toDOM() { const d = document.createElement('div'); d.className = 'cm-git cm-git-' + this.kind; d.title = { add: 'Added since the last commit', mod: 'Changed since the last commit', del: 'Lines deleted here since the last commit' }[this.kind]; return d; }
}
const MARK = { add: new GitMarker('add'), mod: new GitMarker('mod'), del: new GitMarker('del') };

// Which lines of b are added or changed relative to a, and where lines were deleted. Returns [[line, kind]].
export function lineChanges(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  const out = [];
  if (!A.length && !B.length) return out;
  if (!A.length) { for (let j = 0; j < B.length; j++) out.push([s + j + 1, 'add']); return out; }
  if (!B.length) { out.push([Math.min(s + 1, b.length), 'del']); return out; }
  const n = A.length, m = B.length;
  if (n * m > 4e6) { for (let j = 0; j < m; j++) out.push([s + j + 1, 'mod']); return out; }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, dels = 0;
  const flushDel = () => { if (dels) { out.push([Math.min(s + j + 1, b.length), 'del']); dels = 0; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flushDel(); i++; j++; }
    else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) { dels++; i++; }  // deletions first, so a replaced line reads as changed
    else {
      if (dels) { out.push([s + j + 1, 'mod']); dels--; } else out.push([s + j + 1, 'add']);
      j++;
    }
  }
  flushDel();
  return out;
}

const gitPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.t = null; this.schedule(0); }
  update(u) {
    if (u.docChanged || u.startState.field(gitBase, false) !== u.state.field(gitBase, false)) this.schedule(350);
  }
  schedule(ms) { clearTimeout(this.t); this.t = setTimeout(() => this.compute(), ms); }
  compute() {
    const state = this.view.state;
    const base = state.field(gitBase, false);
    let set = RangeSet.empty;
    if (base != null) {
      const marks = lineChanges(base.split('\n'), state.doc.toString().split('\n'));
      const seen = new Set();
      set = RangeSet.of(marks.filter(([ln]) => ln >= 1 && ln <= state.doc.lines && !seen.has(ln) && seen.add(ln))
        .map(([ln, kind]) => MARK[kind].range(state.doc.line(ln).from)), true);
    }
    const cur = state.field(gitMarks, false);
    if (cur && (cur.size || set.size)) this.view.dispatch({ effects: setGitMarks.of(set) });
  }
  destroy() { clearTimeout(this.t); }
});
const gitGutter = [gitBase, gitMarks, gitPlugin, gutter({ class: 'cm-git-gutter', markers: (v) => v.state.field(gitMarks, false) || RangeSet.empty })];

// Formatting commands whose argument the editor shows bold, italic, ...
const FMT = {
  textbf: Decoration.mark({ class: 'tx-bold' }), bfseries: null,
  textit: Decoration.mark({ class: 'tx-ital' }), emph: Decoration.mark({ class: 'tx-ital' }), textsl: Decoration.mark({ class: 'tx-ital' }),
  underline: Decoration.mark({ class: 'tx-under' }),
  texttt: Decoration.mark({ class: 'tx-tt' }),
};
const noSpell = Decoration.mark({ attributes: { spellcheck: 'false' } });
const mathLine = Decoration.line({ class: 'cm-mathline' });
const KEYARG = new Set([...KEYCMDS, 'begin', 'end', 'ref', 'hypersetup', 'definecolor', 'color', 'textcolor', 'newcommand', 'renewcommand', 'setlength', 'includegraphics', 'href', 'cmidrule', 'multicolumn', 'IEEEauthorrefmark']);

function buildDecorations(view) {
  const ranges = [];
  const doc = view.state.doc;
  const regions = regionsOf(view.state);
  for (const { from, to } of view.visibleRanges) {
    let lastLine = -1;
    for (const r of regions) {
      if (r.to < from) continue;
      if (r.from > to) break;
      const a = Math.max(r.from, from), b = Math.min(r.to, to);
      if (b > a) ranges.push(noSpell.range(a, b));
      if (r.display && !r.verbatim) {
        for (let p = doc.lineAt(a).from; p <= b;) {
          const ln = doc.lineAt(p);
          if (ln.number !== lastLine) ranges.push(mathLine.range(ln.from));
          lastLine = ln.number;
          if (ln.to + 1 > doc.length) break;
          p = ln.to + 1;
        }
      }
    }
    const text = doc.sliceString(from, to);
    const re = /\\([a-zA-Z@]+)\*?/g;
    let m;
    while ((m = re.exec(text))) {
      const a = from + m.index;
      ranges.push(noSpell.range(a, a + m[0].length));
      const name = m[1];
      let k = m.index + m[0].length;
      if (KEYARG.has(name)) {
        while (text[k] === '[') { const e = text.indexOf(']', k); if (e < 0) break; k = e + 1; }
        if (text[k] === '{') { const e = text.indexOf('}', k); if (e > k) ranges.push(noSpell.range(from + k, from + e + 1)); }
      }
      const fmt = FMT[name];
      if (fmt && text[k] === '{') {
        const arg = braceArg(text, k);
        if (arg && arg[1] > arg[0]) ranges.push(fmt.range(from + arg[0], from + arg[1]));
      }
    }
    const cre = /(^|[^\\])(%.*)$/gm;
    while ((m = cre.exec(text))) {
      const a = from + m.index + m[1].length;
      ranges.push(noSpell.range(a, from + m.index + m[0].length));
    }
  }
  return Decoration.set(ranges, true);
}

const visual = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildDecorations(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view); }
}, { decorations: (v) => v.decorations });

// Folding: environments, and sections down to the next heading of the same or higher level.
const SEC_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[[{]/;
const folding = foldService.of((state, from) => {
  const line = state.doc.lineAt(from);
  const text = line.text;
  let m = /^\s*\\begin\s*\{([^}]+)\}/.exec(text);
  if (m && m[1] !== 'document') {
    const name = m[1];
    let depth = 0;
    const last = Math.min(state.doc.lines, line.number + 4000);
    for (let n = line.number; n <= last; n++) {
      const t = state.doc.line(n).text;
      const re = /\\(begin|end)\s*\{([^}]+)\}/g;
      let mm;
      while ((mm = re.exec(t))) {
        if (mm[2] !== name) continue;
        depth += mm[1] === 'begin' ? 1 : -1;
        if (depth === 0) {
          if (n <= line.number + 1) return null;
          return { from: line.to, to: state.doc.line(n - 1).to };
        }
      }
    }
    return null;
  }
  m = SEC_RE.exec(text);
  if (m) {
    const lvl = SECTION_LEVELS[m[1]];
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      const t = state.doc.line(n).text;
      const s = SEC_RE.exec(t);
      if ((s && SECTION_LEVELS[s[1]] <= lvl) || /^\s*\\(end\{document\}|bibliography\b|printbibliography\b|appendix\b)/.test(t)) {
        let e = n - 1;
        while (e > line.number && !state.doc.line(e).text.trim()) e--;
        return e > line.number ? { from: line.to, to: state.doc.line(e).to } : null;
      }
    }
    let e = state.doc.lines;
    while (e > line.number && !state.doc.line(e).text.trim()) e--;
    return e > line.number ? { from: line.to, to: state.doc.line(e).to } : null;
  }
  return null;
});

const indenting = indentService.of((cx, pos) => {
  const doc = cx.state.doc;
  let before;
  if (cx.simulatedBreak != null && cx.simulatedBreak === pos) before = cx.lineAt(pos, -1).text;
  else {
    const l = doc.lineAt(pos);
    if (l.number === 1) return 0;
    before = doc.line(l.number - 1).text;
  }
  const lead = /^\s*/.exec(before)[0];
  let ind = 0;
  for (const c of lead) ind = c === '\t' ? ind + cx.unit - (ind % cx.unit) : ind + 1;
  const opens = (before.match(/\\begin\s*\{(?!document\})[^}]*\}/g) || []).length;
  const closes = (before.match(/\\end\s*\{(?!document\})[^}]*\}/g) || []).length;
  const opened = opens > closes;
  if (opened) ind += cx.unit;
  const after = cx.textAfterPos(pos);
  if (/^\s*\\end\s*\{/.test(after) && !/^\s*\\end\s*\{document\}/.test(after)) ind = opened ? ind - cx.unit : Math.max(0, ind - cx.unit);
  return Math.max(0, ind);
});

// Live math preview under the equation the cursor is in.
function mathTipView(view, hooks) {
  const dom = document.createElement('div');
  dom.className = 'math-tip';
  let last = '';
  const render = (state) => {
    const r = regionAt(regionsOf(state), state.selection.main.head);
    if (!r || r.verbatim) return;
    const src = state.doc.sliceString(r.from, r.to);
    if (src === last) return;
    last = src;
    renderMath(dom, { ...r, innerFrom: r.innerFrom - r.from, innerTo: r.innerTo - r.from }, src, hooks.macros());
  };
  render(view.state);
  return { dom, offset: { x: 0, y: 6 }, update(u) { if (u.docChanged || u.selectionSet) render(u.state); } };
}
function mathTipField(hooks) {
  const compute = (state, prev) => {
    const sel = state.selection.main;
    if (!sel.empty) return null;
    const r = regionAt(regionsOf(state), sel.head);
    if (!r || r.verbatim || sel.head < r.innerFrom || sel.head > r.innerTo || r.innerTo - r.innerFrom < 1) return null;
    if (prev && prev.regionFrom === r.from) return prev;
    return { pos: r.from, above: true, strictSide: false, arrow: false, regionFrom: r.from, create: (view) => mathTipView(view, hooks) };
  };
  return StateField.define({
    create: (state) => compute(state, null),
    update: (v, tr) => (tr.docChanged || tr.selection ? compute(tr.state, v) : v),
    provide: (f) => showTooltip.from(f),
  });
}

// ------------------------------------------------------------------ completion
function wrapApply(tpl, again) {
  const sn = snippet(tpl);
  return (view, c, from, to) => {
    sn(view, c, from, to);
    if (again) setTimeout(() => startCompletion(view), 0);
  };
}

let commandOptionsCache = null;
function commandOptions() {
  if (commandOptionsCache) return commandOptionsCache;
  commandOptionsCache = COMMANDS.map((c) => {
    const hasField = c.tpl.includes('${');
    const again = /^\\(ref|eqref|cref|Cref|autoref|pageref|cite[a-z]*|parencite|textcite|autocite|nocite|input|include|includegraphics|bibliography|addbibresource)\{\$\{\}\}$/.test(c.tpl)
      || /^\\includegraphics\[[^\]]*\]\{\$\{\}\}$/.test(c.tpl);
    return { label: '\\' + c.name, detail: c.info, type: c.math ? 'keyword' : 'function', apply: hasField ? wrapApply(c.tpl, again) : c.tpl, math: c.math };
  });
  commandOptionsCache.push({
    label: '\\begin', detail: 'Environment', type: 'class', boost: 2,
    apply: (view, c, from, to) => { view.dispatch({ changes: { from, to, insert: '\\begin{}' }, selection: { anchor: from + 7 } }); setTimeout(() => startCompletion(view), 0); },
  });
  return commandOptionsCache;
}

const ENV_NAMES = Object.keys(ENVIRONMENTS);
function envApply(name) {
  return (view, c, from, to) => {
    let end = to;
    if (view.state.doc.sliceString(to, to + 1) === '}') end = to + 1;
    const body = ENVIRONMENTS[name] ?? '\n\t${}';
    const b = /^[[{]/.test(body) || body.startsWith('\n') ? body : '\n' + body;
    snippet(`${name}}${b}\n\\end{${name}}`)(view, c, from, end);
  };
}
function endApply(name) {
  return (view, c, from, to) => {
    let end = to;
    if (view.state.doc.sliceString(to, to + 1) === '}') end = to + 1;
    view.dispatch({ changes: { from, to: end, insert: name + '}' }, selection: { anchor: from + name.length + 1 } });
  };
}

function latexCompletions(hooks) {
  return (cx) => {
    const line = cx.state.doc.lineAt(cx.pos);
    const before = line.text.slice(0, cx.pos - line.from);
    let m = /\\([a-zA-Z]+)\*?(?:\[[^\]]*\])*\{([^{}]*)$/.exec(before);
    if (m) {
      const cmd = m[1], arg = m[2];
      const partial = arg.slice(arg.lastIndexOf(',') + 1).replace(/^\s+/, '');
      const from = cx.pos - partial.length;
      let options = null;
      if (REF_CMDS.has(cmd)) options = hooks.labelOptions();
      else if (CITE_CMDS.has(cmd)) options = hooks.citeOptions();
      else if (cmd === 'begin') {
        const known = new Set(ENV_NAMES);
        options = [...ENV_NAMES, ...hooks.usedEnvironments().filter((e) => !known.has(e))].map((e) => ({ label: e, type: 'class', apply: envApply(e), boost: ENVIRONMENTS[e] ? 1 : 0 }));
      } else if (cmd === 'end') {
        const open = hooks.openEnvironment(cx.state, cx.pos);
        const names = [...new Set([...(open ? [open] : []), ...ENV_NAMES])];
        options = names.map((e) => ({ label: e, type: 'class', apply: endApply(e), boost: e === open ? 10 : 0 }));
      } else if (INPUT_CMDS.has(cmd)) options = hooks.fileOptions('tex');
      else if (GRAPHICS_CMDS.has(cmd)) options = hooks.fileOptions('image');
      else if (BIB_CMDS.has(cmd)) options = hooks.fileOptions('bib');
      else if (cmd === 'usepackage' || cmd === 'RequirePackage') options = PACKAGES.map((p) => ({ label: p, type: 'namespace' }));
      if (options) return { from, options, validFor: /^[^,}\s]*$/ };
      return null;
    }
    m = /\\[a-zA-Z@]*$/.exec(before);
    if (m) {
      const r = regionAt(regionsOf(cx.state), cx.pos);
      const inMath = !!(r && !r.verbatim && cx.pos > r.from);
      const opts = commandOptions().map((o) => (o.math === undefined ? o : { ...o, boost: o.math === inMath ? 1 : -1 }));
      return { from: cx.pos - m[0].length, options: [...opts, ...hooks.macroOptions()], validFor: /^\\[a-zA-Z@]*$/ };
    }
    return null;
  };
}

const PACKAGES = ('amsmath amssymb amsthm mathtools graphicx xcolor hyperref cleveref booktabs tabularx multirow siunitx geometry fontenc inputenc babel '
  + 'microtype natbib biblatex csquotes caption subcaption float enumitem listings minted tikz pgfplots algorithm algorithmic algpseudocode '
  + 'url bm physics nicefrac xspace lipsum todonotes fancyhdr titlesec setspace array longtable threeparttable makecell acronym glossaries cite import').split(' ');

// ------------------------------------------------------------------ keys
function wrapWith(pre, post) {
  return (view) => {
    view.dispatch(view.state.changeByRange((r) => ({
      changes: [{ from: r.from, insert: pre }, { from: r.to, insert: post }],
      range: r.empty ? EditorSelection.cursor(r.from + pre.length) : EditorSelection.range(r.from + pre.length, r.to + pre.length),
    })));
    return true;
  };
}

// ------------------------------------------------------------------ public API
export function createEditor(parent, hooks, settings) {
  const base = [
    lintGutter(),
    lineNumbers(),
    highlightActiveLineGutter(),
    gitGutter,
    foldGutter({ markerDOM: (open) => { const s = document.createElement('span'); s.appendChild(icon(open ? 'chevron-down' : 'chevron-right')); s.style.display = 'grid'; s.querySelector('svg').style.cssText = 'width:12px;height:12px'; return s; } }),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),
    latexLanguage,
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [latexCompletions(hooks)], icons: true, maxRenderedOptions: 60, closeOnBlur: true, defaultKeymap: true }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches({ minSelectionLength: 2 }),
    search({ top: true }),
    folding,
    indenting,
    visual,
    compileMarks,
    linter((view) => hooks.diagnostics(view.state), { delay: 350 }),
    hoverTooltip((view, pos) => {
      const c = contextAt(view.state, pos);
      if (!c) return null;
      const sel = view.state.selection.main;
      if (c.type === 'math' && sel.empty && sel.head >= c.from && sel.head <= c.to) return null;
      const dom = hooks.hoverCard(c, view.state);
      if (!dom) return null;
      return { pos: c.from, end: c.to, above: true, create: () => ({ dom }) };
    }, { hoverTime: 320 }),
    mathTipComp.of(settings.mathPreview ? mathTipField(hooks) : []),
    compareComp.of([]),
    wrapComp.of(settings.wrap ? EditorView.lineWrapping : []),
    spellComp.of(spellAttrs(settings)),
    Prec.high(keymap.of([
      { key: 'Mod-b', run: wrapWith('\\textbf{', '}') },
      { key: 'Mod-i', run: wrapWith('\\emph{', '}') },
      { key: 'F12', run: (v) => hooks.gotoDefinition(v) },
    ])),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0 || e.altKey) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const c = contextAt(view.state, pos);
        if (!c || c.type === 'math') return false;
        if (hooks.goto(c)) { e.preventDefault(); return true; }
        return false;
      },
      paste(e, view) {
        const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        e.preventDefault();
        hooks.pasteFiles(files, view);
        return true;
      },
      drop(e, view) {
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        hooks.dropFiles(files, view, pos);
        return true;
      },
    }),
    EditorView.updateListener.of((u) => hooks.onUpdate(u)),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: base }) });

  return {
    view,
    makeState(text, path) {
      return EditorState.create({ doc: text, extensions: [base, pathFacet.of(path)] });
    },
    configure(s) {
      view.dispatch({ effects: [
        wrapComp.reconfigure(s.wrap ? EditorView.lineWrapping : []),
        spellComp.reconfigure(spellAttrs(s)),
        mathTipComp.reconfigure(s.mathPreview ? mathTipField(hooks) : []),
      ] });
    },
    // Show another version of this file inline: its text where it differs, with buttons to keep or take it.
    // original: that version's text, or null to stop comparing.
    setCompare(original, name) {
      const cur = view.state.facet(compareKey);
      const key = original == null ? null : name + '\u0000' + original.length + '\u0000' + hashText(original);
      if (cur === key) return;
      // the merge view keeps its original text across reconfigurations, so take it out before putting a new one in
      if (cur != null) view.dispatch({ effects: compareComp.reconfigure([]) });
      if (original == null) return;
      view.dispatch({ effects: compareComp.reconfigure([
        compareKey.of(key),
        unifiedMergeView({ original, highlightChanges: true, gutter: true, syntaxHighlightDeletions: true, mergeControls: true }),
        EditorState.phrases.of({ Accept: 'Keep mine', Reject: 'Use ' + name }),
      ]) });
    },
    compareInfo() {
      const c = getChunks(view.state);
      if (!c) return null;
      const head = view.state.selection.main.head;
      const at = c.chunks.findIndex((ch) => head >= ch.fromB && head <= Math.max(ch.toB, ch.fromB));
      const before = c.chunks.filter((ch) => ch.fromB < head).length;
      return { count: c.chunks.length, index: at >= 0 ? at + 1 : null, before };
    },
    nextChange: () => goToNextChunk(view),
    prevChange: () => goToPreviousChunk(view),
  };
}

const compareComp = new Compartment();
const compareKey = Facet.define({ combine: (v) => (v.length ? v[0] : null) });
function hashText(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function spellAttrs(s) {
  return EditorView.contentAttributes.of({ spellcheck: s.spell ? 'true' : 'false', lang: s.spellLang || 'en', autocorrect: 'off', autocapitalize: 'off' });
}

// A read-only editor setup for diffs.
export function viewerExtensions(settings) {
  return [lineNumbers(), latexLanguage, syntaxHighlighting(highlight), EditorView.editable.of(false), EditorState.readOnly.of(true), settings.wrap ? EditorView.lineWrapping : []];
}
