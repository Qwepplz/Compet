@echo off
set "APP_DIR=%~dp0"
set "LOG_FILE=%APP_DIR%compet-player-client-chromium.log"
start "" "%APP_DIR%Compet Player Client.exe" --enable-logging --log-file="%LOG_FILE%" --disable-gpu --disable-gpu-compositing --disable-direct-composition
