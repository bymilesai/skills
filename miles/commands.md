# Miles CLI Command Reference

## Authentication

### `miles login [server-url]`
Opens browser for device auth. Gets an API key stored in `~/.miles/credentials.json`.
Default server: `https://api.bymiles.ai`

### `miles logout`
Clears all stored credentials.

### `miles whoami`
Shows current auth state, server URL, and active site.

## Site Management

### `miles create-site "<description>" [--name "Name"] [--brief <file>]`
Creates a new Playground site and starts a conversation with Miles.
- `--name`: Optional site name (default: first 50 chars of description)
- `--brief`: Path to a markdown file with a pre-built design brief. Skips discovery and jumps straight to design direction generation.
- Auto-waits for Miles' first response.

### `miles sites`
Lists all sites created via the API with their current phase.

### `miles use <siteId>`
Switches the active site for subsequent commands.

### `miles preview`
Gets and opens the dashboard URL for the active site. Appends `?agent=true` to hide the conversation panel.

### `miles balance`
Shows remaining credits. Provides billing URL if credits are low.

## Conversation

### `miles reply "<message>"`
Sends a message to Miles and auto-waits for the response.
Use this to answer Miles' questions during discovery, approve the brief, or give feedback.

### `miles wait [timeout]`
Long-polls for Miles' response. Rarely needed — `create-site`, `reply`, and `select-design-direction` all stream activity and wait automatically (up to 10 minutes). Use `miles wait` only as a recovery if a command was interrupted.

### `miles status`
Quick non-blocking check of conversation state. Returns phase, streaming status, direction count.

## Design Directions

### `miles design-directions`
Returns design direction preview image URLs. These are publicly accessible and can be embedded anywhere.
If no directions exist yet, shows the current phase and what's needed.

### `miles select-design-direction <number>`
Selects a design direction by number (1, 2, or 3). Triggers Miles to build the full site.
Auto-waits for the build to start.

## Export

### `miles export-theme`
Returns WordPress theme slug and download URL. Only available after theme conversion is complete.

### `miles export-site`
Returns static HTML preview URL and storage slug. Available after site generation is complete.

### `miles messages`
Shows simplified conversation history (user and assistant text only).

## Output Format

The CLI outputs plain text optimized for LLM consumption. Status tags appear in brackets:
- `[status: idle|streaming|completed|aborted]` - Streaming state
- `[phase: discovery|brief_review|generating_design_directions|design_directions_ready|building|converting|complete]`
- `[question: ask_user_question|request_confirmation|open_ended]`
- `[directions]` - Design direction list follows
- `[site_ready: true]` - Site is complete
- `[credits: N]` - Remaining credits
