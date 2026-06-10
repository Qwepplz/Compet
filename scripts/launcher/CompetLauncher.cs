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
        string electron = Path.Combine(root, "runtime", "electron", "electron.exe");
        string app = Path.Combine(root, "resources", "app");

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
            WorkingDirectory = root,
            UseShellExecute = false,
        };

        Process.Start(startInfo);
        return 0;
    }

    private static string BuildArguments(string app, string[] args)
    {
        var builder = new StringBuilder();
        AppendArgument(builder, app);
        foreach (string arg in args)
        {
            builder.Append(' ');
            AppendArgument(builder, arg);
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
