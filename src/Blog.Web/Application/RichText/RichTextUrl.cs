using System.Text.RegularExpressions;
using Blog.Web.Application.Articles;
using Blog.Web.Domain;
namespace Blog.Web.Application.RichText;

public static class RichTextUrl
{
    public static string Normalize(string value, bool httpsOnly = false)
    {
        value = ArticleInput.Text(value, ContentLimits.LinkScalars, "contentJson");
        if (value.Length == 0 || value != value.Trim() || value.Contains('\\') || value.Any(char.IsControl) || Regex.IsMatch(value, "%(?![a-fA-F0-9]{2})")) throw ArticleInput.Invalid("contentJson");
        var decoded = value;
        for (var i = 0; i < 8; i++)
        {
            var next = Uri.UnescapeDataString(decoded);
            if (next.Contains('\\') || next.Any(char.IsControl)) throw ArticleInput.Invalid("contentJson");
            if (next == decoded) break;
            decoded = next;
            if (i == 7) throw ArticleInput.Invalid("contentJson");
        }
        if (!httpsOnly && value.StartsWith('#'))
        { if (value.Length < 2) throw ArticleInput.Invalid("contentJson"); return value; }
        var relative = value.StartsWith('/');
        if (relative && (httpsOnly || value.StartsWith("//") || decoded.StartsWith("//"))) throw ArticleInput.Invalid("contentJson");
        if (!relative && (!Uri.TryCreate(value, UriKind.Absolute, out var absolute) || absolute.Scheme != "https" || absolute.UserInfo.Length != 0)) throw ArticleInput.Invalid("contentJson");
        var baseUri = new Uri("https://site.invalid/");
        if (!Uri.TryCreate(baseUri, relative ? decoded : value, out var parsed) || parsed.UserInfo.Length != 0 || parsed.Scheme != "https") throw ArticleInput.Invalid("contentJson");
        var path = Uri.UnescapeDataString(parsed.AbsolutePath);
        for (var i = 0; i < 8 && path.Contains('%'); i++) { var next = Uri.UnescapeDataString(path); if (next == path) break; path = next; }
        // Normalize decoded dot segments before checking management paths. Do not allow an absolute same-origin bypass.
        path = new Uri(baseUri, path).AbsolutePath;
        if (path.Equals("/admin", StringComparison.OrdinalIgnoreCase) || path.StartsWith("/admin/", StringComparison.OrdinalIgnoreCase) ||
            path.Equals("/api/admin", StringComparison.OrdinalIgnoreCase) || path.StartsWith("/api/admin/", StringComparison.OrdinalIgnoreCase)) throw ArticleInput.Invalid("contentJson");
        if (!relative) return parsed.AbsoluteUri;
        return parsed.PathAndQuery + parsed.Fragment;
    }
}
