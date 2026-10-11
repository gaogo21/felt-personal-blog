using System.Collections.Frozen;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Blog.Web.Application.Articles;
using Blog.Web.Domain;
using Blog.Web.Domain.Persistence;

namespace Blog.Web.Application.RichText;

// Version 1 is deliberately closed. No HTML parser, CSS filter or caller-provided render callback is trusted.
public sealed class RichTextSchema : IDraftBodyBoundary
{
    public const string EmptyJson = "{\"type\":\"doc\",\"content\":[]}";
    public static readonly IReadOnlySet<string> Languages = new[] { "plaintext", "javascript", "typescript", "csharp", "sql", "json", "bash", "html", "css", "python" }.ToFrozenSet(StringComparer.Ordinal);
    // Preview and future publication share canonical JSON and the controlled renderer.
    // Each media request independently checks its current state and requester permissions.
    public RichTextDocument ValidatePreview(JsonElement body, int schemaVersion) => Validate(body, schemaVersion);
    public RichTextDocument Validate(JsonElement body, int schemaVersion)
        => ValidateCore(body, schemaVersion, null);
    internal RichTextDocument RenderWithTrustedMedia(JsonElement body, IReadOnlyDictionary<Guid, MediaAsset> media)
        => ValidateCore(body, 1, media);
    private static RichTextDocument ValidateCore(JsonElement body, int schemaVersion, IReadOnlyDictionary<Guid, MediaAsset>? media)
    {
        if (schemaVersion != 1 || body.ValueKind != JsonValueKind.Object || Encoding.UTF8.GetByteCount(body.GetRawText()) > ContentLimits.JsonBytes) throw Bad();
        var parser = new Parser(media); var root = parser.Node(body, 1, "root");
        var json = root.Json.ToJsonString();
        if (Encoding.UTF8.GetByteCount(json) > ContentLimits.JsonBytes || root.Plain.EnumerateRunes().Count() > ContentLimits.BodyScalars) throw Bad();
        return new(json, root.Html, root.Plain, parser.Toc, parser.References);
    }
    private static Administration.ApiFailure Bad() => ArticleInput.Invalid("contentJson");
    private static string Encode(string value) => HtmlEncoder.Default.Encode(value);
    private sealed record NodeResult(string Type, JsonObject Json, string Html, string Plain);
    private sealed class Parser(IReadOnlyDictionary<Guid, MediaAsset>? media)
    {
        private int count;
        private readonly HashSet<Guid> headings = [];
        public List<TocEntry> Toc { get; } = [];
        public List<BodyMediaReference> References { get; } = [];
        private static readonly HashSet<string> Blocks = ["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule", "image", "video", "table"];
        private static readonly Dictionary<string, int> MarkOrder = new() { ["link"] = 0, ["textColor"] = 1, ["bold"] = 2, ["italic"] = 3, ["strike"] = 4, ["code"] = 5 };
        public NodeResult Node(JsonElement input, int depth, string parent)
        {
            if (++count > ContentLimits.JsonNodes || depth > ContentLimits.JsonDepth) throw Bad();
            Object(input, ["type", "attrs", "content", "text", "marks"]);
            var type = String(input, "type");
            var allowed = parent switch
            {
                "root" => type == "doc",
                "doc" or "blockquote" or "listItem" => Blocks.Contains(type),
                "paragraph" or "heading" => type is "text" or "hardBreak",
                "codeBlock" => type == "text",
                "bulletList" or "orderedList" => type == "listItem",
                "table" => type == "tableRow",
                "tableRow" => type is "tableCell" or "tableHeader",
                "tableCell" or "tableHeader" => type == "paragraph",
                _ => false
            };
            if (!allowed) throw Bad();
            var canonical = new JsonObject { ["type"] = type };
            if (type == "text")
            {
                Only(input, ["type", "text", "marks"]);
                var text = Text(String(input, "text"), ContentLimits.BodyScalars); if (text.Length == 0) throw Bad();
                canonical["text"] = text; var html = Encode(text);
                if (input.TryGetProperty("marks", out var marks))
                {
                    if (parent == "codeBlock") throw Bad();
                    var normalized = Marks(marks); if (normalized.Count > 0) canonical["marks"] = new JsonArray(normalized.Select(x => (JsonNode)x).ToArray());
                    foreach (var mark in normalized.AsEnumerable().Reverse())
                    {
                        var markType = mark["type"]!.GetValue<string>();
                        html = markType switch
                        {
                            "bold" => "<strong>" + html + "</strong>", "italic" => "<em>" + html + "</em>", "strike" => "<s>" + html + "</s>", "code" => "<code>" + html + "</code>",
                            "textColor" => "<span class=\"text-color-" + mark["attrs"]!["token"]!.GetValue<string>() + "\">" + html + "</span>",
                            "link" => Link(mark["attrs"]!["href"]!.GetValue<string>(), html), _ => throw Bad()
                        };
                    }
                }
                return new(type, canonical, html, text);
            }
            if (input.TryGetProperty("text", out _) || input.TryGetProperty("marks", out _)) throw Bad();
            var hasAttributes = type is "heading" or "orderedList" or "codeBlock" or "image" or "video";
            if (!hasAttributes && input.TryGetProperty("attrs", out _)) throw Bad();
            var attrs = input.TryGetProperty("attrs", out var attributes) ? attributes : default;
            JsonObject? normalizedAttrs = null; Guid headingId = default; int level = 0;
            if (type == "heading")
            {
                Object(attrs, ["level", "id"]); level = Integer(attrs, "level"); if (level is not (2 or 3)) throw Bad();
                headingId = attrs.TryGetProperty("id", out var id) && id.ValueKind != JsonValueKind.Null ? Uuid(id) : Guid.NewGuid();
                if (!headings.Add(headingId)) throw Bad();
                normalizedAttrs = new() { ["level"] = level, ["id"] = headingId.ToString("D") };
            }
            else if (type == "orderedList")
            {
                if (attrs.ValueKind != JsonValueKind.Undefined) Object(attrs, ["start"]);
                var start = attrs.ValueKind == JsonValueKind.Undefined || !attrs.TryGetProperty("start", out _) ? 1 : Integer(attrs, "start");
                if (start is < 1 or > 9999) throw Bad(); normalizedAttrs = new() { ["start"] = start };
            }
            else if (type == "codeBlock")
            {
                if (attrs.ValueKind != JsonValueKind.Undefined) Object(attrs, ["language"]);
                var language = attrs.ValueKind == JsonValueKind.Undefined || !attrs.TryGetProperty("language", out _) ? "plaintext" : String(attrs, "language");
                normalizedAttrs = new() { ["language"] = Languages.Contains(language) ? language : "plaintext" };
            }
            else if (type is "image" or "video") normalizedAttrs = Media(attrs, type);
            if (normalizedAttrs is not null) canonical["attrs"] = normalizedAttrs;
            var leaf = type is "hardBreak" or "horizontalRule" or "image" or "video";
            var children = new List<NodeResult>();
            if (input.TryGetProperty("content", out var content))
            {
                if (leaf || content.ValueKind != JsonValueKind.Array) throw Bad();
                foreach (var item in content.EnumerateArray()) children.Add(Node(item, depth + 1, type));
            }
            if (!leaf) canonical["content"] = new JsonArray(children.Select(x => (JsonNode)x.Json).ToArray());
            if (type is "bulletList" or "orderedList" or "blockquote" or "listItem" or "table" or "tableRow" or "tableCell" or "tableHeader" && children.Count == 0) throw Bad();
            if (type == "listItem" && children[0].Type != "paragraph") throw Bad();
            var inline = type is "paragraph" or "heading" or "codeBlock";
            var plain = string.Join(inline ? "" : "\n", children.Select(x => x.Plain)).Normalize(NormalizationForm.FormC);
            if (plain.EnumerateRunes().Count() > ContentLimits.BodyScalars) throw Bad();
            var inner = string.Concat(children.Select(x => x.Html)); string output;
            switch (type)
            {
                case "doc": output = inner; break;
                case "paragraph": output = "<p>" + inner + "</p>"; break;
                case "heading": var anchor = ReadingPresentation.Anchor(headingId); Toc.Add(new(anchor, level, plain)); output = $"<h{level} id=\"{anchor}\" tabindex=\"-1\">{inner}</h{level}>"; break;
                case "hardBreak": output = "<br>"; plain = "\n"; break;
                case "horizontalRule": output = "<hr>"; break;
                case "bulletList": output = "<ul>" + inner + "</ul>"; break;
                case "orderedList": output = "<ol start=\"" + normalizedAttrs!["start"]!.GetValue<int>() + "\">" + inner + "</ol>"; break;
                case "listItem": output = "<li>" + inner + "</li>"; break;
                case "blockquote": output = "<blockquote>" + inner + "</blockquote>"; break;
                case "codeBlock":
                    if (plain.EnumerateRunes().Count() > ContentLimits.CodeScalars) throw Bad();
                    output = "<div class=\"reading-code\"><div class=\"code-language\">" + normalizedAttrs!["language"]!.GetValue<string>() + "</div><div class=\"reading-scroll\" role=\"region\" aria-label=\"代码，可横向滚动\" tabindex=\"0\"><pre><code>" + Encode(plain) + "</code></pre></div></div>"; break;
                case "table":
                    if (children.Count > ContentLimits.TableRows) throw Bad();
                    var width = children[0].Json["content"]!.AsArray().Count;
                    for (var row = 0; row < children.Count; row++)
                    {
                        var cells = children[row].Json["content"]!.AsArray();
                        if (cells.Count != width || width > ContentLimits.TableColumns || row > 0 && cells.Any(x => x!["type"]!.GetValue<string>() == "tableHeader")) throw Bad();
                        if (row == 0 && cells.Any(x => x!["type"]!.GetValue<string>() == "tableHeader") && cells.Any(x => x!["type"]!.GetValue<string>() != "tableHeader")) throw Bad();
                    }
                    output = "<div class=\"reading-scroll reading-table\" role=\"region\" aria-label=\"表格，可横向滚动\" tabindex=\"0\"><table><tbody>" + inner + "</tbody></table></div>"; break;
                case "tableRow": output = "<tr>" + inner + "</tr>"; break;
                case "tableCell": case "tableHeader":
                    if (plain.EnumerateRunes().Count() > ContentLimits.CellScalars) throw Bad();
                    output = type == "tableHeader" ? "<th scope=\"col\">" + inner + "</th>" : "<td>" + inner + "</td>"; break;
                case "image": case "video":
                    var a = normalizedAttrs!; plain = a["caption"]!.GetValue<string>(); var mediaId = a["mediaId"]!.GetValue<string>();
                    var dimensions = Dimensions(Guid.Parse(mediaId), type == "image" ? MediaKind.Image : MediaKind.Video);
                    output = "<figure class=\"reading-figure\">";
                    if (type == "image") output += "<img loading=\"lazy\" src=\"/media/" + mediaId + "\" alt=\"" + Encode(a["alt"]!.GetValue<string>()) + "\"" + dimensions + ">";
                    else output += "<video controls preload=\"metadata\" src=\"/media/" + mediaId + "\"" + dimensions + (a["posterMediaId"] is { } poster ? " poster=\"/media/" + poster.GetValue<string>() + "\"" : "") + ">浏览器不支持此视频。</video>";
                    var attribution = new List<string>();
                    if (plain.Length > 0) attribution.Add(Encode(plain));
                    if (type == "image")
                    {
                        var meta = a["displayMeta"]!;
                        var credit = meta["credit"]!.GetValue<string>();
                        var source = meta["sourceUrl"]!.GetValue<string>();
                        var license = meta["licenseName"]!.GetValue<string>();
                        var licenseUrl = meta["licenseUrl"]!.GetValue<string>();
                        if (credit.Length > 0 || source.Length > 0)
                            attribution.Add(source.Length == 0 ? Encode(credit) : Link(source, credit.Length == 0 ? "来源" : Encode(credit)));
                        if (license.Length > 0 || licenseUrl.Length > 0)
                            attribution.Add(licenseUrl.Length == 0 ? Encode(license) : Link(licenseUrl, license.Length == 0 ? "许可" : Encode(license)));
                    }
                    if (attribution.Count > 0) output += "<figcaption>" + string.Join(" · ", attribution) + "</figcaption>";
                    output += "</figure>"; break;
                default: throw Bad();
            }
            return new(type, canonical, output, plain);
        }
        private string Dimensions(Guid id, MediaKind kind)
        {
            // Only server-resolved metadata can reach this dictionary. JSON attrs never accept dimensions.
            if (media is null || !media.TryGetValue(id, out var asset)) return "";
            if (asset.Id != id || asset.State != MediaState.Ready || asset.Kind != kind || asset.Width is not > 0 || asset.Height is not > 0)
                throw new InvalidOperationException("RICH_TEXT_MEDIA_DIMENSIONS_UNAVAILABLE");
            return " width=\"" + asset.Width.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + "\" height=\"" + asset.Height.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
        }
        private JsonObject Media(JsonElement attrs, string type)
        {
            Object(attrs, type == "image" ? ["mediaId", "alt", "caption", "displayMeta"] : ["mediaId", "posterMediaId", "caption"]);
            var id = Uuid(Required(attrs, "mediaId")); var caption = Text(String(attrs, "caption"), ContentLimits.CaptionScalars);
            References.Add(new(id, type == "image" ? MediaUsage.BodyImage : MediaUsage.Video));
            var normalized = new JsonObject { ["mediaId"] = id.ToString("D") };
            if (type == "image")
            {
                var alt = Text(String(attrs, "alt"), ContentLimits.AltScalars); if (string.IsNullOrWhiteSpace(alt)) throw Bad();
                var meta = Required(attrs, "displayMeta"); Object(meta, ["alt", "caption", "credit", "sourceUrl", "licenseName", "licenseUrl"]);
                var metaAlt = Text(String(meta, "alt"), ContentLimits.AltScalars); var metaCaption = Text(String(meta, "caption"), ContentLimits.CaptionScalars);
                if (metaAlt != alt || metaCaption != caption) throw Bad();
                var source = Text(String(meta, "sourceUrl"), ContentLimits.LinkScalars); var licenseUrl = Text(String(meta, "licenseUrl"), ContentLimits.LinkScalars);
                normalized["alt"] = alt; normalized["caption"] = caption;
                normalized["displayMeta"] = new JsonObject { ["alt"] = alt, ["caption"] = caption,
                    ["credit"] = Text(String(meta, "credit"), ContentLimits.CreditScalars), ["sourceUrl"] = source.Length == 0 ? "" : RichTextUrl.Normalize(source, true),
                    ["licenseName"] = Text(String(meta, "licenseName"), ContentLimits.LicenseScalars), ["licenseUrl"] = licenseUrl.Length == 0 ? "" : RichTextUrl.Normalize(licenseUrl, true) };
            }
            else
            {
                var posterValue = Required(attrs, "posterMediaId"); Guid? poster = posterValue.ValueKind == JsonValueKind.Null ? null : Uuid(posterValue);
                normalized["posterMediaId"] = poster?.ToString("D"); normalized["caption"] = caption;
                if (poster is { } posterId) References.Add(new(posterId, MediaUsage.Poster));
            }
            return normalized;
        }
        private static List<JsonObject> Marks(JsonElement input)
        {
            if (input.ValueKind != JsonValueKind.Array) throw Bad(); var seen = new HashSet<string>(); var result = new List<JsonObject>();
            foreach (var mark in input.EnumerateArray())
            {
                Object(mark, ["type", "attrs"]); var type = String(mark, "type");
                if (!MarkOrder.ContainsKey(type) || !seen.Add(type)) throw Bad();
                var output = new JsonObject { ["type"] = type };
                if (type == "textColor")
                {
                    var attrs = Required(mark, "attrs"); Object(attrs, ["token"]); var token = String(attrs, "token");
                    if (token is not ("default" or "purple" or "gold")) throw Bad(); output["attrs"] = new JsonObject { ["token"] = token };
                }
                else if (type == "link")
                { var attrs = Required(mark, "attrs"); Object(attrs, ["href"]); output["attrs"] = new JsonObject { ["href"] = RichTextUrl.Normalize(String(attrs, "href")) }; }
                else if (mark.TryGetProperty("attrs", out _)) throw Bad();
                result.Add(output);
            }
            return result.OrderBy(x => MarkOrder[x["type"]!.GetValue<string>()]).ToList();
        }
        private static string Link(string url, string inner) => "<a href=\"" + Encode(url) + "\"" + (url.StartsWith("https://", StringComparison.Ordinal) ? " rel=\"noopener noreferrer\"" : "") + ">" + inner + "</a>";
        private static string Text(string value, int max) => ArticleInput.Text(value, max, "contentJson");
        private static void Object(JsonElement value, string[] keys)
        {
            if (value.ValueKind != JsonValueKind.Object) throw Bad(); var seen = new HashSet<string>();
            foreach (var property in value.EnumerateObject())
            {
                string name; try { name = property.Name; } catch (InvalidOperationException) { throw Bad(); }
                if (!keys.Contains(name, StringComparer.Ordinal) || !seen.Add(name)) throw Bad();
            }
        }
        private static void Only(JsonElement value, string[] keys) => Object(value, keys);
        private static JsonElement Required(JsonElement value, string key) => value.TryGetProperty(key, out var found) ? found : throw Bad();
        private static string String(JsonElement value, string key)
        {
            var found = Required(value, key); if (found.ValueKind != JsonValueKind.String) throw Bad();
            try { return found.GetString()!; } catch (InvalidOperationException) { throw Bad(); }
        }
        private static int Integer(JsonElement value, string key) { var found = Required(value, key); return found.ValueKind == JsonValueKind.Number && found.TryGetInt32(out var integer) ? integer : throw Bad(); }
        private static Guid Uuid(JsonElement value)
        {
            try { return value.ValueKind == JsonValueKind.String && Guid.TryParseExact(value.GetString(), "D", out var id) && id != Guid.Empty ? id : throw Bad(); }
            catch (InvalidOperationException) { throw Bad(); }
        }
    }
}
