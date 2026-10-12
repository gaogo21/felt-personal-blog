export const root = document.querySelector("#admin-content");
export const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let csrf = "",
  writing = false;
const pendingKeys = new Map();
export async function bootstrap() {
  const response = await fetch("/api/admin/v1/session/bootstrap", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("暂时无法连接，请稍后重试。");
  const data = await response.json();
  csrf = data.csrfToken;
  return data;
}
const messages = {
  ARTICLE_FEATURED: "这篇文章正在首页精选中，请先替换精选文章，再撤回或移入回收站。",
  PRECONDITION_FAILED: "内容已在其他窗口更新。请先保留当前输入，再重新加载。",
  PRECONDITION_REQUIRED: "请重新加载当前内容后保存。",
  CSRF_INVALID: "登录状态已变化，请重新登录。",
  SESSION_REQUIRED: "请重新登录。",
  LOGIN_FAILED: "用户名或密码不正确，或暂时被锁定。",
  REAUTH_FAILED: "密码验证失败。",
  REAUTH_REQUIRED: "此操作需要再次验证密码。",
  IDEMPOTENCY_CONFLICT: "这次提交与此前请求不同，请重新操作。",
  MEDIA_REFERENCED: "媒体仍被文章、专栏或首页使用，请先移除引用。",
  COLUMN_HAS_PUBLISHED_ARTICLES: "专栏还有已发布文章，请先调整文章所属专栏。",
  DUPLICATE_SLUG: "地址已存在，请换一个地址。",
  STATE_CONFLICT: "当前状态不允许此操作。",
  RESOURCE_PURGED: "内容已永久清空。",
  DESIGN_ASSET_IMMUTABLE: "网站原有素材不能从媒体库删除。",
};
export async function api(
  path,
  { method = "GET", body, etag, key = false } = {},
) {
  const mutate = method !== "GET";
  if (mutate && writing) throw new Error("正在处理上一次操作，请稍候。");
  if (mutate) writing = true;
  const headers = { Accept: "application/json" };
  if (mutate) headers["X-CSRF-TOKEN"] = csrf;
  if (etag) headers["If-Match"] = etag;
  const marker =
    path +
    "|" +
    JSON.stringify(body instanceof FormData ? body.get("sha256") : body);
  if (key) {
    if (!pendingKeys.has(marker)) pendingKeys.set(marker, crypto.randomUUID());
    headers["Idempotency-Key"] = pendingKeys.get(marker);
  }
  if (body !== undefined && !(body instanceof FormData))
    headers["Content-Type"] = "application/json";
  try {
    const response = await fetch("/api/admin/v1" + path, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (
        response.status === 401 &&
        !["/session", "/session/reauth"].includes(path)
      )
        location.href = "/admin/login";
      const error = new Error(
        messages[data?.code] ||
          (response.status === 429
            ? "操作频繁，请稍后重试。"
            : data?.fields
              ? Object.keys(data.fields).map(name => ({
                  galleryIds: "首页画廊必须有 10 张不同的就绪图片。",
                  featuredIds: "精选文章必须有 3 篇不同的已发布文章。",
                  imageIds: "专栏必须有 3 张不同的就绪图片。",
                  introduction: "请填写专栏介绍（最多 1200 字）。",
                  name: "请填写有效名称。",
                  homeAbout: "自我介绍最多 1200 字。",
                }[name] || "输入内容不符合要求，请检查标记的字段。")).join(" ")
              : "操作未完成，请检查内容后重试。"),
      );
      error.fields = data?.fields;
      throw error;
    }
    if (data?.csrfToken) csrf = data.csrfToken;
    if (key) pendingKeys.delete(marker);
    return data;
  } finally {
    if (mutate) writing = false;
  }
}
let statusTimer, unsaved = false;
window.addEventListener("beforeunload", e => {
  if (unsaved) { e.preventDefault(); e.returnValue = ""; }
});
export function setDirty(value) { unsaved = value; }
export function status(message, kind = "success") {
  const panel = document.querySelector("#admin-status");
  panel.querySelector("span").textContent = message;
  panel.dataset.kind = kind;
  panel.hidden = false;
  clearTimeout(statusTimer);
  panel.querySelector("button").onclick = () => { panel.hidden = true; };
  if (kind === "success") statusTimer = setTimeout(() => { panel.hidden = true; }, 6500);
}
export function showError(error) {
  root?.querySelectorAll(".is-invalid").forEach(el => { el.classList.remove("is-invalid"); el.removeAttribute("aria-invalid"); });
  for (const name of Object.keys(error.fields || {})) {
    root?.querySelectorAll(`[name="${name}"],[data-validation-for="${name}"]`).forEach(el => {
      el.classList.add("is-invalid"); el.setAttribute("aria-invalid", "true");
    });
  }
  status(error.message, "error");
}
export function on(selector, event, action, scope = root) {
  scope.querySelector(selector)?.addEventListener(event, async (e) => {
    e.preventDefault();
    const button = e.submitter || e.currentTarget;
    if (button instanceof HTMLButtonElement) { button.disabled = true; button.classList.add("is-loading"); }
    const controls = e.currentTarget.tagName === "FORM" ? [...e.currentTarget.elements].filter(control => !control.disabled) : [];
    controls.forEach(control => { control.disabled = true; });
    try {
      await action(e);
    } catch (error) {
      showError(error);
    } finally {
      controls.forEach(control => { if (control.isConnected) control.disabled = control.dataset.valid === "false"; });
      if (button instanceof HTMLButtonElement) { button.classList.remove("is-loading"); button.disabled = button.dataset.valid === "false"; }
    }
  });
}
export async function allPages(path) {
  let items = [],
    page = 1,
    total = Infinity;
  while (items.length < total) {
    const data = await api(
      path + (path.includes("?") ? "&" : "?") + "page=" + page,
    );
    items.push(...data.items);
    total = data.total;
    if (!data.items.length) break;
    page++;
  }
  return items;
}
export const field = (label, name, value = "", type = "text") =>
  `<label>${label}<input class="form-control" name="${name}" type="${type}" value="${esc(value)}" ${type === "password" ? 'autocomplete="current-password"' : ""}/></label>`;
export const area = (label, name, value = "") =>
  `<label>${label}<textarea class="form-control" name="${name}">${esc(value)}</textarea></label>`;
export const value = (form, name) => form.elements.namedItem(name).value;
export function selectMedia(label, name, media, selected = null) {
  return `<label>${label}<select name="${name}"><option value="">不选择</option>${media
    .filter((x) => x.state === "Ready" && x.kind === "Image")
    .map(
      (x) =>
        `<option value="${x.id}" ${x.id === selected ? "selected" : ""}>${esc(x.alt || x.caption || x.id.slice(0, 8))}</option>`,
    )
    .join("")}</select></label>`;
}
export function pageHeading(title, description, action = "") {
  return `<div class="page-heading"><div><p class="eyebrow">ALWAYS CURIOUS / CONTENT STUDIO</p><h1>${title}</h1><p class="muted">${description}</p></div>${action}</div>`;
}
export function stateLabel(state) {
  return { Draft: "草稿", Published: "已发布", Withdrawn: "已撤回", Trashed: "回收站", Purged: "已清空", Active: "已启用", Archived: "已归档", Processing: "处理中", Ready: "已就绪", Rejected: "处理失败" }[state] || state;
}
export function stateBadge(state) { return `<span class="badge state-badge" data-state-value="${esc(state)}">${esc(stateLabel(state))}</span>`; }
export function enhanceControls(scope = document.body) {
  scope.querySelectorAll("button").forEach(button => {
    if (button.closest(".body-editor-toolbar")) { button.classList.add("btn", "btn-sm"); return; }
    button.classList.add("btn");
    if (button.classList.contains("danger")) button.classList.add("btn-outline-danger");
    else if (!button.classList.contains("secondary") && ((button.closest("form") && button.type === "submit") || button.hasAttribute("data-new") || button.hasAttribute("data-publish"))) button.classList.add("btn-primary");
  });
  scope.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]),textarea').forEach(el => el.classList.add("form-control"));
  scope.querySelectorAll("select").forEach(el => el.classList.add("form-select"));
  scope.querySelectorAll('input[type="checkbox"]').forEach(el => el.classList.add("form-check-input"));
  scope.querySelectorAll("table").forEach(table => {
    if (table.closest(".tiptap,.preview")) return;
    table.classList.add("table", "responsive-table");
    const labels = [...table.querySelectorAll("thead th")].map(el => el.textContent);
    table.querySelectorAll("tbody tr").forEach(row => [...row.cells].forEach((cell, index) => { cell.dataset.label = labels[index] || ""; }));
    if (!table.parentElement.classList.contains("table-scroll")) {
      const wrapper = document.createElement("div"); wrapper.className = "table-scroll"; table.before(wrapper); wrapper.append(table);
    }
  });
}
export async function reauthenticate() {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `<form><h2>再次验证密码</h2><p>永久清空和备份需要确认当前管理员身份。</p>${field("当前密码", "password", "", "password")}<div class="actions"><button type="submit">验证</button><button type="button" class="secondary" data-cancel>取消</button></div><p role="alert"></p></form>`;
    document.body.append(dialog);
    dialog.showModal();
    const close = (result) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    dialog.addEventListener("cancel", () => close(false));
    dialog.querySelector("[data-cancel]").onclick = () => close(false);
    dialog.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/session/reauth", {
          method: "POST",
          body: { password: value(e.currentTarget, "password") },
        });
        close(true);
      } catch (error) {
        dialog.querySelector("[role=alert]").textContent = error.message;
      }
    };
  });
}
export function sortable(items, renderLabel, onSave) {
  root.insertAdjacentHTML(
    "beforeend",
    `<section class="card"><h2>调整顺序</h2><p class="muted">上下移动后保存。</p><ul class="sort-list">${items.map((x) => `<li data-id="${x.id}"><span>${esc(renderLabel(x))}</span><div><button type="button" data-up aria-label="上移">↑</button> <button type="button" data-down aria-label="下移">↓</button></div></li>`).join("")}</ul><button type="button" data-save-order>保存顺序</button></section>`,
  );
  root.querySelector(".sort-list").onclick = (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    if (e.target.closest("[data-up]") && li.previousElementSibling)
      li.previousElementSibling.before(li);
    if (e.target.closest("[data-down]") && li.nextElementSibling)
      li.nextElementSibling.after(li);
  };
  on("[data-save-order]", "click", () =>
    onSave(
      [...root.querySelectorAll(".sort-list li")].map((x) => x.dataset.id),
    ),
  );
}
