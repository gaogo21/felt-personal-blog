using System.Security.Claims;
using Blog.Web.Infrastructure.Security;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
namespace Blog.Web.Api;

public static class SessionEndpoints
{
    public sealed record LoginInput(string UserName, string Password);
    public sealed record ReauthInput(string Password);
    public static void MapSessions(this WebApplication app)
    {
        var group = app.MapGroup("/api/admin/v1");
        group.MapGet("/session/bootstrap", (HttpContext c, IAntiforgery csrf) => Results.Json(new
        {
            csrfToken = csrf.GetAndStoreTokens(c).RequestToken,
            session = c.User.Identity?.IsAuthenticated == true ? new { userName = c.User.Identity.Name } : null
        }));
        group.MapPost("/session", async (LoginInput input, HttpContext c, AdminSecurity security, IAntiforgery csrf) =>
        {
            var session = await security.LoginAsync(input.UserName ?? "", input.Password ?? "", c.RequestAborted);
            if (session is null) throw new ApiFailure(401, "LOGIN_FAILED");
            var principal = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(AdminSecurity.SessionClaim, session.Id.ToString()), new Claim(ClaimTypes.NameIdentifier, session.UserId.ToString()) }, AdminSecurity.Scheme));
            await c.SignInAsync(AdminSecurity.Scheme, principal, new AuthenticationProperties { IsPersistent = false, AllowRefresh = false, ExpiresUtc = session.AbsoluteExpiresAt });
            c.User = principal;
            return Results.Json(new { csrfToken = csrf.GetAndStoreTokens(c).RequestToken, session = new { idleExpiresAt = session.LastSeenAt.AddMinutes(30), absoluteExpiresAt = session.AbsoluteExpiresAt } });
        }).RequireRateLimiting("login");
        group.MapDelete("/session", async (HttpContext c, BlogDbContext db) =>
        {
            var id = AdminSecurity.SessionId(c);
            await db.Set<AdminSession>().Where(x => x.Id == id).ExecuteUpdateAsync(x => x.SetProperty(s => s.RevokedAt, DateTimeOffset.UtcNow), c.RequestAborted);
            await c.SignOutAsync(AdminSecurity.Scheme); return Results.NoContent();
        }).RequireAuthorization();
        group.MapPost("/session/reauth", async (ReauthInput input, HttpContext c, AdminSecurity security) =>
        { if (!await security.ReauthenticateAsync(AdminSecurity.SessionId(c), input.Password ?? "", c.RequestAborted)) throw new ApiFailure(401, "REAUTH_FAILED"); return Results.NoContent(); })
            .RequireAuthorization().RequireRateLimiting("login");
    }
}
