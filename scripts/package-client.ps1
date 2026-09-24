$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-csharp-compiler.ps1")
. (Join-Path $PSScriptRoot "package-common.ps1")
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
$iconSource = Join-Path $repo "packaging\assets\compet-icon.ico"
$clientExe = "Compet Player Client.exe"
$rcedit = Join-Path $repo "node_modules\rcedit\bin\rcedit-x64.exe"
$repoLocal7z = Join-Path $repo ".local-tools\7zr.exe"
$packageVersion = [string]((Get-Content -LiteralPath (Join-Path $repo "packaging\client\app-package.json") -Raw | ConvertFrom-Json).version)

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

function Set-ExeIcon {
  param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$IconPath
  )

  if (-not (Test-Path -LiteralPath $rcedit)) {
    throw "Missing rcedit executable: $rcedit"
  }
  if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "Missing executable: $ExePath"
  }
  if (-not (Test-Path -LiteralPath $IconPath)) {
    throw "Missing application icon: $IconPath"
  }

  & $rcedit $ExePath --set-icon $IconPath
  if ($LASTEXITCODE -ne 0) { throw "rcedit icon update failed with exit code $LASTEXITCODE" }
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

$required = @("out-player\main", "out-player\preload", "out-player\renderer", "packaging\client\app-package.json", "packaging\assets\compet-icon.ico", "node_modules\electron\dist", "scripts\launcher\CompetLauncher.cs", "scripts\launcher\CompetUpdater.cs")
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
Set-ExeIcon -ExePath $clientExePath -IconPath $iconSource
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
  "*/scripts/*",
  "*/sourcemod/*",
  "*/tsconfig*.json",
  "*.map",
  "*.tmp"
)
New-Validated7zArchive -SourceDir $stage -SevenZipPath $repoLocal7z -ArchivePath $archive -RequiredEntries $requiredArchiveEntries -ForbiddenEntryPatterns $forbiddenArchiveEntryPatterns
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
