using System.Security.Cryptography;
using Blog.Web.Application;
using Blog.Web.Application.Articles;
using Blog.Web.Domain;
using Blog.Web.Infrastructure.Security;
namespace Blog.Web.Infrastructure.Media;

public sealed record MediaMetadataInput(string Alt, string Caption, string Credit, string SourceUrl, string LicenseName, string LicenseUrl);
public sealed record MediaPurgeInput(string ConfirmId);
public sealed class MediaService(BlogDbContext db, PrivateStorage storage, MutationCoordinator mutations, AdminSecurity security)
{
    public async Task<MutationReply> UploadAsync(IFormFile file, string sha256, HttpContext c)
    {
        var ct = c.RequestAborted;
        var filename = file.FileName;
        if (filename.Length is < 1 or > 255 || filename != Path.GetFileName(filename) || filename.Contains('\\') || filename.Any(char.IsControl)) throw ArticleInput.Invalid("file");
        var mime = Path.GetExtension(filename).ToLowerInvariant() switch { ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", ".mp4" => "video/mp4", _ => throw new ApiFailure(ProblemCode.MEDIA_TYPE_UNSUPPORTED) };
        if (file.ContentType != mime) throw new ApiFailure(ProblemCode.MEDIA_TYPE_UNSUPPORTED);
        var kind = mime == "video/mp4" ? MediaKind.Video : MediaKind.Image;
        if (file.Length <= 0 || file.Length > (kind == MediaKind.Image ? ContentLimits.ImageBytes : ContentLimits.VideoBytes)) throw new ApiFailure(ProblemCode.FILE_TOO_LARGE);
        if (!System.Text.RegularExpressions.Regex.IsMatch(sha256, "\\A[a-f0-9]{64}\\z")) throw ArticleInput.Invalid("sha256");
        return await mutations.ExecuteAsync(c, "media.upload", new { mime, file.Length, sha256 }, true, async () =>
        {
            if (await db.Set<MediaAsset>().CountAsync(x => x.State == MediaState.Uploading || x.State == MediaState.Processing, ct) >= ContentLimits.PendingJobs) throw new ApiFailure(429, "MEDIA_QUEUE_FULL");
            var asset = new MediaAsset { Kind = kind, MimeType = mime, ByteSize = file.Length, Sha256 = sha256, State = MediaState.Uploading, Alt = "" };
            var path = storage.Input(asset.Id);
            try
            {
                await using (var target = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
                { await file.CopyToAsync(target, ct); await target.FlushAsync(ct); }
                PrivateStorage.Restrict(path);
                await using var input = File.OpenRead(path);
                if (input.Length != file.Length || Convert.ToHexStringLower(await SHA256.HashDataAsync(input, ct)) != sha256) throw new ApiFailure(422, "UPLOAD_HASH_MISMATCH");
                asset.State = MediaState.Processing; db.Add(asset);
                return new(ContentImages.View(asset), 202, Versions.Tag("media", asset.Id, asset.Version), asset.Id);
            }
            catch { if (File.Exists(path)) File.Delete(path); throw; }
        });
    }
    public async Task<MediaAsset> RequireAsync(Guid id, CancellationToken ct) => await db.Set<MediaAsset>().SingleOrDefaultAsync(x => x.Id == id, ct) ?? throw new ApiFailure(ProblemCode.NOT_FOUND);
    public async Task<MutationReply> MetadataAsync(Guid id, MediaMetadataInput input, HttpContext c)
    {
        var a = await RequireAsync(id, c.RequestAborted); Versions.Require(c, Versions.Tag("media", id, a.Version));
        if (a.State != MediaState.Ready) throw new ApiFailure(ProblemCode.STATE_CONFLICT);
        a.Alt = ArticleInput.Text(input.Alt, 200, "alt"); a.Caption = ArticleInput.Text(input.Caption, 240, "caption"); a.Credit = ArticleInput.Text(input.Credit, 160, "credit");
        a.SourceUrl = Url(input.SourceUrl); a.LicenseName = ArticleInput.Text(input.LicenseName, 120, "licenseName"); a.LicenseUrl = Url(input.LicenseUrl); a.Version++;
        return new(ContentImages.View(a), ETag: Versions.Tag("media", id, a.Version), TargetId: id);
    }
    public async Task<MutationReply> LifecycleAsync(Guid id, string action, HttpContext c, MediaPurgeInput? input)
    {
        var ct = c.RequestAborted; var a = await RequireAsync(id, ct); Versions.Require(c, Versions.Tag("media", id, a.Version));
        if (a.DesignPath is not null) throw new ApiFailure(409, "DESIGN_ASSET_IMMUTABLE");
        if (action == "retry" && a.State == MediaState.Rejected)
        { a.State = MediaState.Processing; a.Attempts = 0; a.ErrorCode = null; a.LeaseToken = null; a.LeaseUntil = null; }
        else if (action == "restore" && a.State == MediaState.Trashed)
            a.State = File.Exists(storage.Final(id)) && a.ErrorCode is null ? MediaState.Ready : MediaState.Rejected;
        else if (action == "trash" && a.State is MediaState.Ready or MediaState.Rejected)
        {
            if (await db.Set<MediaReference>().AnyAsync(x => x.MediaId == id, ct)) throw new ApiFailure(409, "MEDIA_REFERENCED");
            a.State = MediaState.Trashed;
        }
        else if (action == "purge" && a.State == MediaState.Trashed)
        {
            await security.RequireRecentAsync(c);
            if (input?.ConfirmId != id.ToString("D")) throw ArticleInput.Invalid("confirmId");
            if (await db.Set<MediaReference>().AnyAsync(x => x.MediaId == id, ct)) throw new ApiFailure(409, "MEDIA_REFERENCED");
            // Mark delivery unavailable transactionally; the persistent sweep owns physical deletion.
            a.State = MediaState.Purged; a.StorageKey = ""; a.Alt = ""; a.Caption = ""; a.Credit = ""; a.SourceUrl = ""; a.LicenseName = ""; a.LicenseUrl = "";
            await mutations.InvalidateReceiptsAsync(id, ct);
        }
        else throw new ApiFailure(ProblemCode.STATE_CONFLICT);
        a.Version++; return new(ContentImages.View(a), ETag: Versions.Tag("media", id, a.Version), TargetId: id);
    }
    public async Task<bool> PubliclyReferencedAsync(Guid id, CancellationToken ct)
    {
        var references = await db.Set<MediaReference>().Where(x => x.MediaId == id).ToListAsync(ct);
        foreach (var r in references)
        {
            if (r.OwnerType == "Gallery") return true;
            if (r.OwnerType == "Column" && await db.Set<Column>().AnyAsync(x => x.Id == r.OwnerId && x.State == ColumnState.Active, ct)) return true;
            if (r.OwnerType == "Revision" && await db.Set<Article>().AnyAsync(x => x.State == ArticleState.Published && x.PublishedRevisionId == r.OwnerId, ct)) return true;
            if (r.OwnerType == "ProjectPublished" && await db.Set<ProjectEntry>().AnyAsync(x => x.Id == r.OwnerId && !x.Trashed && x.PublishedJson != null, ct)) return true;
        }
        return false;
    }
    private static string Url(string? value)
    {
        value = ArticleInput.Text(value, 2048, "url");
        if (value.Length > 0 && (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo.Length > 0 || value.Any(char.IsControl))) throw ArticleInput.Invalid("url");
        return value;
    }
}
