export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export async function readPublic(path, signal) {
  const response = await fetch("/api/public/v1" + path, {
    signal,
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const error = new Error(
      response.status === 404 ? "NOT_FOUND" : "UNAVAILABLE",
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}
export const imageData = (image) =>
  image
    ? {
        ...image,
        raw: { ...image },
        ...Object.fromEntries(
          [
            "src",
            "alt",
            "title",
            "author",
            "provider",
            "source",
            "credit",
            "licenseName",
            "licenseUrl",
          ].map((k) => [k, esc(image[k])]),
        ),
      }
    : null;
export function articleData(article) {
  return {
    ...article,
    id: article.slug,
    title: esc(article.title),
    desc: esc(article.summary),
    intro: esc(article.intro),
    category: esc(article.category),
    date: article.isDemo
      ? "示例文章"
      : new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(article.firstPublishedAt)),
    read: `${article.readingMinutes} 分钟`,
    cover: imageData(article.cover),
    body: article.bodyHtml || "",
    sections: (article.toc || []).map((x) => [esc(x.id), esc(x.title)]),
    next: article.next
      ? { id: article.next.slug, title: esc(article.next.title) }
      : null,
    previous: article.previous
      ? { id: article.previous.slug, title: esc(article.previous.title) }
      : null,
  };
}
export function projectData(project) {
  return {
    ...project,
    id: project.slug,
    title: esc(project.title),
    type: esc(project.type),
    desc: esc(project.desc),
    body: esc(project.body),
    note: esc(project.note),
    tags: project.tags.map(esc),
    details: project.details.map(esc),
    cover: imageData(project.cover),
  };
}
export function columnData(column) {
  return {
    ...column,
    id: column.slug,
    name: esc(column.name),
    rawName: column.name,
    intro: esc(column.introduction),
    count: column.publishedArticleCount,
    order: column.position,
    images: column.images.map(imageData),
    articleIds: [],
  };
}
export async function loadRoute(route, id, page, signal) {
  const home = await readPublic("/home", signal);
  const state = {
    articles: home.featured.map(articleData),
    columns: home.columns.map((column, index) => ({ ...columnData(column), order: index + 1 })),
    gallery: home.gallery.map(imageData),
    homeAbout: esc(home.homeAbout),
    projects: [],
    chapters: [],
    about: null,
    page: { total: home.featured.length, page: 1, pageSize: 12 },
  };
  if (route === "articles" || route === "life") {
    const query = new URLSearchParams({ page: String(page) });
    if (route === "life") query.set("kind", "Life");
    else if (id && id !== "全部") {
      const column = state.columns.find((c) => c.rawName === id || c.id === id);
      if (!column) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      query.set("column", column.id);
      state.category = column.name;
    }
    const data = await readPublic("/articles?" + query, signal);
    state.articles = data.items.map(articleData);
    state.page = data;
  } else if (route === "article" || route === "knowledge") {
    if (route === "knowledge") {
      const chapters = await readPublic("/knowledge", signal);
      state.chapters = chapters.map((c) => [
        String(c.position).padStart(2, "0"),
        esc(c.title),
        c.items.map((a) => [a.id, esc(a.title)]),
      ]);
      id = id || chapters[0]?.items[0]?.id;
      if (!id) {
        state.articles = [];
        state.emptyKnowledge = true;
        return state;
      }
      if (!chapters.some((c) => c.items.some((a) => a.id === id)))
        throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
    }
    state.selectedId = id;
    state.articles = [
      articleData(
        await readPublic("/articles/" + encodeURIComponent(id), signal),
      ),
    ];
  } else if (route === "column") {
    const data = await readPublic("/columns/" + encodeURIComponent(id), signal);
    state.articles = data.articles.map(articleData);
    const column = columnData(data.column);
    column.order = state.columns.find(item => item.id === column.id)?.order || column.order;
    column.articleIds = state.articles.map((a) => a.id);
    state.columns = state.columns.map((c) => (c.id === column.id ? column : c));
  } else if (route === "projects")
    state.projects = (await readPublic("/projects", signal)).map(projectData);
  else if (route === "project")
    state.projects = [
      projectData(
        await readPublic("/projects/" + encodeURIComponent(id), signal),
      ),
    ];
  else if (route === "about") {
    const data = await readPublic("/about", signal);
    state.about = {
      title: esc(data.title),
      text: esc(data.text),
      note: esc(data.note),
      topics: data.topics.map(esc),
    };
  }
  return state;
}
