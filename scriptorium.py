#!/usr/bin/env python3
"""Scriptorium: a LaTeX editor in your browser, with the compiled PDF beside the source, on your own machine.

    python3 scriptorium.py [project-folder] [--main main.tex] [--port 8765] [--no-open]

Without a folder it reopens the last project, or shows a welcome page to create one from a template. It compiles
with Tectonic into a cache folder, so project folders stay clean. Python standard library only. The browser
libraries (CodeMirror 6, pdf.js, KaTeX, Lucide icons) are fetched once from public CDNs into the cache and served
from there, so the editor works offline afterwards. The server only answers on 127.0.0.1, checks the Host header,
and accepts writes only from its own page.
"""
import argparse
import hashlib
import json
import mimetypes
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from synctex import SyncTex

VERSION = '1.0.0'
HERE = Path(__file__).resolve().parent
WEB = HERE / 'web'
TEMPLATES = HERE / 'templates'


def app_dirs():
    """Cache, settings and trash folders, where each system expects them."""
    home = Path.home()
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA') or home / 'AppData' / 'Local') / 'Scriptorium'
        return base / 'Cache', base / 'Settings', base / 'Trash'
    if sys.platform == 'darwin':
        sup = home / 'Library' / 'Application Support' / 'Scriptorium'
        return home / 'Library' / 'Caches' / 'Scriptorium', sup, sup / 'Trash'
    env = lambda var, rel: Path(os.environ.get(var) or home / rel)
    return (env('XDG_CACHE_HOME', '.cache') / 'scriptorium', env('XDG_CONFIG_HOME', '.config') / 'scriptorium',
            env('XDG_DATA_HOME', '.local/share') / 'scriptorium' / 'trash')


CACHE, CONFIG, TRASH = app_dirs()
STATE_FILE = Path(os.environ.get('SCRIPTORIUM_STATE') or CONFIG / 'state.json')


def system_name():
    if sys.platform == 'win32':
        return 'windows'
    if sys.platform == 'darwin':
        return 'mac'
    return 'wsl' if 'microsoft' in platform.release().lower() else 'linux'


def find_tectonic():
    """Tectonic on the PATH, in the usual personal bin folders, or next to scriptorium.py (where its installer drops it)."""
    exe = 'tectonic.exe' if sys.platform == 'win32' else 'tectonic'
    for c in (shutil.which('tectonic'), HERE / exe, Path.home() / '.local' / 'bin' / exe, Path.home() / 'bin' / exe,
              Path('/opt/homebrew/bin') / exe, Path('/usr/local/bin') / exe):
        if c and Path(c).is_file():
            return str(c)
    return None
TEXT = {'.tex', '.bib', '.cls', '.sty', '.bst', '.bbx', '.cbx', '.def', '.cfg', '.clo', '.ltx', '.dtx', '.txt', '.md'}
IMAGE = {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'}
SKIP = {'_build', '__pycache__', 'node_modules', '.venv', 'venv'}
ZONE = ':Zone.Identifier'  # Windows download marks, copied along with files into WSL
CDN = {'cdnjs': 'https://cdnjs.cloudflare.com/ajax/libs/', 'npm': 'https://cdn.jsdelivr.net/npm/'}
MAX_TEXT = 8 << 20
MAX_BODY = 200 << 20
LIB_LOCK = threading.Lock()


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(st):
    """Recent projects and main files. Several Scriptorium servers may run at once, so each writes its own temp file."""
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_name(f'.{STATE_FILE.name}.{os.getpid()}.{threading.get_ident()}.tmp')
        tmp.write_text(json.dumps(st, indent=1))
        tmp.replace(STATE_FILE)
    except OSError as e:
        print(f'Scriptorium: could not save {STATE_FILE}: {e}', file=sys.stderr)


def kind_of(p):
    ext = p.suffix.lower()
    return 'text' if ext in TEXT else 'image' if ext in IMAGE else 'pdf' if ext == '.pdf' else 'other'


# ---------------------------------------------------------------- compile output

ISSUE = re.compile(r'(error|warning): (?:(\S.*?):(\d+): )?(.*)')
NOISE = re.compile(r'(Object @|Trying to include PDF|PDF file is tagged|warnings were issued|internal consistency'
                   r'|TeX rerun|halted on potentially-recoverable)', re.I)
BOX = re.compile(r'(Underfull|Overfull) \\[hv]box')


def parse_issues(text, cwd, root):
    seen, out = set(), []
    for line in text.splitlines():
        m = ISSUE.match(line)
        if not m:
            continue
        kind, f, ln, msg = m.groups()
        if NOISE.match(msg):
            continue
        if kind == 'warning' and BOX.match(msg):
            kind = 'box'
        rel = None
        if f:
            p = cwd / f
            if not p.exists() and (cwd / (f + '.tex')).exists():
                p = cwd / (f + '.tex')
            try:
                rel = p.resolve().relative_to(root).as_posix()
            except ValueError:
                rel = f
        key = (kind, rel, ln, msg)
        if key not in seen:
            seen.add(key)
            out.append(dict(kind=kind, file=rel, line=int(ln) if ln else None, msg=msg))
    return out


LOG_FILE = re.compile(r'\(([^\s()"]+)')
LOG_SKIP = re.compile(r'(There were undefined|Label\(s\) may have changed|Rerun to get|There were multiply-defined|'
                      r'Unused global option|You have requested package)')


def log_warnings(logfile, cwd, root):
    """LaTeX and package warnings, which Tectonic leaves in the .log only. The file is tracked by TeX's ( ) nesting."""
    try:
        lines = logfile.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError:
        return []
    out, stack, i = [], [], 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r'(LaTeX|Package (\S+)|Class (\S+)|LaTeX Font) Warning: (.*)', line)
        if m:
            msg = m.group(4)
            who = m.group(2) or m.group(3)
            pad = '(' + who + ')' if who else None
            j = i + 1
            while j < len(lines) and lines[j].strip() and (lines[j].startswith(' ') or (pad and lines[j].startswith(pad))):
                msg += ' ' + lines[j].replace(pad or '', '', 1).strip()
                j += 1
            msg = re.sub(r'\s+', ' ', msg).strip()
            ln = re.search(r'on input line (\d+)', msg)
            if not LOG_SKIP.search(msg):
                rel = None
                for s in reversed(stack):
                    if not s:
                        continue
                    for cand in (cwd / s, cwd / (s + '.tex')):
                        try:
                            if cand.suffix in ('.tex', '.ltx') and cand.is_file():
                                rel = cand.resolve().relative_to(root).as_posix()
                        except (ValueError, OSError):
                            rel = None
                        if rel:
                            break
                    if rel:
                        break
                kind = 'box' if m.group(1) == 'LaTeX Font' else 'warning'
                text = (('Package ' + who + ': ') if m.group(2) else '') + re.sub(r'\s*on input line \d+\.?', '', msg)
                out.append(dict(kind=kind, file=rel, line=int(ln.group(1)) if ln and rel else None, msg=text))
            i = j
            continue
        # follow the file nesting: "(./file.tex" opens, ")" closes
        k = 0
        while k < len(line):
            c = line[k]
            if c == '(':
                fm = LOG_FILE.match(line, k)
                if fm:
                    stack.append(fm.group(1))
                    k = fm.end()
                    continue
                stack.append('')
            elif c == ')' and stack:
                stack.pop()
            k += 1
        i += 1
    return out


def log_context(logfile):
    """TeX's own view of each error: the source line, split where TeX stopped reading."""
    try:
        lines = logfile.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError:
        return {}
    ctx = {}
    for i, l in enumerate(lines):
        if l.startswith('! '):
            for j in range(i + 1, min(i + 14, len(lines))):
                m = re.match(r'l\.(\d+) (.*)', lines[j])
                if m:
                    after = lines[j + 1].strip() if j + 1 < len(lines) else ''
                    ctx.setdefault(int(m.group(1)), (m.group(2).rstrip(), after))
                    break
    return ctx


# ---------------------------------------------------------------- the project

class Project:
    def __init__(self, root, main=None, remember=True):
        self.root = Path(root).expanduser().resolve()
        if not self.root.is_dir():
            raise ValueError(f'not a folder: {self.root}')
        h = hashlib.sha1(str(self.root).encode()).hexdigest()[:10]
        self.build = CACHE / 'build' / f'{self.root.name}-{h}'
        self.lock = threading.Lock()
        self.sync_cache = None
        st = load_state()
        saved = st.get('mains', {}).get(str(self.root))
        if main and not (self.root / main).is_file():
            main = None
        self.main = main or (saved if saved and (self.root / saved).is_file() else None) or self.detect_main()
        if remember:
            self.remember()

    def remember(self):
        st = load_state()
        st['recent'] = [str(self.root)] + [r for r in st.get('recent', []) if r != str(self.root)][:11]
        st.setdefault('mains', {})[str(self.root)] = self.main
        save_state(st)

    def detect_main(self):
        if (self.root / 'main.tex').is_file():
            return 'main.tex'
        cands = sorted(self.root.glob('*.tex')) + sorted(p for p in self.root.rglob('*.tex') if p.parent != self.root)
        for p in cands:
            try:
                if re.search(r'^[^%\n]*\\documentclass', p.read_text(encoding='utf-8', errors='replace'), re.M):
                    return p.relative_to(self.root).as_posix()
            except OSError:
                pass
        return cands[0].relative_to(self.root).as_posix() if cands else 'main.tex'

    def safe(self, rel):
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ValueError('outside the project')
        return p

    def rel(self, p):
        return Path(p).resolve().relative_to(self.root).as_posix()

    def walk(self):
        out = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP and not d.startswith('.'))
            d = Path(dirpath)
            if d != self.root:
                out.append(dict(path=d.relative_to(self.root).as_posix(), kind='dir'))
            for f in sorted(filenames):
                if f.startswith('.') or f.endswith(('.synctex.gz', '.aux', '.fls', '.fdb_latexmk', ZONE)):
                    continue
                p = d / f
                try:
                    s = p.stat()
                except OSError:
                    continue
                out.append(dict(path=p.relative_to(self.root).as_posix(), kind=kind_of(p), size=s.st_size,
                                mtime=s.st_mtime))
        return out

    def pdf(self):
        return self.build / (Path(self.main).stem + '.pdf')

    def info(self, git=True):
        pdf = self.pdf()
        return dict(root=str(self.root), name=self.root.name, main=self.main, files=self.walk(),
                    pdf_mtime=pdf.stat().st_mtime if pdf.exists() else None, git=self.git_info() if git else None,
                    home=str(Path.home()), tectonic=bool(find_tectonic()), system=system_name(), version=VERSION,
                    app_dir=str(HERE))

    def pdf_is_fresh(self):
        """True when the cached PDF is newer than every source file (a version nobody edits needs no recompile)."""
        pdf = self.pdf()
        if not pdf.exists():
            return False
        newest = max((f['mtime'] for f in self.walk() if f['kind'] != 'dir'), default=0)
        return pdf.stat().st_mtime >= newest

    def texts(self):
        out = {}
        for f in self.walk():
            if f['kind'] == 'text' and f['size'] <= MAX_TEXT:
                p = self.root / f['path']
                try:
                    out[f['path']] = dict(text=p.read_text(encoding='utf-8', errors='replace'), mtime=f['mtime'])
                except OSError:
                    pass
        return out

    # -- compiling
    def compile(self):
        with self.lock:
            self.build.mkdir(parents=True, exist_ok=True)
            main = self.root / self.main
            t0 = time.time()
            tectonic = find_tectonic()
            if not tectonic:
                return dict(ok=False, seconds=0, log='', pdf_mtime=None, no_tectonic=True,
                            issues=[dict(kind='error', file=None, line=None,
                                         msg='Tectonic is not installed yet. Scriptorium uses it to compile.')])
            cmd = [tectonic, '-X', 'compile', main.name, '--outdir', str(self.build), '--keep-logs', '--synctex']
            try:
                r = subprocess.run(cmd, cwd=main.parent, capture_output=True, text=True, timeout=900)
                text, code = r.stdout + r.stderr, r.returncode
            except FileNotFoundError:
                text, code = f'error: Tectonic could not be started ({tectonic})', 1
            except subprocess.TimeoutExpired:
                text, code = 'error: the compile took more than 15 minutes and was stopped', 1
            issues = parse_issues(text, main.parent, self.root)
            seen = {(i['kind'], i['file'], i['line'], i['msg']) for i in issues}
            for w in log_warnings(self.build / (main.stem + '.log'), main.parent, self.root):
                if (w['kind'], w['file'], w['line'], w['msg']) not in seen:
                    seen.add((w['kind'], w['file'], w['line'], w['msg']))
                    issues.append(w)
            ctx = log_context(self.build / (main.stem + '.log'))
            for i in issues:
                if i['kind'] == 'error' and i['line'] in ctx:
                    i['context'] = ctx[i['line']]
            pdf = self.pdf()
            fresh = pdf.exists() and pdf.stat().st_mtime >= t0 - 1
            log = '\n'.join(l for l in text.splitlines() if not l.startswith('note: downloading'))
            return dict(ok=code == 0 and fresh, seconds=round(time.time() - t0, 1), issues=issues, log=log,
                        pdf_mtime=pdf.stat().st_mtime if pdf.exists() else None)

    def synctex(self):
        p = self.build / (Path(self.main).stem + '.synctex.gz')
        m = p.stat().st_mtime
        if not self.sync_cache or self.sync_cache[0] != m:
            self.sync_cache = (m, SyncTex(p, self.root))
        return self.sync_cache[1]

    # -- git
    def git(self, *a):
        return subprocess.run(['git', '-C', str(self.root), *a], capture_output=True, text=True, timeout=30)

    def git_info(self):
        try:
            top = self.git('rev-parse', '--show-toplevel')
        except (OSError, subprocess.TimeoutExpired):
            return None
        if top.returncode:
            return None
        top = Path(top.stdout.strip()).resolve()
        branch = self.git('rev-parse', '--abbrev-ref', 'HEAD').stdout.strip() or '(no commits)'
        st = self.git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.').stdout.split('\0')
        changes, i = [], 0
        while i < len(st):
            it = st[i]
            i += 1
            if len(it) < 4:
                continue
            code, path = it[:2], it[3:]
            if code[0] in 'RC':
                i += 1
            if ZONE in path:
                continue
            try:
                rel = (top / path).resolve().relative_to(self.root).as_posix()
            except ValueError:
                continue
            s = 'U' if code == '??' else 'A' if 'A' in code else 'D' if 'D' in code else 'R' if 'R' in code else 'M'
            changes.append(dict(path=rel, status=s))
        log = self.git('log', '-n', '30', '--format=%h%x1f%ar%x1f%an%x1f%s', '--', '.').stdout
        commits = [dict(zip(('hash', 'when', 'author', 'subject'), l.split('\x1f'))) for l in log.splitlines() if l]
        tracked = bool(self.git('ls-files', '--', '.').stdout.strip())
        home = Path.home()
        where = '~/' + top.relative_to(home).as_posix() if home in top.parents else str(top)
        remote = self.git('remote').stdout.split()
        return dict(branch=branch, changes=changes, log=commits, repo=top.name, repo_path=where, tracked=tracked,
                    remote=remote[0] if remote else None)

    def git_head(self, rel):
        r = self.git('show', f'HEAD:./{rel}')
        return r.stdout if r.returncode == 0 else ''

    def git_commit(self, message):
        # Windows adds "file:Zone.Identifier" twins to files copied from downloads: never commit those
        a = self.git('add', '-A', '--', '.', f':(exclude)*{ZONE}')
        if a.returncode:
            return False, a.stderr
        c = self.git('commit', '-m', message, '--', '.')
        return c.returncode == 0, (c.stdout + c.stderr).strip()


P = None    # the open project
REF = None  # another version of it, opened read-only for comparing


def has_document(folder):
    for f in sorted(folder.glob('*.tex'))[:12]:
        try:
            if re.search(r'^[^%\n]*\\documentclass', f.read_text(encoding='utf-8', errors='replace')[:20000], re.M):
                return True
        except OSError:
            pass
    return False


def compare_candidates():
    """Folders that look like other versions of the open paper: its siblings, then recent projects."""
    seen, out = {P.root}, []
    sibs = sorted((d for d in P.root.parent.iterdir() if d.is_dir() and not d.name.startswith('.')),
                  key=lambda d: d.stat().st_mtime, reverse=True)
    recent = [Path(r) for r in load_state().get('recent', [])]
    for d in sibs + recent:
        d = d.resolve()
        if d in seen or not d.is_dir():
            continue
        seen.add(d)
        if has_document(d):
            home = Path.home()
            out.append(dict(root=str(d), name=d.name, show='~/' + d.relative_to(home).as_posix() if home in d.parents else str(d),
                            sibling=d.parent == P.root.parent))
    return out[:20]


# ---------------------------------------------------------------- the welcome page: templates, folders, recent projects

def short(p):
    p, home = Path(p), Path.home()
    return '~' if p == home else '~/' + p.relative_to(home).as_posix() if home in p.parents else str(p)


def expand(s):
    return Path(os.path.expanduser((s or '~').strip())).resolve()


def has_tex(folder):
    try:
        return any(x.suffix == '.tex' for x in folder.iterdir() if x.is_file())
    except OSError:
        return False


def list_templates():
    out = []
    for d in sorted(TEMPLATES.iterdir()) if TEMPLATES.is_dir() else []:
        meta = d / 'template.json'
        if not meta.is_file():
            continue
        try:
            m = json.loads(meta.read_text(encoding='utf-8'))
        except ValueError:
            continue
        out.append(dict(id=d.name, name=m.get('name', d.name), description=m.get('description', ''),
                        icon=m.get('icon', 'file-text'), order=m.get('order', 99)))
    return sorted(out, key=lambda t: (t['order'], t['name']))


def default_parent():
    home = Path.home()
    return (home / 'Documents' if (home / 'Documents').is_dir() else home) / 'Scriptorium'


def welcome():
    recent = [dict(root=r, name=Path(r).name, show=short(r)) for r in load_state().get('recent', []) if Path(r).is_dir()]
    return dict(recent=recent, templates=list_templates(), parent=short(default_parent()), home=str(Path.home()),
                system=system_name(), tectonic=bool(find_tectonic()), version=VERSION, app_dir=str(HERE))


def browse(path):
    """The subfolders of a folder, for picking a project. Folders with .tex files are marked."""
    d = expand(path)
    while not d.is_dir() and d.parent != d:  # a folder that does not exist yet: start from what does
        d = d.parent
    dirs = []
    try:
        subs = sorted((c for c in d.iterdir() if c.is_dir() and not c.name.startswith('.')), key=lambda c: c.name.lower())
    except OSError:
        subs = []
    for i, c in enumerate(subs[:400]):
        dirs.append(dict(name=c.name, path=str(c), tex=has_tex(c) if i < 200 else False))
    return dict(path=str(d), show=short(d), parent=str(d.parent) if d.parent != d else None, dirs=dirs, tex=has_tex(d))


def create_project(template, parent, name):
    name = (name or '').strip()
    if not name or name in ('.', '..') or re.search(r'[/\\:*?"<>|]', name):
        raise ValueError('Use a plain folder name, without slashes.')
    src = TEMPLATES / template
    if not (src / 'template.json').is_file():
        raise ValueError('Unknown template.')
    dest = expand(parent) / name
    if dest.exists():
        raise ValueError(f'{short(dest)} already exists. Pick another name.')
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns('template.json'))
    return dest


# ---------------------------------------------------------------- references from a DOI or an arXiv identifier

STOP = {'a', 'an', 'the', 'on', 'of', 'for', 'in', 'to', 'and', 'with', 'from', 'towards', 'toward', 'via', 'by', 'at',
        'is', 'are', 'using', 'into', 'through', 'about'}


def fetch_bibtex(ident):
    """BibTeX for a DOI (doi.org content negotiation) or an arXiv identifier (arxiv.org/bibtex)."""
    ident = ident.strip()
    arx = re.search(r'(?:arxiv\.org/(?:abs|pdf)/|arxiv:\s*)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?(?:\.pdf)?$',
                    ident, re.I)
    doi = re.search(r'(10\.\d{4,9}/\S+)', ident)
    if doi:
        url, accept = 'https://doi.org/' + doi.group(1).rstrip('.'), 'application/x-bibtex; charset=utf-8'
    elif arx:
        url, accept = 'https://arxiv.org/bibtex/' + arx.group(1), 'text/plain'
    else:
        raise ValueError('That does not look like a DOI (10.xxxx/...) or an arXiv identifier (2401.12345).')
    req = urllib.request.Request(url, headers={'Accept': accept, 'User-Agent': 'Scriptorium/1.0 (local LaTeX editor)'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            text = r.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        raise ValueError('Nothing found for that identifier.' if e.code == 404 else f'The server answered {e.code}.')
    except OSError as e:
        raise ValueError(f'No connection to {urllib.parse.urlparse(url).netloc}: {e}')
    if '@' not in text:
        raise ValueError('No BibTeX came back for that identifier.')
    return text[text.index('@'):].strip()


def bib_fields(body):
    """Split 'name = {value}, name = value, ...' at top-level commas."""
    out, depth, cur, quote = [], 0, '', False
    for c in body:
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        elif c == '"' and depth == 0:
            quote = not quote
        if c == ',' and depth == 0 and not quote:
            out.append(cur)
            cur = ''
        else:
            cur += c
    out.append(cur)
    fields = []
    for f in out:
        name, eq, value = f.partition('=')
        if eq and name.strip():
            value = ' '.join(value.split())
            fields.append((name.strip().lower(), value))
    return fields


def ascii_word(s):
    import unicodedata
    s = re.sub(r'\\[a-zA-Z]+\s*|[{}\\"\'`^~]', '', s)
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]', '', s.lower())


def tidy_bibtex(raw, taken):
    m = re.match(r'\s*@(\w+)\s*[{(]\s*([^,\s]*)\s*,(.*)[})]\s*$', raw, re.S)
    if not m:
        raise ValueError('The BibTeX that came back could not be read.')
    typ, body = m.group(1).lower(), m.group(3)
    fields = bib_fields(body)
    get = dict(fields).get
    strip = lambda v: v.strip().strip('{}"').strip()
    authors = strip(get('author', '') or get('editor', ''))
    first = authors.split(' and ')[0].strip()
    last = first.split(',')[0] if ',' in first else (first.split()[-1] if first.split() else 'anon')
    year = re.sub(r'\D', '', strip(get('year', '')))[:4]
    words = [ascii_word(w) for w in re.split(r'[\s\-–:]+', strip(get('title', '')))]
    word = next((w for w in words if w and w not in STOP), '')
    base = (ascii_word(last) or 'anon') + year + word
    key, n = base, 0
    while key in taken:
        key = base + 'abcdefghijklmnopqrstuvwxyz'[n % 26] * (n // 26 + 1)
        n += 1
    order = ['author', 'editor', 'title', 'journal', 'booktitle', 'volume', 'number', 'pages', 'year', 'month', 'publisher',
             'organization', 'school', 'institution', 'eprint', 'archiveprefix', 'primaryclass', 'doi', 'url']
    fields.sort(key=lambda f: order.index(f[0]) if f[0] in order else len(order))
    names = {'archiveprefix': 'archivePrefix', 'primaryclass': 'primaryClass'}
    lines = []
    for name, value in fields:
        v = value.strip()
        if not (v.startswith('{') or v.startswith('"') or re.fullmatch(r'\d+|[a-z]{3}', v)):
            v = '{' + v + '}'
        lines.append(f'  {names.get(name, name)} = {v}')
    return key, f'@{typ}{{{key},\n' + ',\n'.join(lines) + '\n}\n'


# ---------------------------------------------------------------- libraries from CDNs, cached

def lib(rel):
    src, _, rest = rel.partition('/')
    if src not in CDN or '..' in rest or not re.fullmatch(r'[\w./@+-]+', rest):
        raise ValueError('bad library path')
    p = CACHE / 'lib' / src / rest
    if not p.exists():
        with LIB_LOCK:
            if not p.exists():
                p.parent.mkdir(parents=True, exist_ok=True)
                with urllib.request.urlopen(CDN[src] + rest, timeout=30) as r:
                    data = r.read()
                tmp = p.with_name(p.name + '.part')
                tmp.write_bytes(data)
                tmp.replace(p)
    return p.read_bytes()


# ---------------------------------------------------------------- HTTP

TYPES = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
         '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json',
         '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png',
         '.webmanifest': 'application/manifest+json'}


class H(BaseHTTPRequestHandler):
    server_version = 'Scriptorium'

    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype='application/json', cache='no-store', extra=None):
        if ctype == 'application/json' and not isinstance(body, bytes):
            body = json.dumps(body)
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', cache)
        self.send_header('Content-Length', str(len(b)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(b)

    def host_ok(self):
        port = self.server.server_address[1]
        return self.headers.get('Host', '') in {f'localhost:{port}', f'127.0.0.1:{port}', f'[::1]:{port}'}

    def file(self, p, cache='no-store', extra=None):
        ctype = TYPES.get(p.suffix.lower()) or mimetypes.guess_type(p.name)[0] or 'application/octet-stream'
        return self.reply(200, p.read_bytes(), ctype, cache, extra)

    def do_GET(self):
        if not self.host_ok():
            return self.reply(403, dict(error='bad host'))
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = unquote(u.path)
        try:
            if path == '/':
                return self.file(WEB / 'index.html')
            if path.startswith('/static/'):
                p = (WEB / path[8:]).resolve()
                if WEB not in p.parents or not p.is_file():
                    return self.reply(404, dict(error='not found'))
                return self.file(p, 'no-cache')
            if path.startswith('/lib/'):
                rel = path[5:]
                ext = Path(rel).suffix.lower()
                return self.reply(200, lib(rel), TYPES.get(ext, 'application/octet-stream'),
                                  'public, max-age=31536000, immutable')
            if path == '/api/project':
                return self.reply(200, P.info() if P else None)
            if path == '/api/welcome':
                return self.reply(200, welcome())
            if path == '/api/browse':
                return self.reply(200, browse(q.get('path')))
            if P is None and path != '/api/recent':
                return self.reply(409, dict(error='No project is open yet.'))
            if path == '/api/texts':
                return self.reply(200, P.texts())
            if path == '/api/file':
                p = P.safe(q['path'])
                return self.reply(200, dict(text=p.read_text(encoding='utf-8', errors='replace'),
                                            mtime=p.stat().st_mtime))
            if path == '/api/stat':
                return self.reply(200, dict(files={f['path']: f.get('mtime') for f in P.walk()},
                                            main=P.main, root=str(P.root)))
            if path.startswith('/raw/'):
                p = P.safe(path[5:])
                if not p.is_file():
                    return self.reply(404, dict(error='not found'))
                return self.file(p, 'no-cache', {'Content-Security-Policy': 'sandbox'})
            if path == '/pdf':
                prj = REF if q.get('ref') else P
                if prj is None:
                    return self.reply(404, dict(error='no other version open'))
                p = prj.pdf()
                if not p.exists():
                    return self.reply(404, dict(error='no PDF yet'))
                extra = {}
                if q.get('download'):
                    extra['Content-Disposition'] = f'attachment; filename="{Path(prj.main).stem}.pdf"'
                return self.file(p, 'no-store', extra)
            # -- the other version, for comparing (read-only)
            if path == '/api/compare':
                return self.reply(200, REF.info(git=False) if REF else None)
            if path == '/api/compare/texts':
                return self.reply(200, REF.texts() if REF else {})
            if path == '/api/compare/candidates':
                return self.reply(200, dict(folders=compare_candidates()))
            if path.startswith('/rawref/'):
                if REF is None:
                    return self.reply(404, dict(error='no other version open'))
                p = REF.safe(path[8:])
                if not p.is_file():
                    return self.reply(404, dict(error='not found'))
                return self.file(p, 'no-cache', {'Content-Security-Policy': 'sandbox'})
            if path == '/api/git/head':
                return self.reply(200, dict(text=P.git_head(q['path'])))
            if path == '/api/git':
                return self.reply(200, P.git_info())
            if path == '/api/recent':
                return self.reply(200, dict(recent=[r for r in load_state().get('recent', []) if Path(r).is_dir()]))
        except (KeyError, ValueError, FileNotFoundError, IsADirectoryError) as e:
            return self.reply(400, dict(error=str(e)))
        except OSError as e:
            return self.reply(502, dict(error=str(e)))
        self.reply(404, dict(error='not found'))

    def do_POST(self):
        global P, REF
        if not self.host_ok() or self.headers.get('X-Scriptorium') != '1':
            return self.reply(403, dict(error='forbidden'))
        n = int(self.headers.get('Content-Length', 0))
        if n > MAX_BODY:
            return self.reply(413, dict(error='too large'))
        raw = self.rfile.read(n)
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if P is None and u.path not in ('/api/open', '/api/create'):
                return self.reply(409, dict(error='No project is open yet.'))
            if u.path == '/api/upload':
                p = P.safe(q['path'])
                if p.exists() and not q.get('overwrite'):
                    return self.reply(409, dict(error='exists'))
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(raw)
                return self.reply(200, dict(path=P.rel(p)))
            body = json.loads(raw or b'{}')
            if u.path == '/api/save':
                p = P.safe(body['path'])
                if p.exists() and not body.get('force') and abs(p.stat().st_mtime - body.get('mtime', 0)) > 1e-3:
                    return self.reply(409, dict(error='changed on disk', mtime=p.stat().st_mtime,
                                                text=p.read_text(encoding='utf-8', errors='replace')))
                p.parent.mkdir(parents=True, exist_ok=True)
                tmp = p.with_name('.' + p.name + '.scriptorium')
                tmp.write_text(body['text'], encoding='utf-8')
                os.replace(tmp, p)
                return self.reply(200, dict(mtime=p.stat().st_mtime))
            if u.path == '/api/compile':
                return self.reply(200, P.compile())
            if u.path == '/api/synctex/edit':
                prj = REF if body.get('ref') else P
                r = prj.synctex().edit(int(body['page']), float(body['x']), float(body['y']))
                return self.reply(200, dict(file=prj.rel(r[0]), line=r[1]) if r else dict(file=None))
            if u.path == '/api/synctex/view':
                prj = REF if body.get('ref') else P
                r = prj.synctex().view(prj.safe(body['file']), int(body['line']))
                return self.reply(200, dict(page=r[0], rects=r[1]) if r else dict(page=None))
            if u.path == '/api/compare/open':
                ref = Project(body['root'], main=P.main, remember=False)
                if ref.root == P.root:
                    return self.reply(400, dict(error='That is the folder you are editing. Pick another version.'))
                REF = ref
                return self.reply(200, REF.info(git=False))
            if u.path == '/api/compare/close':
                REF = None
                return self.reply(200, dict(ok=True))
            if u.path == '/api/compare/compile':
                if REF is None:
                    return self.reply(400, dict(error='no other version open'))
                if not body.get('force') and REF.pdf_is_fresh():
                    return self.reply(200, dict(ok=True, cached=True, seconds=0, issues=[], log='',
                                                pdf_mtime=REF.pdf().stat().st_mtime))
                return self.reply(200, REF.compile())
            if u.path == '/api/new':
                p = P.safe(body['path'])
                if p.exists():
                    return self.reply(409, dict(error='already exists'))
                if body.get('kind') == 'dir':
                    p.mkdir(parents=True)
                else:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(body.get('text', ''), encoding='utf-8')
                return self.reply(200, dict(path=P.rel(p)))
            if u.path == '/api/rename':
                src, dst = P.safe(body['from']), P.safe(body['to'])
                if src == P.root or not src.exists():
                    return self.reply(400, dict(error='nothing to rename'))
                if dst.exists():
                    return self.reply(409, dict(error='already exists'))
                dst.parent.mkdir(parents=True, exist_ok=True)
                old_main = (P.root / P.main).resolve()
                src.rename(dst)
                if old_main == src or src in old_main.parents:
                    P.main = (dst / old_main.relative_to(src)).relative_to(P.root).as_posix()
                    P.remember()
                return self.reply(200, dict(path=P.rel(dst)))
            if u.path == '/api/delete':
                p = P.safe(body['path'])
                if p == P.root or not p.exists():
                    return self.reply(400, dict(error='nothing to delete'))
                dst = TRASH / time.strftime('%Y%m%d-%H%M%S') / P.root.name / P.rel(p)
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(p), str(dst))
                return self.reply(200, dict(trash=str(dst)))
            if u.path == '/api/main':
                p = P.safe(body['main'])
                if not p.is_file() or p.suffix != '.tex':
                    return self.reply(400, dict(error='the main document must be a .tex file'))
                P.main = P.rel(p)
                P.sync_cache = None
                P.remember()
                return self.reply(200, dict(main=P.main))
            if u.path == '/api/open':
                P = Project(expand(body['root']))
                REF = None
                return self.reply(200, dict(root=str(P.root)))
            if u.path == '/api/create':
                dest = create_project(body['template'], body.get('parent') or str(default_parent()), body['name'])
                P = Project(dest)
                REF = None
                return self.reply(200, dict(root=str(P.root)))
            if u.path == '/api/reference':
                key, bib = tidy_bibtex(fetch_bibtex(body['id']), set(body.get('keys', [])))
                return self.reply(200, dict(key=key, bibtex=bib))
            if u.path == '/api/git/commit':
                ok, out = P.git_commit(body['message'])
                return self.reply(200 if ok else 400, dict(ok=ok, output=out))
        except (KeyError, ValueError, FileNotFoundError, json.JSONDecodeError) as e:
            return self.reply(400, dict(error=str(e)))
        except OSError as e:
            return self.reply(500, dict(error=str(e)))
        self.reply(404, dict(error='not found'))


def open_browser(url):
    if 'microsoft' in platform.release().lower():
        for cmd in (['wslview', url], ['explorer.exe', url], ['cmd.exe', '/c', 'start', '', url]):
            if shutil.which(cmd[0]):
                subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd='/')
                return
    import webbrowser
    webbrowser.open(url)


def main():
    global P
    ap = argparse.ArgumentParser(prog='scriptorium', description='Scriptorium: a LaTeX editor on your own machine, '
                                 'with the PDF beside the source.')
    ap.add_argument('folder', nargs='?', help='LaTeX project folder (default: the last one, or the welcome page)')
    ap.add_argument('--main', help='main .tex file inside the folder (default: found automatically)')
    ap.add_argument('--port', type=int, default=8765, help='port on localhost (default 8765, or the next free one)')
    ap.add_argument('--no-open', action='store_true', help='do not open the browser')
    ap.add_argument('--version', action='version', version=f'Scriptorium {VERSION}')
    args = ap.parse_args()
    root = args.folder or next((r for r in load_state().get('recent', []) if Path(r).is_dir()), None)
    if root:
        try:
            P = Project(expand(root), args.main)
        except ValueError as e:
            sys.exit(f'Scriptorium: {e}')
    srv = None
    for port in range(args.port, args.port + 10):
        try:
            srv = ThreadingHTTPServer(('127.0.0.1', port), H)
            break
        except OSError:
            continue
    if srv is None:
        sys.exit(f'ports {args.port}-{args.port + 9} are all in use')
    srv.daemon_threads = True
    url = f'http://localhost:{srv.server_address[1]}'
    print(f'\n  Scriptorium {VERSION} is running at {url}')
    print(f'  Project: {short(P.root)} (main file {P.main})' if P else '  No project yet: create or open one on the page.')
    if not find_tectonic():
        print('  Tectonic is not installed yet: the page shows how to install it.')
    print('  Stop it with Ctrl+C.\n')
    if not args.no_open:
        open_browser(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == '__main__':
    main()
