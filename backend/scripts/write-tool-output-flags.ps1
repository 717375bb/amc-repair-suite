<#
.SYNOPSIS
  Writes Automation Flag / Flag Note / Suggested Action columns into the
  "Output" sheet of a live ESD Matcher / OOR Matcher tool workbook, using
  real Excel via COM automation (not ExcelJS) — a bare ExcelJS read+write
  round-trip was confirmed (via a disposable scratch-copy test) to drop
  dynamic-array formula metadata (xl/metadata.xml, xl/richData/) and
  corrupt at least one cell value. Real Excel saving its own file avoids
  that entirely.

.PARAMETER FilePath
  Path to the workbook to modify, in place. Caller is responsible for
  having already created a timestamped backup before calling this.

.PARAMETER DataJsonPath
  Path to a JSON file: an array of { orderNumber, automationFlag, flagNote,
  suggestedAction }. Only rows whose Order Number (Output sheet column A)
  matches an entry here are touched — everything else in the workbook is
  left exactly as-is.
#>
param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [Parameter(Mandatory = $true)][string]$DataJsonPath
)

$ErrorActionPreference = 'Stop'

# Refuse to proceed if the file is already open/locked (e.g. by the user's
# own Excel session) — COM automation opening a second copy of an
# already-open file risks a genuine save conflict.
try {
  $stream = [System.IO.File]::Open($FilePath, 'Open', 'ReadWrite', 'None')
  $stream.Close()
} catch {
  Write-Error "File appears to be open or locked by another process (possibly already open in Excel): $($_.Exception.Message)"
  exit 1
}

$data = Get-Content -Raw -Path $DataJsonPath -Encoding UTF8 | ConvertFrom-Json

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

try {
  $workbook = $excel.Workbooks.Open($FilePath)
  $sheet = $null
  foreach ($s in $workbook.Sheets) {
    if ($s.Name -eq 'Output') { $sheet = $s }
  }
  if ($null -eq $sheet) {
    throw "No sheet named 'Output' found in $FilePath."
  }

  # Force a full recalc so column A's spilled FILTER() results (and the
  # XLOOKUP columns depending on it) are current before we search them.
  $excel.CalculateFullRebuild()

  $flagCol = 9   # I
  $noteCol = 10  # J
  $actionCol = 11 # K

  if ($sheet.Cells.Item(1, $flagCol).Value2 -ne 'Automation Flag') {
    $sheet.Cells.Item(1, $flagCol).Value2 = 'Automation Flag'
    $sheet.Cells.Item(1, $noteCol).Value2 = 'Flag Note'
    $sheet.Cells.Item(1, $actionCol).Value2 = 'Suggested Action'
  }

  $usedRange = $sheet.UsedRange
  $rowCount = $usedRange.Rows.Count

  $orderToRow = @{}
  for ($r = 2; $r -le $rowCount; $r++) {
    $val = $sheet.Cells.Item($r, 1).Value2
    if ($null -ne $val -and [string]$val -ne '') {
      $orderToRow[[string]$val] = $r
    }
  }

  $updated = 0
  $notFound = New-Object System.Collections.Generic.List[string]
  foreach ($item in $data) {
    $orderNumber = [string]$item.orderNumber
    if ($orderToRow.ContainsKey($orderNumber)) {
      $r = $orderToRow[$orderNumber]
      $sheet.Cells.Item($r, $flagCol).Value2 = $item.automationFlag
      $sheet.Cells.Item($r, $noteCol).Value2 = $item.flagNote
      $sheet.Cells.Item($r, $actionCol).Value2 = $item.suggestedAction
      $updated++
    } else {
      $notFound.Add($orderNumber)
    }
  }

  $workbook.Save()
  $workbook.Close($true)

  Write-Output "RESULT_UPDATED=$updated"
  Write-Output "RESULT_NOTFOUND=$($notFound -join ',')"
  Write-Output "RESULT_TOTALROWS=$rowCount"
} finally {
  $excel.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
