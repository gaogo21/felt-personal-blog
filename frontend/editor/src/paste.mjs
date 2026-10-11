import { DOMParser as ProseMirrorParser } from '@tiptap/pm/model';
import { CODE_LANGUAGES, COLOR_TOKENS, CONTENT_LIMITS, normalizeDocument, safeHref } from './contract.mjs';

const discarded = new Set(['SCRIPT', 'STYLE', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO', 'IMG', 'LINK', 'META', 'BASE', 'TEMPLATE', 'NOSCRIPT', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);
const approved = new Set(['P', 'BR', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'PRE', 'CODE', 'STRONG', 'B', 'EM', 'I', 'S', 'STRIKE', 'DEL', 'SPAN', 'A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH']);

export function parseClipboard(schema, { html = '', plain = '' }) {
  if (new TextEncoder().encode(html || plain).length > CONTENT_LIMITS.JsonBytes) throw new Error('粘贴内容超过允许大小。');
  if (!html) {
    return normalizeDocument({ type: 'doc', content: plain.replace(/\r\n?/g, '\n').split('\n').map(line => ({
      type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
    })) });
  }
  // Template contents are inert. Copy only approved elements and attributes into a new fragment.
  const template = document.createElement('template');
  template.innerHTML = html;
  const clean = document.createElement('div');
  function copy(source, destination, inTable = false, depth = 0) {
    if (depth > CONTENT_LIMITS.JsonDepth * 4) throw new Error('粘贴内容嵌套过深。');
    if (source.nodeType === 3) { destination.append(document.createTextNode(source.nodeValue)); return; }
    if (source.nodeType !== 1 || discarded.has(source.tagName.toUpperCase()) || source.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    const name = source.tagName.toUpperCase();
    if (name === 'TABLE' && inTable) {
      destination.append(document.createTextNode(source.textContent)); return;
    }
    const target = document.createElement(approved.has(name) ? name.toLowerCase() : 'div');
    if (name === 'A') {
      const href = safeHref(source.getAttribute('href'));
      if (href) target.setAttribute('href', href);
    }
    if (name === 'OL') {
      const start = Number(source.getAttribute('start') ?? 1);
      if (Number.isInteger(start) && start >= 1 && start <= 9999) target.setAttribute('start', start);
    }
    if (name === 'SPAN' && COLOR_TOKENS.includes(source.getAttribute('data-text-color'))) target.setAttribute('data-text-color', source.getAttribute('data-text-color'));
    if (name === 'CODE') {
      const language = [...source.classList].find(item => item.startsWith('language-'))?.slice(9);
      if (CODE_LANGUAGES.includes(language)) target.setAttribute('class', `language-${language}`);
    }
    for (const child of source.childNodes) copy(child, target, inTable || name === 'TABLE', depth + 1);
    destination.append(target);
  }
  for (const child of template.content.childNodes) copy(child, clean);
  // Normalize pasted cells before the strict paragraph-only schema parses them.
  for (const table of clean.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length || rows.length > CONTENT_LIMITS.TableRows) throw new Error('粘贴表格最多 20 行。');
    const columns = Math.max(...rows.map(row => row.children.length));
    if (columns < 1 || columns > CONTENT_LIMITS.TableColumns) throw new Error('粘贴表格最多 6 列。');
    rows.forEach((row, rowIndex) => {
      const firstRowHeader = rowIndex === 0 && [...row.children].some(cell => cell.tagName === 'TH');
      for (const cell of [...row.children]) {
        if (!['TD', 'TH'].includes(cell.tagName)) { cell.remove(); continue; }
        if ((rowIndex > 0 && cell.tagName === 'TH') || (firstRowHeader && cell.tagName === 'TD')) {
          const replacement = document.createElement(firstRowHeader ? 'th' : 'td');
          replacement.append(...cell.childNodes); cell.replaceWith(replacement);
        }
      }
      while (row.children.length < columns) row.append(document.createElement(firstRowHeader ? 'th' : 'td'));
      for (const cell of row.children) {
        // Table cells retain basic inline formatting; structural blocks become paragraphs.
        for (const block of [...cell.querySelectorAll('h2,h3,pre,blockquote,ul,ol,li,table,hr')]) {
          const paragraph = document.createElement('p'); paragraph.textContent = block.textContent; block.replaceWith(paragraph);
        }
        if (!cell.childNodes.length) cell.append(document.createElement('p'));
      }
    });
  }
  const parsed = ProseMirrorParser.fromSchema(schema).parse(clean).toJSON();
  const stripBreakMarks = node => { if (node.type === 'hardBreak') delete node.marks; node.content?.forEach(stripBreakMarks); };
  stripBreakMarks(parsed);
  return normalizeDocument(parsed, { newHeadingIds: true });
}
