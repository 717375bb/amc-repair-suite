<#
    Launches run-suite-hidden.cjs with NO visible window at all - this is
    the actual "make everything invisible" step; run-suite-hidden.cjs alone
    would still show a console if started directly, since it inherits
    whichever terminal ran it.

    Called from Start-AMC-Repair-Suite.bat, not meant to be run by hand
    (though it's harmless to). Exits immediately once it has told Windows
    to start the hidden process - it does NOT wait for the suite to come
    up; Start-AMC-Repair-Suite.bat does that part itself by polling the
    real health endpoints, same as it always has.
#>

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'run-suite-hidden.cjs'

Start-Process -FilePath 'node' -ArgumentList @("`"$script`"") -WorkingDirectory $repoRoot -WindowStyle Hidden
