<#
    Creates a real Windows shortcut (.lnk) on this user's Desktop pointing at
    Start-AMC-Repair-Suite.bat in THIS repo checkout.

    Why this exists: a prior session's launcher (Start-AMC-Repair-Suite.bat)
    was once moved (not copied) to the Desktop, which broke it — %~dp0
    resolved to the Desktop, where none of package.json/backend/scripts/
    exist, producing confusing ENOENT errors. Start-AMC-Repair-Suite.bat now
    detects that case and fails with a clear message, but the actual fix is
    a real shortcut that points BACK at the real file, never a copy or move
    of the .bat itself. This script automates creating that shortcut
    correctly, every time, on any analyst's machine, instead of relying on
    a manual right-click "Send to > Desktop (create shortcut)" step.

    Usage (from an ordinary PowerShell prompt, no admin rights needed):
        cd amc-repair-suite
        powershell -ExecutionPolicy Bypass -File .\scripts\Create-Desktop-Shortcut.ps1

    Safe to re-run — it always overwrites the shortcut file, never appends
    a second icon.
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$batPath = Join-Path $repoRoot 'Start-AMC-Repair-Suite.bat'

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

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Start AMC Repair Suite.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $batPath
$shortcut.WorkingDirectory = $repoRoot
$shortcut.Description = 'Starts the AMC Repair Suite (frontend + backend) and opens it in your browser.'

$iconPath = Join-Path $repoRoot 'public\favicon.svg'
# .lnk icons need an .ico/.exe/.dll resource, not .svg — cmd.exe's own icon
# is a safe, always-available fallback rather than pointing at a file
# Explorer can't actually use as an icon source.
$shortcut.IconLocation = "$env:SystemRoot\System32\cmd.exe,0"
$shortcut.Save()

Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  Desktop shortcut created' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host "  $shortcutPath"
Write-Host "  -> $batPath"
Write-Host ''
Write-Host 'Double-click "Start AMC Repair Suite" on your Desktop to launch it.'
Write-Host 'Do NOT move or copy Start-AMC-Repair-Suite.bat itself — only this shortcut belongs on the Desktop.'
