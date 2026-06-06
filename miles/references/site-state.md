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
  "next": [
    "miles design-directions --json",
    "miles build-site --design <number>"
  ]
}
```

- `phase` walks: `discovery → brief_review → generating_design_directions → design_directions_ready → building → site_preview/site_generation → converting → complete` (see [state-objects.md](state-objects.md)).
- `next[]` is a hint list of legal moves derived from the phase — a starting point, not a script. Your judgment about the user's goal decides which to take.
- `status: "streaming"` means a turn is running: `wait-job` (or `cancel`) before sending anything new.
- `connection.connected` tells you whether browser-backed work would succeed right now.

Supporting verbs alongside it: `miles status` (smaller, single GET), `miles sites --json` (all sites), `miles messages` (conversation history — rarely needed since long verbs already print responses).

## Exit codes

`0` ok · `2` no active conversation · `1` failed.
