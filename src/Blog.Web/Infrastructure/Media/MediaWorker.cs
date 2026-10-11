using Blog.Web.Application.Media;
using System.Data;
namespace Blog.Web.Infrastructure.Media;

public sealed class MediaWorker(IServiceScopeFactory scopes, PrivateStorage files, ILogger<MediaWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await RunOneAsync(stoppingToken)) await Task.Delay(1000, stoppingToken);
                await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { logger.LogWarning("Media worker unavailable ({ExceptionType})", error.GetType().Name); await Task.Delay(3000, stoppingToken); }
        }
    }
    public async Task<bool> RunOneAsync(CancellationToken ct)
    {
        Guid id; string token; MediaKind kind; string mime;
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BlogDbContext>();
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct); await MutationCoordinator.LockAsync(db, ct);
            var now = DateTimeOffset.UtcNow;
            var a = await db.Set<MediaAsset>().Where(x => x.State == MediaState.Processing && (x.LeaseUntil == null || x.LeaseUntil < now)).OrderBy(x => x.CreatedAt).FirstOrDefaultAsync(ct);
            if (a is null) return false;
            if (a.Attempts > 2) { a.State = MediaState.Rejected; a.ErrorCode = "MEDIA_RETRY_EXHAUSTED"; a.Version++; await db.SaveChangesAsync(ct); await tx.CommitAsync(ct); return true; }
            id = a.Id; token = Guid.NewGuid().ToString("D"); kind = a.Kind; mime = a.MimeType;
            a.Attempts++; a.LeaseToken = token; a.LeaseUntil = now.AddMinutes(3); a.ErrorCode = null;
            await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
        }
        string? failure = null; bool transient = false; ProcessedMedia? result = null;
        var output = files.Attempt(id, token);
        try
        {
            using var scope = scopes.CreateScope();
            result = await scope.ServiceProvider.GetRequiredService<IMediaFileProcessor>().ProcessAsync(new(kind, mime, files.Input(id), output), ct);
            PrivateStorage.Restrict(output);
        }
        catch (MediaProcessingFailure e) { failure = e.Code; transient = e.Transient; }
        catch (IOException) { failure = "MEDIA_STORAGE_UNAVAILABLE"; transient = true; }
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BlogDbContext>();
            await using var tx = await db.Database.BeginTransactionAsync(ct); await MutationCoordinator.LockAsync(db, ct);
            var a = await db.Set<MediaAsset>().SingleAsync(x => x.Id == id, ct);
            if (a.State == MediaState.Processing && a.LeaseToken == token)
            {
                if (result is not null)
                {
                    File.Move(output, files.Final(id), overwrite: true); a.State = MediaState.Ready; a.StorageKey = id.ToString("N") + ".bin";
                    a.Sha256 = result.Sha256; a.ByteSize = result.ByteSize; a.Width = result.Width; a.Height = result.Height; a.DurationMs = result.DurationMs;
                }
                else { a.ErrorCode = failure; a.State = transient && a.Attempts <= 2 ? MediaState.Processing : MediaState.Rejected; }
                a.LeaseToken = null; a.LeaseUntil = a.State == MediaState.Processing ? DateTimeOffset.UtcNow.AddSeconds(5) : null; a.Version++;
                await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
            }
        }
        if (File.Exists(output)) File.Delete(output);
        return true;
    }
    private async Task SweepAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<BlogDbContext>();
        await using var tx = await db.Database.BeginTransactionAsync(ct); await MutationCoordinator.LockAsync(db, ct);
        var purged = await db.Set<MediaAsset>().Where(x => x.State == MediaState.Purged && x.DesignPath == null).Select(x => x.Id).ToArrayAsync(ct);
        foreach (var id in purged) foreach (var path in Directory.EnumerateFiles(files.MediaRoot, id.ToString("N") + ".*")) File.Delete(path);
        var older = DateTime.UtcNow.AddHours(-24);
        foreach (var path in Directory.EnumerateFiles(files.MediaRoot))
        {
            if (File.GetLastWriteTimeUtc(path) > older) continue;
            var first = Path.GetFileName(path).Split('.')[0];
            if (!Guid.TryParseExact(first, "N", out var id)) continue;
            var a = await db.Set<MediaAsset>().SingleOrDefaultAsync(x => x.Id == id, ct);
            var attemptFile = path.EndsWith(".processed", StringComparison.Ordinal) || path.EndsWith(".processed.stage", StringComparison.Ordinal);
            if (a is null || attemptFile && (a.LeaseUntil is null || a.LeaseUntil < DateTimeOffset.UtcNow)) File.Delete(path);
        }
        await tx.CommitAsync(ct);
    }
}
