$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$artifacts = Join-Path $repo "artifacts"
$stagingRoot = Join-Path $artifacts "staging"
$stage = Join-Path $stagingRoot "Compet-Server"
$appRoot = Join-Path $stage "resources\app"
$archive = Join-Path $artifacts "Compet-Server.7z"
$legacyZip = Join-Path $artifacts "Compet-Server.zip"
$legacyTarXz = Join-Path $artifacts "Compet-Server.tar.xz"
$electronDist = Join-Path $repo "node_modules\electron\dist"
$serverExe = "Compet Server Manager.exe"
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
    [Parameter(Mandatory = $true)][string[]]$RequiredEntries
  )

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
  } catch {
    Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Copy-NodeModulePackage {
  param(
    [Parameter(Mandatory = $true)][string]$PackageName
  )

  $source = Join-Path $repo "node_modules\$PackageName"
  if (-not (Test-Path -LiteralPath (Join-Path $source "package.json"))) {
    throw "Missing runtime package: $PackageName"
  }

  $destination = Join-Path $appRoot "node_modules\$PackageName"
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse
}

function Remove-UnusedElectronFiles {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir
  )

  $localeDir = Join-Path $RootDir "locales"
  if (Test-Path -LiteralPath $localeDir) {
    Get-ChildItem -LiteralPath $localeDir -File |
      Where-Object { $_.Name -notin @("en-US.pak", "zh-CN.pak") } |
      Remove-Item -Force
  }

  Remove-Item -LiteralPath (Join-Path $RootDir "ffmpeg.dll") -Force -ErrorAction SilentlyContinue
}

function Optimize-RuntimeNodeModules {
  $argon2Root = Join-Path $appRoot "node_modules\argon2"
  if (Test-Path -LiteralPath $argon2Root) {
    Remove-Item -LiteralPath (Join-Path $argon2Root "argon2") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $argon2Root "binding.gyp") -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $argon2Root -File -Include *.cpp,*.d.cts,*.map,README.md,CHANGELOG.md -Recurse |
      Remove-Item -Force
    $prebuilds = Join-Path $argon2Root "prebuilds"
    if (Test-Path -LiteralPath $prebuilds) {
      Get-ChildItem -LiteralPath $prebuilds -Directory |
        Where-Object { $_.Name -ne "win32-x64" } |
        Remove-Item -Recurse -Force
    }
  }

  $zodRoot = Join-Path $appRoot "node_modules\zod"
  if (Test-Path -LiteralPath $zodRoot) {
    Remove-Item -LiteralPath (Join-Path $zodRoot "src") -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $zodRoot -File -Include *.d.ts,*.d.cts,*.ts,README.md -Recurse |
      Remove-Item -Force
  }
}

Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $legacyZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $legacyTarXz -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$required = @("src\main.ts", "src\sourcemod\compet_match_lock.smx", "out\main", "out\preload", "out\renderer", "packaging\server", "node_modules\.bin\esbuild.cmd", "node_modules\electron\dist")
foreach ($relative in $required) {
  $path = Join-Path $repo $relative
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $relative" }
}

Copy-Item -Path (Join-Path $electronDist "*") -Destination $stage -Recurse
Move-Item -LiteralPath (Join-Path $stage "electron.exe") -Destination (Join-Path $stage $serverExe)
Remove-UnusedElectronFiles -RootDir $stage
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null

New-Item -ItemType Directory -Path (Join-Path $appRoot "dist") -Force | Out-Null
$serverBundle = Join-Path $appRoot "dist\main.cjs"
& (Join-Path $repo "node_modules\.bin\esbuild.cmd") `
  (Join-Path $repo "src\main.ts") `
  "--bundle" `
  "--platform=node" `
  "--format=cjs" `
  "--outfile=$serverBundle" `
  "--external:argon2"
if ($LASTEXITCODE -ne 0) {
  throw "esbuild server bundle failed with exit code $LASTEXITCODE"
}
Copy-Item -LiteralPath (Join-Path $repo "out") -Destination $appRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repo "src\sourcemod") -Destination (Join-Path $appRoot "sourcemod") -Recurse
Copy-Item -LiteralPath (Join-Path $repo "packaging\server\app-package.json") -Destination (Join-Path $appRoot "package.json")
Copy-NodeModulePackage "argon2"
Copy-NodeModulePackage "@phc\format"
Copy-NodeModulePackage "node-gyp-build"
Copy-NodeModulePackage "zod"
Optimize-RuntimeNodeModules
Copy-Item -LiteralPath (Join-Path $repo "packaging\server\README.txt") -Destination $stage

New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$requiredArchiveEntries = @(
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $stage $serverExe)),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $stage "README.txt")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "package.json")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "dist\main.cjs")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\main\index.js")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\preload\index.js")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\renderer\index.html")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "sourcemod\compet_match_lock.smx")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "node_modules\zod\package.json"))
)
New-Validated7zArchive -SourceDir $stage -ArchivePath $archive -RequiredEntries $requiredArchiveEntries
Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Created $archive"
