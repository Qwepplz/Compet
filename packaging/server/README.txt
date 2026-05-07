Compet Server

1. Extract this archive to a stable folder.
2. Run Compet Server Manager.exe.
3. Use the graphical server manager for bootstrap, settings, diagnostics, logs, accounts, and service start/stop/restart.
4. The managed backend service runs from the packaged app bundle and keeps its default data folder inside the extracted package.
5. The manager uses 18443 as its first-run local service port to avoid common 8443 desktop-app conflicts. Change it to 8443 from the manager settings before hosting real matches if that port is free.
6. Compet starts the game server through the matching map .bat in the server folder and writes match control into csgo/cfg/compet/*.cfg. It does not use RCON.

7. If the EXE closes immediately, run start-server-manager.cmd once and check compet-server-manager-boot.log / compet-server-manager-chromium.log in the same folder.
