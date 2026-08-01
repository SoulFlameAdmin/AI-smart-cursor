"use strict";

const { spawn } = require("child_process");

function runPowerShell(script, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ],
      {
        windowsHide: true,
        env: { ...process.env, ...environment }
      }
    );

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `PowerShell приключи с код ${code}`));
    });
  });
}

async function clickAt(x, y) {
  if (process.platform !== "win32") {
    throw new Error("system_click в DAVID v1 е само за Windows.");
  }

  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DavidMouse {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
[DavidMouse]::SetCursorPos([int]$env:DAVID_X, [int]$env:DAVID_Y) | Out-Null
Start-Sleep -Milliseconds 80
[DavidMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[DavidMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`;

  await runPowerShell(script, {
    DAVID_X: String(Math.round(x)),
    DAVID_Y: String(Math.round(y))
  });
}

async function typeText(text) {
  if (process.platform !== "win32") {
    throw new Error("system_type в DAVID v1 е само за Windows.");
  }

  const encoded = Buffer.from(String(text), "utf8").toString("base64");

  const script = `
Add-Type -AssemblyName System.Windows.Forms
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DAVID_TEXT_B64))
$old = $null
try { $old = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
Set-Clipboard -Value $text
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 150
if ($null -ne $old) { Set-Clipboard -Value $old }
`;

  await runPowerShell(script, { DAVID_TEXT_B64: encoded });
}

module.exports = { clickAt, typeText };
