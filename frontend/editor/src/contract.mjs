import approvedLimits from './content-limits.json' with { type: 'json' };

export const CONTENT_LIMITS = Object.freeze(approvedLimits);
export const CODE_LANGUAGES = Object.freeze(['plaintext', 'javascript', 'typescript', 'csharp', 'sql', 'json', 'bash', 'html', 'css', 'python']);
export const COLOR_TOKENS = Object.freeze(['default', 'purple', 'gold']);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyUuid = '00000000-0000-0000-0000-000000000000';
const blockTypes = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule', 'codeBlock', 'table', 'image', 'video'];
const inlineTypes = ['text', 'hardBreak'];
const markOrder = ['link', 'textColor', 'bold', 'italic', 'strike', 'code'];
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('正文含有不支持的节点或属性。');
};
export function scalarLength(value) { return Array.from(value.normalize('NFC')).length; }
function text(value, limit = CONTENT_LIMITS.BodyScalars) {
  if (typeof value !== 'string' || Array.from(value).some(char => char.length === 1 && /[\uD800-\uDFFF]/u.test(char))) fail('正文文字格式不正确。');
  const normalized = value.normalize('NFC');
  if (scalarLength(normalized) > limit) fail('正文或说明文字超过允许长度。');
  return normalized;
}
function uuid(value) { return typeof value === 'string' && UUID.test(value) && value.toLowerCase() !== emptyUuid; }
export function safeHref(input, origin = globalThis.location?.origin || 'https://editor.invalid') {
  if (typeof input !== 'string' || !input || scalarLength(input) > CONTENT_LIMITS.LinkScalars || /[\s\\\u0000-\u001f\u007f-\u009f]/u.test(input)) return null;
  let decoded = input;
  try {
    for (let i = 0; i < 8; i++) {
      const next = decodeURIComponent(decoded);
      if (/[\\\u0000-\u001f\u007f-\u009f]/u.test(next)) return null;
      if (next === decoded) break;
      decoded = next;
      if (i === 7) return null;
    }
    if (input.startsWith('#')) return input.length > 1 ? input.normalize('NFC') : null;
    const relative = input.startsWith('/') && !input.startsWith('//');
    if (!relative && !/^https:\/\//i.test(input)) return null;
    if (relative && decoded.startsWith('//')) return null;
    const url = new URL(input, origin);
    if (url.username || url.password || (!relative && url.protocol !== 'https:')) return null;
    const decodedUrl = new URL(decoded, origin);
    if (/^\/(?:admin|api\/admin)(?:\/|$)/i.test(decodedUrl.pathname)) return null;
    return relative ? `${decodedUrl.pathname}${decodedUrl.search}${decodedUrl.hash}` : url.href;
  } catch { return null; }
}

export function extractPlainText(node) {
  if (node.type === 'text') return node.text.normalize('NFC');
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'image' || node.type === 'video') return node.attrs.caption.normalize('NFC');
  return (node.content ?? []).map(extractPlainText).join(['paragraph', 'heading', 'codeBlock'].includes(node.type) ? '' : '\n').normalize('NFC');
}

/** UX boundary only. Server independently validates and authorizes every saved document. */
export function normalizeDocument(input, { newHeadingIds = false } = {}) {
  let bytes;
  try { bytes = new TextEncoder().encode(JSON.stringify(input)).length; }
  catch { fail('正文 JSON 格式不正确。'); }
  if (bytes > CONTENT_LIMITS.JsonBytes) fail('正文 JSON 超过 2 MiB。');
  const headingIds = new Set();
  let nodeCount = 0;
  const marks = inputMarks => {
    if (inputMarks === undefined) return undefined;
    if (!Array.isArray(inputMarks)) fail('文字格式不正确。');
    const types = new Set();
    return inputMarks.map(mark => {
      exactKeys(mark, ['type', 'attrs']);
      if (types.has(mark.type)) fail('文字格式重复。');
      types.add(mark.type);
      const attrs = mark.attrs ?? {};
      if (['bold', 'italic', 'strike', 'code'].includes(mark.type)) {
        exactKeys(attrs, []); return { type: mark.type };
      }
      if (mark.type === 'textColor') {
        exactKeys(attrs, ['token']);
        if (!COLOR_TOKENS.includes(attrs.token)) fail('文字颜色只支持默认、紫色和浅金。');
        return { type: 'textColor', attrs: { token: attrs.token } };
      }
      if (mark.type === 'link') {
        exactKeys(attrs, ['href']); const href = safeHref(attrs.href);
        if (!href) fail('链接须使用 HTTPS、本站公开路径或本页锚点。');
        return { type: 'link', attrs: { href } };
      }
      fail('正文含有不支持的文字格式。');
    }).sort((a, b) => markOrder.indexOf(a.type) - markOrder.indexOf(b.type));
  };
  function visit(node, depth, allowed, insideTable = false) {
    if (++nodeCount > CONTENT_LIMITS.JsonNodes || depth > CONTENT_LIMITS.JsonDepth) fail('正文节点数量或嵌套层级超过限制。');
    exactKeys(node, ['type', 'attrs', 'content', 'text', 'marks']);
    if (!allowed.includes(node.type)) fail('正文结构包含不允许的节点。');
    const out = { type: node.type }, attrs = node.attrs ?? {};
    let childTypes = [], minChildren = 0;
    if (node.type !== 'text' && ('text' in node || (node.marks?.length ?? 0) > 0)) fail('正文节点的文字或格式位置不正确。');
    switch (node.type) {
      case 'doc': childTypes = blockTypes; exactKeys(attrs, []); break;
      case 'paragraph': childTypes = inlineTypes; exactKeys(attrs, []); break;
      case 'text': {
        exactKeys(attrs, []);
        if ('content' in node) fail('文字节点不能包含其他节点。');
        out.text = text(node.text);
        if (!out.text) fail('文字节点不能为空。');
        const normalizedMarks = marks(node.marks);
        if (normalizedMarks?.length) out.marks = normalizedMarks;
        return out;
      }
      case 'hardBreak': exactKeys(attrs, []); break;
      case 'heading': {
        exactKeys(attrs, ['level', 'id']);
        if (![2, 3].includes(attrs.level)) fail('正文仅支持二级和三级标题。');
        if (attrs.id != null && !uuid(attrs.id)) fail('标题锚点格式不正确。');
        let id = newHeadingIds || attrs.id == null ? crypto.randomUUID() : attrs.id.toLowerCase();
        if (headingIds.has(id)) id = crypto.randomUUID();
        headingIds.add(id);
        out.attrs = { level: attrs.level, id }; childTypes = inlineTypes; break;
      }
      case 'orderedList':
        exactKeys(attrs, ['start']);
        if (!Number.isInteger(attrs.start) || attrs.start < 1 || attrs.start > 9999) fail('有序列表起始编号须为 1 至 9999。');
        out.attrs = { start: attrs.start }; childTypes = ['listItem']; minChildren = 1; break;
      case 'bulletList': exactKeys(attrs, []); childTypes = ['listItem']; minChildren = 1; break;
      case 'listItem': exactKeys(attrs, []); childTypes = blockTypes; minChildren = 1; break;
      case 'blockquote': exactKeys(attrs, []); childTypes = blockTypes; minChildren = 1; break;
      case 'horizontalRule': exactKeys(attrs, []); break;
      case 'codeBlock':
        exactKeys(attrs, ['language']);
        if (attrs.language != null && typeof attrs.language !== 'string') fail('代码语言格式不正确。');
        out.attrs = { language: CODE_LANGUAGES.includes(attrs.language) ? attrs.language : 'plaintext' };
        childTypes = ['text']; break;
      case 'table':
        exactKeys(attrs, []);
        if (insideTable) fail('表格不能嵌套。');
        childTypes = ['tableRow']; minChildren = 1; insideTable = true; break;
      case 'tableRow': exactKeys(attrs, []); childTypes = ['tableCell', 'tableHeader']; minChildren = 1; break;
      case 'tableCell': case 'tableHeader': exactKeys(attrs, []); childTypes = ['paragraph']; minChildren = 1; break;
      case 'image': {
        exactKeys(attrs, ['mediaId', 'alt', 'caption', 'displayMeta']);
        if (!uuid(attrs.mediaId)) fail('图片媒体标识不正确。');
        const alt = text(attrs.alt, CONTENT_LIMITS.AltScalars), caption = text(attrs.caption, CONTENT_LIMITS.CaptionScalars);
        if (!alt.trim()) fail('图片需要替代文字。');
        const meta = attrs.displayMeta;
        exactKeys(meta, ['alt', 'caption', 'credit', 'sourceUrl', 'licenseName', 'licenseUrl']);
        const displayMeta = {
          alt: text(meta.alt, CONTENT_LIMITS.AltScalars), caption: text(meta.caption, CONTENT_LIMITS.CaptionScalars),
          credit: text(meta.credit, CONTENT_LIMITS.CreditScalars), sourceUrl: text(meta.sourceUrl, CONTENT_LIMITS.LinkScalars),
          licenseName: text(meta.licenseName, CONTENT_LIMITS.LicenseScalars), licenseUrl: text(meta.licenseUrl, CONTENT_LIMITS.LinkScalars),
        };
        if (displayMeta.alt !== alt || displayMeta.caption !== caption) fail('图片说明快照与正文不一致。');
        for (const field of ['sourceUrl', 'licenseUrl']) if (displayMeta[field]) {
          const url = safeHref(displayMeta[field]);
          if (!/^https:\/\//i.test(displayMeta[field]) || !url) fail('来源和许可须使用 HTTPS 链接。');
          displayMeta[field] = url;
        }
        out.attrs = { mediaId: attrs.mediaId.toLowerCase(), alt, caption, displayMeta }; break;
      }
      case 'video':
        exactKeys(attrs, ['mediaId', 'posterMediaId', 'caption']);
        if (!uuid(attrs.mediaId) || (attrs.posterMediaId != null && !uuid(attrs.posterMediaId))) fail('视频或海报媒体标识不正确。');
        out.attrs = { mediaId: attrs.mediaId.toLowerCase(), posterMediaId: attrs.posterMediaId?.toLowerCase() ?? null, caption: text(attrs.caption, CONTENT_LIMITS.CaptionScalars) };
        break;
      default: fail('正文结构不正确。');
    }
    if (node.content !== undefined && !Array.isArray(node.content)) fail('正文子节点格式不正确。');
    const children = node.content ?? [];
    if (children.length < minChildren || (!childTypes.length && children.length)) fail('正文结构不完整。');
    if (childTypes.length) out.content = children.map(child => visit(child, depth + 1, childTypes, insideTable));
    const contentText = extractPlainText;
    if (node.type === 'listItem' && out.content[0].type !== 'paragraph') fail('列表项须从普通段落开始。');
    if (node.type === 'codeBlock' && (scalarLength(contentText(out)) > CONTENT_LIMITS.CodeScalars || out.content.some(child => child.marks?.length))) fail('代码块仅支持限定长度的纯文本。');
    if (['tableCell', 'tableHeader'].includes(node.type) && scalarLength(contentText(out)) > CONTENT_LIMITS.CellScalars) fail('每个表格单元最多 2000 个字符。');
    if (node.type === 'table') {
      const columns = out.content[0]?.content.length;
      if (out.content.length > CONTENT_LIMITS.TableRows || columns < 1 || columns > CONTENT_LIMITS.TableColumns || out.content.some((row, index) => row.content.length !== columns || (index > 0 && row.content.some(cell => cell.type === 'tableHeader'))) || new Set(out.content[0].content.map(cell => cell.type)).size > 1) fail('表格须为 1 至 20 行、1 至 6 列，表头仅在第一整行。');
    }
    return out;
  }
  const result = visit(input, 1, ['doc']);
  if (scalarLength(extractPlainText(result)) > CONTENT_LIMITS.BodyScalars) fail('正文总文字超过 100000 个字符。');
  if (new TextEncoder().encode(JSON.stringify(result)).length > CONTENT_LIMITS.JsonBytes) fail('正文 JSON 超过 2 MiB。');
  return result;
}
