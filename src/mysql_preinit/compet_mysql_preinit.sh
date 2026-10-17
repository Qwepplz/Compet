#!/bin/bash
set -euo pipefail
shopt -s extglob
fail() { echo "$1" >&2; exit 1; }
source_path=$(realpath -ms -- "${BASH_SOURCE[0]}")
root=$(dirname -- "$source_path")
[[ "$root" != *$'\n'* && "$root" != *$'\r'* ]] || fail mysql_preinit_path_invalid
plain() {
  local target="$root/$1" cursor
  cursor="$target"
  while [[ "$cursor" != / ]]; do
    [[ ! -L "$cursor" ]] || fail mysql_preinit_linked_path
    cursor=$(dirname -- "$cursor")
  done
  [[ -f "$target" ]] || fail mysql_preinit_required_file_missing
}
[[ -t 0 && -t 1 ]] || fail mysql_preinit_terminal_required
command -v script >/dev/null || fail mysql_preinit_terminal_unavailable
for relative in "$(basename -- "$source_path")" srcds_run srcds_linux csgo/maps/de_mirage.bsp \
  csgo/addons/sourcemod/configs/core.cfg csgo/addons/sourcemod/configs/databases.cfg \
  csgo/addons/sourcemod/plugins/kento_rankme.smx; do plain "$relative"; done
[[ -x "$root/srcds_run" && -x "$root/srcds_linux" ]] || fail mysql_preinit_entry_not_executable
for process in /proc/[0-9]*; do
  [[ -d "$process" ]] || continue
  if name=$(cat "$process/comm" 2>/dev/null); then
    case "$name" in srcds|srcds_run|srcds_linux) fail mysql_preinit_game_process_exists;; esac
  elif [[ -d "$process" ]]; then fail mysql_preinit_process_check_failed; fi
done
for table in /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6; do
  [[ -r "$table" ]] || fail mysql_preinit_port_check_failed
  if awk 'NR>1 { split($2,a,":"); if (a[2]=="6B49" || a[2]=="6B4A" || a[2]=="6B4B") found=1 } END { exit !found }' "$table"; then
    fail mysql_preinit_port_busy
  fi
done
for relative in csgo/get5/compet_active.json csgo/addons/sourcemod/plugins/compet_match_lock.smx; do
  [[ ! -e "$root/$relative" && ! -L "$root/$relative" ]] || fail mysql_preinit_compet_conflict
done
if [[ -e "$root/csgo/cfg/compet" || -L "$root/csgo/cfg/compet" ]]; then
  cursor="$root/csgo/cfg/compet"
  while [[ "$cursor" != / ]]; do
    [[ ! -L "$cursor" ]] || fail mysql_preinit_linked_path
    cursor=$(dirname -- "$cursor")
  done
  [[ -d "$root/csgo/cfg/compet" ]] || fail mysql_preinit_compet_conflict
  [[ -z "$(find "$root/csgo/cfg/compet" -type f -iname '*.cfg' -print -quit)" ]] || fail mysql_preinit_compet_conflict
fi
active_pattern='compet[/\\].*(active_match|lock)|get5_loadmatch|(^|[[:space:];])(get5_creatematch|get5_scrim|sm_scrim|bot_add[^[:space:];]*)([[:space:];]|$)'
empty_autoload='^get5_autoload_config[[:space:]]+""([[:space:]]*(//.*)?)?$'
for relative in csgo/cfg/autoexec.cfg csgo/cfg/server.cfg csgo/cfg/sourcemod/sourcemod.cfg csgo/cfg/sourcemod/get5.cfg; do
  [[ -e "$root/$relative" || -L "$root/$relative" ]] || continue
  plain "$relative"
  [[ -r "$root/$relative" ]] || fail mysql_preinit_config_check_failed
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line##+([[:space:]])}"
    [[ -z "$line" || "$line" == //* ]] && continue
    lower="${line,,}"
    [[ ! "$lower" =~ $active_pattern ]] || fail mysql_preinit_active_config_conflict
    if [[ "$lower" == *get5_autoload_config* && ! "$lower" =~ $empty_autoload ]]; then fail mysql_preinit_autoload_conflict; fi
  done < "$root/$relative"
done
random_password() {
  local value
  value=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  [[ "${#value}" == 48 ]] || fail mysql_preinit_random_failed
  printf '%s' "$value"
}
args=(-norestart -game csgo -console -usercon -nobots -ip 127.0.0.1 -port 27465
  +clientport 27466 +tv_port 27467 +net_port_try 1 +bot_quota 0 +tv_enable 1 +tv_maxclients 0
  +sv_lan 1 +sv_hibernate_when_empty 0 +sv_password "$(random_password)"
  +tv_password "$(random_password)" +rcon_password "$(random_password)" +map de_mirage)
cd -- "$root"
printf -v command '%q ' /bin/bash ./srcds_run "${args[@]}"
exec script --quiet --return --flush --command "$command" /dev/null
