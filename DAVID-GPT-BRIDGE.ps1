$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class DavidWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(
        uint dwFlags,
        uint dx,
        uint dy,
        uint dwData,
        UIntPtr dwExtraInfo
    );
}
"@

function Get-ChatGPTProcess {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.MainWindowHandle -ne 0 -and
            $_.MainWindowTitle -match "(?i)ChatGPT|OpenAI"
        } |
        Sort-Object {
            if ($_.MainWindowTitle -match "(?i)^ChatGPT") { 0 } else { 1 }
        } |
        Select-Object -First 1
}

function Send-ToChatGPT {
    param(
        [Parameter(Mandatory)]
        [string]$Text
    )

    $Text = $Text.Trim()

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return
    }

    $Process = Get-ChatGPTProcess

    if (-not $Process) {
        Write-Host ""
        Write-Host "DAVID: Не намирам отворен прозорец на ChatGPT." -ForegroundColor Red
        Write-Host "Отвори ChatGPT в Chrome, Edge или приложението." -ForegroundColor Yellow
        [Console]::Beep(350, 500)
        return
    }

    $Shell = New-Object -ComObject WScript.Shell

    if (-not $Shell.AppActivate($Process.Id)) {
        Write-Host "DAVID: Не мога да активирам ChatGPT." -ForegroundColor Red
        return
    }

    Start-Sleep -Milliseconds 600

    $Rect = New-Object DavidWin32+RECT
    $OldCursor = New-Object DavidWin32+POINT

    [DavidWin32]::GetCursorPos([ref]$OldCursor) | Out-Null

    if ([DavidWin32]::GetWindowRect(
        [IntPtr]$Process.MainWindowHandle,
        [ref]$Rect
    )) {
        $Width = $Rect.Right - $Rect.Left

        # Полето за писане на ChatGPT е долу, приблизително по средата.
        $ClickX = [int]($Rect.Left + ($Width * 0.58))
        $ClickY = [int]($Rect.Bottom - 115)

        [DavidWin32]::SetCursorPos($ClickX, $ClickY) | Out-Null
        Start-Sleep -Milliseconds 200

        [DavidWin32]::mouse_event(
            0x0002,
            0,
            0,
            0,
            [UIntPtr]::Zero
        )

        [DavidWin32]::mouse_event(
            0x0004,
            0,
            0,
            0,
            [UIntPtr]::Zero
        )

        Start-Sleep -Milliseconds 350
    }

    $OldClipboard = $null
    $CanRestoreClipboard = $false

    try {
        $OldClipboard = Get-Clipboard -Raw -ErrorAction Stop
        $CanRestoreClipboard = $true
    }
    catch {
    }

    Set-Clipboard -Value $Text

    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

    Start-Sleep -Milliseconds 300

    [DavidWin32]::SetCursorPos(
        $OldCursor.X,
        $OldCursor.Y
    ) | Out-Null

    if ($CanRestoreClipboard) {
        Start-Sleep -Milliseconds 600
        Set-Clipboard -Value $OldClipboard
    }

    Write-Host "DAVID -> GPT: $Text" -ForegroundColor Cyan
}

$Recognizers =
    [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()

if (-not $Recognizers -or $Recognizers.Count -eq 0) {
    throw "Windows няма инсталиран Speech Recognition език."
}

$RecognizerInfo =
    $Recognizers |
    Where-Object { $_.Culture.Name -eq "bg-BG" } |
    Select-Object -First 1

if (-not $RecognizerInfo) {
    $RecognizerInfo =
        $Recognizers |
        Where-Object { $_.Culture.Name -eq "en-US" } |
        Select-Object -First 1
}

if (-not $RecognizerInfo) {
    $RecognizerInfo = $Recognizers | Select-Object -First 1
}

$Recognizer =
    New-Object System.Speech.Recognition.SpeechRecognitionEngine(
        $RecognizerInfo
    )

$Recognizer.SetInputToDefaultAudioDevice()

$DictationGrammar =
    New-Object System.Speech.Recognition.DictationGrammar

$Recognizer.LoadGrammar($DictationGrammar)

Clear-Host

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "       DAVID -> CHATGPT VOICE BRIDGE" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Език: $($RecognizerInfo.Culture.Name)"
Write-Host ""
Write-Host "1. Отвори ChatGPT."
Write-Host "2. Кажи: GPT"
Write-Host "3. След сигнала кажи въпроса."
Write-Host ""
Write-Host "За спиране кажи: STOP DAVID"
Write-Host ""

[Console]::Beep(750, 180)
[Console]::Beep(950, 180)

while ($true) {
    try {
        $Result = $Recognizer.Recognize()
    }
    catch {
        Write-Host "Грешка от микрофона: $($_.Exception.Message)" -ForegroundColor Red
        Start-Sleep -Seconds 1
        continue
    }

    if (-not $Result) {
        continue
    }

    if ($Result.Confidence -lt 0.30) {
        continue
    }

    $Heard = $Result.Text.Trim()
    $Normalized =
        $Heard.ToLowerInvariant() -replace "[\s\.,;:_\-]+", ""

    Write-Host "Чух: $Heard" -ForegroundColor DarkGray

    if (
        $Normalized -match "^(stopdavid|exit|стопдейвид|изход)$"
    ) {
        Write-Host "DAVID GPT Bridge е спрян." -ForegroundColor Yellow
        break
    }

    $IsGPTCommand =
        $Normalized -match "^(gpt|chatgpt|джипити|чатджипити|гпт|чатгпт)$"

    if ($IsGPTCommand) {
        Write-Host ""
        Write-Host "GPT режим. Кажи въпроса..." -ForegroundColor Green

        [Console]::Beep(1000, 220)

        try {
            $QuestionResult = $Recognizer.Recognize()
        }
        catch {
            Write-Host "Не успях да чуя въпроса." -ForegroundColor Red
            continue
        }

        if (
            $QuestionResult -and
            $QuestionResult.Confidence -ge 0.25
        ) {
            Send-ToChatGPT -Text $QuestionResult.Text
        }
        else {
            Write-Host "DAVID: Не разбрах въпроса." -ForegroundColor Yellow
            [Console]::Beep(400, 350)
        }
    }
}

$Recognizer.Dispose()
