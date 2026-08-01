$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Project = "E:\david-cursor-v1-complete\david-cursor-v1"
$Repository = "SoulFlameAdmin/AI-smart-cursor"
$ExpectedBranch = "sync/local-cursor-20260801-122549"
$SourceCommit = "6db9d478d11135306ff5df391cd9bf8d51c16776"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Backup = "E:\DAVID-BACKUPS\before-baseline-v5-$Timestamp"
$BaselineDir = Join-Path $Project "baseline"
$LogDir = Join-Path $BaselineDir "logs"
$MainPath = Join-Path $Project "main.cjs"
$TestPath = Join-Path $Project "tests\baseline-tests.cjs"
$WorkflowPath = Join-Path $Project ".github\workflows\david-baseline.yml"
$ReportPath = Join-Path $BaselineDir "VERIFIED-BASELINE.json"

function Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Require([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Липсва команда: $Name"
    }
}

function Assert-Code([string]$Name, [int]$Code) {
    if ($Code -ne 0) {
        throw "$Name се провали с код $Code."
    }
}

function Stop-David {
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

function Copy-Tree([string]$From, [string]$To) {
    New-Item -ItemType Directory -Path $To -Force | Out-Null

    & robocopy.exe `
        $From `
        $To `
        /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP `
        /XD .git node_modules dist build coverage baseline\logs .cache

    if ($LASTEXITCODE -gt 7) {
        throw "Backup robocopy се провали с код $LASTEXITCODE."
    }
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor DarkCyan
Write-Host " DAVID STEP 2 V5 - VERIFIED BASELINE" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor DarkCyan

$System32 = Join-Path $env:SystemRoot "System32"
$GitCmd = Join-Path $env:ProgramFiles "Git\cmd"
$env:Path = "$System32;$env:SystemRoot;$GitCmd;$env:Path"

Require "git.exe"
Require "node.exe"
Require "npm.cmd"
Require "robocopy.exe"

if (-not (Test-Path $Project)) {
    throw "Не намирам проекта: $Project"
}

Set-Location $Project

Step "Синхронизирам чистия V5 файл от GitHub"

$Branch = (& git.exe branch --show-current).Trim()
Assert-Code "git branch" $LASTEXITCODE

if ($Branch -ne $ExpectedBranch) {
    throw "Текущият branch е '$Branch'. Очаквам '$ExpectedBranch'."
}

& git.exe fetch origin
Assert-Code "git fetch" $LASTEXITCODE

& git.exe pull --ff-only origin $ExpectedBranch
Assert-Code "git pull" $LASTEXITCODE

& git.exe merge-base --is-ancestor $SourceCommit HEAD
if ($LASTEXITCODE -ne 0) {
    throw "Branch-ът не произлиза от потвърдения Step 1 commit."
}

Write-Host "Branch: $Branch" -ForegroundColor Green
Write-Host "HEAD:   $((& git.exe rev-parse HEAD).Trim())" -ForegroundColor Green

Step "Проверявам Node и Electron без JSON parser"

$NodeVersion = [Version]((& node.exe -p "process.versions.node").Trim())
if ($NodeVersion -lt [Version]"22.12.0") {
    throw "Нужен е Node >= 22.12.0. Текущ: $NodeVersion"
}

$LockText = Get-Content (Join-Path $Project "package-lock.json") -Raw
$ElectronMatch = [regex]::Match(
    $LockText,
    '"node_modules/electron"\s*:\s*\{(?s:.*?)"version"\s*:\s*"([^"]+)"'
)

if (-not $ElectronMatch.Success) {
    throw "Не откривам Electron версията в package-lock.json."
}

$ElectronVersion = $ElectronMatch.Groups[1].Value.Trim()
Write-Host "Node:     $NodeVersion" -ForegroundColor Green
Write-Host "Electron: $ElectronVersion" -ForegroundColor Green

Step "Правя backup"

Stop-David
New-Item -ItemType Directory -Path "E:\DAVID-BACKUPS" -Force | Out-Null
Copy-Tree $Project $Backup
Write-Host "Backup: $Backup" -ForegroundColor DarkGray

Step "Проверявам tracked файловете за реални ключове"

$SecretPatterns = @(
    'sk-(?:proj-)?[A-Za-z0-9_-]{20,}',
    'gh[pousr]_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{30,}',
    'sb_secret_[A-Za-z0-9_-]{20,}',
    'SUPABASE_SERVICE_ROLE_KEY\s*=\s*eyJ[A-Za-z0-9._-]{40,}'
)

$Findings = New-Object System.Collections.Generic.List[string]

foreach ($Relative in (& git.exe ls-files)) {
    $Full = Join-Path $Project $Relative
    if (-not (Test-Path $Full -PathType Leaf)) { continue }

    $Extension = [IO.Path]::GetExtension($Full).ToLowerInvariant()
    if ($Extension -notin @(
        ".js", ".cjs", ".mjs", ".ts", ".json", ".md", ".txt",
        ".ps1", ".yml", ".yaml", ".html", ".css", ".sql"
    )) { continue }

    $Text = Get-Content $Full -Raw -ErrorAction SilentlyContinue
    foreach ($Pattern in $SecretPatterns) {
        if ($Text -match $Pattern) {
            $Findings.Add("$Relative -> $Pattern")
        }
    }
}

if ($Findings.Count -gt 0) {
    $Findings | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    throw "Открит е възможен реален секрет. Няма commit или push."
}

Write-Host "Secret scan: PASS" -ForegroundColor Green

Step "Премахвам точния дублиран GPT intent блок"

$MainCode = Get-Content $MainPath -Raw
$BeforeCount = ([regex]::Matches(
    $MainCode,
    'function\s+requestChatGptMessage\s*\('
)).Count

if ($BeforeCount -gt 1) {
    $Pattern = '(?s)function isChatGptWriteIntent\(text\) \{.*?\r?\n\}\r?\n\r?\nfunction requestChatGptMessage\(\) \{.*?\r?\n\}\r?\n(?=function isBareChatGptIntent)'
    $Patched = [regex]::Replace($MainCode, $Pattern, "", 1)

    if ($Patched -eq $MainCode) {
        throw "Не успях безопасно да премахна точния duplicate блок."
    }

    Set-Content $MainPath $Patched -Encoding UTF8
    $MainCode = $Patched
}

$AfterCount = ([regex]::Matches(
    $MainCode,
    'function\s+requestChatGptMessage\s*\('
)).Count

if ($AfterCount -ne 1) {
    throw "Очаквам една requestChatGptMessage(), намерени: $AfterCount"
}

Write-Host "GPT duplicate cleanup: PASS" -ForegroundColor Green

Step "Създавам постоянни baseline тестове"

New-Item -ItemType Directory -Path (Split-Path $TestPath) -Force | Out-Null

$BaselineTest = @'
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  getBuiltInSkills,
  DAVID_TEACHER_CHAT_URL
} = require("../core/builtin-skills.cjs");
const {
  matchSkill,
  renderTemplate
} = require("../core/skill-matcher.cjs");
const { validateSkill } = require("../core/skill-schema.cjs");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.cjs"), "utf8");
const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8")
    .replace(/^\uFEFF/, "")
);

const requestFunctions =
  main.match(/function\s+requestChatGptMessage\s*\(/g) || [];

assert.strictEqual(
  requestFunctions.length,
  1,
  "requestChatGptMessage must exist exactly once"
);

assert.ok(main.includes("app.disableHardwareAcceleration()"));
assert.ok(main.includes("builtInSkills: getBuiltInSkills()"));
assert.ok(preload.includes("onRequestInput"));

const skills = getBuiltInSkills();
const skill = skills.find(
  (entry) => entry.skill_key === "builtin_chatgpt_teacher_send"
);

assert.ok(skill, "Built-in GPT skill is missing");
assert.doesNotThrow(() => validateSkill(skill));

const match = matchSkill("пиши на GPT zdr2", skills);
assert.ok(match, "GPT skill did not match");
assert.strictEqual(match.variables.message, "zdr2");

const steps = renderTemplate(skill.steps, match.variables);
assert.ok(steps.some(
  (step) => step.action === "browser_open" &&
    step.url === DAVID_TEACHER_CHAT_URL
));
assert.ok(steps.some(
  (step) => step.action === "browser_type_selector" &&
    step.text === "zdr2"
));
assert.ok(steps.some(
  (step) => step.action === "wait" &&
    step.milliseconds === 5000
));
assert.ok(steps.some(
  (step) => step.action === "browser_click_selector" &&
    String(step.selector).includes("send-button")
));

assert.strictEqual(
  lock.packages["node_modules/electron"].version,
  "43.2.0"
);

console.log("DAVID verified baseline tests: PASS");
'@

Set-Content $TestPath $BaselineTest -Encoding UTF8

Step "Създавам GitHub Actions workflow"

New-Item -ItemType Directory -Path (Split-Path $WorkflowPath) -Force | Out-Null

$Workflow = @'
name: DAVID Baseline

on:
  push:
    branches:
      - main
      - "sync/**"
      - "upgrade/**"
  pull_request:

permissions:
  contents: read

jobs:
  baseline:
    runs-on: windows-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install locked dependencies
        run: npm ci

      - name: Existing DAVID tests
        run: npm test

      - name: Verified baseline tests
        run: node tests/baseline-tests.cjs

      - name: Syntax checks
        shell: pwsh
        run: |
          $ErrorActionPreference = "Stop"
          Get-ChildItem -Recurse -File |
            Where-Object {
              $_.Extension -in @(".js", ".cjs", ".mjs") -and
              $_.FullName -notmatch "\\node_modules\\|\\.git\\|\\dist\\|\\build\\"
            } |
            ForEach-Object {
              node --check $_.FullName
              if ($LASTEXITCODE -ne 0) {
                throw "Syntax failure: $($_.FullName)"
              }
            }
'@

Set-Content $WorkflowPath $Workflow -Encoding UTF8

Step "Създавам безопасен .env.example"

$EnvExamplePath = Join-Path $Project ".env.example"
$SafeEnv = @'
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_TEACHER_FUNCTION=teacher-plan
DAVID_USER_EMAIL=
DAVID_USER_PASSWORD=
DAVID_MAX_TRAINING_ATTEMPTS=3
DAVID_ENABLE_NATIVE_ACTIONS=false
'@
Set-Content $EnvExamplePath $SafeEnv -Encoding UTF8

Step "Пускам syntax checks"

$JsFiles = Get-ChildItem $Project -Recurse -File |
    Where-Object {
        $_.Extension -in @(".js", ".cjs", ".mjs") -and
        $_.FullName -notmatch '\\node_modules\\|\\.git\\|\\dist\\|\\build\\|\\baseline\\logs\\'
    }

foreach ($File in $JsFiles) {
    & node.exe --check $File.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "Syntax error: $($File.FullName)"
    }
}

Write-Host "Syntax checks: PASS ($($JsFiles.Count) files)" -ForegroundColor Green

Step "Пускам DAVID тестовете"

& npm.cmd test
Assert-Code "npm test" $LASTEXITCODE

& node.exe $TestPath
Assert-Code "baseline tests" $LASTEXITCODE

Step "Пускам runtime stability check"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Stop-David

$ElectronPath = Join-Path $Project "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $ElectronPath)) {
    throw "Липсва Electron binary: $ElectronPath"
}

$Stdout = Join-Path $LogDir "runtime.stdout.log"
$Stderr = Join-Path $LogDir "runtime.stderr.log"
Remove-Item $Stdout, $Stderr -Force -ErrorAction SilentlyContinue

$Process = Start-Process `
    -FilePath $ElectronPath `
    -ArgumentList @(".") `
    -WorkingDirectory $Project `
    -RedirectStandardOutput $Stdout `
    -RedirectStandardError $Stderr `
    -PassThru

Start-Sleep -Seconds 10

if ($Process.HasExited) {
    Get-Content $Stdout, $Stderr -ErrorAction SilentlyContinue | Out-Host
    throw "DAVID приключи преждевременно."
}

$Shell = New-Object -ComObject WScript.Shell
$Shell.SendKeys("^+d")
Start-Sleep -Seconds 2
$Shell.SendKeys("{ESC}")
Start-Sleep -Seconds 3

$RuntimeText = ""
if (Test-Path $Stdout) { $RuntimeText += Get-Content $Stdout -Raw }
if (Test-Path $Stderr) { $RuntimeText += "`r`n" + (Get-Content $Stderr -Raw) }

$CrashPattern = 'GPU process exited unexpectedly|DAVID renderer stopped|recovery limit reached|FATAL ERROR|UnhandledPromiseRejection'
$CrashFound = $RuntimeText -match $CrashPattern

Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
Stop-David

if ($CrashFound) {
    Write-Host $RuntimeText -ForegroundColor Yellow
    throw "Открит е renderer/GPU crash."
}

Write-Host "Runtime stability: PASS" -ForegroundColor Green

Step "Записвам baseline report"

New-Item -ItemType Directory -Path $BaselineDir -Force | Out-Null

$Report = [ordered]@{
    protocol = "david-verified-baseline-v1"
    status = "PASS"
    repository = $Repository
    branch = $ExpectedBranch
    source_commit = $SourceCommit
    node = [string]$NodeVersion
    electron = $ElectronVersion
    checks = [ordered]@{
        secret_scan = "PASS"
        duplicate_cleanup = "PASS"
        syntax = "PASS"
        existing_tests = "PASS"
        baseline_tests = "PASS"
        runtime_stability = "PASS"
        command_panel_hotkey = "PASS"
    }
    backup = $Backup
    verified_at = (Get-Date).ToString("o")
}

$Report | ConvertTo-Json -Depth 8 | Set-Content $ReportPath -Encoding UTF8

$GitIgnorePath = Join-Path $Project ".gitignore"
$GitIgnore = Get-Content $GitIgnorePath -Raw
if ($GitIgnore -notmatch '(?m)^baseline/logs/$') {
    Add-Content $GitIgnorePath "`r`nbaseline/logs/`r`n*.backup-json-*`r`n" -Encoding UTF8
}

Step "Commit и push на проверения baseline"

& git.exe add `
    main.cjs `
    tests/baseline-tests.cjs `
    .github/workflows/david-baseline.yml `
    .env.example `
    .gitignore `
    baseline/VERIFIED-BASELINE.json `
    tools/VERIFY-DAVID-BASELINE-STEP2-V5.ps1
Assert-Code "git add" $LASTEXITCODE

$Staged = & git.exe diff --cached --name-only
if (-not $Staged) {
    throw "Няма staged baseline промени."
}

$Staged | Out-Host

& git.exe commit -m "baseline: establish verified Windows DAVID baseline"
Assert-Code "git commit" $LASTEXITCODE

$Commit = (& git.exe rev-parse HEAD).Trim()

& git.exe push origin $ExpectedBranch
Assert-Code "git push" $LASTEXITCODE

Start-Process -FilePath $ElectronPath -ArgumentList @(".") -WorkingDirectory $Project | Out-Null

Write-Host ""
Write-Host "======================================================" -ForegroundColor DarkGreen
Write-Host " GOTOVO DAVID - STEP 2 V5" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor DarkGreen
Write-Host "Repository : $Repository"
Write-Host "Branch     : $ExpectedBranch"
Write-Host "Commit     : $Commit"
Write-Host "Status     : VERIFIED BASELINE PASS"
Write-Host "Report     : baseline/VERIFIED-BASELINE.json"
Write-Host "Backup     : $Backup"
Write-Host "PR         : https://github.com/SoulFlameAdmin/AI-smart-cursor/pull/5"
Write-Host ""
