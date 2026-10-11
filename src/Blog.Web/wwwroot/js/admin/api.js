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
      throw new Error(
        messages[data?.code] ||
          (response.status === 429
            ? "操作频繁，请稍后重试。"
            : data?.fields
              ? "输入内容不符合要求，请检查长度、正文、专栏或媒体状态。"
              : "操作未完成，请检查内容后重试。"),
      );
    }
    if (data?.csrfToken) csrf = data.csrfToken;
    if (key) pendingKeys.delete(marker);
    return data;
  } finally {
    if (mutate) writing = false;
  }
}
export function status(message) {
  document.querySelector("#admin-status").textContent = message;
}
export function on(selector, event, action, scope = root) {
  scope.querySelector(selector)?.addEventListener(event, async (e) => {
    e.preventDefault();
    const button = e.submitter || e.currentTarget;
    if (button instanceof HTMLButtonElement) button.disabled = true;
    try {
      await action(e);
    } catch (error) {
      status(error.message);
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
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
  `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${type === "password" ? 'autocomplete="current-password"' : ""}/></label>`;
export const area = (label, name, value = "") =>
  `<label>${label}<textarea name="${name}">${esc(value)}</textarea></label>`;
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
