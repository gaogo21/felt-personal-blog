using System.Security.Claims;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Blog.Web.Api;
using Blog.Web.Application;
using Blog.Web.Application.Articles;
using Blog.Web.Application.Media;
using Blog.Web.Application.RichText;
using Blog.Web.Infrastructure.Media;
using Blog.Web.Infrastructure.Backup;
using Blog.Web.Infrastructure.Security;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.FileProviders;
using Npgsql;
using Microsoft.AspNetCore.HttpOverrides;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddFilter("Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Warning);
var connection = builder.Configuration.GetConnectionString("Blog") ?? throw new InvalidOperationException("Set ConnectionStrings__Blog to a PostgreSQL connection string.");
builder.Services.AddDbContext<BlogDbContext>(o => o.UseNpgsql(connection));
builder.Services.ConfigureHttpJsonOptions(o => { o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()); o.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow; o.SerializerOptions.MaxDepth = 32; });
builder.Services.Configure<FormOptions>(o => { o.MultipartBodyLengthLimit = 210L * 1048576; o.MemoryBufferThreshold = 65536; });
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 210L * 1048576);
builder.Services.AddSingleton<PrivateStorage>();
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    if (builder.Configuration["ReverseProxy:KnownProxy"] is { Length: > 0 } proxy) o.KnownProxies.Add(System.Net.IPAddress.Parse(proxy));
});
builder.Services.AddDataProtection().SetApplicationName("felt-personal-blog")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(Path.GetFullPath(builder.Configuration["Blog:StoragePath"] ?? Path.Combine(builder.Environment.ContentRootPath, "../../runtime/private")), "keys")));
builder.Services.AddScoped<AdminSecurity>(); builder.Services.AddScoped<AdminCookieEvents>(); builder.Services.AddScoped<IPasswordHasher<AdminUser>, PasswordHasher<AdminUser>>();
builder.Services.AddAuthentication(AdminSecurity.Scheme).AddCookie(AdminSecurity.Scheme, o =>
{
    o.Cookie.Name = builder.Environment.IsDevelopment() ? "felt-admin-dev" : "__Host-felt-admin";
    o.Cookie.HttpOnly = true; o.Cookie.SecurePolicy = builder.Environment.IsDevelopment() ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;
    o.Cookie.SameSite = SameSiteMode.Strict; o.Cookie.Path = "/"; o.SlidingExpiration = false; o.ExpireTimeSpan = TimeSpan.FromHours(12);
    o.LoginPath = "/admin/login"; o.EventsType = typeof(AdminCookieEvents);
});
builder.Services.AddAuthorization(o => o.DefaultPolicy = new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder(AdminSecurity.Scheme).RequireAuthenticatedUser().RequireRole("Admin").Build());
builder.Services.AddAntiforgery(o => { o.HeaderName = "X-CSRF-TOKEN"; o.Cookie.Name = builder.Environment.IsDevelopment() ? "felt-csrf-dev" : "__Host-felt-csrf"; o.Cookie.HttpOnly = true; o.Cookie.SameSite = SameSiteMode.Strict; o.Cookie.SecurePolicy = builder.Environment.IsDevelopment() ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always; });
builder.Services.AddRazorPages(o => { o.Conventions.AuthorizeFolder("/Admin"); o.Conventions.AllowAnonymousToPage("/Admin/Login"); });
builder.Services.AddRateLimiter(o => { o.RejectionStatusCode = 429; o.AddPolicy("login", c => RateLimitPartition.GetFixedWindowLimiter(c.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 })); });
builder.Services.AddResponseCompression(o => { o.EnableForHttps = true; });
builder.Services.AddScoped<MutationCoordinator>(); builder.Services.AddScoped<ContentImages>(); builder.Services.AddScoped<ArticleService>(); builder.Services.AddScoped<ManagementService>(); builder.Services.AddScoped<PublicContentService>(); builder.Services.AddScoped<DemoSeeder>();
builder.Services.AddSingleton<RichTextSchema>(); builder.Services.AddScoped<MediaService>();
builder.Services.AddScoped<BackupService>();
builder.Services.AddSingleton(new MediaToolOptions
{
    FfmpegPath = builder.Configuration["Media:FfmpegPath"] ?? "/usr/bin/ffmpeg",
    FfprobePath = builder.Configuration["Media:FfprobePath"] ?? "/usr/bin/ffprobe",
    ScannerPath = builder.Configuration["Media:ScannerPath"] ?? "/usr/bin/clamscan",
    ScannerDatabasePath = builder.Configuration["Media:ScannerDatabasePath"] ?? "/var/lib/clamav"
});
builder.Services.AddSingleton<IMediaFileProcessor, ToolMediaFileProcessor>(); builder.Services.AddHostedService<MediaWorker>();
var app = builder.Build();
_ = app.Services.GetRequiredService<PrivateStorage>();
if (args.Contains("--restore"))
{
    string Argument(string name) { var index = Array.IndexOf(args, name); return index >= 0 && index + 1 < args.Length ? args[index + 1] : throw new InvalidOperationException($"Missing {name}."); }
    using var scope = app.Services.CreateScope();
    await scope.ServiceProvider.GetRequiredService<BackupService>().RestoreAsync(Argument("--restore"), Argument("--target"), Argument("--restore-storage"), CancellationToken.None);
    Console.WriteLine("Content and media restored into the isolated database. Initialize a new administrator explicitly.");
    return;
}
if (args.Contains("--migrate") || args.Contains("--init-admin") || args.Contains("--reset-admin") || args.Contains("--seed-demo"))
{
    using var scope = app.Services.CreateScope(); var services = scope.ServiceProvider; var db = services.GetRequiredService<BlogDbContext>();
    await db.Database.MigrateAsync(); await services.GetRequiredService<DemoSeeder>().InitializeSiteAsync(CancellationToken.None);
    if (args.Contains("--init-admin")) await services.GetRequiredService<AdminSecurity>().InitializeAsync(builder.Configuration["Blog:AdminName"] ?? "admin", builder.Configuration["Blog:AdminPassword"] ?? "", CancellationToken.None);
    if (args.Contains("--reset-admin")) await services.GetRequiredService<AdminSecurity>().ResetAsync(builder.Configuration["Blog:AdminName"] ?? "admin", builder.Configuration["Blog:AdminPassword"] ?? "", CancellationToken.None);
    if (args.Contains("--seed-demo")) await services.GetRequiredService<DemoSeeder>().SeedAsync(CancellationToken.None);
    return;
}
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<BlogDbContext>();
    if ((await db.Database.GetPendingMigrationsAsync()).Any()) throw new InvalidOperationException("Database migrations required. Run --migrate first.");
    if (!await db.Set<SiteSettings>().AnyAsync()) throw new InvalidOperationException("Initialize the database with --migrate first.");
}
app.UseForwardedHeaders();
app.Use(async (c, next) =>
{
    c.Response.Headers["X-Content-Type-Options"] = "nosniff"; c.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    c.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    if (c.Request.Path.StartsWithSegments("/api") || c.Request.Path.StartsWithSegments("/admin")) c.Response.Headers.CacheControl = "private, no-store";
    var bodyLimit = c.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (bodyLimit is { IsReadOnly: false } && c.Request.Path.StartsWithSegments("/api") && c.Request.Path != "/api/admin/v1/media/uploads") bodyLimit.MaxRequestBodySize = 3L * 1048576;
    try { await next(c); }
    catch (ApiFailure e) { c.Response.StatusCode = e.Status; await c.Response.WriteAsJsonAsync(new { code = e.Code, fields = e.Fields }); }
    catch (JsonException) { c.Response.StatusCode = 400; await c.Response.WriteAsJsonAsync(new { code = "MALFORMED_REQUEST" }); }
    catch (BadHttpRequestException e) { c.Response.StatusCode = e.StatusCode; await c.Response.WriteAsJsonAsync(new { code = e.StatusCode == 413 ? "REQUEST_TOO_LARGE" : "MALFORMED_REQUEST" }); }
    catch (DbUpdateConcurrencyException) { c.Response.StatusCode = 412; await c.Response.WriteAsJsonAsync(new { code = "PRECONDITION_FAILED" }); }
    catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: "23505" }) { c.Response.StatusCode = 409; await c.Response.WriteAsJsonAsync(new { code = "DUPLICATE_RESOURCE" }); }
    catch (OperationCanceledException) when (c.RequestAborted.IsCancellationRequested) { }
    catch (Exception e) { app.Logger.LogError("Request failed: {ExceptionType}", e.GetType().Name); c.Response.StatusCode = 500; await c.Response.WriteAsJsonAsync(new { code = "INTERNAL_ERROR" }); }
});
app.UseRouting(); app.UseRateLimiter(); app.UseAuthentication(); app.UseAuthorization();
app.Use(async (c, next) =>
{
    if (c.Request.Path.StartsWithSegments("/api/admin") || c.Request.Path.StartsWithSegments("/admin"))
    {
        if (!app.Environment.IsDevelopment() && !c.Request.IsHttps) throw new ApiFailure(400, "HTTPS_REQUIRED");
        if (!HttpMethods.IsGet(c.Request.Method) && !HttpMethods.IsHead(c.Request.Method))
        {
            if (c.Request.Headers.TryGetValue("Origin", out var origin) && (origin.Count != 1 || origin[0] != $"{c.Request.Scheme}://{c.Request.Host}")) throw new ApiFailure(403, "CSRF_INVALID");
            try { await c.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(c); }
            catch (AntiforgeryValidationException) { throw new ApiFailure(403, "CSRF_INVALID"); }
        }
    }
    await next(c);
});
var frontendRoot = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "../../dist"));
if (!Directory.Exists(frontendRoot)) frontendRoot = app.Environment.WebRootPath ?? Path.Combine(app.Environment.ContentRootPath, "wwwroot");
app.UseResponseCompression();
app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(frontendRoot), OnPrepareResponse = c => c.Context.Response.Headers.CacheControl = "public, max-age=300" });
app.UseStaticFiles();
app.MapGet("/", () => Results.File(Path.Combine(frontendRoot, "index.html"), "text/html; charset=utf-8"));
app.MapGet("/health/live", () => Results.Json(new { status = "live" }));
app.MapGet("/health/ready", async (BlogDbContext db, PrivateStorage storage, CancellationToken ct) =>
{ var ready = await db.Database.CanConnectAsync(ct) && !(await db.Database.GetPendingMigrationsAsync(ct)).Any() && Directory.Exists(storage.MediaRoot); return Results.Json(new { status = ready ? "ready" : "unavailable" }, statusCode: ready ? 200 : 503); });
app.MapGet("/articles", () => Results.Redirect("/#/articles"));
app.MapGet("/articles/{slug}", (string slug) => Results.Redirect("/#/article/" + Uri.EscapeDataString(slug)));
app.MapSessions(); app.MapContent(); app.MapMedia(frontendRoot); app.MapRazorPages();
app.MapGet("/api/admin/v1/backups", (BackupService backups) => backups.List()).RequireAuthorization();
app.MapPost("/api/admin/v1/maintenance/backup", async (HttpContext c, BackupService backups, AdminSecurity security, MutationCoordinator mutations) =>
{
    await security.RequireRecentAsync(c);
    return MutationCoordinator.Result(c, await mutations.ExecuteAsync(c, "backup.capture", null, true, () => backups.CaptureAsync(c.RequestAborted)));
}).RequireAuthorization();
await app.RunAsync();
public partial class Program;
