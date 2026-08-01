$ErrorActionPreference = "Continue"

Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class DavidNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(
        IntPtr hWnd,
        int nCmdShow
    );

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(
        IntPtr hWnd,
        out RECT rect
    );

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(
        int x,
        int y
    );

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

function Invoke-DavidClick {
    param(
        [Parameter(Mandatory)]
        [int]$X,

        [Parameter(Mandatory)]
        [int]$Y
    )

    [DavidNative]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 120

    [DavidNative]::mouse_event(
        0x0002,
        0,
        0,
        0,
        [UIntPtr]::Zero
    )

    [DavidNative]::mouse_event(
        0x0004,
        0,
        0,
        0,
        [UIntPtr]::Zero
    )
}

function Get-ChatGptWindow {
    $Processes =
        Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.MainWindowHandle -ne 0 -and
            $_.MainWindowTitle -match
                "(?i)ChatGPT|OpenAI|Попитайте ChatGPT"
        }

    return $Processes |
        Sort-Object {
            if ($_.MainWindowTitle -match "(?i)ChatGPT") {
                0
            }
            else {
                1
            }
        } |
        Select-Object -First 1
}

function Get-ElementInformation {
    param(
        [Parameter(Mandatory)]
        $Element
    )

    try {
        return [PSCustomObject]@{
            Element       = $Element
            Name          = [string]$Element.Current.Name
            HelpText      = [string]$Element.Current.HelpText
            ClassName     = [string]$Element.Current.ClassName
            ControlType   =
                [string]$Element.Current.ControlType.ProgrammaticName
            Enabled       = [bool]$Element.Current.IsEnabled
            Focusable     =
                [bool]$Element.Current.IsKeyboardFocusable
            Rectangle     = $Element.Current.BoundingRectangle
        }
    }
    catch {
        return $null
    }
}

function Find-ChatGptComposer {
    param(
        [Parameter(Mandatory)]
        $RootElement,

        [Parameter(Mandatory)]
        [int]$WindowTop,

        [Parameter(Mandatory)]
        [int]$WindowBottom
    )

    $Elements =
        $RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )

    $Candidates = @()

    foreach ($Element in $Elements) {
        $Info = Get-ElementInformation -Element $Element

        if (-not $Info) {
            continue
        }

        $Rect = $Info.Rectangle

        if (
            $Rect.Width -lt 150 -or
            $Rect.Height -lt 18 -or
            $Rect.Height -gt 350
        ) {
            continue
        }

        if ($Rect.Top -lt ($WindowTop + (($WindowBottom - $WindowTop) * 0.45))) {
            continue
        }

        $CombinedText =
            "$($Info.Name) $($Info.HelpText) $($Info.ClassName)"

        $LooksLikePrompt =
            $CombinedText -match
            "(?i)Попитайте ChatGPT|Ask ChatGPT|Message ChatGPT|" +
            "Send a message|prompt|composer|ProseMirror"

        $LooksEditable =
            $Info.ControlType -match
                "(?i)Edit|Document" -or
            $Info.Focusable

        if ($LooksLikePrompt -and $LooksEditable) {
            $Candidates += $Info
        }
    }

    if ($Candidates.Count -gt 0) {
        return $Candidates |
            Sort-Object {
                $_.Rectangle.Top
            } -Descending |
            Select-Object -First 1
    }

    # Резервно търсене: най-долното голямо editable поле.
    foreach ($Element in $Elements) {
        $Info = Get-ElementInformation -Element $Element

        if (-not $Info) {
            continue
        }

        $Rect = $Info.Rectangle

        if (
            $Info.ControlType -match "(?i)Edit|Document" -and
            $Info.Focusable -and
            $Rect.Width -gt 300 -and
            $Rect.Height -ge 20 -and
            $Rect.Top -gt
                ($WindowTop + (($WindowBottom - $WindowTop) * 0.55))
        ) {
            $Candidates += $Info
        }
    }

    return $Candidates |
        Sort-Object {
            $_.Rectangle.Top
        } -Descending |
        Select-Object -First 1
}

function Find-SendButton {
    param(
        [Parameter(Mandatory)]
        $RootElement,

        $Composer
    )

    $ButtonCondition =
        New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button
        )

    $Buttons =
        $RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $ButtonCondition
        )

    $Candidates = @()

    foreach ($Button in $Buttons) {
        $Info = Get-ElementInformation -Element $Button

        if (-not $Info -or -not $Info.Enabled) {
            continue
        }

        $Rect = $Info.Rectangle
        $CombinedText =
            "$($Info.Name) $($Info.HelpText) $($Info.ClassName)"

        if (
            $CombinedText -match
            "(?i)^send$|send message|submit|" +
            "изпрат|изпращане|изпращане на подкана|" +
            "стрелка"
        ) {
            if ($Composer) {
                $ComposerRect = $Composer.Rectangle

                $IsNearComposer =
                    $Rect.Top -ge ($ComposerRect.Top - 80) -and
                    $Rect.Top -le ($ComposerRect.Bottom + 80)

                if (-not $IsNearComposer) {
                    continue
                }
            }

            $Candidates += $Info
        }
    }

    if ($Candidates.Count -eq 0) {
        return $null
    }

    if ($Composer) {
        $TargetX =
            $Composer.Rectangle.Right + 25

        $TargetY =
            $Composer.Rectangle.Top +
            ($Composer.Rectangle.Height / 2)

        return $Candidates |
            Sort-Object {
                $CenterX =
                    $_.Rectangle.Left +
                    ($_.Rectangle.Width / 2)

                $CenterY =
                    $_.Rectangle.Top +
                    ($_.Rectangle.Height / 2)

                [Math]::Abs($CenterX - $TargetX) +
                [Math]::Abs($CenterY - $TargetY)
            } |
            Select-Object -First 1
    }

    return $Candidates | Select-Object -First 1
}

function Set-DavidClipboard {
    param(
        [Parameter(Mandatory)]
        [string]$Text
    )

    for ($Attempt = 1; $Attempt -le 8; $Attempt++) {
        try {
            [System.Windows.Forms.Clipboard]::Clear()
            [System.Windows.Forms.Clipboard]::SetText($Text)

            if (
                [System.Windows.Forms.Clipboard]::GetText() -eq
                $Text
            ) {
                return $true
            }
        }
        catch {
            Start-Sleep -Milliseconds 150
        }
    }

    return $false
}

function Send-DavidTextToChatGPT {
    param(
        [Parameter(Mandatory)]
        [string]$Text
    )

    $Text = $Text.Trim()

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }

    $Process = Get-ChatGptWindow

    if (-not $Process) {
        Write-Host ""
        Write-Host "DAVID: Не намирам отворен ChatGPT." `
            -ForegroundColor Red
        Write-Host "Отвори ChatGPT и остави прозореца видим." `
            -ForegroundColor Yellow

        [Console]::Beep(350, 500)
        return $false
    }

    $Handle = [IntPtr]$Process.MainWindowHandle

    [DavidNative]::ShowWindowAsync($Handle, 9) | Out-Null
    [DavidNative]::SetForegroundWindow($Handle) | Out-Null

    Start-Sleep -Milliseconds 700

    $WindowRect = New-Object DavidNative+RECT

    if (
        -not [DavidNative]::GetWindowRect(
            $Handle,
            [ref]$WindowRect
        )
    ) {
        Write-Host "Не мога да прочета размера на прозореца." `
            -ForegroundColor Red
        return $false
    }

    try {
        $RootElement =
            [System.Windows.Automation.AutomationElement]::FromHandle(
                $Handle
            )
    }
    catch {
        Write-Host "UI Automation не може да отвори ChatGPT." `
            -ForegroundColor Red
        return $false
    }

    $Composer =
        Find-ChatGptComposer `
            -RootElement $RootElement `
            -WindowTop $WindowRect.Top `
            -WindowBottom $WindowRect.Bottom

    if (-not $Composer) {
        Write-Host ""
        Write-Host "DAVID: Не намирам полето „Попитайте ChatGPT“." `
            -ForegroundColor Red
        Write-Host "ChatGPT трябва да е отворен и видим на екрана." `
            -ForegroundColor Yellow

        [Console]::Beep(350, 500)
        return $false
    }

    $ComposerRect = $Composer.Rectangle

    $InputX =
        [int](
            $ComposerRect.Left +
            [Math]::Min(
                $ComposerRect.Width * 0.35,
                300
            )
        )

    $InputY =
        [int](
            $ComposerRect.Top +
            ($ComposerRect.Height / 2)
        )

    Invoke-DavidClick -X $InputX -Y $InputY
    Start-Sleep -Milliseconds 250

    # Изчиства стар недовършен текст.
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
    Start-Sleep -Milliseconds 150

    if (-not (Set-DavidClipboard -Text $Text)) {
        Write-Host "DAVID: Clipboard-ът е зает." `
            -ForegroundColor Red
        return $false
    }

    # Поставя точно новия въпрос, не стария PowerShell код.
    [System.Windows.Forms.SendKeys]::SendWait("^v")

    Start-Sleep -Milliseconds 900

    # Търси активираната стрелка след поставянето на текста.
    $RootElement =
        [System.Windows.Automation.AutomationElement]::FromHandle(
            $Handle
        )

    $SendButton =
        Find-SendButton `
            -RootElement $RootElement `
            -Composer $Composer

    if ($SendButton) {
        $ButtonRect = $SendButton.Rectangle

        $ButtonX =
            [int](
                $ButtonRect.Left +
                ($ButtonRect.Width / 2)
            )

        $ButtonY =
            [int](
                $ButtonRect.Top +
                ($ButtonRect.Height / 2)
            )

        Invoke-DavidClick -X $ButtonX -Y $ButtonY

        Write-Host ""
        Write-Host "DAVID → GPT: $Text" `
            -ForegroundColor Cyan

        [Console]::Beep(950, 120)
        return $true
    }

    # Резервен клик непосредствено вдясно от полето.
    $FallbackX =
        [int](
            [Math]::Min(
                $WindowRect.Right - 20,
                $ComposerRect.Right + 34
            )
        )

    $FallbackY =
        [int](
            $ComposerRect.Top +
            ($ComposerRect.Height / 2)
        )

    Invoke-DavidClick `
        -X $FallbackX `
        -Y $FallbackY

    Start-Sleep -Milliseconds 500

    Write-Host ""
    Write-Host "DAVID → GPT: $Text" `
        -ForegroundColor Cyan
    Write-Host "Стрелката беше натисната чрез резервната позиция." `
        -ForegroundColor DarkGray

    [Console]::Beep(950, 120)
    return $true
}

function ConvertTo-DavidNormalizedText {
    param(
        [string]$Text
    )

    return (
        $Text.ToLowerInvariant() `
            -replace "[\.\,\;\:\!\?\-_]+", " " `
            -replace "\s+", " "
    ).Trim()
}

# ============================================================
# SPEECH RECOGNITION
# ============================================================

$Recognizers =
    [System.Speech.Recognition.SpeechRecognitionEngine]::
        InstalledRecognizers()

if (-not $Recognizers -or $Recognizers.Count -eq 0) {
    throw "Windows няма инсталиран Speech Recognition език."
}

$RecognizerInfo =
    $Recognizers |
    Where-Object {
        $_.Culture.Name -eq "bg-BG"
    } |
    Select-Object -First 1

if (-not $RecognizerInfo) {
    $RecognizerInfo =
        $Recognizers |
        Where-Object {
            $_.Culture.Name -eq "en-US"
        } |
        Select-Object -First 1
}

if (-not $RecognizerInfo) {
    $RecognizerInfo =
        $Recognizers |
        Select-Object -First 1
}

$Recognizer =
    New-Object `
        System.Speech.Recognition.SpeechRecognitionEngine(
            $RecognizerInfo
        )

$Recognizer.SetInputToDefaultAudioDevice()

$Dictation =
    New-Object `
        System.Speech.Recognition.DictationGrammar

$Recognizer.LoadGrammar($Dictation)

$Host.UI.RawUI.WindowTitle =
    "DAVID GPT SCREEN BRIDGE"

Clear-Host

Write-Host "============================================" `
    -ForegroundColor Cyan
Write-Host "       DAVID → GPT SCREEN BRIDGE" `
    -ForegroundColor Cyan
Write-Host "============================================" `
    -ForegroundColor Cyan
Write-Host ""
Write-Host "Speech language: $($RecognizerInfo.Culture.Name)"
Write-Host ""
Write-Host "Режим 1:"
Write-Host "  Кажи „GPT“"
Write-Host "  След сигнала кажи въпроса."
Write-Host ""
Write-Host "Режим 2:"
Write-Host "  Кажи наведнъж:"
Write-Host "  „GPT как да оправя DAVID?“"
Write-Host ""
Write-Host "За спиране: „STOP DAVID“"
Write-Host ""

[Console]::Beep(750, 150)
[Console]::Beep(950, 150)

while ($true) {
    try {
        $Result = $Recognizer.Recognize()
    }
    catch {
        Write-Host "Грешка от микрофона: $($_.Exception.Message)" `
            -ForegroundColor Red
        Start-Sleep -Seconds 1
        continue
    }

    if (-not $Result) {
        continue
    }

    if ($Result.Confidence -lt 0.18) {
        continue
    }

    $Heard = $Result.Text.Trim()
    $Normalized =
        ConvertTo-DavidNormalizedText -Text $Heard
    $Compact =
        $Normalized -replace "\s+", ""

    Write-Host "Чух: $Heard" `
        -ForegroundColor DarkGray

    if (
        $Compact -match
        "^(stopdavid|exit|стопдейвид|изход)$"
    ) {
        break
    }

    # GPT + въпрос в една команда.
    $InlineMatch =
        [regex]::Match(
            $Normalized,
            "^(?:gpt|chatgpt|джипити|чатджипити|гпт|чатгпт)\s+(.+)$",
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )

    if ($InlineMatch.Success) {
        $Question = $InlineMatch.Groups[1].Value.Trim()

        Send-DavidTextToChatGPT `
            -Text $Question |
            Out-Null

        continue
    }

    # Само GPT — следващото изречение е въпросът.
    $IsHotword =
        $Compact -match
        "^(gpt|chatgpt|джипити|чатджипити|гпт|чатгпт)$"

    if ($IsHotword) {
        Write-Host ""
        Write-Host "GPT режим. Кажи въпроса веднъж..." `
            -ForegroundColor Green

        [Console]::Beep(1050, 220)

        try {
            $QuestionResult =
                $Recognizer.Recognize(
                    [TimeSpan]::FromSeconds(15)
                )
        }
        catch {
            $QuestionResult = $null
        }

        if (
            $QuestionResult -and
            $QuestionResult.Confidence -ge 0.15
        ) {
            $Question =
                $QuestionResult.Text.Trim()

            Send-DavidTextToChatGPT `
                -Text $Question |
                Out-Null
        }
        else {
            Write-Host "DAVID: Не разбрах въпроса." `
                -ForegroundColor Yellow

            [Console]::Beep(400, 350)
        }
    }
}

$Recognizer.Dispose()

Write-Host "DAVID GPT Screen Bridge е спрян." `
    -ForegroundColor Yellow
