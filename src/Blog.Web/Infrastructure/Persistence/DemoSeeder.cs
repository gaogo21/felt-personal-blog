using Blog.Web.Application;
using Blog.Web.Application.RichText;
namespace Blog.Web.Infrastructure.Persistence;

public sealed class DemoSeeder(BlogDbContext db, RichTextSchema schema, ContentImages images, IWebHostEnvironment env)
{
    public static SiteInput EmptySite => new("", "关于", "", "", [], [], []);
    public async Task InitializeSiteAsync(CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct); await MutationCoordinator.LockAsync(db, ct);
        if (!await db.Set<SiteSettings>().AnyAsync(ct)) { db.Add(new SiteSettings { Json = JsonSerializer.Serialize(EmptySite, ApiJson.Options) }); await db.SaveChangesAsync(ct); }
        await tx.CommitAsync(ct);
    }
    public async Task SeedAsync(CancellationToken ct)
    {
        var path = Path.Combine(env.ContentRootPath, "demo-content.json");
        if (!File.Exists(path)) path = Path.GetFullPath(Path.Combine(env.ContentRootPath, "../../data/demo-content.json"));
        using var json = JsonDocument.Parse(await File.ReadAllTextAsync(path, ct)); var root = json.RootElement;
        await using var tx = await db.Database.BeginTransactionAsync(ct); await MutationCoordinator.LockAsync(db, ct);
        var site = await db.Set<SiteSettings>().SingleAsync(x => x.Id == 1, ct);
        if (site.DemoSeeded) return;
        if (await db.Set<Article>().AnyAsync(ct) || await db.Set<Column>().AnyAsync(ct) || await db.Set<ProjectEntry>().AnyAsync(ct)) throw new InvalidOperationException("Demo seed only accepts an empty content database.");
        foreach (var value in root.GetProperty("media").EnumerateArray())
        {
            var asset = value.Deserialize<MediaAsset>(ApiJson.Options)!; asset.State = MediaState.Ready; db.Add(asset);
        }
        foreach (var value in root.GetProperty("columns").EnumerateArray())
        {
            var column = new Column
            {
                Id = value.GetProperty("id").GetGuid(),
                Slug = value.GetProperty("id").GetString()!,
                Name = value.GetProperty("name").GetString()!,
                Introduction = value.GetProperty("intro").GetString()!,
                Position = value.GetProperty("order").GetInt32(),
                State = ColumnState.Active,
                ImageIdsJson = value.GetProperty("imageIds").GetRawText()
            };
            // The extracted seed keeps the original frontend slug separately from the UUID.
            column.Slug = value.GetProperty("slug").GetString()!; db.Add(column);
        }
        await db.SaveChangesAsync(ct);
        foreach (var column in await db.Set<Column>().ToListAsync(ct)) await images.ReplaceReferencesAsync("Column", column.Id, JsonSerializer.Deserialize<Guid[]>(column.ImageIdsJson)!.Select(id => (id, "ColumnImage")), ct);
        foreach (var value in root.GetProperty("articles").EnumerateArray())
        {
            var id = value.GetProperty("id").GetGuid(); var body = schema.Validate(value.GetProperty("content"), 1);
            var column = await db.Set<Column>().SingleAsync(x => x.Slug == value.GetProperty("columnSlug").GetString(), ct);
            var article = new Article
            {
                Id = id,
                Slug = value.GetProperty("slug").GetString()!,
                Kind = value.GetProperty("kind").GetString()!,
                State = ArticleState.Published,
                IsDemo = true,
                FirstPublishedAt = DateTimeOffset.UtcNow,
                LastPublishedAt = DateTimeOffset.UtcNow
            };
            var draft = new ArticleDraft
            {
                ArticleId = id,
                Title = value.GetProperty("title").GetString()!,
                Summary = value.GetProperty("summary").GetString()!,
                Intro = value.GetProperty("intro").GetString()!,
                ColumnId = column.Id,
                CoverMediaId = value.GetProperty("coverMediaId").GetGuid(),
                ContentJson = body.Json
            };
            var revision = new ArticleRevision { ArticleId = id, Number = 1, Title = draft.Title, Summary = draft.Summary, Intro = draft.Intro, ColumnId = column.Id, CoverMediaId = draft.CoverMediaId, ContentJson = body.Json };
            article.PublishedRevisionId = revision.Id; db.Add(article); db.Add(draft); db.Add(revision);
            db.Add(new ColumnArticleOrder { ArticleId = id, ColumnId = column.Id, Position = await db.Set<ColumnArticleOrder>().CountAsync(x => x.ColumnId == column.Id, ct) + 1 });
            var refs = body.References.Select(x => (x.MediaId, x.Usage.ToString())).Concat([(draft.CoverMediaId!.Value, "Cover")]);
            await images.ReplaceReferencesAsync("Draft", id, refs, ct); await images.ReplaceReferencesAsync("Revision", revision.Id, refs, ct);
        }
        foreach (var value in root.GetProperty("projects").EnumerateArray())
        {
            var input = new ProjectInput(value.GetProperty("title").GetString()!, value.GetProperty("type").GetString()!, value.GetProperty("desc").GetString()!, value.GetProperty("tags").Deserialize<string[]>()!, value.GetProperty("body").GetString()!,
                value.GetProperty("details").Deserialize<string[]>()!, value.GetProperty("note").GetString()!, value.GetProperty("coverMediaId").GetGuid());
            var p = new ProjectEntry { Id = value.GetProperty("id").GetGuid(), Slug = value.GetProperty("slug").GetString()!, Position = value.GetProperty("position").GetInt32(), IsDemo = true, DraftJson = JsonSerializer.Serialize(input, ApiJson.Options) }; p.PublishedJson = p.DraftJson; db.Add(p);
            await images.ReplaceReferencesAsync("ProjectDraft", p.Id, [(input.CoverMediaId!.Value, "Cover")], ct); await images.ReplaceReferencesAsync("ProjectPublished", p.Id, [(input.CoverMediaId!.Value, "Cover")], ct);
        }
        foreach (var value in root.GetProperty("chapters").EnumerateArray())
        {
            var parts = value.EnumerateArray().ToArray(); var chapter = new KnowledgeChapter { Title = parts[1].GetString()!, Position = int.Parse(parts[0].GetString()!) }; db.Add(chapter);
            var i = 0; foreach (var entry in parts[2].EnumerateArray())
            { var slug = entry[0].GetString(); var article = await db.Set<Article>().SingleAsync(x => x.Slug == slug, ct); db.Add(new KnowledgeEntry { ChapterId = chapter.Id, ArticleId = article.Id, Position = ++i }); }
        }
        site.Json = root.GetProperty("settings").GetRawText(); site.DemoSeeded = true; site.Version++;
        var settings = ManagementService.SiteValue(site); await images.ReplaceReferencesAsync("Gallery", ManagementService.SiteOwnerId, settings.GalleryIds.Select(id => (id, "Gallery")), ct);
        await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
    }
}
