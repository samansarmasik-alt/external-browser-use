@echo off
setlocal
cd /d "%~dp0"
node "%~dp0src\control.mjs" %*
endlocal
