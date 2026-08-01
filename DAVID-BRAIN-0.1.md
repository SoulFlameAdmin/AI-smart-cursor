# DAVID Brain 0.1

Status: STARTED

DAVID Brain 0.1 is the first control layer above DAVID Smart Cursor.

## Core responsibilities

1. Detect the `-david` upgrade marker.
2. Separate normal commands from upgrade requests.
3. Build a structured upgrade request for the Teacher.
4. Accept only structured upgrade responses.
5. Require tests, backup and rollback before local installation.
6. Return a machine-readable completion report ending with `GOTOVO DAVID` only after verification.

## Safety boundary

Brain 0.1 never executes arbitrary downloaded scripts merely because they are visible in the browser. Upgrades must identify the trusted repository, target branch or commit, expected files, test command and rollback plan.

## Upgrade cycle

```text
-david request
  -> intent router
  -> teacher request
  -> GitHub branch/commit
  -> local updater
  -> backup
  -> tests
  -> restart
  -> health check
  -> GOTOVO DAVID or rollback report
```

## Version

`0.1.0-start`
