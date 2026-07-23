# miles site-state

One snapshot of where the active site is: the `git status` of Miles. Plumbing, HEADLESS. Run it after attaching, after an ambiguous settle, or whenever you are unsure what to do next.

```bash
miles site-state [--json]
```

```json
{
  "siteId": "…",
  "conversationId": "…",
  "phase": "design_directions_ready",
  "status": "idle",
  "conversationStatus": "waiting_for_user_input",
  "code": null,
  "errorId": null,
  "recovery": null,
  "siteReady": false,
  "selectedDirectionId": null,
  "directionCount": 4,
  "directionTotal": 4,
  "progress": null,
  "directions": [ { "number": 1, "directionId": "…", "name": "…", "previewUrl": "…" } ],
  "connection": { "kind": "browser-dashboard", "connected": false },
  "storageSlug": "kiln-site",
  "themeSlug": null,
  "siteCompletionPlan": {
    "items": [
      { "id": "classes-page", "title": "Classes page", "category": "subpage", "status": "pending" },
      { "id": "contact-form", "title": "Contact form", "category": "form", "status": "completed" }
    ]
  },
  "credits": { "usagePercent": 50, "topUpCredits": 25 },
  "approvalRequired": null,
  "undoAvailable": true,
  "undoTurnIndex": 12,
  "isSiteBuildingActive": false,
  "next": [
    "miles design-directions --json",
    "miles build-site --design <number>"
  ]
}
```

- `phase` walks: `discovery → brief_review → generating_design_directions → design_directions_ready → building → site_preview → converting → complete` (`validating` is a transient between build and complete; see [state-objects.md](state-objects.md)).
- `next[]` is **server-derived**: the API reports the legal moves for the real phase, with streaming/unsettled states taking precedence and `undo` included only when actually available. A hint list, not a script — your judgment about the user's goal decides which to take.
- `siteCompletionPlan` is the site's outstanding-work plan (subpages, forms, plugins, content the brief committed to). Item `status` is one of `pending | in_progress | completed | failed | dismissed`. **When the user asks "what's next for this site?", read this plan, present the pending and failed items, and let them pick** — then `say` the chosen work. `failureReason` on failed items tells you what went wrong.
- For the lossless plan contract—including curation state, durable result references, and revision history—use [`miles site-plan --json`](site-plan.md). `site-state` remains the phase/blocker snapshot.
- `undoAvailable: true` means `miles undo` can revert the last turn (see [undo.md](undo.md)).
- `credits.usagePercent` is the account's period usage — mention it to the user when it is high; never silently stop work over it.
- `status: "streaming"` means a turn is running: `wait-job` (or `cancel`) before sending anything new.
- `code`, `errorId`, `recovery[]`, and `progress` are server-derived troubleshooting fields. Read them before deciding whether to retry, reconnect, repair auth, or ask the user.
- `approvalRequired` means live protection is waiting for the user. The only legal next write is `approval-respond` after explicit approval/refusal for that specific change; do not use `say` ([live-protection.md](live-protection.md)).
- `connection.connected` tells you whether browser-backed work would succeed right now.
- If `sessionMemory[]`, `next[]`, or a recent outcome mentions repair, revoked auth, suspended access, terms, backup acknowledgement, or a destructive confirmation, resolve that blocker first. Do not keep sending normal chat turns over it.

Supporting verbs alongside it: `miles status` (smaller, single GET), `miles sites --json` (all sites), `miles site-pages` (built-site file listing), `miles history` (paginated transcript — see [history.md](history.md)).

## Full state (`--full`)

```bash
miles site-state --full --json
```

The complete derived-state dump, for when the summary isn't enough — typically when resuming a site you don't have context on. Adds, on top of what the summary carries:

- `strategicBrief` + `briefApproved` — the actual brief text Miles is designing against.
- `designDirections[]` — full per-direction detail (number, id, name, status, previewUrl, selectable), same shape as `design-directions --json`.
- `sessionMemory[]` — operational notes from past turns: blocked/failed work with `nextRecommendedAction`, what an earlier turn could not finish and why.
- Conversion outcome fields: `conversionStarted/Complete/Failed`, `conversionError`, `editorUrl`.
- `approvalRequired` — the same pending live-protection approval object from the summary, when present.

It is a pure read of stored conversation state — no credits or undo lookups (use the summary for those, and its `next[]` hints; `--full` carries none).

## Exit codes

`0` ok · `2` no active conversation / server lacks the requested read · `1` failed.
