[CmdletBinding()]
param(
  [ValidateRange(10,120)][int]$WatchSeconds = 20
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

function Assert-Root {
  if (!(Test-Path -LiteralPath $Root -PathType Container)) { throw "DAVID ROOT DISAPPEARED: $Root" }
  foreach ($Required in @('edge-soul-main.cjs','START-DAVID-SOUL-INSTANCE.ps1','core\teacher-loop.cjs','core\knowledge-gap-engine.cjs')) {
    if (!(Test-Path -LiteralPath (Join-Path $Root $Required) -PathType Leaf)) { throw "DAVID required file missing: $Required" }
  }
}

$Instances = @(
  [pscustomobject]@{ Name='MITKO'; Id='mitko'; Port=9333; Launcher=(Join-Path $Root 'START-MITKO-DAVID-SOUL.ps1'); Base=(Join-Path $Root '.david-instances\mitko') },
  [pscustomobject]@{ Name='DAVID'; Id='david'; Port=9444; Launcher=(Join-Path $Root 'START-DAVID-THINKER-ACTOR.ps1'); Base=(Join-Path $Root '.david-instances\david') }
)
$Failures=@{}; $Restarts=@{}
foreach($s in $Instances){$Failures[$s.Name]=0;$Restarts[$s.Name]=0}

function Test-Port([int]$Port){ return [bool](Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) }
function Get-WorkerPid($Spec){
  $p=Join-Path $Spec.Base 'david-soul.pid'; if(!(Test-Path -LiteralPath $p)){return 0}
  $v=(Get-Content -LiteralPath $p -Raw -ErrorAction SilentlyContinue).Trim(); if($v -match '^\d+$'){return [int]$v}; return 0
}
function Test-Worker($Spec){$id=Get-WorkerPid $Spec; if($id -le 0){return $false}; return [bool](Get-Process -Id $id -ErrorAction SilentlyContinue)}
function Stop-OnlyInstance($Spec){
  # No Remove-Item -Recurse anywhere in this supervisor.
  $id=Get-WorkerPid $Spec; if($id -gt 0){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $c=[string]$_.CommandLine
    ($_.ProcessId -ne $PID) -and ($c -like "*--david-soul-instance=$($Spec.Id)*" -or $c -like "*$($Spec.Launcher)*")
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Start-Instance($Spec){
  Assert-Root
  if(!(Test-Path -LiteralPath $Spec.Launcher -PathType Leaf)){throw "Missing launcher: $($Spec.Launcher)"}
  New-Item -ItemType Directory -Force -Path (Join-Path $Spec.Base 'logs') | Out-Null
  $out=Join-Path $Spec.Base 'logs\supervisor-launcher-out.log'; $err=Join-Path $Spec.Base 'logs\supervisor-launcher-error.log'
  $args="-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$($Spec.Launcher)`""
  $p=Start-Process -FilePath $PowerShellExe -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  Write-Host "[$($Spec.Name)] Launcher PID $($p.Id)" -ForegroundColor Cyan
}
function Restart-Instance($Spec){
  Assert-Root
  $Restarts[$Spec.Name]++
  Write-Host "[$($Spec.Name)] AUTO-RESTART #$($Restarts[$Spec.Name])" -ForegroundColor Yellow
  Stop-OnlyInstance $Spec
  Start-Sleep -Seconds 2
  Assert-Root
  Start-Instance $Spec
  $Failures[$Spec.Name]=0
}

Assert-Root
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' DAVID STAGE10 RECOVERY SUPERVISOR V1' -ForegroundColor Cyan
Write-Host ' MITKO 9333 + DAVID 9444' -ForegroundColor Cyan
Write-Host ' ROOT-SAFE: no project directory deletion' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Cyan
foreach($s in $Instances){ Stop-OnlyInstance $s }
Start-Sleep -Seconds 2
foreach($s in $Instances){ Start-Instance $s; Start-Sleep -Seconds 2 }
Write-Host '[READY] Supervisor running. New Edge profiles may ask you to sign in once.' -ForegroundColor Green
while($true){
  Start-Sleep -Seconds $WatchSeconds
  Assert-Root
  Write-Host "[WATCH] $(Get-Date -Format HH:mm:ss)"
  foreach($s in $Instances){
    $worker=Test-Worker $s; $port=Test-Port $s.Port
    if($worker -and $port){$Failures[$s.Name]=0; $state='UP'} else {$Failures[$s.Name]++; $state='DOWN'}
    Write-Host ("  {0,-5} {1,-4} | worker={2} | port={3} | failures={4} | restarts={5}" -f $s.Name,$state,(Get-WorkerPid $s),$s.Port,$Failures[$s.Name],$Restarts[$s.Name])
    if($Failures[$s.Name] -ge 4){ Restart-Instance $s }
  }
}
