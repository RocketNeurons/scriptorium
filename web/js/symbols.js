// The symbol palette: math symbols and structures, drawn with KaTeX, inserted on click.
// Each item: [what KaTeX draws, what is inserted (snippet template), name for search]
import { h } from './dom.js';

const G = (names) => names.split(' ').map((n) => ['\\' + n, '\\' + n, n]);

export const GROUPS = [
  ['Greek', G('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega')],
  ['Structures', [
    ['\\frac{a}{b}', '\\frac{${}}{${}}', 'fraction frac'],
    ['\\sqrt{x}', '\\sqrt{${}}', 'square root sqrt'],
    ['\\sqrt[n]{x}', '\\sqrt[${n}]{${}}', 'nth root'],
    ['x^{n}', '^{${}}', 'superscript power'],
    ['x_{i}', '_{${}}', 'subscript index'],
    ['x_{i}^{n}', '_{${}}^{${}}', 'sub and superscript'],
    ['\\binom{n}{k}', '\\binom{${n}}{${k}}', 'binomial'],
    ['\\left( x \\right)', '\\left( ${} \\right)', 'sized parentheses'],
    ['\\left[ x \\right]', '\\left[ ${} \\right]', 'sized brackets'],
    ['\\left\\lVert x \\right\\rVert', '\\left\\lVert ${} \\right\\rVert', 'norm'],
    ['\\left| x \\right|', '\\left| ${} \\right|', 'absolute value'],
    ['\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', '\\begin{pmatrix}\n\t${} & ${} \\\\\n\t${} & ${}\n\\end{pmatrix}', 'matrix pmatrix'],
    ['\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}', '\\begin{bmatrix}\n\t${} & ${} \\\\\n\t${} & ${}\n\\end{bmatrix}', 'matrix bmatrix'],
    ['\\begin{cases}a&x>0\\\\b&x\\le0\\end{cases}', '\\begin{cases}\n\t${} & ${} \\\\\n\t${} & ${}\n\\end{cases}', 'cases piecewise'],
    ['\\overbrace{x+y}^{n}', '\\overbrace{${}}^{${}}', 'overbrace'],
    ['\\underbrace{x+y}_{n}', '\\underbrace{${}}_{${}}', 'underbrace'],
    ['\\text{abc}', '\\text{${}}', 'text in math'],
  ]],
  ['Operators', [...G('pm mp times div cdot ast star circ bullet oplus ominus otimes odot cap cup setminus wedge vee nabla partial'), ['-', '-', 'minus']]],
  ['Relations', G('neq approx sim simeq cong equiv propto leq geq ll gg prec succ preceq succeq subset supset subseteq supseteq in notin ni perp parallel mid models vdash').concat([['=', '=', 'equals'], ['\\coloneqq', '\\coloneqq', 'define colon equals'], ['\\triangleq', '\\triangleq', 'defined as']])],
  ['Arrows', G('to gets leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow mapsto longrightarrow Longrightarrow longmapsto uparrow downarrow updownarrow Uparrow Downarrow nearrow searrow swarrow nwarrow hookrightarrow hookleftarrow rightharpoonup rightleftharpoons implies iff')],
  ['Big operators', [
    ['\\sum_{i=1}^{n}', '\\sum_{${i=1}}^{${n}}', 'sum'],
    ['\\prod_{i=1}^{n}', '\\prod_{${i=1}}^{${n}}', 'product'],
    ['\\int_{a}^{b}', '\\int_{${a}}^{${b}}', 'integral'],
    ['\\iint', '\\iint', 'double integral'],
    ['\\oint', '\\oint', 'contour integral'],
    ['\\lim_{x\\to 0}', '\\lim_{${x \\to 0}}', 'limit'],
    ['\\max_{x}', '\\max_{${}}', 'maximum'],
    ['\\min_{x}', '\\min_{${}}', 'minimum'],
    ['\\operatorname*{arg\\,max}_{x}', '\\operatorname*{arg\\,max}_{${}}', 'argmax'],
    ['\\operatorname*{arg\\,min}_{x}', '\\operatorname*{arg\\,min}_{${}}', 'argmin'],
    ['\\bigcup', '\\bigcup', 'big union'],
    ['\\bigcap', '\\bigcap', 'big intersection'],
    ['\\bigoplus', '\\bigoplus', 'direct sum'],
    ['\\bigotimes', '\\bigotimes', 'tensor product'],
    ['\\sup', '\\sup', 'supremum'],
    ['\\inf', '\\inf', 'infimum'],
    ['\\mathbb{E}', '\\mathbb{E}', 'expectation'],
    ['\\Pr', '\\Pr', 'probability'],
  ]],
  ['Accents', [
    ['\\hat{x}', '\\hat{${}}', 'hat'], ['\\bar{x}', '\\bar{${}}', 'bar'], ['\\tilde{x}', '\\tilde{${}}', 'tilde'],
    ['\\vec{x}', '\\vec{${}}', 'vector arrow'], ['\\dot{x}', '\\dot{${}}', 'dot derivative'], ['\\ddot{x}', '\\ddot{${}}', 'double dot'],
    ['\\check{x}', '\\check{${}}', 'check'], ['\\breve{x}', '\\breve{${}}', 'breve'],
    ['\\overline{xy}', '\\overline{${}}', 'overline'], ['\\underline{xy}', '\\underline{${}}', 'underline'],
    ['\\widehat{xy}', '\\widehat{${}}', 'wide hat'], ['\\widetilde{xy}', '\\widetilde{${}}', 'wide tilde'],
    ['\\overrightarrow{xy}', '\\overrightarrow{${}}', 'vector over'], ['x^{\\top}', '^{\\top}', 'transpose'], ["x'", "'", 'prime derivative'],
  ]],
  ['Letters and fonts', [
    ['\\mathbb{R}', '\\mathbb{R}', 'real numbers'], ['\\mathbb{N}', '\\mathbb{N}', 'natural numbers'], ['\\mathbb{Z}', '\\mathbb{Z}', 'integers'],
    ['\\mathbb{Q}', '\\mathbb{Q}', 'rationals'], ['\\mathbb{C}', '\\mathbb{C}', 'complex numbers'],
    ['\\mathbb{X}', '\\mathbb{${}}', 'blackboard bold'], ['\\mathcal{L}', '\\mathcal{${}}', 'calligraphic'], ['\\mathfrak{g}', '\\mathfrak{${}}', 'fraktur'],
    ['\\mathbf{x}', '\\mathbf{${}}', 'bold'], ['\\boldsymbol{\\theta}', '\\boldsymbol{${}}', 'bold symbol'], ['\\mathrm{d}', '\\mathrm{${}}', 'upright roman'],
    ['\\mathsf{A}', '\\mathsf{${}}', 'sans serif'], ['\\ell', '\\ell', 'script l'], ['\\hbar', '\\hbar', 'h bar'], ['\\Re', '\\Re', 'real part'], ['\\Im', '\\Im', 'imaginary part'], ['\\aleph', '\\aleph', 'aleph'],
  ]],
  ['Logic and sets', G('forall exists nexists neg land lor emptyset varnothing top bot therefore because')],
  ['Dots and misc', G('infty ldots cdots vdots ddots angle triangle square dagger ddagger prime degree checkmark').map((x) => (x[2] === 'degree' ? ['^{\\circ}', '^{\\circ}', 'degree'] : x))],
  ['Delimiters', [
    ['\\langle x \\rangle', '\\langle ${} \\rangle', 'angle brackets'], ['\\lfloor x \\rfloor', '\\lfloor ${} \\rfloor', 'floor'],
    ['\\lceil x \\rceil', '\\lceil ${} \\rceil', 'ceiling'], ['\\lVert x \\rVert', '\\lVert ${} \\rVert', 'norm'],
    ['\\{ x \\}', '\\lbrace ${} \\rbrace', 'braces set'], ['| x |', '| ${} |', 'bars'],
  ]],
];

// The panel: a search box and a grid per group. onPick(template, name) inserts.
export function buildSymbolPanel(onPick) {
  const input = h('input', { placeholder: 'Find a symbol (alpha, arrow, sum…)', spellcheck: 'false', autocomplete: 'off' });
  const body = h('div.sym-body');
  const tiles = [];
  for (const [group, items] of GROUPS) {
    const grid = h('div.sym-grid');
    const sec = h('div.sym-group', h('h4', group), grid);
    for (const [show, tpl, name] of items) {
      const tile = h('button.sym', { title: `${name}  ·  ${tpl.replace(/\$\{[^}]*\}/g, '…').replace(/\n\t?/g, ' ')}`, onclick: () => onPick(tpl, name) });
      try { window.katex.render(show, tile, { throwOnError: false, displayMode: false, strict: 'ignore' }); } catch (e) { tile.textContent = show; }
      tile.dataset.find = (name + ' ' + tpl).toLowerCase();
      grid.appendChild(tile);
      tiles.push({ tile, sec });
    }
    body.appendChild(sec);
  }
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const shown = new Set();
    for (const { tile, sec } of tiles) {
      const ok = !q || tile.dataset.find.includes(q);
      tile.hidden = !ok;
      if (ok) shown.add(sec);
    }
    for (const sec of body.children) sec.hidden = !shown.has(sec);
  });
  return h('div.sym-panel', h('div.search-form', h('div.field', input)), body);
}
