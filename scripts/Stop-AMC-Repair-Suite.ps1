<#
    Stops the hidden AMC Repair Suite launcher and both servers it started.

    Reads logs\hidden-launcher-state.json (written by run-suite-hidden.cjs
    on startup: {launcherPid, backendPid, frontendPid}) and stops all three
    processes DIRECTLY via taskkill, rather than sending the launcher a
    stop signal and hoping it cleans up after itself - Windows does not
    deliver a real SIGTERM to a Node process the way POSIX does, so a
    signal-based stop is not reliable here (see run-suite-hidden.cjs's own
    comment on this). taskkill /t (kill the whole process tree) is used on
    each, so a child node spawned anything further is caught too.

    Safe to run when nothing is actually running - it just says so.

    Usage: double-click, or
        powershell -ExecutionPolicy Bypass -File .\scripts\Stop-AMC-Repair-Suite.ps1
#>

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $repoRoot 'logs\hidden-launcher-state.json'

if (-not (Test-Path $stateFile)) {
    Write-Host 'AMC Repair Suite does not appear to be running (no logs\hidden-launcher-state.json found).' -ForegroundColor Yellow
    Write-Host 'If you started it a different way (the old visible-console launcher), close those windows directly instead.'
    Read-Host 'Press Enter to close'
    exit 0
}

$state = Get-Content $stateFile -Raw | ConvertFrom-Json

function Stop-IfRunning {
    param([int]$TargetPid, [string]$Label)
    if (-not $TargetPid) { return }
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "$Label (pid $TargetPid) is not running - already stopped."
        return
    }
    Write-Host "Stopping $Label (pid $TargetPid)..."
    # CLAUDE_CODE_PROMPT (hidden launcher, 2026-09-10) - two real bugs
    # found and fixed here, both confirmed by actually running this
    # script, not reasoned about:
    #
    # 1. Merely redirecting streams (`2>$null`, even without `2>&1`) does
    #    NOT stop PowerShell 5.1 from raising a terminating
    #    NativeCommandError when a native exe writes to stderr, as long as
    #    $ErrorActionPreference = 'Stop' is in effect - confirmed live,
    #    twice. try/catch is what actually stops it from aborting the rest
    #    of this script, since a NativeCommandError IS a terminating error
    #    once raised, and try/catch catches terminating errors regardless
    #    of source.
    # 2. `taskkill /t` can genuinely fail to bring down a process tree in
    #    one attempt (confirmed live against a real Vite dev server child
    #    process - "could not be terminated" on the first try). One retry
    #    after a short pause is cheap and resolves the transient case; if
    #    it still hasn't worked, this reports that honestly rather than
    #    claiming success or crashing the script.
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        try {
            taskkill /pid $TargetPid /t /f 2>$null | Out-Null
        } catch {
            # Expected and non-fatal - see note 1 above. The real answer
            # is the Get-Process check below, not taskkill's own report.
        }
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) {
            Write-Host "  Confirmed stopped." -ForegroundColor Green
            return
        }
    }
    Write-Host "  $Label (pid $TargetPid) is still running after two attempts - stop it manually via Task Manager if needed." -ForegroundColor Yellow
}

Stop-IfRunning -TargetPid $state.backendPid -Label 'Backend'
Stop-IfRunning -TargetPid $state.frontendPid -Label 'Frontend'
Stop-IfRunning -TargetPid $state.launcherPid -Label 'Hidden launcher'

Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Stopped.' -ForegroundColor Green
Read-Host 'Press Enter to close'
