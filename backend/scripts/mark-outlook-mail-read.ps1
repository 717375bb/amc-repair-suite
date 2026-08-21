<#
.SYNOPSIS
  Marks EXACTLY ONE Outlook message as read, by EntryID. The only mailbox
  mutation in the entire Vendor Quote Writer.

.DESCRIPTION
  Deliberately a separate script from read-outlook-quotes.ps1, which is
  read-only by construction. Keeping the single mutating capability in its
  own file — rather than behind a flag on the reader — means the reader
  cannot be made to modify mail by a future edit or a mis-set parameter.

  Scope is one message, identified by Outlook's own stable EntryID. There
  is no bulk mode and no folder-wide mode, on purpose: the caller must have
  a specific message in hand that it just successfully wrote to MXI.

  Marks read ONLY. Never moves, never deletes, never alters content.

  Idempotent: a message already read is reported as alreadyRead, not an
  error, so a retried write can't fail on this step.

.PARAMETER EntryId
  The Outlook EntryID captured by read-outlook-quotes.ps1.
#>
param(
  [Parameter(Mandatory = $true)][string]$EntryId
)

$ErrorActionPreference = 'Stop'

function Write-Diag([string]$msg) {
  [Console]::Error.WriteLine("[mark-outlook-mail-read] $msg")
}

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 4 -Compress))
}

try {
  $outlook = New-Object -ComObject Outlook.Application
  $namespace = $outlook.GetNamespace("MAPI")
} catch {
  Write-Diag "COM failure: $($_.Exception.Message)"
  Emit ([ordered]@{ ok = $false; error = "Could not start Outlook via COM: $($_.Exception.Message)" })
  exit 1
}

try {
  $item = $namespace.GetItemFromID($EntryId)
} catch {
  Write-Diag "GetItemFromID failed: $($_.Exception.Message)"
  Emit ([ordered]@{ ok = $false; error = "No message found for EntryID (it may have been moved or deleted): $($_.Exception.Message)" })
  exit 1
}

if ($null -eq $item) {
  Emit ([ordered]@{ ok = $false; error = "No message found for the supplied EntryID." })
  exit 1
}

$subject = ''
try { $subject = [string]$item.Subject } catch { }

if (-not $item.UnRead) {
  Write-Diag "Already read; nothing to do."
  Emit ([ordered]@{ ok = $true; alreadyRead = $true; subject = $subject })
  exit 0
}

try {
  $item.UnRead = $false
  $item.Save()
} catch {
  Write-Diag "Could not mark read: $($_.Exception.Message)"
  Emit ([ordered]@{ ok = $false; error = "Failed to mark message read: $($_.Exception.Message)" })
  exit 1
}

# Independent re-read rather than trusting the assignment — the same
# never-trust-the-write discipline this project applies to every real MXI
# write (see writeEsdAndNotes.ts).
$confirmed = $false
try {
  $recheck = $namespace.GetItemFromID($EntryId)
  $confirmed = (-not $recheck.UnRead)
} catch { }

if (-not $confirmed) {
  Emit ([ordered]@{ ok = $false; error = "Marked read, but an independent re-read still reports the message as unread." })
  exit 1
}

Write-Diag "Marked read and verified."
Emit ([ordered]@{ ok = $true; alreadyRead = $false; subject = $subject })
exit 0
