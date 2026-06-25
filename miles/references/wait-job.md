# miles wait-job / miles cancel / --no-wait

The async job triad. Plumbing, HEADLESS. Long verbs stream and wait by default; this triad is for agents that prefer fire → poll → settle, or that need to stop a running turn.

## --no-wait

`site-create`, `say`, `build-site`, and `convert-theme` accept `--no-wait`: fire the turn and return a JSON handle immediately:

```json
{
  "ok": true,
  "status": "streaming",
  "siteId": "…",
  "conversationId": "…",
  "next": {
    "watch": "User present? Open the url from `miles connect-browser --json` in a browser surface NOW so they watch this run live.",
    "wait": "miles wait-job",
    "state": "miles site-state --json",
    "cancel": "miles cancel"
  }
}
```

Act on `watch` first when a user is present — it is the open-the-canvas moment (SKILL.md "Never Dead Air").

`--no-wait` requires a server that supports `cancel` (exit 2 otherwise). Never fire work you cannot stop — an uncancellable build burns the user's credits.

## miles wait-job

```bash
miles wait-job [--timeout <seconds>]    # default 600
```

Polls the running turn over REST. Progress lines go to **stderr**; the single settled JSON result goes to **stdout**; the exit code is mapped from the outcome ([outcomes.md](outcomes.md)).

```json
{
  "ok": true,
  "status": "completed",
  "outcome": "completed",
  "phase": "site_preview",
  "code": null,
  "errorId": null,
  "recovery": null,
  "milesMessage": "…",
  "question": null,
  "brief": null,
  "approvalRequired": null,
  "directions": [ { "number": 1, "directionId": "…", "previewUrl": "…" } ],
  "directionCount": 3,
  "directionTotal": 3,
  "selectedDirectionId": null,
  "siteReady": false,
  "dashboardUrl": "https://start.bymiles.ai/…",
  "sessionMemory": null,
  "credits": { "usagePercent": 42, "topUpCredits": 0 }
}
```

On failed, blocked, or approval-required results, read `code`, `errorId`, `recovery[]`, `sessionMemory[]`, `approvalRequired`, and `dashboardUrl` before choosing a next step. These fields are server-derived recovery guidance, not decoration.

On timeout it exits 1 with `status: "running"` — the turn is still going; run `wait-job` again to keep waiting or `cancel` to stop it. A `question` in the result means Miles needs ordinary input: relay it, then `say` the answer.

If the result contains `approvalRequired`, this is a live-protection gate, not an ordinary question. Stop and ask the user to approve or decline that specific protected change. Do not use `say`; after explicit user approval/refusal, use `miles approval-respond --grant <id> --response approved|declined` ([live-protection.md](live-protection.md)).

`miles wait` is the streaming-text sibling used by the guided flow (recovery after an interrupted long command). `wait-job` is the structured one to build automation on.

## miles cancel

```bash
miles cancel [--json]
```

Stops the running turn for the active conversation: the stream is aborted server-side, statuses settle, and the subsequent `wait-job` reports `outcome: "aborted"`. Use it when the user changes their mind mid-build, when a fired `--no-wait` turn is no longer wanted, or before abandoning a session with work in flight. Requires server `cancel` support (exit 2 otherwise). Cancelling consumes nothing further, but work already done is already billed.

## Exit codes

`wait-job`: outcome-mapped — `0` completed · `4` blocked/declined · `3` need_connection · `5` capacity · `1` failed/aborted/timeout. `cancel`: `0` accepted · `2` no conversation / unsupported server · `1` failed.
