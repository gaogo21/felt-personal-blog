import {
  api,
  root,
  esc,
  on,
  field,
  area,
  value,
  status,
  reauthenticate,
  pageHeading,
  stateBadge,
  stateLabel,
} from "./api.js";
export async function mediaPage() {
  root.innerHTML = `${pageHeading("媒体库", "统一管理文章、画廊与专栏使用的图片和视频。")}<form id="upload-form" class="card"><h2>上传图片或视频</h2><p class="muted">图片支持 JPG、PNG、WebP，最大 10 MiB；视频支持 MP4，最大 200 MiB。上传后先校验和处理，完成后才可插入文章。</p><label>选择文件<input type="file" name="file" accept="image/jpeg,image/png,image/webp,video/mp4" required/></label><button>上传并处理</button></form><form id="media-filter" class="toolbar"><label>状态<select name="state"><option value="">全部</option>${["Processing", "Ready", "Rejected", "Trashed", "Purged"].map((s) => `<option value="${s}">${stateLabel(s)}</option>`).join("")}</select></label>${field("搜索图片说明或来源", "q")}<button>筛选</button></form><div id="media-list"></div>`;
  let page = 1;
  async function list() {
    const f = root.querySelector("#media-filter"),
      query = new URLSearchParams({ page });
    if (value(f, "state")) query.set("state", value(f, "state"));
    if (value(f, "q")) query.set("q", value(f, "q"));
    const data = await api("/media?" + query);
    root.querySelector("#media-list").innerHTML =
      `<div class="media-grid">${data.items.map(m => `<article class="media-card">${m.state === "Ready" && m.kind === "Image" ? `<img src="${esc(m.src)}" alt="${esc(m.alt)}" loading="lazy"/>` : `<div class="media-card-placeholder">${m.kind === "Video" ? "VIDEO" : "IMAGE"} · ${stateLabel(m.state)}</div>`}<div class="media-card-copy"><div>${stateBadge(m.state)}<small>${(m.byteSize / 1048576).toFixed(2)} MiB</small></div><h3>${esc(m.alt || m.caption || m.id.slice(0,8))}</h3><button type="button" class="secondary" data-edit="${m.id}">管理媒体</button>${m.errorCode ? `<p class="editor-note">${esc(m.errorCode)}</p>` : ""}</div></article>`).join("") || '<p class="empty-state">还没有匹配的媒体。</p>'}</div><div class="actions"><button type="button" class="secondary" data-prev ${page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${page} 页，共 ${data.total} 项</span><button type="button" class="secondary" data-next ${page * 20 >= data.total ? "disabled" : ""}>下一页</button><button type="button" class="secondary" data-refresh>刷新处理状态</button></div>`;
    root
      .querySelectorAll("[data-edit]")
      .forEach((b) =>
        on(`[data-edit="${b.dataset.edit}"]`, "click", () =>
          editMedia(b.dataset.edit),
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
    on("[data-refresh]", "click", list);
  }
  on("#media-filter", "submit", async () => {
    page = 1;
    await list();
  });
  on("#upload-form", "submit", async (e) => {
    const file = e.currentTarget.file.files[0];
    if (!file) throw new Error("请选择文件。");
    if (file.size > (file.type === "video/mp4" ? 200 : 10) * 1048576)
      throw new Error("文件超过允许大小。");
    status("正在读取和上传，请稍候…", "info");
    const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      ),
      sha256 = [...new Uint8Array(digest)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    const body = new FormData();
    body.append("file", file);
    body.append("sha256", sha256);
    await api("/media/uploads", { method: "POST", key: true, body });
    e.currentTarget.reset();
    await list();
    status("上传完成，正在处理。可刷新查看状态。");
  });
  await list();
}
async function editMedia(id) {
  const m = await api("/media/" + id),
    refs = await api("/media/" + id + "/references");
  root.innerHTML = `<button class="secondary" data-back>← 返回媒体库</button><h1>媒体信息</h1><p class="muted">${id} · ${stateLabel(m.state)}</p>${m.state === "Ready" ? (m.kind === "Image" ? `<img src="${m.src}" alt="${esc(m.alt)}" class="media-preview"/>` : `<video src="${m.src}" controls class="media-preview"></video>`) : "<p>当前状态不提供文件预览。</p>"}<form id="metadata-form">${field("替代文本", "alt", m.alt)}${field("图片或视频说明", "caption", m.caption)}${field("作者或来源署名", "credit", m.credit)}${field("来源地址（HTTPS）", "sourceUrl", m.source)}${field("许可名称", "licenseName", m.licenseName)}${field("许可地址（HTTPS）", "licenseUrl", m.licenseUrl)}<button ${m.state === "Ready" ? "" : "disabled"}>保存媒体说明</button></form><div class="actions">${m.state === "Rejected" ? '<button data-action="retry">重新处理</button>' : ""}${m.state === "Trashed" ? '<button data-action="restore">恢复</button><button class="danger" data-purge>永久清空</button>' : m.state === "Ready" || m.state === "Rejected" ? '<button class="danger" data-action="trash">移入回收站</button>' : ""}<button class="secondary" data-refresh>刷新状态</button></div><section class="card"><h2>引用位置</h2>${refs.map((r) => `<p>${esc(r.ownerType)} · ${r.ownerId} · ${esc(r.usage)}</p>`).join("") || "<p>没有内容引用此媒体。</p>"}</section>`;
  on("[data-back]", "click", mediaPage);
  on("[data-refresh]", "click", () => editMedia(id));
  on("#metadata-form", "submit", async (e) => {
    const f = e.currentTarget;
    const body = Object.fromEntries(
      [
        "alt",
        "caption",
        "credit",
        "sourceUrl",
        "licenseName",
        "licenseUrl",
      ].map((k) => [k, value(f, k)]),
    );
    await api("/media/" + id, { method: "PATCH", etag: m.etag, body });
    await editMedia(id);
    status("媒体说明已保存。");
  });
  root.querySelectorAll("[data-action]").forEach((b) =>
    on(`[data-action="${b.dataset.action}"]`, "click", async () => {
      await api(`/media/${id}/${b.dataset.action}`, {
        method: "POST",
        key: true,
        etag: m.etag,
      });
      await editMedia(id);
      status("媒体状态已更新。");
    }),
  );
  on("[data-purge]", "click", async () => {
    if (prompt("永久清空不可恢复。请输入完整媒体 ID：") !== id) return;
    if (!(await reauthenticate())) return;
    await api(`/media/${id}/purge`, {
      method: "POST",
      key: true,
      etag: m.etag,
      body: { confirmId: id },
    });
    await mediaPage();
    status("媒体已清空，文件清理将在后台完成。");
  });
}
