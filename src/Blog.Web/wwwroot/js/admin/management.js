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
  sortable,
  pageHeading,
  stateBadge,
  stateLabel,
  setDirty,
} from "./api.js";
import { chooseImage } from "./site.js";
import { completeSlots, fixedSlots, columnPositions } from "./site-contract.js";

export async function columnsPage() {
  setDirty(false);
  const data = await api("/columns");
  const active = data.items.filter(column => column.state === "Active");
  root.innerHTML = `${pageHeading("专栏管理", "每个专栏对应一张首页卡片，维护名称、介绍与固定的 3 张图片。", '<button type="button" data-new>新建专栏</button>')}<div class="column-card-grid">${data.items.map(c => `<article class="column-admin-card"><header><span>${c.state === "Active" ? String(active.indexOf(c) + 1).padStart(2, "0") + " / 首页专栏" : "尚未展示"}</span>${stateBadge(c.state)}</header><div class="column-thumb-mosaic">${c.images.map(image => `<img src="${esc(image.src)}" alt="${esc(image.alt)}"/>`).join("")}</div><div><h2>${esc(c.name)}</h2><p>${esc(c.introduction)}</p><div class="section-toolbar"><span class="muted">${c.publishedArticleCount} 篇已发布文章</span><button type="button" class="secondary" data-edit="${c.id}">管理专栏</button></div></div></article>`).join("") || '<p class="empty-state">还没有专栏。创建专栏并启用后会出现在首页。</p>'}</div>`;
  sortable(
    data.items,
    (x) => x.name,
    async (ids) => {
      await api("/columns/order", {
        method: "PUT",
        etag: data.siteEtag,
        body: { ids },
      });
      await columnsPage();
      status("专栏顺序已保存。");
    },
  );
  on("[data-new]", "click", () => editColumn());
  root
    .querySelectorAll("[data-edit]")
    .forEach((b) =>
      on(`[data-edit="${b.dataset.edit}"]`, "click", () =>
        editColumn(b.dataset.edit),
      ),
    );
}
async function editColumn(id) {
  const c = id
    ? await api("/columns/" + id)
    : { slug: "", name: "", introduction: "", imageIds: [], state: "Draft" };
  const media = await allPages("/media?state=Ready");
  const slots = fixedSlots(c.imageIds, 3);
  let dirty = false;
  root.innerHTML = `<button type="button" class="secondary" data-back>← 返回专栏</button>${pageHeading(id ? "编辑专栏" : "新建专栏", "名称、介绍和 3 张不同图片填写完整后才能保存。")}<form id="column-form"><div class="column-form-layout"><div>${field("专栏地址（创建后固定）", "slug", c.slug)}${field("专栏名称", "name", c.name)}${area("专栏介绍", "introduction", c.introduction)}<p class="field-hint">介绍最多 1200 字，展示编号随首页顺序生成。</p><div class="actions"><button type="submit" id="column-save">保存专栏</button><span id="column-validation" class="muted"></span></div></div><section class="column-image-settings"><h2>专栏展示图片 <span class="count-badge" id="column-count"></span></h2><p class="muted">每张图的电脑和手机位置已标注。</p><div id="column-slots" data-validation-for="imageIds"></div><div class="column-layout-preview"><h3>电脑卡片拼图预览</h3><div class="column-thumb-mosaic" id="column-mosaic-preview"></div></div></section></div></form>${id ? `<div class="actions">${stateBadge(c.state)}${c.state !== "Active" ? '<button type="button" data-state="activate">启用专栏</button>' : ""}${c.state !== "Archived" ? '<button type="button" class="secondary" data-state="archive">归档专栏</button>' : ""}</div>` : ""}`;
  const form = root.querySelector("#column-form");
  form.elements.namedItem("name").required = true;
  form.elements.namedItem("introduction").required = true;
  form.elements.namedItem("introduction").maxLength = 1200;
  if (id) form.slug.disabled = true;
  function mark() { dirty = true; setDirty(true); }
  function paint() {
    const valid = completeSlots(slots, 3) && slots.every(id => media.some(image => image.id === id && image.kind === "Image"));
    root.querySelector("#column-count").textContent = slots.filter(Boolean).length + " / 3";
    const button = root.querySelector("#column-save"); button.dataset.valid = String(valid); button.disabled = !valid;
    root.querySelector("#column-validation").textContent = valid ? "3 张图片已完整" : "请补齐 3 张不同图片";
    root.querySelector("#column-slots").innerHTML = slots.map((imageId, index) => {
      const image = media.find(item => item.id === imageId), position = columnPositions[index];
      return `<article class="image-slot">${image ? `<img src="${esc(image.src)}" alt="${esc(image.alt)}"/>` : '<div class="slot-placeholder"><span>＋</span></div>'}<header><span class="slot-number">0${index + 1}</span><span>电脑：${position.desktop}<br/>手机：${position.mobile}</span></header><div class="slot-copy"><div class="slot-actions"><button type="button" class="secondary" data-image-slot="${index}">${image ? "更换图片" : "选择图片"}</button>${imageId ? `<button type="button" class="secondary" data-image-remove="${index}">移除</button>` : ""}</div></div></article>`;
    }).join("");
    root.querySelector("#column-mosaic-preview").innerHTML = slots.map(imageId => {
      const image = media.find(item => item.id === imageId);
      return image ? `<img src="${esc(image.src)}" alt=""/>` : '<div class="slot-placeholder">等待图片</div>';
    }).join("");
  }
  root.querySelector("#column-slots").addEventListener("click", async e => {
    const button = e.target.closest("button"); if (!button) return;
    if (button.hasAttribute("data-image-remove")) slots[Number(button.dataset.imageRemove)] = null;
    else if (button.hasAttribute("data-image-slot")) {
      const index = Number(button.dataset.imageSlot), image = await chooseImage(media, slots.filter((id, i) => i !== index && id));
      if (!image) return; slots[index] = image.id;
    } else return;
    mark(); paint();
  });
  form.addEventListener("input", mark);
  paint();
  on("[data-back]", "click", async () => {
    if (dirty && !confirm("有未保存修改，确定离开？")) return;
    await columnsPage();
  });
  on("#column-form", "submit", async () => {
    const body = {
      slug: value(form, "slug"),
      name: value(form, "name"),
      introduction: value(form, "introduction"),
      imageIds: slots,
    };
    if (!completeSlots(slots, 3)) throw new Error("专栏必须恰好有 3 张不同图片。");
    const saved = await api("/columns" + (id ? "/" + id : ""), {
      method: id ? "PUT" : "POST",
      etag: c.etag,
      key: !id,
      body,
    });
    dirty = false;
    setDirty(false);
    await editColumn(saved.id);
    status("专栏已保存。");
  });
  root.querySelectorAll("[data-state]").forEach((b) =>
    on(`[data-state="${b.dataset.state}"]`, "click", async () => {
      if (dirty) throw new Error("请先保存专栏修改。");
      await api(`/columns/${id}/${b.dataset.state}`, {
        method: "POST",
        key: true,
        etag: c.etag,
      });
      await editColumn(id);
      status("专栏状态已更新。");
    }),
  );
  if (id && c.state === "Active") {
    const response = await fetch("/api/public/v1/columns/" + c.slug, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("专栏文章暂时无法加载。");
    const publicData = await response.json();
    sortable(
      publicData.articles.map((a) => ({ id: a.entityId, title: a.title })),
      (x) => x.title,
      async (ids) => {
        if (dirty) throw new Error("请先保存专栏修改。");
        await api(`/columns/${id}/articles/order`, {
          method: "PUT",
          etag: c.etag,
          body: { ids },
        });
        await editColumn(id);
        status("文章顺序已保存。");
      },
    );
  }
}
export async function projectsPage() {
  setDirty(false);
  const items = await api("/projects"),
    site = await api("/site");
  root.innerHTML = `${pageHeading("项目展览", "记录从想法到作品的过程。")}<details class="create-disclosure"><summary>＋ 新建项目</summary><form id="create-project" class="card">${field("标题", "title")}${field("项目地址", "slug")}<button>创建项目草稿</button></form></details><table><thead><tr><th>标题</th><th>状态</th><th>操作</th></tr></thead><tbody>${items.map((p) => `<tr><td>${esc(p.draft.title)}${p.isDemo ? ' <span class="badge">示例</span>' : ""}</td><td>${p.trashed ? "回收站" : p.published ? "已发布" : "草稿"}</td><td><button data-edit="${p.id}">编辑</button></td></tr>`).join("")}</tbody></table>`;
  sortable(
    items,
    (x) => x.draft.title,
    async (ids) => {
      await api("/projects/order", {
        method: "PUT",
        etag: site.etag,
        body: { ids },
      });
      await projectsPage();
      status("项目顺序已保存。");
    },
  );
  on("#create-project", "submit", async (e) => {
    const p = await api("/projects", {
      method: "POST",
      key: true,
      body: {
        title: value(e.currentTarget, "title"),
        slug: value(e.currentTarget, "slug"),
      },
    });
    await editProject(p.id);
  });
  root
    .querySelectorAll("[data-edit]")
    .forEach((b) =>
      on(`[data-edit="${b.dataset.edit}"]`, "click", () =>
        editProject(b.dataset.edit),
      ),
    );
}
async function editProject(id) {
  const p = await api("/projects/" + id),
    d = p.draft,
    media = await allPages("/media?state=Ready");
  let dirty = false;
  root.innerHTML = `<button class="secondary" data-back>← 返回项目</button><h1>编辑项目</h1><p>${p.slug} · ${p.trashed ? "回收站" : p.published ? "已发布" : "草稿"}</p><form id="project-form">${field("标题", "title", d.title)}${field("项目类型", "type", d.type)}${area("摘要", "summary", d.summary)}${field("标签（用逗号分隔）", "tags", d.tags.join(","))}${selectMedia("封面图片", "coverMediaId", media, d.coverMediaId)}${area("项目正文", "body", d.body)}${area("过程与细节（每行一项）", "details", d.details.join("\n"))}${area("补充说明", "note", d.note)}<button ${p.trashed ? "disabled" : ""}>保存项目草稿</button></form><div class="actions">${p.trashed ? '<button data-state="restore">恢复为草稿</button>' : '<button data-state="publish">发布已保存内容</button>' + (p.published ? '<button class="secondary" data-state="withdraw">撤回发布</button>' : "") + '<button class="danger" data-state="trash">移入回收站</button>'}<a href="/#/project/${p.slug}" target="_blank" rel="noopener">查看公开页面 ↗</a></div>`;
  const form = root.querySelector("#project-form");
  if (p.trashed) for (const control of form.elements) control.disabled = true;
  form.addEventListener("input", () => { dirty = true; setDirty(true); });
  on("[data-back]", "click", async () => {
    if (dirty && !confirm("有未保存修改，确定离开？")) return;
    await projectsPage();
  });
  on("#project-form", "submit", async () => {
    await api("/projects/" + id, {
      method: "PUT",
      etag: p.etag,
      body: {
        title: value(form, "title"),
        type: value(form, "type"),
        summary: value(form, "summary"),
        tags: value(form, "tags")
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
        coverMediaId: value(form, "coverMediaId") || null,
        body: value(form, "body"),
        details: value(form, "details").split("\n").filter(Boolean),
        note: value(form, "note"),
      },
    });
    dirty = false;
    setDirty(false);
    await editProject(id);
    status("项目草稿已保存。");
  });
  root.querySelectorAll("[data-state]").forEach((b) =>
    on(`[data-state="${b.dataset.state}"]`, "click", async () => {
      if (dirty) throw new Error("请先保存项目修改。");
      await api(`/projects/${id}/${b.dataset.state}`, {
        method: "POST",
        key: true,
        etag: p.etag,
      });
      await editProject(id);
      status("项目状态已更新。");
    }),
  );
}
export async function knowledgePage() {
  setDirty(false);
  const data = await api("/knowledge");
  root.innerHTML = `${pageHeading("知识库章节", "关联已有文章，整理知识路径，正文只维护一份。", '<button type="button" data-new>新建章节</button>')}<div>${data.items.map((c) => `<section class="card"><h2>${esc(c.title)}</h2><p>${c.articleIds.length} 篇关联文章</p><button data-edit="${c.id}">编辑章节与文章顺序</button></section>`).join("")}</div>`;
  sortable(
    data.items,
    (x) => x.title,
    async (ids) => {
      await api("/knowledge/order", {
        method: "PUT",
        etag: data.siteEtag,
        body: { ids },
      });
      await knowledgePage();
      status("章节顺序已保存。");
    },
  );
  on("[data-new]", "click", () => editChapter());
  root
    .querySelectorAll("[data-edit]")
    .forEach((b) =>
      on(`[data-edit="${b.dataset.edit}"]`, "click", () =>
        editChapter(b.dataset.edit),
      ),
    );
}
async function editChapter(id) {
  const data = await api("/knowledge"),
    c = id
      ? data.items.find((c) => c.id === id)
      : { title: "", articleIds: [] };
  const articles = (await allPages("/articles")).filter(
    (a) => a.state !== "Purged",
  );
  let chosen = [...c.articleIds];
  let dirty = false;
  root.innerHTML = `<button class="secondary" data-back>← 返回章节</button><h1>${id ? "编辑" : "新建"}章节</h1><form id="chapter-form">${field("章节名称", "title", c.title)}<label>添加文章<select id="chapter-article"><option value="">选择文章</option>${articles.map((a) => `<option value="${a.id}">${esc(a.draft?.title || a.slug)} (${stateLabel(a.state)})</option>`).join("")}</select></label><button type="button" data-add>添加到章节</button><ul id="chapter-entries" class="sort-list"></ul><div class="actions"><button type="submit">保存章节与顺序</button>${id ? '<button type="button" class="danger" data-delete>删除章节</button>' : ""}</div></form>`;
  function list() {
    root.querySelector("#chapter-entries").innerHTML = chosen
      .map(
        (id, i) =>
          `<li data-id="${id}"><span>${esc(articles.find((a) => a.id === id)?.draft?.title || id)}</span><div><button type="button" data-up="${i}" aria-label="文章上移">↑</button> <button type="button" data-down="${i}" aria-label="文章下移">↓</button> <button type="button" class="secondary" data-remove="${i}">移除</button></div></li>`,
      )
      .join("");
  }
  root.querySelector("#chapter-entries").onclick = (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    dirty = true; setDirty(true);
    const key = Object.keys(t.dataset)[0],
      i = Number(t.dataset[key]);
    if (key === "remove") chosen.splice(i, 1);
    if (key === "up" && i > 0)
      [chosen[i - 1], chosen[i]] = [chosen[i], chosen[i - 1]];
    if (key === "down" && i < chosen.length - 1)
      [chosen[i + 1], chosen[i]] = [chosen[i], chosen[i + 1]];
    list();
  };
  list();
  on("[data-add]", "click", () => {
    const id = root.querySelector("#chapter-article").value;
    if (id && !chosen.includes(id)) {
      dirty = true; setDirty(true);
      chosen.push(id);
      list();
    }
  });
  root.querySelector("#chapter-form").addEventListener("input", () => { dirty = true; setDirty(true); });
  on("[data-back]", "click", () => {
    if (dirty && !confirm("有未保存修改，确定离开？")) return;
    return knowledgePage();
  });
  on("#chapter-form", "submit", async (e) => {
    await api("/knowledge" + (id ? "/" + id : ""), {
      method: id ? "PUT" : "POST",
      etag: c.etag,
      key: !id,
      body: { title: value(e.currentTarget, "title"), articleIds: chosen },
    });
    await knowledgePage();
    status("知识库章节已保存。");
  });
  on("[data-delete]", "click", async () => {
    if (!confirm("删除章节不会删除文章，确定继续？")) return;
    await api("/knowledge/" + id, { method: "DELETE", etag: c.etag });
    await knowledgePage();
    status("章节已删除。");
  });
}
