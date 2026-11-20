// What the completion menu offers. Templates use ${} for the places the cursor visits (Tab moves on).
// Lines: name | template (empty = just the name) | short description

const TEXT = `
section|\\section{\${title}}|Section
section*|\\section*{\${title}}|Section without number
subsection|\\subsection{\${title}}|Subsection
subsection*|\\subsection*{\${title}}|Subsection without number
subsubsection|\\subsubsection{\${title}}|Subsubsection
paragraph|\\paragraph{\${title}}|Paragraph heading
chapter|\\chapter{\${title}}|Chapter
part|\\part{\${title}}|Part
textbf|\\textbf{\${}}|Bold
textit|\\textit{\${}}|Italic
emph|\\emph{\${}}|Emphasis
underline|\\underline{\${}}|Underline
texttt|\\texttt{\${}}|Typewriter
textsc|\\textsc{\${}}|Small capitals
textsf|\\textsf{\${}}|Sans serif
textrm|\\textrm{\${}}|Roman
textsuperscript|\\textsuperscript{\${}}|Superscript text
textsubscript|\\textsubscript{\${}}|Subscript text
footnote|\\footnote{\${}}|Footnote
label|\\label{\${}}|Label for \\ref
ref|\\ref{\${}}|Reference
eqref|\\eqref{\${}}|Equation reference (n)
cref|\\cref{\${}}|Clever reference
Cref|\\Cref{\${}}|Clever reference, capitalised
autoref|\\autoref{\${}}|Reference with its name
pageref|\\pageref{\${}}|Page of a label
cite|\\cite{\${}}|Citation
citep|\\citep{\${}}|Citation in parentheses
citet|\\citet{\${}}|Citation in the text
citeauthor|\\citeauthor{\${}}|Author of a citation
citeyear|\\citeyear{\${}}|Year of a citation
parencite|\\parencite{\${}}|Citation in parentheses (biblatex)
textcite|\\textcite{\${}}|Citation in the text (biblatex)
autocite|\\autocite{\${}}|Citation (biblatex)
nocite|\\nocite{\${}}|List without citing
url|\\url{\${}}|URL
href|\\href{\${url}}{\${text}}|Link
includegraphics|\\includegraphics[width=\\linewidth]{\${}}|Image
caption|\\caption{\${}}|Caption
centering||Centre the float
item|\\item \${}|List item
input|\\input{\${}}|Read another file here
include|\\include{\${}}|Include a chapter file
usepackage|\\usepackage{\${}}|Load a package
documentclass|\\documentclass{\${article}}|Document class
newcommand|\\newcommand{\\\${name}}{\${definition}}|New command
renewcommand|\\renewcommand{\\\${name}}{\${definition}}|Redefine a command
title|\\title{\${}}|Title
author|\\author{\${}}|Author
date|\\date{\${}}|Date
maketitle||Print the title
tableofcontents||Table of contents
listoffigures||List of figures
listoftables||List of tables
bibliography|\\bibliography{\${}}|Bibliography file (BibTeX)
bibliographystyle|\\bibliographystyle{\${plain}}|Bibliography style
printbibliography||Print the bibliography (biblatex)
addbibresource|\\addbibresource{\${}}|Bibliography file (biblatex)
appendix||Start the appendices
newpage||New page
clearpage||New page, place floats
pagebreak||Page break
linebreak||Line break
newline||New line
noindent||No indent
vspace|\\vspace{\${1em}}|Vertical space
hspace|\\hspace{\${1em}}|Horizontal space
vfill||Fill vertical space
hfill||Fill horizontal space
smallskip||Small vertical skip
medskip||Medium vertical skip
bigskip||Big vertical skip
quad||Space (1em)
qquad||Space (2em)
ldots||…
today||Today's date
LaTeX||The LaTeX logo
TeX||The TeX logo
thanks|\\thanks{\${}}|Title footnote
small||Smaller text
footnotesize||Footnote-size text
scriptsize||Script-size text
tiny||Tiny text
large||Larger text
Large||Even larger text
LARGE||Very large text
huge||Huge text
normalsize||Normal size
toprule||Table top rule (booktabs)
midrule||Table middle rule (booktabs)
bottomrule||Table bottom rule (booktabs)
cmidrule|\\cmidrule(lr){\${2-3}}|Partial rule (booktabs)
hline||Table rule
multicolumn|\\multicolumn{\${2}}{\${c}}{\${}}|Cell over columns
multirow|\\multirow{\${2}}{*}{\${}}|Cell over rows
textwidth||Width of the text
linewidth||Width of the line
columnwidth||Width of a column
raggedright||Align left
raggedleft||Align right
textcolor|\\textcolor{\${red}}{\${}}|Coloured text
mbox|\\mbox{\${}}|Unbreakable box
fbox|\\fbox{\${}}|Framed box
parbox|\\parbox{\${width}}{\${}}|Paragraph box
si|\\si{\${}}|Unit (siunitx)
SI|\\SI{\${}}{\${}}|Number with unit (siunitx)
num|\\num{\${}}|Number (siunitx)
qty|\\qty{\${}}{\${}}|Quantity (siunitx)
ac|\\ac{\${}}|Acronym
gls|\\gls{\${}}|Glossary entry
IEEEPARstart|\\IEEEPARstart{\${}}{\${}}|IEEE drop letter
`;

const MATH = `
frac|\\frac{\${}}{\${}}|Fraction
dfrac|\\dfrac{\${}}{\${}}|Display fraction
tfrac|\\tfrac{\${}}{\${}}|Text fraction
sqrt|\\sqrt{\${}}|Square root
sum|\\sum_{\${i=1}}^{\${n}}|Sum
prod|\\prod_{\${i=1}}^{\${n}}|Product
int|\\int_{\${a}}^{\${b}}|Integral
iint||Double integral
oint||Contour integral
lim|\\lim_{\${x \\to \\infty}}|Limit
max|\\max_{\${}}|Maximum
min|\\min_{\${}}|Minimum
sup||Supremum
inf||Infimum
argmax|\\operatorname*{arg\\,max}_{\${}}|Argument of the maximum
argmin|\\operatorname*{arg\\,min}_{\${}}|Argument of the minimum
log||Logarithm
ln||Natural logarithm
exp||Exponential
sin||Sine
cos||Cosine
tan||Tangent
arctan||Arctangent
partial||∂
nabla||∇
infty||∞
cdot||·
cdots||⋯
vdots||⋮
ddots||⋱
times||×
div||÷
pm||±
mp||∓
leq||≤
geq||≥
neq||≠
ll||≪
gg||≫
approx||≈
equiv||≡
sim||∼
simeq||≃
propto||∝
in||∈
notin||∉
subset||⊂
subseteq||⊆
cup||∪
cap||∩
setminus||∖
forall||∀
exists||∃
rightarrow||→
Rightarrow||⇒
leftarrow||←
Leftarrow||⇐
leftrightarrow||↔
Leftrightarrow||⇔
to||→
mapsto||↦
implies||⟹
iff||⟺
mathbb|\\mathbb{\${}}|Blackboard bold (ℝ)
mathcal|\\mathcal{\${}}|Calligraphic
mathbf|\\mathbf{\${}}|Bold
mathrm|\\mathrm{\${}}|Upright
mathit|\\mathit{\${}}|Italic
mathsf|\\mathsf{\${}}|Sans serif
boldsymbol|\\boldsymbol{\${}}|Bold symbol
bm|\\bm{\${}}|Bold symbol (bm)
hat|\\hat{\${}}|Hat
bar|\\bar{\${}}|Bar
tilde|\\tilde{\${}}|Tilde
vec|\\vec{\${}}|Vector arrow
dot|\\dot{\${}}|Dot (time derivative)
ddot|\\ddot{\${}}|Double dot
overline|\\overline{\${}}|Line over
widehat|\\widehat{\${}}|Wide hat
overbrace|\\overbrace{\${}}^{\${}}|Brace over
underbrace|\\underbrace{\${}}_{\${}}|Brace under
left(|\\left( \${} \\right)|Sized parentheses
left[|\\left[ \${} \\right]|Sized brackets
left||Sized delimiter
right||Sized delimiter
big||Bigger delimiter
Big||Bigger delimiter
text|\\text{\${}}|Text in math
operatorname|\\operatorname{\${}}|Operator name
binom|\\binom{\${n}}{\${k}}|Binomial
ell||ℓ
hbar||ℏ
emptyset||∅
top||Transpose ⊤
mathbb{R}|\\mathbb{R}|Real numbers ℝ
mathbb{E}|\\mathbb{E}|Expectation 𝔼
`;

const GREEK = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho varrho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega';
const GREEK_CH = 'α β γ δ ϵ ε ζ η θ ϑ ι κ λ μ ν ξ π ρ ϱ σ τ υ ϕ φ χ ψ ω Γ Δ Θ Λ Ξ Π Σ Υ Φ Ψ Ω'.split(' ');

function parse(block, math) {
  return block.trim().split('\n').map((l) => {
    const [name, tpl, info] = l.split('|');
    return { name, tpl: tpl || '\\' + name, info: info || '', math };
  });
}

export const COMMANDS = [
  ...parse(TEXT, false),
  ...parse(MATH, true),
  ...GREEK.split(' ').map((g, i) => ({ name: g, tpl: '\\' + g, info: GREEK_CH[i], math: true })),
];

// \begin{...}: environment name -> body template (lines after \begin{name}, before \end{name})
export const ENVIRONMENTS = {
  itemize: '\t\\item ${}',
  enumerate: '\t\\item ${}',
  description: '\t\\item[${}] ${}',
  figure: '[${t}]\n\t\\centering\n\t\\includegraphics[width=\\linewidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}',
  'figure*': '[${t}]\n\t\\centering\n\t\\includegraphics[width=\\textwidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}',
  table: '[${t}]\n\t\\centering\n\t\\caption{${}}\n\t\\label{tab:${}}\n\t\\begin{tabular}{${lc}}\n\t\t\\toprule\n\t\t${} \\\\\n\t\t\\midrule\n\t\t \\\\\n\t\t\\bottomrule\n\t\\end{tabular}',
  'table*': '[${t}]\n\t\\centering\n\t\\caption{${}}\n\t\\label{tab:${}}\n\t\\begin{tabular}{${lc}}\n\t\t\\toprule\n\t\t${} \\\\\n\t\t\\bottomrule\n\t\\end{tabular}',
  tabular: '{${lc}}\n\t${} \\\\',
  tabularx: '{\\linewidth}{${lX}}\n\t${} \\\\',
  equation: '\n\t${}',
  'equation*': '\n\t${}',
  align: '\n\t${} &= ${} \\\\',
  'align*': '\n\t${} &= ${} \\\\',
  gather: '\n\t${}',
  'gather*': '\n\t${}',
  multline: '\n\t${}',
  split: '\n\t${} &= ${}',
  cases: '\n\t${} & ${} \\\\',
  pmatrix: '\n\t${} & ${} \\\\',
  bmatrix: '\n\t${} & ${} \\\\',
  matrix: '\n\t${} & ${} \\\\',
  array: '{${cc}}\n\t${} & ${} \\\\',
  abstract: '\n\t${}',
  center: '\n\t${}',
  flushleft: '\n\t${}',
  flushright: '\n\t${}',
  minipage: '{${0.48\\linewidth}}\n\t${}',
  quote: '\n\t${}',
  quotation: '\n\t${}',
  verbatim: '\n${}',
  lstlisting: '\n${}',
  theorem: '\n\t${}',
  lemma: '\n\t${}',
  proposition: '\n\t${}',
  corollary: '\n\t${}',
  definition: '\n\t${}',
  remark: '\n\t${}',
  example: '\n\t${}',
  proof: '\n\t${}',
  algorithm: '[${t}]\n\t\\caption{${}}\n\t\\label{alg:${}}\n\t\\begin{algorithmic}[1]\n\t\t\\State ${}\n\t\\end{algorithmic}',
  algorithmic: '[1]\n\t\\State ${}',
  subfigure: '{${0.48\\linewidth}}\n\t\\centering\n\t\\includegraphics[width=\\linewidth]{${}}\n\t\\caption{${}}',
  frame: '{${title}}\n\t${}',
  columns: '\n\t\\column{${0.5\\textwidth}}\n\t${}',
  thebibliography: '{${9}}\n\t\\bibitem{${}} ${}',
  IEEEkeywords: '\n\t${}',
  tikzpicture: '\n\t${}',
  document: '\n${}',
};
