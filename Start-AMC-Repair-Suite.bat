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

echo Starting frontend in its own window...
start "AMC Repair Suite - Frontend" /D "%~dp0" cmd /k npm run dev

echo Waiting for the frontend to be ready...
timeout /t 6 /nobreak >nul

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

:error
echo.
echo Something failed above - scroll up to see the error. This window will stay
echo open so you can read it.
pause
