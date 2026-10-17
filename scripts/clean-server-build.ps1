$ErrorActionPreference = "Stop"
& node --import tsx (Join-Path $PSScriptRoot "clean-server-build.ts")
if ($LASTEXITCODE -ne 0) { throw "Server build cleanup failed" }
