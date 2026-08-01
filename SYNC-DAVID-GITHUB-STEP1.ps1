$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Source = "E:\david-cursor-v1-complete\david-cursor-v1"
$RepoUrl = "https://github.com/SoulFlameAdmin/AI-smart-cursor.git"
$RepoFullName = "SoulFlameAdmin/AI-smart-cursor"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Branch = "sync/local-cursor-$Timestamp"
$Staging = "E:\DAVID-GITHUB-STAGING-$Timestamp"
$BackupRoot = "E:\DAVID-BACKUPS"
$Backup = Join-Path $BackupRoot "before-github-sync-$Timestamp"

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Require-Command([string]$Name) {
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $Command) {
        throw "Липсва командата '$Name'. Инсталирай Git for Windows и пусни скрипта отново."
    }
}

function Invoke-RobocopySafe {
    param(
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$To,
        [string[]]$ExtraArgs = @()
    )

    New-Item -ItemType Directory -Path $To -Force | Out-Null

    $Args = @(
        $From,
        $To,
        "/E",
        "/COPY:DAT",
        "/DCOPY:DAT",
        "/R:2",
        "/W:1",
        "/XJ",
        "/NFL",
        "/NDL",
        "/NP"
    ) + $ExtraArgs

    & robocopy.exe @Args | Out-Host
    $Code = $LASTEXITCODE

    # Robocopy 0-7 = success / copied / extra files / mismatches handled.
    if ($Code -gt 7) {
        throw "Robocopy се провали с код $Code."
    }
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor DarkCyan
Write-Host " DAVID STEP 1 - LOCAL CURSOR -> PRIVATE GITHUB BRANCH" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor DarkCyan

Require-Command "git.exe"
Require-Command "robocopy.exe"

if (-not (Test-Path $Source)) {
    throw "Не намирам DAVID проекта: $Source"
}

Write-Step "Спирам старите DAVID процеси"

Get-CimInstance Win32_Process |
Where-Object {
    $_.Name -in @("node.exe", "electron.exe") -and
    $_.CommandLine -like "*david-cursor-v1*"
} |
ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 700

Write-Step "Правя локален backup преди GitHub синхронизация"

New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null

Invoke-RobocopySafe `
    -From $Source `
    -To $Backup `
    -ExtraArgs @(
        "/XD",
        ".git",
        "node_modules",
        ".cache",
        "dist",
        "build",
        "coverage"
    )

Write-Host "Backup: $Backup" -ForegroundColor DarkGray

Write-Step "Клонирам частното GitHub хранилище"

if (Test-Path $Staging) {
    Remove-Item $Staging -Recurse -Force
}

& git.exe clone $RepoUrl $Staging

if ($LASTEXITCODE -ne 0) {
    throw @"
GitHub clone се провали.

Влез в GitHub през Git Credential Manager и пусни скрипта отново.
Хранилище: $RepoFullName
"@
}

Set-Location $Staging

Write-Step "Създавам безопасен branch: $Branch"

& git.exe checkout -b $Branch

if ($LASTEXITCODE -ne 0) {
    throw "Не успях да създам branch $Branch."
}

Write-Step "Копирам реалния работещ DAVID без секрети и тежки локални папки"

Invoke-RobocopySafe `
    -From $Source `
    -To $Staging `
    -ExtraArgs @(
        "/XD",
        ".git",
        "node_modules",
        ".cache",
        ".next",
        "dist",
        "build",
        "coverage",
        "backups",
        "backup",
        "backup-*",
        "david-data",
        "user-data",
        "userdata",
        "logs",
        "/XF",
        ".env",
        ".env.*",
        "*.log",
        "*.tmp",
        "*.bak",
        "*.backup",
        "*.backup-*",
        "*.dmp"
    )

$GitIgnore = @'
# Dependencies
node_modules/

# Secrets
.env
.env.*
!.env.example
*.pem
*.key
*.pfx
*.p12

# Local DAVID state
david-data/
user-data/
userdata/
logs/
.david-sync.json

# Generated output
dist/
build/
coverage/
.cache/
.next/

# Backups and crash files
backup/
backups/
backup-*/
*.backup
*.backup-*
*.bak
*.tmp
*.log
*.dmp

# OS / editors
.DS_Store
Thumbs.db
desktop.ini
.vscode/
.idea/
'@

Set-Content `
    -Path (Join-Path $Staging ".gitignore") `
    -Value $GitIgnore `
    -Encoding UTF8

$Snapshot = @"
# DAVID Local Cursor Snapshot

Imported from the working Windows DAVID Cursor project.

- Source path: ``E:\david-cursor-v1-complete\david-cursor-v1``
- Import branch: ``$Branch``
- Import time: ``$(Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz")``
- Secrets, dependencies, local state, logs and backups are excluded.
- This branch must be reviewed and tested before merging into ``main``.
"@

Set-Content `
    -Path (Join-Path $Staging "DAVID-LOCAL-SNAPSHOT.md") `
    -Value $Snapshot `
    -Encoding UTF8

Write-Step "Проверявам staged файловете за вероятни секрети"

$SecretPatterns = @(
    'sk-proj-[A-Za-z0-9_-]{20,}',
    'sk-[A-Za-z0-9]{32,}',
    'ghp_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{30,}',
    'sb_secret_[A-Za-z0-9_-]{20,}',
    'SUPABASE_SERVICE_ROLE_KEY\s*=\s*(?:eyJ[A-Za-z0-9._-]{40,}|sb_secret_[A-Za-z0-9_-]{20,})',
    'OPENAI_API_KEY\s*=\s*sk-(?:proj-)?[A-Za-z0-9_-]{20,}'
)

$TextExtensions = @(
    ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx",
    ".json", ".md", ".txt", ".ps1", ".yml", ".yaml",
    ".html", ".css", ".toml", ".ini", ".conf"
)

$Suspicious = New-Object System.Collections.Generic.List[object]

Get-ChildItem $Staging -Recurse -File |
Where-Object {
    $_.FullName -notlike "$Staging\.git\*" -and
    $TextExtensions -contains $_.Extension.ToLowerInvariant()
} |
ForEach-Object {
    $File = $_

    foreach ($Pattern in $SecretPatterns) {
        $Match = Select-String `
            -Path $File.FullName `
            -Pattern $Pattern `
            -AllMatches `
            -ErrorAction SilentlyContinue

        if ($Match) {
            $Suspicious.Add([PSCustomObject]@{
                File = $File.FullName.Substring($Staging.Length + 1)
                Pattern = $Pattern
            })
        }
    }
}

if ($Suspicious.Count -gt 0) {
    Write-Host ""
    Write-Host "ОТКРИТ Е ВЪЗМОЖЕН СЕКРЕТ. PUSH Е СПРЯН." -ForegroundColor Red
    $Suspicious | Format-Table -AutoSize | Out-Host
    throw "Премахни секретите от показаните файлове и пусни скрипта отново."
}

Write-Host "Не са открити вероятни API ключове." -ForegroundColor Green

Write-Step "Подготвям Git commit"

$CurrentName = (& git.exe config user.name 2>$null)
$CurrentEmail = (& git.exe config user.email 2>$null)

if (-not $CurrentName) {
    & git.exe config user.name "SoulFlameAdmin"
}

if (-not $CurrentEmail) {
    & git.exe config user.email "david-brain@users.noreply.github.com"
}

& git.exe add -A

$Changes = (& git.exe status --short)

if (-not $Changes) {
    Write-Host "Няма нови промени за commit." -ForegroundColor Yellow
}
else {
    $Changes | Out-Host

    & git.exe commit `
        -m "sync: import working DAVID Cursor from local machine"

    if ($LASTEXITCODE -ne 0) {
        throw "Git commit се провали."
    }
}

Write-Step "Качвам branch-а в GitHub"

& git.exe push -u origin $Branch

if ($LASTEXITCODE -ne 0) {
    throw "GitHub push се провали. Локалният backup е запазен в $Backup"
}

$Commit = (& git.exe rev-parse HEAD).Trim()

Write-Step "Свързвам реалната E:\ папка с точния Git commit"

# Копира GitHub union-а обратно: добавя Brain файловете, без да трие node_modules.
Invoke-RobocopySafe `
    -From $Staging `
    -To $Source `
    -ExtraArgs @(
        "/XD",
        ".git",
        "node_modules"
    )

$SourceGit = Join-Path $Source ".git"

if (Test-Path $SourceGit) {
    Remove-Item $SourceGit -Recurse -Force
}

Invoke-RobocopySafe `
    -From (Join-Path $Staging ".git") `
    -To $SourceGit `
    -ExtraArgs @("/MIR")

$SyncInfo = [ordered]@{
    protocol = "david-git-sync-v1"
    repository = $RepoFullName
    branch = $Branch
    commit = $Commit
    synced_at = (Get-Date).ToString("o")
    source_path = $Source
}

$SyncInfo |
ConvertTo-Json -Depth 4 |
Set-Content `
    -Path (Join-Path $Source ".david-sync.json") `
    -Encoding UTF8

Write-Step "Проверявам локалната Git връзка"

& git.exe -C $Source status --short
& git.exe -C $Source branch --show-current
& git.exe -C $Source rev-parse HEAD
& git.exe -C $Source remote -v

if ($LASTEXITCODE -ne 0) {
    throw "Локалната Git проверка се провали."
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor DarkGreen
Write-Host " GOTOVO DAVID - STEP 1" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor DarkGreen
Write-Host "Repository : $RepoFullName"
Write-Host "Branch     : $Branch"
Write-Host "Commit     : $Commit"
Write-Host "Backup     : $Backup"
Write-Host "Local path : $Source"
Write-Host ""
Write-Host "Не merge-ваме още в main. Първо преглеждаме и тестваме branch-а." -ForegroundColor Yellow
Write-Host ""

