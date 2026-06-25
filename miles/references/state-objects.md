# State Objects

The handles and state machine every primitive shares.

## Handles

| Handle | Where it comes from | What takes it |
|---|---|---|
| `siteId` | `site-create`, `sites --json`, `site-attach` | `site-attach`, `use` |
| `conversationId` | site handle (one active conversation per site) | carried implicitly by the active site |
| `directionId` / `number` | `design-directions --json` | `build-site --design <number>` |
| `approvalRequired.grantId` | `wait-job`, `status --json`, `site-state --json` | `approval-respond --grant <id> --response approved|declined` |
| `slug` (storage) | `export --type html` | preview/screenshot paths |
| `themeSlug` | `export --type theme` | theme download |

Local credentials (`$MILES_HOME/credentials.json`) hold the account API key plus per-site tokens; `activeSite` selects which site conversation verbs operate on. Site tokens expire after ~24h — `site-attach` mints fresh ones.

## The phase machine

State is **derived from the conversation messages** server-side and is monotonic — you can read it at any time (`site-state`) and enter at any job. Phases:

```text
discovery → brief_review → generating_design_directions →
design_directions_ready → building → site_preview / site_generation →
converting → complete
```

- `discovery`: Miles interviews. `say` answers. (`site-create --brief` skips to direction generation.)
- `brief_review`: the brief awaits approval. Show it in full; `say` approval or changes.
- `generating_design_directions` / `building` / `converting`: a turn is running — `wait-job`, `cancel`, or watch via the dashboard.
- `design_directions_ready`: `design-directions --json`, present, then `build-site`.
- `site_preview` / `site_generation`: built HTML site exists. `say` edits, `screenshot`, `export --type html`, `convert-theme`.
- `complete`: WordPress theme exists. `export --type theme`; further `say` edits are browser-backed.

Two streaming-level fields ride alongside the phase: `status` (`idle | streaming | completed | failed | aborted | waiting_for_input`) and `conversationStatus` (`waiting_for_user_input` when Miles asked something). `status: streaming` means exactly one turn is in flight — sending another message exits 5.

`approvalRequired` can appear alongside any phase when live protection is waiting. It pauses protected work until the user explicitly approves or declines the specific grant. Use `approval-respond`, not `say` ([live-protection.md](live-protection.md)).

## Things with no undo

Conversation state is append-only: brief approval, design selection, and conversion do not unwind. The branch pattern is `site-attach <siteId> --duplicate` BEFORE the risky step.
