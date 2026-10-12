#requires -Version 5.1
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-PlainItem([string]$Path, [bool]$Optional = $false) {
  $absolute = [IO.Path]::GetFullPath($Path)
  $ancestors = New-Object 'System.Collections.Generic.Stack[string]'
  $current = $absolute
  while ($current) {
    $ancestors.Push($current)
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
  }
  $item = $null
  while ($ancestors.Count -gt 0) {
    $current = $ancestors.Pop()
    try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
    catch {
      if ($Optional -and $_.CategoryInfo.Category -eq "ObjectNotFound") { return $null }
      throw "Cannot inspect required path: $current"
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Unsafe reparse point: $current"
    }
    if ($current -ne $absolute -and -not $item.PSIsContainer) {
      throw "Ancestor is not a directory: $current"
    }
  }
  return $item
}

function Assert-NoCompetConfig([string]$Directory) {
  $item = Get-PlainItem $Directory $true
  if ($null -eq $item) { return }
  if (-not $item.PSIsContainer) { throw "Invalid Compet config directory: $Directory" }
  foreach ($child in Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop) {
    $plain = Get-PlainItem $child.FullName
    if ($plain.PSIsContainer) { Assert-NoCompetConfig $plain.FullName }
    elseif ($plain.Extension -ieq ".cfg") { throw "Existing Compet match config: $($plain.FullName)" }
  }
}

function Assert-SafeConfig([string]$Path) {
  $item = Get-PlainItem $Path $true
  if ($null -eq $item) { return }
  if ($item.PSIsContainer) { throw "Config is not a regular file: $Path" }
  $lineNumber = 0
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $lineNumber++
    if ($line -match '^\s*//') { continue }
    if ($line -match '(?i)compet[\\/]+active_match|\bcompet_lock_enable\b|\bget5_(?:loadmatch(?:_url)?|creatematch|scrim)\b|\bsm_scrim\b|\bbot_add\w*\b') {
      throw "Match or combat-BOT risk: $Path (line $lineNumber)"
    }
    if ($line -match '(?i)\bget5_autoload_config\b') {
      if ($line -notmatch '(?i)^\s*get5_autoload_config\s+""\s*(?://.*)?$') {
        throw "Nonempty or ambiguous Get5 autoload: $Path (line $lineNumber)"
      }
    }
  }
}

try {
  $root = [IO.Path]::GetFullPath($PSScriptRoot)
  $rootItem = Get-PlainItem $root
  if (-not $rootItem.PSIsContainer) { throw "Game root is not a directory: $root" }
  foreach ($relative in @("srcds.exe", "csgo/maps/de_mirage.bsp",
      "csgo/addons/sourcemod/configs/core.cfg", "csgo/addons/sourcemod/configs/databases.cfg",
      "csgo/addons/sourcemod/plugins/kento_rankme.smx")) {
    $item = Get-PlainItem (Join-Path $root $relative)
    if ($item.PSIsContainer) { throw "Required path is not a regular file: $($item.FullName)" }
  }
  if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -ieq "srcds" }).Count -gt 0) {
    throw "A srcds process is already running. Close it manually before initialization."
  }
  $ports = @(27465, 27466, 27467)
  $udp = @(Get-NetUDPEndpoint -ErrorAction Stop | Where-Object { $_.LocalPort -in $ports })
  $tcp = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -in $ports })
  if ($udp.Count -gt 0 -or $tcp.Count -gt 0) { throw "An initialization port (27465-27467) is occupied." }

  Assert-NoCompetConfig (Join-Path $root "csgo/cfg/compet")
  foreach ($relative in @("csgo/cfg/get5/compet_active.json", "csgo/addons/sourcemod/plugins/compet_match_lock.smx")) {
    if ($null -ne (Get-PlainItem (Join-Path $root $relative) $true)) {
      throw "Existing match automation: $(Join-Path $root $relative)"
    }
  }
  foreach ($relative in @("csgo/cfg/autoexec.cfg", "csgo/cfg/server.cfg",
      "csgo/cfg/sourcemod/sourcemod.cfg", "csgo/cfg/sourcemod/get5.cfg")) {
    Assert-SafeConfig (Join-Path $root $relative)
  }

  $bytes = New-Object byte[] 24
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $secret = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
  $arguments = @("-language", "english", "-game", "csgo", "-console", "-usercon",
    "-ip", "127.0.0.1", "-port", "27465", "-net_port_try", "1", "-nobots",
    "+clientport", "27466", "+tv_enable", "1", "+tv_port", "27467", "+tv_maxclients", "0",
    "+bot_quota", "0", "+sv_hibernate_when_empty", "0", "+sv_lan", "1",
    "+sv_password", $secret, "+tv_password", $secret, "+rcon_password", $secret,
    "+game_type", "0", "+game_mode", "1", "+map", "de_mirage")
  Start-Process -FilePath (Join-Path $root "srcds.exe") -WorkingDirectory $root -ArgumentList $arguments -WindowStyle Normal -ErrorAction Stop
  Write-Host "Launch submitted. Verify plugin initialization in the game console, then close the game server manually."
  exit 0
}
catch {
  [Console]::Error.WriteLine("MySQL preinitialization launch refused: " + $_.Exception.Message)
  exit 1
}
