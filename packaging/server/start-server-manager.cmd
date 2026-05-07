@echo off
set "APP_DIR=%~dp0"
set "LOG_FILE=%APP_DIR%compet-server-manager-chromium.log"
start "" "%APP_DIR%Compet Server Manager.exe" --enable-logging --log-file="%LOG_FILE%" --disable-gpu --disable-gpu-compositing --disable-direct-composition
