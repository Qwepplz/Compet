$ErrorActionPreference = "Stop"

$map = $env:COMPET_GAME_MAP
if ([string]::IsNullOrWhiteSpace($map)) {
  throw "COMPET_GAME_MAP must not be empty"
}

$port = $env:COMPET_GAME_PORT
if ([string]::IsNullOrWhiteSpace($port)) {
  $port = "27015"
}

$clientPort = $env:COMPET_GAME_CLIENT_PORT
$steamAccountToken = $env:COMPET_STEAM_ACCOUNT_TOKEN
$srcds = Join-Path $PSScriptRoot "srcds.exe"
if (-not (Test-Path -LiteralPath $srcds)) {
  $srcds = "srcds"
}

$arguments = @(
  "-language", "english",
  "-game", "csgo",
  "-console",
  "-usercon",
  "-tickrate", "128",
  "-worldwide",
  "-port", $port,
  "+game_type", "0",
  "+game_mode", "1",
  "+mapgroup", "mg_active",
  "+map", $map,
  "+maxplayers_override", "10",
  "+tv_enable", "1",
  "+exec", "1.cfg"
)

if (-not ([string]::IsNullOrWhiteSpace($clientPort))) {
  $arguments += @("+clientport", $clientPort)
}

if (-not ([string]::IsNullOrWhiteSpace($steamAccountToken))) {
  $arguments += @("+sv_setsteamaccount", $steamAccountToken)
}

Start-Process -FilePath $srcds -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
