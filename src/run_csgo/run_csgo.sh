#!/bin/bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
: "${COMPET_GAME_MAP:?COMPET_GAME_MAP must not be empty}"
: "${COMPET_GAME_PORT:?COMPET_GAME_PORT must not be empty}"
: "${COMPET_GAME_CLIENT_PORT:?COMPET_GAME_CLIENT_PORT must not be empty}"
[[ "$COMPET_GAME_MAP" =~ ^[A-Za-z0-9_/-]+$ ]] || { echo "game_map_invalid" >&2; exit 1; }
for port in "$COMPET_GAME_PORT" "$COMPET_GAME_CLIENT_PORT"; do
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo "game_port_invalid" >&2; exit 1; }
done
[[ -f "$root/srcds_run" && ! -L "$root/srcds_run" && -x "$root/srcds_run" ]] || { echo "game_entry_invalid" >&2; exit 1; }
cd -- "$root"
args=(-norestart -language english -game csgo -console -usercon -tickrate 128 -worldwide
  -port "$COMPET_GAME_PORT" +game_type 0 +game_mode 1 +mapgroup mg_active +map "$COMPET_GAME_MAP"
  +maxplayers_override 10 +tv_enable 1 +exec 1.cfg +clientport "$COMPET_GAME_CLIENT_PORT")
if [[ -n "${COMPET_STEAM_ACCOUNT_TOKEN:-}" ]]; then args+=(+sv_setsteamaccount "$COMPET_STEAM_ACCOUNT_TOKEN"); fi
exec /bin/bash ./srcds_run "${args[@]}"
