using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// Compile as WindowsApplication: the launcher itself has no console subsystem.
internal static class BackgroundTask
{
    private static readonly object LogLock = new object();
    private static string logFile;

    // Windows CreateProcess quoting, including embedded quotes and trailing slashes.
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static void Log(string message)
    {
        if (String.IsNullOrEmpty(message)) return;
        lock (LogLock)
            File.AppendAllText(logFile, DateTimeOffset.Now.ToString("o") + " " + message + Environment.NewLine, new UTF8Encoding(false));
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3) return 2;
            string script = Path.GetFullPath(args[0]);
            string logDirectory = Path.GetFullPath(args[2]);
            Directory.CreateDirectory(logDirectory);
            logFile = Path.Combine(logDirectory, Path.GetFileNameWithoutExtension(script) + "-" + DateTime.Now.ToString("yyyy-MM-dd") + ".log");
            if (!File.Exists(script) || !String.Equals(Path.GetExtension(script), ".ps1", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Expected an existing PowerShell script.");
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(script) +
                    (String.IsNullOrEmpty(args[1]) ? "" : " -CredentialFile " + Quote(args[1])),
                WorkingDirectory = Path.GetDirectoryName(script),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false)
            };
            using (var child = new Process { StartInfo = start })
            {
                child.OutputDataReceived += (sender, e) => Log(e.Data);
                child.ErrorDataReceived += (sender, e) => Log(e.Data);
                child.Start();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                child.WaitForExit();
                int result = child.ExitCode;
                if (result != 0) Log("PowerShell exited with code " + result);
                return result;
            }
        }
        catch (Exception error)
        {
            if (logFile != null) { try { Log(error.ToString()); } catch { } }
            return 2;
        }
    }
}
