// DOM simulation only: no HTTP listener, browser, PostgreSQL, native clipboard, or visual QA.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { Editor } from '@tiptap/core';
import { createBodyEditor, normalizeDocument, safeHref, CONTENT_LIMITS } from '../src/editor.mjs';
import { editorExtensions } from '../src/extensions.mjs';
import { parseClipboard } from '../src/paste.mjs';
import { extractPlainText } from '../src/contract.mjs';

const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body></body></html>', { url: 'https://blog.test/admin/articles/1', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'DOMParser', 'Event', 'KeyboardEvent', 'MouseEvent', 'AbortController', 'getComputedStyle', 'location', 'DOMRect']) {
  Object.defineProperty(globalThis, name, { value: typeof dom.window[name] === 'function' && name === 'getComputedStyle' ? dom.window[name].bind(dom.window) : dom.window[name], configurable: true });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const rect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = rect;
dom.window.scrollBy = () => {};
after(() => dom.window.close());
const p = (value = '') => ({ type: 'paragraph', content: value ? [{ type: 'text', text: value }] : [] });
const doc = (...content) => ({ type: 'doc', content });
const heading = (value, id = null, level = 2) => ({ type: 'heading', attrs: { level, id }, content: [{ type: 'text', text: value }] });
const table = (rows = 2, columns = 2) => ({ type: 'table', content: Array.from({ length: rows }, (_, row) => ({ type: 'tableRow', content: Array.from({ length: columns }, () => ({ type: row === 0 ? 'tableHeader' : 'tableCell', content: [p('单元')] })) })) });
const allNodes = value => [value, ...(value.content ?? []).flatMap(allNodes)];
function mount(options = {}) {
  const element = document.createElement('div'); document.body.append(element);
  const api = createBodyEditor(element, options);
  return { element, api, close() { api.destroy(); element.remove(); } };
}
function raw(content = doc(p())) {
  const element = document.createElement('div'); document.body.append(element);
  const errors = [];
  const editor = new Editor({ element, content: normalizeDocument(content), extensions: editorExtensions(message => errors.push(message)), injectCSS: false });
  return { editor, errors, close() { editor.destroy(); element.remove(); } };
}
function button(element, label) { return [...element.querySelectorAll('button')].find(node => node.textContent === label); }
function field(element, label) { return [...element.querySelectorAll('label')].find(node => node.firstChild.textContent === label)?.querySelector('input,select'); }
function paste(element, html, plain = '', files = []) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: type => type === 'text/html' ? html : plain } });
  element.querySelector('.tiptap').dispatchEvent(event);
  return event;
}

test('DOM simulation: empty mount, Chinese accessible controls, canonical manual-save JSON', () => {
  let updates = 0;
  const fixture = mount({ onUpdate: () => updates++ });
  try {
    assert.deepEqual(fixture.api.getJSON(), doc());
    assert.equal(fixture.element.querySelector('[role=textbox]').getAttribute('aria-label'), '文章正文');
    assert.equal(fixture.element.querySelector('[role=textbox]').getAttribute('aria-multiline'), 'true');
    assert.ok(button(fixture.element, '二级标题'));
    assert.ok(field(fixture.element, '文字颜色'));
    assert.ok(button(fixture.element, '插入表格'));
    assert.equal(fixture.api.setContent(doc(p('手动保存正文'))), true);
    assert.equal(updates, 0, 'server replacement must not set dirty state');
    assert.equal(fixture.api.getJSON().content[0].content[0].text, '手动保存正文');
  } finally { fixture.close(); }
});

test('DOM simulation: strict replacement rejects unknown fields without losing existing input', () => {
  const errors = [];
  const fixture = mount({ content: doc(p('保留输入')), onError: message => errors.push(message) });
  try {
    for (const bad of [doc({ ...p('危险'), attrs: { style: 'color:red' } }), doc({ type: 'rawHtml', text: '<script>bad()</script>' }), doc({ type: 'heading', attrs: { level: 1 }, content: [] })]) {
      assert.equal(fixture.api.setContent(bad), false);
      assert.equal(fixture.api.getJSON().content[0].content[0].text, '保留输入');
    }
    assert.equal(errors.length, 3);
    assert.ok(fixture.element.querySelector('[role=status]').textContent);
  } finally { fixture.close(); }
});

test('DOM simulation: heading UUID survives text rename, level switch, save reload and repeated reads', () => {
  const fixture = raw(doc(heading('旧标题')));
  try {
    const id = fixture.editor.getJSON().content[0].attrs.id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    fixture.editor.commands.setTextSelection({ from: 1, to: 4 });
    fixture.editor.commands.insertContent('新标题');
    assert.equal(fixture.editor.getJSON().content[0].attrs.id, id);
    fixture.editor.commands.setNode('heading', { level: 3, id });
    assert.equal(fixture.editor.getJSON().content[0].attrs.id, id);
    const saved = fixture.editor.getJSON();
    fixture.editor.commands.setContent(saved);
    assert.equal(fixture.editor.getJSON().content[0].attrs.id, id);
    assert.equal(fixture.editor.getJSON().content[0].attrs.id, id);
  } finally { fixture.close(); }
});

test('DOM simulation: new headings and duplicated headings receive unique stable UUIDs', () => {
  const fixture = raw(doc(p('标题')));
  try {
    fixture.editor.commands.setTextSelection(1);
    fixture.editor.commands.setHeading({ level: 2 });
    const first = fixture.editor.getJSON().content[0];
    assert.ok(first.attrs.id);
    fixture.editor.commands.insertContentAt(fixture.editor.state.doc.content.size, first);
    const nodes = fixture.editor.getJSON().content;
    assert.equal(nodes[0].attrs.id, first.attrs.id);
    assert.notEqual(nodes[1].attrs.id, first.attrs.id);
    assert.equal(new Set(nodes.map(node => node.attrs.id)).size, 2);
  } finally { fixture.close(); }
});

test('DOM simulation: safe HTML paste keeps approved formatting, gives pasted headings fresh IDs and drops active content', () => {
  const id = crypto.randomUUID();
  const fixture = mount({ content: doc(heading('已存在标题', id), p()) });
  try {
    paste(fixture.element, `<h2 id="${id}" style="color:red">粘贴标题</h2><p onclick="bad()"><strong>粗体</strong><u>下划线</u><a href="javascript:alert(1)">危险链接</a><a href="https://example.com">安全链接</a></p><script>bad()</script><svg onload="bad()"><text>恶意SVG</text></svg><iframe src="https://example.com"></iframe><img src="https://example.com/pixel" onerror="bad()">`);
    const content = fixture.api.getJSON(), json = JSON.stringify(content);
    assert.ok(json.includes('粗体'));
    assert.ok(json.includes('安全链接'));
    assert.ok(json.includes('"type":"bold"'));
    assert.ok(json.includes('https://example.com/'));
    for (const forbidden of ['javascript:', 'onclick', 'onerror', 'style', 'underline', 'iframe', 'pixel', 'bad()', '恶意SVG']) assert.ok(!json.includes(forbidden), forbidden);
    const headings = allNodes(content).filter(node => node.type === 'heading');
    assert.equal(headings.length, 2);
    assert.equal(new Set(headings.map(node => node.attrs.id)).size, 2);
    assert.ok(headings.some(node => node.attrs.id === id));
    assert.equal(fixture.element.querySelectorAll('script,svg,iframe,img').length, 0);
  } finally { fixture.close(); }
});

test('DOM simulation: plain-text clipboard treats HTML-looking code as literal text', () => {
  const fixture = mount();
  try {
    paste(fixture.element, '', '<script>alert(1)</script>\n下一行');
    assert.equal(fixture.element.querySelectorAll('script').length, 0);
    assert.ok(JSON.stringify(fixture.api.getJSON()).includes('<script>alert(1)</script>'));
    assert.equal(fixture.api.getJSON().content.length, 2);
  } finally { fixture.close(); }
});

test('DOM simulation: file paste and external drag remain disabled without requesting resources', () => {
  const errors = [];
  const fixture = mount({ content: doc(p('原文')), onError: message => errors.push(message) });
  try {
    paste(fixture.element, '<p>不能插入</p>', '', [{ name: 'file.png' }]);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [{ name: 'video.mp4' }], getData: () => '' } });
    fixture.element.querySelector('.tiptap').dispatchEvent(event);
    assert.equal(fixture.api.getJSON().content[0].content[0].text, '原文');
    assert.ok(errors.some(message => message.includes('媒体')));
    assert.equal(fixture.element.querySelectorAll('img,video,iframe').length, 0);
  } finally { fixture.close(); }
});

test('DOM simulation: read-only and frozen editors block toolbar and paste, preserve JSON, then re-enable', () => {
  let updates = 0;
  const fixture = mount({ content: doc(p('只读正文')), editable: false, onUpdate: () => updates++ });
  try {
    assert.equal(fixture.element.querySelector('[role=textbox]').contentEditable, undefined); // jsdom has no editing layout engine.
    assert.equal(fixture.element.querySelector('[role=textbox]').getAttribute('contenteditable'), 'false');
    assert.equal(fixture.element.querySelector('[role=textbox]').getAttribute('aria-readonly'), 'true');
    assert.ok([...fixture.element.querySelectorAll('button,input,select')].every(control => control.disabled));
    button(fixture.element, '二级标题').click(); paste(fixture.element, '<p>新文字</p>');
    assert.equal(fixture.api.getJSON().content[0].content[0].text, '只读正文');
    assert.equal(updates, 0);
    fixture.api.setEditable(true);
    assert.equal(fixture.element.querySelector('[role=textbox]').getAttribute('contenteditable'), 'true');
    assert.equal(button(fixture.element, '二级标题').disabled, false);
    fixture.api.setEditable(false);
    assert.equal(button(fixture.element, '二级标题').disabled, true);
  } finally { fixture.close(); }
});

test('DOM simulation: repeat mount and destroy dispose old listeners and prevent duplicate update callbacks', () => {
  let oldUpdates = 0, newUpdates = 0;
  const fixture = mount({ onUpdate: () => oldUpdates++ });
  const oldButton = button(fixture.element, '二级标题');
  const replacement = createBodyEditor(fixture.element, { onUpdate: () => newUpdates++ });
  try {
    assert.equal(fixture.element.querySelectorAll('.body-editor-toolbar').length, 1);
    oldButton.click();
    assert.equal(oldUpdates, 0);
    paste(fixture.element, '', '只更新一次');
    assert.equal(newUpdates, 1);
    replacement.destroy(); replacement.destroy();
    oldButton.click();
    assert.equal(fixture.element.childElementCount, 0);
    assert.equal(replacement.setContent(doc(p('不能复活'))), false);
    assert.throws(() => replacement.getJSON(), /已关闭/);
  } finally { replacement.destroy(); fixture.element.remove(); }
});

test('DOM simulation: safe link allowlist rejects protocols, credentials, controls and encoded admin routes', () => {
  for (const url of ['https://example.com/path?q=a#b', '/articles/hello', '#heading-id']) assert.ok(safeHref(url), url);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://example.com', '//evil.test', '\\evil.test', 'https://user:secret@example.com', 'https://example.com/\nfoo', '/admin', '/admin/login', '/api/admin/v1/articles', '/%61dmin/login', '/%2561dmin/login', '/x/../admin/login', '/%2fexample.com', 'https://blog.test/admin/login', '/%0aadmin', '#', ' https://example.com']) assert.equal(safeHref(url), null, url);
});

test('DOM simulation: approved marks serialize only exact attributes and unsupported formats fail', () => {
  const input = doc({ type: 'paragraph', content: [{ type: 'text', text: '样式', marks: [
    { type: 'link', attrs: { href: '/articles/x' } }, { type: 'textColor', attrs: { token: 'gold' } }, { type: 'bold' }, { type: 'italic' }, { type: 'strike' },
  ] }] });
  assert.deepEqual(normalizeDocument(input), input);
  for (const mark of [{ type: 'underline' }, { type: 'textColor', attrs: { token: 'red' } }, { type: 'textColor', attrs: { token: 'purple', color: '#fff' } }, { type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }, { type: 'bold', attrs: { style: 'color:red' } }]) {
    assert.throws(() => normalizeDocument(doc({ type: 'paragraph', content: [{ type: 'text', text: '拒绝', marks: [mark] }] })));
  }
});

test('DOM simulation: code remains text; unsupported language normalizes to plaintext', () => {
  const fixture = raw();
  try {
    const pasted = parseClipboard(fixture.editor.schema, { html: '<pre><code class="language-ruby">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>' });
    assert.equal(pasted.content[0].attrs.language, 'plaintext');
    assert.equal(pasted.content[0].content[0].text, '<script>alert(1)</script>');
    const normalized = normalizeDocument(doc({ type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'print("中文")' }] }));
    assert.equal(normalized.content[0].attrs.language, 'python');
    assert.throws(() => normalizeDocument(doc({ type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'x'.repeat(CONTENT_LIMITS.CodeScalars + 1) }] })));
    assert.throws(() => normalizeDocument(doc({ type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }] })));
  } finally { fixture.close(); }
});

test('DOM simulation: bounded rectangular tables serialize without merge/width attrs', () => {
  const fixture = mount({ content: doc(table(20, 6)) });
  try {
    const value = fixture.api.getJSON();
    assert.equal(value.content[0].content.length, 20);
    assert.ok(allNodes(value).filter(node => node.type.startsWith('table')).every(node => !('attrs' in node)));
    const invalid = [table(21, 1), table(1, 7), table(0, 1), table(1, 0)];
    const ragged = table(); ragged.content[1].content.pop(); invalid.push(ragged);
    const nested = table(); nested.content[0].content[0].content = [table(1, 1)]; invalid.push(nested);
    const merged = table(); merged.content[0].content[0].attrs = { colspan: 2 }; invalid.push(merged);
    const misplacedHeader = table(); misplacedHeader.content[1].content[0].type = 'tableHeader'; invalid.push(misplacedHeader);
    const longCell = table(); longCell.content[0].content[0].content = [p('字'.repeat(CONTENT_LIMITS.CellScalars + 1))]; invalid.push(longCell);
    for (const value of invalid) assert.throws(() => normalizeDocument(doc(value)));
  } finally { fixture.close(); }
});

test('DOM simulation: table toolbar inserts bounded table and prevents nested insertion', () => {
  const fixture = mount();
  try {
    field(fixture.element, '表格行数').value = '3'; field(fixture.element, '表格列数').value = '2';
    button(fixture.element, '插入表格').click();
    assert.equal(fixture.api.getJSON().content[0].type, 'table');
    assert.equal(fixture.api.getJSON().content[0].content.length, 3);
    assert.equal(button(fixture.element, '插入表格').disabled, true);
    assert.equal(button(fixture.element, '二级标题').disabled, true);
    button(fixture.element, '插入表格').click();
    assert.equal(allNodes(fixture.api.getJSON()).filter(node => node.type === 'table').length, 1);
    button(fixture.element, '删除表格').click();
    assert.deepEqual(fixture.api.getJSON(), doc());
  } finally { fixture.close(); }
});

test('DOM simulation: pasted table drops merge/style, repairs rectangle, demotes later headers, flattens nested tables', () => {
  const fixture = raw();
  try {
    const pasted = parseClipboard(fixture.editor.schema, { html: '<table style="width:100%"><tr><th colspan="2">标题</th><th>第二</th></tr><tr><th><table><tr><td>嵌套文字</td></tr></table></th></tr></table>' });
    const value = pasted.content[0];
    assert.equal(value.type, 'table');
    assert.ok(value.content.every(row => row.content.length === 2));
    assert.ok(value.content[1].content.every(cell => cell.type === 'tableCell'));
    assert.equal(allNodes(pasted).filter(node => node.type === 'table').length, 1);
    assert.ok(!JSON.stringify(pasted).includes('colspan'));
    assert.ok(JSON.stringify(pasted).includes('嵌套文字'));
  } finally { fixture.close(); }
});

test('DOM simulation: media preserves approved metadata as inert placeholders without URL elements', () => {
  const id = crypto.randomUUID(), poster = crypto.randomUUID();
  const image = { type: 'image', attrs: { mediaId: id, alt: '图片文字', caption: '说明', displayMeta: { alt: '图片文字', caption: '说明', credit: '作者', sourceUrl: 'https://example.com/', licenseName: 'CC BY', licenseUrl: 'https://example.com/license' } } };
  const video = { type: 'video', attrs: { mediaId: id, posterMediaId: poster, caption: '视频说明' } };
  const fixture = mount({ content: doc(image, video) });
  try {
    assert.deepEqual(fixture.api.getJSON(), doc(image, video));
    assert.equal(fixture.element.querySelectorAll('.body-media-placeholder').length, 2);
    assert.equal(fixture.element.querySelectorAll('img,video,iframe,source').length, 0);
    assert.throws(() => normalizeDocument(doc({ ...image, attrs: { ...image.attrs, src: 'https://example.com/file' } })));
    assert.throws(() => normalizeDocument(doc({ ...video, attrs: { ...video.attrs, autoplay: true } })));
    assert.throws(() => normalizeDocument(doc({ ...image, attrs: { ...image.attrs, displayMeta: { ...image.attrs.displayMeta, alt: '不一致' } } })));
    assert.throws(() => normalizeDocument(doc({ ...image, attrs: { ...image.attrs, mediaId: 'not-a-uuid' } })));
  } finally { fixture.close(); }
});

test('DOM simulation: Unicode NFC scalar bounds, JSON depth/nodes/bytes and ordered-list bounds', () => {
  assert.equal(normalizeDocument(doc(p('e\u0301😀'))).content[0].content[0].text, 'é😀');
  assert.doesNotThrow(() => normalizeDocument(doc(p('😀'.repeat(CONTENT_LIMITS.BodyScalars)))));
  assert.throws(() => normalizeDocument(doc(p('😀'.repeat(CONTENT_LIMITS.BodyScalars + 1)))));
  assert.throws(() => normalizeDocument(doc(p('\ud800'))));
  assert.throws(() => normalizeDocument(doc(...Array.from({ length: CONTENT_LIMITS.JsonNodes }, () => p()))));
  let deep = p('深层'); for (let i = 0; i < CONTENT_LIMITS.JsonDepth; i++) deep = { type: 'blockquote', content: [deep] };
  assert.throws(() => normalizeDocument(doc(deep)));
  assert.throws(() => normalizeDocument(doc(p('x'.repeat(CONTENT_LIMITS.JsonBytes + 1)))));
  for (const start of [1, 9999]) assert.doesNotThrow(() => normalizeDocument(doc({ type: 'orderedList', attrs: { start }, content: [{ type: 'listItem', content: [p('项')] }] })));
  for (const start of [0, 10000, 1.5, '1']) assert.throws(() => normalizeDocument(doc({ type: 'orderedList', attrs: { start }, content: [{ type: 'listItem', content: [p('项')] }] })));
});

test('DOM simulation: invalid transactions are rejected, current document retained, and feedback supplied', () => {
  const fixture = raw(doc(table()));
  try {
    const value = fixture.editor.getJSON();
    const broken = table(); broken.content[1].content.pop();
    fixture.editor.commands.setContent(doc(broken));
    assert.deepEqual(fixture.editor.getJSON(), value);
    assert.ok(fixture.errors.some(message => message.includes('表格')));
  } finally { fixture.close(); }
});

test('DOM simulation: shared server/client fixtures preserve canonical marks, attributes and plain-text separators', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./contract-fixtures.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    assert.deepEqual(normalizeDocument(fixture.input), fixture.normalized, fixture.name);
    assert.equal(extractPlainText(fixture.normalized), fixture.plainText, fixture.name);
    const mounted = mount({ content: fixture.normalized });
    try { assert.deepEqual(mounted.api.getJSON(), fixture.normalized, fixture.name); }
    finally { mounted.close(); }
  }
});

test('DOM simulation: combined marks retain server order; block and cell limits include separators', () => {
  const marks = [{ type: 'code' }, { type: 'bold' }, { type: 'link', attrs: { href: '#part' } }, { type: 'italic' }, { type: 'textColor', attrs: { token: 'default' } }, { type: 'strike' }];
  const canonical = normalizeDocument(doc({ type: 'paragraph', content: [{ type: 'text', text: '文字', marks }] }));
  assert.deepEqual(canonical.content[0].content[0].marks.map(mark => mark.type), ['link', 'textColor', 'bold', 'italic', 'strike', 'code']);
  assert.throws(() => normalizeDocument(doc(p('x'.repeat(CONTENT_LIMITS.BodyScalars)), p(''))));
  const value = table(1, 1); value.content[0].content[0].content = [p('x'.repeat(CONTENT_LIMITS.CellScalars)), p('')];
  assert.throws(() => normalizeDocument(doc(value)));
  const mixed = table(); mixed.content[0].content[0].type = 'tableCell';
  assert.throws(() => normalizeDocument(doc(mixed)));
  assert.equal(safeHref('/articles/%2E%2E/articles/example'), '/articles/example');
  assert.equal(safeHref('https://external.test/admin/login'), null);
});

test('DOM simulation: hard break in marked text and table keyboard navigation stay within approved schema', () => {
  const fixture = raw(doc(p('原文')));
  try {
    fixture.editor.commands.setTextSelection(2);
    fixture.editor.commands.setMark('bold');
    fixture.editor.commands.setHardBreak();
    assert.doesNotThrow(() => normalizeDocument(fixture.editor.getJSON()));
    assert.equal(allNodes(fixture.editor.getJSON()).find(node => node.type === 'hardBreak')?.marks, undefined);
    fixture.editor.commands.setContent(doc(table()));
    fixture.editor.commands.setTextSelection(4);
    const position = fixture.editor.state.selection.from;
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    fixture.editor.view.dom.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.ok(fixture.editor.state.selection.from > position);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    fixture.editor.view.dom.dispatchEvent(back);
    assert.equal(fixture.editor.state.selection.from, position);
    assert.equal(fixture.editor.getJSON().content[0].content.length, 2);
  } finally { fixture.close(); }
});
