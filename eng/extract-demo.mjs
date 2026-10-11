import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { JSDOM } from "../frontend/editor/node_modules/jsdom/lib/api.js";
import { normalizeDocument } from "../frontend/editor/src/contract.mjs";

// Read the audited prototype commit so regeneration survives the API integration.
const source = execFileSync(
  "git",
  ["show", "81eed0f397dfe7ca1a2fe66d6fa2418b2ed480c1:dist/app.js"],
  { encoding: "utf8" },
);
const sandbox = {
  document: { querySelector: () => null, querySelectorAll: () => [] },
  matchMedia: () => ({ matches: false }),
};
vm.createContext(sandbox);
vm.runInContext(
  source.slice(0, source.indexOf("function setupExperience")) +
    ";result={articles,projects,columns,chapters,galleryArt,covers};",
  sandbox,
);
const original = JSON.parse(JSON.stringify(sandbox.result));
function uuid(text) {
  const hex = createHash("sha256").update(text).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
const media = new Map();
function asset(path, meta = {}) {
  if (media.has(path)) return media.get(path).id;
  const bytes = readFileSync("dist" + path),
    probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=width,height:format=duration",
          "-of",
          "json",
          "dist" + path,
        ],
        { encoding: "utf8" },
      ),
    );
  const size = probe.streams.find((s) => s.width && s.height);
  const kind = path.endsWith(".mp4") ? "Video" : "Image";
  const extension = path.split(".").at(-1),
    mime = {
      png: "image/png",
      jpg: "image/jpeg",
      webp: "image/webp",
      mp4: "video/mp4",
    }[extension];
  const record = {
    id: uuid(path),
    kind,
    mimeType: mime,
    designPath: path,
    width: size.width,
    height: size.height,
    durationMs:
      kind === "Video"
        ? Math.round(Number(probe.format.duration) * 1000)
        : null,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    alt: meta.alt || "示例素材",
    caption: meta.title || "",
    credit: meta.author || "",
    sourceUrl: meta.source || "",
    licenseName: meta.author ? "Unsplash License" : "见 THIRD_PARTY_ASSETS.md",
    licenseUrl: meta.author ? "https://unsplash.com/license" : "",
  };
  media.set(path, record);
  return record.id;
}
const gallery = original.galleryArt.map((item) => asset(item.src, item));
function inline(node, marks = []) {
  if (node.nodeType === 3)
    return node.textContent
      ? [
          {
            type: "text",
            text: node.textContent,
            ...(marks.length ? { marks } : {}),
          },
        ]
      : [];
  const tag = node.tagName?.toLowerCase();
  if (tag === "br") return [{ type: "hardBreak" }];
  const mark = {
    strong: "bold",
    b: "bold",
    em: "italic",
    i: "italic",
    s: "strike",
    code: "code",
  }[tag];
  let next = mark ? [...marks, { type: mark }] : marks;
  if (tag === "a")
    next = [
      ...marks,
      { type: "link", attrs: { href: node.getAttribute("href") } },
    ];
  return [...node.childNodes].flatMap((n) => inline(n, next));
}
function block(node) {
  const tag = node.tagName?.toLowerCase();
  if (node.nodeType === 3)
    return node.textContent.trim()
      ? [{ type: "paragraph", content: inline(node) }]
      : [];
  if (["p", "h2", "h3"].includes(tag))
    return [
      {
        type: tag === "p" ? "paragraph" : "heading",
        ...(tag === "p"
          ? {}
          : {
              attrs: {
                level: Number(tag[1]),
                id: uuid(node.id || node.textContent),
              },
            }),
        content: [...node.childNodes].flatMap((n) => inline(n)),
      },
    ];
  if (tag === "pre")
    return [
      {
        type: "codeBlock",
        attrs: { language: "plaintext" },
        content: [{ type: "text", text: node.textContent }],
      },
    ];
  if (tag === "ul" || tag === "ol")
    return [
      {
        type: tag === "ul" ? "bulletList" : "orderedList",
        ...(tag === "ol" ? { attrs: { start: 1 } } : {}),
        content: [...node.children].map((n) => ({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [...n.childNodes].flatMap((c) => inline(c)),
            },
          ],
        })),
      },
    ];
  if (tag === "aside" || tag === "blockquote")
    return [
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: node.textContent }],
          },
        ],
      },
    ];
  if (tag === "video") {
    const path =
      node.querySelector("source")?.getAttribute("src") ||
      node.getAttribute("src");
    return [
      {
        type: "video",
        attrs: {
          mediaId: asset(path),
          posterMediaId: null,
          caption: "原创场景视频 · 示例",
        },
      },
    ];
  }
  if (tag === "img") {
    const alt = node.getAttribute("alt") || "示例图片";
    return [
      {
        type: "image",
        attrs: {
          mediaId: asset(node.getAttribute("src")),
          alt,
          caption: "",
          displayMeta: {
            alt,
            caption: "",
            credit: "",
            sourceUrl: "",
            licenseName: "见 THIRD_PARTY_ASSETS.md",
            licenseUrl: "",
          },
        },
      },
    ];
  }
  if (node.matches?.(".diagram"))
    return [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [...node.querySelectorAll(".diagram-node")].map((n) => ({
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: n.textContent }],
                },
              ],
            })),
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: node.querySelector("figcaption")?.textContent || "",
          },
        ],
      },
    ];
  if (node.matches?.(".code-wrap"))
    return [...node.querySelectorAll("pre")].flatMap(block);
  if (tag === "figcaption") return [];
  return [...node.childNodes].flatMap(block);
}
const articles = original.articles.map((a) => ({
  id: uuid("article:" + a.id),
  slug: a.id,
  kind: a.category === "生活随记" ? "Life" : "Article",
  title: a.title,
  summary: a.desc,
  intro: a.intro,
  columnSlug: original.columns.find((c) => c.articleIds.includes(a.id)).id,
  coverMediaId: asset("/assets/" + original.covers[a.id]),
  content: normalizeDocument({
    type: "doc",
    content: [...new JSDOM(a.body).window.document.body.childNodes].flatMap(
      block,
    ),
  }),
}));
const projects = original.projects.map((p, i) => ({
  ...p,
  id: uuid("project:" + p.id),
  slug: p.id,
  coverMediaId: asset(
    "/assets/" + (i ? "network-fibers.png" : "sculptural-glass.png"),
  ),
  position: i + 1,
}));
const settings = {
  homeAbout:
    "I’m a developer who loves turning ideas into things you can use. This is where I share what I build, what I learn, and the moments I want to remember. From code and side projects to everyday discoveries, I’m always curious about what comes next.",
  aboutTitle: "技术，知识，还有生活。",
  aboutText:
    "文章用来展开一个想法，知识库用来整理一条路径，项目用来记录一次尝试。生活随记，则留给不需要急着得出结论的瞬间。",
  aboutNote: "文章与项目中标注为示例的内容用于展示，不代表作者真实经历。",
  galleryIds: gallery,
  featuredIds: articles.slice(0, 3).map((a) => a.id),
  topics: original.columns.map((c) => c.name),
};
mkdirSync("data", { recursive: true });
writeFileSync(
  "data/demo-content.json",
  JSON.stringify(
    {
      format: 1,
      media: [...media.values()],
      articles,
      columns: original.columns.map((c) => ({
        ...c,
        slug: c.id,
        id: uuid("column:" + c.id),
        imageIds: c.images.map((i) => gallery[i]),
      })),
      projects,
      chapters: original.chapters,
      settings,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Converted ${articles.length} demo articles, ${projects.length} projects and ${media.size} registered assets. Diagrams become structured tables; callouts become blockquotes.`,
);
