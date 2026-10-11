import { Extension, Mark, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Heading from '@tiptap/extension-heading';
import CodeBlock from '@tiptap/extension-code-block';
import { OrderedList } from '@tiptap/extension-list';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { CODE_LANGUAGES, COLOR_TOKENS, UUID, normalizeDocument, safeHref } from './contract.mjs';

const StableHeading = Heading.extend({
  addAttributes() {
    return { level: { default: 2, rendered: false }, id: { default: null, parseHTML: () => null } };
  },
}).configure({ levels: [2, 3] });
const SafeOrderedList = OrderedList.extend({
  addAttributes() {
    return { start: { default: 1, parseHTML: element => {
      const value = Number(element.getAttribute('start') ?? 1);
      return Number.isInteger(value) && value >= 1 && value <= 9999 ? value : 1;
    } } };
  },
});
const SafeCodeBlock = CodeBlock.extend({
  addAttributes() {
    return { language: { default: 'plaintext', rendered: false, parseHTML: element => {
      const name = [...(element.firstElementChild?.classList ?? [])].find(value => value.startsWith('language-'))?.slice(9);
      return CODE_LANGUAGES.includes(name) ? name : 'plaintext';
    } } };
  },
}).configure({ defaultLanguage: 'plaintext' });
const TextColor = Mark.create({
  name: 'textColor',
  addAttributes: () => ({ token: { default: 'default', rendered: false } }),
  parseHTML: () => [{ tag: 'span[data-text-color]', getAttrs: element => {
    const token = element.getAttribute('data-text-color');
    return COLOR_TOKENS.includes(token) ? { token } : false;
  } }],
  renderHTML: ({ mark }) => ['span', { 'data-text-color': mark.attrs.token, class: `body-color-${mark.attrs.token}` }, 0],
});
const SafeLink = Mark.create({
  name: 'link', inclusive: false,
  addAttributes: () => ({ href: { default: null } }),
  parseHTML: () => [{ tag: 'a[href]', getAttrs: element => {
    const href = safeHref(element.getAttribute('href')); return href ? { href } : false;
  } }],
  renderHTML: ({ mark }) => ['a', { href: safeHref(mark.attrs.href) || '#', rel: 'noopener noreferrer' }, 0],
});
const InlineCode = Mark.create({
  name: 'code', code: true, exitable: true, excludes: '',
  parseHTML: () => [{ tag: 'code' }], renderHTML: () => ['code', 0],
  addKeyboardShortcuts() { return { 'Mod-e': () => this.editor.commands.toggleMark('code') }; },
});
// A deliberately small table schema avoids Tiptap's span/width/merge attributes.
const Table = Node.create({ name: 'table', group: 'block', content: 'tableRow+', isolating: true,
  parseHTML: () => [{ tag: 'table' }], renderHTML: () => ['table', { class: 'body-editor-table' }, ['tbody', 0]] });
const TableRow = Node.create({ name: 'tableRow', content: '(tableCell | tableHeader)+',
  parseHTML: () => [{ tag: 'tr' }], renderHTML: () => ['tr', 0] });
const TableCell = Node.create({ name: 'tableCell', content: 'paragraph+', isolating: true,
  parseHTML: () => [{ tag: 'td' }], renderHTML: () => ['td', 0] });
const TableHeader = Node.create({ name: 'tableHeader', content: 'paragraph+', isolating: true,
  parseHTML: () => [{ tag: 'th' }], renderHTML: () => ['th', { scope: 'col' }, 0] });
function mediaNode(name, attributes, label) {
  return Node.create({ name, group: 'block', atom: true, draggable: false,
    addAttributes: () => Object.fromEntries(attributes.map(attribute => [attribute, { default: null, rendered: false }])),
    // Media can only arrive as server-validated JSON, never as pasted HTML.
    parseHTML: () => [],
    renderHTML: ({ node }) => ['figure', { class: 'body-media-placeholder', 'data-media-kind': name, contenteditable: 'false' },
      ['strong', {}, label], ['span', {}, name === 'image' ? (node.attrs.alt || '') : '视频文件'],
      ['figcaption', {}, node.attrs.caption || '暂无说明']],
  });
}
const Image = mediaNode('image', ['mediaId', 'alt', 'caption', 'displayMeta'], '图片占位');
const Video = mediaNode('video', ['mediaId', 'posterMediaId', 'caption'], '视频占位');

export function stableHeadingTransaction(state) {
  const transaction = state.tr, ids = new Set();
  state.doc.descendants((node, position) => {
    if (node.type.name === 'heading') {
      let id = node.attrs.id;
      if (!id || !UUID.test(id) || ids.has(id.toLowerCase())) id = crypto.randomUUID();
      id = id.toLowerCase(); ids.add(id);
      if (id !== node.attrs.id) transaction.setNodeMarkup(position, undefined, { ...node.attrs, id });
    }
    if (node.type.name === 'codeBlock' && !CODE_LANGUAGES.includes(node.attrs.language)) {
      transaction.setNodeMarkup(position, undefined, { language: 'plaintext' });
    }
  });
  return transaction.docChanged ? transaction.setMeta('addToHistory', false) : null;
}

export function editorExtensions(reportError) {
  const Boundary = Extension.create({ name: 'bodyBoundary',
    addProseMirrorPlugins() {
      return [new Plugin({ key: new PluginKey('bodyBoundary'),
        filterTransaction(transaction) {
          if (!transaction.docChanged) return true;
          try { normalizeDocument(transaction.doc.toJSON()); return true; }
          catch (error) { reportError(error.message); return false; }
        },
        appendTransaction: (_transactions, _oldState, state) => stableHeadingTransaction(state),
        props: {
          handleClick: (_view, _position, event) => {
            if (event.target.closest?.('a')) { event.preventDefault(); return true; }
            return false;
          },
          handleKeyDown: (view, event) => {
            if (event.key !== 'Tab' || !this.editor.isEditable) return false;
            const { $from } = view.state.selection;
            let cellDepth = $from.depth;
            while (cellDepth && !['tableCell', 'tableHeader'].includes($from.node(cellDepth).type.name)) cellDepth--;
            if (!cellDepth) return false;
            const cells = [];
            view.state.doc.descendants((node, pos) => {
              if (['tableCell', 'tableHeader'].includes(node.type.name)) { cells.push(pos); return false; }
            });
            const current = cells.indexOf($from.before(cellDepth));
            const next = cells[current + (event.shiftKey ? -1 : 1)];
            if (next === undefined) return false; // Native Tab can leave the final cell.
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(next + 2))));
            return true;
          },
        },
      })];
    },
  });
  return [StarterKit.configure({ heading: false, codeBlock: false, code: false, orderedList: false, link: false,
    underline: false, trailingNode: false, dropcursor: false, hardBreak: { keepMarks: false } }), StableHeading, SafeCodeBlock,
  SafeOrderedList, TextColor, SafeLink, InlineCode, Table, TableRow, TableCell, TableHeader, Image, Video, Boundary];
}
