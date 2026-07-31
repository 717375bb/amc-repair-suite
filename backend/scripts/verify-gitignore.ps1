<#
.SYNOPSIS
  Fails loudly if any known-sensitive path is NOT actually excluded by
  .gitignore. Exists because this exact class of bug (a .gitignore entry
  that visually looks right but doesn't actually match, due to stray quote
  characters) has now happened TWICE in this project — once for .env/
  discovery-recording.ts, and again for discovery-notes-recording.ts. A
  visual read of .gitignore is not sufficient; this checks the real,
  authoritative git behavior (`git check-ignore`) for every sensitive path
  every time, so a third silent recurrence isn't possible.

.DESCRIPTION
  Run from the repo root (or anywhere — it cds into backend/ itself).
  Exits 0 if every checked path is genuinely ignored. Exits 1 and prints
  exactly which path(s) failed if not — safe to wire into a pre-commit
  hook or just run by hand before anything sensitive gets touched.
#>

$ErrorActionPreference = 'Stop'
$repoRoot = git rev-parse --show-toplevel
if (-not $repoRoot) {
  Write-Error "Not inside a git repository."
  exit 1
}

# Representative sensitive paths — checked whether or not the file
# currently exists, since git check-ignore matches on the path/pattern,
# not file presence. Add new sensitive filenames here as they come up.
$sensitivePaths = @(
  'backend/.env',
  'backend/data/audit.db',
  'backend/data/mxi-stage-storage-state.json',
  'backend/data/tool-backups/placeholder-check.xlsx',
  'backend/discovery-recording.ts',
  'backend/discovery-notes-recording.ts'
)

Push-Location $repoRoot
$failures = @()

foreach ($path in $sensitivePaths) {
  $output = git check-ignore -v $path 2>$null
  if ($LASTEXITCODE -ne 0) {
    $failures += $path
    Write-Host "NOT IGNORED (real problem): $path" -ForegroundColor Red
  } else {
    Write-Host "OK, ignored: $path -> $output" -ForegroundColor Green
  }
}

Pop-Location

if ($failures.Count -gt 0) {
  Write-Host "`n$($failures.Count) sensitive path(s) are NOT actually excluded by .gitignore:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  Write-Host "Fix backend/.gitignore before doing anything with real secrets/data in this repo." -ForegroundColor Red
  exit 1
}

Write-Host "`nAll sensitive paths are correctly excluded." -ForegroundColor Green
exit 0
