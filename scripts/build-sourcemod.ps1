param(
  [string]$CompilerPath,
  [string]$SourcePath = (Join-Path $PSScriptRoot "..\src\sourcemod\compet_match_lock.sp"),
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\src\sourcemod\compet_match_lock.smx")
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($CompilerPath)) { $CompilerPath = $env:COMPET_SPCOMP }
if ([string]::IsNullOrWhiteSpace($CompilerPath)) {
  $command = Get-Command "spcomp" -CommandType Application -ErrorAction SilentlyContinue
  if ($command) { $CompilerPath = $command.Source }
}
if ([string]::IsNullOrWhiteSpace($CompilerPath) -or -not (Test-Path -LiteralPath $CompilerPath -PathType Leaf)) {
  throw "SourcePawn compiler not found. Use -CompilerPath, COMPET_SPCOMP or PATH."
}

$compiler = (Resolve-Path -LiteralPath $CompilerPath).Path
$includeDir = Join-Path (Split-Path -Parent $compiler) "include"
$source = (Resolve-Path -LiteralPath $SourcePath).Path
$output = [System.IO.Path]::GetFullPath($OutputPath)
$tempOutput = Join-Path (Split-Path -Parent $output) (".sourcemod-" + [guid]::NewGuid().ToString("N") + ".tmp.smx")
try {
  $compilerArgs = @("-i$includeDir", "-o$tempOutput", $source)
  & $compiler @compilerArgs
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempOutput -PathType Leaf)) {
    throw "SourcePawn compilation failed (exit code $LASTEXITCODE): no valid output."
  }
  if ((Get-Item -LiteralPath $tempOutput).Length -eq 0) {
    throw "SourcePawn compilation failed: empty output."
  }
  [System.IO.File]::Move($tempOutput, $output, $true)
  Write-Host "Compiled SourcePawn plugin: $output"
} finally {
  if (Test-Path -LiteralPath $tempOutput) {
    Remove-Item -LiteralPath $tempOutput -Force
  }
}
