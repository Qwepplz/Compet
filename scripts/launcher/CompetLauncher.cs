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
            Arguments = BuildArguments(args),
            WorkingDirectory = electronRoot,
            UseShellExecute = false,
        };

        Process.Start(startInfo);
        return 0;
    }

    private static string BuildArguments(string[] args)
    {
        var builder = new StringBuilder();
        for (int i = 0; i < args.Length; i += 1)
        {
            if (i > 0) builder.Append(' ');
            AppendArgument(builder, args[i]);
        }
        return builder.ToString();
    }

    private static void AppendArgument(StringBuilder builder, string value)
    {
        builder.Append('"');
        foreach (char ch in value)
        {
            if (ch == '"' || ch == '\\')
            {
                builder.Append('\\');
            }
            builder.Append(ch);
        }
        builder.Append('"');
    }
}
