# DAVID_COMAND_CENTER — integration with DAVID Smart Cursor

**Status: staged integration branch; not yet installed on the running Windows machine.**

This is a **connection layer**, not a copy of the 146-file live Enchev runtime and not a second autonomy worker. It reads sanitized status snapshots, probes loopback-only CDP ports 9444 (Matrix) and 9555 (Scientist), and exposes a separate ASK queue that cannot control Enchev sessions.

## Direct Cursor integration

- In the Cursor command panel (`Ctrl+Shift+D`), enter `:center` to request an **observed status snapshot**.
- The Electron preload exposes `window.david.commandCenterStatus()` for read-only status from an application UI.
- The status data is not proof that a worker is actually generating, nor that tasks finished. Missing/stale status is shown explicitly.
- `src/ask-queue.cjs` only handles independent ASK jobs; it needs an explicitly configured, approved Gemini responder. Until configured, it returns `blocked` rather than pretending to provide answers.
- No SendKeys, browser tabs, automatic workers, git updates, scripts or restarts are triggered by this integration.

## Folder contents

- `src/status.cjs`: whitelist-only passive local state reader and loopback CDP reachability probes.
- `src/ask-queue.cjs`: independent ASK job queue and opt-in responder interface.
- `src/index.cjs`: module entrypoint.
- `bin/status.cjs`: command-line status inspection.
- `tests/smoke.cjs`: synthetic state, redaction and mocked ASK test.

## Provenance and safety

- Export reviewed: 2026-11-01 13:50:53 UTC; 146 files.
- Enchev local git branch: `test/david-autonomy-system-dpp-apk-20260919`, local HEAD `82e8377`, with 3 modified tracked worker files.
- Actual Mode Center is `D:\ASI\enchev-auctions\DAVID_MODE_SELECTOR_V2.ps1` (v2.1); its runtime remains in Enchev and is **not** moved or started by Cursor.
- Local Cursor v1.1.1 is under `D:\ASI\DAVID\AI-smart-cursor-main`; the older local Cursor 0.1.0 is a separate reference.
- Five Cursor tests were withheld by the exporter for potential secrets. This integration neither imports those files nor republishes the raw ZIP, runtime state or private chat URLs.
- `DAVID_MATRIX_START.ps1 -SkipUpdate` can still run stop logic; **do not** use that launcher for read-only inspection.
- For recovery, follow DAVID supervisor's active-work protection. Do not bypass it with Stop-Process/taskkill.

## Read-only local check (after syncing this integration branch, not on the running Cursor yet)

```powershell
$env:DAVID_ENCHEV_ROOT='D:\ASI\enchev-auctions'
node .\DAVID_COMAND_CENTER\bin\status.cjs
node .\DAVID_COMAND_CENTER\tests\smoke.cjs
```

## Next stage

Before merging or deploying: reconcile this feature branch with the actual local Cursor v1.1.1 source, test Electron UI and Gemini ASK in a dedicated session, verify Enchev worker continuity during interactive questions, and obtain explicit approval for production updates. No live mouse control or asynchronous Gemini answering has been verified by this stage.
