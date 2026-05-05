$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$artifacts = Join-Path $repo "artifacts"
$stagingRoot = Join-Path $artifacts "staging"
$stage = Join-Path $stagingRoot "Compet-Client"
$appRoot = Join-Path $stage "resources\app"
$zip = Join-Path $artifacts "Compet-Client.zip"
$electronDist = Join-Path $repo "node_modules\electron\dist"
$clientExe = "Compet Player Client.exe"

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-ZipEntryPath {
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

function New-ValidatedZip {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string[]]$RequiredEntries
  )

  $stageFileCount = (Get-ChildItem -LiteralPath $SourceDir -Recurse -File | Measure-Object).Count
  if ($stageFileCount -lt $RequiredEntries.Count) {
    throw "Stage directory is missing expected files: $SourceDir"
  }

  try {
    [System.IO.Compression.ZipFile]::CreateFromDirectory($SourceDir, $ZipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
      if ($archive.Entries.Count -lt $stageFileCount) {
        throw "ZIP entry count $($archive.Entries.Count) is smaller than stage file count $stageFileCount."
      }

      $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
      $missing = New-Object System.Collections.Generic.List[string]
      foreach ($requiredEntry in $RequiredEntries) {
        if (-not ($entryNames -contains $requiredEntry)) {
          [void]$missing.Add($requiredEntry)
        }
      }
      if ($missing.Count -gt 0) {
        throw "ZIP verification failed. Missing entries: $($missing -join ', ')"
      }
    } finally {
      if ($archive) {
        $archive.Dispose()
      }
    }
  } catch {
    Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
    throw
  }
}

Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$required = @("out-player\main", "out-player\preload", "out-player\renderer", "packaging\client", "node_modules\electron\dist")
foreach ($relative in $required) {
  $path = Join-Path $repo $relative
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $relative" }
}

Copy-Item -Path (Join-Path $electronDist "*") -Destination $stage -Recurse
Move-Item -LiteralPath (Join-Path $stage "electron.exe") -Destination (Join-Path $stage $clientExe)
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $repo "out-player") -Destination $appRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repo "packaging\client\app-package.json") -Destination (Join-Path $appRoot "package.json")
Copy-Item -LiteralPath (Join-Path $repo "packaging\client\README.txt") -Destination $stage

New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$requiredZipEntries = @(
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $stage $clientExe)),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $stage "README.txt")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "package.json")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out-player\main\index.js")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out-player\preload\index.js")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out-player\renderer\index.html"))
)
New-ValidatedZip -SourceDir $stage -ZipPath $zip -RequiredEntries $requiredZipEntries
Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Created $zip"
