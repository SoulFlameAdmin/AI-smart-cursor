[CmdletBinding()]
param(
  [switch]$RunTests,
  [switch]$OpenTwins
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$arguments = @{
  InstanceName = 'david'
  InstanceEnvFile = '.david-instances\david\instance.env'
  PreferredDebugPort = 9444
  StrictDebugPort = $true
  StartupTimeoutSeconds = 180
}
if ($RunTests) { $arguments.RunTests = $true }
if ($OpenTwins) { $arguments.OpenTwins = $true }

& (Join-Path $root 'START-DAVID-SOUL-INSTANCE.ps1') @arguments
exit 0
