import {
  api,
  allPages,
  root,
  esc,
  on,
  field,
  area,
  value,
  selectMedia,
  status,
  reauthenticate,
  sortable,
  pageHeading,
  stateBadge,
  stateLabel,
} from "./api.js";
import { createBodyEditor } from "./editor.bundle.js";
let editor = null;
let dirty = false;
export function dispose() {
  editor?.destroy();
  editor = null;
  dirty = false;
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
export async function articlesPage() {
  dispose();
  const columns = (await api("/columns")).items;
  root.innerHTML = `${pageHeading("文章与随记", "记录想法、知识与生活，手动保存并发布内容。")}<details class="create-disclosure"><summary>＋ 新建文章或随记</summary><form id="create-article" class="card"><div class="split">${field("标题", "title")}${field("地址（小写字母、数字和短横线）", "slug")}</div><label>类型<select name="kind"><option value="Article">文章</option><option value="Life">生活随记</option></select></label><button type="submit">创建草稿</button></form></details><form id="article-filter" class="toolbar">${field("搜索标题或地址", "q")}<label>状态<select name="state"><option value="">全部</option>${["Draft", "Published", "Withdrawn", "Trashed", "Purged"].map((s) => `<option value="${s}">${stateLabel(s)}</option>`).join("")}</select></label><label>专栏<select name="columnId"><option value="">全部</option>${columns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label><button>筛选</button></form><div id="article-list"></div>`;
  let page = 1;
  async function list() {
    const form = root.querySelector("#article-filter");
    const params = new URLSearchParams({ page });
    for (const key of ["q", "state", "columnId"])
      if (value(form, key)) params.set(key, value(form, key));
    const data = await api("/articles?" + params);
    root.querySelector("#article-list").innerHTML =
      `<div class="table-scroll"><table><thead><tr><th>标题 / 地址</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.items.map((a) => `<tr><td>${esc(a.draft?.title || a.slug)}${a.isDemo ? ' <span class="badge">示例</span>' : ""}<br><small>${a.slug}</small></td><td>${a.kind === "Life" ? "随记" : "文章"}</td><td>${stateBadge(a.state)}</td><td><button data-edit="${a.id}" ${a.state === "Purged" ? "disabled" : ""}>管理</button></td></tr>`).join("")}</tbody></table></div><div class="actions"><button data-prev ${page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${page} 页，共 ${data.total} 条</span><button data-next ${page * 20 >= data.total ? "disabled" : ""}>下一页</button></div>`;
    root
      .querySelectorAll("[data-edit]")
      .forEach((b) =>
        on(`[data-edit="${b.dataset.edit}"]`, "click", () =>
          editArticle(b.dataset.edit),
        ),
      );
    on("[data-prev]", "click", async () => {
      page--;
      await list();
    });
    on("[data-next]", "click", async () => {
      page++;
      await list();
    });
  }
  on("#article-filter", "submit", async () => {
    page = 1;
    await list();
  });
  on("#create-article", "submit", async (e) => {
    const f = e.currentTarget;
    const a = await api("/articles", {
      method: "POST",
      key: true,
      body: {
        title: value(f, "title"),
        slug: value(f, "slug"),
        kind: value(f, "kind"),
      },
    });
    await editArticle(a.id);
  });
  await list();
}
export async function editArticle(id) {
  dispose();
  let article = await api("/articles/" + id);
  const [columnData, media] = await Promise.all([
    api("/columns"),
    allPages("/media?state=Ready"),
  ]);
  const draft = article.draft;
  if (!draft) {
    root.innerHTML = "<h1>文章已永久清空</h1>";
    return;
  }
  const columnOptions = columnData.items.filter(c => c.state !== "Archived").map(c => `<option value="${c.id}" ${c.id === draft.columnId ? "selected" : ""}>${esc(c.name)}（${stateLabel(c.state)}）</option>`).join("");
  root.innerHTML = `<button type="button" class="secondary" data-back>← 返回文章列表</button>${pageHeading("编辑文章", article.slug + " · 手动保存，发布后更新公开内容。")}<form id="article-edit"><div class="editor-savebar"><span class="muted">${stateBadge(article.state)} <span id="unsaved" class="unsaved"></span></span><div class="actions"><button type="submit" class="secondary">保存草稿</button><button type="button" class="secondary" data-preview>预览</button><button type="button" data-publish ${article.state === "Trashed" ? "disabled" : ""}>发布已保存内容</button></div></div><div class="article-editor-layout"><section class="article-writing">${field("文章标题", "title", draft.title)}<label>正文</label><div id="body-editor"></div><p class="editor-note">手动保存草稿；发布后访客才能看到更新。正文图片和视频从已就绪的媒体库插入。</p><div class="actions"><select id="insert-media"><option value="">选择正文媒体</option>${media.map(m => `<option value="${m.id}">${m.kind === "Video" ? "视频" : "图片"} · ${esc(m.alt || m.caption || m.id.slice(0,8))}</option>`).join("")}</select><button type="button" class="secondary" data-insert>插入正文末尾</button></div></section><aside class="article-settings"><h2>文章设置</h2><label>所属专栏<select name="columnId"><option value="">未选择</option>${columnOptions}</select></label>${selectMedia("封面图片", "coverMediaId", media, draft.coverMediaId)}${area("摘要", "summary", draft.summary)}${area("导读", "intro", draft.intro)}</aside></div></form><div class="actions">${article.state === "Published" ? '<button type="button" class="secondary" data-action="withdraw">撤回发布</button>' : ""}${article.state === "Trashed" ? '<button type="button" data-action="restore">恢复到草稿</button><button type="button" class="danger" data-purge>永久清空</button>' : '<button type="button" class="danger" data-action="trash">移入回收站</button>'}<a href="/#/article/${article.slug}" target="_blank" rel="noopener">查看公开页面 ↗</a></div><section id="preview"></section><section class="card"><h2>发布历史</h2><div id="history"></div></section>`;
  const form = root.querySelector("#article-edit");
  const mark = () => {
    dirty = true;
    root.querySelector("#unsaved").textContent = "有未保存修改";
  };
  form.addEventListener("input", mark);
  editor = createBodyEditor(root.querySelector("#body-editor"), {
    content: draft.contentJson,
    onUpdate: mark,
    editable: article.state !== "Trashed",
    onError: status,
  });
  if (article.state === "Trashed")
    for (const control of form.elements) control.disabled = true;
  const input = () => ({
    title: value(form, "title"),
    summary: value(form, "summary"),
    intro: value(form, "intro"),
    columnId: value(form, "columnId") || null,
    coverMediaId: value(form, "coverMediaId") || null,
    contentJson: editor.getJSON(),
    schemaVersion: 1,
  });
  on("[data-back]", "click", async () => {
    if (dirty && !confirm("有未保存修改，确定离开？")) return;
    await articlesPage();
  });
  on("#article-edit", "submit", async () => {
    const currentEditor = editor, body = input();
    currentEditor.setEditable(false);
    try {
      const saved = await api(`/articles/${id}/draft`, {
        method: "PUT",
        etag: article.draft.etag,
        body,
      });
      article.draft = saved;
      if (editor === currentEditor && form.isConnected) {
        dirty = false;
        root.querySelector("#unsaved").textContent = "已保存";
      }
      status("草稿已保存。");
    } finally {
      currentEditor.setEditable(article.state !== "Trashed");
    }
  });
  on("[data-publish]", "click", async () => {
    if (dirty) throw new Error("请先保存当前草稿，再发布。");
    article = await api(`/articles/${id}/publish`, {
      method: "POST",
      key: true,
      etag: article.etag,
      body: { draftEtag: article.draft.etag },
    });
    dirty = false;
    await editArticle(id);
    status("文章已发布。");
  });
  on("[data-preview]", "click", async () => {
    if (dirty) throw new Error("请先保存草稿，再预览。");
    const result = await api(`/articles/${id}/preview`);
    root.querySelector("#preview").innerHTML =
      `<section class="preview"><h2>${esc(result.title)}</h2><p>${esc(result.intro)}</p>${result.html}</section>`;
  });
  on("[data-insert]", "click", () => {
    const m = media.find(
      (x) => x.id === root.querySelector("#insert-media").value,
    );
    if (!m) throw new Error("请先选择媒体。");
    const document = editor.getJSON();
    const alt = m.alt || "图片";
    document.content.push(
      m.kind === "Image"
        ? {
            type: "image",
            attrs: {
              mediaId: m.id,
              alt,
              caption: m.caption,
              displayMeta: {
                alt,
                caption: m.caption,
                credit: m.credit,
                sourceUrl: m.source,
                licenseName: m.licenseName,
                licenseUrl: m.licenseUrl,
              },
            },
          }
        : {
            type: "video",
            attrs: { mediaId: m.id, posterMediaId: null, caption: m.caption },
          },
    );
    editor.setContent(document);
    mark();
  });
  root.querySelectorAll("[data-action]").forEach((b) =>
    on(`[data-action="${b.dataset.action}"]`, "click", async () => {
      if (dirty) throw new Error("请先保存或明确放弃当前修改。");
      await api(`/articles/${id}/${b.dataset.action}`, {
        method: "POST",
        key: true,
        etag: article.etag,
      });
      await editArticle(id);
      status("文章状态已更新。");
    }),
  );
  on("[data-purge]", "click", async () => {
    if (prompt("永久清空不可恢复。请输入完整文章地址：") !== article.slug)
      return;
    if (!(await reauthenticate())) return;
    await api(`/articles/${id}/purge`, {
      method: "POST",
      key: true,
      etag: article.etag,
      body: { confirmSlug: article.slug },
    });
    await articlesPage();
    status("文章已永久清空。");
  });
  const history = await api(`/articles/${id}/revisions`);
  root.querySelector("#history").innerHTML =
    history
      .map(
        (r) =>
          `<p>版本 ${r.number} · ${esc(r.title)} <button class="secondary" data-revision="${r.id}">恢复为工作草稿</button></p>`,
      )
      .join("") || '<p class="muted">还没有发布版本。</p>';
  root.querySelectorAll("[data-revision]").forEach((b) =>
    on(`[data-revision="${b.dataset.revision}"]`, "click", async () => {
      if (dirty) throw new Error("请先保存或放弃当前修改。");
      await api(`/articles/${id}/revisions/${b.dataset.revision}/restore`, {
        method: "POST",
        key: true,
        etag: article.draft.etag,
      });
      await editArticle(id);
      status("历史版本已恢复到草稿，公开版本保持原样。");
    }),
  );
}
