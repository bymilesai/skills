# miles connect-browser

The one explicit browser gate. Plumbing. Returns the authenticated dashboard handoff URL and the live connection state; browser-backed primitives (`convert-theme`, `say` edits on a converted site, theme zip downloads) work only while a dashboard is connected.

```bash
miles connect-browser --json            # URL + connection state, no side effects
miles connect-browser --open            # also launch the user's OS browser
miles connect-browser --wait [seconds]  # poll until connected (default 30s; exit 3 on timeout)
```

(`preview` is the legacy alias.)

```json
{
  "url": "https://api.bymiles.ai/…handoff…",
  "dashboardUrl": "https://beta.bymiles.ai/sites/<id>?agent=true",
  "authenticated": true,
  "connected": false,
  "connection": { "kind": "browser-dashboard" },
  "activeSite": { "id": "…", "name": "…" }
}
```

## The rules that make the handoff work

- Open the **`url`** field — when `authenticated` is true it logs that browser into a dashboard session and then redirects. Do NOT substitute `dashboardUrl`; a fresh browser hits the login page and never satisfies the WebSocket connection.
- After opening, rerun `connect-browser --json` (or use `--wait`) until `connected: true` before starting browser-backed work.
- If the host browser rejects the authenticated handoff on security policy, that browser surface is a hard stop — move down the browser priority list ([browser.md](browser.md)); do not retry with `dashboardUrl` or raw browser protocols.
- Connections drop (tab closed, user navigated, long idle). Do not pre-check before every operation: browser-backed commands fail fast with exit 3; connect and retry once. Re-open proactively only for high-stakes steps (theme conversion, first edit after a long pause) or when the user reports the tab changed.

## When to open it even though work is headless

The dashboard is the best live progress surface. When the user is present for direction generation or a site build, opening the dashboard lets them watch — optional for the work, good for the experience.

## Exit codes

`0` reported (inspect `connected` yourself) · `2` no active site · `3` `--wait` timed out without a connection · `1` failed.
