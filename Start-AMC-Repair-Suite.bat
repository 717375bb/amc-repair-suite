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
    echo instead run scripts\Create-Desktop-Shortcut.ps1 from its real
    echo folder ^(see docs\DESKTOP_SHORTCUT_SETUP.md^), or right-click it
    echo and choose "Send to -^> Desktop (create shortcut)".
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

REM CLAUDE_CODE_PROMPT (hidden launcher, 2026-09-10) - per explicit user
REM direction: no lingering visible console windows for the backend/
REM frontend. Start-Hidden.ps1 launches scripts\run-suite-hidden.cjs with
REM no window of its own, which in turn starts the backend/frontend
REM (also windowless), waits for both, and opens the browser itself -
REM see that script's own header for the full design, including why
REM stopping later goes through Stop-AMC-Repair-Suite.ps1 rather than
REM closing a window that no longer exists to close.
echo.
echo Starting AMC Repair Suite in the background...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Hidden.ps1"
if errorlevel 1 goto :error

REM This window still polls the real health endpoints itself (same
REM wait-for-server.cjs as before) purely to give honest first-run
REM feedback and a clear failure message - it does NOT open the browser
REM itself anymore (run-suite-hidden.cjs already does, exactly once, from
REM the one place that actually knows both servers are up).
echo.
node scripts\wait-for-server.cjs http://127.0.0.1:3001/health "Backend" 120
if errorlevel 1 goto :backendfailed
node scripts\wait-for-server.cjs http://127.0.0.1:5173 "Frontend" 120
if errorlevel 1 goto :frontendfailed

echo.
echo Started. The app should be opening in your browser now.
echo.
echo Both servers are now running invisibly in the background - there are no
echo windows to close. To stop them, use the "Stop AMC Repair Suite" shortcut
echo (or run scripts\Stop-AMC-Repair-Suite.ps1 directly).
echo This window will close on its own.
timeout /t 4 >nul
goto :eof

:backendfailed
echo.
echo The backend never started, so the app was NOT opened - it would have
echo failed every request. Check logs\backend.log and logs\launcher.log for
echo the real error (there's no visible console window for it anymore).
pause
exit /b 1

:frontendfailed
echo.
echo The backend is running, but the frontend never came up. Check
echo logs\frontend.log and logs\launcher.log for the real error.
pause
exit /b 1

:error
echo.
echo Something failed above - scroll up to see the error. This window will stay
echo open so you can read it.
pause
