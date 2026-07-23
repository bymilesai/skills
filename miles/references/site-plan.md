# miles site-plan

Read the active site's complete Site Plan. Plumbing, HEADLESS. This is the
plan-specific inspection surface; unlike the compact `site-state` summary it
preserves the complete current contract.

```bash
miles site-plan --json
miles site-plan --history --json
```

Current-plan shape:

```json
{
  "siteId": "…",
  "conversationId": "…",
  "phase": "complete",
  "summary": {
    "total": 3,
    "statuses": {
      "pending": 1,
      "in_progress": 0,
      "completed": 2,
      "failed": 0,
      "dismissed": 0
    },
    "curated": 3,
    "uncurated": 0
  },
  "siteCompletionPlan": {
    "id": "site-completion-plan",
    "createdAt": "2026-07-20T10:00:00.000Z",
    "updatedAt": "2026-07-20T10:05:00.000Z",
    "items": [
      {
        "id": "contact-form",
        "title": "Connect the contact form",
        "description": "The contact form will send real messages.",
        "category": "form",
        "status": "pending",
        "source": "generation",
        "curated": true,
        "resultRef": {
          "pageId": 42,
          "pageSlug": "home",
          "sectionMarker": "miles-sec-contact",
          "patternId": 99,
          "designArtifactKind": "wordpress-theme",
          "designArtifactVersion": 2,
          "designArtifactId": "artifact-contact",
          "designArtifactItemKey": "home:contact",
          "entityType": "wp_template",
          "entityId": "theme//home",
          "intent": "Connect the contact form",
          "evidence": "Static form controls are present"
        },
        "failureReason": null
      }
    ]
  }
}
```

Every normalized field is preserved:

- Plan: `id`, `createdAt`, `updatedAt`, `items[]`.
- Item: `id`, `title`, `description`, `category`, `status`, `source`,
  `curated`, `failureReason`, `resultRef`.
- Durable result reference: page, pattern, section, design-artifact, editor
  entity, intent, and evidence fields when Miles recorded them.

## Revision history

`--history` walks the complete sanitized conversation history, finds every
`data-site-completion-plan` snapshot, removes consecutive byte-identical
repeats, and adds:

```json
{
  "revisions": [
    {
      "revision": 2,
      "messageId": "…",
      "updatedAt": "2026-07-20T10:05:00.000Z",
      "summary": { "total": 3 },
      "changes": {
        "added": ["contact-form"],
        "removed": [],
        "changed": [
          {
            "id": "foundation",
            "changedFields": ["status", "resultRef"],
            "before": { "status": "pending" },
            "after": { "status": "completed" }
          }
        ]
      },
      "siteCompletionPlan": { "id": "site-completion-plan", "items": [] }
    }
  ]
}
```

Each revision carries the full snapshot. `changes` is a convenience diff, not
a replacement for that snapshot; `before` and `after` are the complete
previous and next item objects (only `changedFields` is trimmed), abbreviated
in the example above. This is the plan-snapshot history preserved
in the conversation, not an internal event log; an in-place update that left no
distinct stored snapshot cannot be reconstructed.

## Curation boundary

`curated: false` marks a generation row whose title, description, intent, and
evidence are machine-facing placeholders. JSON deliberately preserves those
fields so an agent can understand and repair the plan, but do not present them
to the user as authored Site Plan copy. The human command hides their raw text
and reports them as uncurated.

## Judgment

- Use `site-plan --json` for “what is left?” or to select a specific plan item
  for the next `say` request.
- Use `site-plan --history --json` when auditing whether an edit, conversion,
  make-real action, failure, or dismissal actually changed plan ownership.
- Treat `completed` and `dismissed` differently: dismissed means the promise
  was intentionally removed, not delivered.
- On a failed item, surface `failureReason` before proposing a retry.
- Do not infer completion from a `resultRef`; `status` is authoritative.

## Exit codes

`0` read completed, including when no plan exists · `2` no active conversation
or the connected server lacks the full state/history primitive · `1` failed.
