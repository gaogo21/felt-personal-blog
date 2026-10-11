using System.Data;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
namespace Blog.Web.Infrastructure.Persistence;

public sealed record MutationReply(object? Value, int Status = 200, string? ETag = null, Guid? TargetId = null);
public sealed class MutationCoordinator(BlogDbContext db)
{
    // One global content writer lock also coordinates workers and backup capture across instances.
    public const long ContentLock = 0x46656c74426c6f67;
    public async Task<MutationReply> ExecuteAsync(HttpContext context, string action, object? input,
        bool requireKey, Func<Task<MutationReply>> operation)
    {
        Guid? key = null;
        if (requireKey)
        {
            var header = context.Request.Headers["Idempotency-Key"];
            if (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var parsed) || parsed == Guid.Empty)
                throw new ApiFailure(422, "IDEMPOTENCY_KEY_REQUIRED");
            key = parsed;
        }
        var actor = Guid.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var requestHash = Hash(input);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, context.RequestAborted);
        await LockAsync(db, context.RequestAborted);
        var now = DateTimeOffset.UtcNow;
        await db.Set<IdempotencyRecord>().Where(x => x.ExpiresAt <= now).ExecuteDeleteAsync(context.RequestAborted);
        if (key is { } id)
        {
            var previous = await db.Set<IdempotencyRecord>().SingleOrDefaultAsync(x => x.UserId == actor && x.Scope == action && x.Key == id, context.RequestAborted);
            if (previous is not null)
            {
                if (previous.RequestHash != requestHash) throw new ApiFailure(ProblemCode.IDEMPOTENCY_CONFLICT);
                return new(JsonSerializer.Deserialize<JsonElement>(previous.Json), previous.Status, previous.ETag, previous.TargetId);
            }
        }
        var reply = await operation();
        db.Add(new AuditEvent { UserId = actor, Action = action, TargetId = reply.TargetId });
        if (key is { } current) db.Add(new IdempotencyRecord
        {
            UserId = actor,
            Scope = action,
            Key = current,
            TargetId = reply.TargetId,
            RequestHash = requestHash,
            Status = reply.Status,
            Json = JsonSerializer.Serialize(reply.Value, ApiJson.Options),
            ETag = reply.ETag,
            ExpiresAt = now.AddHours(24)
        });
        await db.SaveChangesAsync(context.RequestAborted);
        await transaction.CommitAsync(context.RequestAborted);
        return reply;
    }
    public static Task LockAsync(BlogDbContext db, CancellationToken ct) => db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock({ContentLock})", ct);
    public async Task InvalidateReceiptsAsync(Guid id, CancellationToken ct)
    {
        foreach (var receipt in await db.Set<IdempotencyRecord>().Where(x => x.TargetId == id).ToListAsync(ct))
        { receipt.Status = 410; receipt.Json = "{\"code\":\"RESOURCE_PURGED\"}"; receipt.ETag = null; }
    }
    public static IResult Result(HttpContext context, MutationReply reply)
    {
        if (reply.ETag is not null) context.Response.Headers.ETag = reply.ETag;
        return Results.Json(reply.Value, ApiJson.Options, statusCode: reply.Status);
    }
    private static string Hash(object? input)
    {
        static JsonNode? Canonical(JsonNode? node) => node switch
        {
            JsonObject obj => new JsonObject(obj.OrderBy(x => x.Key, StringComparer.Ordinal).Select(x => new KeyValuePair<string, JsonNode?>(x.Key, Canonical(x.Value)))),
            JsonArray array => new JsonArray(array.Select(Canonical).ToArray()),
            _ => node?.DeepClone()
        };
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(JsonSerializer.SerializeToNode(input, ApiJson.Options))?.ToJsonString() ?? "null")));
    }
}
