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

## First Windows test

1. Pull branch `feature/david-soul-relay-v1`.
2. Copy the values above into the local `.env` while preserving the existing paired token.
3. Start DAVID Electron.
4. Enter `twins` once to start the relay.
5. Log into ChatGPT in the `DAVID SOUL` Electron window if requested.
6. Send a message from Soul Free / Fast Brain in Twins.
7. Verify the queue changes from `queued` to `processing` to `completed` and the answer appears in the same Soul thread.

The response is treated only as chat text. It is never executed as PowerShell or as a local system command.
