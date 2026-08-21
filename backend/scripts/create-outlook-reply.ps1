<#
.SYNOPSIS
  Creates a Reply All to ONE Outlook message with a supplied HTML body, and
  either saves it to Drafts or sends it.

.DESCRIPTION
  Vendor Quote Writer — approval replies (see docs/VENDOR_QUOTE_WRITER_SPEC.md).

  This is the ONLY script in this project that can send mail out of the
  user's mailbox to an external party. It is deliberately separate from
  both read-outlook-quotes.ps1 (read-only) and mark-outlook-mail-read.ps1
  (read-flag only), so the capability to send is isolated in one small,
  obvious file rather than hidden behind a flag on something else.

  DEFAULTS TO DRAFT. Sending requires -Mode send explicitly. There is no
  configuration in which the default behavior sends mail.

  Scope is one message, by EntryID. There is no bulk mode.

.PARAMETER EntryId
  The Outlook EntryID of the message to reply to.

.PARAMETER BodyHtmlPath
  Path to a UTF-8 file containing the rendered HTML body. Passed as a file
  rather than an argument because approval wording is long, contains markup
  and quotes, and must not be mangled by command-line escaping.

.PARAMETER Mode
  'draft' (default) saves to Drafts and sends nothing.
  'send' sends immediately — an explicit, deliberate opt-in.
#>
param(
  [Parameter(Mandatory = $true)][string]$EntryId,
  [Parameter(Mandatory = $true)][string]$BodyHtmlPath,
  [ValidateSet('draft', 'send')][string]$Mode = 'draft'
)

$ErrorActionPreference = 'Stop'

function Write-Diag([string]$msg) {
  [Console]::Error.WriteLine("[create-outlook-reply] $msg")
}

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 4 -Compress))
}

# -Encoding UTF8 explicitly: Windows PowerShell 5.1's Get-Content does not
# reliably detect UTF-8 without a BOM, and this project has already been
# bitten by exactly that (em dash -> mojibake in the Excel writer). Wrong
# encoding here would put garbled characters in a vendor-facing email.
try {
  $bodyHtml = Get-Content -Path $BodyHtmlPath -Raw -Encoding UTF8
} catch {
  Emit ([ordered]@{ ok = $false; error = "Could not read body file: $($_.Exception.Message)" })
  exit 1
}

if ([string]::IsNullOrWhiteSpace($bodyHtml)) {
  Emit ([ordered]@{ ok = $false; error = 'Rendered reply body was empty — refusing to create an empty reply.' })
  exit 1
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
  # ReplyAll (not Reply) per explicit user direction — vendor teams and PSA
  # colleagues are routinely copied on these threads and need to see the
  # approval.
  $reply = $item.ReplyAll()

  # Prepend the template ABOVE Outlook's own quoted chain rather than
  # replacing HTMLBody outright, so the original quote thread is preserved
  # for the vendor's reference.
  $reply.HTMLBody = $bodyHtml + $reply.HTMLBody

  $recipients = @()
  foreach ($r in $reply.Recipients) { $recipients += [string]$r.Address }

  if ($Mode -eq 'send') {
    $reply.Send()
    Write-Diag "Reply SENT to: $($recipients -join '; ')"
    Emit ([ordered]@{ ok = $true; mode = 'send'; subject = [string]$reply.Subject; recipients = $recipients })
  } else {
    $reply.Save()   # lands in Drafts; nothing leaves the mailbox
    Write-Diag "Reply saved to Drafts for: $($recipients -join '; ')"
    Emit ([ordered]@{ ok = $true; mode = 'draft'; subject = [string]$reply.Subject; recipients = $recipients })
  }
  exit 0
} catch {
  Write-Diag "Failed: $($_.Exception.Message)"
  Emit ([ordered]@{ ok = $false; error = "Could not create the reply: $($_.Exception.Message)" })
  exit 1
}
