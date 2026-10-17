param([Parameter(Mandatory=$true)][string]$Stage, [Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-csharp-compiler.ps1")
$csc = Resolve-CSharpCompiler
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifacts = Join-Path $repo "artifacts"
$target = [IO.Path]::GetFullPath($Stage)
if (-not $target.StartsWith($artifacts + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Stage must be inside artifacts" }
$rcedit = Join-Path $repo "node_modules/rcedit/bin/rcedit-x64.exe"
$iconSource = Join-Path $repo "packaging/assets/compet-icon.ico"
$serverExePath = Join-Path $target "Compet Server Manager.exe"
$updaterExePath = Join-Path $target "runtime/updater/Compet Updater.exe"
$launcher = Join-Path $repo "scripts/launcher/CompetLauncher.cs"
$updater = Join-Path $repo "scripts/launcher/CompetUpdater.cs"
$bridge = Join-Path $repo "scripts/launcher/CompetServerUpdaterBridge.cs"
& $csc /nologo /target:winexe /optimize+ /define:COMPET_SERVER "/out:$serverExePath" /reference:System.Windows.Forms.dll $launcher
if ($LASTEXITCODE -ne 0) { throw "C# launcher compilation failed" }
& $csc /nologo /target:winexe /optimize+ "/define:COMPET_SERVER;COMPET_SERVER_BRIDGE" "/out:$updaterExePath" /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll $updater $bridge
if ($LASTEXITCODE -ne 0) { throw "C# bridge compilation failed" }
foreach ($executable in @($serverExePath, $updaterExePath)) {
  $name = [IO.Path]::GetFileNameWithoutExtension($executable)
  & $rcedit $executable --set-version-string CompanyName Qwepplz --set-version-string FileDescription $name --set-version-string ProductName "Compet Server Manager" --set-version-string OriginalFilename ([IO.Path]::GetFileName($executable)) --set-version-string InternalName $name --set-version-string LegalCopyright "Copyright (C) 2026 Qwepplz" --set-file-version $Version --set-product-version $Version
  if ($LASTEXITCODE -ne 0) { throw "rcedit version update failed" }
}
& $rcedit $serverExePath --set-icon $iconSource
if ($LASTEXITCODE -ne 0) { throw "rcedit icon update failed" }
