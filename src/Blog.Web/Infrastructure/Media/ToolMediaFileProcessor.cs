using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Blog.Web.Application.Media;
using Blog.Web.Domain;
using Blog.Web.Domain.Persistence;

namespace Blog.Web.Infrastructure.Media;

// These are trusted deployment settings, never request fields. No tool installation or database
// update happens here; absent tools/signatures leave uploads isolated and explicitly retryable.
public sealed class MediaToolOptions
{
    public string FfmpegPath { get; init; } = "/usr/bin/ffmpeg";
    public string FfprobePath { get; init; } = "/usr/bin/ffprobe";
    public string ScannerPath { get; init; } = "/usr/bin/clamscan";
    public string ScannerDatabasePath { get; init; } = "/var/lib/clamav";
    public string? ScannerLibraryPath { get; init; }
    public TimeSpan ProcessingTimeout { get; init; } = TimeSpan.FromSeconds(ContentLimits.ProcessingTimeoutSeconds);
}

public sealed class ToolMediaFileProcessor(MediaToolOptions options) : IMediaFileProcessor
{
    public async Task<ProcessedMedia> ProcessAsync(MediaInspectionInput input, CancellationToken cancellationToken = default)
    {
        if (options.ProcessingTimeout <= TimeSpan.Zero || options.ProcessingTimeout > TimeSpan.FromSeconds(ContentLimits.ProcessingTimeoutSeconds))
            throw new MediaProcessingFailure("MEDIA_TOOL_CONFIGURATION", true);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(options.ProcessingTimeout);
        var token = budget.Token;
        string? stage = null;
        try
        {
            CheckPaths(input);
            var format = MediaContainerInspection.FormatFor(input.Kind, input.MimeType);
            var limit = input.Kind == MediaKind.Image ? ContentLimits.ImageBytes : ContentLimits.VideoBytes;
            var size = new FileInfo(input.InputPath).Length;
            if (size <= 0) throw new MediaProcessingFailure("MEDIA_CORRUPT");
            if (size > limit) throw new MediaProcessingFailure("MEDIA_SIZE_EXCEEDED");
            var originalSha = await HashAsync(input.InputPath, token);
            if (input.Kind == MediaKind.Image)
                MediaContainerInspection.Image(await ReadImageBytesAsync(input.InputPath, token), input.MimeType, false);
            else
                await MediaContainerInspection.VideoAsync(input.InputPath, token);

            await ScanAsync(input.InputPath, token);
            var metadata = await ProbeAsync(input.InputPath, input.Kind, format, token);
            // Preserve the server-generated media/attempt prefix so a crash orphan is identifiable
            // by the same 24-hour reconciler as the attempt's other private files.
            stage = input.OutputPath + ".stage";
            if (input.Kind == MediaKind.Image)
            {
                await ReencodeImageAsync(input.InputPath, stage, input.MimeType, format, token);
                if (new FileInfo(stage).Length > ContentLimits.ImageBytes)
                    throw new MediaProcessingFailure("MEDIA_SIZE_EXCEEDED");
                MediaContainerInspection.Image(await ReadImageBytesAsync(stage, token), input.MimeType, true);
                metadata = await ProbeAsync(stage, MediaKind.Image, format, token);
                await DecodeAsync(stage, MediaKind.Image, format, token);
            }
            else
            {
                var decodedDuration = await DecodeAsync(input.InputPath, MediaKind.Video, format, token);
                metadata = metadata with { DurationMs = Math.Max(metadata.DurationMs!.Value, decodedDuration!.Value) };
                await using var source = new FileStream(input.InputPath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
                await using var target = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true);
                await source.CopyToAsync(target, token);
                await target.FlushAsync(token);
            }

            // Private upload files are immutable to the queue. Detect accidental replacement or writes
            // between scan/decode/copy as well, so a different source never inherits a scan result.
            if (originalSha != await HashAsync(input.InputPath, token))
                throw new MediaProcessingFailure("MEDIA_SOURCE_CHANGED");
            var finalSize = new FileInfo(stage).Length;
            if (finalSize <= 0 || finalSize > limit) throw new MediaProcessingFailure("MEDIA_SIZE_EXCEEDED");
            var sha = await HashAsync(stage, token);
            if (input.Kind == MediaKind.Video && sha != originalSha)
                throw new MediaProcessingFailure("MEDIA_SOURCE_CHANGED");
            token.ThrowIfCancellationRequested();
            File.Move(stage, input.OutputPath, overwrite: false);
            stage = null;
            return new(input.MimeType, finalSize, sha, metadata.Width, metadata.Height, metadata.DurationMs);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new MediaProcessingFailure("MEDIA_PROCESSING_TIMEOUT", true); }
        catch (JsonException) { throw new MediaProcessingFailure("MEDIA_CORRUPT"); }
        catch (IOException) { throw new MediaProcessingFailure("MEDIA_STORAGE_UNAVAILABLE", true); }
        catch (UnauthorizedAccessException) { throw new MediaProcessingFailure("MEDIA_STORAGE_UNAVAILABLE", true); }
        finally
        {
            if (stage is not null)
            {
                try { File.Delete(stage); }
                catch (IOException) { } // Queue reconciliation owns any still-private orphan after storage failure.
                catch (UnauthorizedAccessException) { }
            }
        }
    }

    internal async Task ScanAsync(string path, CancellationToken token)
    {
        if (!Path.IsPathFullyQualified(options.ScannerDatabasePath) || !Directory.Exists(options.ScannerDatabasePath))
            throw new MediaProcessingFailure("MEDIA_SCANNER_UNAVAILABLE", true);
        MediaToolResult result;
        try
        {
            result = await BoundedMediaProcess.RunAsync(options.ScannerPath,
                ["--stdout", "--no-summary", "--official-db-only=yes", "--bytecode-unsigned=no",
                 "--follow-file-symlinks=0", "--follow-dir-symlinks=0", "--recursive=no",
                 "--alert-exceeds-max=yes", "--max-filesize=" + ContentLimits.VideoBytes.ToString(CultureInfo.InvariantCulture),
                 "--max-scansize=" + (2 * ContentLimits.VideoBytes).ToString(CultureInfo.InvariantCulture),
                 "--max-files=1000", "--max-recursion=8", "--max-scantime=0",
                 "--database=" + options.ScannerDatabasePath, "--tempdir=" + Path.GetDirectoryName(path), path],
                token, options.ScannerLibraryPath);
        }
        catch (MediaProcessingFailure e) when (e.Code == "MEDIA_TOOL_UNAVAILABLE")
        { throw new MediaProcessingFailure("MEDIA_SCANNER_UNAVAILABLE", true); }
        if (result.ExitCode == 1) throw new MediaProcessingFailure("MEDIA_SCAN_REJECTED");
        if (result.ExitCode != 0 || !result.StandardOutput.EndsWith(": OK\n", StringComparison.Ordinal))
            throw new MediaProcessingFailure("MEDIA_SCANNER_UNAVAILABLE", true);
    }

    private async Task<ProbeMetadata> ProbeAsync(string path, MediaKind kind, string format, CancellationToken token)
    {
        var args = InputArguments(kind, format);
        args.AddRange(["-show_entries", "stream=index,codec_type,codec_name,width,height,duration,nb_read_frames:stream_disposition=attached_pic:format=format_name,duration", "-of", "json"]);
        if (kind == MediaKind.Image) args.Add("-count_frames");
        args.AddRange(["-i", path]);
        var result = await BoundedMediaProcess.RunAsync(options.FfprobePath, args, token);
        CheckDecoded(result);
        using var json = JsonDocument.Parse(result.StandardOutput, new JsonDocumentOptions { MaxDepth = 12 });
        var root = json.RootElement;
        if (!root.TryGetProperty("streams", out var streams) || streams.ValueKind != JsonValueKind.Array)
            throw new MediaProcessingFailure("MEDIA_CORRUPT");
        var videoCount = 0;
        var audioCount = 0;
        var width = 0;
        var height = 0;
        double duration = 0;
        foreach (var stream in streams.EnumerateArray())
        {
            var type = Text(stream, "codec_type");
            var codec = Text(stream, "codec_name");
            if (type == "video")
            {
                videoCount++;
                var expected = kind == MediaKind.Video ? "h264" : format switch { "jpeg_pipe" => "mjpeg", "png_pipe" => "png", _ => "webp" };
                if (codec != expected) throw new MediaProcessingFailure("MEDIA_CODEC_UNSUPPORTED");
                width = Integer(stream, "width"); height = Integer(stream, "height");
                MediaContainerInspection.CheckDimensions(width, height, kind);
                if (stream.TryGetProperty("disposition", out var disposition) && Integer(disposition, "attached_pic") != 0)
                    throw new MediaProcessingFailure("MEDIA_STREAM_UNSUPPORTED");
                if (kind == MediaKind.Image && Text(stream, "nb_read_frames") != "1")
                    throw new MediaProcessingFailure("MEDIA_ANIMATION_UNSUPPORTED");
            }
            else if (type == "audio" && kind == MediaKind.Video)
            {
                audioCount++;
                if (codec != "aac") throw new MediaProcessingFailure("MEDIA_CODEC_UNSUPPORTED");
            }
            else throw new MediaProcessingFailure("MEDIA_STREAM_UNSUPPORTED");
            if (kind == MediaKind.Video) duration = Math.Max(duration, Duration(stream));
        }
        if (videoCount != 1 || audioCount > 1) throw new MediaProcessingFailure("MEDIA_STREAM_UNSUPPORTED");
        if (!root.TryGetProperty("format", out var fileFormat)) throw new MediaProcessingFailure("MEDIA_CORRUPT");
        if (kind == MediaKind.Video)
        {
            if (Text(fileFormat, "format_name") != "mov,mp4,m4a,3gp,3g2,mj2")
                throw new MediaProcessingFailure("MEDIA_CONTAINER_UNSUPPORTED");
            duration = Math.Max(duration, Duration(fileFormat));
        }
        else if (Text(fileFormat, "format_name") != format)
            throw new MediaProcessingFailure("MEDIA_TYPE_MISMATCH");
        return new(width, height, kind == MediaKind.Video ? (long)Math.Ceiling(duration * 1000) : null);
    }

    private async Task ReencodeImageAsync(string source, string target, string mime, string format, CancellationToken token)
    {
        var args = new List<string> { "-nostdin", "-n", "-xerror", "-max_error_rate", "0", "-filter_threads", "1", "-filter_complex_threads", "1" };
        args.AddRange(InputArguments(MediaKind.Image, format));
        args.AddRange(["-i", source, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-threads", "1", "-flags", "+bitexact", "-fflags", "+bitexact"]);
        // Decoding and automatic display rotation happen before a fresh encoded file is made.
        // Only fixed codecs/muxers are used; user-provided metadata and arguments never reach the command line.
        args.AddRange(mime switch
        {
            "image/jpeg" => ["-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p", "-f", "image2pipe"],
            "image/png" => ["-c:v", "png", "-f", "image2pipe"],
            _ => ["-c:v", "libwebp", "-lossless", "1", "-compression_level", "4", "-f", "webp"]
        });
        args.Add("pipe:1");
        CheckDecoded(await BoundedMediaProcess.RunAsync(options.FfmpegPath, args, token,
            outputFile: target, outputByteLimit: ContentLimits.ImageBytes));
    }

    private async Task<long?> DecodeAsync(string path, MediaKind kind, string format, CancellationToken token)
    {
        var args = new List<string> { "-nostdin", "-xerror", "-max_error_rate", "0", "-filter_threads", "1", "-filter_complex_threads", "1" };
        args.AddRange(InputArguments(kind, format));
        args.AddRange(["-i", path, "-map", "0", "-map_metadata", "-1", "-map_chapters", "-1", "-threads", "1", "-progress", "pipe:1", "-stats_period", "600", "-f", "null", "-"]);
        var result = await BoundedMediaProcess.RunAsync(options.FfmpegPath, args, token);
        CheckDecoded(result);
        if (!result.StandardOutput.Contains("progress=end", StringComparison.Ordinal)) throw new MediaProcessingFailure("MEDIA_CORRUPT");
        if (kind != MediaKind.Video) return null;
        long greatestTime = 0;
        long frames = 0;
        foreach (var line in result.StandardOutput.Split('\n'))
        {
            if (line.StartsWith("out_time_us=", StringComparison.Ordinal) && long.TryParse(line[12..].Trim(), CultureInfo.InvariantCulture, out var time))
                greatestTime = Math.Max(greatestTime, time);
            if (line.StartsWith("frame=", StringComparison.Ordinal) && long.TryParse(line[6..].Trim(), CultureInfo.InvariantCulture, out var count))
                frames = Math.Max(frames, count);
        }
        if (greatestTime <= 0 || frames <= 0) throw new MediaProcessingFailure("MEDIA_CORRUPT");
        if (greatestTime > ContentLimits.VideoSeconds * 1000000L) throw new MediaProcessingFailure("MEDIA_DURATION_EXCEEDED");
        return (greatestTime + 999) / 1000;
    }

    private static List<string> InputArguments(MediaKind kind, string format)
    {
        var args = new List<string>
        {
            "-hide_banner", "-v", "error", "-max_alloc", "268435456", "-threads", "1",
            "-protocol_whitelist", "file", "-format_whitelist", format, "-f", format,
            "-codec_whitelist", kind == MediaKind.Video ? "h264,aac" : format switch { "jpeg_pipe" => "mjpeg", "png_pipe" => "png", _ => "webp" },
            "-max_pixels", (kind == MediaKind.Image ? ContentLimits.ImagePixels : ContentLimits.VideoFramePixels).ToString(CultureInfo.InvariantCulture),
            "-err_detect", "explode", "-probesize", "1048576", "-analyzeduration", "5000000"
        };
        // MOV aliases/data references stay disabled even when the referenced target is another local file.
        if (kind == MediaKind.Video) args.AddRange(["-enable_drefs", "0", "-use_absolute_path", "0"]);
        return args;
    }

    private static void CheckDecoded(MediaToolResult result)
    {
        if (result.ExitCode < 0 || result.ExitCode >= 126) throw new MediaProcessingFailure("MEDIA_TOOL_FAILED", true);
        if (result.ExitCode != 0 || !string.IsNullOrWhiteSpace(result.StandardError)) throw new MediaProcessingFailure("MEDIA_CORRUPT");
    }

    private static double Duration(JsonElement element)
    {
        if (!double.TryParse(Text(element, "duration"), NumberStyles.Float, CultureInfo.InvariantCulture, out var duration) || !double.IsFinite(duration) || duration <= 0)
            throw new MediaProcessingFailure("MEDIA_CORRUPT");
        if (duration > ContentLimits.VideoSeconds) throw new MediaProcessingFailure("MEDIA_DURATION_EXCEEDED");
        return duration;
    }

    private static string? Text(JsonElement element, string name) => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static int Integer(JsonElement element, string name) => element.TryGetProperty(name, out var value) && value.TryGetInt32(out var number) ? number : 0;
    private static async Task<string> HashAsync(string path, CancellationToken token)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(file, token));
    }

    private static async Task<byte[]> ReadImageBytesAsync(string path, CancellationToken token)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
        if (file.Length > ContentLimits.ImageBytes) throw new MediaProcessingFailure("MEDIA_SIZE_EXCEEDED");
        var bytes = new byte[(int)file.Length];
        await file.ReadExactlyAsync(bytes, token);
        if (await file.ReadAsync(new byte[1], token) != 0) throw new MediaProcessingFailure("MEDIA_SOURCE_CHANGED");
        return bytes;
    }

    private static void CheckPaths(MediaInspectionInput input)
    {
        if (!Path.IsPathFullyQualified(input.InputPath) || !Path.IsPathFullyQualified(input.OutputPath)
            || Path.GetFullPath(input.InputPath) == Path.GetFullPath(input.OutputPath)
            || !File.Exists(input.InputPath) || Path.Exists(input.OutputPath))
            throw new MediaProcessingFailure("MEDIA_STORAGE_PATH_INVALID");
        if ((File.GetAttributes(input.InputPath) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
            throw new MediaProcessingFailure("MEDIA_STORAGE_PATH_INVALID");
        foreach (var path in new[] { input.InputPath, input.OutputPath })
            for (var directory = new DirectoryInfo(Path.GetDirectoryName(path)!); directory is not null; directory = directory.Parent)
                if (!directory.Exists || (directory.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new MediaProcessingFailure("MEDIA_STORAGE_PATH_INVALID");
    }

    private sealed record ProbeMetadata(int Width, int Height, long? DurationMs);
}

internal static class MediaContainerInspection
{
    public static string FormatFor(MediaKind kind, string mime) => (kind, mime) switch
    {
        (MediaKind.Image, "image/jpeg") => "jpeg_pipe",
        (MediaKind.Image, "image/png") => "png_pipe",
        (MediaKind.Image, "image/webp") => "webp_pipe",
        (MediaKind.Video, "video/mp4") => "mov",
        _ => throw new MediaProcessingFailure("MEDIA_TYPE_UNSUPPORTED")
    };

    public static void CheckDimensions(int width, int height, MediaKind kind)
    {
        if (width <= 0 || height <= 0) throw new MediaProcessingFailure("MEDIA_CORRUPT");
        var pixels = (long)width * height;
        if (kind == MediaKind.Image
            ? pixels > ContentLimits.ImagePixels || Math.Max(width, height) > ContentLimits.ImageLongestEdge
            : pixels > ContentLimits.VideoFramePixels)
            throw new MediaProcessingFailure("MEDIA_DIMENSIONS_EXCEEDED");
    }

    public static void Image(byte[] bytes, string mime, bool trustedOutput)
    {
        if (mime == "image/png") Png(bytes, trustedOutput);
        else if (mime == "image/jpeg") Jpeg(bytes, trustedOutput);
        else Webp(bytes, trustedOutput);
    }

    private static void Png(ReadOnlySpan<byte> bytes, bool output)
    {
        if (bytes.Length < 8 || !bytes[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) TypeMismatch();
        var offset = 8;
        var header = false;
        var data = false;
        while (offset <= bytes.Length - 12)
        {
            var length = BinaryPrimitives.ReadUInt32BigEndian(bytes[offset..]);
            if (length > bytes.Length - offset - 12) Corrupt();
            var count = (int)length;
            var name = Encoding.ASCII.GetString(bytes.Slice(offset + 4, 4));
            var payload = bytes.Slice(offset + 8, count);
            if (Crc32(bytes.Slice(offset + 4, count + 4)) != BinaryPrimitives.ReadUInt32BigEndian(bytes[(offset + count + 8)..])) Corrupt();
            if (!header && name != "IHDR") Corrupt();
            if (name == "IHDR")
            {
                if (header || count != 13) Corrupt();
                CheckDimensions(ReadDimension(payload), ReadDimension(payload[4..]), MediaKind.Image);
                header = true;
            }
            if (name is "acTL" or "fcTL" or "fdAT") throw new MediaProcessingFailure("MEDIA_ANIMATION_UNSUPPORTED");
            if (output && name is not ("IHDR" or "PLTE" or "IDAT" or "IEND" or "tRNS" or "pHYs" or "sRGB" or "gAMA" or "cHRM" or "cICP"))
                throw new MediaProcessingFailure("MEDIA_METADATA_UNSAFE");
            if (name == "IDAT") data = true;
            offset += count + 12;
            if (name == "IEND")
            {
                if (count != 0 || !data || offset != bytes.Length) Corrupt();
                return;
            }
        }
        Corrupt();
    }

    private static void Jpeg(ReadOnlySpan<byte> bytes, bool output)
    {
        if (bytes.Length < 4 || bytes[0] != 0xff || bytes[1] != 0xd8) TypeMismatch();
        var offset = 2;
        var frame = false;
        var scan = false;
        while (offset < bytes.Length)
        {
            if (bytes[offset++] != 0xff) Corrupt();
            while (offset < bytes.Length && bytes[offset] == 0xff) offset++;
            if (offset == bytes.Length) Corrupt();
            var marker = bytes[offset++];
            if (marker == 0xd9)
            {
                if (!frame || !scan || offset != bytes.Length) Corrupt();
                return;
            }
            if (marker is 0 or 0xd8 or >= 0xd0 and <= 0xd7) Corrupt();
            if (offset > bytes.Length - 2) Corrupt();
            var length = BinaryPrimitives.ReadUInt16BigEndian(bytes[offset..]);
            if (length < 2 || length > bytes.Length - offset) Corrupt();
            var payload = bytes.Slice(offset + 2, length - 2);
            // MPO embeds additional JPEG pictures and must never be flattened silently.
            if (marker == 0xe2 && payload.StartsWith("MPF\0"u8)) throw new MediaProcessingFailure("MEDIA_ANIMATION_UNSUPPORTED");
            if (output && (marker == 0xfe || marker is >= 0xe1 and <= 0xed || marker == 0xef))
                throw new MediaProcessingFailure("MEDIA_METADATA_UNSAFE");
            if (marker is 0xc0 or 0xc1 or 0xc2)
            {
                if (frame || payload.Length < 6) Corrupt();
                CheckDimensions(BinaryPrimitives.ReadUInt16BigEndian(payload[3..]), BinaryPrimitives.ReadUInt16BigEndian(payload[1..]), MediaKind.Image);
                frame = true;
            }
            offset += length;
            if (marker == 0xda)
            {
                if (!frame) Corrupt();
                scan = true;
                while (offset < bytes.Length - 1)
                {
                    if (bytes[offset] != 0xff) { offset++; continue; }
                    var next = bytes[offset + 1];
                    if (next == 0 || next is >= 0xd0 and <= 0xd7) { offset += 2; continue; }
                    break;
                }
            }
        }
        Corrupt();
    }

    private static void Webp(ReadOnlySpan<byte> bytes, bool output)
    {
        if (bytes.Length < 20 || !bytes[..4].SequenceEqual("RIFF"u8) || !bytes.Slice(8, 4).SequenceEqual("WEBP"u8)) TypeMismatch();
        if (BinaryPrimitives.ReadUInt32LittleEndian(bytes[4..]) != bytes.Length - 8) Corrupt();
        var offset = 12;
        var pictures = 0;
        while (offset <= bytes.Length - 8)
        {
            var name = Encoding.ASCII.GetString(bytes.Slice(offset, 4));
            var length = BinaryPrimitives.ReadUInt32LittleEndian(bytes[(offset + 4)..]);
            if (length > bytes.Length - offset - 8) Corrupt();
            var count = (int)length;
            var payload = bytes.Slice(offset + 8, count);
            if (name is "ANIM" or "ANMF" || name == "VP8X" && count >= 1 && (payload[0] & 2) != 0)
                throw new MediaProcessingFailure("MEDIA_ANIMATION_UNSUPPORTED");
            if (output && name is not ("VP8 " or "VP8L" or "VP8X" or "ALPH"))
                throw new MediaProcessingFailure("MEDIA_METADATA_UNSAFE");
            if (name == "VP8X")
            {
                if (count != 10) Corrupt();
                CheckDimensions(1 + U24(payload[4..]), 1 + U24(payload[7..]), MediaKind.Image);
            }
            else if (name == "VP8 ")
            {
                if (count < 10 || (payload[0] & 1) != 0 || !payload.Slice(3, 3).SequenceEqual(new byte[] { 0x9d, 1, 0x2a })) Corrupt();
                CheckDimensions(BinaryPrimitives.ReadUInt16LittleEndian(payload[6..]) & 0x3fff, BinaryPrimitives.ReadUInt16LittleEndian(payload[8..]) & 0x3fff, MediaKind.Image);
                pictures++;
            }
            else if (name == "VP8L")
            {
                if (count < 5 || payload[0] != 0x2f) Corrupt();
                var bits = BinaryPrimitives.ReadUInt32LittleEndian(payload[1..]);
                CheckDimensions((int)(bits & 0x3fff) + 1, (int)((bits >> 14) & 0x3fff) + 1, MediaKind.Image);
                pictures++;
            }
            offset += count + 8 + (count & 1);
        }
        if (offset != bytes.Length || pictures != 1) Corrupt();
    }

    public static async Task VideoAsync(string path, CancellationToken token)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, true);
        var header = new byte[16];
        var first = true;
        var movie = false;
        var media = false;
        while (file.Position < file.Length)
        {
            var start = file.Position;
            if (file.Length - start < 8) Corrupt();
            await file.ReadExactlyAsync(header.AsMemory(0, 8), token);
            var size = (long)BinaryPrimitives.ReadUInt32BigEndian(header);
            var name = Encoding.ASCII.GetString(header, 4, 4);
            var headerSize = 8;
            if (size == 1)
            {
                if (file.Length - file.Position < 8) Corrupt();
                await file.ReadExactlyAsync(header.AsMemory(8, 8), token);
                var extendedSize = BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8));
                if (extendedSize > long.MaxValue) Corrupt();
                size = (long)extendedSize; headerSize = 16;
            }
            else if (size == 0) size = file.Length - start;
            if (size < headerSize || size > file.Length - start) Corrupt();
            if (first)
            {
                if (name != "ftyp" || size < headerSize + 8 || size > 1024) TypeMismatch();
                await file.ReadExactlyAsync(header.AsMemory(0, 8), token);
                var brand = Encoding.ASCII.GetString(header, 0, 4);
                if (brand is not ("isom" or "iso2" or "iso3" or "iso4" or "iso5" or "iso6" or "mp41" or "mp42" or "avc1" or "M4V "))
                    throw new MediaProcessingFailure("MEDIA_CONTAINER_UNSUPPORTED");
                first = false;
            }
            else if (name == "ftyp") Corrupt();
            movie |= name == "moov";
            media |= name == "mdat";
            file.Position = start + size;
        }
        if (first || !movie || !media) Corrupt();
    }

    private static int ReadDimension(ReadOnlySpan<byte> bytes)
    {
        var value = BinaryPrimitives.ReadUInt32BigEndian(bytes);
        if (value > int.MaxValue) throw new MediaProcessingFailure("MEDIA_DIMENSIONS_EXCEEDED");
        return (int)value;
    }
    private static int U24(ReadOnlySpan<byte> bytes) => bytes[0] | bytes[1] << 8 | bytes[2] << 16;
    private static uint Crc32(ReadOnlySpan<byte> bytes)
    {
        var crc = uint.MaxValue;
        foreach (var value in bytes)
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++) crc = crc >> 1 ^ (0xedb88320u & (uint)-(int)(crc & 1));
        }
        return ~crc;
    }
    private static void TypeMismatch() => throw new MediaProcessingFailure("MEDIA_TYPE_MISMATCH");
    private static void Corrupt() => throw new MediaProcessingFailure("MEDIA_CORRUPT");
}
