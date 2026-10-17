param([string]$ArtifactsDir, [string]$RequiredClientVersion = $env:COMPET_REQUIRED_CLIENT_VERSION)
$ErrorActionPreference = "Stop"
$arguments = @("--import", "tsx", (Join-Path $PSScriptRoot "package-server.ts"), "--platform", "win32-x64")
if ($RequiredClientVersion) { $arguments += @("--required-client-version", $RequiredClientVersion) }
if ($ArtifactsDir) { $arguments += @("--artifacts-dir", $ArtifactsDir) }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Server packaging failed; see diagnostic output" }
