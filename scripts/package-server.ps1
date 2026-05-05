$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$artifacts = Join-Path $repo "artifacts"
$stagingRoot = Join-Path $artifacts "staging"
$stage = Join-Path $stagingRoot "Compet-Server"
$appRoot = Join-Path $stage "resources\app"
$zip = Join-Path $artifacts "Compet-Server.zip"
$electronDist = Join-Path $repo "node_modules\electron\dist"
$serverExe = "Compet Server Manager.exe"

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

Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$required = @("src\main.ts", "src\sourcemod\compet_match_lock.smx", "out\main", "out\preload", "out\renderer", "packaging\server", "node_modules\.bin\esbuild.cmd", "node_modules\electron\dist")
foreach ($relative in $required) {
  $path = Join-Path $repo $relative
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $relative" }
}

Copy-Item -Path (Join-Path $electronDist "*") -Destination $stage -Recurse
Move-Item -LiteralPath (Join-Path $stage "electron.exe") -Destination (Join-Path $stage $serverExe)
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
Copy-Item -LiteralPath (Join-Path $repo "packaging\server\README.txt") -Destination $stage

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$runtimeNode = Join-Path $appRoot "runtime\node"
New-Item -ItemType Directory -Path $runtimeNode -Force | Out-Null
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $runtimeNode "node.exe")

New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$requiredZipEntries = @(
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $stage $serverExe)),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $stage "README.txt")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "package.json")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "dist\main.cjs")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\main\index.js")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\preload\index.js")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\renderer\index.html")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "sourcemod\compet_match_lock.smx")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "runtime\node\node.exe")),
  (Get-ZipEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "node_modules\zod\package.json"))
)
New-ValidatedZip -SourceDir $stage -ZipPath $zip -RequiredEntries $requiredZipEntries
Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Created $zip"
