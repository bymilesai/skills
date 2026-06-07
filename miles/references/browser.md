# Browser Surfaces by Host

How to open the authenticated dashboard from `connect-browser --json` on each agent host, and how to verify the connection. This file is only needed for browser-backed work (`convert-theme`, edits on a converted site, theme downloads) or when the user wants to watch progress live.

## Browser priority (all hosts)

1. A controlled internal browser, preview, webview, or navigation tool the agent can open and observe.
2. A configured browser MCP or custom browser tool.
3. `miles connect-browser --open` — the user's external OS browser.
4. CLI-only, after telling the user visual review is degraded.

Exhaust 1 and 2 before touching 3. An internal surface means you can observe the canvas yourself — inspect design directions without screenshots, verify edits landed, and watch `connected` flip true — while the user sees the work in-context. With `--open` you are blind: you cannot confirm the tab opened, stayed open, or logged in. Most hosts DO have an internal surface; it is often not named "browser" in the tool list. Search your complete tool inventory (including deferred or dynamically-loaded tools) for browser, chrome, preview, webview, tab, or navigate capabilities before concluding none exists.

Always open the exact authenticated `url` from JSON (never `dashboardUrl` — it may land on a login page), then rerun `connect-browser --json` (or use `--wait`) until `connected: true`. If a browser rejects the handoff on security policy, that surface is a hard stop: move down the list, do not work around it with raw protocols or unauthenticated URLs.

## Host mapping

**Claude Code**: the Claude-in-Chrome extension is the best surface — a headed Chrome window the agent drives and the user watches, sharing the user's real login state. Its tools are named `mcp__claude-in-chrome__*` (`navigate`, `take_screenshot`, `click`, ...). They are often deferred: search the tool registry (ToolSearch for "claude-in-chrome", "chrome", "browser") before concluding they are absent. If they are genuinely absent, tell the user they can enable it with the `/chrome` command (requires the Claude in Chrome extension). The agent-browser skill (a Playwright-style browser CLI) is a working fallback for holding the dashboard connection and screenshotting it, but it is headless by default — the user sees nothing, so say so. Only after those: `connect-browser --open`.

**Cursor**: Cursor's built-in Browser ("Browser Automation") is an in-editor pane the agent fully drives — navigate, click, type, scroll, screenshot, plus console and network reads — and the user watches it live. Browser state persists per workspace, so the authenticated handoff stays logged in across the session. It is opt-in (Settings > Tools & MCP > Browser Automation, mode "Browser Tab"); trust your ACTUAL tool list over the settings UI — sessions exist where settings show it connected but the tools are not exposed to the agent. If the tools are missing, ask the user to enable it, use a configured browser MCP (Playwright or similar), or fall back to `connect-browser --open`. Cursor's sandbox network policy applies to shell commands ([sandbox.md](sandbox.md)), not the in-editor browser.

**Codex (app / IDE extension)**: the in-app browser is driven through the Browser Use skill plus the `node_repl` JavaScript tool — read that skill and follow its bootstrap (it selects the in-app `iab` backend, names a session, and opens tabs; visibility is inherent to the in-app surface, there is no visibility flag to set). Availability is flaky and thread-scoped: if `node_repl` is not in the tool list, search for it before concluding the browser is unavailable, and let the bootstrap attempt be the real test. Important limitation: the in-app browser does not support sign-in flows or persistent cookies, so the authenticated dashboard handoff may not produce a working session — attempt it once, and on an auth or policy failure treat the in-app browser as a hard stop and use `connect-browser --open`. The terminal Codex CLI has no in-app browser; go straight to `--open` there.

**OpenCode / other hosts**: use any visible browser/webview/preview/browser-MCP tool; otherwise assume none and use `connect-browser --open` — do not wait for a nonexistent internal browser. If the agent cannot observe the external browser, rely on `connect-browser --json` connection state plus `miles screenshot` for review, and say when visual inspection is limited.

## Connection lifecycle

- Connections are per-tab and drop when the tab closes, the user navigates away, or after long idle.
- Browser-backed commands fail fast with exit 3 when the connection is missing — the cheap pattern is act → exit 3 → connect → retry once, not pre-checking before every command.
- Re-check proactively only when: the user reports the tab changed, several minutes passed since the last browser-backed op, a prior op failed or hung, or the next step is high-stakes (theme conversion, first edit after a pause).
- Keep the tab open for the whole duration of long browser-backed runs (conversion).
