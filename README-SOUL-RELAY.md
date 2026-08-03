# DAVID Electron inside Soul Free / Fast Brain

## Real flow

```text
Soul chat on phone or PC
  -> authenticated Supabase queue
  -> local DAVID Electron on Windows
  -> fixed private ChatGPT conversation
  -> completed answer in the same Soul conversation
```

The website is the interface. DAVID Electron is the hidden Fast Brain worker.
The previous deterministic JavaScript Fast Brain remains available only for accounts that are not explicitly bound to the Electron pilot.

## Pilot owner

- SoulFlame account: Dimitar Lambov
- Auth owner UUID: `de35fedf-f922-42b2-bf14-9320c11fb2a4`
- Active Twin: DAVID

## Required local `.env`

```dotenv
SUPABASE_URL=https://frhletkiuupgksmgxoxc.supabase.co
DAVID_DEVICE_BRIDGE_FUNCTION=david-soul-bridge
DAVID_DEVICE_TOKEN=<existing paired DAVID token>
DAVID_SOUL_USER_ID=de35fedf-f922-42b2-bf14-9320c11fb2a4
DAVID_SOUL_CHAT_URL=https://chatgpt.com/c/<private-chat-id>
DAVID_SOUL_BROWSER_VISIBLE=true
```

Never commit the device token.

## One-click Windows update and start

Double-click:

```text
UPDATE-AND-START-DAVID-SOUL.cmd
```

The launcher safely:

1. stops if tracked local files have uncommitted changes;
2. fetches `feature/david-soul-relay-v1`;
3. updates only with a fast-forward merge;
4. runs the DAVID test suite;
5. starts the existing Electron relay through `START-DAVID-E-DRIVE.ps1`.

PowerShell is used only by the local launcher. SOUL messages and GPT answers remain normal chat text and are never executed as PowerShell or local commands.

## End-to-end test

1. Double-click `UPDATE-AND-START-DAVID-SOUL.cmd`.
2. Confirm that the local `.env` still contains the paired device token and private GPT conversation URL.
3. Enter `twins - start server` if the listener is not already active.
4. Log into ChatGPT in the `DAVID SOUL` Electron window if requested.
5. Send a message from Soul Free / Fast Brain in Twins.
6. Verify the relay reaches:

```text
queued
-> processing
-> answer_ready
-> returning_to_soul
-> completed
```

7. Confirm the answer appears in the same Soul thread.
