import { api, allPages, root, esc, on, area, field, value, status, setDirty, pageHeading } from "./api.js";
import { GALLERY_SIZE, FEATURED_SIZE, fixedSlots, completeSlots, galleryPosition, mergeSite } from "./site-contract.js";

const imageTitle = image => image?.caption || image?.alt || "未命名图片";
const countLabel = slots => slots.filter(Boolean).length;
async function publicFeaturedIds() {
  const response = await fetch("/api/public/v1/home", { cache: "no-store" });
  if (!response.ok) throw new Error("首页配置暂时无法加载。");
  return (await response.json()).featured.map(article => article.entityId);
}
function saveState(button, valid) { button.dataset.valid = String(valid); button.disabled = !valid; }
function setupWarning(site) {
  if (completeSlots(site.galleryIds, 10) && completeSlots(site.featuredIds, 3)) return "";
  return '<div class="alert alert-warning">现有首页配置尚未完整。请先在 <a href="/admin/gallery">首页画廊</a> 补齐 10 张图片和 3 篇精选文章后保存。已有公开内容会保留，未保存修改不会应用。</div>';
}
async function saveSite(snapshot, patch) {
  const result = await api("/site", { method: "PUT", etag: snapshot.etag, body: mergeSite(snapshot.value, patch) });
  setDirty(false);
  return result;
}
export async function chooseImage(media, used = []) {
  let images = media.filter(item => item.state === "Ready" && item.kind === "Image");
  const dialog = document.createElement("dialog");
  dialog.className = "media-picker";
  dialog.innerHTML = '<header class="dialog-heading"><div><h2>从媒体库选择图片</h2><p class="muted">选择一张已就绪的图片。</p></div><button type="button" data-close aria-label="关闭图片选择">×</button></header><label class="picker-search">搜索图片<input type="search" placeholder="图片说明、名称" class="form-control"/></label><div class="picker-grid"></div><div class="section-toolbar picker-footer"><p class="muted">需要新图片？<a href="/admin/media" target="_blank" rel="noopener">打开媒体库上传 ↗</a></p><button type="button" class="secondary" data-refresh-images>刷新图片</button></div>';
  document.body.append(dialog);
  return new Promise(resolve => {
    let settled = false;
    const close = result => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(result); };
    function paint() {
      const query = dialog.querySelector("input").value.toLowerCase();
      const matches = images.filter(image => imageTitle(image).toLowerCase().includes(query));
      dialog.querySelector(".picker-grid").innerHTML = matches.map(image => `<button type="button" class="picker-image" data-image="${image.id}" ${used.includes(image.id) ? "disabled" : ""}><img src="${esc(image.src)}" alt="" loading="lazy"/><span>${esc(imageTitle(image))}</span>${used.includes(image.id) ? '<small>已在其他位置使用</small>' : ""}</button>`).join("") || '<p class="empty-state">没有匹配的就绪图片。可以先到媒体库上传。</p>';
    }
    dialog.querySelector("input").addEventListener("input", paint);
    dialog.querySelector("[data-close]").onclick = () => close(null);
    dialog.querySelector("[data-refresh-images]").onclick = async e => {
      const button = e.currentTarget; button.disabled = true;
      try {
        const fresh = await allPages("/media?state=Ready");
        media.splice(0, media.length, ...fresh);
        images = media.filter(item => item.state === "Ready" && item.kind === "Image");
        paint();
      } catch (error) { status(error.message, "error"); }
      finally { button.disabled = false; }
    };
    dialog.addEventListener("cancel", e => { e.preventDefault(); close(null); });
    dialog.addEventListener("click", e => { const button = e.target.closest("[data-image]"); if (button && !button.disabled) close(images.find(image => image.id === button.dataset.image)); });
    paint(); dialog.showModal();
  });
}
async function uploadImage(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (file.size > 10 * 1048576) throw new Error("图片不能超过 10 MiB。");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const body = new FormData();
  body.append("file", file);
  body.append("sha256", [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
  const uploaded = await api("/media/uploads", { method: "POST", key: true, body });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const image = await api("/media/" + uploaded.id);
    if (image.state === "Ready") return image;
    if (image.state === "Rejected") throw new Error("图片处理失败，请到媒体库查看原因并重新上传。");
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  throw new Error("图片仍在处理。请稍后从媒体库选择，未保存的画廊不会应用。");
}
export async function galleryPage() {
  setDirty(false);
  const [snapshot, media, visibleFeatured] = await Promise.all([api("/site"), allPages("/media?state=Ready"), publicFeaturedIds()]);
  const slots = fixedSlots(snapshot.value.galleryIds, GALLERY_SIZE);
  const initialSetup = !completeSlots(snapshot.value.featuredIds, FEATURED_SIZE) || !snapshot.value.featuredIds.every(id => visibleFeatured.includes(id));
  const initialArticles = initialSetup ? await publishedArticles() : [];
  const initialFeatured = fixedSlots(snapshot.value.featuredIds, FEATURED_SIZE);
  const setupPanel = initialSetup ? `<section class="card"><h2>补齐首页精选文章</h2><p class="muted">首次配置需要在这次保存中同时补齐 3 篇精选，之后可在独立的精选文章页面管理。</p><div class="split">${[0, 1, 2].map(index => `<label>精选位置 0${index + 1}<select name="setupFeatured${index}"><option value="">选择已发布文章</option>${initialArticles.map(article => `<option value="${article.entityId}" ${initialFeatured[index] === article.entityId ? "selected" : ""}>${esc(article.title)}</option>`).join("")}</select></label>`).join("")}</div>${!initialArticles.length ? '<p>还没有已发布文章。<a href="/admin/articles" target="_blank" rel="noopener">先创建并发布文章 ↗</a></p>' : ""}</section>` : "";
  let uploading = false, uploadSlot = null;
  root.innerHTML = `${pageHeading("首页画廊", "第二屏的两排滑动图片。每排 5 张，每个位置都与你的网站对应。", '<a class="btn" href="/" target="_blank" rel="noopener">查看首页 ↗</a>')}${setupWarning(snapshot.value)}<form id="gallery-form"><div class="section-toolbar"><div><h2>画廊图片 <span id="gallery-count" class="count-badge"></span></h2><p class="muted">已满 10 张时，先移除一个位置的图片，再上传或选择新图。</p></div><button type="submit" id="gallery-save">保存画廊</button></div><p id="gallery-validation" class="validation-note" role="status"></p><div id="gallery-slots" data-validation-for="galleryIds"></div><input type="file" id="gallery-upload" accept="image/jpeg,image/png,image/webp" hidden/><div class="save-note"><span class="status-dot"></span><span id="gallery-note">保存后同步到首页，编辑中的空位不会影响已保存画廊。</span></div></form>`;
  const form = root.querySelector("#gallery-form");
  if (setupPanel) form.insertAdjacentHTML("beforeend", setupPanel);
  function paint() {
    const count = countLabel(slots);
    const galleryValid = completeSlots(slots, GALLERY_SIZE) && slots.every(id => media.some(image => image.id === id && image.kind === "Image" && image.state === "Ready"));
    const featuredValid = !initialSetup || completeSlots(initialFeatured, 3) && initialFeatured.every(id => initialArticles.some(article => article.entityId === id));
    const valid = galleryValid && featuredValid && !uploading;
    root.querySelector("#gallery-count").textContent = `${count} / 10`;
    root.querySelector("#gallery-validation").textContent = uploading ? "正在上传与处理图片，请稍候…" : valid ? "10 个位置已完整，可以保存。" : galleryValid && !featuredValid ? "请在下方补齐 3 篇不同的精选文章，再一起保存。" : count < 10 ? `还缺 ${10 - count} 张图片，补齐 10 张后才能保存。` : "请移除超出位置、重复或不可用的图片，保留 10 个有效位置。";
    saveState(root.querySelector("#gallery-save"), valid);
    root.querySelector("#gallery-slots").innerHTML = [0, 1, 2].map(row => {
      const start = row * 5, items = slots.slice(start, start + 5);
      if (!items.length) return "";
      return `<section class="gallery-row"><div class="row-heading"><h3>${row === 0 ? "第一排" : row === 1 ? "第二排" : "超出位置"}</h3><span>${row === 0 ? "向右循环滑动" : row === 1 ? "向左循环滑动" : "请移除"}</span></div><div class="gallery-slot-grid">${items.map((id, offset) => {
        const index = start + offset, image = media.find(item => item.id === id);
        return `<article class="image-slot ${id ? "" : "is-empty"}"><header><span class="slot-number">${String(index + 1).padStart(2, "0")}</span><span>${galleryPosition(index)}</span></header>${image ? `<img src="${esc(image.src)}" alt="${esc(image.alt)}"/>` : '<div class="slot-placeholder"><span>＋</span><small>等待添加图片</small></div>'}<div class="slot-copy"><strong>${id ? esc(image ? imageTitle(image) : "图片不可用，请移除后替换") : "空位置"}</strong><div class="slot-actions">${id ? `<button type="button" class="secondary" data-remove="${index}" ${uploading ? "disabled" : ""}>移除图片</button>` : `<button type="button" data-choose="${index}" ${uploading ? "disabled" : ""}>从媒体库选择</button><button type="button" class="secondary" data-upload="${index}" ${uploading ? "disabled" : ""}>上传新图</button>`}</div></div></article>`;
      }).join("")}</div></section>`;
    }).join("");
  }
  form.addEventListener("change", e => {
    if (!e.target.name.startsWith("setupFeatured")) return;
    initialFeatured[Number(e.target.name.slice(-1))] = e.target.value || null;
    setDirty(true); paint();
  });
  root.querySelector("#gallery-slots").addEventListener("click", async e => {
    const button = e.target.closest("button");
    if (!button || button.disabled || uploading) return;
    if (button.hasAttribute("data-remove")) {
      const index = Number(button.dataset.remove);
      if (index >= 10) slots.splice(index, 1); else slots[index] = null;
      setDirty(true); paint();
    } else if (button.hasAttribute("data-choose")) {
      const index = Number(button.dataset.choose), image = await chooseImage(media, slots.filter(Boolean));
      if (image) { slots[index] = image.id; setDirty(true); paint(); }
    } else if (button.hasAttribute("data-upload")) {
      uploadSlot = Number(button.dataset.upload);
      root.querySelector("#gallery-upload").click();
    }
  });
  root.querySelector("#gallery-upload").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file || uploading || uploadSlot === null || slots[uploadSlot]) return;
    const index = uploadSlot;
    uploading = true; setDirty(true); paint();
    try {
      const image = await uploadImage(file);
      media.push(image); slots[index] = image.id;
      status("图片已就绪。点击保存画廊后才会应用到首页。");
    } catch (error) { status(error.message, "error"); }
    finally { uploading = false; e.target.value = ""; uploadSlot = null; paint(); }
  });
  on("#gallery-form", "submit", async () => {
    if (!completeSlots(slots, 10) || uploading) throw new Error("请补齐 10 张不同的就绪图片。");
    if (initialSetup && !completeSlots(initialFeatured, 3)) throw new Error("请同时补齐 3 篇不同的精选文章。");
    await saveSite(snapshot, { galleryIds: slots, ...(initialSetup ? { featuredIds: initialFeatured } : {}) });
    await galleryPage(); status("画廊已保存，首页位置已同步。");
  });
  paint();
}
async function publishedArticles() {
  const items = [];
  for (let page = 1; ; page++) {
    const response = await fetch("/api/public/v1/articles?page=" + page, { cache: "no-store" });
    if (!response.ok) throw new Error("已发布文章暂时无法加载。");
    const data = await response.json(); items.push(...data.items);
    if (!data.items.length || items.length >= data.total) return items;
  }
}
export async function featuredPage() {
  setDirty(false);
  const [snapshot, articles] = await Promise.all([api("/site"), publishedArticles()]);
  const slots = fixedSlots(snapshot.value.featuredIds, FEATURED_SIZE);
  root.innerHTML = `${pageHeading("精选文章", "从已发布文章中挑选 3 篇，按你设置的顺序展示在首页。")}${setupWarning(snapshot.value)}<form id="featured-form"><div class="section-toolbar"><div><h2>首页展示位置 <span class="count-badge" id="featured-count"></span></h2><p class="muted">替换精选后，原文章才可以撤回或移入回收站。</p></div><button type="submit" id="featured-save">保存精选文章</button></div><p id="featured-validation" class="validation-note" role="status"></p><div class="featured-slots" id="featured-slots" data-validation-for="featuredIds"></div></form><section class="candidate-section"><div class="section-toolbar"><div><h2>选择已有文章</h2><p class="muted">这里只显示前端可以访问的已发布内容。</p></div><label class="search-label">搜索文章<input type="search" id="featured-search" placeholder="搜索标题或专栏"/></label></div><div id="featured-candidates" class="candidate-list"></div></section>`;
  function paint() {
    const valid = completeSlots(slots, 3) && slots.every(id => articles.some(article => article.entityId === id));
    root.querySelector("#featured-count").textContent = `${countLabel(slots)} / 3`;
    root.querySelector("#featured-validation").textContent = valid ? "3 个位置已完整，可以保存。" : "请选择 3 篇不同且可公开访问的文章后保存。";
    saveState(root.querySelector("#featured-save"), valid);
    root.querySelector("#featured-slots").innerHTML = slots.map((id, index) => {
      const article = articles.find(item => item.entityId === id);
      return `<article class="featured-slot"><span class="featured-number">${String(index + 1).padStart(2, "0")}</span><div><small>首页精选 · 第 ${index + 1} 篇</small><h3>${id ? esc(article?.title || "文章已不可用，请移除") : "等待选择文章"}</h3><p>${esc(article?.category || "从下方文章列表添加")}</p></div><div class="slot-actions">${id ? `<button type="button" class="secondary" data-move="${index}" data-step="-1" aria-label="上移精选文章" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="secondary" data-move="${index}" data-step="1" aria-label="下移精选文章" ${index === slots.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="secondary" data-remove="${index}">移除</button>` : '<span class="muted">空位置</span>'}</div></article>`;
    }).join("");
    const query = root.querySelector("#featured-search").value.toLowerCase();
    const matches = articles.filter(article => (article.title + " " + article.category).toLowerCase().includes(query));
    root.querySelector("#featured-candidates").innerHTML = matches.map(article => `<article class="candidate-row"><div><h3>${esc(article.title)}</h3><p>${esc(article.category)} <span>· 已发布</span></p></div><button type="button" class="secondary" data-add="${article.entityId}" ${slots.includes(article.entityId) || !slots.includes(null) ? "disabled" : ""}>${slots.includes(article.entityId) ? "已精选" : "加入精选"}</button></article>`).join("") || '<p class="empty-state">没有匹配的已发布文章。</p>';
  }
  root.querySelector("#featured-search").addEventListener("input", paint);
  root.querySelector("#featured-form").addEventListener("click", handle);
  root.querySelector("#featured-candidates").addEventListener("click", handle);
  function handle(e) {
    const button = e.target.closest("button");
    if (!button || button.disabled) return;
    if (button.hasAttribute("data-add")) { const index = slots.indexOf(null); if (index < 0) return; slots[index] = button.dataset.add; }
    else if (button.hasAttribute("data-remove")) { const index = Number(button.dataset.remove); if (index >= 3) slots.splice(index, 1); else slots[index] = null; }
    else if (button.hasAttribute("data-move")) { const index = Number(button.dataset.move), next = index + Number(button.dataset.step); if (next < 0 || next >= slots.length) return; [slots[index], slots[next]] = [slots[next], slots[index]]; }
    else return;
    setDirty(true); paint();
  }
  on("#featured-form", "submit", async () => {
    if (!completeSlots(slots, 3)) throw new Error("精选文章必须恰好 3 篇。");
    await saveSite(snapshot, { featuredIds: slots });
    await featuredPage(); status("精选文章已保存，首页顺序已同步。");
  });
  paint();
}
export async function introductionPage() {
  setDirty(false);
  const snapshot = await api("/site");
  root.innerHTML = `${pageHeading("自我介绍", "首页 ABOUT ME 的展示文案。输入的回车和空行会原样保留。")}${setupWarning(snapshot.value)}<form id="introduction-form"><div class="section-toolbar"><div><h2>介绍文案</h2><p class="muted">手动回车决定段落，窄屏会在此基础上自动折行。</p></div><button type="submit">保存自我介绍</button></div><div class="intro-workspace"><div class="intro-input">${area("自我介绍", "homeAbout", snapshot.value.homeAbout)}<p class="field-hint"><span id="intro-length"></span> / 1200 字 · 回车换行，空行分段</p><p class="muted">可以在右侧切换电脑与手机预览，检查每行文字的展示效果。</p></div><section class="intro-preview-panel" aria-label="自我介绍预览"><div class="preview-device-controls"><button type="button" class="secondary" data-device="desktop" aria-pressed="true">电脑预览</button><button type="button" class="secondary" data-device="mobile" aria-pressed="false">手机预览</button></div><div class="intro-preview" data-device="desktop"><span>ABOUT ME</span><p id="intro-preview-copy"></p><small>MORE ABOUT ME ↗</small></div></section></div></form>`;
  const form = root.querySelector("#introduction-form");
  function preview() {
    const text = value(form, "homeAbout");
    root.querySelector("#intro-preview-copy").textContent = text;
    root.querySelector("#intro-length").textContent = Array.from(text).length;
    saveState(form.querySelector('[type="submit"]'), Array.from(text).length <= 1200);
  }
  form.addEventListener("input", () => { setDirty(true); preview(); });
  form.querySelectorAll("[data-device]").forEach(button => {
    if (button.tagName !== "BUTTON") return;
    button.onclick = () => {
      form.querySelector(".intro-preview").dataset.device = button.dataset.device;
      form.querySelectorAll("button[data-device]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    };
  });
  on("#introduction-form", "submit", async () => {
    await saveSite(snapshot, { homeAbout: value(form, "homeAbout") });
    await introductionPage(); status("自我介绍已保存，换行已同步到首页。");
  });
  preview();
}
export async function aboutPage() {
  setDirty(false);
  const snapshot = await api("/site"), site = snapshot.value;
  root.innerHTML = `${pageHeading("关于页面", "维护独立关于页面的内容，首页自我介绍在单独的模块中管理。")}${setupWarning(site)}<form id="about-form" class="settings-form">${field("页面标题", "aboutTitle", site.aboutTitle)}${area("关于正文", "aboutText", site.aboutText)}${area("补充说明", "aboutNote", site.aboutNote)}${field("主题标签（用逗号分隔）", "topics", site.topics.join(","))}<div class="actions"><button type="submit">保存关于页面</button><a class="btn" href="/#/about" target="_blank" rel="noopener">查看关于页面 ↗</a></div></form>`;
  const form = root.querySelector("#about-form");
  form.addEventListener("input", () => setDirty(true));
  on("#about-form", "submit", async () => {
    await saveSite(snapshot, { aboutTitle: value(form, "aboutTitle"), aboutText: value(form, "aboutText"), aboutNote: value(form, "aboutNote"), topics: value(form, "topics").split(/[,，]/u).map(item => item.trim()).filter(Boolean) });
    await aboutPage(); status("关于页面已保存。");
  });
}
