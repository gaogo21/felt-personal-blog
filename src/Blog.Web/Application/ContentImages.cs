using Blog.Web.Application.Articles;
namespace Blog.Web.Application;

public sealed class ContentImages(BlogDbContext db)
{
    public async Task<MediaAsset> ReadyAsync(Guid id, MediaKind? kind, CancellationToken ct)
    {
        var asset = await db.Set<MediaAsset>().SingleOrDefaultAsync(x => x.Id == id, ct);
        if (asset is null || asset.State != MediaState.Ready || kind is not null && asset.Kind != kind) throw ArticleInput.Invalid("mediaId", FieldIssue.Unavailable);
        return asset;
    }
    public async Task ReplaceReferencesAsync(string ownerType, Guid ownerId, IEnumerable<(Guid Id, string Usage)> ids, CancellationToken ct)
    {
        var wanted = ids.Distinct().ToArray();
        foreach (var id in wanted.Select(x => x.Id).Distinct()) _ = await ReadyAsync(id, null, ct);
        var previous = await db.Set<MediaReference>().Where(x => x.OwnerType == ownerType && x.OwnerId == ownerId).ToListAsync(ct);
        db.RemoveRange(previous);
        // Flush deletion under the content transaction before replacing a unique reference.
        await db.SaveChangesAsync(ct);
        db.AddRange(wanted.Select(x => new MediaReference { MediaId = x.Id, OwnerType = ownerType, OwnerId = ownerId, Usage = x.Usage }));
    }
    public async Task<IReadOnlyDictionary<Guid, MediaAsset>> ResolveAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var list = ids.Distinct().ToArray();
        return await db.Set<MediaAsset>().Where(x => list.Contains(x.Id)).ToDictionaryAsync(x => x.Id, ct);
    }
    public static object View(MediaAsset a) => new
    {
        a.Id,
        a.Kind,
        a.State,
        a.Version,
        etag = Versions.Tag("media", a.Id, a.Version),
        src = a.DesignPath ?? $"/media/{a.Id:D}",
        a.Width,
        a.Height,
        a.DurationMs,
        a.MimeType,
        a.ByteSize,
        a.Alt,
        a.Caption,
        title = a.Caption,
        author = a.Credit,
        provider = a.SourceUrl.Contains("unsplash", StringComparison.OrdinalIgnoreCase) ? "Unsplash" : "",
        source = a.SourceUrl,
        credit = a.Credit,
        a.LicenseName,
        a.LicenseUrl,
        a.ErrorCode,
        a.CreatedAt
    };
}
