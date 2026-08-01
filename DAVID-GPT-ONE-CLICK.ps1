$ErrorActionPreference = "Continue"

Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class DavidMouse
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
    public static extern bool SetForegroundWindow(
        IntPtr hWnd
    );

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
        uint flags,
        uint dx,
        uint dy,
        uint data,
        UIntPtr extraInfo
    );
}
"@

$DavidMessage = "az sum david cursor, upgredmi me"

function Invoke-DavidClick {
    param(
        [int]$X,
        [int]$Y
    )

    [DavidMouse]::SetCursorPos(
        $X,
        $Y
    ) | Out-Null

    Start-Sleep -Milliseconds 150

    [DavidMouse]::mouse_event(
        0x0002,
        0,
        0,
        0,
        [UIntPtr]::Zero
    )

    [DavidMouse]::mouse_event(
        0x0004,
        0,
        0,
        0,
        [UIntPtr]::Zero
    )
}

function Invoke-DavidDoubleClick {
    param(
        [int]$X,
        [int]$Y
    )

    Invoke-DavidClick -X $X -Y $Y
    Start-Sleep -Milliseconds 120
    Invoke-DavidClick -X $X -Y $Y
}

function Get-ChatGptWindow {
    return Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.MainWindowHandle -ne 0 -and
            $_.MainWindowTitle -match
                "(?i)ChatGPT|OpenAI"
        } |
        Sort-Object {
            if (
                $_.MainWindowTitle -match
                "(?i)^ChatGPT"
            ) {
                0
            }
            else {
                1
            }
        } |
        Select-Object -First 1
}

function Get-DavidElementInfo {
    param($Element)

    try {
        return [PSCustomObject]@{
            Element = $Element
            Name = [string]$Element.Current.Name
            HelpText = [string]$Element.Current.HelpText
            AutomationId =
                [string]$Element.Current.AutomationId
            ClassName =
                [string]$Element.Current.ClassName
            ControlType =
                [string]$Element.Current.ControlType.ProgrammaticName
            Focusable =
                [bool]$Element.Current.IsKeyboardFocusable
            Enabled =
                [bool]$Element.Current.IsEnabled
            Rectangle =
                $Element.Current.BoundingRectangle
        }
    }
    catch {
        return $null
    }
}

function Find-ChatGptInput {
    param(
        $RootElement,
        [int]$WindowTop,
        [int]$WindowBottom
    )

    $AllElements =
        $RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )

    $Candidates = @()

    for (
        $Index = 0;
        $Index -lt $AllElements.Count;
        $Index++
    ) {
        $Info =
            Get-DavidElementInfo `
                -Element $AllElements.Item($Index)

        if (-not $Info) {
            continue
        }

        $Rect = $Info.Rectangle

        if (
            $Rect.Width -lt 180 -or
            $Rect.Height -lt 18 -or
            $Rect.Height -gt 400
        ) {
            continue
        }

        $Combined =
            "$($Info.Name) " +
            "$($Info.HelpText) " +
            "$($Info.AutomationId) " +
            "$($Info.ClassName)"

        $Score = 0

        if (
            $Combined -match
            "(?i)Попитайте ChatGPT"
        ) {
            $Score += 300
        }

        if (
            $Combined -match
            "(?i)Ask ChatGPT|Message ChatGPT"
        ) {
            $Score += 250
        }

        if (
            $Combined -match
            "(?i)prompt-textarea|composer|ProseMirror|prompt"
        ) {
            $Score += 150
        }

        if (
            $Info.ControlType -match
            "(?i)Edit|Document"
        ) {
            $Score += 80
        }

        if ($Info.Focusable) {
            $Score += 30
        }

        $Middle =
            $WindowTop +
            (($WindowBottom - $WindowTop) * 0.50)

        if ($Rect.Top -gt $Middle) {
            $Score += 50
        }

        if ($Score -ge 80) {
            $Candidates += [PSCustomObject]@{
                Info = $Info
                Score = $Score
            }
        }
    }

    return $Candidates |
        Sort-Object `
            Score,
            @{Expression={$_.Info.Rectangle.Top}} `
            -Descending |
        Select-Object -First 1
}

function Find-ChatGptSendButton {
    param(
        $RootElement,
        $InputRectangle
    )

    $AllElements =
        $RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )

    $Candidates = @()

    for (
        $Index = 0;
        $Index -lt $AllElements.Count;
        $Index++
    ) {
        $Info =
            Get-DavidElementInfo `
                -Element $AllElements.Item($Index)

        if (
            -not $Info -or
            -not $Info.Enabled
        ) {
            continue
        }

        $Combined =
            "$($Info.Name) " +
            "$($Info.HelpText) " +
            "$($Info.AutomationId) " +
            "$($Info.ClassName)"

        if (
            $Combined -notmatch
            "(?i)send|submit|изпрат|стрелка"
        ) {
            continue
        }

        $Rect = $Info.Rectangle

        if (
            $Rect.Width -lt 15 -or
            $Rect.Width -gt 150 -or
            $Rect.Height -lt 15 -or
            $Rect.Height -gt 150
        ) {
            continue
        }

        $Distance = 0

        if ($InputRectangle) {
            $ButtonCenterX =
                $Rect.Left +
                ($Rect.Width / 2)

            $ButtonCenterY =
                $Rect.Top +
                ($Rect.Height / 2)

            $TargetX =
                $InputRectangle.Right - 35

            $TargetY =
                $InputRectangle.Bottom - 35

            $Distance =
                [Math]::Abs(
                    $ButtonCenterX - $TargetX
                ) +
                [Math]::Abs(
                    $ButtonCenterY - $TargetY
                )
        }

        $Candidates += [PSCustomObject]@{
            Info = $Info
            Distance = $Distance
        }
    }

    return $Candidates |
        Sort-Object Distance |
        Select-Object -First 1
}

function Set-DavidClipboardText {
    param([string]$Text)

    for (
        $Attempt = 1;
        $Attempt -le 10;
        $Attempt++
    ) {
        try {
            [System.Windows.Forms.Clipboard]::Clear()

            [System.Windows.Forms.Clipboard]::SetText(
                $Text
            )

            return $true
        }
        catch {
            Start-Sleep -Milliseconds 150
        }
    }

    return $false
}

function Invoke-DavidGptAction {
    $Process = Get-ChatGptWindow

    if (-not $Process) {
        Write-Host "Не намирам отворен ChatGPT." `
            -ForegroundColor Red

        [Console]::Beep(350, 500)
        return
    }

    $Handle =
        [IntPtr]$Process.MainWindowHandle

    [DavidMouse]::ShowWindowAsync(
        $Handle,
        9
    ) | Out-Null

    [DavidMouse]::SetForegroundWindow(
        $Handle
    ) | Out-Null

    Start-Sleep -Milliseconds 700

    $WindowRectangle =
        New-Object DavidMouse+RECT

    if (
        -not [DavidMouse]::GetWindowRect(
            $Handle,
            [ref]$WindowRectangle
        )
    ) {
        return
    }

    $WindowWidth =
        $WindowRectangle.Right -
        $WindowRectangle.Left

    $WindowHeight =
        $WindowRectangle.Bottom -
        $WindowRectangle.Top

    $RootElement = $null

    try {
        $RootElement =
            [System.Windows.Automation.AutomationElement]::
                FromHandle($Handle)
    }
    catch {}

    $InputCandidate = $null

    if ($RootElement) {
        $InputCandidate =
            Find-ChatGptInput `
                -RootElement $RootElement `
                -WindowTop $WindowRectangle.Top `
                -WindowBottom $WindowRectangle.Bottom
    }

    if ($InputCandidate) {
        $InputInfo =
            $InputCandidate.Info

        $InputRectangle =
            $InputInfo.Rectangle

        $InputX =
            [int](
                $InputRectangle.Left +
                [Math]::Min(
                    180,
                    $InputRectangle.Width * 0.30
                )
            )

        $InputY =
            [int](
                $InputRectangle.Top +
                ($InputRectangle.Height / 2)
            )

        Write-Host "Намерих „Попитайте ChatGPT“." `
            -ForegroundColor Green

        try {
            $InputInfo.Element.SetFocus()
        }
        catch {}

        # Точно два клика в полето.
        Invoke-DavidDoubleClick `
            -X $InputX `
            -Y $InputY
    }
    else {
        Write-Host `
            "Полето не е изложено към UI Automation. Използвам screen позицията." `
            -ForegroundColor Yellow

        # Резервна позиция: долната централна част на ChatGPT.
        $InputX =
            [int](
                $WindowRectangle.Left +
                ($WindowWidth * 0.50)
            )

        $InputY =
            [int](
                $WindowRectangle.Bottom - 80
            )

        $InputRectangle =
            [PSCustomObject]@{
                Left =
                    $WindowRectangle.Left +
                    ($WindowWidth * 0.20)
                Right =
                    $WindowRectangle.Left +
                    ($WindowWidth * 0.76)
                Top =
                    $WindowRectangle.Bottom - 145
                Bottom =
                    $WindowRectangle.Bottom - 25
            }

        Invoke-DavidDoubleClick `
            -X $InputX `
            -Y $InputY
    }

    Start-Sleep -Milliseconds 250

    # Изчиства евентуален стар текст.
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 100

    [System.Windows.Forms.SendKeys]::SendWait(
        "{BACKSPACE}"
    )

    Start-Sleep -Milliseconds 150

    if (
        -not (
            Set-DavidClipboardText `
                -Text $DavidMessage
        )
    ) {
        Write-Host "Clipboard грешка." `
            -ForegroundColor Red
        return
    }

    [System.Windows.Forms.SendKeys]::SendWait("^v")

    Write-Host "Поставих: $DavidMessage" `
        -ForegroundColor Cyan

    Start-Sleep -Milliseconds 900

    $SendCandidate = $null

    if ($RootElement) {
        try {
            $RootElement =
                [System.Windows.Automation.AutomationElement]::
                    FromHandle($Handle)

            $SendCandidate =
                Find-ChatGptSendButton `
                    -RootElement $RootElement `
                    -InputRectangle $InputRectangle
        }
        catch {}
    }

    if ($SendCandidate) {
        $ButtonRectangle =
            $SendCandidate.Info.Rectangle

        $SendX =
            [int](
                $ButtonRectangle.Left +
                ($ButtonRectangle.Width / 2)
            )

        $SendY =
            [int](
                $ButtonRectangle.Top +
                ($ButtonRectangle.Height / 2)
            )

        Write-Host "Намерих стрелката." `
            -ForegroundColor Green

        # Точно един клик на стрелката.
        Invoke-DavidClick `
            -X $SendX `
            -Y $SendY
    }
    else {
        # Резервно: долният десен ъгъл на намереното поле.
        $SendX =
            [int](
                $InputRectangle.Right - 30
            )

        $SendY =
            [int](
                $InputRectangle.Bottom - 30
            )

        Write-Host `
            "Стрелката не е изложена към UI Automation. Кликвам screen позицията." `
            -ForegroundColor Yellow

        # Точно един клик.
        Invoke-DavidClick `
            -X $SendX `
            -Y $SendY
    }

    [Console]::Beep(1050, 150)

    Write-Host "DAVID изпрати съобщението." `
        -ForegroundColor Green
}

# ============================================================
# VOICE HOTWORD: GPT
# ============================================================

$InstalledRecognizers =
    [System.Speech.Recognition.SpeechRecognitionEngine]::
        InstalledRecognizers()

if (
    -not $InstalledRecognizers -or
    $InstalledRecognizers.Count -eq 0
) {
    throw "Няма Windows Speech Recognition език."
}

$RecognizerInfo =
    $InstalledRecognizers |
    Where-Object {
        $_.Culture.Name -eq "bg-BG"
    } |
    Select-Object -First 1

if (-not $RecognizerInfo) {
    $RecognizerInfo =
        $InstalledRecognizers |
        Select-Object -First 1
}

$Recognizer =
    New-Object `
        System.Speech.Recognition.SpeechRecognitionEngine(
            $RecognizerInfo
        )

$Recognizer.SetInputToDefaultAudioDevice()

$Choices =
    New-Object System.Speech.Recognition.Choices

$Choices.Add(
    @(
        "GPT",
        "Chat GPT",
        "джи пи ти",
        "джипити",
        "чат джипити",
        "гпт"
    )
)

$GrammarBuilder =
    New-Object System.Speech.Recognition.GrammarBuilder

$GrammarBuilder.Culture =
    $RecognizerInfo.Culture

$GrammarBuilder.Append($Choices)

$Grammar =
    New-Object System.Speech.Recognition.Grammar(
        $GrammarBuilder
    )

$Recognizer.LoadGrammar($Grammar)

$Host.UI.RawUI.WindowTitle =
    "DAVID GPT ONE CLICK"

Clear-Host

Write-Host "========================================" `
    -ForegroundColor Cyan
Write-Host "       DAVID GPT ONE CLICK" `
    -ForegroundColor Cyan
Write-Host "========================================" `
    -ForegroundColor Cyan
Write-Host ""
Write-Host "Кажи: GPT"
Write-Host ""
Write-Host "DAVID ще:"
Write-Host "1. Намери ChatGPT"
Write-Host "2. Кликне два пъти в полето"
Write-Host "3. Постави: $DavidMessage"
Write-Host "4. Кликне стрелката веднъж"
Write-Host ""

[Console]::Beep(750, 150)
[Console]::Beep(950, 150)

while ($true) {
    try {
        $Result = $Recognizer.Recognize()
    }
    catch {
        Start-Sleep -Milliseconds 500
        continue
    }

    if (-not $Result) {
        continue
    }

    Write-Host "Чух: $($Result.Text)" `
        -ForegroundColor DarkGray

    Invoke-DavidGptAction

    # Не позволява двойно изпълнение от едно изговаряне.
    Start-Sleep -Seconds 3
}
