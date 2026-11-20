// Reading LaTeX source: comments, math, structure, labels, citations, bibliography, words. Pure functions.

export const SECTION_LEVELS = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
export const REF_CMDS = new Set(['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'cpageref', 'Cpageref', 'nameref', 'vref', 'Vref', 'labelcref', 'crefrange', 'Crefrange', 'subref']);
export const CITE_CMDS = new Set(['cite', 'citep', 'citet', 'citealt', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar', 'Citep', 'Citet',
  'parencite', 'Parencite', 'textcite', 'Textcite', 'autocite', 'Autocite', 'footcite', 'smartcite', 'supercite', 'nocite', 'fullcite', 'citenum']);
export const INPUT_CMDS = new Set(['input', 'include', 'subfile', 'InputIfFileExists', 'includeonly']);
export const GRAPHICS_CMDS = new Set(['includegraphics', 'includesvg', 'includepdf']);
export const BIB_CMDS = new Set(['bibliography', 'addbibresource', 'addglobalbib']);
export const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'displaymath', 'math', 'flalign', 'flalign*', 'alignat', 'alignat*', 'dmath', 'dmath*']);
export const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment', 'Verbatim', 'BVerbatim', 'filecontents', 'filecontents*']);
export const FLOAT_ENVS = new Set(['figure', 'figure*', 'table', 'table*', 'algorithm', 'wrapfigure', 'subfigure', 'sidewaystable', 'sidewaysfigure']);
export const IMAGE_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg', '.gif', '.webp'];

// Comments become spaces, so every position stays where it was.
export function stripComments(text) {
  let out = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const j = text.indexOf('%', i);
    if (j < 0) break;
    let bs = 0;
    for (let k = j - 1; k >= 0 && text.charCodeAt(k) === 92; k--) bs++;
    if (bs % 2 === 1) { i = j + 1; continue; }
    let e = text.indexOf('\n', j);
    if (e < 0) e = n;
    if (!out) out = text.split('');
    for (let k = j; k < e; k++) out[k] = ' ';
    i = e;
  }
  return out ? out.join('') : text;
}

// The argument in braces that starts at text[i] == '{'. Returns [contentFrom, contentTo, end] or null.
export function braceArg(text, i) {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === '\\') { k++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return [i + 1, k, k + 1]; }
    else if (c === '\n' && text[k + 1] === '\n' && depth > 0 && k - i > 4000) return null;
  }
  return null;
}

// Skip spaces, optional [..] arguments and a star after a command name.
function skipOpts(text, i) {
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '*') { i++; continue; }
    if (text[i] === '[') {
      let d = 0, k = i;
      for (; k < text.length; k++) {
        if (text[k] === '[') d++;
        else if (text[k] === ']') { d--; if (d === 0) break; }
        else if (text[k] === '\n' && text[k + 1] === '\n') break;
      }
      i = k + 1;
      continue;
    }
    if (text[i] === '\n' && text[i + 1] !== '\n') { i++; continue; }
    return i;
  }
}

export function lineStarts(text) {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) s.push(i + 1);
  return s;
}
export function lineOf(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; }
  return lo + 1;
}

// Turn a bit of LaTeX (a section title, a caption) into plain text for display.
export function plain(s) {
  return s
    .replace(/\\(?:label|ref|cite[a-z]*|footnote|thanks|index)\*?(\[[^\]]*\])?\{[^{}]*\}/g, '')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|textrm|textsf|underline|mathrm|mathbf|mathit|text|mbox|hbox)\{([^{}]*)\}/g, '$1')
    .replace(/\\([a-zA-Z]+)\*?/g, (m, c) => ({ LaTeX: 'LaTeX', TeX: 'TeX', ldots: '…', dots: '…', textendash: '–', textemdash: '—', S: '§', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω' }[c] ?? ''))
    .replace(/\\(.)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/--/g, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

// Math regions: inline $..$, \(..\), display $$..$$, \[..\], and math environments. Also verbatim regions.
export function mathRegions(text) {
  const t = stripComments(text);
  const out = [];
  const n = t.length;
  let i = 0;
  const findEnd = (env, from) => {
    const re = new RegExp('\\\\end\\s*\\{' + env.replace(/[*]/g, '\\*') + '\\}', 'g');
    re.lastIndex = from;
    const m = re.exec(t);
    return m ? [m.index, m.index + m[0].length] : [n, n];
  };
  while (i < n) {
    const c = t[i];
    if (c === '\\') {
      const nx = t[i + 1];
      if (nx === '[' || nx === '(') {
        const close = nx === '[' ? '\\]' : '\\)';
        let e = t.indexOf(close, i + 2);
        if (e < 0) e = n;
        out.push({ from: i, to: Math.min(n, e + 2), innerFrom: i + 2, innerTo: e, display: nx === '[', kind: nx === '[' ? '\\[' : '\\(' });
        i = e + 2;
        continue;
      }
      if (t.startsWith('begin', i + 1)) {
        const m = /^\\begin\s*\{([^}]+)\}/.exec(t.slice(i, i + 80));
        if (m) {
          const env = m[1].trim();
          if (MATH_ENVS.has(env)) {
            const [a, b] = findEnd(env, i + m[0].length);
            out.push({ from: i, to: b, innerFrom: i + m[0].length, innerTo: a, display: true, kind: env, env });
            i = b;
            continue;
          }
          if (VERBATIM_ENVS.has(env)) {
            const [, b] = findEnd(env, i + m[0].length);
            out.push({ from: i, to: b, verbatim: true });
            i = b;
            continue;
          }
          i += m[0].length;
          continue;
        }
      }
      if (t.startsWith('verb', i + 1) && /[^a-zA-Z*]/.test(t[i + 5] || '')) {
        const d = t[i + 5];
        const e = t.indexOf(d, i + 6);
        const end = e < 0 ? i + 6 : e + 1;
        out.push({ from: i, to: end, verbatim: true });
        i = end;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === '$') {
      const dbl = t[i + 1] === '$';
      const start = i + (dbl ? 2 : 1);
      let k = start, end = -1;
      for (; k < n; k++) {
        const ch = t[k];
        if (ch === '\\') { k++; continue; }
        if (ch === '$') { end = k; break; }
        if (!dbl && ch === '\n' && t[k + 1] === '\n') break;
      }
      if (end < 0) { out.push({ from: i, to: k, innerFrom: start, innerTo: k, display: dbl, kind: dbl ? '$$' : '$', open: true }); i = k; continue; }
      const to = end + (dbl ? 2 : 1);
      out.push({ from: i, to, innerFrom: start, innerTo: end, display: dbl, kind: dbl ? '$$' : '$' });
      i = to;
      continue;
    }
    i++;
  }
  return out;
}

export function regionAt(regions, pos) {
  let lo = 0, hi = regions.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const r = regions[m];
    if (pos < r.from) hi = m - 1;
    else if (pos > r.to) lo = m + 1;
    else return r;
  }
  return null;
}

// Everything the editor needs to know about one .tex file.
export function scanTex(text) {
  const t = stripComments(text);
  const starts = lineStarts(text);
  const L = (p) => lineOf(starts, p);
  const r = { sections: [], labels: [], refs: [], cites: [], inputs: [], graphics: [], bibs: [], macros: [], envs: [], floats: [], hasDocument: false, docBegin: -1, docEnd: -1 };
  const floatStack = [];
  const re = /\\([a-zA-Z@]+)/g;
  let m;
  const verb = mathRegions(text).filter((x) => x.verbatim);
  let vi = 0;
  while ((m = re.exec(t))) {
    const at = m.index;
    while (vi < verb.length && verb[vi].to <= at) vi++;
    if (vi < verb.length && verb[vi].from < at && at < verb[vi].to) { re.lastIndex = verb[vi].to; continue; }
    const cmd = m[1];
    const after = at + m[0].length;
    if (cmd in SECTION_LEVELS) {
      const star = t[after] === '*';
      const j = skipOpts(t, after);
      const a = braceArg(t, j);
      if (!a) continue;
      r.sections.push({ level: SECTION_LEVELS[cmd], cmd, star, title: plain(text.slice(a[0], a[1])), raw: text.slice(a[0], a[1]), pos: at, line: L(at), end: a[2] });
      continue;
    }
    if (cmd === 'begin' || cmd === 'end') {
      const j = skipOpts(t, after);
      const a = braceArg(t, j);
      if (!a) continue;
      const name = t.slice(a[0], a[1]).trim();
      r.envs.push({ begin: cmd === 'begin', name, pos: at, end: a[2], nameFrom: a[0], nameTo: a[1] });
      if (name === 'document') { r.hasDocument = true; if (cmd === 'begin') r.docBegin = a[2]; else r.docEnd = at; }
      if (FLOAT_ENVS.has(name)) {
        if (cmd === 'begin') floatStack.push({ type: name.replace('*', ''), pos: at, line: L(at), caption: '', label: '' });
        else if (floatStack.length) { const f = floatStack.pop(); f.endPos = a[2]; r.floats.push(f); }
      }
      continue;
    }
    if (cmd === 'label') {
      const a = braceArg(t, skipOpts(t, after));
      if (!a) continue;
      const name = t.slice(a[0], a[1]).trim();
      r.labels.push({ name, pos: at, from: a[0], to: a[1], line: L(at) });
      if (floatStack.length && !floatStack[floatStack.length - 1].label) floatStack[floatStack.length - 1].label = name;
      continue;
    }
    if (cmd === 'caption' && floatStack.length) {
      const a = braceArg(t, skipOpts(t, after));
      if (a && !floatStack[floatStack.length - 1].caption) floatStack[floatStack.length - 1].caption = plain(text.slice(a[0], a[1]));
      continue;
    }
    const base = cmd.replace(/\*$/, '');
    if (REF_CMDS.has(base) || CITE_CMDS.has(base) || INPUT_CMDS.has(base) || GRAPHICS_CMDS.has(base) || BIB_CMDS.has(base)) {
      const a = braceArg(t, skipOpts(t, after));
      if (!a) continue;
      const raw = t.slice(a[0], a[1]);
      if (INPUT_CMDS.has(base)) { r.inputs.push({ cmd, path: raw.trim(), pos: at, from: a[0], to: a[1], end: a[2], line: L(at) }); continue; }
      if (GRAPHICS_CMDS.has(base)) { r.graphics.push({ cmd, path: raw.trim(), pos: at, from: a[0], to: a[1], line: L(at) }); continue; }
      if (BIB_CMDS.has(base)) { for (const k of keysIn(raw, a[0])) r.bibs.push({ path: k.key, from: k.from, to: k.to, line: L(at) }); continue; }
      const list = REF_CMDS.has(base) ? r.refs : r.cites;
      for (const k of keysIn(raw, a[0])) list.push({ cmd, key: k.key, from: k.from, to: k.to, line: L(k.from) });
      continue;
    }
    if (cmd === 'import' || cmd === 'subimport' || cmd === 'inputfrom' || cmd === 'subinputfrom') {
      const a = braceArg(t, skipOpts(t, after));
      const b = a && braceArg(t, a[2]);
      if (b) r.inputs.push({ cmd, path: (t.slice(a[0], a[1]).trim().replace(/\/?$/, '/') + t.slice(b[0], b[1]).trim()), pos: at, from: b[0], to: b[1], end: b[2], line: L(at) });
      continue;
    }
    if (cmd === 'newcommand' || cmd === 'renewcommand' || cmd === 'providecommand' || cmd === 'DeclareMathOperator' || cmd === 'DeclareRobustCommand') {
      let j = after;
      if (t[j] === '*') j++;
      while (t[j] === ' ') j++;
      let name, k;
      if (t[j] === '{') { const a = braceArg(t, j); if (!a) continue; name = t.slice(a[0], a[1]).trim(); k = a[2]; }
      else { const mm = /^\\[a-zA-Z@]+/.exec(t.slice(j, j + 60)); if (!mm) continue; name = mm[0]; k = j + mm[0].length; }
      let nargs = 0;
      while (t[k] === ' ') k++;
      if (t[k] === '[') { const e = t.indexOf(']', k); nargs = parseInt(t.slice(k + 1, e)) || 0; k = e + 1; while (t[k] === ' ') k++; if (t[k] === '[') { const e2 = t.indexOf(']', k); k = e2 + 1; } }
      while (t[k] === ' ') k++;
      const b = braceArg(t, k);
      if (!b || !name.startsWith('\\')) continue;
      const def = text.slice(b[0], b[1]);
      r.macros.push({ name, nargs, def: cmd === 'DeclareMathOperator' ? '\\operatorname{' + def + '}' : def, line: L(at), pos: at });
      continue;
    }
    if (cmd === 'def') {
      const mm = /^\\([a-zA-Z@]+)((?:#\d)*)\s*\{/.exec(t.slice(after, after + 80));
      if (!mm) continue;
      const b = braceArg(t, after + mm[0].length - 1);
      if (b) r.macros.push({ name: '\\' + mm[1], nargs: mm[2].length / 2, def: text.slice(b[0], b[1]), line: L(at), pos: at });
    }
  }
  for (const f of floatStack) r.floats.push(f);
  r.floats.sort((a, b) => a.pos - b.pos);
  return r;
}

// Split "a, b ,c" into keys with their positions.
function keysIn(raw, base) {
  const out = [];
  const re = /[^,\s][^,]*/g;
  let m;
  while ((m = re.exec(raw))) {
    const key = m[0].trim();
    if (key) out.push({ key, from: base + m.index, to: base + m.index + key.length });
  }
  return out;
}

// Environments that do not close (or close the wrong one).
export function envProblems(scan) {
  const stack = [];
  const out = [];
  for (const e of scan.envs) {
    if (e.begin) { stack.push(e); continue; }
    if (!stack.length) { out.push({ from: e.pos, to: e.end, message: `\\end{${e.name}} has no matching \\begin{${e.name}}` }); continue; }
    const top = stack[stack.length - 1];
    if (top.name === e.name) { stack.pop(); continue; }
    const idx = stack.map((s) => s.name).lastIndexOf(e.name);
    if (idx >= 0) {
      for (let k = stack.length - 1; k > idx; k--) out.push({ from: stack[k].pos, to: stack[k].end, message: `\\begin{${stack[k].name}} is not closed before \\end{${e.name}}` });
      stack.length = idx;
    } else out.push({ from: e.pos, to: e.end, message: `\\end{${e.name}} does not match \\begin{${top.name}}` });
  }
  for (const s of stack) if (s.name !== 'document' || scan.hasDocument) out.push({ from: s.pos, to: s.end, message: `\\begin{${s.name}} is never closed` });
  return out;
}

// The innermost environment still open at pos (for \end{ completion).
export function openEnvAt(scan, pos) {
  const stack = [];
  for (const e of scan.envs) {
    if (e.pos >= pos) break;
    if (e.begin) stack.push(e.name);
    else { const i = stack.lastIndexOf(e.name); if (i >= 0) stack.length = i; }
  }
  return stack[stack.length - 1] || null;
}

// --------------------------------------------------------------- bibliography

export function parseBib(text) {
  const out = [];
  const starts = lineStarts(text);
  const re = /@([a-zA-Z]+)\s*([{(])\s*([^,\s]+)\s*,/g;
  let m;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const open = m.index + m[0].indexOf(m[2]);
    let depth = 0, k = open;
    for (; k < text.length; k++) {
      const c = text[k];
      if (c === '{' || c === '(') depth++;
      else if (c === '}' || c === ')') { depth--; if (depth === 0) break; }
    }
    const body = text.slice(open + 1, k);
    const fields = {};
    const fre = /([a-zA-Z_-]+)\s*=\s*/g;
    let f;
    while ((f = fre.exec(body))) {
      let v = '';
      let j = f.index + f[0].length;
      if (body[j] === '{') { const a = braceArg(body, j); if (a) { v = body.slice(a[0], a[1]); fre.lastIndex = a[2]; } }
      else if (body[j] === '"') { const e = body.indexOf('"', j + 1); v = body.slice(j + 1, e); fre.lastIndex = e + 1; }
      else { const mm = /^[^,}\s]+/.exec(body.slice(j)); v = mm ? mm[0] : ''; }
      fields[f[1].toLowerCase()] = v;
    }
    out.push({
      key: m[3], type, line: lineOf(starts, m.index), pos: m.index,
      title: plain(fields.title || fields.booktitle || ''),
      author: shortAuthors(fields.author || fields.editor || ''),
      year: (fields.year || fields.date || '').slice(0, 4),
      venue: plain(fields.journal || fields.journaltitle || fields.booktitle || fields.publisher || fields.institution || fields.howpublished || ''),
    });
    re.lastIndex = k;
  }
  return out;
}

function shortAuthors(a) {
  const names = plain(a).split(/\s+and\s+/).map((s) => s.trim()).filter(Boolean)
    .map((n) => (n.includes(',') ? n.split(',')[0].trim() : n.split(/\s+/).slice(-1)[0]));
  if (names.length > 3) return names[0] + ' et al.';
  return names.join(', ');
}

// --------------------------------------------------------------- words

const SKIP_ARG = new Set(['label', 'ref', 'eqref', 'cref', 'Cref', 'autoref', 'pageref', 'cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite',
  'includegraphics', 'input', 'include', 'bibliography', 'bibliographystyle', 'usepackage', 'documentclass', 'begin', 'end', 'url', 'href', 'hypersetup',
  'newcommand', 'renewcommand', 'def', 'setlength', 'addtolength', 'vspace', 'hspace', 'definecolor', 'color', 'textcolor', 'graphicspath', 'addbibresource',
  'nocite', 'thispagestyle', 'pagestyle', 'setcounter', 'DeclareMathOperator', 'IEEEauthorrefmark', 'orcid', 'linewidth', 'fontsize']);

export function countWords(text, from = 0, to = text.length, regions = null) {
  let t = stripComments(text).slice(from, to);
  const reg = (regions || mathRegions(text)).filter((r) => r.to > from && r.from < to);
  if (reg.length) {
    const parts = [];
    let p = 0;
    for (const r of reg) {
      const a = Math.max(0, r.from - from), b = Math.min(t.length, r.to - from);
      if (a > p) parts.push(t.slice(p, a));
      if (!r.display && !r.verbatim) parts.push(' x ');
      p = Math.max(p, b);
    }
    parts.push(t.slice(p));
    t = parts.join(' ');
  }
  t = t.replace(/\\([a-zA-Z@]+)\*?((?:\[[^\]]*\])*)(\{[^{}]*\})?/g, (m, c, o, a) => (SKIP_ARG.has(c) ? ' ' : a ? ' ' + a.slice(1, -1) + ' ' : ' '));
  t = t.replace(/\\[^a-zA-Z]/g, ' ').replace(/[{}[\]&~^_#]/g, ' ');
  const words = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

// --------------------------------------------------------------- the whole document

export function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
export function joinPath(dir, rel) {
  const parts = (dir ? dir + '/' + rel : rel).split('/');
  const out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}

// Which project file an \input{...} names, relative to the main file's folder (where TeX runs).
export function resolveInput(name, mainDir, has, exts = ['.tex', '']) {
  name = name.replace(/^"|"$/g, '');
  for (const base of [mainDir, '']) {
    for (const e of exts) {
      const p = joinPath(base, name + e);
      if (has(p)) return p;
    }
  }
  return null;
}

// Walk the document from the main file, following \input and \include, and return the pieces in reading order:
// [{file, from, to}] (ranges of that file's text read at that point).
export function documentPieces(main, scans, texts, has) {
  const mainDir = dirname(main);
  const out = [];
  const seen = new Set();
  const walk = (file, depth) => {
    if (depth > 12 || seen.has(file)) return;
    const text = texts.get(file);
    const scan = scans.get(file);
    if (text == null || !scan) return;
    seen.add(file);
    let p = 0;
    for (const inp of scan.inputs) {
      if (inp.cmd === 'includeonly') continue;
      const target = resolveInput(inp.path, mainDir, has);
      if (!target) continue;
      out.push({ file, from: p, to: inp.pos });
      walk(target, depth + 1);
      p = inp.end;
    }
    out.push({ file, from: p, to: text.length });
    seen.delete(file);
  };
  walk(main, 0);
  return out;
}

// The outline in reading order: sections (and optionally floats) of every file the main document reads.
export function documentOutline(main, scans, texts, has, withFloats) {
  const items = [];
  for (const piece of documentPieces(main, scans, texts, has)) {
    const scan = scans.get(piece.file);
    for (const s of scan.sections) if (s.pos >= piece.from && s.pos < piece.to) items.push({ kind: 'section', file: piece.file, ...s });
    if (withFloats) for (const f of scan.floats) if (f.pos >= piece.from && f.pos < piece.to) items.push({ kind: 'float', file: piece.file, level: 9, title: f.caption || f.label || f.type, type: f.type, pos: f.pos, line: f.line });
  }
  // numbering like LaTeX does (unstarred only)
  const counters = [0, 0, 0, 0, 0, 0, 0];
  const top = Math.min(...items.filter((i) => i.kind === 'section').map((i) => i.level), 9);
  let appendix = false;
  for (const it of items) {
    if (it.kind !== 'section') continue;
    if (it.raw === undefined) continue;
    if (it.star || it.level > 3) { it.num = ''; continue; }
    const d = it.level - top;
    if (d < 0) continue;
    counters[d]++;
    for (let k = d + 1; k < counters.length; k++) counters[k] = 0;
    it.num = counters.slice(0, d + 1).join('.');
  }
  void appendix;
  return items;
}

// Word counts per section, in reading order, for the body of the document.
export function wordsBySection(main, scans, texts, has) {
  const rows = [];
  let cur = { title: 'Before the first section', level: 0, words: 0, file: main, line: 1 };
  rows.push(cur);
  let total = 0;
  const regionsOf = new Map();
  for (const piece of documentPieces(main, scans, texts, has)) {
    const text = texts.get(piece.file);
    const scan = scans.get(piece.file);
    if (!regionsOf.has(piece.file)) regionsOf.set(piece.file, mathRegions(text));
    let from = piece.from, to = piece.to;
    if (piece.file === main && scan.hasDocument) {
      if (scan.docBegin >= 0) from = Math.max(from, scan.docBegin);
      if (scan.docEnd >= 0) to = Math.min(to, scan.docEnd);
      if (from >= to) continue;
    }
    let p = from;
    for (const s of scan.sections) {
      if (s.pos < from || s.pos >= to) continue;
      const w = countWords(text, p, s.pos, regionsOf.get(piece.file));
      cur.words += w; total += w;
      cur = { title: s.title, level: s.level, words: 0, file: piece.file, line: s.line, star: s.star };
      rows.push(cur);
      p = s.end;
    }
    const w = countWords(text, p, to, regionsOf.get(piece.file));
    cur.words += w; total += w;
  }
  if (rows[0].words === 0) rows.shift();
  return { rows, total };
}

// KaTeX macros from \newcommand and friends, so previews match the paper.
export function katexMacros(scans) {
  const macros = {};
  for (const scan of scans.values()) for (const m of scan.macros) if (m.def.length < 400) macros[m.name] = m.def;
  return macros;
}

// Fuzzy match for the quick-open box: returns a score (higher is better) and the matched positions, or null.
export function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase(), t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const hits = [];
    for (let k = 0; k < q.length; k++) hits.push(direct + k);
    const atWord = direct === 0 || /[\/_\-. ]/.test(t[direct - 1]);
    return { score: 100 - direct * 0.5 + (atWord ? 30 : 0) - t.length * 0.05, hits };
  }
  let ti = 0, score = 0, prev = -2;
  const hits = [];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === ' ') continue;
    const k = t.indexOf(c, ti);
    if (k < 0) return null;
    score += k === prev + 1 ? 6 : (k === 0 || /[\/_\-. ]/.test(t[k - 1])) ? 4 : 1;
    hits.push(k);
    prev = k;
    ti = k + 1;
  }
  return { score: score - t.length * 0.05, hits };
}

export function highlight(text, hits) {
  const set = new Set(hits);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = esc(text[i]);
    out += set.has(i) ? '<b>' + ch + '</b>' : ch;
  }
  return out.replace(/<\/b><b>/g, '');
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
