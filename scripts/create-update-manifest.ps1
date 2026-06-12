param(
  [Parameter(Mandatory = $true)][string]$AppId,
  [Parameter(Mandatory = $true)][string]$PackageDir,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$LatestUrlBase,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
  throw "Version is not SemVer: $Version"
}
$version = $Version

$packageRoot = Resolve-Path $PackageDir
$outputRoot = New-Item -ItemType Directory -Path $OutputDir -Force
Remove-Item -LiteralPath (Join-Path $outputRoot "files") -Recurse -Force -ErrorAction SilentlyContinue

$base = $LatestUrlBase.TrimEnd('/')
$releasePath = Join-Path $outputRoot "releases\$version"
for ($attempt = 1; $attempt -le 5; $attempt++) {
  try {
    Remove-Item -LiteralPath $releasePath -Recurse -Force -ErrorAction SilentlyContinue
    break
  } catch {
    if ($attempt -eq 5) { throw }
    Start-Sleep -Milliseconds 250
  }
}
$releaseDir = New-Item -ItemType Directory -Path $releasePath -Force
$releaseFilesDir = New-Item -ItemType Directory -Path (Join-Path $releaseDir.FullName "files") -Force

$entries = @(
  Get-ChildItem -LiteralPath $packageRoot -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $relative = $_.FullName.Substring($packageRoot.Path.Length).TrimStart('\').Replace('\', '/')
      $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $releaseFilesDir.FullName $hash) -Force
      [pscustomobject]@{
        path = $relative
        sha256 = $hash
        size = $_.Length
        group = if ($relative -like "resources/app/*") { "app" } elseif ($relative -like "runtime/*") { "runtime" } else { "launcher" }
        url = "files/$hash"
      }
    }
)

$manifest = [ordered]@{
  appId = $AppId
  version = $version
  platform = "win32-x64"
  baseUrl = "$base/releases/$version/files/"
  files = $entries
}
$latest = [ordered]@{
  channel = "stable"
  version = $version
  manifestUrl = "$base/releases/$version/manifest.json"
  publishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
}

for ($attempt = 1; $attempt -le 5; $attempt++) {
  try {
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $releaseDir.FullName "manifest.json") -Encoding UTF8
    $latest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outputRoot "latest.json") -Encoding UTF8
    break
  } catch {
    if ($attempt -eq 5) { throw }
    Start-Sleep -Milliseconds 250
  }
}

Write-Host "Created update manifest at $($outputRoot.FullName)"
