import { api, bootstrap, status } from "./api.js";
import { articlesPage, dispose } from "./articles.js";
import {
  columnsPage,
  knowledgePage,
  projectsPage,
  sitePage,
} from "./management.js";
import { mediaPage } from "./media.js";
import { operationsPage } from "./operations.js";
async function start() {
  try {
    const session = await bootstrap();
    const login = document.querySelector("#login-form");
    if (login) {
      document.querySelector(".admin-nav").hidden = true;
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
          location.href = "/admin/articles";
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
        location.href = "/admin/login";
      } catch (error) {
        status(error.message);
      }
    };
    const section = location.pathname.split("/")[2] || "articles";
    document
      .querySelector(`.admin-nav a[href="/admin/${section}"]`)
      ?.setAttribute("aria-current", "page");
    const page = {
      articles: articlesPage,
      columns: columnsPage,
      media: mediaPage,
      knowledge: knowledgePage,
      projects: projectsPage,
      site: sitePage,
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
    status(error.message);
    document.querySelector("#admin-content")?.removeAttribute("aria-busy");
  }
}
start();
