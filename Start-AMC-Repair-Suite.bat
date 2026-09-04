@echo off
setlocal
cd /d "%~dp0"

if not exist "package.json" (
    echo ============================================
    echo   ERROR: This file has been moved or copied.
    echo ============================================
    echo.
    echo Start-AMC-Repair-Suite.bat only works from inside its original
    echo project folder - it needs package.json, backend\, and scripts\ to
    echo sit right next to it.
    echo.
    echo If you want a Desktop icon, don't move or copy this file itself -
    echo instead right-click it in its real folder and choose
    echo "Send to -^> Desktop (create shortcut)", or ask Claude to set one
    echo up for you.
    echo.
    pause
    exit /b 1
)

echo ============================================
echo   AMC Repair Suite - Starting...
echo ============================================
echo.

if not exist "node_modules" (
    echo Installing frontend dependencies - first run only, this may take a few minutes...
    call npm install
    if errorlevel 1 goto :error
)

if not exist "backend\node_modules" (
    echo Installing backend dependencies - first run only, this may take a few minutes...
    call npm install --prefix backend
    if errorlevel 1 goto :error
)

echo Checking backend\.env...
node scripts\prepare-local-env.cjs
if errorlevel 1 goto :error

echo.
echo Starting backend in its own window...
start "AMC Repair Suite - Backend" /D "%~dp0backend" cmd /k npm run server

REM Wait for the backend to actually be listening before going any further.
REM This used to be a flat 6-second sleep for BOTH servers started at once,
REM and a cold backend (two SQLite opens plus a Playwright client) regularly
REM takes longer than that - so the browser opened against a backend that
REM wasn't up, and the app looked broken rather than early.
echo.
node scripts\wait-for-server.cjs http://127.0.0.1:3001/health "Backend" 120
if errorlevel 1 goto :backendfailed

echo.
echo Starting frontend in its own window...
start "AMC Repair Suite - Frontend" /D "%~dp0" cmd /k npm run dev

REM Same treatment for Vite: poll it rather than guess.
echo.
node scripts\wait-for-server.cjs http://127.0.0.1:5173 "Frontend" 120
if errorlevel 1 goto :frontendfailed

echo.
echo Opening the app in your browser...
start http://localhost:5173

echo.
echo Both servers are running in their own windows - closing those windows stops
echo them. If you double-click this file again while they're already running,
echo close the old windows first to avoid a port conflict.
echo.
echo You can close this window now.
pause
goto :eof

:backendfailed
echo.
echo The backend never started, so the app was NOT opened - it would have
echo failed every request. Look at the "AMC Repair Suite - Backend" window,
echo which is still open, for the real error.
pause
exit /b 1

:frontendfailed
echo.
echo The backend is running, but the frontend never came up. Look at the
echo "AMC Repair Suite - Frontend" window for the real error.
pause
exit /b 1

:error
echo.
echo Something failed above - scroll up to see the error. This window will stay
echo open so you can read it.
pause
