@echo off
setlocal
cd /d "%~dp0"
set "TASK_NODE=node"
set "TASK_NPM=npm.cmd"
if exist ".tools\node-version.txt" set /p TASK_NODE_VERSION=<".tools\node-version.txt"
if exist ".tools\node-%TASK_NODE_VERSION%-win-x64\node.exe" set "TASK_RUNTIME=%~dp0.tools\node-%TASK_NODE_VERSION%-win-x64"
if defined TASK_RUNTIME set "TASK_NODE=%TASK_RUNTIME%\node.exe"
if defined TASK_RUNTIME set "TASK_NPM=%TASK_RUNTIME%\npm.cmd"
if defined TASK_RUNTIME set "PATH=%TASK_RUNTIME%;%PATH%"
"%TASK_NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\" (
  call "%TASK_NPM%" ci --no-audit --no-fund
  if errorlevel 1 goto failed
)
if not exist "build-server\server\index.js" (
  call "%TASK_NPM%" run build
  if errorlevel 1 goto failed
)
echo Open http://127.0.0.1:3000 in your browser after the server starts.
echo Press Ctrl+C to stop safely.
call "%TASK_NPM%" start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. Please check the message above.
pause
exit /b 1
