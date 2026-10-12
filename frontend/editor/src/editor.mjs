import { Editor } from '@tiptap/core';
import { CONTENT_LIMITS, CODE_LANGUAGES, normalizeDocument, safeHref } from './contract.mjs';
import { editorExtensions, stableHeadingTransaction } from './extensions.mjs';
import { parseClipboard } from './paste.mjs';

export { CONTENT_LIMITS, CODE_LANGUAGES, normalizeDocument, safeHref } from './contract.mjs';
const instances = new WeakMap();
const emptyDocument = () => ({ type: 'doc', content: [] });
const withCaretParagraph = value => value.content.length ? value : { type: 'doc', content: [{ type: 'paragraph', content: [] }] };

/** Creates a local editor only. The owner handles authenticated manual save and concurrency. */
export function createBodyEditor(element, { content = emptyDocument(), onUpdate = () => {}, onError = () => {}, editable = true } = {}) {
  if (!(element instanceof HTMLElement)) throw new TypeError('需要提供正文编辑器容器。');
  // Validate before replacing an existing editor or any unsaved input.
  const initial = normalizeDocument(content);
  instances.get(element)?.destroy();
  const events = new AbortController();
  let destroyed = false, replacing = false, editor;
  element.classList.add('body-editor');
  const toolbar = document.createElement('div');
  toolbar.className = 'body-editor-toolbar'; toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '正文格式');
  const surface = document.createElement('div'); surface.className = 'body-editor-surface';
  const feedback = document.createElement('p'); feedback.className = 'body-editor-feedback';
  feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  element.replaceChildren(toolbar, surface, feedback);
  const controls = [], activeButtons = [];
  function reportError(message) { feedback.textContent = message; onError(message); }
  function currentJSON() {
    if (destroyed) throw new Error('正文编辑器已关闭。');
    const transaction = stableHeadingTransaction(editor.state);
    if (transaction) editor.view.dispatch(transaction);
    const document = normalizeDocument(editor.getJSON());
    // Tiptap needs a caret paragraph; the approved empty server document is [].
    if (document.content.length === 1 && document.content[0].type === 'paragraph' && document.content[0].content.length === 0) document.content = [];
    return document;
  }
  function invoke(action) {
    if (destroyed || !editor.isEditable) return;
    feedback.textContent = '';
    try { action(); } catch (error) { reportError(error.message); }
    updateControls();
  }
  function button(label, action, isActive, canUse = () => true) {
    const control = document.createElement('button'); control.type = 'button'; control.textContent = label;
    control.addEventListener('click', () => invoke(action), { signal: events.signal });
    if (isActive) { control.setAttribute('aria-pressed', 'false'); activeButtons.push([control, isActive]); }
    toolbar.append(control); controls.push([control, canUse]); return control;
  }
  function select(label, options, changed) {
    const wrapper = document.createElement('label'); wrapper.append(document.createTextNode(label));
    const control = document.createElement('select');
    for (const [value, caption] of options) { const option = document.createElement('option'); option.value = value; option.textContent = caption; control.append(option); }
    control.addEventListener('change', () => invoke(() => changed(control.value)), { signal: events.signal });
    wrapper.append(control); toolbar.append(wrapper); controls.push([control, () => true]); return control;
  }
  function input(label, { type = 'text', value = '', min, max } = {}) {
    const wrapper = document.createElement('label'); wrapper.append(document.createTextNode(label));
    const control = document.createElement('input'); control.type = type; control.value = value;
    if (min !== undefined) control.min = min;
    if (max !== undefined) control.max = max;
    wrapper.append(control); toolbar.append(wrapper); controls.push([control, () => true]); return control;
  }
  const inCell = () => editor.isActive('tableCell') || editor.isActive('tableHeader');
  const canBlock = () => !inCell();
  button('正文', () => editor.chain().focus().setParagraph().run(), () => editor.isActive('paragraph'));
  for (const level of [2, 3]) button(`${level === 2 ? '二' : '三'}级标题`, () => {
    const old = editor.getAttributes('heading');
    if (editor.isActive('heading', { level })) editor.chain().focus().setParagraph().run();
    else editor.chain().focus().setNode('heading', { level, id: old.id ?? null }).run();
  }, () => editor.isActive('heading', { level }), canBlock);
  for (const [name, label] of [['bold', '加粗'], ['italic', '斜体'], ['strike', '删除线'], ['code', '行内代码']]) {
    button(label, () => editor.chain().focus().toggleMark(name).run(), () => editor.isActive(name));
  }
  const color = select('文字颜色', [['default', '默认'], ['purple', '紫色'], ['gold', '浅金']], token => editor.chain().focus().setMark('textColor', { token }).run());
  button('无序列表', () => editor.chain().focus().toggleBulletList().run(), () => editor.isActive('bulletList'), canBlock);
  const start = input('列表起始编号', { type: 'number', value: '1', min: 1, max: 9999 });
  button('有序列表', () => {
    const number = Number(start.value);
    if (!Number.isInteger(number) || number < 1 || number > 9999) throw new Error('列表起始编号须为 1 至 9999。');
    editor.chain().focus().toggleOrderedList().updateAttributes('orderedList', { start: number }).run();
  }, () => editor.isActive('orderedList'), canBlock);
  button('引用', () => editor.chain().focus().toggleBlockquote().run(), () => editor.isActive('blockquote'), canBlock);
  button('分隔线', () => editor.chain().focus().setHorizontalRule().run(), undefined, canBlock);
  const language = select('代码语言', CODE_LANGUAGES.map(value => [value, value === 'plaintext' ? '纯文本' : value]), value => {
    if (editor.isActive('codeBlock')) editor.chain().focus().updateAttributes('codeBlock', { language: value }).run();
  });
  button('代码块', () => editor.chain().focus().toggleCodeBlock({ language: language.value }).run(), () => editor.isActive('codeBlock'), canBlock);
  const href = input('链接地址'); href.inputMode = 'url'; href.placeholder = 'https://、/公开路径或 #锚点'; href.autocomplete = 'off';
  button('应用链接', () => {
    const value = safeHref(href.value);
    if (!value) throw new Error('链接须使用 HTTPS、本站公开路径或本页锚点。');
    editor.chain().focus().extendMarkRange('link').setMark('link', { href: value }).run();
  });
  button('移除链接', () => editor.chain().focus().extendMarkRange('link').unsetMark('link').run());
  const rows = input('表格行数', { type: 'number', value: '2', min: 1, max: CONTENT_LIMITS.TableRows });
  const columns = input('表格列数', { type: 'number', value: '2', min: 1, max: CONTENT_LIMITS.TableColumns });
  const headers = input('首行为表头', { type: 'checkbox' }); headers.checked = true;
  button('插入表格', () => {
    const r = Number(rows.value), c = Number(columns.value);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 1 || r > CONTENT_LIMITS.TableRows || c < 1 || c > CONTENT_LIMITS.TableColumns) throw new Error('表格须为 1 至 20 行、1 至 6 列。');
    editor.chain().focus().insertContent({ type: 'table', content: Array.from({ length: r }, (_, index) => ({
      type: 'tableRow', content: Array.from({ length: c }, () => ({
        type: headers.checked && index === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: [] }],
      })),
    })) }).run();
  }, undefined, () => !editor.isActive('table'));
  button('删除表格', () => editor.chain().focus().deleteNode('table').run(), undefined, () => editor.isActive('table'));
  button('撤销', () => editor.chain().focus().undo().run(), undefined, () => editor.can().undo());
  button('重做', () => editor.chain().focus().redo().run(), undefined, () => editor.can().redo());
  const more = document.createElement('details'); more.className = 'editor-more';
  const summary = document.createElement('summary'); summary.textContent = '更多格式';
  const advanced = document.createElement('div'); advanced.className = 'toolbar-advanced';
  more.append(summary, advanced);
  const basic = new Set(['正文', '二级标题', '三级标题', '加粗', '斜体', '撤销', '重做']);
  for (const control of [...toolbar.children]) {
    if (control.tagName !== 'BUTTON' || !basic.has(control.textContent)) advanced.append(control);
  }
  toolbar.append(more);
  function updateControls() {
    if (!editor || destroyed) return;
    for (const [control, canUse] of controls) control.disabled = !editor.isEditable || !canUse();
    for (const [control, active] of activeButtons) control.setAttribute('aria-pressed', String(active()));
    color.value = editor.getAttributes('textColor').token || 'default';
    surface.querySelector('[contenteditable]')?.setAttribute('aria-readonly', String(!editor.isEditable));
    element.dataset.editable = String(editor.isEditable);
  }
  editor = new Editor({
    element: surface, extensions: editorExtensions(reportError), content: withCaretParagraph(initial), editable,
    injectCSS: false, enableContentCheck: true,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': '文章正文', 'aria-multiline': 'true', spellcheck: 'true' },
      handlePaste: (_view, event) => {
        event.preventDefault();
        if (!editor.isEditable || destroyed) return true;
        if (event.clipboardData?.files.length) { reportError('当前阶段不支持粘贴或上传媒体文件。'); return true; }
        try {
          const pasted = parseClipboard(editor.schema, { html: event.clipboardData?.getData('text/html') || '', plain: event.clipboardData?.getData('text/plain') || '' });
          if (pasted.content.length) editor.commands.insertContent(pasted.content);
        } catch (error) { reportError(error.message); }
        return true;
      },
      handleDOMEvents: {
        drop: (_view, event) => {
          event.preventDefault();
          if (editor.isEditable) reportError('请粘贴文字；当前阶段不支持拖入文件或外部内容。');
          return true;
        },
      },
    },
    onUpdate: () => {
      if (destroyed || replacing) return;
      updateControls();
      try { onUpdate(currentJSON()); } catch (error) { reportError(error.message); }
    },
    onSelectionUpdate: updateControls,
    onTransaction: updateControls,
  });
  updateControls();
  const api = {
    getJSON: currentJSON,
    setContent(value) {
      if (destroyed) return false;
      try {
        const normalized = normalizeDocument(value);
        // Check the actual schema too, before any replacement can discard content.
        editor.schema.nodeFromJSON(withCaretParagraph(normalized)).check();
        replacing = true;
        const result = editor.commands.setContent(withCaretParagraph(normalized), { emitUpdate: false, errorOnInvalidContent: true });
        feedback.textContent = ''; updateControls(); return result;
      } catch (error) { reportError(error.message); return false; }
      finally { replacing = false; }
    },
    setEditable(value) { if (!destroyed) { editor.setEditable(Boolean(value), false); updateControls(); } },
    destroy() {
      if (destroyed) return;
      destroyed = true; events.abort(); editor.destroy(); element.replaceChildren();
      element.classList.remove('body-editor'); delete element.dataset.editable;
      instances.delete(element);
    },
  };
  instances.set(element, api);
  return api;
}
