using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class CompetUpdater
{
    private static int Main(string[] args)
    {
        try
        {
            string planPath = GetArg(args, "--plan");
            int pid = int.Parse(GetArg(args, "--pid"));
            WaitForExit(pid);

            string[] lines = File.ReadAllLines(planPath);
            if (lines.Length < 2 || !lines[0].StartsWith("root=", StringComparison.Ordinal) || !lines[1].StartsWith("exe=", StringComparison.Ordinal)) return 1;
            string root = Path.GetFullPath(lines[0].Substring(5));
            string exe = lines[1].Substring(4);

            for (int i = 2; i < lines.Length; i += 1)
            {
                if (string.IsNullOrWhiteSpace(lines[i])) continue;
                string[] parts = lines[i].Split(new[] { '\t' }, 2);
                if (parts.Length != 2) return 1;
                string source = Path.GetFullPath(parts[0]);
                string target = Path.GetFullPath(Path.Combine(root, parts[1].Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return 1;
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(source, target, true);
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(root, exe),
                WorkingDirectory = root,
                UseShellExecute = true,
            });
            return 0;
        }
        catch
        {
            return 1;
        }
    }

    private static string GetArg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i += 1)
        {
            if (args[i] == name) return args[i + 1];
        }
        throw new ArgumentException(name);
    }

    private static void WaitForExit(int pid)
    {
        try
        {
            using (Process process = Process.GetProcessById(pid))
            {
                process.WaitForExit(30000);
            }
        }
        catch
        {
            Thread.Sleep(1000);
        }
    }
}
