namespace Blog.Web.Domain;

// Approved chapter 7 defaults. Runtime options may only change after the matching schema/tests change.
public static class ContentLimits
{
    public const int TitleScalars = 120, SummaryScalars = 240, BodyScalars = 100000;
    public const int SlugScalars = 100, LinkScalars = 2048, ColumnNameScalars = 40, AboutScalars = 1200;
    public const int AltScalars = 200, CaptionScalars = 240, CreditScalars = 160, LicenseScalars = 120;
    public const int JsonBytes = 2 * 1048576, JsonNodes = 2000, JsonDepth = 12, CodeScalars = 30000;
    public const int TableRows = 20, TableColumns = 6, CellScalars = 2000;
    public const long ImageBytes = 10 * 1048576, VideoBytes = 200 * 1048576, ProxyRequestBytes = 210 * 1048576;
    public const int ImagePixels = 40000000, ImageLongestEdge = 16384, VideoFramePixels = 8294400, VideoSeconds = 600;
    public const int ConcurrentUploads = 2, ConcurrentProcessing = 1, PendingJobs = 10, ProcessingTimeoutSeconds = 120, AutomaticRetries = 2;
    public const int PublicPageSize = 12, AdminPageSize = 20, AdminMaxPageSize = 100;
    public const int IdleSessionMinutes = 30, AbsoluteSessionHours = 12, ReauthenticationMinutes = 10;
    public const int LoginFailures = 5, LockoutMinutes = 15, IpLoginAttemptsPerMinute = 10;
    public const int IdempotencyHours = 24, OrphanFileHours = 24, BackupRetentionDays = 30;
    public const int GalleryCount = 10, FeaturedMaximum = 3, ColumnImages = 3, DesignMediaCount = 19;
}
