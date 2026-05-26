$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$artifacts = Join-Path $repo "artifacts"
$stagingRoot = Join-Path $artifacts "staging"
$stage = Join-Path $stagingRoot "Compet-Client"
$appRoot = Join-Path $stage "resources\app"
$archive = Join-Path $artifacts "Compet-Client.7z"
$archiveTmp = "$archive.tmp"
$supersededZip = Join-Path $artifacts "Compet-Client.zip"
$supersededTarXz = Join-Path $artifacts "Compet-Client.tar.xz"
$electronDist = Join-Path $repo "node_modules\electron\dist"
$clientExe = "Compet Player Client.exe"
$rcedit = Join-Path $repo "node_modules\rcedit\bin\rcedit-x64.exe"
$preferred7z = "E:\EXCHANGE\github-C\lzma2600\bin\x64\7zr.exe"

function Get-ArchiveEntryPath {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$FilePath
  )

  $root = [System.IO.Path]::GetFullPath($RootDir)
  $path = [System.IO.Path]::GetFullPath($FilePath)
  if (-not $path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "File path is outside the stage directory: $FilePath"
  }

  return $path.Substring($root.Length).TrimStart('\').Replace('\', '/')
}

function Get-SevenZipCommand {
  if ($env:COMPET_7Z -and (Test-Path -LiteralPath $env:COMPET_7Z)) {
    return $env:COMPET_7Z
  }
  if (Test-Path -LiteralPath $preferred7z) {
    return $preferred7z
  }

  foreach ($commandName in @("7zr.exe", "7z.exe", "7za.exe")) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  throw "7z executable not found. Set COMPET_7Z or install 7z/7zr."
}

function Get-PackageVersion {
  $packageJson = Get-Content -LiteralPath (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
  $version = [string]$packageJson.version
  if ($version -match '^\d+\.\d+\.\d+$') {
    return "$version.0"
  }
  return $version
}

function Set-ExeVersionInfo {
  param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$Description,
    [Parameter(Mandatory = $true)][string]$ProductName,
    [Parameter(Mandatory = $true)][string]$OriginalFilename,
    [Parameter(Mandatory = $true)][string]$InternalName
  )

  if (-not (Test-Path -LiteralPath $rcedit)) {
    throw "Missing rcedit executable: $rcedit"
  }

  $version = Get-PackageVersion
  & $rcedit $ExePath `
    --set-version-string "CompanyName" "Qwepplz" `
    --set-version-string "FileDescription" $Description `
    --set-version-string "ProductName" $ProductName `
    --set-version-string "OriginalFilename" $OriginalFilename `
    --set-version-string "InternalName" $InternalName `
    --set-version-string "LegalCopyright" "Copyright (C) 2026 Qwepplz" `
    --set-file-version $version `
    --set-product-version $version
  if ($LASTEXITCODE -ne 0) { throw "rcedit failed with exit code $LASTEXITCODE" }
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

  $sevenZip = Get-SevenZipCommand
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

function Remove-UnusedElectronFiles {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir
  )

  Get-ChildItem -LiteralPath $RootDir -File -Filter "*.log" -ErrorAction SilentlyContinue |
    Remove-Item -Force

  Remove-Item -LiteralPath (Join-Path $RootDir "resources\default_app.asar") -Force -ErrorAction SilentlyContinue

  $localeDir = Join-Path $RootDir "locales"
  if (Test-Path -LiteralPath $localeDir) {
    Get-ChildItem -LiteralPath $localeDir -File |
      Where-Object { $_.Name -notin @("en-US.pak", "zh-CN.pak") } |
      Remove-Item -Force
  }

}

Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
foreach ($staleArtifact in @($archive, $archiveTmp, $supersededZip, $supersededTarXz)) {
  Remove-Item -LiteralPath $staleArtifact -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $staleArtifact) {
    throw "Unable to remove stale package artifact: $staleArtifact"
  }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$required = @("out-player\main", "out-player\preload", "out-player\renderer", "packaging\client", "node_modules\electron\dist")
foreach ($relative in $required) {
  $path = Join-Path $repo $relative
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $relative" }
}

Copy-Item -Path (Join-Path $electronDist "*") -Destination $stage -Recurse
$clientExePath = Join-Path $stage $clientExe
Move-Item -LiteralPath (Join-Path $stage "electron.exe") -Destination $clientExePath
Set-ExeVersionInfo `
  -ExePath $clientExePath `
  -Description "Compet Player Client" `
  -ProductName "Compet Player Client" `
  -OriginalFilename $clientExe `
  -InternalName "Compet Player Client"
Remove-UnusedElectronFiles -RootDir $stage
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $repo "out-player") -Destination $appRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repo "packaging\client\app-package.json") -Destination (Join-Path $appRoot "package.json")
Copy-Item -LiteralPath (Join-Path $repo "packaging\client\README.txt") -Destination $stage
Copy-Item -LiteralPath (Join-Path $repo "packaging\client\start-player-client.cmd") -Destination $stage

New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$requiredArchiveEntries = @(
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $stage $clientExe)),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $stage "ffmpeg.dll")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $stage "README.txt")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $stage "start-player-client.cmd")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "package.json")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out-player\main\index.cjs")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out-player\preload\index.js")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out-player\renderer\index.html"))
)
$forbiddenArchiveEntryPatterns = @(
  "*/.git/*",
  "*/default_app.asar",
  "*/package-lock.json",
  "*/recent-maps.json",
  "*/server-data*",
  "*/src/*",
  "*/tests/*",
  "*/scripts/*",
  "*/sourcemod/*",
  "*/tsconfig*.json",
  "*.map",
  "*.tmp"
)
New-Validated7zArchive -SourceDir $stage -ArchivePath $archive -RequiredEntries $requiredArchiveEntries -ForbiddenEntryPatterns $forbiddenArchiveEntryPatterns
Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Created $archive"
