# Miles CLI Command Reference

## Authentication

### `miles doctor [--json]`
Checks the local CLI runtime, skill path, `MILES_HOME`, credentials file, hook relay file, screenshot directory, WebSocket support, and active site state.

Use this first when validating an install or when an agent cannot find the Miles CLI.

### `miles login [--json]`
Requests a Miles device login code and exits immediately, without polling or opening a browser.

Text output presents the code and prefilled URL:

```text
Code: YXQS-SHNK
Open: https://beta.bymiles.ai/device?code=YXQS-SHNK
```

JSON output includes `deviceCode`, `userCode`, complete code-embedded `verificationUrl`, `verificationUrlHasCode`, `intervalSeconds`, `expiresInSeconds`, `expiresAt`, `pendingState`, and `pendingStatePath`. Agents should show `userCode` and `verificationUrl` to the user, ask the user to confirm the browser page shows the same code, then immediately run `miles login --poll --json` to listen while the user authorizes.

The CLI also saves the pending login to `$MILES_HOME/login-state.json` with mode `0600`, so a later `miles login --poll` can finish the same login without a device code argument. If `pendingState` is `unsaved`, the JSON response includes `pendingStateError`; agents should poll with the returned `deviceCode` explicitly. `deviceCode` is a bearer secret for the polling step. Do not paste it into user-facing messages, logs, or shared telemetry.

Only one pending login is supported per `MILES_HOME`. For concurrent agents or separate users, set a separate `MILES_HOME` before running Miles.

### `miles login --poll [deviceCode] --json [--interval <seconds>] [--expires-in <seconds>] [--timeout <seconds>] [--once]`
Listens for the pending device login to be authorized. On success, saves the API key to `$MILES_HOME/credentials.json`.

When `deviceCode` is omitted, the CLI uses the pending login saved by the preceding `miles login`. Explicit `deviceCode`, `--interval`, and `--expires-in` are still accepted for stateless callers. The command can run until the code is authorized or expires; agents should allow a 10-minute command timeout.

JSON output uses stable `status` values:

```json
{ "ok": true, "status": "authorized", "apiKeyPrefix": "mk_live_..." }
{ "ok": false, "status": "authorized_but_unsaved", "apiKeyPrefix": "mk_live_...", "credentialsPath": "~/.miles/credentials.json", "error": "..." }
{ "ok": false, "status": "pending" }
{ "ok": false, "status": "pending", "retryAfterSeconds": 30, "nextPollIntervalSeconds": 30 }
{ "ok": false, "status": "expired" }
{ "ok": false, "status": "denied" }
{ "ok": false, "status": "rate_limited", "retryAfterSeconds": 120 }
{ "ok": false, "status": "transport_error", "error": "..." }
{ "ok": false, "status": "invalid_request", "error": "..." }
{ "ok": false, "status": "timeout" }
```

Use `--once` for a single status check. It exits 0 for both `authorized` and `pending`; agents must inspect `status`, not only the exit code. If `pending` includes `nextPollIntervalSeconds` or `retryAfterSeconds`, wait at least that long before polling again. Without `--once`, the command waits until authorization succeeds, expires, is denied, is rate-limited, has repeated transport failures, or times out. Default server: `https://api.bymiles.ai`.

By default, `MILES_HOME` is `~/.miles`. Set `MILES_HOME=/path/to/isolated/state` for clean-machine smoke tests or separate agent environments.

### `miles logout`
Clears all stored credentials.

### `miles whoami`
Shows current auth state and active site.
Supports `--json`.

## Site Management

### `miles create-site "<description>" [--name "Name"] [--brief <file>]`
Creates a new Playground site and starts a conversation with Miles.
- `--name`: Optional site name (default: first 50 chars of description)
- `--brief`: Path to a markdown file with a pre-built design brief. Skips discovery and jumps straight to design direction generation.
- Auto-waits for Miles' first response.

### `miles sites`
Lists all sites created via the API with their current phase.
Supports `--json`.

### `miles use <siteId>`
Switches the active site for subsequent commands.
Supports `--json`.

### `miles preview [--open]`
Gets the dashboard URL for the active site. Appends `?agent=true` to hide the conversation panel.
Supports `--json`. JSON output includes `url`, `dashboardUrl`, `authenticated`, `connected`, and `activeSite` so agents can open the URL with a host browser tool and verify the dashboard WebSocket connection. When `authenticated` is true, `url` is the authenticated browser handoff that logs that browser into a normal dashboard session before redirecting to `dashboardUrl`. Do not replace it with `dashboardUrl`; a fresh browser may otherwise hit the login page. Use `--open` only when you explicitly want the CLI to launch the OS browser.
When design direction generation starts, agents should run `miles preview --json`, open the returned authenticated `url`, and rerun `miles preview --json` until `connected` is true. If a host browser rejects the authenticated handoff because of browser security policy, do not work around that by opening `dashboardUrl`; use an approved external browser fallback or continue CLI-only.

### `miles balance`
Shows remaining credits. Provides billing URL if credits are low.
Supports `--json`.

## Conversation

### `miles reply "<message>"`
Sends a message to Miles and auto-waits for the response.
Use this to answer Miles' questions during discovery, approve the brief, or give feedback.
After a site is generated, browser-backed edits require the dashboard WebSocket connection. Send `miles reply` directly for normal edits; when an edit needs the dashboard and it is not connected, the CLI fails immediately with `dashboard_connection_required`. Recover by running `miles preview --json`, opening the authenticated URL, waiting for `connected: true`, then retrying the same reply once.

For text that contains shell-sensitive characters such as `$`, backticks, quotes, or multiline Markdown, prefer:

```bash
miles reply --file /tmp/reply.md
printf '%s' 'Quick Safety Check starting at $35' | miles reply --stdin
```

Both forms auto-wait for the response.

### `miles wait`
Long-polls for Miles' response. Rarely needed — `create-site`, `reply`, and `select-design-direction` all stream activity and wait automatically (up to 10 minutes). Use `miles wait` only as a recovery if a command was interrupted.

### `miles status`
Quick non-blocking check of conversation state. Returns phase, streaming status, direction count.
Supports `--json`.

## Design Directions

### `miles design-directions`
Returns design direction numbers, names, preview URLs, and screenshot commands.
If no directions exist yet, shows the current phase and what's needed.
Supports `--json`.
When the dashboard is connected and visually usable, use these results as metadata for browser-first review rather than as an instruction to screenshot every direction.

### `miles select-design-direction <number>`
Selects a design direction by number. Triggers Miles to build the full site.
Requires the dashboard WebSocket connection before starting the build. Run `miles preview --json`, open the returned authenticated URL with the host browser tool, and rerun `miles preview --json` until `connected` is true before selecting.

### `miles build-theme`
Converts the completed HTML site into a WordPress block theme.
Requires the dashboard WebSocket connection before conversion. Run `miles preview --json`, open the returned authenticated URL with the host browser tool, and rerun `miles preview --json` until `connected` is true before building.

### `miles screenshot <preview-url>`
Captures a preview URL to a JPEG under `$MILES_HOME/screenshots` and prints the file path.
Supports `--json`, including target URL, path, byte count, content type, and structured error details when capture fails.
Use this as a fallback when browser previews are unavailable, blocked, not connected, not visible, or when the final response needs embedded local image files. Do not make screenshots the default review path once the connected dashboard is available.

## Export

### `miles export-theme`
Returns WordPress theme slug and download URL. Only available after theme conversion is complete.
Supports `--json`.

### `miles export-site`
Returns static HTML preview URL and storage slug. Available after site generation is complete.
Supports `--json`.

### `miles messages`
Shows simplified conversation history (user and assistant text only).
Supports `--json`.

## Output Format

The CLI outputs plain text optimized for LLM consumption. Status tags appear in brackets:
- `[status: idle|streaming|completed|aborted]` - Streaming state
- `[phase: discovery|brief_review|generating_design_directions|design_directions_ready|building|site_preview|site_generation|converting|complete]`
- `[question: ask_user_question|request_confirmation|open_ended]`
- `[directions]` - Design direction list follows
- `[site_ready: true]` - Site is complete
- `[warning: ...]` or `[error: ...]` - Credit warnings when usage is high

For agent composition, use `--json` with non-streaming inspection commands such as `doctor`, `whoami`, `status`, `sites`, `design-directions`, `screenshot`, `messages`, `export-site`, and `export-theme`.

Long-running commands such as `create-site`, `reply`, `wait`, `select-design-direction`, and `build-theme` stream progress as text, print the final Miles response to stdout, and write the same response to the hook relay file in `MILES_HOME`. The stream includes public progress signals from tool action descriptions, safe tool titles, observations, design/build progress data, and final responses.

For Codex agent mode, treat streamed progress as milestone input for a compact visible status, not as chat transcript. When chat fallback is needed, use action-log lines like `Miles: verifying mobile layout...`, cap single-edit updates, and finish with a compact checklist. If the stream is active but there is no new meaningful action yet, do not say "waiting for edit milestone"; either stay quiet or use one neutral line such as `Miles: stream active...`.
If a CLI progress line already starts with `Miles:`, do not add another `Miles:` prefix when forwarding or paraphrasing it.

Browser-backed edits need the dashboard WebSocket, but agents do not need to pre-check before every `miles reply`. Let the CLI guard the operation. If it returns `dashboard_connection_required`, open the authenticated dashboard URL with `miles preview --json`, wait for `connected: true`, and retry once. Keep proactive checks for high-stakes operations such as design selection and theme conversion.
