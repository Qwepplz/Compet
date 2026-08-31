$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-csharp-compiler.ps1")
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$artifacts = Join-Path $repo "artifacts"
$stagingRoot = Join-Path $artifacts "staging"
$stage = Join-Path $stagingRoot "Compet-Server"
$electronRuntimeRoot = Join-Path $stage "runtime\electron"
$appRoot = Join-Path $electronRuntimeRoot "resources\app"
$archive = Join-Path $artifacts "Compet-Server.7z"
$archiveTmp = "$archive.tmp"
$supersededZip = Join-Path $artifacts "Compet-Server.zip"
$supersededTarXz = Join-Path $artifacts "Compet-Server.tar.xz"
$electronDist = Join-Path $repo "node_modules\electron\dist"
$launcherSource = Join-Path $repo "scripts\launcher\CompetLauncher.cs"
$updaterSource = Join-Path $repo "scripts\launcher\CompetUpdater.cs"
$nodeRuntime = (Get-Command "node.exe" -ErrorAction Stop).Source
$serverExe = "Compet Server Manager.exe"
$rcedit = Join-Path $repo "node_modules\rcedit\bin\rcedit-x64.exe"
$repoLocal7z = Join-Path $repo ".local-tools\7zr.exe"
$logArchive7z = Join-Path $repo "packaging\server\runtime\7zr.exe"
$profileSeedPath = Join-Path $repo "packaging\server\profile-seed\human-index.json"
$packageVersion = [string]((Get-Content -LiteralPath (Join-Path $repo "packaging\server\app-package.json") -Raw | ConvertFrom-Json).version)

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

function Assert-ProfileSeed {
  param(
    [Parameter(Mandatory = $true)][string]$SeedPath
  )

  if (-not (Test-Path -LiteralPath $SeedPath)) {
    throw "Missing profile seed: $SeedPath"
  }

  try {
    $seed = Get-Content -LiteralPath $SeedPath -Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Invalid profile seed JSON: $SeedPath"
  }

  if ($null -eq $seed -or $seed -is [System.Array] -or $seed -isnot [pscustomobject]) {
    throw "Invalid profile seed root: $SeedPath"
  }

  $validEntries = 0
  foreach ($property in $seed.PSObject.Properties) {
    if ($property.Name -notmatch '^\d{17}$') { continue }
    $personaName = $property.Value.personaName
    if ($personaName -is [string] -and $personaName.Trim().Length -gt 0) {
      $validEntries += 1
    }
  }
  if ($validEntries -eq 0) {
    throw "Profile seed contains no valid human entries: $SeedPath"
  }
}

function Assert-NodeSqliteRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [switch]$Electron
  )

  if (-not (Test-Path -LiteralPath $Executable)) {
    throw "Missing $DisplayName executable: $Executable"
  }

  $probe = 'const { DatabaseSync } = require("node:sqlite"); const database = new DatabaseSync(":memory:"); database.exec("SELECT 1"); database.close();'
  $previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    if ($Electron) { $env:ELECTRON_RUN_AS_NODE = "1" }
    & $Executable -e $probe *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "$DisplayName runtime does not support node:sqlite"
    }
  } catch {
    throw "${DisplayName} runtime does not support node:sqlite: $($_.Exception.Message)"
  } finally {
    if ($null -eq $previousElectronRunAsNode) {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    } else {
      $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
    }
  }
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
  $rceditArgs = @(
    $ExePath,
    "--set-version-string", "CompanyName", "Qwepplz",
    "--set-version-string", "FileDescription", $Description,
    "--set-version-string", "ProductName", $ProductName,
    "--set-version-string", "OriginalFilename", $OriginalFilename,
    "--set-version-string", "InternalName", $InternalName,
    "--set-version-string", "LegalCopyright", "Copyright (C) 2026 Qwepplz",
    "--set-file-version", $version,
    "--set-product-version", $version
  )
  & $rcedit @rceditArgs
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
    Get-ChildItem -LiteralPath $zodRoot -File -Include *.d.ts,*.d.cts,*.d.mts,*.ts,*.js,*.mjs,README.md -Recurse |
      Remove-Item -Force
  }

  $nodeGypBuildRoot = Join-Path $appRoot "node_modules\node-gyp-build"
  if (Test-Path -LiteralPath $nodeGypBuildRoot) {
    foreach ($relative in @("bin.js", "build-test.js", "optional.js", "README.md", "SECURITY.md")) {
      Remove-Item -LiteralPath (Join-Path $nodeGypBuildRoot $relative) -Force -ErrorAction SilentlyContinue
    }
  }

  $phcFormatRoot = Join-Path $appRoot "node_modules\@phc\format"
  if (Test-Path -LiteralPath $phcFormatRoot) {
    Remove-Item -LiteralPath (Join-Path $phcFormatRoot "readme.md") -Force -ErrorAction SilentlyContinue
  }
}

Assert-NodeSqliteRuntime -Executable $nodeRuntime -DisplayName "Node.js"
Assert-NodeSqliteRuntime -Executable (Join-Path $electronDist "electron.exe") -DisplayName "Electron" -Electron
Assert-ProfileSeed -SeedPath $profileSeedPath

Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
foreach ($staleArtifact in @($archive, $archiveTmp, $supersededZip, $supersededTarXz)) {
  Remove-Item -LiteralPath $staleArtifact -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $staleArtifact) {
    throw "Unable to remove stale package artifact: $staleArtifact"
  }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$required = @("src\main.ts", "src\sourcemod\compet_match_lock.smx", "src\run_csgo", "out\main", "out\preload", "out\renderer", "packaging\server\app-package.json", "packaging\server\profile-seed\human-index.json", "node_modules\.bin\esbuild.cmd", "node_modules\electron\dist", "scripts\launcher\CompetLauncher.cs", "scripts\launcher\CompetUpdater.cs")
foreach ($relative in $required) {
  $path = Join-Path $repo $relative
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required path: $relative" }
}

New-Item -ItemType Directory -Path $electronRuntimeRoot -Force | Out-Null
Copy-Item -Path (Join-Path $electronDist "*") -Destination $electronRuntimeRoot -Recurse
Remove-UnusedElectronFiles -RootDir $electronRuntimeRoot
$serverExePath = Join-Path $stage $serverExe
New-CSharpExe -SourcePath $launcherSource -ExePath $serverExePath -References @("System.Windows.Forms.dll")
Set-ExeVersionInfo `
  -ExePath $serverExePath `
  -Description "Compet Server Manager" `
  -ProductName "Compet Server Manager" `
  -OriginalFilename $serverExe `
  -InternalName "Compet Server Manager"
$updaterRoot = Join-Path $stage "runtime\updater"
New-Item -ItemType Directory -Path $updaterRoot -Force | Out-Null
$updaterExePath = Join-Path $updaterRoot "Compet Updater.exe"
New-CSharpExe -SourcePath $updaterSource -ExePath $updaterExePath
Set-ExeVersionInfo `
  -ExePath $updaterExePath `
  -Description "Compet Updater" `
  -ProductName "Compet Server Manager" `
  -OriginalFilename "Compet Updater.exe" `
  -InternalName "Compet Updater"
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appRoot "runtime\node") -Force | Out-Null
Copy-Item -LiteralPath $nodeRuntime -Destination (Join-Path $appRoot "runtime\node\node.exe")
New-Item -ItemType Directory -Path (Join-Path $appRoot "runtime\7z") -Force | Out-Null
Copy-Item -LiteralPath $logArchive7z -Destination (Join-Path $appRoot "runtime\7z\7zr.exe")
New-Item -ItemType Directory -Path (Join-Path $appRoot "runtime\profiles") -Force | Out-Null
Copy-Item -LiteralPath $profileSeedPath -Destination (Join-Path $appRoot "runtime\profiles\human-index.json")

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
New-Item -ItemType Directory -Path (Join-Path $appRoot "sourcemod") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo "src\sourcemod\compet_match_lock.smx") -Destination (Join-Path $appRoot "sourcemod\compet_match_lock.smx")
Copy-Item -LiteralPath (Join-Path $repo "src\run_csgo") -Destination (Join-Path $appRoot "run_csgo") -Recurse
Copy-Item -LiteralPath (Join-Path $repo "packaging\server\app-package.json") -Destination (Join-Path $appRoot "package.json")
Copy-NodeModulePackage "argon2"
Copy-NodeModulePackage "@phc\format"
Copy-NodeModulePackage "node-gyp-build"
Copy-NodeModulePackage "zod"
Optimize-RuntimeNodeModules
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$requiredArchiveEntries = @(
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $stage $serverExe)),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $electronRuntimeRoot "electron.exe")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $electronRuntimeRoot "ffmpeg.dll")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "package.json")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "runtime\node\node.exe")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "runtime\7z\7zr.exe")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "runtime\profiles\human-index.json")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "dist\main.cjs")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\main\index.cjs")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\preload\index.js")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "out\renderer\index.html")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "sourcemod\compet_match_lock.smx")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "run_csgo\run_csgo.ps1")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "run_csgo\csgo\cfg\1.cfg")),
  (Get-ArchiveEntryPath -RootDir $stage -FilePath (Join-Path $appRoot "node_modules\zod\package.json"))
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
  "*/tsconfig*.json",
  "*.map",
  "*.tmp",
  "resources/app/sourcemod/*.sp"
)
New-Validated7zArchive -SourceDir $stage -ArchivePath $archive -RequiredEntries $requiredArchiveEntries -ForbiddenEntryPatterns $forbiddenArchiveEntryPatterns
$updateBaseUrl = if ($env:COMPET_SERVER_UPDATE_BASE_URL) { $env:COMPET_SERVER_UPDATE_BASE_URL } else { "https://qwepplz111.site/update/server" }
& pwsh -NoProfile -File (Join-Path $repo "scripts\create-update-manifest.ps1") `
  -AppId "compet-server-manager" `
  -PackageDir $stage `
  -OutputDir (Join-Path $artifacts "update\server") `
  -LatestUrlBase $updateBaseUrl `
  -Version $packageVersion
if ($LASTEXITCODE -ne 0) { throw "Server update manifest creation failed with exit code $LASTEXITCODE" }
Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Created $archive"
