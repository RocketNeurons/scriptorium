// A small Markdown renderer for the Assistant panel: paragraphs, lists, headings, code, bold, italics, links.
// The text is escaped first, so an agent's message cannot inject HTML.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

function inline(s) {
  const codes = [];
  let t = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  t = esc(t)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + esc(codes[+i]) + '</code>');
}

export function markdown(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const isList = (l) => /^\s*([-*•]|\d+[.)])\s+/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (!l.trim()) { i++; continue; }
    if (/^#{1,6}\s/.test(l)) { out.push('<p class="h">' + inline(l.replace(/^#+\s*/, '')) + '</p>'); i++; continue; }
    if (isList(l)) {
      const ordered = /^\s*\d+[.)]\s/.test(l);
      const items = [];
      while (i < lines.length && isList(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, '');
        while (i < lines.length && lines[i].trim() && !isList(lines[i]) && /^\s{2,}/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push('<li>' + inline(item) + '</li>');
      }
      out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>');
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !isList(lines[i]) && !/^#{1,6}\s/.test(lines[i])) para.push(lines[i++]);
    out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
  }
  return out.join('');
}
