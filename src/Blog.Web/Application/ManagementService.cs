using Blog.Web.Application.Articles;
using Blog.Web.Domain;
namespace Blog.Web.Application;

public sealed record ColumnInput(string Slug, string Name, string Introduction, Guid[] ImageIds);
public sealed record OrderInput(Guid[] Ids);
public sealed record SiteInput(string HomeAbout, string AboutTitle, string AboutText, string AboutNote, string[] Topics, Guid[] GalleryIds, Guid[] FeaturedIds);
public sealed record ProjectInput(string Title, string Type, string Summary, string[] Tags, string Body, string[] Details, string Note, Guid? CoverMediaId);
public sealed record CreateProjectInput(string Slug, string Title);
public sealed record ChapterInput(string Title, Guid[] ArticleIds);

public sealed class ManagementService(BlogDbContext db, ContentImages images)
{
    public static readonly Guid SiteOwnerId = Guid.Parse("00000000-0000-4000-8000-000000000001");
    public static string SiteTag(long version) => $"\"site-1-{version}\"";
    public async Task<SiteSettings> SiteAsync(CancellationToken ct) => await db.Set<SiteSettings>().SingleAsync(x => x.Id == 1, ct);
    public static SiteInput SiteValue(SiteSettings site) => JsonSerializer.Deserialize<SiteInput>(site.Json, ApiJson.Options)!;
    public async Task<object> SiteViewAsync(CancellationToken ct)
    { var site = await SiteAsync(ct); return new { etag = SiteTag(site.Version), value = SiteValue(site) }; }
    public async Task<MutationReply> SaveSiteAsync(SiteInput input, HttpContext c)
    {
        var site = await SiteAsync(c.RequestAborted); Versions.Require(c, SiteTag(site.Version));
        input = input with
        {
            HomeAbout = Text(input.HomeAbout, 1200, "homeAbout"),
            AboutTitle = Text(input.AboutTitle, 120, "aboutTitle"),
            AboutText = Text(input.AboutText, 3000, "aboutText"),
            AboutNote = Text(input.AboutNote, 1200, "aboutNote"),
            Topics = Strings(input.Topics, 12, 40, "topics"),
            GalleryIds = Exact(input.GalleryIds, 10, "galleryIds"),
            FeaturedIds = Exact(input.FeaturedIds, 3, "featuredIds")
        };
        foreach (var id in input.GalleryIds) _ = await images.ReadyAsync(id, MediaKind.Image, c.RequestAborted);
        var featuredCount = await (from a in db.Set<Article>()
                                   join r in db.Set<ArticleRevision>() on a.PublishedRevisionId equals (Guid?)r.Id
                                   join col in db.Set<Column>() on r.ColumnId equals col.Id
                                   where input.FeaturedIds.Contains(a.Id) && a.State == ArticleState.Published && col.State == ColumnState.Active
                                   select a.Id).CountAsync(c.RequestAborted);
        if (featuredCount != 3) throw ArticleInput.Invalid("featuredIds", FieldIssue.Unavailable);
        site.Json = JsonSerializer.Serialize(input, ApiJson.Options); site.Version++;
        await images.ReplaceReferencesAsync("Gallery", SiteOwnerId, input.GalleryIds.Select(x => (x, "Gallery")), c.RequestAborted);
        return new(new { etag = SiteTag(site.Version), value = input }, ETag: SiteTag(site.Version), TargetId: SiteOwnerId);
    }
    public async Task<Column> ColumnAsync(Guid id, CancellationToken ct) => await db.Set<Column>().SingleOrDefaultAsync(x => x.Id == id, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
    public async Task<object> ColumnViewAsync(Column value, CancellationToken ct)
    {
        var ids = JsonSerializer.Deserialize<Guid[]>(value.ImageIdsJson)!;
        var assets = await images.ResolveAsync(ids, ct);
        var count = await (from a in db.Set<Article>() join r in db.Set<ArticleRevision>() on a.PublishedRevisionId equals (Guid?)r.Id where a.State == ArticleState.Published && r.ColumnId == value.Id select a).CountAsync(ct);
        return new
        {
            value.Id,
            value.Slug,
            value.Name,
            value.Introduction,
            value.State,
            value.Position,
            value.Version,
            etag = Versions.Tag("column", value.Id, value.Version),
            imageIds = ids,
            images = ids.Where(assets.ContainsKey).Select(id => ContentImages.View(assets[id])).ToArray(),
            publishedArticleCount = count
        };
    }
    public async Task<MutationReply> CreateColumnAsync(ColumnInput input, CancellationToken ct)
    {
        input = await ValidateColumnAsync(input, ct);
        if (await db.Set<Column>().AnyAsync(x => x.Slug == input.Slug, ct)) throw new ApiFailure(ProblemCode.DUPLICATE_SLUG);
        var value = new Column
        {
            Slug = input.Slug,
            Name = input.Name,
            Introduction = input.Introduction,
            ImageIdsJson = JsonSerializer.Serialize(input.ImageIds),
            Position = (await db.Set<Column>().MaxAsync(x => (int?)x.Position, ct) ?? 0) + 1
        };
        db.Add(value); await images.ReplaceReferencesAsync("Column", value.Id, input.ImageIds.Select(id => (id, "ColumnImage")), ct);
        return new(await ColumnViewAsync(value, ct), 201, Versions.Tag("column", value.Id, value.Version), value.Id);
    }
    public async Task<MutationReply> SaveColumnAsync(Guid id, ColumnInput input, HttpContext c)
    {
        var value = await ColumnAsync(id, c.RequestAborted); Versions.Require(c, Versions.Tag("column", id, value.Version));
        input = await ValidateColumnAsync(input, c.RequestAborted);
        if (value.Slug != input.Slug) throw ArticleInput.Invalid("slug");
        if (value.State == ColumnState.Active && input.ImageIds.Length != 3) throw ArticleInput.Invalid("imageIds");
        value.Name = input.Name; value.Introduction = input.Introduction; value.ImageIdsJson = JsonSerializer.Serialize(input.ImageIds); value.Version++;
        await images.ReplaceReferencesAsync("Column", id, input.ImageIds.Select(media => (media, "ColumnImage")), c.RequestAborted);
        return new(await ColumnViewAsync(value, c.RequestAborted), ETag: Versions.Tag("column", id, value.Version), TargetId: id);
    }
    public async Task<MutationReply> ColumnStateAsync(Guid id, string action, HttpContext c)
    {
        var value = await ColumnAsync(id, c.RequestAborted); Versions.Require(c, Versions.Tag("column", id, value.Version));
        if (action is "activate" or "restore" && value.State != ColumnState.Active)
        {
            var ids = JsonSerializer.Deserialize<Guid[]>(value.ImageIdsJson)!;
            _ = await ValidateColumnAsync(new(value.Slug, value.Name, value.Introduction, ids), c.RequestAborted);
            value.State = ColumnState.Active;
        }
        else if (action == "archive" && value.State != ColumnState.Archived)
        {
            if (await (from a in db.Set<Article>() join r in db.Set<ArticleRevision>() on a.PublishedRevisionId equals (Guid?)r.Id where a.State == ArticleState.Published && r.ColumnId == id select a).AnyAsync(c.RequestAborted)) throw new ApiFailure(409, "COLUMN_HAS_PUBLISHED_ARTICLES");
            value.State = ColumnState.Archived;
        }
        else throw new ApiFailure(ProblemCode.STATE_CONFLICT);
        value.Version++;
        return new(await ColumnViewAsync(value, c.RequestAborted), ETag: Versions.Tag("column", id, value.Version), TargetId: id);
    }
    public async Task<MutationReply> OrderColumnsAsync(OrderInput input, HttpContext c)
    {
        var site = await SiteAsync(c.RequestAborted); Versions.Require(c, SiteTag(site.Version));
        var columns = await db.Set<Column>().OrderBy(x => x.Position).ToListAsync(c.RequestAborted);
        ExactOrder(input.Ids, columns.Select(x => x.Id));
        for (var i = 0; i < input.Ids.Length; i++) { var column = columns.Single(x => x.Id == input.Ids[i]); column.Position = i + 1; column.Version++; }
        site.Version++;
        return new(new { ids = input.Ids, etag = SiteTag(site.Version) }, ETag: SiteTag(site.Version), TargetId: SiteOwnerId);
    }
    public async Task<MutationReply> OrderArticlesAsync(Guid columnId, OrderInput input, HttpContext c)
    {
        var column = await ColumnAsync(columnId, c.RequestAborted); Versions.Require(c, Versions.Tag("column", columnId, column.Version));
        var published = await (from a in db.Set<Article>() join r in db.Set<ArticleRevision>() on a.PublishedRevisionId equals (Guid?)r.Id where a.State == ArticleState.Published && r.ColumnId == columnId select a.Id).ToArrayAsync(c.RequestAborted);
        ExactOrder(input.Ids, published);
        var orders = await db.Set<ColumnArticleOrder>().Where(x => x.ColumnId == columnId).ToListAsync(c.RequestAborted);
        for (var i = 0; i < input.Ids.Length; i++) orders.Single(x => x.ArticleId == input.Ids[i]).Position = i + 1;
        column.Version++;
        return new(new { ids = input.Ids }, ETag: Versions.Tag("column", columnId, column.Version), TargetId: columnId);
    }
    public async Task<MutationReply> CreateProjectAsync(CreateProjectInput input, CancellationToken ct)
    {
        var slug = ArticleInput.Slug(input.Slug);
        if (await db.Set<ProjectEntry>().AnyAsync(x => x.Slug == slug, ct)) throw new ApiFailure(ProblemCode.DUPLICATE_SLUG);
        var value = new ProjectEntry
        {
            Slug = slug,
            DraftJson = JsonSerializer.Serialize(new ProjectInput(Text(input.Title, 120, "title"), "项目", "", [], "", [], "", null), ApiJson.Options),
            Position = (await db.Set<ProjectEntry>().MaxAsync(x => (int?)x.Position, ct) ?? 0) + 1
        };
        db.Add(value); return new(ProjectView(value), 201, Versions.Tag("project", value.Id, value.Version), value.Id);
    }
    public static object ProjectView(ProjectEntry p) => new
    {
        p.Id,
        p.Slug,
        p.Version,
        p.Position,
        p.IsDemo,
        p.Trashed,
        published = p.PublishedJson is not null,
        draft = JsonSerializer.Deserialize<ProjectInput>(p.DraftJson, ApiJson.Options),
        etag = Versions.Tag("project", p.Id, p.Version)
    };
    public async Task<ProjectEntry> ProjectAsync(Guid id, CancellationToken ct) => await db.Set<ProjectEntry>().SingleOrDefaultAsync(x => x.Id == id, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
    public async Task<MutationReply> SaveProjectAsync(Guid id, ProjectInput input, HttpContext c)
    {
        var p = await ProjectAsync(id, c.RequestAborted); Versions.Require(c, Versions.Tag("project", id, p.Version));
        if (p.Trashed) throw new ApiFailure(ProblemCode.STATE_CONFLICT);
        input = input with
        {
            Title = Text(input.Title, 120, "title"),
            Type = Text(input.Type, 80, "type"),
            Summary = Text(input.Summary, 240, "summary"),
            Body = Text(input.Body, 100000, "body"),
            Note = Text(input.Note, 1200, "note"),
            Tags = Strings(input.Tags, 12, 40, "tags"),
            Details = Strings(input.Details, 20, 1000, "details")
        };
        if (input.CoverMediaId is { } cover) _ = await images.ReadyAsync(cover, MediaKind.Image, c.RequestAborted);
        p.DraftJson = JsonSerializer.Serialize(input, ApiJson.Options); p.Version++;
        await images.ReplaceReferencesAsync("ProjectDraft", id, input.CoverMediaId is { } media ? [(media, "Cover")] : [], c.RequestAborted);
        return new(ProjectView(p), ETag: Versions.Tag("project", id, p.Version), TargetId: id);
    }
    public async Task<MutationReply> ProjectStateAsync(Guid id, string action, HttpContext c)
    {
        var p = await ProjectAsync(id, c.RequestAborted); Versions.Require(c, Versions.Tag("project", id, p.Version));
        if (action == "publish" && !p.Trashed)
        {
            var input = JsonSerializer.Deserialize<ProjectInput>(p.DraftJson, ApiJson.Options)!;
            if (string.IsNullOrWhiteSpace(input.Title) || string.IsNullOrWhiteSpace(input.Body)) throw ArticleInput.Invalid("body", FieldIssue.Required);
            if (input.CoverMediaId is { } cover) _ = await images.ReadyAsync(cover, MediaKind.Image, c.RequestAborted);
            p.PublishedJson = p.DraftJson;
            await images.ReplaceReferencesAsync("ProjectPublished", id, input.CoverMediaId is { } media ? [(media, "Cover")] : [], c.RequestAborted);
        }
        else if (action == "withdraw" && p.PublishedJson is not null) { p.PublishedJson = null; await images.ReplaceReferencesAsync("ProjectPublished", id, [], c.RequestAborted); }
        else if (action == "trash" && !p.Trashed) p.Trashed = true;
        else if (action == "restore" && p.Trashed) { p.Trashed = false; p.PublishedJson = null; await images.ReplaceReferencesAsync("ProjectPublished", id, [], c.RequestAborted); }
        else throw new ApiFailure(ProblemCode.STATE_CONFLICT);
        p.Version++; return new(ProjectView(p), ETag: Versions.Tag("project", id, p.Version), TargetId: id);
    }
    public async Task<MutationReply> OrderProjectsAsync(OrderInput input, HttpContext c)
    {
        var site = await SiteAsync(c.RequestAborted); Versions.Require(c, SiteTag(site.Version)); var projects = await db.Set<ProjectEntry>().ToListAsync(c.RequestAborted);
        ExactOrder(input.Ids, projects.Select(x => x.Id));
        for (var i = 0; i < input.Ids.Length; i++) { var p = projects.Single(x => x.Id == input.Ids[i]); p.Position = i + 1; p.Version++; }
        site.Version++; return new(new { ids = input.Ids }, ETag: SiteTag(site.Version), TargetId: SiteOwnerId);
    }
    public async Task<MutationReply> SaveChapterAsync(Guid? id, ChapterInput input, HttpContext c)
    {
        var ct = c.RequestAborted; var chapter = id is { } key ? await db.Set<KnowledgeChapter>().SingleOrDefaultAsync(x => x.Id == key, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND) : new KnowledgeChapter { Position = (await db.Set<KnowledgeChapter>().MaxAsync(x => (int?)x.Position, ct) ?? 0) + 1 };
        if (id is not null) Versions.Require(c, Versions.Tag("chapter", chapter.Id, chapter.Version)); else db.Add(chapter);
        var ids = Unique(input.ArticleIds, 1000, "articleIds");
        if (await db.Set<Article>().CountAsync(x => ids.Contains(x.Id) && x.State != ArticleState.Purged, ct) != ids.Length) throw ArticleInput.Invalid("articleIds", FieldIssue.Unavailable);
        chapter.Title = Text(input.Title, 120, "title"); chapter.Version++;
        db.RemoveRange(await db.Set<KnowledgeEntry>().Where(x => x.ChapterId == chapter.Id).ToListAsync(ct)); await db.SaveChangesAsync(ct);
        db.AddRange(ids.Select((article, i) => new KnowledgeEntry { ChapterId = chapter.Id, ArticleId = article, Position = i + 1 }));
        return new(new { chapter.Id, chapter.Title, articleIds = ids, etag = Versions.Tag("chapter", chapter.Id, chapter.Version) }, id is null ? 201 : 200, Versions.Tag("chapter", chapter.Id, chapter.Version), chapter.Id);
    }
    public async Task<MutationReply> OrderChaptersAsync(OrderInput input, HttpContext c)
    {
        var site = await SiteAsync(c.RequestAborted); Versions.Require(c, SiteTag(site.Version)); var chapters = await db.Set<KnowledgeChapter>().ToListAsync(c.RequestAborted);
        ExactOrder(input.Ids, chapters.Select(x => x.Id));
        for (var i = 0; i < input.Ids.Length; i++) { var p = chapters.Single(x => x.Id == input.Ids[i]); p.Position = i + 1; p.Version++; }
        site.Version++; return new(new { ids = input.Ids }, ETag: SiteTag(site.Version), TargetId: SiteOwnerId);
    }
    private async Task<ColumnInput> ValidateColumnAsync(ColumnInput input, CancellationToken ct)
    {
        input = input with { Slug = ArticleInput.Slug(input.Slug), Name = Text(input.Name, ContentLimits.ColumnNameScalars, "name"), Introduction = Text(input.Introduction, 1200, "introduction"), ImageIds = Exact(input.ImageIds, 3, "imageIds") };
        if (string.IsNullOrWhiteSpace(input.Name)) throw ArticleInput.Invalid("name", FieldIssue.Required);
        if (string.IsNullOrWhiteSpace(input.Introduction)) throw ArticleInput.Invalid("introduction", FieldIssue.Required);
        foreach (var id in input.ImageIds) _ = await images.ReadyAsync(id, MediaKind.Image, ct);
        return input;
    }
    private static string Text(string? value, int limit, string field) => ArticleInput.Text(value, limit, field);
    private static string[] Strings(string[]? values, int count, int limit, string field)
    { if (values is null || values.Length > count) throw ArticleInput.Invalid(field); return values.Select(v => Text(v, limit, field)).ToArray(); }
    private static Guid[] Unique(Guid[]? ids, int maximum, string field)
    { if (ids is null || ids.Length > maximum || ids.Contains(Guid.Empty) || ids.Distinct().Count() != ids.Length) throw ArticleInput.Invalid(field); return ids; }
    private static Guid[] Exact(Guid[]? ids, int count, string field)
    { var value = Unique(ids, count, field); if (value.Length != count) throw ArticleInput.Invalid(field); return value; }
    private static void ExactOrder(Guid[]? ids, IEnumerable<Guid> current)
    { if (ids is null || ids.Distinct().Count() != ids.Length || !ids.ToHashSet().SetEquals(current)) throw ArticleInput.Invalid("ids"); }
}
