
function Get-ArchiveEntryPath {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$FilePath
  )

  $root = [System.IO.Path]::GetFullPath($RootDir)
  $path = [System.IO.Path]::GetFullPath($FilePath)
  $relative = [System.IO.Path]::GetRelativePath($root, $path)
  if ([System.IO.Path]::IsPathRooted($relative) -or $relative -eq ".." -or
      $relative.StartsWith("../") -or $relative.StartsWith("..\")) {
    throw "File path is outside the stage directory: $FilePath"
  }

  return $relative.Replace('\', '/')
}

function Get-SevenZipCommand {
  param([Parameter(Mandatory = $true)][string]$SevenZipPath)

  if (Test-Path -LiteralPath $SevenZipPath) {
    return $SevenZipPath
  }
  throw "Packaging 7z executable not found: $SevenZipPath"
}

function Convert-ArchivePath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $entry = $Path.Trim().Replace('\', '/')
  while ($entry.StartsWith("./", [System.StringComparison]::Ordinal)) {
    $entry = $entry.Substring(2)
  }
  return $entry
}

function New-Validated7zArchive {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$SevenZipPath,
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string[]]$RequiredEntries,
    [string[]]$ForbiddenEntryPatterns = @()
  )

  Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$ArchivePath.tmp" -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $ArchivePath) {
    throw "Unable to remove stale archive before packaging: $ArchivePath"
  }

  $stageFileCount = (Get-ChildItem -LiteralPath $SourceDir -Recurse -File | Measure-Object).Count
  if ($stageFileCount -lt $RequiredEntries.Count) {
    throw "Stage directory is missing expected files: $SourceDir"
  }

  $sevenZip = Get-SevenZipCommand -SevenZipPath $SevenZipPath
  try {
    Push-Location $SourceDir
    try {
      & $sevenZip a -t7z $ArchivePath ".\*" -r -mx=9 -m0=LZMA2:d=128m:fb=273 -ms=on -mmt=on -bb0 -bd -y
      if ($LASTEXITCODE -ne 0) { throw "7z archive creation failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }

    & $sevenZip t $ArchivePath -bb0 -bd -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z archive verification failed with exit code $LASTEXITCODE" }

    $archiveSelfPath = Convert-ArchivePath -Path ([System.IO.Path]::GetFullPath($ArchivePath))
    $entries = @(
      & $sevenZip l -slt $ArchivePath |
        Where-Object { $_.StartsWith("Path = ", [System.StringComparison]::Ordinal) } |
        ForEach-Object { Convert-ArchivePath -Path $_.Substring(7) } |
        Where-Object { $_ -and $_ -ne $archiveSelfPath }
    )

    $missing = New-Object System.Collections.Generic.List[string]
    foreach ($requiredEntry in $RequiredEntries) {
      if (-not ($entries -contains $requiredEntry)) {
        [void]$missing.Add($requiredEntry)
      }
    }
    if ($missing.Count -gt 0) {
      throw "Archive verification failed. Missing entries: $($missing -join ', ')"
    }

    $forbidden = @(
      foreach ($entry in $entries) {
        foreach ($pattern in $ForbiddenEntryPatterns) {
          if ($entry -like $pattern) { $entry; break }
        }
      }
    )
    if ($forbidden.Count -gt 0) {
      throw "Archive verification failed. Forbidden entries: $($forbidden -join ', ')"
    }
  } catch {
    Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$ArchivePath.tmp" -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Initialize-ExecutableIconVerifier {
  if ("CompetExecutableIcon" -as [type]) { return }
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "client_platform_unsupported" }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class CompetExecutableIcon
{
    private sealed class Frame
    {
        internal byte[] Header;
        internal byte[] Image;
    }

    private delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
    private delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceNamesW(IntPtr module, IntPtr type, NameCallback callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LockResource(IntPtr resource);

    private static byte[] Slice(byte[] value, int offset, int count)
    {
        if (offset < 0 || count < 0 || offset > value.Length - count) throw new InvalidDataException("app_icon_invalid");
        byte[] result = new byte[count];
        Buffer.BlockCopy(value, offset, result, 0, count);
        return result;
    }

    private static bool Equal(byte[] left, byte[] right)
    {
        if (left.Length != right.Length) return false;
        for (int index = 0; index < left.Length; index++) if (left[index] != right[index]) return false;
        return true;
    }

    private static Dictionary<int, Frame> ReadIcon(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        if (bytes.Length < 6 || BitConverter.ToUInt16(bytes, 0) != 0 ||
            BitConverter.ToUInt16(bytes, 2) != 1 || BitConverter.ToUInt16(bytes, 4) != 7)
            throw new InvalidDataException("app_icon_invalid");
        var frames = new Dictionary<int, Frame>();
        for (int index = 0; index < 7; index++)
        {
            byte[] entry = Slice(bytes, 6 + index * 16, 16);
            int width = entry[0] == 0 ? 256 : entry[0];
            int height = entry[1] == 0 ? 256 : entry[1];
            uint length = BitConverter.ToUInt32(entry, 8), offset = BitConverter.ToUInt32(entry, 12);
            if (width != height || frames.ContainsKey(width) || length > int.MaxValue || offset > int.MaxValue ||
                offset < 118 || length == 0) throw new InvalidDataException("app_icon_invalid");
            frames.Add(width, new Frame { Header = Slice(entry, 0, 12), Image = Slice(bytes, (int)offset, (int)length) });
        }
        foreach (int size in new[] { 16, 24, 32, 48, 64, 128, 256 })
            if (!frames.ContainsKey(size)) throw new InvalidDataException("app_icon_invalid");
        return frames;
    }

    public static void ValidateIconSource(string path) { ReadIcon(path); }

    private static byte[] ReadResource(IntPtr module, int type, IntPtr name, ushort language)
    {
        IntPtr resource = FindResourceExW(module, new IntPtr(type), name, language);
        if (resource == IntPtr.Zero) throw new InvalidDataException("executable_icon_mismatch: missing resource");
        uint size = SizeofResource(module, resource);
        IntPtr bytes = LockResource(LoadResource(module, resource));
        if (size == 0 || size > int.MaxValue || bytes == IntPtr.Zero)
            throw new InvalidDataException("executable_icon_mismatch: invalid resource");
        byte[] result = new byte[(int)size];
        Marshal.Copy(bytes, result, 0, result.Length);
        return result;
    }

    public static void Verify(string executable, string icon)
    {
        Dictionary<int, Frame> frames = ReadIcon(icon);
        IntPtr module = LoadLibraryExW(executable, IntPtr.Zero, 0x22);
        if (module == IntPtr.Zero) throw new InvalidDataException("executable_icon_invalid");
        try
        {
            Exception failure = null;
            int groups = 0;
            NameCallback names = (handle, type, name, parameter) =>
            {
                LanguageCallback languages = (image, resourceType, resourceName, language, unused) =>
                {
                    try
                    {
                        byte[] group = ReadResource(image, 14, resourceName, language);
                        if (group.Length != 104 || BitConverter.ToUInt16(group, 0) != 0 ||
                            BitConverter.ToUInt16(group, 2) != 1 || BitConverter.ToUInt16(group, 4) != 7)
                            throw new InvalidDataException("executable_icon_mismatch: group dimensions");
                        var seen = new HashSet<int>();
                        for (int index = 0; index < 7; index++)
                        {
                            byte[] entry = Slice(group, 6 + index * 14, 14);
                            int size = entry[0] == 0 ? 256 : entry[0];
                            Frame frame;
                            if (!seen.Add(size) || !frames.TryGetValue(size, out frame) || !Equal(Slice(entry, 0, 12), frame.Header))
                                throw new InvalidDataException("executable_icon_mismatch: group layer");
                            ushort id = BitConverter.ToUInt16(entry, 12);
                            if (!Equal(ReadResource(image, 3, new IntPtr(id), language), frame.Image))
                                throw new InvalidDataException("executable_icon_mismatch: layer bytes");
                        }
                        groups++;
                        return true;
                    }
                    catch (Exception error) { failure = error; return false; }
                };
                if (!EnumResourceLanguagesW(handle, type, name, languages, IntPtr.Zero) && failure == null)
                    failure = new InvalidDataException("executable_icon_mismatch: languages");
                return failure == null;
            };
            bool enumerated = EnumResourceNamesW(module, new IntPtr(14), names, IntPtr.Zero);
            if (failure != null) throw failure;
            if (!enumerated || groups == 0) throw new InvalidDataException("executable_icon_mismatch: no main icon");
        }
        finally { FreeLibrary(module); }
    }
}
'@
}

function Assert-ExecutableIcon {
  param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$IconPath
  )
  if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf)) { throw "app_icon_missing" }
  if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { throw "executable_icon_invalid" }
  Initialize-ExecutableIconVerifier
  [CompetExecutableIcon]::Verify([IO.Path]::GetFullPath($ExePath), [IO.Path]::GetFullPath($IconPath))
}

function Set-ExeIcon {
  param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$IconPath
  )
  if (-not (Test-Path -LiteralPath $rcedit -PathType Leaf)) { throw "Missing rcedit executable: $rcedit" }
  if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { throw "Missing executable: $ExePath" }
  if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf)) { throw "app_icon_missing" }
  & $rcedit $ExePath --set-icon $IconPath
  if ($LASTEXITCODE -ne 0) { throw "rcedit icon update failed with exit code $LASTEXITCODE" }
  Assert-ExecutableIcon -ExePath $ExePath -IconPath $IconPath
}
