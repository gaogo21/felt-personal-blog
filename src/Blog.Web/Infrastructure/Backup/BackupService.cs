using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using Blog.Web.Infrastructure.Media;
using Npgsql;
namespace Blog.Web.Infrastructure.Backup;

public sealed record BackupFile(string Name, long Bytes, string Sha256);
public sealed record ContentSnapshot(int Format, DateTimeOffset CreatedAt, Article[] Articles, ArticleDraft[] Drafts,
    ArticleRevision[] Revisions, Column[] Columns, ColumnArticleOrder[] Orders, MediaAsset[] Media,
    MediaReference[] References, ProjectEntry[] Projects, KnowledgeChapter[] Chapters, KnowledgeEntry[] Entries,
    SiteSettings[] Settings, BackupFile[] Files);

public sealed class BackupService(BlogDbContext db, PrivateStorage storage, IConfiguration config, IWebHostEnvironment environment)
{
    private const long MaximumBytes = 10L * 1024 * 1024 * 1024;
    private static readonly byte[] Magic = "FELTBAK1"u8.ToArray();
    private byte[] Key()
    {
        var configured = config["Backup:Key"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var value = Convert.FromBase64String(configured);
            if (value.Length != 32) throw new InvalidOperationException("Backup__Key must be a base64-encoded 32-byte key.");
            return value;
        }
        if (!environment.IsDevelopment()) throw new ApiFailure(503, "BACKUP_KEY_REQUIRED");
        var path = Path.Combine(storage.Root, "backup.key");
        if (!File.Exists(path))
        {
            // Content mutations serialize this creation across application instances.
            File.WriteAllBytes(path, RandomNumberGenerator.GetBytes(32)); PrivateStorage.Restrict(path);
        }
        var key = File.ReadAllBytes(path);
        if (key.Length != 32) throw new InvalidOperationException("Invalid backup key file.");
        return key;
    }
    public object[] List() => Directory.EnumerateFiles(storage.BackupRoot, "*.felt")
        .Select(x => new FileInfo(x)).OrderByDescending(x => x.CreationTimeUtc)
        .Select(x => (object)new { id = Path.GetFileNameWithoutExtension(x.Name), byteSize = x.Length, createdAt = x.LastWriteTimeUtc }).ToArray();

    // Caller holds the global database content lock for the entire capture.
    public async Task<MutationReply> CaptureAsync(CancellationToken ct)
    {
        var key = Key(); var id = Guid.NewGuid();
        var temporary = Path.Combine(storage.BackupRoot, id.ToString("D") + ".zip.tmp");
        var encrypted = Path.Combine(storage.BackupRoot, id.ToString("D") + ".felt.tmp");
        try
        {
            var assets = await db.Set<MediaAsset>().AsNoTracking().ToArrayAsync(ct);
            var files = new List<BackupFile>(); long total = 0;
            await using (var zipStream = new FileStream(temporary, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 65536, true))
            {
                PrivateStorage.Restrict(temporary);
                using var archive = new ZipArchive(zipStream, ZipArchiveMode.Create, leaveOpen: true);
                foreach (var asset in assets.Where(x => x.DesignPath is null && x.State != MediaState.Purged))
                {
                    foreach (var source in new[] { storage.Input(asset.Id), storage.Final(asset.Id) }.Where(File.Exists))
                    {
                        await using var input = File.OpenRead(source);
                        total += input.Length;
                        if (total > MaximumBytes) throw new ApiFailure(422, "BACKUP_TOO_LARGE");
                        var hash = Convert.ToHexStringLower(await SHA256.HashDataAsync(input, ct)); input.Position = 0;
                        var name = "media/" + Path.GetFileName(source);
                        files.Add(new(name, input.Length, hash));
                        await using var entry = archive.CreateEntry(name, CompressionLevel.NoCompression).Open();
                        await input.CopyToAsync(entry, ct);
                    }
                }
                var snapshot = new ContentSnapshot(1, DateTimeOffset.UtcNow,
                    await db.Set<Article>().AsNoTracking().ToArrayAsync(ct), await db.Set<ArticleDraft>().AsNoTracking().ToArrayAsync(ct),
                    await db.Set<ArticleRevision>().AsNoTracking().ToArrayAsync(ct), await db.Set<Column>().AsNoTracking().ToArrayAsync(ct),
                    await db.Set<ColumnArticleOrder>().AsNoTracking().ToArrayAsync(ct), assets,
                    await db.Set<MediaReference>().AsNoTracking().ToArrayAsync(ct), await db.Set<ProjectEntry>().AsNoTracking().ToArrayAsync(ct),
                    await db.Set<KnowledgeChapter>().AsNoTracking().ToArrayAsync(ct), await db.Set<KnowledgeEntry>().AsNoTracking().ToArrayAsync(ct),
                    await db.Set<SiteSettings>().AsNoTracking().ToArrayAsync(ct), files.ToArray());
                await using var json = archive.CreateEntry("content.json", CompressionLevel.Optimal).Open();
                await JsonSerializer.SerializeAsync(json, snapshot, ApiJson.Options, ct);
            }
            await EncryptAsync(temporary, encrypted, key, ct);
            var final = Path.Combine(storage.BackupRoot, id.ToString("D") + ".felt"); File.Move(encrypted, final);
            return new(new { id, byteSize = new FileInfo(final).Length, createdAt = DateTimeOffset.UtcNow }, 201, TargetId: id);
        }
        finally { CryptographicOperations.ZeroMemory(key); File.Delete(temporary); File.Delete(encrypted); }
    }

    public async Task RestoreAsync(string file, string targetConnection, string targetStorage, CancellationToken ct)
    {
        var source = new NpgsqlConnectionStringBuilder(db.Database.GetConnectionString());
        var target = new NpgsqlConnectionStringBuilder(targetConnection);
        if (string.IsNullOrEmpty(target.Database) || !target.Database.StartsWith("felt_restore_", StringComparison.Ordinal) || target.Database == source.Database)
            throw new InvalidOperationException("Restore requires a separate empty database named felt_restore_*. Create it explicitly first.");
        if (PrivateStorage.Within(Path.GetFullPath(targetStorage), storage.Root) || PrivateStorage.Within(storage.Root, Path.GetFullPath(targetStorage)))
            throw new InvalidOperationException("Restore storage must be separate from source storage.");
        var destination = new PrivateStorage(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Blog:StoragePath"] = targetStorage }).Build(), environment);
        if (Directory.EnumerateFiles(destination.Root, "*", SearchOption.AllDirectories).Any()) throw new InvalidOperationException("Restore storage must be empty.");
        var temporary = Path.Combine(destination.Root, "restore.zip.tmp"); var key = Key(); var written = new List<string>();
        try
        {
            await DecryptAsync(file, temporary, key, ct);
            using var archive = ZipFile.OpenRead(temporary);
            if (archive.Entries.Count > 100001 || archive.Entries.Select(x => x.FullName).Distinct().Count() != archive.Entries.Count)
                throw new InvalidDataException("Invalid archive entries.");
            var json = archive.GetEntry("content.json") ?? throw new InvalidDataException("Missing content manifest.");
            if (json.Length > 128L * 1048576) throw new InvalidDataException("Content manifest too large.");
            await using var jsonStream = json.Open();
            var snapshot = await JsonSerializer.DeserializeAsync<ContentSnapshot>(jsonStream, ApiJson.Options, ct) ?? throw new InvalidDataException("Empty manifest.");
            if (snapshot.Format != 1 || snapshot.Settings.Length != 1 || snapshot.Settings[0].Id != 1 || snapshot.Files.Length + 1 != archive.Entries.Count || snapshot.Files.Sum(x => x.Bytes) > MaximumBytes)
                throw new InvalidDataException("Invalid content manifest.");
            var mediaIds = snapshot.Media.Select(x => x.Id).ToHashSet();
            foreach (var descriptor in snapshot.Files)
            {
                var parts = descriptor.Name.Split('/');
                if (parts.Length != 2 || parts[0] != "media" || !Guid.TryParseExact(parts[1].Split('.')[0], "N", out var mediaId) || !mediaIds.Contains(mediaId)
                    || parts[1] != mediaId.ToString("N") + ".input" && parts[1] != mediaId.ToString("N") + ".bin") throw new InvalidDataException("Invalid media path.");
                var entry = archive.GetEntry(descriptor.Name) ?? throw new InvalidDataException("Missing media.");
                if (entry.Length != descriptor.Bytes || entry.Length > 210L * 1048576) throw new InvalidDataException("Media size mismatch.");
                var output = Path.Combine(destination.MediaRoot, parts[1]);
                await using (var from = entry.Open())
                await using (var to = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
                { written.Add(output); PrivateStorage.Restrict(output); await from.CopyToAsync(to, ct); }
                await using var verify = File.OpenRead(output);
                if (Convert.ToHexStringLower(await SHA256.HashDataAsync(verify, ct)) != descriptor.Sha256) throw new InvalidDataException("Media hash mismatch.");
            }
            var frontendRoot = Path.GetFullPath(Path.Combine(environment.ContentRootPath, "../../dist"));
            if (!Directory.Exists(frontendRoot)) frontendRoot = environment.WebRootPath;
            foreach (var asset in snapshot.Media)
            {
                if (asset.DesignPath is { } path)
                {
                    if (!path.StartsWith("/assets/", StringComparison.Ordinal) || path.Contains("..") || path.Contains('\\')) throw new InvalidDataException("Invalid design asset path.");
                    var design = Path.Combine(frontendRoot, path.TrimStart('/'));
                    await using var bytes = File.OpenRead(design);
                    if (Convert.ToHexStringLower(await SHA256.HashDataAsync(bytes, ct)) != asset.Sha256) throw new InvalidDataException("Design asset mismatch.");
                }
                else if (asset.State == MediaState.Ready || asset.State == MediaState.Trashed && asset.ErrorCode is null)
                {
                    await using var bytes = File.OpenRead(destination.Final(asset.Id));
                    if (Convert.ToHexStringLower(await SHA256.HashDataAsync(bytes, ct)) != asset.Sha256) throw new InvalidDataException("Processed media mismatch.");
                }
                asset.LeaseToken = null; asset.LeaseUntil = null;
            }
            // Check before migrating: even an old restore database must never be changed in place.
            await using (var preflight = new NpgsqlConnection(targetConnection))
            {
                await preflight.OpenAsync(ct);
                await using var check = new NpgsqlCommand("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public')", preflight);
                if ((bool)(await check.ExecuteScalarAsync(ct))!) throw new InvalidOperationException("Restore database must have no existing tables.");
            }
            await using var restored = new BlogDbContext(new DbContextOptionsBuilder<BlogDbContext>().UseNpgsql(targetConnection).Options);
            await restored.Database.MigrateAsync(ct);
            await using var transaction = await restored.Database.BeginTransactionAsync(ct); await MutationCoordinator.LockAsync(restored, ct);
            if (await restored.Set<SiteSettings>().AnyAsync(ct) || await restored.Set<Article>().AnyAsync(ct) || await restored.Set<AdminUser>().AnyAsync(ct) || await restored.Set<MediaAsset>().AnyAsync(ct))
                throw new InvalidOperationException("Restore database is not empty.");
            restored.AddRange(snapshot.Media); restored.AddRange(snapshot.Columns); restored.AddRange(snapshot.Articles);
            restored.AddRange(snapshot.Drafts); restored.AddRange(snapshot.Revisions); restored.AddRange(snapshot.Orders); restored.AddRange(snapshot.References);
            restored.AddRange(snapshot.Projects); restored.AddRange(snapshot.Chapters); restored.AddRange(snapshot.Entries); restored.AddRange(snapshot.Settings);
            await restored.SaveChangesAsync(ct); await transaction.CommitAsync(ct);
        }
        catch { foreach (var path in written) File.Delete(path); throw; }
        finally { CryptographicOperations.ZeroMemory(key); File.Delete(temporary); }
    }

    // Authenticated 64-KiB records, including a mandatory authenticated terminal record.
    // This avoids retaining whole videos or backups in memory and detects truncation/reordering.
    private static async Task EncryptAsync(string input, string output, byte[] key, CancellationToken ct)
    {
        await using var from = File.OpenRead(input);
        await using var to = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true); PrivateStorage.Restrict(output);
        var prefix = RandomNumberGenerator.GetBytes(8); await to.WriteAsync(Magic, ct); await to.WriteAsync(prefix, ct);
        using var aes = new AesGcm(key, 16); var plain = new byte[65536]; uint index = 0;
        while (true)
        {
            var length = await from.ReadAsync(plain, ct); var nonce = new byte[12]; prefix.CopyTo(nonce, 0); BinaryPrimitives.WriteUInt32BigEndian(nonce.AsSpan(8), index++);
            var size = new byte[4]; BinaryPrimitives.WriteInt32BigEndian(size, length); var cipher = new byte[length]; var tag = new byte[16];
            aes.Encrypt(nonce, plain.AsSpan(0, length), cipher, tag, size);
            await to.WriteAsync(size, ct); await to.WriteAsync(cipher, ct); await to.WriteAsync(tag, ct);
            if (length == 0) break;
        }
    }
    private static async Task DecryptAsync(string input, string output, byte[] key, CancellationToken ct)
    {
        await using var from = File.OpenRead(input);
        await using var to = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true); PrivateStorage.Restrict(output);
        var magic = new byte[8]; await from.ReadExactlyAsync(magic, ct); if (!magic.SequenceEqual(Magic)) throw new InvalidDataException("Unsupported backup format.");
        var prefix = new byte[8]; await from.ReadExactlyAsync(prefix, ct); uint index = 0; long total = 0; using var aes = new AesGcm(key, 16);
        while (true)
        {
            var size = new byte[4]; await from.ReadExactlyAsync(size, ct); var length = BinaryPrimitives.ReadInt32BigEndian(size);
            total += length; if (length < 0 || length > 65536 || total > MaximumBytes + 128L * 1048576) throw new InvalidDataException("Invalid backup record.");
            var cipher = new byte[length]; var tag = new byte[16]; await from.ReadExactlyAsync(cipher, ct); await from.ReadExactlyAsync(tag, ct);
            var nonce = new byte[12]; prefix.CopyTo(nonce, 0); BinaryPrimitives.WriteUInt32BigEndian(nonce.AsSpan(8), index++);
            var plain = new byte[length]; aes.Decrypt(nonce, cipher, tag, plain, size);
            if (length == 0) { if (from.ReadByte() != -1) throw new InvalidDataException("Trailing backup data."); break; }
            await to.WriteAsync(plain, ct);
        }
    }
}
