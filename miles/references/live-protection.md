# Live Protection Approvals

Live protection is the safety gate for protected changes to a live Miles site. It is different from ordinary conversation, design-brief approval, and browser connection.

When a turn needs approval, `wait-job`, `status --json`, or `site-state --json` includes `approvalRequired`:

```json
{
  "outcome": "blocked",
  "approvalRequired": {
    "type": "live_protection",
    "grantId": "approval-id",
    "summary": "Publish content changes",
    "actions": [
      { "scope": "content.publish", "summary": "Publish the edited page" }
    ]
  }
}
```

## What You Do

1. Stop the run flow. The protected work has not happened.
2. Tell the user what Miles wants to do, using `summary` and `actions`.
3. Ask them to approve or decline this specific protected change.
4. Only after the latest user message explicitly approves or declines that specific change, run:

```bash
miles approval-respond --grant <approval-id> --response approved
miles approval-respond --grant <approval-id> --response declined
```

`approval-respond` waits for the resumed turn to settle and maps the final outcome with the normal exit codes. With `--json`, it returns the settled `wait-job` payload.

## Consent Rules

Do not infer approval from:

- the original site-edit request
- a prior approval for a different action
- silence
- "continue"
- a broad "yes" where multiple decisions are in play
- automation shortcuts such as `--yes`, `--force`, or `--auto`

The latest user message must explicitly answer the current pending approval. If it is ambiguous, ask a short clarification instead of calling `approval-respond`.

## What Not To Do

- Do not answer a live-protection approval with `miles say`. The server rejects ordinary chat while an approval is pending.
- Do not retry, rephrase, or route around a declined approval.
- Do not call `approval-respond` because a coding agent thinks the change is safe. The user decides.
- Do not expose raw request paths, secrets, tokens, or internal grant details to the user. Use the sanitized CLI summary.

## Locking And Unlocking Miles

This skill cannot lock or unlock Miles. If the user asks you to lock Miles, unlock Miles, or change the protection mode, tell them to use the Miles app control. You may explain what is waiting for approval, but you cannot toggle the lock state from the CLI.

## Recovery

If `miles say` exits with `approval_response_required`, run `miles site-state --json` or `miles wait-job` to read `approvalRequired`, then ask the user. Do not try another `say`.

If `approval-respond` exits `2` with `approval_not_active`, refresh with `site-state --json`; the approval may have been answered, expired, or replaced by a newer one.
