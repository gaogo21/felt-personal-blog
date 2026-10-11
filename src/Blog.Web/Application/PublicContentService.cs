using Blog.Web.Application.RichText;
using Blog.Web.Application.Articles;
namespace Blog.Web.Application;

public sealed class PublicContentService(BlogDbContext db, ContentImages images, ManagementService management, RichTextSchema schema)
{
    private IQueryable<Article> Published => db.Set<Article>().AsNoTracking().Where(x => x.State == ArticleState.Published);
    public async Task<object> ArticleAsync(string slug, CancellationToken ct)
    {
        var article = await Published.SingleOrDefaultAsync(x => x.Slug == slug, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
        var revision = await db.Set<ArticleRevision>().AsNoTracking().SingleAsync(x => x.Id == article.PublishedRevisionId && x.ArticleId == article.Id, ct);
        var column = await db.Set<Column>().AsNoTracking().SingleOrDefaultAsync(x => x.Id == revision.ColumnId && x.State == ColumnState.Active, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
        var body = schema.Validate(JsonSerializer.Deserialize<JsonElement>(revision.ContentJson), 1);
        var assets = await images.ResolveAsync(body.References.Select(x => x.MediaId).Concat(revision.CoverMediaId is { } cover ? [cover] : []), ct);
        body = body.WithTrustedMedia(assets);
        var ordered = await (from a in Published
                             join r in db.Set<ArticleRevision>() on a.PublishedRevisionId equals (Guid?)r.Id
                             join o in db.Set<ColumnArticleOrder>() on a.Id equals o.ArticleId
                             where r.ColumnId == column.Id
                             orderby o.Position, a.Id
                             select new { a.Slug, r.Title }).ToListAsync(ct);
        var index = ordered.FindIndex(x => x.Slug == slug);
        return new
        {
            id = article.Slug,
            entityId = article.Id,
            article.Slug,
            article.Kind,
            article.IsDemo,
            revision.Title,
            summary = revision.Summary,
            revision.Intro,
            category = column.Name,
            columnSlug = column.Slug,
            article.FirstPublishedAt,
            updatedAt = article.LastPublishedAt,
            readingMinutes = body.ReadingMinutes,
            bodyHtml = body.Html.ToString(),
            toc = body.Toc,
            cover = revision.CoverMediaId is { } coverId ? ContentImages.View(assets[coverId]) : null,
            previous = index > 0 ? ordered[index - 1] : null,
            next = index >= 0 && index + 1 < ordered.Count ? ordered[index + 1] : null
        };
    }
    public async Task<object> ListAsync(string? columnSlug, string? kind, int page, CancellationToken ct)
    {
        if (page < 1 || page > 1000000 || kind is not (null or "Article" or "Life")) throw ArticleInput.Invalid("page");
        Guid? columnId = null;
        if (columnSlug is not null)
            columnId = await db.Set<Column>().Where(x => x.Slug == columnSlug && x.State == ColumnState.Active).Select(x => (Guid?)x.Id).SingleOrDefaultAsync(ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
        var query = from a in Published
                    join r in db.Set<ArticleRevision>().AsNoTracking() on a.PublishedRevisionId equals (Guid?)r.Id
                    join column in db.Set<Column>().AsNoTracking() on r.ColumnId equals column.Id
                    where column.State == ColumnState.Active && (columnId == null || r.ColumnId == columnId) && (kind == null || a.Kind == kind)
                    orderby a.FirstPublishedAt descending, a.Id
                    select new { Article = a, Revision = r, Column = column };
        var total = await query.CountAsync(ct);
        var rows = await query.Skip((page - 1) * 12).Take(12).ToListAsync(ct);
        var assetIds = rows.Where(x => x.Revision.CoverMediaId != null).Select(x => x.Revision.CoverMediaId!.Value);
        var assets = await images.ResolveAsync(assetIds, ct);
        return new { total, page, pageSize = 12, items = rows.Select(x => Summary(x.Article, x.Revision, x.Column, assets)).ToArray() };
    }
    public async Task<object[]> ColumnsAsync(CancellationToken ct)
    {
        var list = await db.Set<Column>().AsNoTracking().Where(x => x.State == ColumnState.Active).OrderBy(x => x.Position).ThenBy(x => x.Id).ToListAsync(ct);
        var values = new List<object>(); foreach (var column in list) values.Add(await management.ColumnViewAsync(column, ct)); return values.ToArray();
    }
    public async Task<object> ColumnAsync(string slug, CancellationToken ct)
    {
        var column = await db.Set<Column>().AsNoTracking().SingleOrDefaultAsync(x => x.Slug == slug && x.State == ColumnState.Active, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
        var rows = await (from a in Published
                          join r in db.Set<ArticleRevision>().AsNoTracking() on a.PublishedRevisionId equals (Guid?)r.Id
                          join order in db.Set<ColumnArticleOrder>() on a.Id equals order.ArticleId
                          where r.ColumnId == column.Id
                          orderby order.Position, a.Id
                          select new { Article = a, Revision = r }).ToListAsync(ct);
        var assets = await images.ResolveAsync(rows.Where(x => x.Revision.CoverMediaId != null).Select(x => x.Revision.CoverMediaId!.Value), ct);
        return new { column = await management.ColumnViewAsync(column, ct), articles = rows.Select(x => Summary(x.Article, x.Revision, column, assets)).ToArray() };
    }
    public async Task<object> HomeAsync(CancellationToken ct)
    {
        var site = ManagementService.SiteValue(await management.SiteAsync(ct));
        var rows = await (from a in Published
                          join r in db.Set<ArticleRevision>() on a.PublishedRevisionId equals (Guid?)r.Id
                          join col in db.Set<Column>() on r.ColumnId equals col.Id
                          where site.FeaturedIds.Contains(a.Id) && col.State == ColumnState.Active
                          select new { A = a, R = r, C = col }).ToListAsync(ct);
        var assets = await images.ResolveAsync(site.GalleryIds.Concat(rows.Where(x => x.R.CoverMediaId != null).Select(x => x.R.CoverMediaId!.Value)), ct);
        return new
        {
            homeAbout = site.HomeAbout,
            featured = site.FeaturedIds.Where(id => rows.Any(x => x.A.Id == id)).Select(id => { var x = rows.Single(x => x.A.Id == id); return Summary(x.A, x.R, x.C, assets); }).ToArray(),
            columns = await ColumnsAsync(ct),
            gallery = site.GalleryIds.Where(assets.ContainsKey).Select(id => ContentImages.View(assets[id])).ToArray()
        };
    }
    public async Task<object> AboutAsync(CancellationToken ct)
    { var s = ManagementService.SiteValue(await management.SiteAsync(ct)); return new { title = s.AboutTitle, text = s.AboutText, note = s.AboutNote, s.Topics }; }
    public async Task<object[]> KnowledgeAsync(CancellationToken ct)
    {
        var chapters = await db.Set<KnowledgeChapter>().OrderBy(x => x.Position).ThenBy(x => x.Id).ToListAsync(ct);
        var result = new List<object>();
        foreach (var chapter in chapters)
        {
            var entries = await (from entry in db.Set<KnowledgeEntry>()
                                 join a in Published on entry.ArticleId equals a.Id
                                 join r in db.Set<ArticleRevision>() on a.PublishedRevisionId equals (Guid?)r.Id
                                 where entry.ChapterId == chapter.Id
                                 orderby entry.Position, entry.Id
                                 select new { id = a.Slug, r.Title }).ToArrayAsync(ct);
            if (entries.Length > 0) result.Add(new { chapter.Title, chapter.Position, items = entries });
        }
        return result.ToArray();
    }
    public async Task<object[]> ProjectsAsync(CancellationToken ct)
    {
        var projects = await db.Set<ProjectEntry>().AsNoTracking().Where(x => !x.Trashed && x.PublishedJson != null).OrderBy(x => x.Position).ThenBy(x => x.Id).ToListAsync(ct);
        var result = new List<object>(); foreach (var p in projects) result.Add(await ProjectViewAsync(p, ct)); return result.ToArray();
    }
    public async Task<object> ProjectAsync(string slug, CancellationToken ct) => await ProjectViewAsync(await db.Set<ProjectEntry>().AsNoTracking().SingleOrDefaultAsync(x => x.Slug == slug && !x.Trashed && x.PublishedJson != null, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND), ct);
    private async Task<object> ProjectViewAsync(ProjectEntry p, CancellationToken ct)
    {
        var input = JsonSerializer.Deserialize<ProjectInput>(p.PublishedJson!, ApiJson.Options)!;
        var cover = input.CoverMediaId is { } id ? await images.ReadyAsync(id, MediaKind.Image, ct) : null;
        return new { id = p.Slug, p.Slug, p.IsDemo, input.Title, input.Type, desc = input.Summary, input.Tags, input.Body, input.Details, input.Note, cover = cover is null ? null : ContentImages.View(cover) };
    }
    private object Summary(Article a, ArticleRevision r, Column column, IReadOnlyDictionary<Guid, MediaAsset> assets)
    {
        var body = schema.Validate(JsonSerializer.Deserialize<JsonElement>(r.ContentJson), 1);
        return new
        {
            id = a.Slug,
            a.Slug,
            entityId = a.Id,
            a.Kind,
            a.IsDemo,
            r.Title,
            summary = r.Summary,
            r.Intro,
            category = column.Name,
            columnSlug = column.Slug,
            a.FirstPublishedAt,
            readingMinutes = body.ReadingMinutes,
            cover = r.CoverMediaId is { } id && assets.TryGetValue(id, out var cover) ? ContentImages.View(cover) : null
        };
    }
}
