$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $repo "dist"

if (Test-Path -LiteralPath $dist) {
  $root = [System.IO.Path]::GetFullPath($repo)
  $target = [System.IO.Path]::GetFullPath($dist)
  if (-not $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean path outside repository: $target"
  }

  Remove-Item -LiteralPath $target -Recurse -Force
}
