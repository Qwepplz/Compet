param([string]$CompilerPath, [string]$SourcePath, [string]$OutputPath)
$ErrorActionPreference = "Stop"
$arguments = @("--import", "tsx", (Join-Path $PSScriptRoot "build-sourcemod.ts"))
if ($CompilerPath) { $arguments += @("--compiler-path", $CompilerPath) }
if ($SourcePath) { $arguments += @("--source-path", $SourcePath) }
if ($OutputPath) { $arguments += @("--output-path", $OutputPath) }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "SourcePawn compilation failed; see diagnostic output" }
