
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
