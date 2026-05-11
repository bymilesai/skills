# Miles CLI Command Reference

## Authentication

### `miles doctor [--json]`
Checks the local CLI runtime, skill path, `MILES_HOME`, credentials file, hook relay file, screenshot directory, Node version, WebSocket support, and active site state.

Use this first when validating an install or when an agent cannot find the Miles CLI.

### `miles login`
Opens browser for device auth. Gets an API key stored in `$MILES_HOME/credentials.json`.
Default server: `https://api.bymiles.ai`

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

### `miles preview`
Gets and opens the dashboard URL for the active site. Appends `?agent=true` to hide the conversation panel.
Supports `--json`. In JSON mode, returns the URL without opening an external browser so agents can use an internal browser tool first.

### `miles balance`
Shows remaining credits. Provides billing URL if credits are low.
Supports `--json`.

## Conversation

### `miles reply "<message>"`
Sends a message to Miles and auto-waits for the response.
Use this to answer Miles' questions during discovery, approve the brief, or give feedback.

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
Returns design direction preview URLs and screenshot commands.
If no directions exist yet, shows the current phase and what's needed.
Supports `--json`.

### `miles select-design-direction <number>`
Selects a design direction by number (1, 2, or 3). Triggers Miles to build the full site.
Auto-waits for the build to start.

### `miles screenshot <preview-url>`
Captures a preview URL to a JPEG under `$MILES_HOME/screenshots` and prints the file path.
Supports `--json`, including target URL, path, byte count, content type, and structured error details when capture fails.

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

Long-running commands such as `create-site`, `reply`, `wait`, `select-design-direction`, and `build-theme` stream progress as text, print the final Miles response to stdout, and write the same response to the hook relay file in `MILES_HOME`.
