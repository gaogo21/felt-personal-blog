using Blog.Web.Application.RichText;
using Blog.Web.Infrastructure.Security;
using Blog.Web.Domain;
namespace Blog.Web.Application.Articles;

public sealed record CreateArticleInput(string Title, string Slug, string Kind = "Article");
public sealed record DraftInput(string Title, string Summary, string Intro, Guid? ColumnId, Guid? CoverMediaId, JsonElement ContentJson, int SchemaVersion = 1);
public sealed record PublishInput(string DraftEtag);
public sealed record IdentityInput(string Slug, string Kind);
public sealed record PurgeInput(string ConfirmSlug);
public sealed class ArticleService(BlogDbContext db, RichTextSchema schema, ContentImages images, MutationCoordinator mutations, AdminSecurity security)
{
    public async Task<Article> RequireAsync(Guid id, CancellationToken ct) => await db.Set<Article>().SingleOrDefaultAsync(x => x.Id == id, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
    public async Task<object> AdminViewAsync(Article article, CancellationToken ct)
    {
        var draft = await db.Set<ArticleDraft>().SingleOrDefaultAsync(x => x.ArticleId == article.Id, ct);
        return new
        {
            article.Id,
            article.Slug,
            article.Kind,
            article.State,
            article.IsDemo,
            article.Version,
            etag = Versions.Tag("article", article.Id, article.Version),
            article.CreatedAt,
            article.FirstPublishedAt,
            article.LastPublishedAt,
            article.PurgedAt,
            draft = draft is null ? null : DraftView(draft),
            article.PublishedRevisionId
        };
    }
    public static object DraftView(ArticleDraft draft) => new
    {
        draft.Title,
        draft.Summary,
        draft.Intro,
        draft.ColumnId,
        draft.CoverMediaId,
        contentJson = JsonSerializer.Deserialize<JsonElement>(draft.ContentJson),
        schemaVersion = 1,
        draft.Version,
        etag = Versions.Tag("draft", draft.ArticleId, draft.Version),
        draft.UpdatedAt
    };
    public async Task<MutationReply> CreateAsync(CreateArticleInput input, CancellationToken ct)
    {
        var title = ArticleInput.Text(input.Title, ContentLimits.TitleScalars, "title"); var slug = ArticleInput.Slug(input.Slug);
        if (input.Kind is not ("Article" or "Life")) throw ArticleInput.Invalid("kind");
        if (await db.Set<Article>().AnyAsync(x => x.Slug == slug, ct)) throw new ApiFailure(ProblemCode.DUPLICATE_SLUG);
        var article = new Article { Slug = slug, Kind = input.Kind }; db.Add(article);
        db.Add(new ArticleDraft { ArticleId = article.Id, Title = title }); await db.SaveChangesAsync(ct);
        return new(await AdminViewAsync(article, ct), 201, Versions.Tag("article", article.Id, article.Version), article.Id);
    }
    public async Task<MutationReply> SaveAsync(Guid id, DraftInput input, HttpContext context)
    {
        var ct = context.RequestAborted; var article = await RequireAsync(id, ct); Editable(article);
        var draft = await db.Set<ArticleDraft>().SingleAsync(x => x.ArticleId == id, ct);
        Versions.Require(context, Versions.Tag("draft", id, draft.Version));
        var document = schema.Validate(input.ContentJson, input.SchemaVersion);
        await document.CheckMediaAsync(async (mediaId, token) => await db.Set<MediaAsset>().SingleOrDefaultAsync(x => x.Id == mediaId, token), ct);
        if (input.ColumnId is { } column && !await db.Set<Column>().AnyAsync(x => x.Id == column && x.State != ColumnState.Archived, ct)) throw ArticleInput.Invalid("columnId", FieldIssue.Unavailable);
        if (input.CoverMediaId is { } cover) _ = await images.ReadyAsync(cover, MediaKind.Image, ct);
        draft.Title = ArticleInput.Text(input.Title, ContentLimits.TitleScalars, "title");
        draft.Summary = ArticleInput.Text(input.Summary, ContentLimits.SummaryScalars, "summary");
        draft.Intro = ArticleInput.Text(input.Intro, 1200, "intro");
        draft.ColumnId = input.ColumnId; draft.CoverMediaId = input.CoverMediaId; draft.ContentJson = document.Json; draft.Version++; draft.UpdatedAt = DateTimeOffset.UtcNow;
        await images.ReplaceReferencesAsync("Draft", id, References(document, input.CoverMediaId), ct);
        return new(DraftView(draft), ETag: Versions.Tag("draft", id, draft.Version), TargetId: id);
    }
    public async Task<MutationReply> IdentityAsync(Guid id, IdentityInput input, HttpContext c)
    {
        var article = await RequireAsync(id, c.RequestAborted); Editable(article); Versions.Require(c, Versions.Tag("article", id, article.Version));
        if (article.FirstPublishedAt is not null) throw new ApiFailure(ProblemCode.STATE_CONFLICT);
        var slug = ArticleInput.Slug(input.Slug);
        if (input.Kind is not ("Article" or "Life")) throw ArticleInput.Invalid("kind");
        if (await db.Set<Article>().AnyAsync(x => x.Id != id && x.Slug == slug, c.RequestAborted)) throw new ApiFailure(ProblemCode.DUPLICATE_SLUG);
        article.Slug = slug; article.Kind = input.Kind; article.Version++;
        return new(await AdminViewAsync(article, c.RequestAborted), ETag: Versions.Tag("article", id, article.Version), TargetId: id);
    }
    public async Task<MutationReply> PublishAsync(Guid id, PublishInput input, HttpContext c)
    {
        var ct = c.RequestAborted; var article = await RequireAsync(id, ct); Editable(article); Versions.Require(c, Versions.Tag("article", id, article.Version));
        var draft = await db.Set<ArticleDraft>().SingleAsync(x => x.ArticleId == id, ct);
        if (input.DraftEtag != Versions.Tag("draft", id, draft.Version)) throw new ApiFailure(ProblemCode.PRECONDITION_FAILED);
        if (string.IsNullOrWhiteSpace(draft.Title)) throw ArticleInput.Invalid("title", FieldIssue.Required);
        if (draft.ColumnId is not { } columnId || !await db.Set<Column>().AnyAsync(x => x.Id == columnId && x.State == ColumnState.Active, ct)) throw ArticleInput.Invalid("columnId", FieldIssue.Unavailable);
        var body = schema.Validate(JsonSerializer.Deserialize<JsonElement>(draft.ContentJson), 1);
        (await body.CheckMediaAsync(async (mediaId, token) => await db.Set<MediaAsset>().SingleOrDefaultAsync(x => x.Id == mediaId, token), ct)).RequireNonempty();
        if (draft.CoverMediaId is { } cover) _ = await images.ReadyAsync(cover, MediaKind.Image, ct);
        var revision = new ArticleRevision
        {
            ArticleId = id,
            Number = (await db.Set<ArticleRevision>().Where(x => x.ArticleId == id).MaxAsync(x => (int?)x.Number, ct) ?? 0) + 1,
            Title = draft.Title,
            Summary = draft.Summary,
            Intro = draft.Intro,
            ColumnId = columnId,
            CoverMediaId = draft.CoverMediaId,
            ContentJson = body.Json
        };
        db.Add(revision);
        article.PublishedRevisionId = revision.Id; article.State = ArticleState.Published; article.Version++;
        article.FirstPublishedAt ??= revision.CreatedAt; article.LastPublishedAt = revision.CreatedAt; draft.Version++;
        var order = await db.Set<ColumnArticleOrder>().SingleOrDefaultAsync(x => x.ArticleId == id, ct);
        if (order is null) db.Add(new ColumnArticleOrder { ArticleId = id, ColumnId = columnId, Position = await NextPositionAsync(columnId, ct) });
        else if (order.ColumnId != columnId) { order.ColumnId = columnId; order.Position = await NextPositionAsync(columnId, ct); }
        await images.ReplaceReferencesAsync("Revision", revision.Id, References(body, draft.CoverMediaId), ct);
        return new(await AdminViewAsync(article, ct), ETag: Versions.Tag("article", id, article.Version), TargetId: id);
    }
    public async Task<MutationReply> LifecycleAsync(Guid id, string action, HttpContext c, PurgeInput? purge = null)
    {
        var ct = c.RequestAborted; var article = await RequireAsync(id, ct); Versions.Require(c, Versions.Tag("article", id, article.Version));
        switch (action)
        {
            case "withdraw" when article.State == ArticleState.Published: article.State = ArticleState.Withdrawn; break;
            case "trash" when article.State is ArticleState.Draft or ArticleState.Published or ArticleState.Withdrawn: article.State = ArticleState.Trashed; break;
            case "restore" when article.State == ArticleState.Trashed: article.State = article.FirstPublishedAt is null ? ArticleState.Draft : ArticleState.Withdrawn; break;
            case "purge" when article.State == ArticleState.Trashed:
                await security.RequireRecentAsync(c);
                if (purge?.ConfirmSlug != article.Slug) throw ArticleInput.Invalid("confirmSlug");
                var revisions = await db.Set<ArticleRevision>().Where(x => x.ArticleId == id).Select(x => x.Id).ToArrayAsync(ct);
                db.RemoveRange(await db.Set<MediaReference>().Where(x => x.OwnerType == "Draft" && x.OwnerId == id || x.OwnerType == "Revision" && revisions.Contains(x.OwnerId)).ToListAsync(ct));
                db.RemoveRange(await db.Set<ArticleRevision>().Where(x => x.ArticleId == id).ToListAsync(ct));
                db.RemoveRange(await db.Set<ArticleDraft>().Where(x => x.ArticleId == id).ToListAsync(ct));
                db.RemoveRange(await db.Set<KnowledgeEntry>().Where(x => x.ArticleId == id).ToListAsync(ct));
                db.RemoveRange(await db.Set<ColumnArticleOrder>().Where(x => x.ArticleId == id).ToListAsync(ct));
                article.PublishedRevisionId = null; article.State = ArticleState.Purged; article.PurgedAt = DateTimeOffset.UtcNow;
                await mutations.InvalidateReceiptsAsync(id, ct); break;
            default: throw new ApiFailure(ProblemCode.STATE_CONFLICT);
        }
        article.Version++; await db.SaveChangesAsync(ct);
        return new(await AdminViewAsync(article, ct), ETag: Versions.Tag("article", id, article.Version), TargetId: id);
    }
    public async Task<MutationReply> RestoreRevisionAsync(Guid id, Guid revisionId, HttpContext c)
    {
        var ct = c.RequestAborted; var article = await RequireAsync(id, ct); Editable(article);
        var draft = await db.Set<ArticleDraft>().SingleAsync(x => x.ArticleId == id, ct); Versions.Require(c, Versions.Tag("draft", id, draft.Version));
        var revision = await db.Set<ArticleRevision>().SingleOrDefaultAsync(x => x.Id == revisionId && x.ArticleId == id, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
        var body = schema.Validate(JsonSerializer.Deserialize<JsonElement>(revision.ContentJson), 1);
        draft.Title = revision.Title; draft.Summary = revision.Summary; draft.Intro = revision.Intro; draft.ColumnId = revision.ColumnId; draft.CoverMediaId = revision.CoverMediaId; draft.ContentJson = revision.ContentJson; draft.Version++;
        await images.ReplaceReferencesAsync("Draft", id, References(body, draft.CoverMediaId), ct);
        return new(DraftView(draft), ETag: Versions.Tag("draft", id, draft.Version), TargetId: id);
    }
    public async Task<object> PreviewAsync(Guid id, CancellationToken ct)
    {
        var article = await RequireAsync(id, ct); Editable(article);
        var draft = await db.Set<ArticleDraft>().SingleAsync(x => x.ArticleId == id, ct);
        var body = schema.Validate(JsonSerializer.Deserialize<JsonElement>(draft.ContentJson), 1);
        var media = await images.ResolveAsync(body.References.Select(x => x.MediaId), ct);
        return new { draft.Title, draft.Summary, draft.Intro, html = body.WithAvailablePreviewMedia(media).Html.ToString(), toc = body.Toc };
    }
    private async Task<int> NextPositionAsync(Guid columnId, CancellationToken ct) =>
        (await db.Set<ColumnArticleOrder>().Where(x => x.ColumnId == columnId).MaxAsync(x => (int?)x.Position, ct) ?? 0) + 1;
    private static void Editable(Article a) { if (a.State is ArticleState.Trashed or ArticleState.Purged) throw new ApiFailure(ProblemCode.STATE_CONFLICT); }
    private static IEnumerable<(Guid Id, string Usage)> References(RichTextDocument body, Guid? cover) => body.References.Select(x => (x.MediaId, x.Usage.ToString())).Concat(cover is { } id ? [(id, "Cover")] : []);
}
