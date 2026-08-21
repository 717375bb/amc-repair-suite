<#
.SYNOPSIS
  Reads PDF attachments out of ONE configured Outlook folder via COM and
  emits a single JSON envelope on stdout. Strictly read-only.

.DESCRIPTION
  Stage 1 of the Vendor Quote Writer (see docs/VENDOR_QUOTE_WRITER_SPEC.md).

  Outlook COM was confirmed automatable on this machine before this script
  was written (Outlook.Application.16, version 16.0.0.20228, MAPI namespace
  OK) — not assumed.

  READ-ONLY BY CONSTRUCTION: this script contains no Move, Delete, Save, or
  UnRead assignment anywhere. That is a structural guarantee, not a flag
  that could be flipped — marking mail read lives in a separate script
  (mark-outlook-mail-read.ps1) that takes exactly one EntryID and is only
  ever called after a verified-successful MXI write.

  Emits ONE JSON object on stdout so the Node caller can parse a single
  envelope (same discipline as the job runners' own JSON envelopes).
  Diagnostics go to stderr, never stdout, so they can never corrupt it.

.PARAMETER FolderPath
  Backslash-separated path relative to the mailbox root, e.g.
  "psa_CRA\Quotes". Case-insensitive. If it can't be resolved, this fails
  loudly and prints the folders that DO exist at the point it got stuck —
  never returns an empty result set that looks like "no new quotes."

.PARAMETER OutDir
  Directory to save extracted PDF attachments into. Created if absent.

.PARAMETER MaxMessages
  Safety cap on how many messages to process, newest first. Default 200.

.PARAMETER SinceDays
  Only consider mail received in the last N days. 0 (default) = no limit.
#>
param(
  [Parameter(Mandatory = $true)][string]$FolderPath,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$MaxMessages = 200,
  [int]$SinceDays = 0
)

$ErrorActionPreference = 'Stop'

function Write-Diag([string]$msg) {
  # stderr only — stdout is reserved exclusively for the JSON envelope.
  [Console]::Error.WriteLine("[read-outlook-quotes] $msg")
}

function Fail([string]$msg) {
  Write-Diag "ERROR: $msg"
  $err = @{ ok = $false; error = $msg } | ConvertTo-Json -Depth 4 -Compress
  [Console]::Out.WriteLine($err)
  exit 1
}

# ---------------------------------------------------------------------------
# Connect
# ---------------------------------------------------------------------------
try {
  $outlook = New-Object -ComObject Outlook.Application
  $namespace = $outlook.GetNamespace("MAPI")
} catch {
  Fail "Could not start Outlook via COM: $($_.Exception.Message). Is desktop Outlook installed and able to run as this user?"
}

# ---------------------------------------------------------------------------
# Resolve the configured folder, one segment at a time.
#
# Deliberately NOT a silent failure: a typo'd or not-yet-created folder is
# the single most likely real-world setup mistake here, and it would
# otherwise look identical to "no quotes have arrived." Report exactly
# which segment failed and what siblings were actually available.
# ---------------------------------------------------------------------------
$segments = $FolderPath.Split('\') | Where-Object { $_ -ne '' }
if ($segments.Count -eq 0) { Fail "FolderPath was empty." }

$rootStore = $null
foreach ($store in $namespace.Folders) { $rootStore = $store; break }
if ($null -eq $rootStore) { Fail "No mail stores found in this Outlook profile." }

$current = $rootStore
$walked = @($rootStore.Name)

foreach ($segment in $segments) {
  $match = $null
  foreach ($child in $current.Folders) {
    if ($child.Name -ieq $segment) { $match = $child; break }
  }
  if ($null -eq $match) {
    $available = @()
    foreach ($child in $current.Folders) { $available += $child.Name }
    $availableList = if ($available.Count -gt 0) { $available -join ', ' } else { '(none)' }
    Fail ("Folder segment '$segment' not found under '" + ($walked -join '\') + "'. Available there: $availableList")
  }
  $current = $match
  $walked += $segment
}

$folder = $current
Write-Diag ("Resolved folder: " + ($walked -join '\') + " (items: " + $folder.Items.Count + ")")

# ---------------------------------------------------------------------------
# Staging directory for extracted PDFs
# ---------------------------------------------------------------------------
if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$OutDirResolved = (Resolve-Path $OutDir).Path

# ---------------------------------------------------------------------------
# Collect messages, newest first
# ---------------------------------------------------------------------------
$items = $folder.Items
try {
  $items.Sort("[ReceivedTime]", $true)   # descending
} catch {
  Write-Diag "Could not sort by ReceivedTime ($($_.Exception.Message)); continuing in natural order."
}

$cutoff = $null
if ($SinceDays -gt 0) { $cutoff = (Get-Date).AddDays(-$SinceDays) }

$results = @()
$processed = 0
$skippedNoPdf = 0

foreach ($item in $items) {
  if ($processed -ge $MaxMessages) { break }

  # Only real mail items carry attachments in the shape we expect; anything
  # else in the folder (meeting requests, reports) is skipped rather than
  # guessed at.
  $messageClass = ''
  try { $messageClass = [string]$item.MessageClass } catch { }
  if (-not $messageClass.StartsWith('IPM.Note')) { continue }

  $received = $null
  try { $received = $item.ReceivedTime } catch { }
  if ($null -ne $cutoff -and $null -ne $received -and $received -lt $cutoff) {
    # Sorted newest-first, so the first too-old message means we're done.
    break
  }

  $processed++

  # --- attachments: PDFs only -------------------------------------------
  $pdfAttachments = @()
  try {
    foreach ($att in $item.Attachments) {
      $fileName = [string]$att.FileName
      if (-not $fileName) { continue }
      if (-not $fileName.ToLower().EndsWith('.pdf')) { continue }

      # EntryID-prefixed filename: guarantees uniqueness across messages
      # that legitimately share an attachment name ("Quote.pdf" is not rare).
      $entryId = [string]$item.EntryID
      $shortId = $entryId.Substring([Math]::Max(0, $entryId.Length - 16))
      $safeName = ($fileName -replace '[^A-Za-z0-9._-]', '_')
      $savedName = "$shortId-$safeName"
      $savedPath = Join-Path $OutDirResolved $savedName

      try {
        $att.SaveAsFile($savedPath)   # writes to DISK, does not modify the mail item
      } catch {
        Write-Diag "Could not save attachment '$fileName': $($_.Exception.Message)"
        continue
      }

      $sizeBytes = 0
      try { $sizeBytes = (Get-Item $savedPath).Length } catch { }

      $pdfAttachments += [ordered]@{
        fileName  = $fileName
        savedPath = $savedPath
        sizeBytes = $sizeBytes
      }
    }
  } catch {
    Write-Diag "Could not enumerate attachments on one message: $($_.Exception.Message)"
  }

  if ($pdfAttachments.Count -eq 0) { $skippedNoPdf++; continue }

  # --- sender: SMTP address is not always directly available ------------
  $senderEmail = ''
  try {
    $senderEmail = [string]$item.SenderEmailAddress
    if ($item.SenderEmailType -eq 'EX') {
      try { $senderEmail = [string]$item.Sender.GetExchangeUser().PrimarySmtpAddress } catch { }
    }
  } catch { }

  $results += [ordered]@{
    entryId      = [string]$item.EntryID
    subject      = [string]$item.Subject
    senderName   = [string]$item.SenderName
    senderEmail  = $senderEmail
    receivedTime = if ($null -ne $received) { $received.ToString('o') } else { $null }
    isRead       = (-not $item.UnRead)
    attachments  = $pdfAttachments
  }
}

Write-Diag "Scanned $processed message(s); $($results.Count) with PDF attachment(s); $skippedNoPdf without."

$envelope = [ordered]@{
  ok             = $true
  folderPath     = ($walked -join '\')
  scannedCount   = $processed
  messages       = $results
  attachmentDir  = $OutDirResolved
}

# -Compress keeps this to a single stdout line, matching how the Node job
# runners already parse one JSON envelope per line.
[Console]::Out.WriteLine(($envelope | ConvertTo-Json -Depth 6 -Compress))
exit 0
