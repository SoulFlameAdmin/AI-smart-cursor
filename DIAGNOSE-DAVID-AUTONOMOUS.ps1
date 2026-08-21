[CmdletBinding()]
param(
  [string]$TaskId = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$taskRoot = Join-Path $root '.david-runtime\autonomous-tasks'
$requestRoot = Join-Path $root '.david-runtime\teacher-requests'
$smokeFile = Join-Path $root '.david-runtime\autonomous-live-smoke.txt'
$soulStatus = Join-Path $root '.david-system\soul-status.json'
$thinkerStatus = Join-Path $root '.david-instances\david\thinker-node-status.json'

function SafeText {
  param([AllowNull()][object]$Value, [int]$Max = 1800)
  $text = [string]$Value
  $text = $text -replace '(?i)(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+', '$1=[REDACTED]'
  $text = $text -replace '(?i)\b(sk|sbp|eyJ)[A-Za-z0-9._-]{16,}\b', '[REDACTED]'
  if ($text.Length -gt $Max) { return $text.Substring(0, $Max) + ' ...[TRUNCATED]' }
  return $text
}

function Read-JsonSafe {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { return $null }
}

function Get-OptionalProperty {
  param(
    [AllowNull()][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowNull()][object]$Default = $null
  )
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Get-StatusEvents {
  param([AllowNull()][object]$Result)
  $events = Get-OptionalProperty -Object $Result -Name 'status_events' -Default @()
  if ($null -eq $events) { return @() }
  return @($events)
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  DAVID AUTONOMOUS DIAGNOSTIC REPORT'
Write-Host '============================================================' -ForegroundColor Cyan

$taskFile = $null
if ($TaskId) {
  $candidate = Join-Path $taskRoot ($TaskId + '.json')
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { $taskFile = Get-Item -LiteralPath $candidate }
} elseif (Test-Path -LiteralPath $taskRoot -PathType Container) {
  $taskFile = Get-ChildItem -LiteralPath $taskRoot -Filter '*.json' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
}

Write-Host "`n=== AUTONOMOUS TASK ===" -ForegroundColor Yellow
if (-not $taskFile) {
  Write-Host 'NO AUTONOMOUS TASK STATE FOUND'
} else {
  $task = Read-JsonSafe -Path $taskFile.FullName
  Write-Host ('File      : ' + $taskFile.FullName)
  if ($task) {
    Write-Host ('Task ID   : ' + (SafeText (Get-OptionalProperty $task 'task_id') 200))
    Write-Host ('State     : ' + (SafeText (Get-OptionalProperty $task 'state') 100))
    Write-Host ('Goal      : ' + (SafeText (Get-OptionalProperty $task 'goal') 600))
    $updated = Get-OptionalProperty -Object $task -Name 'updated_at'
    if ($null -ne $updated -and [string]$updated) {
      Write-Host ('Updated   : ' + (SafeText $updated 120))
    }
  }

  $journal = [System.IO.Path]::ChangeExtension($taskFile.FullName, '.jsonl')
  Write-Host "`n=== LAST AUTONOMOUS EVIDENCE ===" -ForegroundColor Yellow
  if (Test-Path -LiteralPath $journal -PathType Leaf) {
    $events = @(Get-Content -LiteralPath $journal -Encoding UTF8 -ErrorAction SilentlyContinue |
      Select-Object -Last 120 |
      ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
      } |
      Where-Object { $null -ne $_ })

    $interesting = @($events | Where-Object {
      (SafeText (Get-OptionalProperty $_ 'event_type') 200) -match 'verification|worker_exception|blocked|failed|completed|state_test|state_verify'
    } | Select-Object -Last 40)

    if ($interesting.Count -eq 0) { $interesting = @($events | Select-Object -Last 25) }
    foreach ($event in $interesting) {
      $eventEvidence = Get-OptionalProperty -Object $event -Name 'evidence'
      $evidence = if ($null -ne $eventEvidence) {
        SafeText ($eventEvidence | ConvertTo-Json -Depth 12 -Compress) 2200
      } else { '' }
      Write-Host ('{0} | {1} | state={2} | {3}' -f `
        (SafeText (Get-OptionalProperty $event 'timestamp') 80), `
        (SafeText (Get-OptionalProperty $event 'event_type') 120), `
        (SafeText (Get-OptionalProperty $event 'state') 80), `
        $evidence)
    }
  } else {
    Write-Host 'NO JOURNAL FOUND'
  }
}

Write-Host "`n=== RECENT TEACHER RESULTS ===" -ForegroundColor Cyan
if (Test-Path -LiteralPath $requestRoot -PathType Container) {
  $results = @(Get-ChildItem -LiteralPath $requestRoot -Filter '*.result.json' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 16)

  foreach ($file in $results) {
    $result = Read-JsonSafe -Path $file.FullName
    if (-not $result) { continue }
    $statusEvents = @(Get-StatusEvents -Result $result)
    $lastError = @($statusEvents | Where-Object { (Get-OptionalProperty $_ 'kind') -eq 'error' } | Select-Object -Last 1)
    $lastEvent = @($statusEvents | Select-Object -Last 1)
    Write-Host ('--- ' + $file.Name)
    Write-Host ('status  : ' + (SafeText (Get-OptionalProperty $result 'status') 100))
    Write-Host ('ok      : ' + [string](Get-OptionalProperty $result 'ok' $false))
    Write-Host ('round   : ' + (SafeText (Get-OptionalProperty $result 'round') 80))
    Write-Host ('summary : ' + (SafeText (Get-OptionalProperty $result 'summary') 1500))
    if ($lastError.Count -gt 0) {
      Write-Host ('error   : ' + (SafeText (Get-OptionalProperty $lastError[0] 'message') 1500)) -ForegroundColor Red
    } elseif ($lastEvent.Count -gt 0) {
      Write-Host ('last    : ' + (SafeText (Get-OptionalProperty $lastEvent[0] 'message') 1000))
    }
  }
} else {
  Write-Host 'NO TEACHER REQUEST DIRECTORY'
}

Write-Host "`n=== LIVE SMOKE PROOF ===" -ForegroundColor Green
if (Test-Path -LiteralPath $smokeFile -PathType Leaf) {
  $content = Get-Content -LiteralPath $smokeFile -Raw -Encoding UTF8
  $exact = ($content -eq 'DAVID_AUTONOMOUS_LIVE_PASS') -or ($content -eq "DAVID_AUTONOMOUS_LIVE_PASS`r`n") -or ($content -eq "DAVID_AUTONOMOUS_LIVE_PASS`n")
  Write-Host 'Exists    : YES'
  Write-Host ('Exact     : ' + $exact)
  Write-Host ('Content   : ' + (SafeText $content 200))
  try {
    $hash = (Get-FileHash -LiteralPath $smokeFile -Algorithm SHA256).Hash
    Write-Host ('SHA256    : ' + $hash)
  } catch {}
} else {
  Write-Host 'Exists    : NO'
}

Write-Host "`n=== RUNTIME STATUS ===" -ForegroundColor Magenta
foreach ($entry in @(
  [pscustomobject]@{ Name='SOUL'; Path=$soulStatus },
  [pscustomobject]@{ Name='THINKER'; Path=$thinkerStatus }
)) {
  $status = Read-JsonSafe -Path $entry.Path
  if ($status) {
    Write-Host ('{0,-8} state={1} pid={2} stage={3} message={4}' -f `
      $entry.Name, `
      (SafeText (Get-OptionalProperty $status 'state') 80), `
      (SafeText (Get-OptionalProperty $status 'pid') 40), `
      (SafeText (Get-OptionalProperty $status 'stage') 100), `
      (SafeText (Get-OptionalProperty $status 'message') 600))
  } else {
    Write-Host ($entry.Name + '     status=UNAVAILABLE')
  }
}

Write-Host "`n=== PORTS / PROCESSES ===" -ForegroundColor Magenta
Get-NetTCPConnection -LocalPort 9333,9444 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,State,OwningProcess |
  Sort-Object LocalPort,OwningProcess |
  Format-Table -AutoSize

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.Name -eq 'node.exe' -or $_.Name -eq 'msedge.exe') -and
    ($_.CommandLine -like '*DAVID_ASI*' -or $_.CommandLine -like '*david-thinker*' -or $_.CommandLine -like '*edge-soul-node-main.cjs*')
  } |
  Select-Object ProcessId,Name,CommandLine |
  Format-Table -Wrap

Write-Host "`n=== END REPORT ===" -ForegroundColor Cyan
