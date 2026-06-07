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
  "siteReady": false,
  "selectedDirectionId": null,
  "directionCount": 4,
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
  "undoAvailable": true,
  "next": [
    "miles design-directions --json",
    "miles build-site --design <number>"
  ]
}
```

- `phase` walks: `discovery → brief_review → generating_design_directions → design_directions_ready → building → site_preview → converting → complete` (`validating` is a transient between build and complete; see [state-objects.md](state-objects.md)).
- `next[]` is **server-derived**: the API reports the legal moves for the real phase, with streaming/unsettled states taking precedence and `undo` included only when actually available. A hint list, not a script — your judgment about the user's goal decides which to take.
- `siteCompletionPlan` is the site's outstanding-work plan (subpages, forms, plugins, content the brief committed to). Item `status` is one of `pending | in_progress | completed | failed | dismissed`. **When the user asks "what's next for this site?", read this plan, present the pending and failed items, and let them pick** — then `say` the chosen work. `failureReason` on failed items tells you what went wrong.
- `undoAvailable: true` means `miles undo` can revert the last turn (see [undo.md](undo.md)).
- `credits.usagePercent` is the account's period usage — mention it to the user when it is high; never silently stop work over it.
- `status: "streaming"` means a turn is running: `wait-job` (or `cancel`) before sending anything new.
- `connection.connected` tells you whether browser-backed work would succeed right now.

Supporting verbs alongside it: `miles status` (smaller, single GET), `miles sites --json` (all sites), `miles site-pages` (built-site file listing), `miles messages` (conversation history — rarely needed since long verbs already print responses).

## Exit codes

`0` ok · `2` no active conversation · `1` failed.
