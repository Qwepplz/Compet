$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-csharp-compiler.ps1")
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$artifacts = Join-Path $repo "artifacts"
$stagingRoot = Join-Path $artifacts "staging"
$stage = Join-Path $stagingRoot "Compet-Client"
$electronRuntimeRoot = Join-Path $stage "runtime\electron"
$appRoot = Join-Path $electronRuntimeRoot "resources\app"
$archive = Join-Path $artifacts "Compet-Client.7z"
$archiveTmp = "$archive.tmp"
$supersededZip = Join-Path $artifacts "Compet-Client.zip"
$supersededTarXz = Join-Path $artifacts "Compet-Client.tar.xz"
$electronDist = Join-Path $repo "node_modules\electron\dist"
$launcherSource = Join-Path $repo "scripts\launcher\CompetLauncher.cs"
$updaterSource = Join-Path $repo "scripts\launcher\CompetUpdater.cs"
$clientExe = "Compet Player Client.exe"
$rcedit = Join-Path $repo "node_modules\rcedit\bin\rcedit-x64.exe"
$repoLocal7z = Join-Path $repo ".local-tools\7zr.exe"
$packageVersion = [string]((Get-Content -LiteralPath (Join-Path $repo "packaging\client\app-package.json") -Raw | ConvertFrom-Json).version)

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
  if (Test-Path -LiteralPath $repoLocal7z) {
    return $repoLocal7z
  }
  throw "Packaging 7z executable not found: $repoLocal7z"
}

function Get-PackageVersion {
  if ($packageVersion -match '^\d+\.\d+\.\d+$') {
    return "$packageVersion.0"
  }
  return $packageVersion
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

function New-CSharpExe {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$ExePath,
    [string[]]$References = @()
  )

  $csc = Resolve-CSharpCompiler
  $cscArgs = @("/nologo", "/target:winexe", "/optimize+", "/out:$ExePath")
  foreach ($reference in $References) { $cscArgs += "/reference:$reference" }
  $cscArgs += $SourcePath
  & $csc @cscArgs
  if ($LASTEXITCODE -ne 0) { throw "C# compilation failed with exit code $LASTEXITCODE" }
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

$required = @("out-player\main", "out-player\preload", "out-player\renderer", "packaging\client\app-package.json", "node_modules\electron\dist", "scripts\launcher\CompetLauncher.cs", "scripts\launcher\CompetUpdater.cs")
foreach ($relative in $required) {
  $path = Join-Path $repo $relative
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $relative" }
}

New-Item -ItemType Directory -Path $electronRuntimeRoot -Force | Out-Null
Copy-Item -Path (Join-Path $electronDist "*") -Destination $electronRuntimeRoot -Recurse
Remove-UnusedElectronFiles -RootDir $electronRuntimeRoot
$clientExePath = Join-Path $stage $clientExe
New-CSharpExe -SourcePath $launcherSource -ExePath $clientExePath -References @("System.Windows.Forms.dll")
Set-ExeVersionInfo `
  -ExePath $clientExePath `
  -Description "Compet Player Client" `
  -ProductName "Compet Player Client" `
  -OriginalFilename $clientExe `
  -InternalName "Compet Player Client"
$updaterRoot = Join-Path $stage "runtime\updater"
New-Item -ItemType Directory -Path $updaterRoot -Force | Out-Null
$updaterExePath = Join-Path $updaterRoot "Compet Updater.exe"
New-CSharpExe -SourcePath $updaterSource -ExePath $updaterExePath
Set-ExeVersionInfo `
  -ExePath $updaterExePath `
  -Description "Compet Updater" `
  -ProductName "Compet Player Client" `
  -OriginalFilename "Compet Updater.exe" `
  -InternalName "Compet Updater"
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $repo "out-player") -Destination $appRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repo "packaging\client\app-package.json") -Destination (Join-Path $appRoot "package.json")

New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$requiredArchiveEntries = @(
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $stage $clientExe)),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $electronRuntimeRoot "electron.exe")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $electronRuntimeRoot "ffmpeg.dll")),
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
$updateBaseUrl = if ($env:COMPET_CLIENT_UPDATE_BASE_URL) { $env:COMPET_CLIENT_UPDATE_BASE_URL } else { "https://qwepplz111.site/update/client" }
& pwsh -NoProfile -File (Join-Path $repo "scripts\create-update-manifest.ps1") `
  -AppId "compet-player-client" `
  -PackageDir $stage `
  -OutputDir (Join-Path $artifacts "update\client") `
  -LatestUrlBase $updateBaseUrl `
  -Version $packageVersion
if ($LASTEXITCODE -ne 0) { throw "Client update manifest creation failed with exit code $LASTEXITCODE" }
Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Created $archive"
