# miles account-status

Account-scoped plan, credits, and site count. Plumbing, HEADLESS. No conversation or site needed — this is the headroom check to run before committing to expensive work (a full build costs real credits).

```bash
miles account-status [--json]
```

```json
{
  "plan": "Pro",
  "credits": {
    "totalSpendableCredits": 500,
    "monthlyRemainingCredits": 400,
    "topUpBalanceCredits": 100,
    "periodAllowanceCredits": 1000,
    "periodUsageCredits": 600,
    "usagePercent": 60,
    "periodEnd": "2026-07-01T00:00:00.000Z"
  },
  "canBuild": true,
  "buildHeadroom": {
    "spendableCredits": 500,
    "monthlyRemainingCredits": 400,
    "topUpCredits": 100,
    "source": "monthly_and_top_up",
    "explanation": "500 credits are available for Miles work."
  },
  "siteCount": 3,
  "activeSite": { "id": "...", "name": "...", "conversationId": "...", "dashboardUrl": "..." }
}
```

## Judgment

- Run before `build-site` and `convert-theme` when usage looks high or the user has fired several builds this session.
- Use `canBuild` and `buildHeadroom`, not `usagePercent` alone. A plan can be at 100% while spendable top-up credits still provide build headroom.
- When the server returns no credit data, `canBuild` is `null` and `buildHeadroom` is `null` — "balance unavailable", not "zero credits". Do not tell the user to top up on that basis.
- `usagePercent >= 95` with no top-up credits: stop and tell the user to top up at their dashboard billing page before firing more generative work.
- Requires a server that advertises `account-status` (exit 2 with a clear message otherwise). On older servers, `miles balance` reads credits through the active conversation instead.

## Exit codes

`0` ok · `2` not logged in / server lacks the primitive · `1` other failures.
