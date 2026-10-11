using System.Data;
using Blog.Web.Application;
using Blog.Web.Application.Articles;
namespace Blog.Web.Api;

public static class ContentEndpoints
{
    public static void MapContent(this WebApplication app)
    {
        var read = app.MapGroup("/api/public/v1");
        read.AddEndpointFilter(async (context, next) =>
        {
            var db = context.HttpContext.RequestServices.GetRequiredService<BlogDbContext>();
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, context.HttpContext.RequestAborted);
            var result = await next(context); await tx.CommitAsync(context.HttpContext.RequestAborted); return result;
        });
        read.MapGet("/home", (PublicContentService s, CancellationToken ct) => s.HomeAsync(ct));
        read.MapGet("/about", (PublicContentService s, CancellationToken ct) => s.AboutAsync(ct));
        read.MapGet("/articles", (PublicContentService s, string? column, string? kind, int? page, CancellationToken ct) => s.ListAsync(column, kind, page ?? 1, ct));
        read.MapGet("/articles/{slug}", (PublicContentService s, string slug, CancellationToken ct) => s.ArticleAsync(slug, ct));
        read.MapGet("/columns", (PublicContentService s, CancellationToken ct) => s.ColumnsAsync(ct));
        read.MapGet("/columns/{slug}", (PublicContentService s, string slug, CancellationToken ct) => s.ColumnAsync(slug, ct));
        read.MapGet("/knowledge", (PublicContentService s, CancellationToken ct) => s.KnowledgeAsync(ct));
        read.MapGet("/projects", (PublicContentService s, CancellationToken ct) => s.ProjectsAsync(ct));
        read.MapGet("/projects/{slug}", (PublicContentService s, string slug, CancellationToken ct) => s.ProjectAsync(slug, ct));

        var admin = app.MapGroup("/api/admin/v1").RequireAuthorization();
        admin.MapGet("/articles", async (BlogDbContext db, ArticleService s, string? state, string? q, string? columnId, int? page, CancellationToken ct) =>
        {
            var query = db.Set<Article>().AsQueryable();
            if (state is not null) { if (!Enum.TryParse<ArticleState>(state, out var parsed) || !Enum.IsDefined(parsed)) throw ArticleInput.Invalid("state"); query = query.Where(x => x.State == parsed); }
            if (q is not null) { if (q.Length > 100) throw ArticleInput.Invalid("q"); query = query.Where(x => x.Slug.Contains(q) || db.Set<ArticleDraft>().Any(d => d.ArticleId == x.Id && d.Title.Contains(q))); }
            if (columnId is not null) { if (!Guid.TryParse(columnId, out var column)) throw ArticleInput.Invalid("columnId"); query = query.Where(x => db.Set<ArticleDraft>().Any(d => d.ArticleId == x.Id && d.ColumnId == column)); }
            var current = page ?? 1; if (current < 1 || current > 1000000) throw ArticleInput.Invalid("page");
            var total = await query.CountAsync(ct); var list = await query.OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Skip((current - 1) * 20).Take(20).ToListAsync(ct);
            var items = new List<object>(); foreach (var a in list) items.Add(await s.AdminViewAsync(a, ct)); return new { total, page = current, pageSize = 20, items };
        });
        admin.MapGet("/articles/{id:guid}", async (Guid id, ArticleService s, HttpContext c) =>
        { var a = await s.RequireAsync(id, c.RequestAborted); c.Response.Headers.ETag = Versions.Tag("article", id, a.Version); return await s.AdminViewAsync(a, c.RequestAborted); });
        admin.MapGet("/articles/{id:guid}/draft", async (Guid id, ArticleService s, BlogDbContext db, HttpContext c) =>
        { var a = await s.RequireAsync(id, c.RequestAborted); if (a.State == ArticleState.Purged) throw new ApiFailure(ProblemCode.NOT_FOUND); var d = await db.Set<ArticleDraft>().SingleAsync(x => x.ArticleId == id, c.RequestAborted); c.Response.Headers.ETag = Versions.Tag("draft", id, d.Version); return ArticleService.DraftView(d); });
        admin.MapGet("/articles/{id:guid}/preview", (Guid id, ArticleService s, CancellationToken ct) => s.PreviewAsync(id, ct));
        admin.MapGet("/articles/{id:guid}/revisions", async (Guid id, BlogDbContext db, CancellationToken ct) => await db.Set<ArticleRevision>().Where(x => x.ArticleId == id).OrderByDescending(x => x.Number).Select(x => new { x.Id, x.Number, x.Title, x.CreatedAt }).ToArrayAsync(ct));
        admin.MapPost("/articles", async (CreateArticleInput input, ArticleService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "article.create", input, true, () => s.CreateAsync(input, c.RequestAborted))));
        admin.MapPut("/articles/{id:guid}/draft", async (Guid id, DraftInput input, ArticleService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "draft.save:" + id, input, false, () => s.SaveAsync(id, input, c))));
        admin.MapPatch("/articles/{id:guid}/identity", async (Guid id, IdentityInput input, ArticleService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "article.identity:" + id, input, false, () => s.IdentityAsync(id, input, c))));
        admin.MapPost("/articles/{id:guid}/publish", async (Guid id, PublishInput input, ArticleService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "article.publish:" + id, input, true, () => s.PublishAsync(id, input, c))));
        foreach (var action in new[] { "withdraw", "trash", "restore" })
        {
            var captured = action;
            admin.MapPost("/articles/{id:guid}/" + captured, async (Guid id, ArticleService s, MutationCoordinator m, HttpContext c) =>
                MutationCoordinator.Result(c, await m.ExecuteAsync(c, "article." + captured + ":" + id, null, true, () => s.LifecycleAsync(id, captured, c))));
        }
        admin.MapPost("/articles/{id:guid}/purge", async (Guid id, PurgeInput input, ArticleService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "article.purge:" + id, input, true, () => s.LifecycleAsync(id, "purge", c, input))));
        admin.MapPost("/articles/{id:guid}/revisions/{revision:guid}/restore", async (Guid id, Guid revision, ArticleService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "article.revision.restore:" + id + ":" + revision, null, true, () => s.RestoreRevisionAsync(id, revision, c))));
        admin.MapGet("/columns", async (BlogDbContext db, ManagementService s, CancellationToken ct) =>
        { var columns = await db.Set<Column>().OrderBy(x => x.Position).ThenBy(x => x.Id).ToListAsync(ct); var items = new List<object>(); foreach (var col in columns) items.Add(await s.ColumnViewAsync(col, ct)); var site = await s.SiteAsync(ct); return new { items, siteEtag = ManagementService.SiteTag(site.Version) }; });
        admin.MapGet("/columns/{id:guid}", async (Guid id, ManagementService s, CancellationToken ct) => await s.ColumnViewAsync(await s.ColumnAsync(id, ct), ct));
        admin.MapPost("/columns", async (ColumnInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "column.create", input, true, () => s.CreateColumnAsync(input, c.RequestAborted))));
        admin.MapPut("/columns/{id:guid}", async (Guid id, ColumnInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "column.save:" + id, input, false, () => s.SaveColumnAsync(id, input, c))));
        foreach (var action in new[] { "activate", "archive", "restore" })
        {
            var captured = action;
            admin.MapPost("/columns/{id:guid}/" + captured, async (Guid id, ManagementService s, MutationCoordinator m, HttpContext c) =>
                MutationCoordinator.Result(c, await m.ExecuteAsync(c, "column." + captured + ":" + id, null, true, () => s.ColumnStateAsync(id, captured, c))));
        }
        admin.MapPut("/columns/order", async (OrderInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "column.order", input, false, () => s.OrderColumnsAsync(input, c))));
        admin.MapPut("/columns/{id:guid}/articles/order", async (Guid id, OrderInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "column.articles.order:" + id, input, false, () => s.OrderArticlesAsync(id, input, c))));
        admin.MapGet("/site", (ManagementService s, CancellationToken ct) => s.SiteViewAsync(ct));
        admin.MapPut("/site", async (SiteInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "site.save", input, false, () => s.SaveSiteAsync(input, c))));
        admin.MapGet("/projects", async (BlogDbContext db, CancellationToken ct) => (await db.Set<ProjectEntry>().OrderBy(x => x.Position).ToListAsync(ct)).Select(ManagementService.ProjectView).ToArray());
        admin.MapGet("/projects/{id:guid}", async (Guid id, ManagementService s, CancellationToken ct) => ManagementService.ProjectView(await s.ProjectAsync(id, ct)));
        admin.MapPost("/projects", async (CreateProjectInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "project.create", input, true, () => s.CreateProjectAsync(input, c.RequestAborted))));
        admin.MapPut("/projects/{id:guid}", async (Guid id, ProjectInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "project.save:" + id, input, false, () => s.SaveProjectAsync(id, input, c))));
        foreach (var action in new[] { "publish", "withdraw", "trash", "restore" })
        {
            var captured = action;
            admin.MapPost("/projects/{id:guid}/" + captured, async (Guid id, ManagementService s, MutationCoordinator m, HttpContext c) =>
                MutationCoordinator.Result(c, await m.ExecuteAsync(c, "project." + captured + ":" + id, null, true, () => s.ProjectStateAsync(id, captured, c))));
        }
        admin.MapPut("/projects/order", async (OrderInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "project.order", input, false, () => s.OrderProjectsAsync(input, c))));
        admin.MapGet("/knowledge", async (BlogDbContext db, ManagementService s, CancellationToken ct) =>
        {
            var chapters = await db.Set<KnowledgeChapter>().OrderBy(x => x.Position).ToListAsync(ct); var entries = await db.Set<KnowledgeEntry>().OrderBy(x => x.Position).ToListAsync(ct); var site = await s.SiteAsync(ct);
            return new { siteEtag = ManagementService.SiteTag(site.Version), items = chapters.Select(x => new { x.Id, x.Title, x.Position, etag = Versions.Tag("chapter", x.Id, x.Version), articleIds = entries.Where(e => e.ChapterId == x.Id).Select(e => e.ArticleId).ToArray() }).ToArray() };
        });
        admin.MapPost("/knowledge", async (ChapterInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "chapter.create", input, true, () => s.SaveChapterAsync(null, input, c))));
        admin.MapPut("/knowledge/{id:guid}", async (Guid id, ChapterInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "chapter.save:" + id, input, false, () => s.SaveChapterAsync(id, input, c))));
        admin.MapPut("/knowledge/order", async (OrderInput input, ManagementService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "chapter.order", input, false, () => s.OrderChaptersAsync(input, c))));
        admin.MapDelete("/knowledge/{id:guid}", async (Guid id, BlogDbContext db, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "chapter.delete:" + id, null, false, async () =>
            { var chapter = await db.Set<KnowledgeChapter>().SingleOrDefaultAsync(x => x.Id == id, c.RequestAborted) ?? throw new ApiFailure(ProblemCode.NOT_FOUND); Versions.Require(c, Versions.Tag("chapter", id, chapter.Version)); db.Remove(chapter); return new MutationReply(new { deleted = true }, TargetId: id); })));
        admin.MapGet("/audit", async (BlogDbContext db, CancellationToken ct) => await db.Set<AuditEvent>().OrderByDescending(x => x.CreatedAt).Take(100).Select(x => new { x.Action, x.TargetId, x.CreatedAt }).ToArrayAsync(ct));
    }
}
