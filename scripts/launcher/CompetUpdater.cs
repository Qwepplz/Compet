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
    internal MaintenanceFailure(string code) : base(code) { Code = code; }
}

internal sealed class MaintenanceFile
{
    internal string Source = "";
    internal string Target = "";
    internal long Size;
    internal string Hash = "";
}

internal sealed class MaintenancePlan
{
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

internal static class CompetUpdater
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private const int WaitTimeoutMs = 120000;

    private static int Main(string[] args)
    {
        try
        {
            string planPath = GetArg(args, "--plan");
            string[] lines = File.ReadAllLines(planPath, Utf8);
            if (lines.Length == 0) return 1;
            if (lines[0] != "protocol=2")
            {
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

    private static void CheckRelative(string value)
    {
        if (String.IsNullOrEmpty(value) || value.IndexOf('\\') >= 0 || Path.IsPathRooted(value))
            throw new MaintenanceFailure("maintenance_path_invalid");
        string[] parts = value.Split('/');
        if (parts[0].StartsWith(".compet-maintenance", StringComparison.OrdinalIgnoreCase))
            throw new MaintenanceFailure("maintenance_path_invalid");
        foreach (string part in parts)
        {
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

    private static string RootChild(string root, string relative)
    {
        CheckRelative(relative);
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
                throw new MaintenanceFailure("maintenance_path_linked");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }

    private static MaintenancePlan ParsePlan(string planPath, string[] lines, bool allowStaging)
    {
        if (lines.Length < 5 || lines[0] != "protocol=2" ||
            !lines[1].StartsWith("root=", StringComparison.Ordinal) ||
            !lines[2].StartsWith("exe=", StringComparison.Ordinal) ||
            !lines[3].StartsWith("target=", StringComparison.Ordinal) ||
            !lines[4].StartsWith("helper=", StringComparison.Ordinal))
            throw new MaintenanceFailure("maintenance_plan_invalid");
        MaintenancePlan plan = new MaintenancePlan();
        plan.Directory = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(planPath)));
        string directoryName = Path.GetFileName(plan.Directory);
        if (!directoryName.Equals(".compet-maintenance", StringComparison.OrdinalIgnoreCase) &&
            !(allowStaging && directoryName.Equals(".compet-maintenance-staging", StringComparison.OrdinalIgnoreCase)))
            throw new MaintenanceFailure("maintenance_plan_invalid");
        plan.Root = Decode(lines[1].Substring(5));
        if (!Path.IsPathRooted(plan.Root) || !Path.GetFullPath(plan.Root).Equals(plan.Root, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetDirectoryName(plan.Directory).Equals(plan.Root, StringComparison.OrdinalIgnoreCase))
            throw new MaintenanceFailure("maintenance_plan_invalid");
        plan.Exe = Decode(lines[2].Substring(4));
        plan.Version = Decode(lines[3].Substring(7));
        CheckRelative(plan.Exe);
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
            RootChild(plan.Root, file.Target);
            if (file.Source != "files/" + file.Hash || !targets.Add(file.Target))
                throw new MaintenanceFailure("maintenance_plan_invalid");
            plan.Files.Add(file);
        }
        CheckNoReparse(plan.Root);
        CheckNoReparse(plan.Directory);
        return plan;
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

    private static void ValidateSources(MaintenancePlan plan)
    {
        VerifyHelper(plan);
        string manifest = Path.Combine(plan.Directory, "manifest.json");
        CheckNoReparse(manifest);
        if (!File.Exists(manifest)) throw new MaintenanceFailure("maintenance_manifest_missing");
        foreach (MaintenanceFile file in plan.Files)
        {
            string source = Path.Combine(plan.Directory, file.Source.Replace('/', Path.DirectorySeparatorChar));
            string target = RootChild(plan.Root, file.Target);
            CheckNoReparse(source);
            CheckNoReparse(target);
            if (!Matches(source, file.Size, file.Hash))
                throw new MaintenanceFailure("maintenance_source_invalid");
        }
    }

    private static void AtomicWrite(string destination, string content)
    {
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
        string content = "protocol=2\nstate=" + state + "\n";
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
        if (lines.Length < 2 || lines[0] != "protocol=2" || !lines[1].StartsWith("state=", StringComparison.Ordinal))
            throw new MaintenanceFailure("maintenance_result_invalid");
        return lines[1].Substring(6);
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
        foreach (Process process in Process.GetProcessesByName("electron"))
        {
            using (process)
            {
                try
                {
                    if (Path.GetFullPath(process.MainModule.FileName).Equals(electron, StringComparison.OrdinalIgnoreCase) &&
                        !process.HasExited) return true;
                }
                catch (System.ComponentModel.Win32Exception)
                {
                    throw new MaintenanceFailure("maintenance_process_unknown");
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

    private static void CopyDurable(string source, string destination)
    {
        using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
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
        try
        {
            CopyDurable(source, temporary);
            if (!Matches(temporary, size, hash))
                throw new MaintenanceFailure("maintenance_source_invalid");
            CheckNoReparse(target);
            if (File.Exists(target)) File.Replace(temporary, target, null);
            else File.Move(temporary, target);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void WriteJournal(MaintenancePlan plan, List<JournalEntry> entries)
    {
        StringBuilder text = new StringBuilder("protocol=2\n");
        foreach (JournalEntry entry in entries)
        {
            text.Append("entry=").Append(Encode(entry.Target)).Append('\t')
                .Append(entry.Existed ? "1" : "0").Append('\t')
                .Append(Encode(entry.Backup)).Append('\t')
                .Append(entry.Size.ToString(CultureInfo.InvariantCulture)).Append('\t')
                .Append(entry.Hash).Append('\n');
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
        if (lines.Length == 0 || lines[0] != "protocol=2")
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
            RootChild(plan.Root, entry.Target);
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
            string target = RootChild(plan.Root, entry.Target);
            CheckNoReparse(target);
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
                    FileName = RootChild(plan.Root, plan.Exe),
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
                WriteResult(plan, "applying", "");
                applying = true;
                List<JournalEntry> entries = new List<JournalEntry>();
                WriteJournal(plan, entries);
                Directory.CreateDirectory(Path.Combine(plan.Directory, "backup"));
                foreach (MaintenanceFile file in plan.Files)
                {
                    string target = RootChild(plan.Root, file.Target);
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
                    ReplaceFrom(source, target, file.Size, file.Hash);
                    if (!Matches(target, file.Size, file.Hash))
                        throw new MaintenanceFailure("maintenance_target_invalid");
                }
                fullyApplied = true;
                WriteResult(plan, "applied", "");
                Process.Start(new ProcessStartInfo
                {
                    FileName = RootChild(plan.Root, plan.Exe),
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
                    if (applying) Restore(plan, true, fullyApplied);
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
}
