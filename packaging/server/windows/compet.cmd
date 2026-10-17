@echo off
"%~dp0runtime\node\node.exe" "%~dp0runtime\electron\resources\app\dist\cli.cjs" %*
exit /b %errorlevel%
