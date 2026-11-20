"""Read the SyncTeX file that Tectonic (XeTeX) writes, for jumps between the PDF and the source.

A .synctex.gz file lists, page by page, the boxes TeX built (a typeset line is an hbox) and the glue, kerns
and math nodes inside them. Each record carries the input file (a numeric tag) and the source line that made it.
Coordinates are in scaled points from the top-left corner of the page; this module returns PDF points (bp).

    s = SyncTex(path_to_synctex_gz, project_root)
    s.edit(page, x, y)   -> (absolute source path, line) for a click on the PDF, or None
    s.view(path, line)   -> (page, [[x, y, w, h], ...]) the typeset lines made by that source line, or None
"""
import gzip
import os
import re

SP_PER_BP = 65781.76  # 65536 scaled points per TeX point, 72.27 TeX points per 72 PDF points

# type, tag, line, optional column, h, v, then W (kern) or W,H,D (boxes, rules)
REC = re.compile(r'([\[(vhxkg$r])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?')


class SyncTex:
    def __init__(self, path, root):
        root = os.path.normpath(str(root))
        self.inputs = {}  # tag -> normalised absolute path
        self.pages = {}   # page -> list of boxes [left, top, right, bottom, tag, line, points, kind]
        self.index = {}   # (tag, line) -> list of (page, box index)
        unit, xo, yo = 1.0, 0.0, 0.0
        content = False
        page, boxes, stack = 0, [], []
        with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as f:
            for raw in f:
                c = raw[:1]
                if c == 'I' and raw.startswith('Input:'):
                    tag, _, p = raw[6:].rstrip('\n').partition(':')
                    if p:
                        self.inputs[int(tag)] = os.path.normpath(p)
                    continue
                if not content:
                    if raw.startswith('Unit:'):
                        unit = float(raw[5:])
                    elif raw.startswith('X Offset:'):
                        xo = float(raw[9:])
                    elif raw.startswith('Y Offset:'):
                        yo = float(raw[9:])
                    elif raw.startswith('Content:'):
                        content = True
                    continue
                if c == '{':
                    page = int(raw[1:])
                    boxes = self.pages.setdefault(page, [])
                    stack = []
                    continue
                if c == '}':
                    stack = []
                    continue
                if c == ')' or c == ']':
                    if stack:
                        stack.pop()
                    continue
                m = REC.match(raw)
                if not m:
                    continue
                kind, tag, line = m.group(1), int(m.group(2)), int(m.group(3))
                h = (int(m.group(4)) * unit + xo) / SP_PER_BP
                v = (int(m.group(5)) * unit + yo) / SP_PER_BP
                key = (tag, line)
                if kind in '[(vhr':
                    w = int(m.group(6) or 0) * unit / SP_PER_BP
                    ht = int(m.group(7) or 0) * unit / SP_PER_BP
                    dp = int(m.group(8) or 0) * unit / SP_PER_BP
                    box = [min(h, h + w), v - ht, max(h, h + w), v + dp, tag, line, [], 'h' if kind in '(h' else kind]
                    boxes.append(box)
                    i = len(boxes) - 1
                    if kind in '(h':
                        self.index.setdefault(key, []).append((page, i))
                    if kind in '[(':
                        stack.append(i)
                else:  # a point inside the current box: glue, kern, math, current position
                    parent = stack[-1] if stack else None
                    if parent is not None:
                        boxes[parent][6].append((h, tag, line))
                        if boxes[parent][7] == 'h':
                            self.index.setdefault(key, []).append((page, parent))
        self.project = {t for t, p in self.inputs.items() if p == root or p.startswith(root + os.sep)}

    def edit(self, page, x, y):
        """The source position of a click at (x, y) points from the top-left of a page (1-based)."""
        boxes = self.pages.get(page) or []
        inside, near = [], []
        for b in boxes:
            if b[7] != 'h' or b[2] - b[0] <= 0 or b[3] - b[1] <= 0:
                continue
            if not (b[4] in self.project or any(p[1] in self.project for p in b[6])):
                continue
            dx = max(b[0] - x, 0, x - b[2])
            dy = max(b[1] - y, 0, y - b[3])
            if dx <= 1 and dy <= 1:
                inside.append(((b[2] - b[0]) * (b[3] - b[1]), b))
            else:
                near.append((dy * 4 + dx, b))
        pool = inside or near
        if not pool:
            return None
        b = min(pool, key=lambda t: t[0])[1]
        pts = [p for p in b[6] if p[1] in self.project]
        if pts:
            left = [p for p in pts if p[0] <= x + 0.5]
            p = max(left, key=lambda p: p[0]) if left else min(pts, key=lambda p: p[0])
            return self.inputs[p[1]], p[2]
        if b[4] in self.project:
            return self.inputs[b[4]], b[5]
        return None

    def view(self, path, line):
        """Where a source line ended up: the first page it reaches and the typeset lines it made there."""
        path = os.path.normpath(str(path))
        tags = [t for t, p in self.inputs.items() if p == path]
        if not tags:
            return None
        hits = []
        for d in [0] + [s * k for k in range(1, 40) for s in (1, -1)]:
            for t in tags:
                hits += self.index.get((t, line + d), [])
            if hits:
                break
        if not hits:
            return None
        page = min(p for p, _ in hits)
        seen, rects = set(), []
        for p, i in hits:
            if p != page or i in seen:
                continue
            seen.add(i)
            b = self.pages[p][i]
            if b[2] - b[0] > 0 and b[3] - b[1] > 0:
                rects.append([round(b[0], 2), round(b[1], 2), round(b[2] - b[0], 2), round(b[3] - b[1], 2)])
        rects.sort(key=lambda r: (r[1], r[0]))
        return page, rects[:40]
