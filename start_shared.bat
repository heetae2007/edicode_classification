@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
if exist "runtime\node.exe" set "NODE=runtime\node.exe"
"%NODE%" -v >nul 2>&1
if errorlevel 1 goto nonode
if exist "node_modules\mysql2" goto run
echo [first run] installing mysql2 ...
call npm install mysql2 --no-audit --no-fund
if errorlevel 1 goto fail
:run
set OPEN_BROWSER=1
set BIND=0.0.0.0
echo Shared mode: other PCs connect to http://THIS-PC-IP:3000 (check IP with ipconfig)
"%NODE%" server.js
goto end
:nonode
echo Node.js was not found. Put node.exe in the runtime folder or install Node.js LTS.
:fail
:end
pause
