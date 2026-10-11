using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Blog.Web.Domain;
namespace Blog.Web.Application.Administration
{
    public enum FieldIssue { Invalid, Required, Unavailable, TooLong }
    public enum ProblemCode { VALIDATION_FAILED, NOT_FOUND, STATE_CONFLICT, DUPLICATE_SLUG, PRECONDITION_REQUIRED, PRECONDITION_FAILED, IDEMPOTENCY_CONFLICT, REAUTH_REQUIRED, MEDIA_TYPE_UNSUPPORTED, FILE_TOO_LARGE }
    public sealed class ApiFailure : Exception
    {
        public int Status { get; }
        public string Code { get; }
        public object? Fields { get; }
        public ApiFailure(int status, string code, object? fields = null) : base(code) { Status = status; Code = code; Fields = fields; }
        public ApiFailure(ProblemCode code, object? fields = null) : this(code switch
        {
            ProblemCode.NOT_FOUND => 404,
            ProblemCode.PRECONDITION_REQUIRED => 428,
            ProblemCode.PRECONDITION_FAILED => 412,
            ProblemCode.STATE_CONFLICT or ProblemCode.DUPLICATE_SLUG or ProblemCode.IDEMPOTENCY_CONFLICT => 409,
            ProblemCode.REAUTH_REQUIRED => 403,
            ProblemCode.FILE_TOO_LARGE => 413,
            ProblemCode.MEDIA_TYPE_UNSUPPORTED => 415,
            _ => 422
        }, code.ToString(), fields)
        { }
    }
    public static class ApiJson
    {
        public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    }
    public static class Versions
    {
        public static string Tag(string kind, Guid id, long version) => $"\"{kind}-{id:D}-{version}\"";
        public static void Require(HttpContext context, string tag)
        {
            var value = context.Request.Headers.IfMatch;
            if (value.Count == 0) throw new ApiFailure(ProblemCode.PRECONDITION_REQUIRED);
            if (value.Count != 1 || value[0] != tag) throw new ApiFailure(ProblemCode.PRECONDITION_FAILED);
        }
    }
}
namespace Blog.Web.Application.Articles
{
    public interface IDraftBodyBoundary { RichText.RichTextDocument Validate(JsonElement body, int schemaVersion); }
    public static class ArticleInput
    {
        public static ApiFailure Invalid(string field, FieldIssue issue = FieldIssue.Invalid) => new(ProblemCode.VALIDATION_FAILED, new Dictionary<string, FieldIssue[]> { [field] = [issue] });
        public static string Text(string? value, int limit, string field)
        {
            if (value is null) throw Invalid(field, FieldIssue.Required);
            try { value = value.Normalize(NormalizationForm.FormC); } catch (ArgumentException) { throw Invalid(field); }
            if (value.EnumerateRunes().Count() > limit) throw Invalid(field, FieldIssue.TooLong);
            if (value.Any(c => char.IsControl(c) && c != '\n' && c != '\t')) throw Invalid(field);
            return value;
        }
        public static string Slug(string? value)
        {
            value = Text(value, ContentLimits.SlugScalars, "slug");
            if (!Regex.IsMatch(value, "\\A[a-z0-9]+(?:-[a-z0-9]+)*\\z")) throw Invalid("slug");
            return value;
        }
    }
}
namespace Blog.Web.Application
{
    public sealed record TocEntry(string Id, int Level, string Title);
    public static class ReadingPresentation { public static string Anchor(Guid id) => "section-" + id.ToString("N"); }
    public static class ReadingTime { public static int FromPlainText(string text) => Math.Max(1, (int)Math.Ceiling(text.EnumerateRunes().Count() / 400d)); }
}
namespace Blog.Web.Application.Media
{
    public sealed record MediaInspectionInput(MediaKind Kind, string MimeType, string InputPath, string OutputPath);
    public sealed record ProcessedMedia(string MimeType, long ByteSize, string Sha256, int Width, int Height, long? DurationMs);
    public interface IMediaFileProcessor { Task<ProcessedMedia> ProcessAsync(MediaInspectionInput input, CancellationToken cancellationToken = default); }
    public sealed class MediaProcessingFailure(string code, bool transient = false) : Exception(code)
    { public string Code { get; } = code; public bool Transient { get; } = transient; }
}
