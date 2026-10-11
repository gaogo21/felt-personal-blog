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
} from "./api.js";

export async function columnsPage() {
  const data = await api("/columns");
  root.innerHTML = `<h1>专栏与排序</h1><button data-new>新建专栏</button><div class="table-scroll"><table><thead><tr><th>名称</th><th>状态</th><th>已发布文章</th><th>操作</th></tr></thead><tbody>${data.items.map((c) => `<tr><td>${esc(c.name)}<br><small>${c.slug}</small></td><td>${c.state}</td><td>${c.publishedArticleCount}</td><td><button data-edit="${c.id}">编辑</button></td></tr>`).join("")}</tbody></table></div>`;
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
  let dirty = false;
  root.innerHTML = `<button class="secondary" data-back>← 返回专栏</button><h1>${id ? "编辑" : "新建"}专栏</h1><p class="muted">启用专栏需要三张不同图片。专栏地址创建后保持固定。</p><form id="column-form">${field("专栏地址", "slug", c.slug)}${field("名称", "name", c.name)}${area("介绍", "introduction", c.introduction)}<div class="split">${[0, 1, 2].map((i) => selectMedia("封面图片 " + (i + 1), "image" + i, media, c.imageIds[i])).join("")}</div><button>保存专栏</button></form>${id ? `<div class="actions"><span class="badge">${c.state}</span>${c.state !== "Active" ? '<button data-state="activate">启用专栏</button>' : ""}${c.state !== "Archived" ? '<button class="secondary" data-state="archive">归档专栏</button>' : ""}</div>` : ""}`;
  const form = root.querySelector("#column-form");
  if (id) form.slug.disabled = true;
  form.addEventListener("input", () => (dirty = true));
  on("[data-back]", "click", async () => {
    if (dirty && !confirm("有未保存修改，确定离开？")) return;
    await columnsPage();
  });
  on("#column-form", "submit", async () => {
    const body = {
      slug: value(form, "slug"),
      name: value(form, "name"),
      introduction: value(form, "introduction"),
      imageIds: [0, 1, 2].map((i) => value(form, "image" + i)).filter(Boolean),
    };
    const saved = await api("/columns" + (id ? "/" + id : ""), {
      method: id ? "PUT" : "POST",
      etag: c.etag,
      key: !id,
      body,
    });
    dirty = false;
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
  const items = await api("/projects"),
    site = await api("/site");
  root.innerHTML = `<h1>项目展览</h1><form id="create-project" class="card"><h2>新建项目</h2>${field("标题", "title")}${field("项目地址", "slug")}<button>创建项目草稿</button></form><table><thead><tr><th>标题</th><th>状态</th><th>操作</th></tr></thead><tbody>${items.map((p) => `<tr><td>${esc(p.draft.title)}${p.isDemo ? ' <span class="badge">示例</span>' : ""}</td><td>${p.trashed ? "回收站" : p.published ? "已发布" : "草稿"}</td><td><button data-edit="${p.id}">编辑</button></td></tr>`).join("")}</tbody></table>`;
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
  form.addEventListener("input", () => (dirty = true));
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
  const data = await api("/knowledge");
  root.innerHTML = `<h1>知识库章节</h1><p class="muted">章节关联已有文章，正文只维护一份。只有已发布文章会出现在公开知识库中。</p><button data-new>新建章节</button><div>${data.items.map((c) => `<section class="card"><h2>${esc(c.title)}</h2><p>${c.articleIds.length} 篇关联文章</p><button data-edit="${c.id}">编辑章节与文章顺序</button></section>`).join("")}</div>`;
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
  root.innerHTML = `<button class="secondary" data-back>← 返回章节</button><h1>${id ? "编辑" : "新建"}章节</h1><form id="chapter-form">${field("章节名称", "title", c.title)}<label>添加文章<select id="chapter-article"><option value="">选择文章</option>${articles.map((a) => `<option value="${a.id}">${esc(a.draft?.title || a.slug)} (${a.state})</option>`).join("")}</select></label><button type="button" data-add>添加到章节</button><ul id="chapter-entries" class="sort-list"></ul><div class="actions"><button type="submit">保存章节与顺序</button>${id ? '<button type="button" class="danger" data-delete>删除章节</button>' : ""}</div></form>`;
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
      chosen.push(id);
      list();
    }
  });
  on("[data-back]", "click", knowledgePage);
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
export async function sitePage() {
  const data = await api("/site"),
    s = data.value;
  const [media, articles] = await Promise.all([
    allPages("/media?state=Ready"),
    allPages("/articles?state=Published"),
  ]);
  root.innerHTML = `<h1>首页与关于</h1><form id="site-form">${area("首页自我介绍", "homeAbout", s.homeAbout)}${field("关于页面标题", "aboutTitle", s.aboutTitle)}${area("关于正文", "aboutText", s.aboutText)}${area("补充说明", "aboutNote", s.aboutNote)}${field("主题标签（逗号分隔）", "topics", s.topics.join(","))}<fieldset><legend>首页推荐文章（最多三篇，下方可调整顺序）</legend>${articles.map((a) => `<label class="choice"><input type="checkbox" name="featured" value="${a.id}" ${s.featuredIds.includes(a.id) ? "checked" : ""}/>${esc(a.draft?.title || a.slug)}</label>`).join("")}<ul class="sort-list" id="featured-order"></ul></fieldset><fieldset><legend>画廊图片（最多十张，下方可调整顺序）</legend>${media
    .filter((m) => m.kind === "Image")
    .map(
      (m) =>
        `<label class="choice"><input type="checkbox" name="gallery" value="${m.id}" ${s.galleryIds.includes(m.id) ? "checked" : ""}/><img class="media-thumb" src="${m.src}" alt=""/>${esc(m.alt || m.caption || m.id.slice(0, 8))}</label>`,
    )
    .join(
      "",
    )}<ul class="sort-list" id="gallery-order"></ul></fieldset><div class="actions"><button>保存并应用首页与关于</button></div></form>`;
  const ordered = { featured: [...s.featuredIds], gallery: [...s.galleryIds] };
  const form = root.querySelector("#site-form");
  function paint(name) {
    const list = root.querySelector("#" + name + "-order");
    list.innerHTML = ordered[name]
      .map((id) => {
        const item =
          name === "featured"
            ? articles.find((a) => a.id === id)
            : media.find((m) => m.id === id);
        return `<li data-id="${id}"><span>${esc(name === "featured" ? item?.draft?.title || id : item?.alt || item?.caption || id)}</span><div><button type="button" data-up aria-label="上移">↑</button> <button type="button" data-down aria-label="下移">↓</button></div></li>`;
      })
      .join("");
    list.onclick = (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      const i = ordered[name].indexOf(li.dataset.id);
      if (e.target.closest("[data-up]") && i > 0)
        [ordered[name][i - 1], ordered[name][i]] = [
          ordered[name][i],
          ordered[name][i - 1],
        ];
      if (e.target.closest("[data-down]") && i < ordered[name].length - 1)
        [ordered[name][i + 1], ordered[name][i]] = [
          ordered[name][i],
          ordered[name][i + 1],
        ];
      paint(name);
    };
  }
  for (const name of ["featured", "gallery"]) {
    const checked = [
      ...form.querySelectorAll(`input[name="${name}"]:checked`),
    ].map((x) => x.value);
    ordered[name] = ordered[name].filter((id) => checked.includes(id));
    paint(name);
  }
  form.addEventListener("change", (e) => {
    const name = e.target.name;
    if (!ordered[name]) return;
    const checked = [
      ...form.querySelectorAll(`input[name="${name}"]:checked`),
    ].map((x) => x.value);
    ordered[name] = ordered[name]
      .filter((id) => checked.includes(id))
      .concat(checked.filter((id) => !ordered[name].includes(id)));
    paint(name);
  });
  on("#site-form", "submit", async (e) => {
    const f = e.currentTarget;
    const checked = (name) => ordered[name];
    await api("/site", {
      method: "PUT",
      etag: data.etag,
      body: {
        homeAbout: value(f, "homeAbout"),
        aboutTitle: value(f, "aboutTitle"),
        aboutText: value(f, "aboutText"),
        aboutNote: value(f, "aboutNote"),
        topics: value(f, "topics")
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
        featuredIds: checked("featured"),
        galleryIds: checked("gallery"),
      },
    });
    await sitePage();
    status("首页与关于已更新。");
  });
}
