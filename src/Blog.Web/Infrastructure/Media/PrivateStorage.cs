namespace Blog.Web.Infrastructure.Media;

public sealed class PrivateStorage
{
    public string Root { get; }
    public string MediaRoot { get; }
    public string BackupRoot { get; }
    public PrivateStorage(IConfiguration configuration, IWebHostEnvironment environment)
    {
        Root = Path.GetFullPath(configuration["Blog:StoragePath"] ?? Path.Combine(environment.ContentRootPath, "../../runtime/private"));
        var publicRoot = Path.GetFullPath(environment.WebRootPath ?? Path.Combine(environment.ContentRootPath, "wwwroot"));
        var frontendRoot = Path.GetFullPath(Path.Combine(environment.ContentRootPath, "../../dist"));
        if (Within(Root, publicRoot) || Within(Root, frontendRoot)) throw new InvalidOperationException("Private storage must be outside public static roots.");
        MediaRoot = Path.Combine(Root, "media"); BackupRoot = Path.Combine(Root, "backups");
        foreach (var path in new[] { Root, MediaRoot, BackupRoot, Path.Combine(Root, "keys") })
        {
            Directory.CreateDirectory(path);
            for (var d = new DirectoryInfo(path); d is not null; d = d.Parent)
                if (d.LinkTarget is not null) throw new InvalidOperationException("Private storage cannot contain symbolic-link ancestors.");
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }
    public string Input(Guid id) => Path.Combine(MediaRoot, id.ToString("N") + ".input");
    public string Final(Guid id) => Path.Combine(MediaRoot, id.ToString("N") + ".bin");
    public string Attempt(Guid id, string token) => Path.Combine(MediaRoot, id.ToString("N") + "." + Guid.Parse(token).ToString("N") + ".processed");
    public static bool Within(string path, string root) => path == root || path.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    public static void Restrict(string path) { if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite); }
}
