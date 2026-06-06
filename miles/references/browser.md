# Browser Surfaces by Host

How to open the authenticated dashboard from `connect-browser --json` on each agent host, and how to verify the connection. This file is only needed for browser-backed work (`convert-theme`, edits on a converted site, theme downloads) or when the user wants to watch progress live.

## Browser priority (all hosts)

1. A controlled internal browser, preview, webview, or navigation tool the agent can open and observe.
2. A configured browser MCP or custom browser tool.
3. `miles connect-browser --open` — the user's external OS browser.
4. CLI-only, after telling the user visual review is degraded.

Always open the exact authenticated `url` from JSON (never `dashboardUrl` — it may land on a login page), then rerun `connect-browser --json` (or use `--wait`) until `connected: true`. If a browser rejects the handoff on security policy, that surface is a hard stop: move down the list, do not work around it with raw protocols or unauthenticated URLs.

## Host mapping

**Claude Code**: prefer `mcp__Claude_in_Chrome__navigate` when available; else `mcp__Claude_Preview__preview_start`; else `connect-browser --open`.

**Codex**: the Browser plugin is driven through the `node_repl` JavaScript tool after reading the Browser skill — do not conclude Browser is unavailable just because there is no browser tool namespace. Bootstrap per that skill, select the `iab` browser, name the session, open the authenticated `url` in a tab, set `visibility: true` so the user sees progress, then re-check `connect-browser --json` until connected. If Codex policy rejects the handoff URL, stop the in-app setup and use `connect-browser --open`.

**Cursor**: use its browser/preview/navigation surface when present; open the exact authenticated `url`; repoll until connected. No internal surface → `connect-browser --open`. If the sandbox blocks Miles hosts, follow [sandbox.md](sandbox.md) instead of retrying.

**OpenCode / other hosts**: use any visible browser/webview/preview/browser-MCP tool; otherwise assume none and use `connect-browser --open` — do not wait for a nonexistent internal browser. If the agent cannot observe the external browser, rely on `connect-browser --json` connection state plus `miles screenshot` for review, and say when visual inspection is limited.

## Connection lifecycle

- Connections are per-tab and drop when the tab closes, the user navigates away, or after long idle.
- Browser-backed commands fail fast with exit 3 when the connection is missing — the cheap pattern is act → exit 3 → connect → retry once, not pre-checking before every command.
- Re-check proactively only when: the user reports the tab changed, several minutes passed since the last browser-backed op, a prior op failed or hung, or the next step is high-stakes (theme conversion, first edit after a pause).
- Keep the tab open for the whole duration of long browser-backed runs (conversion).
