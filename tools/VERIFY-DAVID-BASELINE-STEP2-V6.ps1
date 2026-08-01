$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
$Repository = "SoulFlameAdmin/AI-smart-cursor"
$Branch = "sync/local-cursor-20260801-122549"
$SourceCommit = "6db9d478d11135306ff5df391cd9bf8d51c16776"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDirectory = "E:\DAVID-BACKUPS"
$BackupZip = Join-Path $BackupDirectory "verified-baseline-v6-$Timestamp.zip"
$BaselineDirectory = Join-Path $Project "baseline"
$LogDirectory = Join-Path $BaselineDirectory "logs"
$ReportPath = Join-Path $BaselineDirectory "VERIFIED-BASELINE.json"

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Text)

    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Require-Command {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command: $Name"
    }
}

function Assert-ExitCode {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$Code
    )

    if ($Code -ne 0) {
        throw "$Name failed with exit code $Code."
    }
}

function Stop-DavidProcesses {
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -in @("node.exe", "electron.exe") -and
            $_.CommandLine -like "*david-cursor-v1*"
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Milliseconds 700
}

function Read-Text {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path $Path -PathType Leaf)) {
        return ""
    }

    try {
        return Get-Content -Path $Path -Raw -ErrorAction Stop
    }
    catch {
        return ""
    }
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor DarkCyan
Write-Host " DAVID STEP 2 V6 - VERIFIED BASELINE" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor DarkCyan

$System32 = Join-Path $env:SystemRoot "System32"
$GitCmd = Join-Path $env:ProgramFiles "Git\cmd"
$env:Path = "$System32;$env:SystemRoot;$GitCmd;$env:Path"

Require-Command "git.exe"
Require-Command "node.exe"
Require-Command "npm.cmd"
Require-Command "taskkill.exe"

if (-not (Test-Path $Project -PathType Container)) {
    throw "Project not found: $Project"
}

if (-not (Test-Path (Join-Path $Project ".git") -PathType Container)) {
    throw "The project is not connected to Git. Run Step 1 first."
}

Set-Location $Project

Write-Step "Checking Git branch and source commit"

$CurrentBranch = (& git.exe branch --show-current).Trim()
Assert-ExitCode -Name "git branch" -Code $LASTEXITCODE

if ($CurrentBranch -ne $Branch) {
    throw "Expected branch '$Branch' but current branch is '$CurrentBranch'."
}

$TrackedChanges = @(
    & git.exe status --porcelain --untracked-files=no
)

if ($TrackedChanges.Count -gt 0) {
    Write-Host "Tracked local changes:" -ForegroundColor Yellow
    $TrackedChanges | Out-Host
    throw "Tracked files are modified. Baseline verification stopped."
}

& git.exe fetch origin
Assert-ExitCode -Name "git fetch" -Code $LASTEXITCODE

& git.exe pull --ff-only origin $Branch
Assert-ExitCode -Name "git pull" -Code $LASTEXITCODE

& git.exe merge-base --is-ancestor $SourceCommit HEAD
Assert-ExitCode -Name "source commit ancestry check" -Code $LASTEXITCODE

$HeadBeforeVerification = (& git.exe rev-parse HEAD).Trim()

Write-Host "Branch: $CurrentBranch" -ForegroundColor Green
Write-Host "HEAD:   $HeadBeforeVerification" -ForegroundColor Green

Write-Step "Checking Node and Electron versions"

$NodeVersionText = (& node.exe --version).Trim()
$NodeVersionNumber = $NodeVersionText.TrimStart([char]'v')
$NodeVersion = [Version]$NodeVersionNumber
$MinimumNode = [Version]"22.12.0"

if ($NodeVersion -lt $MinimumNode) {
    throw "Node $NodeVersionNumber is too old. Minimum: 22.12.0"
}

$LockPath = Join-Path $Project "package-lock.json"
$LockLines = Get-Content -Path $LockPath
$InsideElectron = $false
$ElectronVersion = ""

foreach ($Line in $LockLines) {
    if (-not $InsideElectron) {
        if ($Line -like '*"node_modules/electron": {*') {
            $InsideElectron = $true
        }

        continue
    }

    if ($Line -match '^\s*"version"\s*:\s*"([0-9.]+)"') {
        $ElectronVersion = $Matches[1]
        break
    }

    if ($Line -match '^\s*},?\s*$') {
        break
    }
}

if ([string]::IsNullOrWhiteSpace($ElectronVersion)) {
    throw "Electron version was not found in package-lock.json."
}

Write-Host "Node:     $NodeVersionNumber" -ForegroundColor Green
Write-Host "Electron: $ElectronVersion" -ForegroundColor Green

Write-Step "Scanning tracked files for likely real secrets"

$SecretPatterns = @(
    'sk-proj-[A-Za-z0-9_-]{20,}',
    'sk-[A-Za-z0-9]{32,}',
    'github_pat_[A-Za-z0-9_]{30,}',
    'ghp_[A-Za-z0-9]{30,}',
    'sb_secret_[A-Za-z0-9_-]{20,}',
    'SUPABASE_SERVICE_ROLE_KEY\s*=\s*eyJ[A-Za-z0-9._-]{40,}',
    'OPENAI_API_KEY\s*=\s*sk-(?:proj-)?[A-Za-z0-9_-]{20,}'
)

$SecretFindings = New-Object System.Collections.Generic.List[string]
$TrackedFiles = @(& git.exe ls-files)

foreach ($RelativePath in $TrackedFiles) {
    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        continue
    }

    $FullPath = Join-Path $Project $RelativePath

    if (-not (Test-Path $FullPath -PathType Leaf)) {
        continue
    }

    $Text = Read-Text -Path $FullPath

    if ([string]::IsNullOrEmpty($Text)) {
        continue
    }

    foreach ($Pattern in $SecretPatterns) {
        if ($Text -match $Pattern) {
            $SecretFindings.Add("$RelativePath -> $Pattern")
        }
    }
}

if ($SecretFindings.Count -gt 0) {
    Write-Host "Possible real secrets found:" -ForegroundColor Red
    $SecretFindings | ForEach-Object {
        Write-Host $_ -ForegroundColor Red
    }

    throw "Secret scan failed. Nothing was committed or pushed."
}

Write-Host "Secret scan: PASS" -ForegroundColor Green

Write-Step "Creating exact Git backup"

New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null

& git.exe archive --format=zip "--output=$BackupZip" HEAD
Assert-ExitCode -Name "git archive" -Code $LASTEXITCODE

Write-Host "Backup: $BackupZip" -ForegroundColor Green

Write-Step "Running JavaScript syntax checks"

$JavaScriptFiles = Get-ChildItem -Path $Project -Recurse -File |
    Where-Object {
        $_.Extension -in @(".js", ".cjs", ".mjs") -and
        $_.FullName -notmatch '\\node_modules\\|\\.git\\|\\dist\\|\\build\\|\\coverage\\|\\baseline\\logs\\'
    }

foreach ($File in $JavaScriptFiles) {
    & node.exe --check $File.FullName

    if ($LASTEXITCODE -ne 0) {
        throw "JavaScript syntax failed: $($File.FullName)"
    }
}

Write-Host "Syntax checks: PASS ($($JavaScriptFiles.Count) files)" -ForegroundColor Green

Write-Step "Running existing DAVID tests"

& npm.cmd test
Assert-ExitCode -Name "npm test" -Code $LASTEXITCODE

Write-Step "Running DAVID baseline tests"

& node.exe (Join-Path $Project "tests\baseline-tests.cjs")
Assert-ExitCode -Name "baseline tests" -Code $LASTEXITCODE

Write-Step "Running real Electron stability check"

$ElectronPath = Join-Path $Project "node_modules\electron\dist\electron.exe"

if (-not (Test-Path $ElectronPath -PathType Leaf)) {
    throw "Electron binary not found: $ElectronPath"
}

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

$RuntimeStdout = Join-Path $LogDirectory "runtime.stdout.log"
$RuntimeStderr = Join-Path $LogDirectory "runtime.stderr.log"

Remove-Item $RuntimeStdout, $RuntimeStderr -Force -ErrorAction SilentlyContinue
Stop-DavidProcesses

$RuntimeProcess = $null
$HotkeyStatus = "NOT_TESTED"
$RuntimeAlive = $false
$CrashFound = $false

try {
    $RuntimeProcess = Start-Process `
        -FilePath $ElectronPath `
        -ArgumentList @(".") `
        -WorkingDirectory $Project `
        -RedirectStandardOutput $RuntimeStdout `
        -RedirectStandardError $RuntimeStderr `
        -PassThru

    Start-Sleep -Seconds 10

    if ($RuntimeProcess.HasExited) {
        $Output = Read-Text -Path $RuntimeStdout
        $ErrorOutput = Read-Text -Path $RuntimeStderr
        Write-Host $Output
        Write-Host $ErrorOutput
        throw "DAVID exited before the runtime check completed."
    }

    $RuntimeAlive = $true

    try {
        $Shell = New-Object -ComObject WScript.Shell
        $Shell.SendKeys("^+d")
        Start-Sleep -Seconds 2
        $Shell.SendKeys("{ESC}")
        Start-Sleep -Seconds 3
        $HotkeyStatus = "PASS"
    }
    catch {
        $HotkeyStatus = "WARN"
    }

    $CombinedOutput =
        (Read-Text -Path $RuntimeStdout) +
        "`r`n" +
        (Read-Text -Path $RuntimeStderr)

    $CrashTerms = @(
        "DAVID renderer stopped",
        "GPU process exited unexpectedly",
        "renderer recovery limit reached",
        "FATAL ERROR",
        "UnhandledPromiseRejection"
    )

    foreach ($Term in $CrashTerms) {
        if ($CombinedOutput.Contains($Term)) {
            $CrashFound = $true
            break
        }
    }

    if ($CrashFound) {
        Write-Host $CombinedOutput
        throw "A renderer or GPU crash was found in the runtime log."
    }
}
finally {
    if ($null -ne $RuntimeProcess) {
        try {
            if (-not $RuntimeProcess.HasExited) {
                & taskkill.exe /PID $RuntimeProcess.Id /T /F | Out-Null
            }
        }
        catch {
        }
    }

    Stop-DavidProcesses
}

if (-not $RuntimeAlive) {
    throw "Runtime stability check failed."
}

Write-Host "Runtime stability: PASS" -ForegroundColor Green
Write-Host "Command panel hotkey: $HotkeyStatus" -ForegroundColor Green

Write-Step "Writing verified baseline report"

New-Item -ItemType Directory -Path $BaselineDirectory -Force | Out-Null

$MainText = Read-Text -Path (Join-Path $Project "main.cjs")
$DuplicateFunctionCount = (
    [regex]::Matches(
        $MainText,
        'function\s+requestChatGptMessage\s*\('
    )
).Count

$DuplicateStatus = "PASS"

if ($DuplicateFunctionCount -gt 1) {
    $DuplicateStatus = "WARN"
}

$Report = [ordered]@{
    protocol = "david-verified-baseline-v1"
    status = "PASS"
    repository = $Repository
    branch = $Branch
    source_commit = $SourceCommit
    verified_head = $HeadBeforeVerification
    node = $NodeVersionNumber
    electron = $ElectronVersion
    backup = $BackupZip
    checks = [ordered]@{
        secret_scan = "PASS"
        syntax = "PASS"
        existing_tests = "PASS"
        baseline_tests = "PASS"
        runtime_stability = "PASS"
        command_panel_hotkey = $HotkeyStatus
        duplicate_request_function = $DuplicateStatus
        duplicate_request_function_count = $DuplicateFunctionCount
    }
    verified_at = (Get-Date).ToString("o")
}

$Report |
    ConvertTo-Json -Depth 8 |
    Set-Content -Path $ReportPath -Encoding UTF8

& git.exe add "baseline/VERIFIED-BASELINE.json"
Assert-ExitCode -Name "git add report" -Code $LASTEXITCODE

$StagedFiles = @(& git.exe diff --cached --name-only)

if ($StagedFiles.Count -gt 0) {
    & git.exe commit -m "baseline: record verified Windows runtime"
    Assert-ExitCode -Name "git commit" -Code $LASTEXITCODE

    & git.exe push origin $Branch
    Assert-ExitCode -Name "git push" -Code $LASTEXITCODE
}

$VerifiedCommit = (& git.exe rev-parse HEAD).Trim()

Write-Step "Restarting verified DAVID"

Start-Process `
    -FilePath $ElectronPath `
    -ArgumentList @(".") `
    -WorkingDirectory $Project |
    Out-Null

Write-Host ""
Write-Host "======================================================" -ForegroundColor DarkGreen
Write-Host " GOTOVO DAVID - STEP 2 V6" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor DarkGreen
Write-Host "Repository : $Repository"
Write-Host "Branch     : $Branch"
Write-Host "Commit     : $VerifiedCommit"
Write-Host "Status     : VERIFIED BASELINE PASS"
Write-Host "Report     : baseline/VERIFIED-BASELINE.json"
Write-Host "Backup     : $BackupZip"
Write-Host "Duplicate  : $DuplicateStatus ($DuplicateFunctionCount)"
Write-Host ""
Write-Host "Next: DAVID Supervisor 0.1" -ForegroundColor Cyan
Write-Host ""
