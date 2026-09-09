<#
.SYNOPSIS
  Forwards ONE Outlook message, with its attachments, to a fixed recipient,
  and either saves it to Drafts or sends it.

.DESCRIPTION
  Vendor Quote Writer — forwarding a quote to PSA's warranty department
  (2026-09-04, at the analyst's request).

  A true Outlook Forward, so the original message body, the thread beneath
  it, and the quote PDF all travel with it — the warranty team needs the
  vendor's own document, not our reading of it.

  Deliberately a SEPARATE script from create-outlook-reply.ps1 even though
  the mechanics are similar, following the same principle that keeps
  read-outlook-quotes.ps1 and mark-outlook-mail-read.ps1 apart: each
  capability that can change or leave the mailbox lives in its own small,
  obvious file rather than behind a flag on something else.

  DEFAULTS TO DRAFT. Sending requires -Mode send explicitly. There is no
  configuration in which the default behaviour sends mail.

  Scope is one message, by EntryID. There is no bulk mode.

.PARAMETER EntryId
  The Outlook EntryID of the message to forward.

.PARAMETER To
  The recipient address. Supplied by the caller rather than hardcoded here
  so the address lives in one place in the TypeScript, but it is never
  taken from client input — see the endpoint.

.PARAMETER BodyHtmlPath
  Optional path to a UTF-8 file whose contents are placed ABOVE the
  forwarded chain. Omit for a bare forward.

.PARAMETER Mode
  'draft' (default) saves to Drafts and sends nothing.
  'send' sends immediately — an explicit, deliberate opt-in.
#>
param(
  [Parameter(Mandatory = $true)][string]$EntryId,
  [Parameter(Mandatory = $true)][string]$To,
  [string]$BodyHtmlPath,
  [ValidateSet('draft', 'send')][string]$Mode = 'draft'
)

$ErrorActionPreference = 'Stop'

function Write-Diag([string]$msg) {
  [Console]::Error.WriteLine("[forward-outlook-mail] $msg")
}

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 4 -Compress))
}

$bodyHtml = ''
if ($BodyHtmlPath) {
  # -Encoding UTF8 explicitly, for the same reason as the reply script:
  # PowerShell 5.1's Get-Content does not reliably detect UTF-8 without a
  # BOM, and this project has already shipped mojibake that way once.
  try {
    $bodyHtml = Get-Content -Path $BodyHtmlPath -Raw -Encoding UTF8
  } catch {
    Emit ([ordered]@{ ok = $false; error = "Could not read body file: $($_.Exception.Message)" })
    exit 1
  }
}

try {
  $outlook = New-Object -ComObject Outlook.Application
  $namespace = $outlook.GetNamespace("MAPI")
} catch {
  Emit ([ordered]@{ ok = $false; error = "Could not start Outlook via COM: $($_.Exception.Message)" })
  exit 1
}

try {
  $item = $namespace.GetItemFromID($EntryId)
} catch {
  Emit ([ordered]@{ ok = $false; error = "No message found for EntryID (moved or deleted?): $($_.Exception.Message)" })
  exit 1
}

if ($null -eq $item) {
  Emit ([ordered]@{ ok = $false; error = 'No message found for the supplied EntryID.' })
  exit 1
}

try {
  # Forward (not ReplyAll): carries the attachments, which is the entire
  # point — the warranty team works from the vendor's own PDF.
  $forward = $item.Forward()
  $forward.Recipients.Add($To) | Out-Null

  # Resolve before sending. An unresolved address silently fails to deliver
  # on send, which would look like success here.
  $resolved = $forward.Recipients.ResolveAll()

  if ($bodyHtml) {
    $forward.HTMLBody = $bodyHtml + $forward.HTMLBody
  }

  $attachmentCount = $forward.Attachments.Count

  if ($Mode -eq 'send') {
    $forward.Send()
    Write-Diag "Forward SENT to $To with $attachmentCount attachment(s)."
    Emit ([ordered]@{ ok = $true; mode = 'send'; subject = [string]$forward.Subject; recipients = @($To); resolved = [bool]$resolved; attachmentCount = $attachmentCount })
  } else {
    $forward.Save()   # lands in Drafts; nothing leaves the mailbox
    Write-Diag "Forward saved to Drafts for $To with $attachmentCount attachment(s)."
    Emit ([ordered]@{ ok = $true; mode = 'draft'; subject = [string]$forward.Subject; recipients = @($To); resolved = [bool]$resolved; attachmentCount = $attachmentCount })
  }
  exit 0
} catch {
  Write-Diag "Failed: $($_.Exception.Message)"
  Emit ([ordered]@{ ok = $false; error = "Could not forward the message: $($_.Exception.Message)" })
  exit 1
}
