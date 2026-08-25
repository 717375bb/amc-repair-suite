<#
.SYNOPSIS
  Creates a NEW Outlook mail item with a supplied body and saves it to
  Drafts (or sends it, only when explicitly asked).

.DESCRIPTION
  Zero-times-and-cycles notifications to Maintenance Records (see the
  Order Write-Ups zero_usage exception).

  Deliberately a separate file from create-outlook-reply.ps1 rather than a
  flag on it. That script replies to an existing thread by EntryID and can
  reach external vendors; this one composes a fresh internal message to a
  fixed distribution list. Keeping the two apart means the ability to mail
  an outside party stays isolated in one small, obvious file.

  DEFAULTS TO DRAFT. Sending requires -Mode send explicitly. There is no
  configuration in which the default behavior sends mail.

  Scope is one message per invocation. There is no bulk mode.

.PARAMETER To
  Recipient address. One only — this is not a mailing helper.

.PARAMETER Subject
  The message subject, verbatim.

.PARAMETER BodyPath
  Path to a UTF-8 file containing the plain-text body. Passed as a file
  rather than an argument because the body contains tabs, newlines and a
  data table, and command-line escaping is exactly the kind of thing that
  silently corrupts it.

.PARAMETER Mode
  'draft' (default) saves to Drafts and sends nothing.
  'send' sends immediately — an explicit, deliberate opt-in.
#>
param(
  [Parameter(Mandatory = $true)][string]$To,
  [Parameter(Mandatory = $true)][string]$Subject,
  [Parameter(Mandatory = $true)][string]$BodyPath,
  [ValidateSet('draft', 'send')][string]$Mode = 'draft'
)

$ErrorActionPreference = 'Stop'

function Write-Diag([string]$msg) {
  [Console]::Error.WriteLine("[create-outlook-mail] $msg")
}

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 4 -Compress))
}

# -Encoding UTF8 explicitly: Windows PowerShell 5.1's Get-Content does not
# reliably detect UTF-8 without a BOM, and this project has already shipped
# mojibake from exactly that mismatch once (em dash in the Excel writer).
try {
  $body = Get-Content -Path $BodyPath -Raw -Encoding UTF8
} catch {
  Emit ([ordered]@{ ok = $false; error = "Could not read body file: $($_.Exception.Message)" })
  exit 1
}

if ([string]::IsNullOrWhiteSpace($body)) {
  Emit ([ordered]@{ ok = $false; error = 'Body was empty — refusing to create an empty message.' })
  exit 1
}

try {
  $outlook = New-Object -ComObject Outlook.Application
} catch {
  Emit ([ordered]@{ ok = $false; error = "Could not start Outlook via COM: $($_.Exception.Message)" })
  exit 1
}

try {
  # 0 = olMailItem
  $mail = $outlook.CreateItem(0)
  $mail.To = $To
  $mail.Subject = $Subject
  # Plain text on purpose. The body carries a tab-separated Usage Parm
  # table, which survives verbatim as text; converting it to HTML would
  # collapse the tabs and lose the column alignment the records team reads.
  $mail.Body = $body

  # Resolve so the DL shows as a real recipient in Drafts rather than as
  # unresolved text. Non-fatal: an unresolvable name still saves, and the
  # analyst sees it plainly before sending.
  $resolved = $false
  try { $resolved = $mail.Recipients.ResolveAll() } catch { $resolved = $false }

  if ($Mode -eq 'send') {
    $mail.Send()
    Write-Diag "Mail SENT to: $To"
    Emit ([ordered]@{ ok = $true; mode = 'send'; subject = $Subject; recipients = @($To); resolved = $resolved; entryId = [string]$mail.EntryID })
  } else {
    $mail.Save()   # lands in Drafts; nothing leaves the mailbox
    Write-Diag "Mail saved to Drafts for: $To (resolved=$resolved)"
    Emit ([ordered]@{ ok = $true; mode = 'draft'; subject = $Subject; recipients = @($To); resolved = $resolved; entryId = [string]$mail.EntryID })
  }
  exit 0
} catch {
  Write-Diag "Failed: $($_.Exception.Message)"
  Emit ([ordered]@{ ok = $false; error = "Could not create the message: $($_.Exception.Message)" })
  exit 1
}
