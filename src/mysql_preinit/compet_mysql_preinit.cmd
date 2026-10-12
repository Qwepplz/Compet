@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0compet_mysql_preinit.ps1"
set "compet_preinit_exit=%errorlevel%"
if not "%compet_preinit_exit%"=="0" (
  echo Initialization launch failed. Review the error above.
  pause
)
exit /b %compet_preinit_exit%
