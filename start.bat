@echo off
setlocal
title UMBC Dashboard Launcher
rem Always run from the folder this file lives in
cd /d "%~dp0"

rem ---------- Find Python and Node ----------
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo Python was not found. Install it from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" during setup.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org/
  pause
  exit /b 1
)

rem ---------- One-time setup (skipped once done) ----------
%PY% -c "import fastapi, uvicorn, pandas" >nul 2>nul
if errorlevel 1 (
  echo Installing Python packages...
  %PY% -m pip install fastapi uvicorn pandas
)

if not exist "umbc.db" (
  echo Building umbc.db from the CSV files...
  %PY% db_creator.py
  if errorlevel 1 (
    echo Building the database failed - see the error above.
    pause
    exit /b 1
  )
)

if not exist "dashboard\node_modules" (
  echo Installing dashboard packages...
  pushd dashboard
  call npm install
  popd
)

rem ---------- Start both servers in their own windows ----------
echo Starting API on http://localhost:8000 ...
start "UMBC API - close this window to stop" cmd /k %PY% -m uvicorn api:app --reload --port 8000

echo Starting dashboard on http://localhost:5173 ...
start "UMBC Dashboard - close this window to stop" /d "%~dp0dashboard" cmd /k npm run dev -- --port 5173 --strictPort

rem ---------- Open the browser once they're up ----------
timeout /t 4 /nobreak >nul
start "" http://localhost:5173

echo.
echo Both servers are running in their own windows.
echo Close those two windows to stop them.
timeout /t 6 >nul
