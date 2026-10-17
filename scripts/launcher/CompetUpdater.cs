using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal sealed class MaintenanceFailure : Exception
{
    internal readonly string Code;
    internal MaintenanceFailure(string code, string relatedPath = "") : base(code + (relatedPath == "" ? "" : ": " + relatedPath)) { Code = code; }
}

internal sealed class MaintenanceFile
{
    internal bool Delete;
    internal bool BeforeExists;
    internal long BeforeSize;
    internal string BeforeHash = "";
    internal string Source = "";
    internal string Target = "";
    internal long Size;
    internal string Hash = "";
}

internal sealed class MaintenancePlan
{
    internal int Protocol = 2;
    internal int EntryStage;
    internal readonly List<MaintenanceFile> ExpectedFiles = new List<MaintenanceFile>();
    internal readonly List<MaintenanceFile> BaselineFiles = new List<MaintenanceFile>();
    internal readonly List<string> ProtectedPaths = new List<string>();
    internal string Directory = "";
    internal string Root = "";
    internal string Exe = "";
    internal string Version = "";
    internal long HelperSize;
    internal string HelperHash = "";
    internal readonly List<MaintenanceFile> Files = new List<MaintenanceFile>();
}

internal sealed class JournalEntry
{
    internal string Target = "";
    internal bool Existed;
    internal string Backup = "";
    internal long Size;
    internal string Hash = "";
}

internal static partial class CompetUpdater
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private const int WaitTimeoutMs = 120000;

    private static int Main(string[] args)
    {
#if COMPET_SERVER_BRIDGE
        return ServerBridgeMain(args);
#else
        try
        {
            string planPath = GetArg(args, "--plan");
            string[] lines = File.ReadAllLines(planPath, Utf8);
            if (lines.Length == 0) return 1;
            if (lines[0] != "protocol=2")
            {
                if (lines[0].StartsWith("protocol=", StringComparison.Ordinal)) return 1;
                if (HasArg(args, "--recover") || HasArg(args, "--validate-plan")) return 1;
                return RunLegacy(planPath, int.Parse(GetArg(args, "--pid"), CultureInfo.InvariantCulture));
            }

            bool validation = HasArg(args, "--validate-plan");
            MaintenancePlan plan = ParsePlan(planPath, lines, validation);
            if (validation) return ValidateOnly(plan);
            if (HasArg(args, "--recover"))
                return Recover(plan, HasArg(args, "--pid") ? (int?)int.Parse(GetArg(args, "--pid"), CultureInfo.InvariantCulture) : null);
            return Apply(plan, int.Parse(GetArg(args, "--pid"), CultureInfo.InvariantCulture));
        }
        catch
        {
            return 1;
        }
#endif
    }

    private static bool HasArg(string[] args, string name)
    {
        foreach (string arg in args) if (arg == name) return true;
        return false;
    }

    private static string GetArg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i += 1)
            if (args[i] == name) return args[i + 1];
        throw new MaintenanceFailure("maintenance_argument_invalid");
    }

    private static string Decode(string value)
    {
        try
        {
            byte[] bytes = Convert.FromBase64String(value);
            if (Convert.ToBase64String(bytes) != value || bytes.Length == 0)
                throw new MaintenanceFailure("maintenance_plan_invalid");
            return Utf8.GetString(bytes);
        }
        catch
        {
            throw new MaintenanceFailure("maintenance_plan_invalid");
        }
    }

    private static string Encode(string value)
    {
        return Convert.ToBase64String(Utf8.GetBytes(value));
    }

    private static long ParseSize(string value)
    {
        long result;
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out result) || result < 0)
            throw new MaintenanceFailure("maintenance_plan_invalid");
        return result;
    }

    private static string ParseHash(string value)
    {
        if (value.Length != 64) throw new MaintenanceFailure("maintenance_plan_invalid");
        foreach (char ch in value)
            if (!Uri.IsHexDigit(ch)) throw new MaintenanceFailure("maintenance_plan_invalid");
        return value.ToUpperInvariant();
    }

    private static void CheckRelative(string value, bool serverProgram = false)
    {
        if (String.IsNullOrEmpty(value) || value.IndexOf('\\') >= 0 || Path.IsPathRooted(value))
            throw new MaintenanceFailure("maintenance_path_invalid");
        string[] parts = value.Split('/');
        if (!serverProgram && parts[0].StartsWith(".compet-maintenance", StringComparison.OrdinalIgnoreCase))
            throw new MaintenanceFailure("maintenance_path_invalid");
        foreach (string part in parts)
        {
            if (serverProgram && (value.Length > 240 || System.Text.RegularExpressions.Regex.IsMatch(part, @"^\.compet-maintenance(?:-staging|-retired)?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)))
                throw new MaintenanceFailure("maintenance_path_invalid");
            if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" "))
                throw new MaintenanceFailure("maintenance_path_invalid");
            foreach (char ch in part)
                if (ch < 32 || "<>:\"|?*".IndexOf(ch) >= 0)
                    throw new MaintenanceFailure("maintenance_path_invalid");
            string stem = part.Split('.')[0].ToUpperInvariant();
            if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
                (stem.Length == 4 && (stem.StartsWith("COM") || stem.StartsWith("LPT")) &&
                 stem[3] >= '1' && stem[3] <= '9'))
                throw new MaintenanceFailure("maintenance_path_invalid");
        }
    }

    private static string RootChild(string root, string relative, bool serverProgram = false)
    {
        CheckRelative(relative, serverProgram);
        string absolute = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!absolute.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new MaintenanceFailure("maintenance_path_invalid");
        return absolute;
    }

    private static void CheckNoReparse(string absolute)
    {
        string full = Path.GetFullPath(absolute);
        string current = Path.GetPathRoot(full);
        string remaining = full.Substring(current.Length);
        CheckAttributes(current);
        foreach (string part in remaining.Split(new[] { Path.DirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
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
                throw new MaintenanceFailure("maintenance_path_linked", path);
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }

    private static MaintenancePlan ParsePlan(string planPath, string[] lines, bool allowStaging)
    {
        if (lines.Length < 5 || (lines[0] != "protocol=2" && lines[0] != "protocol=4") ||
            !lines[1].StartsWith("root=", StringComparison.Ordinal) ||
            !lines[2].StartsWith("exe=", StringComparison.Ordinal) ||
            !lines[3].StartsWith("target=", StringComparison.Ordinal) ||
            !lines[4].StartsWith("helper=", StringComparison.Ordinal))
            throw new MaintenanceFailure("maintenance_plan_invalid");
        CheckNoReparse(planPath);
        MaintenancePlan plan = new MaintenancePlan();
        plan.Protocol = lines[0] == "protocol=4" ? 4 : 2;
        plan.Directory = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(planPath)));
        string directoryName = Path.GetFileName(plan.Directory);
        if (!directoryName.Equals(".compet-maintenance", StringComparison.OrdinalIgnoreCase) &&
            !(allowStaging && directoryName.Equals(".compet-maintenance-staging", StringComparison.OrdinalIgnoreCase)) &&
            !(plan.Protocol == 4 && directoryName.Equals(".compet-maintenance-retired", StringComparison.OrdinalIgnoreCase)))
            throw new MaintenanceFailure("maintenance_plan_invalid");
        plan.Root = Decode(lines[1].Substring(5));
        if (!Path.IsPathRooted(plan.Root) || !Path.GetFullPath(plan.Root).Equals(plan.Root, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetDirectoryName(plan.Directory).Equals(plan.Root, StringComparison.OrdinalIgnoreCase))
            throw new MaintenanceFailure("maintenance_plan_invalid");
        plan.Exe = Decode(lines[2].Substring(4));
        plan.Version = Decode(lines[3].Substring(7));
        CheckRelative(plan.Exe, plan.Protocol == 4);
        if (!System.Text.RegularExpressions.Regex.IsMatch(plan.Version,
            @"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"))
            throw new MaintenanceFailure("maintenance_plan_invalid");
        string[] helper = lines[4].Substring(7).Split('\t');
        if (helper.Length != 2) throw new MaintenanceFailure("maintenance_plan_invalid");
        plan.HelperSize = ParseSize(helper[0]);
        plan.HelperHash = ParseHash(helper[1]);
        HashSet<string> targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 5; i < lines.Length; i += 1)
        {
            if (plan.Protocol == 4)
            {
                ParseServerEntry(plan, lines[i], targets);
                continue;
            }
            if (!lines[i].StartsWith("file=", StringComparison.Ordinal))
                throw new MaintenanceFailure("maintenance_plan_invalid");
            string[] fields = lines[i].Substring(5).Split('\t');
            if (fields.Length != 4) throw new MaintenanceFailure("maintenance_plan_invalid");
            MaintenanceFile file = new MaintenanceFile();
            file.Source = Decode(fields[0]);
            file.Target = Decode(fields[1]);
            file.Size = ParseSize(fields[2]);
            file.Hash = ParseHash(fields[3]);
            CheckRelative(file.Source);
            PlanChild(plan, file.Target);
            if (file.Source != "files/" + file.Hash || !targets.Add(file.Target))
                throw new MaintenanceFailure("maintenance_plan_invalid");
            plan.Files.Add(file);
        }
        foreach (string target in targets)
            foreach (string other in targets)
                if (!target.Equals(other, StringComparison.OrdinalIgnoreCase) && target.StartsWith(other + "/", StringComparison.OrdinalIgnoreCase))
                    throw new MaintenanceFailure("maintenance_path_invalid");
        if (plan.Protocol == 4) ValidateServerPlan(plan);
        CheckNoReparse(plan.Root);
        CheckNoReparse(plan.Directory);
        return plan;
    }

    private static void ParseServerEntry(MaintenancePlan plan, string line, HashSet<string> targets)
    {
        if (line.StartsWith("protect=", StringComparison.Ordinal))
        {
            string protection = Decode(line.Substring(8));
            if (plan.EntryStage != 0 || !Path.IsPathRooted(protection) ||
                Path.GetFullPath(protection) != protection || plan.ProtectedPaths.Exists(p => p.Equals(protection, StringComparison.OrdinalIgnoreCase)) ||
                plan.Root.Equals(protection, StringComparison.OrdinalIgnoreCase) || plan.Root.StartsWith(protection.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new MaintenanceFailure("maintenance_path_invalid");
            CheckNoReparse(protection);
            plan.ProtectedPaths.Add(protection);
            return;
        }
        bool expected = line.StartsWith("expect=", StringComparison.Ordinal), baseline = line.StartsWith("baseline=", StringComparison.Ordinal);
        if (expected || baseline)
        {
            int stage = expected ? 1 : 2;
            if (plan.EntryStage > stage) throw new MaintenanceFailure("maintenance_plan_invalid");
            plan.EntryStage = stage;
            string[] fingerprintFields = line.Substring(expected ? 7 : 9).Split('\t');
            if (fingerprintFields.Length != 3 || !System.Text.RegularExpressions.Regex.IsMatch(fingerprintFields[1], @"^(0|[1-9]\d*)$") ||
                !System.Text.RegularExpressions.Regex.IsMatch(fingerprintFields[2], @"^[A-F0-9]{64}$"))
                throw new MaintenanceFailure("maintenance_plan_invalid");
            MaintenanceFile item = new MaintenanceFile();
            item.Target = Decode(fingerprintFields[0]); item.Size = ParseSize(fingerprintFields[1]); item.Hash = ParseHash(fingerprintFields[2]);
            if (item.Size > 9007199254740991L) throw new MaintenanceFailure("maintenance_plan_invalid");
            (expected ? plan.ExpectedFiles : plan.BaselineFiles).Add(item);
            return;
        }
        plan.EntryStage = 3;
        bool delete = line.StartsWith("delete=", StringComparison.Ordinal);
        if (!delete && !line.StartsWith("replace=", StringComparison.Ordinal))
            throw new MaintenanceFailure("maintenance_plan_invalid");
        string[] fields = line.Substring(delete ? 7 : 8).Split('\t');
        if (fields.Length != (delete ? 3 : 6)) throw new MaintenanceFailure("maintenance_plan_invalid");
        MaintenanceFile file = new MaintenanceFile();
        file.Delete = delete;
        file.Target = Decode(fields[delete ? 0 : 1]);
        PlanChild(plan, file.Target);
        if (!targets.Add(file.Target)) throw new MaintenanceFailure("maintenance_plan_invalid");
        int before = delete ? 1 : 4;
        file.BeforeExists = fields[before] != "-" || fields[before + 1] != "-";
        if (delete && !file.BeforeExists) throw new MaintenanceFailure("maintenance_plan_invalid");
        if (file.BeforeExists)
        {
            file.BeforeSize = ParseSize(fields[before]);
            file.BeforeHash = ParseHash(fields[before + 1]);
        }
        if (!delete)
        {
            file.Source = Decode(fields[0]);
            file.Size = ParseSize(fields[2]);
            file.Hash = ParseHash(fields[3]);
            if (file.Source != "files/" + file.Hash) throw new MaintenanceFailure("maintenance_plan_invalid");
        }
        CheckServerTarget(plan, file, false);
        plan.Files.Add(file);
    }

    private static void CheckServerTarget(MaintenancePlan plan, MaintenanceFile file, bool before)
    {
        if (plan.Protocol != 4) return;
        string target = PlanChild(plan, file.Target);
        CheckNoReparse(target);
        foreach (string protection in plan.ProtectedPaths)
        {
            CheckNoReparse(protection);
            string normalized = protection.TrimEnd(Path.DirectorySeparatorChar);
            if (target.Equals(normalized, StringComparison.OrdinalIgnoreCase) ||
                target.StartsWith(normalized + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                normalized.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new MaintenanceFailure("maintenance_path_protected");
        }
        if (Directory.Exists(target)) throw new MaintenanceFailure("maintenance_path_invalid");
        for (string parent = Path.GetDirectoryName(target); parent != plan.Root; parent = Path.GetDirectoryName(parent))
            if (File.Exists(parent)) throw new MaintenanceFailure("maintenance_path_invalid");
        if (before && (file.BeforeExists ? !Matches(target, file.BeforeSize, file.BeforeHash) : File.Exists(target)))
            throw new MaintenanceFailure("maintenance_target_changed");
    }


    private static string PlanChild(MaintenancePlan plan, string relative)
    {
        return RootChild(plan.Root, relative, plan.Protocol == 4);
    }

    private static void ValidateServerPlan(MaintenancePlan plan)
    {
        Dictionary<string, MaintenanceFile> expected = ServerCollection(plan, plan.ExpectedFiles);
        Dictionary<string, MaintenanceFile> baseline = ServerCollection(plan, plan.BaselineFiles);
        string[] required = { "Compet Server Manager.exe", "runtime/updater/Compet Updater.exe", "runtime/electron/resources/app/package.json", "compet-package-manifest.json" };
        if (plan.Exe != required[0]) throw new MaintenanceFailure("maintenance_plan_invalid");
        foreach (string value in required) if (!expected.ContainsKey(value)) throw new MaintenanceFailure("maintenance_plan_invalid");
        MaintenanceFile helper = expected[required[1]];
        if (helper.Size != plan.HelperSize || helper.Hash != plan.HelperHash) throw new MaintenanceFailure("maintenance_helper_invalid");
        foreach (string name in new[] { "server-data", "user-data" })
        {
            string protection = Path.Combine(plan.Root, "runtime", "electron", "resources", "app", name);
            if (!plan.ProtectedPaths.Exists(p => p.Equals(protection, StringComparison.OrdinalIgnoreCase)))
                throw new MaintenanceFailure("maintenance_path_protected");
        }
        Dictionary<string, MaintenanceFile> operations = new Dictionary<string, MaintenanceFile>(StringComparer.OrdinalIgnoreCase);
        foreach (MaintenanceFile op in plan.Files)
        {
            MaintenanceFile before, after;
            baseline.TryGetValue(op.Target, out before); expected.TryGetValue(op.Target, out after);
            if (operations.ContainsKey(op.Target) || op.BeforeExists != (before != null) ||
                (before != null && (op.BeforeSize != before.Size || op.BeforeHash != before.Hash)) ||
                (op.Delete ? after != null : after == null || op.Size != after.Size || op.Hash != after.Hash))
                throw new MaintenanceFailure("maintenance_plan_invalid");
            operations.Add(op.Target, op);
        }
        HashSet<string> all = new HashSet<string>(expected.Keys, StringComparer.OrdinalIgnoreCase);
        all.UnionWith(baseline.Keys);
        foreach (string key in all)
        {
            MaintenanceFile before, after;
            baseline.TryGetValue(key, out before); expected.TryGetValue(key, out after);
            bool changed = before == null || after == null || before.Size != after.Size || before.Hash != after.Hash;
            if (changed != operations.ContainsKey(key)) throw new MaintenanceFailure("maintenance_plan_invalid");
        }
    }

    private static Dictionary<string, MaintenanceFile> ServerCollection(MaintenancePlan plan, List<MaintenanceFile> files)
    {
        Dictionary<string, MaintenanceFile> result = new Dictionary<string, MaintenanceFile>(StringComparer.OrdinalIgnoreCase);
        foreach (MaintenanceFile file in files)
        {
            CheckServerTarget(plan, file, false);
            if (result.ContainsKey(file.Target)) throw new MaintenanceFailure("maintenance_plan_invalid");
            result.Add(file.Target, file);
        }
        foreach (string key in result.Keys)
            foreach (string other in result.Keys)
                if (!key.Equals(other, StringComparison.OrdinalIgnoreCase) && key.StartsWith(other + "/", StringComparison.OrdinalIgnoreCase))
                    throw new MaintenanceFailure("maintenance_path_invalid");
        return result;
    }

    private static string HashFile(string file)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "");
        }
    }

    private static bool Matches(string file, long size, string hash)
    {
        if (!File.Exists(file)) return false;
        FileInfo info = new FileInfo(file);
        return info.Length == size && HashFile(file) == hash;
    }

    private static string HelperPath(MaintenancePlan plan)
    {
        return Path.Combine(plan.Directory, "Compet Updater.exe");
    }

    private static void VerifyHelper(MaintenancePlan plan)
    {
        string helper = HelperPath(plan);
        CheckNoReparse(helper);
        if (!Matches(helper, plan.HelperSize, plan.HelperHash))
            throw new MaintenanceFailure("maintenance_helper_invalid");
        string running = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
        if (!running.Equals(helper, StringComparison.OrdinalIgnoreCase))
            throw new MaintenanceFailure("maintenance_helper_invalid");
    }

    private static void ValidateSources(MaintenancePlan plan, bool requireQuiet = false)
    {
        VerifyHelper(plan);
        string manifest = Path.Combine(plan.Directory, "manifest.json");
        CheckNoReparse(manifest);
        if (!File.Exists(manifest)) throw new MaintenanceFailure("maintenance_manifest_missing");
#if COMPET_SERVER_BRIDGE
        if (plan.Protocol == 4) VerifyServerTree(plan, plan.BaselineFiles, requireQuiet);
#endif
        foreach (MaintenanceFile file in plan.Files)
        {
            string source = Path.Combine(plan.Directory, file.Source.Replace('/', Path.DirectorySeparatorChar));
            string target = PlanChild(plan, file.Target);
            CheckNoReparse(source);
            CheckNoReparse(target);
            CheckServerTarget(plan, file, true);

            if (!file.Delete && !Matches(source, file.Size, file.Hash))
                throw new MaintenanceFailure("maintenance_source_invalid");
        }
    }

    private static void AtomicWrite(string destination, string content)
    {
        CheckNoReparse(destination);
        CheckNoReparse(Path.GetDirectoryName(destination));
        string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            byte[] bytes = Utf8.GetBytes(content);
            using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                output.Write(bytes, 0, bytes.Length);
                output.Flush(true);
            }
            if (File.Exists(destination)) File.Replace(temporary, destination, null);
            else File.Move(temporary, destination);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void WriteResult(MaintenancePlan plan, string state, string error, string recoveryPhase = "")
    {
        string content = "protocol=" + plan.Protocol + "\nstate=" + state + "\n";
        if (!String.IsNullOrEmpty(error)) content += "error=" + error + "\n";
        if (state == "recovery_failed")
        {
            if (recoveryPhase != "prepared" && recoveryPhase != "applying" && recoveryPhase != "applied")
                throw new MaintenanceFailure("maintenance_result_invalid");
            content += "phase=" + recoveryPhase + "\n";
        }
        AtomicWrite(Path.Combine(plan.Directory, "result.txt"), content);
    }

    private static string ReadState(MaintenancePlan plan)
    {
        string result = Path.Combine(plan.Directory, "result.txt");
        if (!File.Exists(result)) return "";
        string[] lines = File.ReadAllLines(result, Utf8);
        if (lines.Length < 2 || lines.Length > 4 || lines[0] != "protocol=" + plan.Protocol || !lines[1].StartsWith("state=", StringComparison.Ordinal))
            throw new MaintenanceFailure("maintenance_result_invalid");
        string state = lines[1].Substring(6);
        if (state != "prepared" && state != "applying" && state != "applied" &&
            state != "verified" && state != "rolled_back" && state != "recovery_failed")
            throw new MaintenanceFailure("maintenance_result_invalid");
        if (lines.Length >= 3 && (!lines[2].StartsWith("error=", StringComparison.Ordinal) ||
            !System.Text.RegularExpressions.Regex.IsMatch(lines[2].Substring(6), @"\A[a-z0-9_]+\z")))
            throw new MaintenanceFailure("maintenance_result_invalid");
        if (lines.Length == 4 && (state != "recovery_failed" ||
            (lines[3] != "phase=prepared" && lines[3] != "phase=applying" && lines[3] != "phase=applied")))
            throw new MaintenanceFailure("maintenance_result_invalid");
        return state;
    }

    private static string RecoveryPhase(MaintenancePlan plan, string state)
    {
        if (state != "recovery_failed") return state;
        string[] lines = File.ReadAllLines(Path.Combine(plan.Directory, "result.txt"), Utf8);
        string phase = "";
        for (int i = 2; i < lines.Length; i += 1)
        {
            if (!lines[i].StartsWith("phase=", StringComparison.Ordinal)) continue;
            if (phase != "") throw new MaintenanceFailure("maintenance_result_invalid");
            phase = lines[i].Substring(6);
        }
        if (phase == "") return "applied";
        if (phase != "prepared" && phase != "applying" && phase != "applied")
            throw new MaintenanceFailure("maintenance_result_invalid");
        return phase;
    }

    private static string MutexName(string root)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] bytes = sha.ComputeHash(Utf8.GetBytes(root.ToUpperInvariant()));
            return "Local\\CompetMaintenance-" + BitConverter.ToString(bytes).Replace("-", "");
        }
    }

    private static Mutex Acquire(MaintenancePlan plan)
    {
        Mutex mutex = new Mutex(false, MutexName(plan.Root));
        bool entered;
        try { entered = mutex.WaitOne(5000); }
        catch (AbandonedMutexException) { entered = true; }
        if (!entered)
        {
            mutex.Dispose();
            throw new MaintenanceFailure("maintenance_busy");
        }
        return mutex;
    }

    private static int ValidateOnly(MaintenancePlan plan)
    {
        using (Mutex mutex = Acquire(plan))
        {
            try
            {
                string state = ReadState(plan);
                if (state != "" && state != "prepared")
                    throw new MaintenanceFailure("maintenance_state_invalid");
                ValidateSources(plan);
                WriteResult(plan, "prepared", "");
                return 0;
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private static bool ProcessAlive(int pid)
    {
        try
        {
            using (Process process = Process.GetProcessById(pid))
                return !process.HasExited;
        }
        catch (ArgumentException) { return false; }
    }

    private static bool InstallationElectronAlive(MaintenancePlan plan)
    {
        string electron = Path.Combine(plan.Root, "runtime", "electron", "electron.exe");
        List<Process> processes = new List<Process>(Process.GetProcessesByName("electron"));
        string node = Path.Combine(plan.Root, "runtime", "electron", "resources", "app", "runtime", "node", "node.exe");
        if (plan.Protocol == 4) processes.AddRange(Process.GetProcessesByName("node"));
        foreach (Process process in processes)
        {
            using (process)
            {
                try
                {
                    if ((Path.GetFullPath(process.MainModule.FileName).Equals(electron, StringComparison.OrdinalIgnoreCase) ||
                        (plan.Protocol == 4 && Path.GetFullPath(process.MainModule.FileName).Equals(node, StringComparison.OrdinalIgnoreCase))) &&
                        !process.HasExited) return true;
                }
                catch (System.ComponentModel.Win32Exception)
                {
                    // A process can exit between enumeration and MainModule inspection.
                    // Only a confirmed exit makes an unreadable process safe to ignore.
                    bool exited = false;
                    try { exited = process.HasExited; }
                    catch (System.ComponentModel.Win32Exception) { }
                    catch (InvalidOperationException) { }
                    if (!exited) throw new MaintenanceFailure("maintenance_process_unknown");
                }
                catch (InvalidOperationException) { }
            }
        }
        return false;
    }

    private static void WaitForInstallationExit(MaintenancePlan plan, int pid)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(WaitTimeoutMs);
        while (ProcessAlive(pid) || InstallationElectronAlive(plan))
        {
            if (DateTime.UtcNow >= deadline)
                throw new MaintenanceFailure("maintenance_wait_timeout");
            Thread.Sleep(200);
        }
    }

    private static void CopyDurable(string source, string destination, Action onCreated = null)
    {
        CheckNoReparse(source);
        CheckNoReparse(destination);
        using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            if (onCreated != null) onCreated();
            input.CopyTo(output);
            output.Flush(true);
        }
    }

    private static void ReplaceFrom(string source, string target, long size, string hash)
    {
        string parent = Path.GetDirectoryName(target);
        CheckNoReparse(parent);
        Directory.CreateDirectory(parent);
        CheckNoReparse(parent);
        string temporary = Path.Combine(parent, ".compet-" + Guid.NewGuid().ToString("N") + ".tmp");
        CheckNoReparse(temporary);
        if (File.Exists(temporary) || Directory.Exists(temporary)) throw new MaintenanceFailure("maintenance_temporary_conflict", temporary);
        bool temporaryOwned = false;
        try
        {
            CopyDurable(source, temporary, delegate { temporaryOwned = true; });
            if (!Matches(temporary, size, hash))
                throw new MaintenanceFailure("maintenance_source_invalid");
            CheckNoReparse(target);
            if (File.Exists(target)) File.Replace(temporary, target, null);
            else File.Move(temporary, target);
        }
        finally
        {
            if (temporaryOwned && File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void WriteJournal(MaintenancePlan plan, List<JournalEntry> entries)
    {
        StringBuilder text = new StringBuilder("protocol=" + plan.Protocol + "\n");
        foreach (JournalEntry entry in entries)
        {
            text.Append("entry=").Append(Encode(entry.Target)).Append('\t')
                .Append(entry.Existed ? "1" : "0").Append('\t')
                .Append(Encode(entry.Backup)).Append('\t')
                .Append(entry.Size.ToString(CultureInfo.InvariantCulture)).Append('\t')
                .Append(entry.Hash);
            text.Append('\n');
        }
        AtomicWrite(Path.Combine(plan.Directory, "journal.txt"), text.ToString());
    }

    private static List<JournalEntry> ReadJournal(MaintenancePlan plan, bool required, bool complete)
    {
        string journal = Path.Combine(plan.Directory, "journal.txt");
        List<JournalEntry> entries = new List<JournalEntry>();
        if (!File.Exists(journal))
        {
            if (required) throw new MaintenanceFailure("maintenance_journal_invalid");
            return entries;
        }
        string[] lines = File.ReadAllLines(journal, Utf8);
        if (lines.Length == 0 || lines[0] != "protocol=" + plan.Protocol)
            throw new MaintenanceFailure("maintenance_journal_invalid");
        if (lines.Length > plan.Files.Count + 1 || (complete && lines.Length != plan.Files.Count + 1))
            throw new MaintenanceFailure("maintenance_journal_invalid");
        for (int i = 1; i < lines.Length; i += 1)
        {
            string line = lines[i];
            if (!line.StartsWith("entry=", StringComparison.Ordinal))
                throw new MaintenanceFailure("maintenance_journal_invalid");
            string[] fields = line.Substring(6).Split('\t');
            if (fields.Length != 5) throw new MaintenanceFailure("maintenance_journal_invalid");
            JournalEntry entry = new JournalEntry();
            entry.Target = Decode(fields[0]);
            entry.Existed = fields[1] == "1";
            if (fields[1] != "0" && fields[1] != "1")
                throw new MaintenanceFailure("maintenance_journal_invalid");
            entry.Backup = Decode(fields[2]);
            entry.Size = ParseSize(fields[3]);
            entry.Hash = ParseHash(fields[4]);
            PlanChild(plan, entry.Target);
            CheckRelative(entry.Backup);
            if (!entry.Target.Equals(plan.Files[i - 1].Target, StringComparison.OrdinalIgnoreCase) ||
                entry.Backup != "backup/" + (i - 1).ToString(CultureInfo.InvariantCulture) + ".bin")
                throw new MaintenanceFailure("maintenance_journal_invalid");
            entries.Add(entry);
        }
        return entries;
    }

    private static void Restore(MaintenancePlan plan, bool requireJournal, bool requireComplete)
    {
        List<JournalEntry> entries = ReadJournal(plan, requireJournal, requireComplete);
        for (int i = entries.Count - 1; i >= 0; i -= 1)
        {
            JournalEntry entry = entries[i];
            string target = PlanChild(plan, entry.Target);
            CheckNoReparse(target);
            CheckServerTarget(plan, plan.Files[i], false);
            if (entry.Existed)
            {
                string backup = Path.Combine(plan.Directory, entry.Backup.Replace('/', Path.DirectorySeparatorChar));
                CheckNoReparse(backup);
                if (!Matches(backup, entry.Size, entry.Hash))
                    throw new MaintenanceFailure("maintenance_backup_invalid");
                if (!Matches(target, entry.Size, entry.Hash))
                    ReplaceFrom(backup, target, entry.Size, entry.Hash);
                if (!Matches(target, entry.Size, entry.Hash))
                    throw new MaintenanceFailure("maintenance_recovery_failed");
            }
            else
            {
                if (Directory.Exists(target)) throw new MaintenanceFailure("maintenance_recovery_failed");
                if (File.Exists(target)) File.Delete(target);
            }
        }
    }

    private static int Recover(MaintenancePlan plan, int? pid)
    {
        using (Mutex mutex = Acquire(plan))
        {
            string phase = "applied";
            try
            {
                string state = ReadState(plan);
                phase = RecoveryPhase(plan, state);
                VerifyHelper(plan);
                if (state == "verified" || state == "rolled_back") return 0;
                if (state != "prepared" && state != "applying" && state != "applied" && state != "recovery_failed")
                    throw new MaintenanceFailure("maintenance_state_invalid");
                WaitForInstallationExit(plan, pid ?? -1);
                Restore(plan, phase != "prepared", phase == "applied");
                WriteResult(plan, "rolled_back", "maintenance_interrupted");
            }
            catch
            {
                try { WriteResult(plan, "recovery_failed", "maintenance_recovery_failed", phase); }
                catch { }
                return 1;
            }
            finally { mutex.ReleaseMutex(); }
        }
        if (pid.HasValue)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = PlanChild(plan, plan.Exe),
                    WorkingDirectory = plan.Root,
                    UseShellExecute = true,
                });
            }
            catch { return 1; }
        }
        return 0;
    }

    private static int Apply(MaintenancePlan plan, int pid)
    {
        using (Mutex mutex = Acquire(plan))
        {
            bool applying = false;
            bool fullyApplied = false;
            try
            {
                ValidateSources(plan);
                if (ReadState(plan) != "prepared")
                    throw new MaintenanceFailure("maintenance_state_invalid");
                WaitForInstallationExit(plan, pid);
                ValidateSources(plan, true);
                WriteResult(plan, "applying", "");
                applying = true;
                List<JournalEntry> entries = new List<JournalEntry>();
                WriteJournal(plan, entries);
                Directory.CreateDirectory(Path.Combine(plan.Directory, "backup"));
                foreach (MaintenanceFile file in plan.Files)
                {
                    string target = PlanChild(plan, file.Target);
                    string source = Path.Combine(plan.Directory, file.Source.Replace('/', Path.DirectorySeparatorChar));
                    CheckNoReparse(target);
                    CheckNoReparse(source);
                    if (!Matches(source, file.Size, file.Hash))
                        throw new MaintenanceFailure("maintenance_source_invalid");
                    if (Directory.Exists(target))
                        throw new MaintenanceFailure("maintenance_path_invalid");
                    bool existed = File.Exists(target);
                    if (existed)
                    {
                        using (FileStream probe = new FileStream(target, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                    }
                    JournalEntry entry = new JournalEntry();
                    entry.Target = file.Target;
                    entry.Existed = existed;
                    entry.Backup = "backup/" + entries.Count.ToString(CultureInfo.InvariantCulture) + ".bin";
                    if (existed)
                    {
                        string backup = Path.Combine(plan.Directory, entry.Backup.Replace('/', Path.DirectorySeparatorChar));
                        CopyDurable(target, backup);
                        entry.Size = new FileInfo(backup).Length;
                        entry.Hash = HashFile(backup);
                    }
                    else
                    {
                        entry.Size = 0;
                        entry.Hash = new string('0', 64);
                    }
                    entries.Add(entry);
                    WriteJournal(plan, entries);
                    // intent durable
                    ReplaceFrom(source, target, file.Size, file.Hash);
                    if (!Matches(target, file.Size, file.Hash))
                        throw new MaintenanceFailure("maintenance_target_invalid");
                }
                fullyApplied = true;
                WriteResult(plan, "applied", "");
                Process.Start(new ProcessStartInfo
                {
                    FileName = PlanChild(plan, plan.Exe),
                    WorkingDirectory = plan.Root,
                    UseShellExecute = true,
                });
                return 0;
            }
            catch (Exception error)
            {
                string code = error is MaintenanceFailure ? ((MaintenanceFailure)error).Code :
                    applying ? "maintenance_apply_failed" : "maintenance_preparation_failed";
                try
                {
                    if (applying) {
                        Restore(plan, true, fullyApplied);
                    }
                    WriteResult(plan, "rolled_back", code);
                }
                catch
                {
                    try { WriteResult(plan, "recovery_failed", "maintenance_recovery_failed",
                        fullyApplied ? "applied" : applying ? "applying" : "prepared"); }
                    catch { }
                }
                return 1;
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private static int RunLegacy(string planPath, int pid)
    {
        try
        {
            try
            {
                using (Process process = Process.GetProcessById(pid))
                    process.WaitForExit(30000);
            }
            catch { Thread.Sleep(1000); }
            string[] lines = File.ReadAllLines(planPath);
            if (lines.Length < 2 || !lines[0].StartsWith("root=", StringComparison.Ordinal) ||
                !lines[1].StartsWith("exe=", StringComparison.Ordinal)) return 1;
            string root = Path.GetFullPath(lines[0].Substring(5));
            string exe = lines[1].Substring(4);
            for (int i = 2; i < lines.Length; i += 1)
            {
                if (String.IsNullOrWhiteSpace(lines[i])) continue;
                string[] parts = lines[i].Split(new[] { '\t' }, 2);
                if (parts.Length != 2) return 1;
                string source = Path.GetFullPath(parts[0]);
                string target = Path.GetFullPath(Path.Combine(root, parts[1].Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase)) return 1;
                Directory.CreateDirectory(Path.GetDirectoryName(target));
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
        catch { return 1; }
    }

#if COMPET_SERVER_BRIDGE
    private static void ServerError(string code, string path)
    {
        throw new MaintenanceFailure(code, path);
    }

    private static void VerifyInstalledHelper(MaintenancePlan plan, bool targetOnly)
    {
        string expectedPath = PlanChild(plan, "runtime/updater/Compet Updater.exe");
        string running = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
        CheckNoReparse(expectedPath);
        if (!running.Equals(expectedPath, StringComparison.OrdinalIgnoreCase)) ServerError("maintenance_helper_invalid", running);
        if (Matches(running, plan.HelperSize, plan.HelperHash)) return;
        if (!targetOnly) foreach (MaintenanceFile file in plan.BaselineFiles)
            if (file.Target.Equals("runtime/updater/Compet Updater.exe", StringComparison.OrdinalIgnoreCase) && Matches(running, file.Size, file.Hash)) return;
        ServerError("maintenance_helper_invalid", running);
    }

    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }

    private static void AssertInstallationQuiet(MaintenancePlan plan)
    {
        if (InstallationElectronAlive(plan)) ServerError("maintenance_process_busy", plan.Root);
        ValidateCurrentServerBoundaries(plan);
    }

    private static bool ServerPathsOverlap(string left, string right)
    {
        left = left.TrimEnd(Path.DirectorySeparatorChar);
        right = right.TrimEnd(Path.DirectorySeparatorChar);
        return left.Equals(right, StringComparison.OrdinalIgnoreCase) ||
            left.StartsWith(right + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            right.StartsWith(left + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static void ValidateCurrentServerBoundaries(MaintenancePlan plan)
    {
        string appRoot = Path.Combine(plan.Root, "runtime", "electron", "resources", "app");
        string configPath = Path.Combine(appRoot, "user-data", "manager-config.json");
        CheckNoReparse(configPath);
        string dataDir = Path.Combine(appRoot, "server-data"), gameRoot = "";
        if (File.Exists(configPath))
        {
            Dictionary<string, object> config;
            try { config = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(File.ReadAllText(configPath, Utf8)) as Dictionary<string, object>; }
            catch { throw new MaintenanceFailure("maintenance_config_invalid", configPath); }
            if (config == null) ServerError("maintenance_config_invalid", configPath);
            object value;
            if (config.TryGetValue("dataDir", out value)) {
                if (!(value is string)) ServerError("maintenance_config_invalid", configPath);
                dataDir = (string)value;
            }
            if (config.TryGetValue("serverRoot", out value)) {
                if (!(value is string)) ServerError("maintenance_config_invalid", configPath);
                gameRoot = (string)value;
            }
        }
        for (int boundary = 0; boundary < 2; boundary++)
        {
            string value = boundary == 0 ? dataDir : gameRoot;
            if (boundary == 1 && value == "") continue;
            if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value) || Path.GetPathRoot(value) != Path.GetPathRoot(Path.GetFullPath(value)))
                ServerError("maintenance_config_invalid", configPath);
            string absolute = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
            CheckNoReparse(absolute);
            if (boundary == 1) {
                if (ServerPathsOverlap(absolute, plan.Root)) ServerError("maintenance_path_protected", absolute);
                continue;
            }
            foreach (MaintenanceFile file in plan.ExpectedFiles)
                if (ServerPathsOverlap(absolute, PlanChild(plan, file.Target))) ServerError("maintenance_path_protected", absolute);
            foreach (MaintenanceFile file in plan.BaselineFiles)
                if (ServerPathsOverlap(absolute, PlanChild(plan, file.Target))) ServerError("maintenance_path_protected", absolute);
            foreach (string name in new[] { ".compet-maintenance", ".compet-maintenance-staging", ".compet-maintenance-retired" })
                if (ServerPathsOverlap(absolute, Path.Combine(plan.Root, name))) ServerError("maintenance_path_protected", absolute);
            if (ServerPathsOverlap(absolute, plan.Root) && !ProtectedDirectory(plan, absolute)) ServerError("maintenance_config_changed", absolute);
        }
    }

    private static Dictionary<string, MaintenanceFile> ScanServerFiles(MaintenancePlan plan)
    {
        Dictionary<string, MaintenanceFile> files = new Dictionary<string, MaintenanceFile>(StringComparer.OrdinalIgnoreCase);
        ScanServerDirectory(plan, plan.Root, files);
        return files;
    }

    private static bool ProtectedDirectory(MaintenancePlan plan, string absolute)
    {
        foreach (string protection in plan.ProtectedPaths)
            if (absolute.Equals(protection, StringComparison.OrdinalIgnoreCase) || absolute.StartsWith(protection.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static void ScanServerDirectory(MaintenancePlan plan, string directory, Dictionary<string, MaintenanceFile> files)
    {
        CheckNoReparse(directory);
        foreach (string absolute in Directory.GetFileSystemEntries(directory))
        {
            CheckNoReparse(absolute);
            if (absolute.Equals(plan.Directory, StringComparison.OrdinalIgnoreCase)) continue;
            if (ProtectedDirectory(plan, absolute)) continue;
            string relative = absolute.Substring(plan.Root.TrimEnd(Path.DirectorySeparatorChar).Length + 1).Replace(Path.DirectorySeparatorChar, '/');
            CheckRelative(relative, true);
            if (Directory.Exists(absolute)) ScanServerDirectory(plan, absolute, files);
            else {
                if (files.ContainsKey(relative)) ServerError("maintenance_path_invalid", absolute);
                files.Add(relative, new MaintenanceFile { Target = relative, Size = new FileInfo(absolute).Length, Hash = HashFile(absolute) });
            }
        }
    }

    private static void VerifyServerTree(MaintenancePlan plan, List<MaintenanceFile> expected, bool requireQuiet = true)
    {
        if (requireQuiet) AssertInstallationQuiet(plan); else ValidateCurrentServerBoundaries(plan);
        Dictionary<string, MaintenanceFile> actual = ScanServerFiles(plan);
        foreach (MaintenanceFile file in expected) {
            MaintenanceFile found;
            if (!actual.TryGetValue(file.Target, out found) || found.Size != file.Size || found.Hash != file.Hash) ServerError("maintenance_verification_failed", PlanChild(plan, file.Target));
            actual.Remove(file.Target);
        }
        foreach (string extra in actual.Keys) ServerError("maintenance_unexpected_file", PlanChild(plan, extra));
    }

#endif
}