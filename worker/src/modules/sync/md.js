// Description conversion for pi-sync: Jira ADF <-> markdown <-> ADO HTML (plan section 3).
// Best effort. Supported: headings, bullet and numbered lists, bold, inline code, code blocks, links.
// Unknown nodes become plain text. Links are kept only for http(s) URLs.
export const MARKER = '<!-- pi-sync -->';

const safeUrl = u => /^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null;

export function normMd(md) {
  return String(md || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- ADF -> markdown
function inlineAdf(nodes) {
  return (nodes || []).map(n => {
    if (n.type === 'hardBreak') return '\n';
    if (n.type !== 'text') return n.content ? inlineAdf(n.content) : (n.attrs && n.attrs.text) || '';
    let t = n.text || '';
    const marks = n.marks || [];
    if (marks.some(m => m.type === 'code')) t = '`' + t + '`';
    if (marks.some(m => m.type === 'strong')) t = '**' + t + '**';
    const link = marks.find(m => m.type === 'link');
    if (link && safeUrl(link.attrs && link.attrs.href)) t = '[' + t + '](' + link.attrs.href + ')';
    return t;
  }).join('');
}
function blockAdf(n) {
  switch (n.type) {
    case 'paragraph': return inlineAdf(n.content);
    case 'heading': return '#'.repeat(Math.min(6, (n.attrs && n.attrs.level) || 1)) + ' ' + inlineAdf(n.content);
    case 'bulletList': return (n.content || []).map(li => '- ' + (li.content || []).map(blockAdf).join(' ')).join('\n');
    case 'orderedList': return (n.content || []).map((li, i) => (i + 1) + '. ' + (li.content || []).map(blockAdf).join(' ')).join('\n');
    case 'codeBlock': return '```\n' + (n.content || []).map(c => c.text || '').join('') + '\n```';
    default: return n.content ? n.content.map(c => c.type === 'text' ? c.text || '' : blockAdf(c)).join(' ') : (n.text || '');
  }
}
export function adfToMd(adf) {
  if (!adf) return '';
  if (typeof adf === 'string') return normMd(adf);
  return normMd((adf.content || []).map(blockAdf).join('\n\n'));
}

// ---- markdown -> ADF
function inlineMd(s) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let i = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > i) out.push({type: 'text', text: s.slice(i, m.index)});
    if (m[1] !== undefined) out.push({type: 'text', text: m[1], marks: [{type: 'strong'}]});
    else if (m[2] !== undefined) out.push({type: 'text', text: m[2], marks: [{type: 'code'}]});
    else {
      const u = safeUrl(m[4]);
      out.push(u ? {type: 'text', text: m[3], marks: [{type: 'link', attrs: {href: u}}]} : {type: 'text', text: m[3]});
    }
    i = re.lastIndex;
  }
  if (i < s.length) out.push({type: 'text', text: s.slice(i)});
  return out;
}
function mdBlocks(md) {
  const lines = normMd(md).split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const body = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++; blocks.push({k: 'code', text: body.join('\n')}); continue;
    }
    const h = /^(#{1,6}) (.*)$/.exec(l);
    if (h) { blocks.push({k: 'h', level: h[1].length, text: h[2]}); i++; continue; }
    if (/^- /.test(l) || /^\d+\. /.test(l)) {
      const ordered = /^\d+\. /.test(l), items = [];
      while (i < lines.length && (ordered ? /^\d+\. /.test(lines[i]) : /^- /.test(lines[i]))) items.push(lines[i++].replace(/^(- |\d+\. )/, ''));
      blocks.push({k: ordered ? 'ol' : 'ul', items}); continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6} |- |\d+\. |```)/.test(lines[i])) p.push(lines[i++]);
    blocks.push({k: 'p', text: p.join('\n')});
  }
  return blocks;
}
export function mdToAdf(md) {
  const content = mdBlocks(md).map(b => {
    if (b.k === 'code') return {type: 'codeBlock', content: b.text ? [{type: 'text', text: b.text}] : []};
    if (b.k === 'h') return {type: 'heading', attrs: {level: b.level}, content: inlineMd(b.text)};
    if (b.k === 'ul' || b.k === 'ol') return {type: b.k === 'ul' ? 'bulletList' : 'orderedList',
      content: b.items.map(t => ({type: 'listItem', content: [{type: 'paragraph', content: inlineMd(t)}]}))};
    const parts = b.text.split('\n'), c = [];
    parts.forEach((t, i) => { if (i) c.push({type: 'hardBreak'}); c.push(...inlineMd(t)); });
    return {type: 'paragraph', content: c};
  });
  return {type: 'doc', version: 1, content};
}

// ---- HTML -> markdown
const ENT = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' '};
const decode = s => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, e => ENT[e]);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const MAX_DESC = 64 * 1024;
const stripTags = t => { let p; do { p = t; t = t.replace(/<[^>]*>/g, ''); } while (t !== p); return t.replace(/[<>]/g, ''); };

export function htmlToMd(html) {
  let s = String(html || '').slice(0, MAX_DESC).split(MARKER).join('');
  const codes = [];
  s = s.replace(/<pre[^>]*>(?:\s*<code[^>]*>)?([\s\S]*?)(?:<\/code>\s*)?<\/pre>/gi, (_, c) => { codes.push(decode(stripTags(c))); return '\n\n\u0000' + (codes.length - 1) + '\u0000\n\n'; });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => '\n\n' + '#'.repeat(+n) + ' ' + t + '\n\n');
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, b) => { let k = 0; return '\n\n' + b.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, t) => (++k) + '. ' + t + '\n') + '\n'; });
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, b) => '\n\n' + b.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, t) => '- ' + t + '\n') + '\n');
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, u, t) => safeUrl(decode(u)) ? '[' + t + '](' + decode(u) + ')' : t);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div)>/gi, '\n\n');
  s = stripTags(s);
  s = decode(s).replace(/\u0000(\d+)\u0000/g, (_, i) => '```\n' + codes[+i] + '\n```');
  return normMd(s.split('\n').map(l => l.replace(/^\s+(?=\S)/, '')).join('\n'));
}

// ---- markdown -> HTML
function inlineHtml(s) {
  return inlineMd(s).map(n => {
    let t = esc(n.text);
    const m = (n.marks || [])[0];
    if (!m) return t;
    if (m.type === 'strong') return '<strong>' + t + '</strong>';
    if (m.type === 'code') return '<code>' + t + '</code>';
    return '<a href="' + esc(m.attrs.href) + '">' + t + '</a>';
  }).join('');
}
export function mdToHtml(md) {
  const html = mdBlocks(md).map(b => {
    if (b.k === 'code') return '<pre><code>' + esc(b.text) + '</code></pre>';
    if (b.k === 'h') return '<h' + b.level + '>' + inlineHtml(b.text) + '</h' + b.level + '>';
    if (b.k === 'ul' || b.k === 'ol') return '<' + b.k + '>' + b.items.map(t => '<li>' + inlineHtml(t) + '</li>').join('') + '</' + b.k + '>';
    return '<p>' + b.text.split('\n').map(inlineHtml).join('<br>') + '</p>';
  }).join('');
  return html ? html + MARKER : '';
}
