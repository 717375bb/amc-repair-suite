<#
    Creates two real Windows shortcuts (.lnk) on this user's Desktop:
    "Start AMC Repair Suite" (Start-AMC-Repair-Suite.bat) and
    "Stop AMC Repair Suite" (scripts\Stop-AMC-Repair-Suite.ps1), both
    pointing back at THIS repo checkout.

    Why this exists: a prior session's launcher (Start-AMC-Repair-Suite.bat)
    was once moved (not copied) to the Desktop, which broke it - %~dp0
    resolved to the Desktop, where none of package.json/backend/scripts/
    exist, producing confusing ENOENT errors. Start-AMC-Repair-Suite.bat now
    detects that case and fails with a clear message, but the actual fix is
    a real shortcut that points BACK at the real file, never a copy or move
    of the .bat itself. This script automates creating that shortcut
    correctly, every time, on any analyst's machine, instead of relying on
    a manual right-click "Send to > Desktop (create shortcut)" step.

    The Stop shortcut exists because the servers now run hidden (see
    run-suite-hidden.cjs) - there is no window left to close to stop them,
    so a symmetrical Stop entry point is needed alongside Start.

    Usage (from an ordinary PowerShell prompt, no admin rights needed):
        cd amc-repair-suite
        powershell -ExecutionPolicy Bypass -File .\scripts\Create-Desktop-Shortcut.ps1

    Safe to re-run - it always overwrites both shortcut files, never
    appends a second icon.
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$batPath = Join-Path $repoRoot 'Start-AMC-Repair-Suite.bat'
$stopScriptPath = Join-Path $repoRoot 'scripts\Stop-AMC-Repair-Suite.ps1'

if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) {
    Write-Host ''
    Write-Host '============================================' -ForegroundColor Red
    Write-Host '  ERROR: This script is not sitting inside a real repo checkout.' -ForegroundColor Red
    Write-Host '============================================' -ForegroundColor Red
    Write-Host ''
    Write-Host "Expected to find package.json at: $repoRoot"
    Write-Host 'Run this script from inside scripts\ in your real amc-repair-suite clone.'
    exit 1
}

if (-not (Test-Path $batPath)) {
    Write-Host ''
    Write-Host "ERROR: Start-AMC-Repair-Suite.bat not found at $batPath" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $stopScriptPath)) {
    Write-Host ''
    Write-Host "ERROR: scripts\Stop-AMC-Repair-Suite.ps1 not found at $stopScriptPath" -ForegroundColor Red
    exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

$startShortcutPath = Join-Path $desktop 'Start AMC Repair Suite.lnk'
$startShortcut = $shell.CreateShortcut($startShortcutPath)
$startShortcut.TargetPath = $batPath
$startShortcut.WorkingDirectory = $repoRoot
$startShortcut.Description = 'Starts the AMC Repair Suite (frontend + backend, running hidden) and opens it in your browser.'
# .lnk icons need an .ico/.exe/.dll resource, not .svg - cmd.exe's own icon
# is a safe, always-available fallback rather than pointing at a file
# Explorer can't actually use as an icon source.
$startShortcut.IconLocation = "$env:SystemRoot\System32\cmd.exe,0"
$startShortcut.Save()

$stopShortcutPath = Join-Path $desktop 'Stop AMC Repair Suite.lnk'
$stopShortcut = $shell.CreateShortcut($stopShortcutPath)
$stopShortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$stopShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$stopScriptPath`""
$stopShortcut.WorkingDirectory = $repoRoot
$stopShortcut.Description = 'Stops the AMC Repair Suite backend and frontend.'
$stopShortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,131"
$stopShortcut.Save()

Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  Desktop shortcuts created' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host "  $startShortcutPath"
Write-Host "  -> $batPath"
Write-Host ''
Write-Host "  $stopShortcutPath"
Write-Host "  -> powershell.exe -File $stopScriptPath"
Write-Host ''
Write-Host 'Double-click "Start AMC Repair Suite" on your Desktop to launch it, and'
Write-Host '"Stop AMC Repair Suite" to stop it - the servers run hidden now, so there'
Write-Host 'is no window to close instead.'
Write-Host 'Do NOT move or copy Start-AMC-Repair-Suite.bat itself - only these shortcuts belong on the Desktop.'
