[CmdletBinding()]
param(
  [ValidatePattern('^https://chatgpt\.com/c/[A-Za-z0-9-]+(?:[/?#].*)?$')]
  [string]$BorkoChatUrl = '',

  [switch]$RunTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$mitkoLauncher = Join-Path $root 'START-MITKO-DAVID-SOUL.ps1'
$borkoLauncher = Join-Path $root 'START-BORKO-DAVID-SOUL.ps1'
$borkoInstanceEnv = Join-Path $root '.david-instances\borko\instance.env'

if (-not (Test-Path -LiteralPath $mitkoLauncher)) { throw 'Missing START-MITKO-DAVID-SOUL.ps1.' }
if (-not (Test-Path -LiteralPath $borkoLauncher)) { throw 'Missing START-BORKO-DAVID-SOUL.ps1.' }

if ($BorkoChatUrl) {
  & $borkoLauncher -ChatUrl $BorkoChatUrl -ConfigureOnly
}

if (-not (Test-Path -LiteralPath $borkoInstanceEnv)) {
  throw 'Borko is not configured. Run START-BOTH-DAVID-SOUL.ps1 once with -BorkoChatUrl.'
}

function Find-PowerShellExecutable {
  $candidates = New-Object System.Collections.Generic.List[string]

  try {
    $currentProcess = Get-Process -Id $PID -ErrorAction Stop
    if ($currentProcess.Path) {
      $candidates.Add([string]$currentProcess.Path)
    }
  } catch {}

  if ($PSHOME) {
    $candidates.Add((Join-Path $PSHOME 'powershell.exe'))
    $candidates.Add((Join-Path $PSHOME 'pwsh.exe'))
  }

  if ($env:SystemRoot) {
    $candidates.Add((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  }

  if ($env:WINDIR) {
    $candidates.Add((Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'))
  }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  throw 'PowerShell executable was not found. Windows PowerShell or PowerShell 7 is required.'
}

$powerShellExe = Find-PowerShellExecutable
$testArgument = if ($RunTests) { ' -RunTests' } else { '' }

$mitkoArguments = "-NoExit -ExecutionPolicy Bypass -File `"$mitkoLauncher`" -OpenTwins$testArgument"
$borkoArguments = "-NoExit -ExecutionPolicy Bypass -File `"$borkoLauncher`"$testArgument"

$mitkoProcess = Start-Process -FilePath $powerShellExe -ArgumentList $mitkoArguments -WorkingDirectory $root -PassThru
Start-Sleep -Seconds 2
$borkoProcess = Start-Process -FilePath $powerShellExe -ArgumentList $borkoArguments -WorkingDirectory $root -PassThru

Write-Host '============================================================' -ForegroundColor Green
Write-Host '  TWO DAVID SOUL SERVERS STARTED' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host "  PowerShell executable       : $powerShellExe"
Write-Host "  MITKO launcher window PID   : $($mitkoProcess.Id)"
Write-Host '  MITKO Edge port starts at   : 9333'
Write-Host '  MITKO storage               : .david-instances\mitko'
Write-Host ''
Write-Host "  BORKO launcher window PID   : $($borkoProcess.Id)"
Write-Host '  BORKO Edge port starts at   : 9444'
Write-Host '  BORKO storage               : .david-instances\borko'
Write-Host ''
Write-Host '  Each server has its own worker, queue owner, Edge profile and fixed GPT chat.'
Write-Host '  Closing or stopping one server does not stop the other.'
Write-Host '============================================================' -ForegroundColor Green
