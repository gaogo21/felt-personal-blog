namespace Blog.Web.Domain.Persistence;

public enum ArticleState { Draft, Published, Withdrawn, Trashed, Purged }
public enum ColumnState { Draft, Active, Archived }
public enum MediaState { Uploading, Processing, Ready, Rejected, Trashed, Purged }
public enum MediaKind { Image, Video }
public enum MediaUsage { BodyImage, Video, Poster, Cover, ColumnImage, Gallery }

public sealed class AdminUser
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string UserName { get; set; } = "";
    public string NormalizedName { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public string SecurityStamp { get; set; } = Guid.NewGuid().ToString("N");
    public int FailedAttempts { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }
}
public sealed class AdminSession
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public string SecurityStamp { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
    public DateTimeOffset AbsoluteExpiresAt { get; set; }
    public DateTimeOffset? ReauthenticatedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}
public sealed class Article
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Slug { get; set; } = "";
    public string Kind { get; set; } = "Article";
    public ArticleState State { get; set; }
    public bool IsDemo { get; set; }
    public long Version { get; set; } = 1;
    public Guid? PublishedRevisionId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? FirstPublishedAt { get; set; }
    public DateTimeOffset? LastPublishedAt { get; set; }
    public DateTimeOffset? PurgedAt { get; set; }
}
public sealed class ArticleDraft
{
    public Guid ArticleId { get; set; }
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public string Intro { get; set; } = "";
    public Guid? ColumnId { get; set; }
    public Guid? CoverMediaId { get; set; }
    public string ContentJson { get; set; } = "{\"type\":\"doc\",\"content\":[]}";
    public long Version { get; set; } = 1;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
public sealed class ArticleRevision
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ArticleId { get; set; }
    public int Number { get; set; }
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public string Intro { get; set; } = "";
    public Guid ColumnId { get; set; }
    public Guid? CoverMediaId { get; set; }
    public string ContentJson { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
public sealed class Column
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Slug { get; set; } = "";
    public string Name { get; set; } = "";
    public string Introduction { get; set; } = "";
    public ColumnState State { get; set; }
    public long Version { get; set; } = 1;
    public int Position { get; set; }
    public string ImageIdsJson { get; set; } = "[]";
}
public sealed class ColumnArticleOrder
{
    public Guid ArticleId { get; set; }
    public Guid ColumnId { get; set; }
    public int Position { get; set; }
}
public sealed class MediaAsset
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public MediaState State { get; set; }
    public MediaKind Kind { get; set; }
    public long Version { get; set; } = 1;
    public string MimeType { get; set; } = "";
    public string StorageKey { get; set; } = "";
    public string? DesignPath { get; set; }
    public string Alt { get; set; } = "";
    public string Caption { get; set; } = "";
    public string Credit { get; set; } = "";
    public string SourceUrl { get; set; } = "";
    public string LicenseName { get; set; } = "";
    public string LicenseUrl { get; set; } = "";
    public long ByteSize { get; set; }
    public string Sha256 { get; set; } = "";
    public int? Width { get; set; }
    public int? Height { get; set; }
    public long? DurationMs { get; set; }
    public int Attempts { get; set; }
    public string? ErrorCode { get; set; }
    public string? LeaseToken { get; set; }
    public DateTimeOffset? LeaseUntil { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
public sealed class MediaReference
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid MediaId { get; set; }
    public string OwnerType { get; set; } = "";
    public Guid OwnerId { get; set; }
    public string Usage { get; set; } = "";
}
public sealed class ProjectEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Slug { get; set; } = "";
    public string DraftJson { get; set; } = "{}";
    public string? PublishedJson { get; set; }
    public long Version { get; set; } = 1;
    public int Position { get; set; }
    public bool IsDemo { get; set; }
    public bool Trashed { get; set; }
}
public sealed class KnowledgeChapter
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Title { get; set; } = "";
    public int Position { get; set; }
    public long Version { get; set; } = 1;
}
public sealed class KnowledgeEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ChapterId { get; set; }
    public Guid ArticleId { get; set; }
    public int Position { get; set; }
}
public sealed class SiteSettings
{
    public int Id { get; set; } = 1;
    public long Version { get; set; } = 1;
    public string Json { get; set; } = "{}";
    public bool DemoSeeded { get; set; }
}
public sealed class IdempotencyRecord
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public string Scope { get; set; } = "";
    public Guid Key { get; set; }
    public Guid? TargetId { get; set; }
    public string RequestHash { get; set; } = "";
    public int Status { get; set; }
    public string Json { get; set; } = "";
    public string? ETag { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
}
public sealed class AuditEvent
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public string Action { get; set; } = "";
    public Guid? TargetId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
