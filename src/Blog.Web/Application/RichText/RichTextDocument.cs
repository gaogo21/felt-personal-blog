using System.Text.Encodings.Web;
using System.Text.Json;
using Blog.Web.Application.Articles;
using Blog.Web.Domain.Persistence;
using Microsoft.AspNetCore.Html;

namespace Blog.Web.Application.RichText;

public sealed record BodyMediaReference(Guid MediaId, MediaUsage Usage);
// Only RichTextSchema constructs this capability. Neither a DTO nor a database string can be rendered as trusted HTML.
public sealed class SafeBodyHtml : IHtmlContent
{
    private readonly string value;
    internal SafeBodyHtml(string value) => this.value = value;
    public void WriteTo(TextWriter writer, HtmlEncoder encoder) => writer.Write(value);
    public override string ToString() => value;
}
public sealed class RichTextDocument
{
    public string Json { get; }
    public SafeBodyHtml Html { get; }
    public string PlainText { get; }
    public IReadOnlyList<TocEntry> Toc { get; }
    public IReadOnlyList<BodyMediaReference> References { get; }
    public int ReadingMinutes => ReadingTime.FromPlainText(PlainText);
    public bool HasSubstantiveText => PlainText.EnumerateRunes().Any(r => !System.Text.Rune.IsWhiteSpace(r) && System.Text.Rune.GetUnicodeCategory(r) is not (System.Globalization.UnicodeCategory.Format or System.Globalization.UnicodeCategory.Control));
    internal RichTextDocument(string json, string html, string plainText, IEnumerable<TocEntry> toc, IEnumerable<BodyMediaReference> references)
    { Json = json; Html = new(html); PlainText = plainText; Toc = Array.AsReadOnly(toc.ToArray()); References = Array.AsReadOnly(references.Distinct().OrderBy(x => x.MediaId).ThenBy(x => x.Usage).ToArray()); }

    // Publication calls this only after acquiring every referenced media row lock and checking readiness.
    // Re-render canonical JSON; never patch or trust a stored/caller-supplied HTML string.
    public RichTextDocument WithTrustedMedia(IReadOnlyDictionary<Guid, MediaAsset> media)
    {
        foreach (var reference in References)
        {
            var kind = reference.Usage == MediaUsage.Video ? MediaKind.Video : MediaKind.Image;
            if (!media.TryGetValue(reference.MediaId, out var asset) || asset.Id != reference.MediaId || asset.State != MediaState.Ready || asset.Kind != kind)
                throw ArticleInput.Invalid("contentJson", Administration.FieldIssue.Unavailable);
            if (asset.Width is not > 0 || asset.Height is not > 0) throw new InvalidOperationException("RICH_TEXT_MEDIA_DIMENSIONS_UNAVAILABLE");
        }
        return Render(media);
    }
    // A private preview may outlive a Ready asset. Missing/unavailable assets retain their protected URL;
    // the independent media endpoint rejects delivery, while other available images keep their dimensions.
    public RichTextDocument WithAvailablePreviewMedia(IReadOnlyDictionary<Guid, MediaAsset> media) => Render(media);
    private RichTextDocument Render(IReadOnlyDictionary<Guid, MediaAsset> media)
    {
        using var document = JsonDocument.Parse(Json);
        return new RichTextSchema().RenderWithTrustedMedia(document.RootElement, media);
    }

    // Call under the same sorted media row locks used for saving/publishing. A UUID alone is never evidence of content.
    // F15 must re-run this against current Ready assets in the publication transaction, not reuse a past result.
    public async Task<BodyReadiness> CheckMediaAsync(Func<Guid, CancellationToken, Task<MediaAsset?>> lookup, CancellationToken ct)
    {
        var media = new Dictionary<Guid, MediaAsset?>();
        foreach (var reference in References)
        {
            if (!media.TryGetValue(reference.MediaId, out var asset)) media.Add(reference.MediaId, asset = await lookup(reference.MediaId, ct));
            var kind = reference.Usage == MediaUsage.Video ? MediaKind.Video : MediaKind.Image;
            if (asset is null || asset.State != MediaState.Ready || asset.Kind != kind) throw ArticleInput.Invalid("contentJson", Administration.FieldIssue.Unavailable);
        }
        return new(HasSubstantiveText || References.Any(x => x.Usage is MediaUsage.BodyImage or MediaUsage.Video));
    }
}
public sealed record BodyReadiness(bool HasPublishableBody)
{
    public void RequireNonempty() { if (!HasPublishableBody) throw ArticleInput.Invalid("contentJson", Administration.FieldIssue.Required); }
}
