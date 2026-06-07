# miles usage-history

Account-scoped credit transaction history. Plumbing, HEADLESS. Requires the account API key (from `miles auth login`) — site tokens cannot read account billing.

```bash
miles usage-history [--limit <n>] [--offset <n>] [--type purchase|usage|bonus|adjustment] [--json]
```

```json
{
  "transactions": [
    {
      "id": "…",
      "type": "usage",
      "amountCredits": 2.5,
      "isDeduction": true,
      "balanceAfterCredits": 47.5,
      "description": "Site build",
      "createdAt": "2026-06-07T00:00:00.000Z"
    }
  ],
  "pagination": { "limit": 50, "offset": 0, "hasMore": false }
}
```

## Judgment

- Use it to **reconcile spend** after a batch of work, or when the user asks what something cost. For the current balance, `miles account-status` is the lighter call.
- `--limit` caps at 100 per page; follow `pagination.hasMore` with `--offset` for older history.

## Exit codes

`0` ok · `2` not logged in or unsupported server · `1` failed.
