using System;
using System.Diagnostics;
using System.IO;
using System.Text;
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
