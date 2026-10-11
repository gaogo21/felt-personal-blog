using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using Blog.Web.Application.Media;

[assembly: InternalsVisibleTo("Blog.MediaFileTests")]

namespace Blog.Web.Infrastructure.Media;

internal sealed record MediaToolResult(int ExitCode, string StandardOutput, string StandardError);

// No shell, remote protocols, scripts, inherited input, or unbounded diagnostic capture.
// The RSS check is an additional process watchdog, not a replacement for deployment resource isolation.
internal static class BoundedMediaProcess
{
    private const int OutputBytes = 65536;
    private const long MaximumWorkingSet = 1536L * 1048576;

    public static async Task<MediaToolResult> RunAsync(string executable, IEnumerable<string> arguments,
        CancellationToken cancellationToken, string? libraryPath = null, string? outputFile = null, long outputByteLimit = 0)
    {
        if (!Path.IsPathFullyQualified(executable) || !File.Exists(executable))
            throw new MediaProcessingFailure("MEDIA_TOOL_UNAVAILABLE", true);
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        start.Environment["LC_ALL"] = "C";
        // FFREPORT can otherwise cause a native tool to create a diagnostic log outside private storage.
        start.Environment.Remove("FFREPORT");
        if (!string.IsNullOrEmpty(libraryPath)) start.Environment["LD_LIBRARY_PATH"] = libraryPath;
        using var process = new Process { StartInfo = start };
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!process.Start()) throw new MediaProcessingFailure("MEDIA_TOOL_UNAVAILABLE", true);
        }
        catch (Win32Exception) { throw new MediaProcessingFailure("MEDIA_TOOL_UNAVAILABLE", true); }
        process.StandardInput.Close();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var kill = stop.Token.Register(() => Kill(process));
        var stdout = outputFile is null ? ReadAsync(process.StandardOutput, stop)
            : WriteFileAsync(process.StandardOutput.BaseStream, outputFile, outputByteLimit, stop);
        var stderr = ReadAsync(process.StandardError, stop);
        var watchdog = WatchMemoryAsync(process, stop);
        foreach (var task in new Task[] { stdout, stderr, watchdog })
            _ = task.ContinueWith(_ => stop.Cancel(), CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        try
        {
            await process.WaitForExitAsync(stop.Token);
            var output = await stdout;
            var error = await stderr;
            await watchdog;
            return new(process.ExitCode, output, error);
        }
        catch
        {
            stop.Cancel();
            Kill(process);
            // Reap the child and observe all capture/watchdog tasks before the private stage is removed.
            try { await process.WaitForExitAsync(CancellationToken.None); } catch (InvalidOperationException) { }
            try { await Task.WhenAll(stdout, stderr, watchdog); } catch { }
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var task in new Task[] { stdout, stderr, watchdog })
                if (task.Exception?.InnerException is MediaProcessingFailure failure) throw failure;
            if (stdout.Exception?.InnerException is IOException or UnauthorizedAccessException)
                throw new MediaProcessingFailure("MEDIA_STORAGE_UNAVAILABLE", true);
            throw new MediaProcessingFailure("MEDIA_TOOL_FAILED", true);
        }
    }

    private static async Task<string> WriteFileAsync(Stream source, string path, long limit, CancellationTokenSource stop)
    {
        await using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true);
        var buffer = new byte[65536];
        long total = 0;
        while (true)
        {
            var count = await source.ReadAsync(buffer, stop.Token);
            if (count == 0) { await output.FlushAsync(stop.Token); return ""; }
            total += count;
            if (total > limit)
            {
                stop.Cancel();
                throw new MediaProcessingFailure("MEDIA_SIZE_EXCEEDED");
            }
            await output.WriteAsync(buffer.AsMemory(0, count), stop.Token);
        }
    }

    private static async Task<string> ReadAsync(StreamReader reader, CancellationTokenSource stop)
    {
        using var result = new MemoryStream();
        var buffer = new byte[2048];
        while (true)
        {
            var count = await reader.BaseStream.ReadAsync(buffer, stop.Token);
            if (count == 0) return Encoding.UTF8.GetString(result.GetBuffer(), 0, (int)result.Length);
            if (result.Length + count > OutputBytes)
            {
                stop.Cancel();
                throw new MediaProcessingFailure("MEDIA_TOOL_OUTPUT_LIMIT");
            }
            result.Write(buffer, 0, count);
        }
    }

    private static async Task WatchMemoryAsync(Process process, CancellationTokenSource stop)
    {
        while (!process.HasExited)
        {
            process.Refresh();
            if (!process.HasExited && process.WorkingSet64 > MaximumWorkingSet)
            {
                stop.Cancel();
                throw new MediaProcessingFailure("MEDIA_TOOL_RESOURCE_LIMIT");
            }
            await Task.Delay(50, stop.Token);
        }
    }

    private static void Kill(Process process)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (Win32Exception) { }
    }
}
