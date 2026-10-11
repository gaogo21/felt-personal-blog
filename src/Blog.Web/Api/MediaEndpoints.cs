using Blog.Web.Application;
using Blog.Web.Infrastructure.Media;
namespace Blog.Web.Api;

public static class MediaEndpoints
{
    public static void MapMedia(this WebApplication app, string frontendRoot)
    {
        var group = app.MapGroup("/api/admin/v1/media").RequireAuthorization();
        group.MapGet("", async (BlogDbContext db, string? state, string? kind, string? q, int? page, CancellationToken ct) =>
        {
            var query = db.Set<MediaAsset>().AsQueryable();
            if (state is not null) { if (!Enum.TryParse<MediaState>(state, out var parsed) || !Enum.IsDefined(parsed)) throw new ApiFailure(422, "INVALID_STATE"); query = query.Where(x => x.State == parsed); }
            else query = query.Where(x => x.State != MediaState.Purged);
            if (kind is not null) { if (!Enum.TryParse<MediaKind>(kind, out var parsed) || !Enum.IsDefined(parsed)) throw new ApiFailure(422, "INVALID_KIND"); query = query.Where(x => x.Kind == parsed); }
            if (q is not null) { if (q.Length > 100) throw new ApiFailure(422, "INVALID_QUERY"); query = query.Where(x => x.Alt.Contains(q) || x.Credit.Contains(q)); }
            var current = page ?? 1; if (current < 1 || current > 1000000) throw new ApiFailure(422, "INVALID_PAGE");
            var total = await query.CountAsync(ct); var list = await query.OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Skip((current - 1) * 20).Take(20).ToListAsync(ct);
            return new { total, page = current, pageSize = 20, items = list.Select(ContentImages.View).ToArray() };
        });
        group.MapGet("/{id:guid}", async (Guid id, MediaService s, HttpContext c) => { var a = await s.RequireAsync(id, c.RequestAborted); c.Response.Headers.ETag = Versions.Tag("media", id, a.Version); return ContentImages.View(a); });
        group.MapGet("/{id:guid}/references", async (Guid id, BlogDbContext db, CancellationToken ct) => await db.Set<MediaReference>().Where(x => x.MediaId == id).Select(x => new { x.OwnerType, x.OwnerId, x.Usage }).ToArrayAsync(ct));
        group.MapPost("/uploads", async (HttpContext c, MediaService s) =>
        {
            if (!c.Request.HasFormContentType) throw new ApiFailure(415, "MULTIPART_REQUIRED");
            var form = await c.Request.ReadFormAsync(c.RequestAborted);
            if (form.Files.Count != 1 || form.Files[0].Name != "file" || form["sha256"].Count != 1) throw new ApiFailure(422, "UPLOAD_MANIFEST_REQUIRED");
            return MutationCoordinator.Result(c, await s.UploadAsync(form.Files[0], form["sha256"].ToString(), c));
        }).DisableAntiforgery(); // Our cookie/Origin/CSRF boundary validates before multipart parsing.
        group.MapPatch("/{id:guid}", async (Guid id, MediaMetadataInput input, MediaService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "media.metadata:" + id, input, false, () => s.MetadataAsync(id, input, c))));
        foreach (var action in new[] { "trash", "restore", "retry" })
        {
            var captured = action;
            group.MapPost("/{id:guid}/" + captured, async (Guid id, MediaService s, MutationCoordinator m, HttpContext c) =>
                MutationCoordinator.Result(c, await m.ExecuteAsync(c, "media." + captured + ":" + id, null, true, () => s.LifecycleAsync(id, captured, c, null))));
        }
        group.MapPost("/{id:guid}/purge", async (Guid id, MediaPurgeInput input, MediaService s, MutationCoordinator m, HttpContext c) =>
            MutationCoordinator.Result(c, await m.ExecuteAsync(c, "media.purge:" + id, input, true, () => s.LifecycleAsync(id, "purge", c, input))));
        app.MapMethods("/media/{id:guid}", ["GET", "HEAD"], async (Guid id, MediaService service, PrivateStorage storage, HttpContext c) =>
        {
            var a = await service.RequireAsync(id, c.RequestAborted);
            if (a.State != MediaState.Ready || c.User.Identity?.IsAuthenticated != true && !await service.PubliclyReferencedAsync(id, c.RequestAborted)) return Results.NotFound();
            var path = a.DesignPath is null ? storage.Final(a.Id) : Path.Combine(frontendRoot, a.DesignPath.TrimStart('/'));
            if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return Results.NotFound();
            c.Response.Headers.CacheControl = "private, no-store"; c.Response.Headers["X-Content-Type-Options"] = "nosniff";
            return Results.File(path, a.MimeType, enableRangeProcessing: true);
        });
    }
}
