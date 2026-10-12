import { api, bootstrap, showError, enhanceControls, setDirty } from "./api.js";
import { articlesPage, dispose } from "./articles.js";
import {
  columnsPage,
  knowledgePage,
  projectsPage,
} from "./management.js";
import { galleryPage, introductionPage, featuredPage, aboutPage } from "./site.js";
import { mediaPage } from "./media.js";
import { operationsPage } from "./operations.js";
async function start() {
  enhanceControls();
  new MutationObserver(() => enhanceControls()).observe(document.body, { childList: true, subtree: true });
  try {
    const session = await bootstrap();
    const login = document.querySelector("#login-form");
    if (login) {
      login.addEventListener("submit", async (e) => {
        e.preventDefault();
        const button = e.submitter;
        button.disabled = true;
        try {
          await api("/session", {
            method: "POST",
            body: {
              userName: login.userName.value,
              password: login.password.value,
            },
          });
          location.href = "/admin/gallery";
        } catch (error) {
          document.querySelector("#login-error").textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      return;
    }
    if (!session.session) {
      location.href = "/admin/login";
      return;
    }
    const logout = document.querySelector("#logout");
    logout.hidden = false;
    logout.onclick = async () => {
      try {
        await api("/session", { method: "DELETE" });
        dispose();
        setDirty(false);
        location.href = "/admin/login";
      } catch (error) {
        showError(error);
      }
    };
    const section = location.pathname.split("/")[2] || "gallery";
    if (section === "site") { location.replace("/admin/gallery"); return; }
    const active = document.querySelector(`.admin-nav a[href="/admin/${section}"]`);
    active?.setAttribute("aria-current", "page");
    document.querySelector("#admin-section-title").textContent = active?.textContent.trim() || "内容管理";
    document.querySelector("#admin-section-group").textContent = active?.closest(".nav-group").querySelector("p").textContent || "工作台";
    setupNavigation();
    const page = {
      articles: articlesPage,
      columns: columnsPage,
      media: mediaPage,
      knowledge: knowledgePage,
      projects: projectsPage,
      gallery: galleryPage,
      introduction: introductionPage,
      featured: featuredPage,
      about: aboutPage,
      operations: operationsPage,
    }[section];
    if (!page) {
      document.querySelector("#admin-content").innerHTML =
        "<h1>没有这个管理页面。</h1>";
      return;
    }
    await page();
    document.querySelector("#admin-content").removeAttribute("aria-busy");
  } catch (error) {
    showError(error);
    document.querySelector("#admin-content")?.removeAttribute("aria-busy");
  }
}
function setupNavigation() {
  const sidebar = document.querySelector("#admin-sidebar"), toggle = document.querySelector("#sidebar-toggle"),
    backdrop = document.querySelector("#sidebar-backdrop"), workspace = document.querySelector(".admin-workspace"),
    mobile = matchMedia("(max-width: 900px)");
  let open = false;
  function close(restore = true) {
    open = false; sidebar.classList.remove("is-open"); backdrop.hidden = true; workspace.inert = false;
    sidebar.removeAttribute("role"); sidebar.removeAttribute("aria-modal");
    sidebar.inert = mobile.matches; toggle.setAttribute("aria-expanded", "false"); document.body.classList.remove("nav-open");
    if (restore) toggle.focus();
  }
  toggle.onclick = () => {
    if (open) { close(); return; }
    open = true; sidebar.inert = false; sidebar.classList.add("is-open"); backdrop.hidden = false;
    sidebar.setAttribute("role", "dialog"); sidebar.setAttribute("aria-modal", "true");
    toggle.setAttribute("aria-expanded", "true"); document.body.classList.add("nav-open"); workspace.inert = true;
    sidebar.querySelector("a").focus();
  };
  backdrop.onclick = () => close();
  document.addEventListener("keydown", e => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Tab") {
      const links = [...sidebar.querySelectorAll("a,button")], first = links[0], last = links.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  mobile.addEventListener("change", () => close(false));
  sidebar.inert = mobile.matches;
}
start();
