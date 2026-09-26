using System;
using System.Diagnostics;
using System.IO;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class CompetLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string electronRoot = Path.Combine(root, "runtime", "electron");
        string electron = Path.Combine(electronRoot, "electron.exe");
        string app = Path.Combine(electronRoot, "resources", "app");

        if (!RecoverMaintenance(root)) return 1;

        if (!File.Exists(electron))
        {
            MessageBox.Show("Missing Electron runtime.", "Compet", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        if (!Directory.Exists(app))
        {
            MessageBox.Show("Missing application files.", "Compet", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = electron,
            Arguments = BuildArguments(app, args),
            WorkingDirectory = electronRoot,
            UseShellExecute = false,
        };

        Process.Start(startInfo);
        return 0;
    }

    private static bool RecoverMaintenance(string baseRoot)
    {
        string root = Path.GetFullPath(baseRoot).TrimEnd(Path.DirectorySeparatorChar);
        string directory = Path.Combine(root, ".compet-maintenance");
        if (!Directory.Exists(directory)) return true;
        try
        {
            CheckNoReparse(root);
            CheckNoReparse(directory);
            string planPath = Path.Combine(directory, "plan.txt");
            string resultPath = Path.Combine(directory, "result.txt");
            string helperPath = Path.Combine(directory, "Compet Updater.exe");
            CheckNoReparse(planPath);
            CheckNoReparse(resultPath);
            CheckNoReparse(helperPath);
            string[] plan = File.ReadAllLines(planPath, new UTF8Encoding(false, true));
            if (plan.Length < 5 || plan[0] != "protocol=2" ||
                !plan[1].StartsWith("root=", StringComparison.Ordinal) ||
                !plan[4].StartsWith("helper=", StringComparison.Ordinal))
                return false;
            if (!Decode(plan[1].Substring(5)).Equals(root, StringComparison.OrdinalIgnoreCase))
                return false;
            string[] helper = plan[4].Substring(7).Split('\t');
            long expectedSize;
            if (helper.Length != 2 ||
                !long.TryParse(helper[0], NumberStyles.None, CultureInfo.InvariantCulture, out expectedSize) ||
                expectedSize < 0 || helper[1].Length != 64 || !File.Exists(helperPath) ||
                new FileInfo(helperPath).Length != expectedSize ||
                !HashFile(helperPath).Equals(helper[1], StringComparison.OrdinalIgnoreCase))
                return false;

            string state;
            using (Mutex mutex = new Mutex(false, MutexName(root)))
            {
                bool entered;
                try { entered = mutex.WaitOne(5000); }
                catch (AbandonedMutexException) { entered = true; }
                if (!entered) return false;
                try { state = ReadState(resultPath); }
                finally { mutex.ReleaseMutex(); }
            }
            if (state == "applied" || state == "verified" || state == "rolled_back") return true;
            if (state != "prepared" && state != "applying" && state != "recovery_failed") return false;

            var arguments = new StringBuilder("--recover --plan ");
            AppendArgument(arguments, planPath);
            using (Process recovery = Process.Start(new ProcessStartInfo
            {
                FileName = helperPath,
                Arguments = arguments.ToString(),
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true,
            }))
            {
                if (recovery == null || !recovery.WaitForExit(120000) || recovery.ExitCode != 0) return false;
            }
            return ReadState(resultPath) == "rolled_back";
        }
        catch
        {
            return false;
        }
    }

    private static string Decode(string value)
    {
        byte[] bytes = Convert.FromBase64String(value);
        if (bytes.Length == 0 || Convert.ToBase64String(bytes) != value)
            throw new InvalidDataException("Invalid maintenance root");
        return new UTF8Encoding(false, true).GetString(bytes);
    }

    private static string ReadState(string resultPath)
    {
        string[] lines = File.ReadAllLines(resultPath, new UTF8Encoding(false, true));
        if (lines.Length < 2 || lines[0] != "protocol=2" ||
            !lines[1].StartsWith("state=", StringComparison.Ordinal))
            throw new InvalidDataException("Invalid maintenance result");
        return lines[1].Substring(6);
    }

    private static string HashFile(string file)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "");
    }

    private static string MutexName(string root)
    {
        using (SHA256 sha = SHA256.Create())
            return "Local\\CompetMaintenance-" +
                BitConverter.ToString(sha.ComputeHash(new UTF8Encoding(false, true).GetBytes(root.ToUpperInvariant()))).Replace("-", "");
    }

    private static void CheckNoReparse(string absolute)
    {
        string full = Path.GetFullPath(absolute);
        string current = Path.GetPathRoot(full);
        CheckAttributes(current);
        foreach (string part in full.Substring(current.Length).Split(
            new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            CheckAttributes(current);
        }
    }

    private static void CheckAttributes(string path)
    {
        try
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Linked maintenance path");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }

    private static string BuildArguments(string app, string[] args)
    {
        var builder = new StringBuilder();
        AppendArgument(builder, app);
        for (int i = 0; i < args.Length; i += 1)
        {
            builder.Append(' ');
            AppendArgument(builder, args[i]);
        }
        return builder.ToString();
    }

    private static void AppendArgument(StringBuilder builder, string value)
    {
        builder.Append('"');
        int backslashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (ch == '"')
            {
                builder.Append('\\', (backslashes * 2) + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                builder.Append('\\', backslashes);
                backslashes = 0;
            }
            builder.Append(ch);
        }
        if (backslashes > 0)
        {
            builder.Append('\\', backslashes * 2);
        }
        builder.Append('"');
    }
}
