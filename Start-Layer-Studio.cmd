@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0server.mjs" (
  echo Extract the entire ZIP first, then run this file from the extracted folder.
  pause
  exit /b 1
)
set "LAYER_STUDIO_NODE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined LAYER_STUDIO_NODE set "LAYER_STUDIO_NODE=%%I"
if not defined LAYER_STUDIO_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "LAYER_STUDIO_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined LAYER_STUDIO_NODE (
  echo Node.js was not found. Install a recent Node.js release, then run this file again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4317 after the server starts.
echo Keep this window open while using Layer Studio.
"%LAYER_STUDIO_NODE%" "%~dp0server.mjs"
pause
