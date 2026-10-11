using Blog.Web.Domain.Persistence;
namespace Blog.Web.Infrastructure.Persistence;

public sealed class BlogDbContext(DbContextOptions<BlogDbContext> options) : DbContext(options)
{
    protected override void OnModelCreating(ModelBuilder m)
    {
        m.Entity<AdminUser>().HasIndex(x => x.NormalizedName).IsUnique();
        m.Entity<AdminSession>().HasOne<AdminUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        m.Entity<AdminSession>().HasIndex(x => x.AbsoluteExpiresAt);
        m.Entity<Article>().HasIndex(x => x.Slug).IsUnique();
        m.Entity<Article>().Property(x => x.Version).IsConcurrencyToken();
        m.Entity<Article>().Property(x => x.Slug).HasMaxLength(100);
        m.Entity<Article>().ToTable(t => t.HasCheckConstraint("article_version", "\"Version\" > 0"));
        m.Entity<ArticleDraft>().HasKey(x => x.ArticleId);
        m.Entity<ArticleDraft>().HasOne<Article>().WithOne().HasForeignKey<ArticleDraft>(x => x.ArticleId).OnDelete(DeleteBehavior.Cascade);
        m.Entity<ArticleDraft>().HasOne<Column>().WithMany().HasForeignKey(x => x.ColumnId).OnDelete(DeleteBehavior.Restrict);
        m.Entity<ArticleDraft>().HasOne<MediaAsset>().WithMany().HasForeignKey(x => x.CoverMediaId).OnDelete(DeleteBehavior.Restrict);
        m.Entity<ArticleDraft>().Property(x => x.Version).IsConcurrencyToken();
        m.Entity<ArticleDraft>().Property(x => x.ContentJson).HasColumnType("jsonb");
        m.Entity<ArticleRevision>().HasOne<Article>().WithMany().HasForeignKey(x => x.ArticleId).OnDelete(DeleteBehavior.Cascade);
        m.Entity<ArticleRevision>().HasOne<Column>().WithMany().HasForeignKey(x => x.ColumnId).OnDelete(DeleteBehavior.Restrict);
        m.Entity<ArticleRevision>().HasOne<MediaAsset>().WithMany().HasForeignKey(x => x.CoverMediaId).OnDelete(DeleteBehavior.Restrict);
        m.Entity<ArticleRevision>().HasIndex(x => new { x.ArticleId, x.Number }).IsUnique();
        m.Entity<ArticleRevision>().Property(x => x.ContentJson).HasColumnType("jsonb");
        m.Entity<Column>().HasIndex(x => x.Slug).IsUnique();
        m.Entity<Column>().Property(x => x.Version).IsConcurrencyToken();
        m.Entity<Column>().Property(x => x.ImageIdsJson).HasColumnType("jsonb");
        m.Entity<ColumnArticleOrder>().HasKey(x => x.ArticleId);
        m.Entity<ColumnArticleOrder>().HasOne<Article>().WithOne().HasForeignKey<ColumnArticleOrder>(x => x.ArticleId).OnDelete(DeleteBehavior.Cascade);
        m.Entity<ColumnArticleOrder>().HasOne<Column>().WithMany().HasForeignKey(x => x.ColumnId).OnDelete(DeleteBehavior.Restrict);
        m.Entity<MediaAsset>().Property(x => x.Version).IsConcurrencyToken();
        m.Entity<MediaReference>().HasOne<MediaAsset>().WithMany().HasForeignKey(x => x.MediaId).OnDelete(DeleteBehavior.Restrict);
        m.Entity<MediaReference>().HasIndex(x => new { x.MediaId, x.OwnerType, x.OwnerId, x.Usage }).IsUnique();
        m.Entity<ProjectEntry>().HasIndex(x => x.Slug).IsUnique();
        m.Entity<ProjectEntry>().Property(x => x.Version).IsConcurrencyToken();
        m.Entity<ProjectEntry>().Property(x => x.DraftJson).HasColumnType("jsonb");
        m.Entity<ProjectEntry>().Property(x => x.PublishedJson).HasColumnType("jsonb");
        m.Entity<KnowledgeChapter>().Property(x => x.Version).IsConcurrencyToken();
        m.Entity<KnowledgeEntry>().HasOne<KnowledgeChapter>().WithMany().HasForeignKey(x => x.ChapterId).OnDelete(DeleteBehavior.Cascade);
        m.Entity<KnowledgeEntry>().HasOne<Article>().WithMany().HasForeignKey(x => x.ArticleId).OnDelete(DeleteBehavior.Cascade);
        m.Entity<KnowledgeEntry>().HasIndex(x => new { x.ChapterId, x.ArticleId }).IsUnique();
        m.Entity<SiteSettings>().Property(x => x.Version).IsConcurrencyToken();
        m.Entity<SiteSettings>().Property(x => x.Json).HasColumnType("jsonb");
        m.Entity<IdempotencyRecord>().HasIndex(x => new { x.UserId, x.Scope, x.Key }).IsUnique();
        m.Entity<IdempotencyRecord>().HasIndex(x => x.ExpiresAt);
        m.Entity<IdempotencyRecord>().Property(x => x.Json).HasColumnType("jsonb");
        m.Entity<AuditEvent>().HasIndex(x => x.CreatedAt);
    }
}
