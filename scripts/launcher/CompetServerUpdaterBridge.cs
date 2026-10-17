using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;

// This partial uses only the existing strict parser and fingerprint/path helpers.
// File replacement, rollback and terminal cleanup belong to the Node worker.
internal static partial class CompetUpdater
{
    private static int ServerBridgeMain(string[] args)
    {
        string runner = null;
        bool handedOff = false;
        try
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            var flags = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--silent" || arg == "--validate-plan" || arg == "--recover" || arg == "--finish-server")
                {
                    if (!flags.Add(arg)) throw new MaintenanceFailure("maintenance_argument_invalid");
                }
                else if (arg == "--plan" || arg == "--pid")
                {
                    if (++i == args.Length || values.ContainsKey(arg)) throw new MaintenanceFailure("maintenance_argument_invalid");
                    values.Add(arg, args[i]);
                }
                else throw new MaintenanceFailure("maintenance_argument_invalid");
            }
            int modes = (flags.Contains("--validate-plan") ? 1 : 0) + (flags.Contains("--recover") ? 1 : 0) + (flags.Contains("--finish-server") ? 1 : 0);
            if (modes > 1) throw new MaintenanceFailure("maintenance_argument_invalid");
            string planPath;
            if (!values.TryGetValue("--plan", out planPath))
            {
                string installed = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
                string root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(installed), "..", ".."));
                if (!installed.Equals(Path.Combine(root, "runtime", "updater", "Compet Updater.exe"), StringComparison.OrdinalIgnoreCase))
                    throw new MaintenanceFailure("maintenance_layout_invalid");
                var candidates = new List<string>();
                foreach (string name in new[] { ".compet-maintenance", ".compet-maintenance-retired" })
                    if (Directory.Exists(Path.Combine(root, name))) candidates.Add(Path.Combine(root, name, "plan.txt"));
                if (candidates.Count != 1) throw new MaintenanceFailure("maintenance_transaction_conflict");
                planPath = candidates[0]; flags.Add("--recover");
            }
            if (!Path.IsPathRooted(planPath) || Path.GetFullPath(planPath) != planPath || Path.GetFileName(planPath) != "plan.txt")
                throw new MaintenanceFailure("maintenance_plan_invalid");
            CheckNoReparse(planPath);
            if (new FileInfo(planPath).Length > 32L * 1024 * 1024) throw new MaintenanceFailure("maintenance_plan_invalid");
            MaintenancePlan plan = ParsePlan(planPath, File.ReadAllLines(planPath, Utf8), flags.Contains("--validate-plan"));
            if (plan.Protocol != 4) throw new MaintenanceFailure("maintenance_plan_invalid");
            if (File.Exists(Path.Combine(plan.Directory, "plan.json"))) throw new MaintenanceFailure("update_transaction_format_conflict");
            string running = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
            if (running.Equals(Path.Combine(plan.Root, "runtime", "updater", "Compet Updater.exe"), StringComparison.OrdinalIgnoreCase))
                VerifyInstalledHelper(plan, false);
            else VerifyHelper(plan);
            if (flags.Contains("--validate-plan")) ValidateSources(plan);
            int parent = 0;
            string pid;
            if (values.TryGetValue("--pid", out pid) && (!Int32.TryParse(pid, NumberStyles.None, CultureInfo.InvariantCulture, out parent) || parent <= 0))
                throw new MaintenanceFailure("maintenance_argument_invalid");
            if (!flags.Contains("--validate-plan"))
            {
                if (parent > 0) WaitForInstallationExit(plan, parent);
                AssertInstallationQuiet(plan);
            }
            runner = Path.Combine(Path.GetTempPath(), "compet-server-bridge-" + Guid.NewGuid().ToString("N"));
            CheckNoReparse(runner);
            Directory.CreateDirectory(runner);
            string node = CopyBridgeRunner(plan, "runtime/node/node.exe", Path.Combine(runner, "node.exe"));
            string worker = CopyBridgeRunner(plan, "runtime/updater/worker.cjs", Path.Combine(runner, "worker.cjs"));
            string mode = flags.Contains("--validate-plan") ? "validate" : flags.Contains("--finish-server") ? "finish" : flags.Contains("--recover") ? "recover" : "apply";
            string bridgeStart = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
            var start = new ProcessStartInfo(node, Quote(worker) + " --plan " + Quote(planPath) + " --mode " + mode +
                " --bridge-pid " + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + " --bridge-start " + bridgeStart)
            { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = runner, RedirectStandardError = mode == "validate" };
            foreach (string key in new[] { "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE" }) start.EnvironmentVariables.Remove(key);
            using (Process child = Process.Start(start))
            {
                if (mode == "validate")
                {
                    if (!child.WaitForExit(30000)) throw new MaintenanceFailure("maintenance_runner_timeout");
                    Console.Error.Write(child.StandardError.ReadToEnd());
                    return child.ExitCode;
                }
                handedOff = true;
            }
            return 0;
        }
        catch (Exception error)
        {
            MaintenanceFailure known = error as MaintenanceFailure;
            Console.Error.WriteLine(known != null ? known.Code : "maintenance_bridge_failed");
            return 1;
        }
        finally
        {
            if (!handedOff && runner != null && Directory.Exists(runner))
            {
                // Only the two files created by this invocation can be removed.
                foreach (string name in new[] { "node.exe", "worker.cjs" })
                    if (File.Exists(Path.Combine(runner, name))) File.Delete(Path.Combine(runner, name));
                if (Directory.GetFileSystemEntries(runner).Length == 0) Directory.Delete(runner);
            }
        }
    }

    private static string CopyBridgeRunner(MaintenancePlan plan, string relative, string destination)
    {
        MaintenanceFile expected = plan.ExpectedFiles.Find(file => file.Target == relative);
        if (expected == null) throw new MaintenanceFailure("maintenance_runner_invalid");
        string staged = Path.Combine(plan.Directory, "files", expected.Hash);
        string source = File.Exists(staged) ? staged : PlanChild(plan, relative);
        CheckNoReparse(source);
        if (!Matches(source, expected.Size, expected.Hash)) throw new MaintenanceFailure("maintenance_runner_invalid");
        CopyDurable(source, destination);
        if (!Matches(destination, expected.Size, expected.Hash)) throw new MaintenanceFailure("maintenance_runner_invalid");
        return destination;
    }
}
