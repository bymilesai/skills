# miles auth

Device-code login lifecycle. Plumbing, HEADLESS (the human authorizes once in their own browser — that is the point of the device flow, not a browser dependency of the CLI).

## Verbs

```bash
miles auth status            # current auth + active site (alias: whoami)
miles auth login [--json]    # request a device code and EXIT — never waits
miles auth poll [--json]     # listen for authorization (10-minute command timeout)
miles auth logout            # clear stored credentials
```

`login`, `whoami`, `logout` remain as top-level aliases.

## Login flow

1. `miles auth login --json` returns:

```json
{
  "userCode": "YXQS-SHNK",
  "verificationUrl": "https://beta.bymiles.ai/device?code=YXQS-SHNK",
  "intervalSeconds": 5,
  "expiresInSeconds": 600,
  "pendingState": "saved"
}
```

The JSON always includes the private `deviceCode` — treat the whole response as sensitive and never echo it into user-facing messages. The CLI also saves it to `$MILES_HOME/login-state.json` (mode 0600) so the poll step can finish the same login without the secret in shell history; only when `pendingState` is `unsaved` do you need to pass it explicitly: `miles auth poll <deviceCode> --json`.

2. Show the user the code + complete URL in a visible assistant message, then immediately run `miles auth poll --json`. Do not wait for the user to confirm first.

3. Poll statuses (inspect `status`, not just exit code):

```json
{ "ok": true,  "status": "authorized", "apiKeyPrefix": "mk_live_..." }
{ "ok": false, "status": "authorized_but_unsaved", "credentialsPath": "...", "error": "..." }
{ "ok": false, "status": "pending", "nextPollIntervalSeconds": 30 }
{ "ok": false, "status": "rate_limited", "retryAfterSeconds": 120 }
{ "ok": false, "status": "expired" }
{ "ok": false, "status": "denied" }
{ "ok": false, "status": "timeout" }
{ "ok": false, "status": "transport_error", "error": "..." }
{ "ok": false, "status": "sandbox_network_blocked", "code": "SANDBOX_NETWORK_BLOCKED", "host": "api.bymiles.ai" }
{ "ok": false, "status": "invalid_request", "error": "..." }
```

## Hard rules

- Never wait inside `auth login` — it must return a code before any polling happens.
- Always display the agent-side code and ask the user to confirm the browser page shows the same code before authorizing. Never tell the user to authorize a code this session did not just generate; if a browser tab shows a different code, tell them to discard that tab.
- Hand the user the complete `verificationUrl` instead of opening the OS browser — opening can land in the wrong browser profile.
- On `expired`/`timeout`: mint a fresh code (`auth login`). On `rate_limited`: wait `retryAfterSeconds`, then re-poll the SAME code — do not mint a fresh one.
- On `denied`: tell the user authorization was declined; offer to retry with a fresh code.
- `auth poll --once` exits 0 for both `authorized` and `pending` — inspect `status`.
- `deviceCode` is a bearer secret: never paste it into user-facing messages or logs.
- After `authorized`, confirm with `miles auth status` before continuing.
- One pending login per `MILES_HOME`; set separate `MILES_HOME`s for concurrent agents.

## Terminal fallback

If the agent sandbox blocks network egress (see [sandbox.md](sandbox.md)), the user can finish login in their own terminal:

```bash
~/.miles/bin/miles login --json
~/.miles/bin/miles login --poll --json
~/.miles/bin/miles whoami
```

Opening the browser URL alone does not finish auth — the polling command still needs shell access to `api.bymiles.ai`.
