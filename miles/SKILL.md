---
name: miles
description: Design websites with Miles AI. Use when building websites, generating site layouts, creating web content, or when the user mentions Miles. Manages the full design conversation from brief through design direction selection to final build.
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "MILES_SKILL_DIR=\"${MILES_SKILL_DIR:-${CLAUDE_SKILL_DIR:-}}\"; MILES_CLI=\"${MILES_CLI:-${MILES_SKILL_DIR}/scripts/miles}\"; chmod +x \"$MILES_CLI\" 2>/dev/null || true; \"$MILES_CLI\" hook-init 2>/dev/null || true; \"$MILES_CLI\" check-auth 2>/dev/null || true"
          once: true
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "MILES_SKILL_DIR=\"${MILES_SKILL_DIR:-${CLAUDE_SKILL_DIR:-}}\"; MILES_CLI=\"${MILES_CLI:-${MILES_SKILL_DIR}/scripts/miles}\"; \"$MILES_CLI\" hook 2>/dev/null || true"
---

# Miles AI Website Designer

Miles is an AI website designer you interact with through conversation via a CLI. You send messages, Miles responds — progressing through discovery, brief creation, design directions, and full site building.

## Available Commands

This is the complete set of commands. Do not invent others.

| Command | Purpose |
|---------|---------|
| `miles doctor` | Check local CLI setup and paths |
| `miles whoami` | Check authentication status |
| `miles login` | Authenticate (production, opens external browser) |
| `miles create-site "<description>" [--brief file]` | Create site, start conversation, wait for response |
| `miles reply "<message>"` | Send a message to Miles, wait for response |
| `miles reply --file <path>` | Send reply text from a file; best for prices, quotes, Markdown, or long answers |
| `miles reply --stdin` | Send reply text from stdin |
| `miles wait` | Recovery only — if a prior command was interrupted |
| `miles status` | Quick non-blocking status check |
| `miles design-directions [--json]` | Re-list design direction metadata and preview URLs |
| `miles select-design-direction <N>` | Pick a design, triggers site build, waits for completion |
| `miles screenshot <url>` | Screenshot a preview URL (saves JPEG, prints path) |
| `miles preview [--open]` | Get the active dashboard URL |
| `miles sites` | List all sites |
| `miles balance` | Check credits |
| `miles messages` | Full conversation history |
| `miles export-site` | Get static HTML download URL |
| `miles build-theme` | Convert HTML site to WordPress theme |
| `miles export-theme` | Get WordPress theme download URL |

Run all miles commands through the bundled CLI. In examples, `$MILES_CLI` means the path to this skill's `scripts/miles` launcher or `scripts/miles-cli.mjs` file.

If your agent exposes a skill directory variable, resolve the CLI before running commands:

```bash
MILES_SKILL_DIR="${MILES_SKILL_DIR:-/path/to/miles}"
MILES_CLI="${MILES_CLI:-$MILES_SKILL_DIR/scripts/miles}"
"$MILES_CLI" doctor
```

Use `MILES_HOME=/path/to/isolated/state` when you need a clean test environment. By default Miles stores credentials, hook relay state, and screenshots in `~/.miles`.

Set the Bash timeout to 10 minutes (600000ms) for all miles commands — site building and theme conversion can take several minutes.

## Codex Progress Visibility

Miles can stream many useful milestones while it works, but in Codex agent mode the Miles dashboard chat may be hidden from the user. The CLI exposes public progress signals from Miles' live stream, including tool action descriptions, safe tool titles, observations, design/build progress data, and final responses. Keep the main Codex chat calm while still showing that Miles is alive.

Prefer host-rendered progress when available, such as a single updating activity block or chip fed by the latest meaningful Miles milestone.

If no visible progress surface exists, use compact action-log updates in chat. Do not write explanatory progress paragraphs. For a single edit, send at most:

1. One start line.
2. Up to three progress lines.
3. One compact completion checklist.

Progress lines should be one line, under 12 words when possible, and prefixed consistently:

```text
Miles: locating Visit section...
Miles: removing card styling...
Miles: verifying desktop and mobile...
Miles: saving changes...
```

Use Miles output as signal, not transcript. Translate raw logs into short action states such as locating a section, inspecting layout/CSS, applying a change, verifying desktop/mobile, saving, or design directions becoming ready. Prefer phase changes over every emitted line: inspect -> apply -> save -> verify. Suppress repeated or vague updates such as "coordinating specialist work" unless there has been a long silence and no better signal. If the stream is active but has not emitted a new meaningful action, say nothing or use a single neutral `Miles: stream active...` style line; do not tell the user you are "waiting for an edit milestone." Keep raw logs in tool output or expandable details when the host supports that.

Bad:

```text
Miles is now in the right area: it found the Visit section and is inspecting the section root plus the existing Visit Card, which is the boxed piece we want removed.
```

Good:

```text
Miles: inspecting Visit card structure...
```

Completion messages should be compact and verification-focused:

```markdown
Done:

- Removed Visit card container
- Made background edge-to-edge
- Centered location content and directions button
- Verified desktop and mobile layout
```

## Opening the Active Dashboard

During long visual phases, keep the active Miles dashboard visible so the user can see progress. Prefer the host agent's internal browser when one is available. In Codex, this means reading and using the Browser skill, which controls the in-app browser through `node_repl`; do not require a direct browser tool namespace. Only use the CLI's external browser fallback after that path has been attempted or is unavailable.

Mandatory checkpoint: when Miles enters `phase: generating_design_directions`, do not just tell the user you are waiting. Immediately get the active progress URL and open that exact URL in a browser view.

To get the URL without launching the OS browser:

```bash
"$MILES_CLI" preview --json
```

Open the returned `url` with the host's browser/navigation tool. Use the exact URL from JSON. When `authenticated` is true, that URL is an authenticated browser handoff: it logs the browser into a normal dashboard session and then redirects to the active dashboard. Do not replace it with `dashboardUrl`; that plain dashboard URL may send a fresh browser to login and will not satisfy browser-backed WebSocket work. The JSON response also reports whether the dashboard WebSocket is `connected`; after opening the URL, rerun `preview --json` until `connected` is true before starting browser-backed work. If no internal browser tool is available, use the explicit external-browser fallback:

```bash
"$MILES_CLI" preview --open
```

The CLI does not launch dashboard windows from action commands. If the host browser rejects the authenticated handoff URL because of browser security policy, treat that as a hard stop for in-app dashboard opening. Do not try to get the same result by opening `dashboardUrl`, using raw browser protocols, or switching to another browser surface. Tell the user the in-app dashboard could not be opened by policy and use `"$MILES_CLI" preview --open` only when an external browser fallback is acceptable. Do this before design-direction generation, design selection, and theme conversion. For normal edit replies, let the CLI connection guard below decide whether reconnecting is needed.

### Codex In-App Browser Requirement

When running in Codex and the Browser plugin is available, you must use the Browser skill to open the Miles dashboard in the Codex in-app browser.

Do not decide Browser is unavailable just because there is no direct browser tool namespace. In Codex, Browser is controlled through the `node_repl` JavaScript tool after reading the Browser skill. Follow that skill's bootstrap, then:

1. Run `"$MILES_CLI" preview --json` to get the active dashboard URL.
2. Use the Browser skill / Node REPL path to select the `iab` browser.
3. Name the browser session for the site.
4. Open the returned `url` in a tab. If `authenticated` is true, this is the login handoff for the in-app browser before it redirects to the dashboard.
5. Set the browser `visibility` capability to `true` so the user can see progress.
6. Rerun `"$MILES_CLI" preview --json` until `connected` is true.
7. Continue the Miles wait, design-generation, design-selection, edit, or theme-conversion flow.

If Codex rejects the authenticated handoff URL due to browser security policy, do not retry with `dashboardUrl` as a workaround. That URL is intentionally unauthenticated. Stop the in-app browser setup, explain the policy denial, and use `"$MILES_CLI" preview --open` only when opening the external browser is acceptable. Otherwise continue CLI-only and explain that browser-backed work may wait for a dashboard connection.

Only fall back to `"$MILES_CLI" preview --open` or printing the dashboard URL if the Browser plugin is not listed, the Browser skill file cannot be read, `node_repl` JavaScript execution is not available after tool discovery, the Browser bootstrap fails, or the Browser policy denies the authenticated handoff.

### Connection Reuse for Edits

Miles browser-backed edits need the dashboard WebSocket, but the CLI checks this internally for edit replies.

Do not run `preview --json` before every `miles reply` edit. For small follow-up edits, send the edit directly. If the dashboard is not connected when the edit requires browser backing, the CLI fails immediately with `dashboard_connection_required`; then run `"$MILES_CLI" preview --json`, open the returned authenticated URL, wait for `connected: true`, and retry the same edit once.

Open or re-check the dashboard proactively when the browser tab changed, the user navigated away, the browser was interrupted, several minutes passed, Miles reports `dashboard_connection_required`, a prior edit failed or hung, or the operation is high-stakes such as design selection, theme conversion, export setup, or the first edit after a long pause.

For straightforward visual edits, proceed with a focused Miles edit request. Inspect enough to identify the target, apply the change, then verify desktop and mobile behavior; do not add a long preflight unless the target is ambiguous, the first attempt fails, or the edit requires structural understanding.

## Step 1: Authenticate

```bash
"$MILES_CLI" whoami
```

If not logged in:

```bash
"$MILES_CLI" login
```

This opens the OS/default browser for device authorization. Keep login in the external browser because in-app browsers may not support hardware security keys or other required identity-provider flows. After the CLI is logged in, `"$MILES_CLI" preview --json` can log the host's browser surface into the dashboard for viewing and WebSocket work.

## Step 2: Create a Site

Pass the user's description directly to create-site — the richer the initial description, the fewer follow-up questions Miles will ask:

```bash
"$MILES_CLI" create-site "<user's description>"
```

If the user provided a written brief, save it to a temp file and use `--brief`:

```bash
"$MILES_CLI" create-site --brief /tmp/brief.md "<summary>"
```

## Step 3: Relay the Conversation

After every `create-site`, `reply`, or `wait` command, Miles prints its response to stdout. On hosts that support skill hooks, the same response may also be delivered as additional context. The response contains Miles' message, the current phase, and structured data like questions and options.

<relay_guidance>

### Your role: relay, not participant

Miles conducts a design interview where each question builds on previous answers to refine the user's intent. Even if you think you know the answer from the user's original prompt, Miles needs to hear it directly from the user — Miles uses the specific phrasing to calibrate tone, formality, and design direction. Skipping the conversation produces worse designs because Miles lacks the nuanced input it needs.

Your job is straightforward: take what Miles says and show it to the user, then take what the user says and send it to Miles.

A detailed initial prompt (e.g. "Build me a website for my yoga studio in Portland, we do hot yoga and vinyasa, modern style") is a description to pass to `create-site`, not permission to answer all of Miles' follow-up questions yourself. Only if the user explicitly says "just go ahead" or "you decide" can you answer Miles' questions using your judgment — and even then, still show the brief and design directions for user approval.

### How to relay

The Miles response includes structured tags like `[question: ...]` with question text and numbered options. Before presenting a Miles question in plain chat, check whether a native user-question or user-input tool is available, callable in the active mode, and can represent all Miles options without dropping or distorting them. If it can, use that tool for Miles questions, brief approval, and design selection so the user can click an option or type a custom answer. Otherwise, use the Markdown card fallback.

Host examples:

- Claude Code: use `askUserQuestion` when available.
- Codex: use `request_user_input` when it is present, callable in the active mode, and the Miles question has 2-3 options. In some Codex modes this tool is unavailable even when documented elsewhere. If Miles returns more than 3 options, or if the tool is unavailable, present the Markdown card fallback without mentioning tool availability.
- Cursor or other agents: use the host's equivalent choice/freeform question UI when available.

Copy the Miles question text and answer options directly from the response. Preserve all options when the tool supports them. If the host tool cannot represent all Miles options cleanly, use the Markdown card fallback. Do not silently drop important options. Do not invent option explanations or meanings that Miles did not provide.

Assume Miles questions are single-choice unless Miles explicitly says multiple selections are allowed. Make the answer mode clear in the prompt.

### Markdown card fallback

When native structured questions are unavailable, present Miles' question as a compact Markdown card. The message to the user must contain only the card content: heading, question, table, and reply hint. Do not mention `request_user_input`, tool names, fallback behavior, or phrases like "use this format." Do not answer the question yourself.

Important visibility rule: if you need the user's answer, the Markdown card must be the final assistant response for that turn. Do not put the card only in a progress update, tool-request note, hidden reasoning, or intermediate message. Do not send an empty or generic final response after showing the card. Stop after the card and wait for the user to reply.

Choice question card:

**Miles asks:** <question text>

Choose one option.

| # | Option |
|---:|---|
| 1 | <option one> |
| 2 | <option two> |
| 3 | <option three> |

Reply with one number, or type a custom answer.

If Miles explicitly allows multiple selections, replace "Choose one option" with "Choose one or more options" and replace the reply hint with: "Reply with one or more numbers separated by commas, or type a custom answer."

Use exactly the `#` and `Option` columns. Add a third `Details` column only when Miles returned separate option descriptions. Never invent a `Meaning` or `Details` column from your own interpretation.

Approval card:

For `phase: brief_review`, do not use this compact approval card by itself. Use the Brief review template below so the full brief and approval request are visible together in the final response.

**Miles needs approval:** <brief approval or action text>

Choose one option.

| # | Option |
|---:|---|
| 1 | Approve |
| 2 | Request changes |

Reply with one number, or describe the changes.

For design direction selection, use the connected dashboard as the primary visual canvas when it is available. Inspect the visible design cards before asking the user to choose, then give a concise recommendation and a short table of notes. If local screenshots are already available and useful, include them as Markdown images using absolute file paths; do not generate screenshots by default when the dashboard is connected and visually usable. Ask the user to reply with one design number or requested changes.

Then send the user's answer:

```bash
"$MILES_CLI" reply "<user's exact answer>"
```

If the answer contains `$`, quotes, backticks, multiline text, Markdown, or long pricing lists, do not put it in an inline double-quoted shell argument. Prefer writing the exact answer to a temporary file and sending:

```bash
"$MILES_CLI" reply --file /tmp/miles-reply.md
```

If the user replies with a number, send the exact Miles option text for that number. If the user writes a custom answer, pass the user's words through unchanged. If the user says "Modern and clean", send "Modern and clean" — Miles knows how to work with brief answers. Go straight to the next action after each reply; skip commentary like "Great choice!".

</relay_guidance>

<example>
User prompt: "Build a website for my yoga studio"

1. Run: `"$MILES_CLI" create-site "Build a website for my yoga studio"`
2. Miles responds with: `[question: What's the name of your studio?]`
3. Use the native structured question tool if it can represent the question cleanly; otherwise show a Markdown card: "What's the name of your studio?"
4. User answers: "Breathe Portland Yoga"
5. Run: `"$MILES_CLI" reply "Breathe Portland Yoga"`
6. Miles responds with next question → repeat relay
7. Miles presents brief (phase: brief_review) → show brief to user, ask approval
8. User approves → open the authenticated dashboard handoff from `"$MILES_CLI" preview --json`, wait for `connected: true`, then run `"$MILES_CLI" reply "Looks good, approved"`
9. Miles generates design directions with the dashboard visible → inspect them in the browser, recommend one, then present the choices to the user
10. User picks design 2 → ensure `"$MILES_CLI" preview --json` shows `connected: true`, then run `"$MILES_CLI" select-design-direction 2`
11. Miles builds the site → `[site_ready: true]`
</example>

### Brief review

When Miles presents a design brief for approval (phase: `brief_review`), the next user-visible response must include the full brief content and the approval request together. The brief is the blueprint for the entire site. Do not summarize it, omit it, or replace it with only an approval prompt.

If Miles includes `[brief]...[/brief]`, copy the full content inside those tags. Preserve headings, bullets, pricing details, contact details, page structure, and requirements. If Miles provides the brief without tags, copy the full brief text Miles returned.

The brief review must be the final assistant response for that turn. Stop after the approval prompt and wait for the user to reply.

Use this structure:

---

## Design Brief

<full brief content from Miles, preserving Markdown headings and lists when present>

---

**Miles needs approval:** Does this brief look right?

Choose one option.

| # | Option |
|---:|---|
| 1 | Approve |
| 2 | Request changes |

Reply with one number, or describe the changes.

Self-check before sending: if the response does not include the actual brief content from Miles, revise it before sending.

## Step 4: Choose a Design Direction

When Miles finishes generating design directions (phase: `design_directions_ready`), the context includes preview URLs and metadata for each design.

Before design-direction generation begins, tell the user it can take several minutes. Before you send the approval reply that starts generation, run `"$MILES_CLI" preview --json`, open the returned authenticated `url` with the host's internal browser/navigation tool, and rerun `preview --json` until `connected` is true. Then send the approval reply, for example `"$MILES_CLI" reply "Looks good, approved"`. This is required even if Miles has not returned design preview URLs yet; the dashboard URL shows generation progress while the user waits. Do not substitute `dashboardUrl` for the authenticated `url`; a fresh browser may not be logged in. If the internal browser is unavailable or the host policy denies the authenticated handoff, run `"$MILES_CLI" preview --open` as the explicit external-browser fallback when acceptable. During generation, send progress updates only for meaningful milestones: generation started, first design complete, halfway complete, all directions complete, or no visible progress for more than 90 seconds. Use the Codex Progress Visibility action-log style above. Avoid repeated "still waiting" updates unless there is new information or a long silence.

When `preview --json` reports `connected: true`, treat the in-app browser dashboard as the primary design review surface. Run `"$MILES_CLI" design-directions --json` to get direction numbers, names, statuses, and preview URLs. Inspect the visible dashboard canvas first; open individual preview URLs in the in-app browser only when the dashboard cards do not expose enough detail to make a useful judgment. Evaluate each option for visual hierarchy, tone match with the user's brief, layout quality, image quality, overall polish, and suitability for the business and audience.

Give the user design judgment, not just neutral options. Make a recommendation tied to the brief, then present concise notes for each direction. A good response shape is:

```markdown
I inspected the design directions in the Miles dashboard.

My recommendation: **Direction N, Name**.

Why: <brief rationale tied to the user's brief>.

| # | Direction | Notes |
|---:|---|---|
| 1 | Direction name | Short visual assessment |
| 2 | Direction name | Short visual assessment |

Reply with one design number, or describe changes you want before we build.
```

Only say you visually inspected a design if the dashboard, an individual browser preview, or a screenshot actually loaded. If the browser inspection is limited by loading errors or missing previews, say that clearly and fall back to the available metadata.

Use `miles screenshot` as a fallback, not the default connected-dashboard path. Use it when the in-app browser cannot be opened, the authenticated handoff is blocked, `connected` remains false, the dashboard does not visibly show previews, an individual preview URL needs inspection outside the dashboard, the final response needs embedded local images, or the user explicitly asks for screenshots. It saves a JPEG and prints the path, then use the host image-reading capability to view the image:

```bash
"$MILES_CLI" screenshot /preview/abc123/previews/hero-xyz/index.html
```

If `miles screenshot` fails, rerun it once with `--json` and inspect the `detail`, `targetUrl`, and `contentType` fields:

```bash
"$MILES_CLI" screenshot --json /preview/abc123/previews/hero-xyz/index.html
```

If browser previews and screenshots are unavailable, do not claim visual inspection happened. Tell the user that visual preview capture failed, include the design names, any descriptions Miles returned, and preview URLs, then ask whether to choose from descriptions, retry browser/screenshot inspection, or request new directions.

If none fit, ask Miles for new directions with feedback:

```bash
"$MILES_CLI" reply "None of these feel right. I want something more modern and minimal."
"$MILES_CLI" wait
```

Ask the user which design they prefer using the same native-or-Markdown-card rule from Step 3. Then select it — this command triggers the full site build and waits for completion:

```bash
"$MILES_CLI" preview --json
# Open the returned authenticated url with the host's internal browser/navigation tool.
# Rerun preview --json until connected is true.
"$MILES_CLI" select-design-direction <number>
```

The select command already waits for the build, so there's no need to run `miles wait` after it.

## Step 5: The Built HTML Site

When `select-design-direction` finishes (indicated by `[site_ready: true]`), Miles has built a complete static HTML website. This is the first deliverable.

```bash
"$MILES_CLI" preview --json       # Get live preview URL for the host browser
"$MILES_CLI" screenshot <url>     # Screenshot a preview URL
"$MILES_CLI" export-site          # Get static HTML download URL and file info
```

For generated-site edits, send straightforward `miles reply` requests directly when the dashboard was recently opened or appears visibly connected. The CLI checks whether the edit needs the dashboard WebSocket and fails immediately with `dashboard_connection_required` when the browser is not connected. On that error, run `"$MILES_CLI" preview --json`, open the returned authenticated URL, wait for `connected: true`, then retry the same edit once.

## Step 6: WordPress Theme (Separate Step)

Converting the HTML site into a WordPress block theme is a separate operation from the site build.

```bash
"$MILES_CLI" preview --json       # Open returned authenticated url in the host browser first
# Rerun preview --json until connected is true.
"$MILES_CLI" build-theme
"$MILES_CLI" export-theme         # Get WordPress theme download URL
```

## How the Hook Works

When you run `create-site`, `reply`, or `wait`, the CLI prints Miles' response and writes it to a relay file under `MILES_HOME`. On hosts that support a PostToolUse hook, the hook reads that file and delivers it as additional context. This means:

- Miles' response appears in stdout; on hook-capable hosts it may also appear as context after the tool result
- `create-site`, `reply`, and `wait` already deliver Miles' full response, so calling `miles messages` or `miles status` afterward is redundant
- Go straight to the next action after receiving Miles' response. If Miles needs user input, the question must be visible in the final assistant response using the native-or-Markdown-card rule. If no user input is needed, tell the user what happened.

## Credits

Miles uses credits for operations. If the context includes a `[warning: ...]` about credits running low, inform the user. If there's an `[error: ...]` about no credits, stop and tell the user to top up at their dashboard billing page.

See [commands.md](commands.md) for detailed command reference and [examples.md](examples.md) for workflow examples.
