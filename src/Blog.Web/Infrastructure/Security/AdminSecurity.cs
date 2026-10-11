using System.Security.Claims;
using Blog.Web.Domain;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
namespace Blog.Web.Infrastructure.Security;

public sealed class AdminSecurity(BlogDbContext db, IPasswordHasher<AdminUser> passwords)
{
    public const string Scheme = "AdminSession";
    public const string SessionClaim = "felt:session";
    public async Task<AdminSession?> LoginAsync(string userName, string password, CancellationToken ct)
    {
        if (userName.Length > 256 || password.Length > 1024) return null;
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        // Credential writes have their own namespace, independent of content/backup maintenance.
        await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(506634353536)", ct);
        var user = await db.Set<AdminUser>().SingleOrDefaultAsync(x => x.NormalizedName == userName.ToUpperInvariant(), ct);
        var now = DateTimeOffset.UtcNow;
        if (user is null || user.LockedUntil > now) return null;
        if (passwords.VerifyHashedPassword(user, user.PasswordHash, password) == PasswordVerificationResult.Failed)
        {
            user.FailedAttempts++;
            if (user.FailedAttempts >= ContentLimits.LoginFailures) { user.LockedUntil = now.AddMinutes(ContentLimits.LockoutMinutes); user.FailedAttempts = 0; }
            await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct); return null;
        }
        user.FailedAttempts = 0; user.LockedUntil = null;
        var session = new AdminSession { UserId = user.Id, SecurityStamp = user.SecurityStamp, CreatedAt = now, LastSeenAt = now, AbsoluteExpiresAt = now.AddHours(ContentLimits.AbsoluteSessionHours) };
        db.Add(session); await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct); return session;
    }
    public async Task<bool> ReauthenticateAsync(Guid id, string password, CancellationToken ct)
    {
        if (password.Length > 1024) return false;
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(506634353536)", ct);
        var session = await db.Set<AdminSession>().SingleOrDefaultAsync(x => x.Id == id && x.RevokedAt == null, ct);
        if (session is null || session.AbsoluteExpiresAt <= DateTimeOffset.UtcNow) return false;
        var user = await db.Set<AdminUser>().SingleAsync(x => x.Id == session.UserId, ct);
        if (user.LockedUntil > DateTimeOffset.UtcNow || passwords.VerifyHashedPassword(user, user.PasswordHash, password) == PasswordVerificationResult.Failed)
        {
            user.FailedAttempts++;
            if (user.FailedAttempts >= ContentLimits.LoginFailures) { user.LockedUntil = DateTimeOffset.UtcNow.AddMinutes(ContentLimits.LockoutMinutes); user.FailedAttempts = 0; }
            await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct); return false;
        }
        user.FailedAttempts = 0; user.LockedUntil = null; session.ReauthenticatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct); await transaction.CommitAsync(ct); return true;
    }
    public static Guid SessionId(HttpContext context) => Guid.Parse(context.User.FindFirstValue(SessionClaim)!);
    public async Task RequireRecentAsync(HttpContext context)
    {
        var id = SessionId(context); var now = DateTimeOffset.UtcNow;
        if (!await db.Set<AdminSession>().AnyAsync(x => x.Id == id && x.RevokedAt == null && x.ReauthenticatedAt > now.AddMinutes(-ContentLimits.ReauthenticationMinutes), context.RequestAborted))
            throw new ApiFailure(ProblemCode.REAUTH_REQUIRED);
    }
    public async Task InitializeAsync(string userName, string password, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(userName) || userName.Length > 100 || password.Length < 12 || password.Length > 1024)
            throw new InvalidOperationException("Administrator name required; password must have 12–1024 characters.");
        var existing = await db.Set<AdminUser>().SingleOrDefaultAsync(x => x.NormalizedName == userName.ToUpperInvariant(), ct);
        if (existing is not null) throw new InvalidOperationException("Administrator already exists. Use the explicit reset-admin command.");
        var user = new AdminUser { UserName = userName.Trim(), NormalizedName = userName.Trim().ToUpperInvariant() };
        user.PasswordHash = passwords.HashPassword(user, password); db.Add(user); await db.SaveChangesAsync(ct);
    }
    public async Task ResetAsync(string userName, string password, CancellationToken ct)
    {
        if (password.Length < 12 || password.Length > 1024) throw new InvalidOperationException("Password must have 12–1024 characters.");
        var user = await db.Set<AdminUser>().SingleAsync(x => x.NormalizedName == userName.ToUpperInvariant(), ct);
        user.PasswordHash = passwords.HashPassword(user, password); user.SecurityStamp = Guid.NewGuid().ToString("N"); user.FailedAttempts = 0; user.LockedUntil = null;
        await db.SaveChangesAsync(ct);
    }
}
public sealed class AdminCookieEvents(BlogDbContext db) : CookieAuthenticationEvents
{
    public override async Task ValidatePrincipal(CookieValidatePrincipalContext context)
    {
        if (!Guid.TryParse(context.Principal?.FindFirstValue(AdminSecurity.SessionClaim), out var id)) { context.RejectPrincipal(); return; }
        var now = DateTimeOffset.UtcNow;
        var session = await db.Set<AdminSession>().AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.RevokedAt == null && x.AbsoluteExpiresAt > now && x.LastSeenAt > now.AddMinutes(-ContentLimits.IdleSessionMinutes), context.HttpContext.RequestAborted);
        var user = session is null ? null : await db.Set<AdminUser>().AsNoTracking().SingleOrDefaultAsync(x => x.Id == session.UserId && x.SecurityStamp == session.SecurityStamp, context.HttpContext.RequestAborted);
        if (session is null || user is null) { context.RejectPrincipal(); return; }
        var touched = await db.Set<AdminSession>().Where(x => x.Id == id && x.RevokedAt == null && x.AbsoluteExpiresAt > now && x.LastSeenAt > now.AddMinutes(-ContentLimits.IdleSessionMinutes))
            .ExecuteUpdateAsync(x => x.SetProperty(s => s.LastSeenAt, now), context.HttpContext.RequestAborted);
        if (touched == 0) { context.RejectPrincipal(); return; }
        context.ReplacePrincipal(new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim(AdminSecurity.SessionClaim, id.ToString()), new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()), new Claim(ClaimTypes.Name, user.UserName), new Claim(ClaimTypes.Role, "Admin") }, AdminSecurity.Scheme)));
    }
    public override Task RedirectToLogin(RedirectContext<CookieAuthenticationOptions> context)
    {
        if (context.Request.Path.StartsWithSegments("/api")) { context.Response.StatusCode = 401; return context.Response.WriteAsJsonAsync(new { code = "SESSION_REQUIRED" }); }
        context.Response.Redirect("/admin/login"); return Task.CompletedTask;
    }
    public override Task RedirectToAccessDenied(RedirectContext<CookieAuthenticationOptions> context)
    { context.Response.StatusCode = 403; return context.Response.WriteAsJsonAsync(new { code = "FORBIDDEN" }); }
}
