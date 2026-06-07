# miles undo

Revert the last agent turn. Porcelain, HEADLESS. Restores the WordPress site to the snapshot captured before the turn AND truncates the chat history to that boundary — site and conversation move back together, so the next `say` continues from the pre-turn state.

```bash
miles undo [--json]
```

```json
{
  "ok": true,
  "kind": "reverted",
  "snapshotVersion": 7,
  "truncatedMessages": 3,
  "browserRefreshRequired": true
}
```

## Judgment

- **One level, most recent turn only.** Each new turn replaces the checkpoint, and a successful undo consumes it — there is no redo and no multi-step history. For deeper branching, `miles site-attach <siteId> --duplicate` forks the site instead.
- **Check before offering it.** `miles site-state --json` reports `undoAvailable`; when true, `undo` also appears in `next[]`. Don't offer undo you can't deliver.
- **Use it when the user dislikes a result**, not as a retry mechanism — if a turn failed outright, the site usually didn't change; just `say` the correction.
- **Tell the user about open tabs.** The restore is committed server-side, but an already-open dashboard tab shows stale state until reloaded. When `browserRefreshRequired` is true and the user may have the dashboard open, tell them to reload it.

## Exit codes

`0` reverted · `2` nothing to undo (no checkpoint, or it expired) · `1` failed.

A `2` is normal early in a conversation: checkpoints only exist once the site has a live snapshot (after the first browser session captures one), so fresh headless-only sites may have no undo point yet.
