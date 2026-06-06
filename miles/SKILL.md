---
name: miles
description: Use Miles AI, an expert WordPress designer, through composable CLI primitives. Use when the user wants to design or build a website, get design options for content they already have, design around existing copy or a brief, convert HTML into a WordPress block theme, edit or redesign a site, export site deliverables, resume work on an existing Miles site, or update/uninstall the Miles skill. Triggers include mentions of Miles, bymiles.ai, start.bymiles.ai, "build a website", "design directions", "WordPress theme", or supplying content/briefs that need a designed site.
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

Miles is an AI website designer you drive through a CLI of composable primitives. Each primitive does one job with structured JSON output and meaningful exit codes, and they chain into the full guided design workflow when the user wants the complete experience. You can run the whole journey (discovery interview → brief → design directions → build → WordPress theme) or jump in at exactly the step you need.

Run every command through the bundled CLI. `$MILES_CLI` means the path to this skill's `scripts/miles` launcher:

```bash
MILES_SKILL_DIR="${MILES_SKILL_DIR:-/path/to/miles}"
MILES_CLI="${MILES_CLI:-$MILES_SKILL_DIR/scripts/miles}"
"$MILES_CLI" doctor --json
```

Set the Bash timeout to 10 minutes (600000ms) for long-running commands — site building and theme conversion take minutes. Use `MILES_HOME=/path/to/isolated/state` for a clean test environment (default `~/.miles`).

## The Primitive Menu

This is the complete v0 contract. Do not invent other commands. HEADLESS = works with no browser. BROWSER = needs a connected dashboard via `connect-browser` first. Reference files in `references/` carry each primitive's flags, JSON schema, and judgment — load them when you use the primitive.

| Primitive | Mode | What it does | Reference |
|---|---|---|---|
| `miles auth [login\|poll\|status\|logout]` | HEADLESS | Device-code login lifecycle | [auth.md](references/auth.md) |
| `miles account-status --json` | HEADLESS | Plan, credits, site count — headroom check | [account-status.md](references/account-status.md) |
| `miles site-create "<description>" [--brief <file>]` | HEADLESS | New site + conversation; `--brief` skips discovery | [site-create.md](references/site-create.md) |
| `miles say "<message>"` | HEADLESS* | Talk to Miles: answers, brief feedback, edits | [say.md](references/say.md) |
| `miles design-directions --json` | HEADLESS | List generated design directions with ids + previews | [design-directions.md](references/design-directions.md) |
| `miles build-site --design <n>` | HEADLESS | Commit a design → full HTML site build | [build-site.md](references/build-site.md) |
| `miles wait-job` / `miles cancel` | HEADLESS | Wait for / stop the running turn (JSON + exit codes) | [wait-job.md](references/wait-job.md) |
| `miles site-state --json` | HEADLESS | Phase, directions, connection, suggested next moves | [site-state.md](references/site-state.md) |
| `miles site-attach <siteId> [--duplicate]` | HEADLESS | Resume any owned site; fork before risky changes | [site-attach.md](references/site-attach.md) |
| `miles screenshot <preview-url>` | HEADLESS | Capture any preview to a local JPEG | [screenshot.md](references/screenshot.md) |
| `miles export [--type html\|theme]` | HEADLESS* | Deliverable URLs (theme zip download is browser-backed) | [export.md](references/export.md) |
| `miles connect-browser [--open] [--wait]` | — | The one explicit browser gate: authenticated dashboard URL + connection state | [connect-browser.md](references/connect-browser.md) |
| `miles convert-theme` | BROWSER | HTML site → WordPress block theme | [convert-theme.md](references/convert-theme.md) |

Supporting verbs: `doctor`, `status`, `sites`, `use`, `messages`, `balance`, `wait`. Earlier verb names (`create-site`, `reply`, `select-design-direction`, `preview`, `build-theme`, `export-site`, `export-theme`, `login`, `whoami`, `logout`) still work as aliases.

\* `say` is headless through discovery, brief, and pre-build feedback. Edits on a built WordPress site are browser-backed: the CLI fails fast with exit 3 when the connection is missing. `export --type html` is fully headless.

The CLI checks the connected server's supported primitives automatically (`miles doctor --json` shows them under `server.primitives`). If a primitive is missing there, the server predates it — do not work around it; tell the user.

## Exit Codes and Outcomes

Every verb shares one exit-code grammar. Branch on codes, not prose:

- `0` — completed
- `1` — failed or aborted (read the error, do not blindly retry)
- `2` — precondition missing (not logged in, no active site, unsupported primitive, bad usage)
- `3` — need_connection: open the URL from `connect-browser --json`, wait for `connected: true`, retry the same command once
- `4` — blocked or declined: the requested work did NOT happen
- `5` — capacity: another turn is already running, or the server is saturated; wait, then retry

Settled turns also carry an `outcome` (`completed | blocked | declined | aborted | need_connection | capacity | failed`) in `wait-job` JSON and as `[outcome: ...]` in streamed output. **Never assume success because a command printed text.** A `declined` outcome means the user said no — do not retry it or route around it. Details: [outcomes.md](references/outcomes.md).

## The Headless/Browser Boundary

Everything up to and including the built HTML site is headless: discovery, brief, design directions, the full site build, screenshots, HTML export. The browser fault line sits exactly between "built HTML site" and "WordPress": theme conversion and edits to a converted WordPress site run through a connected dashboard browser.

`connect-browser` is the single, explicit, queryable gate — never a mid-command surprise. Commands that need it fail fast with exit 3; you connect and retry once. Do not pre-emptively open the dashboard for headless work; do open it when the user wants to watch design generation or builds live (it is the best progress surface). Per-host browser tool mapping and connection recovery: [browser.md](references/browser.md).

## Pick Your Entry Point

State is derived from the conversation and monotonic — you can enter at whatever job matches what you already have. The interview is one primitive among many, not the container.

- **"Build me a website" (user present, wants the experience)** → run the full guided workflow: relay Miles' interview to the user, show the brief, present directions, build. Load [full-workflow.md](references/full-workflow.md) — it carries the relay rules, brief-review template, and progress style.
- **"I already have the content / a brief — design around it"** → write the brief to a file → `site-create --brief brief.md "<summary>"` → discovery never runs → `design-directions` → present → `build-site`.
- **"Give me design options for this"** → `site-create --brief ...` → `design-directions --json` → `screenshot` each preview → present in your own UI. Never build until something is chosen.
- **"Edit my Miles site" / "resume where I left off"** → `site-attach <siteId>` (cross-machine) or `use <siteId>` (local) → `site-state --json` → follow its `next[]` hints.
- **"Make it a WordPress theme"** → `connect-browser` → `convert-theme` → `export --type theme`.
- **"Try something risky on an existing site"** → `site-attach <siteId> --duplicate` first; conversation state has no undo — the fork is the branch.

Judgment that holds across all entries: check `account-status` headroom before firing a build; directions before build (users react to options faster than they articulate preferences); content before layout; present design choices to the user rather than choosing silently, unless they explicitly delegated the decision.

## The Full Workflow as a Chain

Each arrow is one primitive; reorder or skip according to what you already have:

```text
auth → account-status                     # headroom before committing
site-create "<description>"               # or --brief file to skip discovery
  loop: say "<user's answer>"             # relay interview; approve brief
connect-browser --open                    # user watching? open the live canvas
design-directions --json → screenshot     # inspect, recommend, let user pick
build-site --design N                     # headless full-site build
say "<edit>" ...                          # iterate on the built site
connect-browser → convert-theme           # the browser fault line
export --type html | --type theme         # deliverables
```

Long verbs (`site-create`, `say`, `build-site`, `convert-theme`) stream progress and wait by default. Add `--no-wait` to get a JSON handle immediately and then drive `wait-job` / `cancel` yourself — useful when your host can poll but not stream. `--no-wait` requires a server with `cancel` support; never fire work you cannot stop.

## Long-Running Commands: Never Dead Air

`site-create` (with a brief), brief approval via `say`, `build-site`, and `convert-theme` each run for **minutes**. Two rules apply BEFORE you fire the first one:

1. **The user must see progress the whole time.** Many hosts — Claude Code included — buffer foreground stdout, which turns the live progress stream into minutes of silence. On those hosts, either run the command in the background and monitor its output log, or fire with `--no-wait` and loop `miles wait-job --timeout 60`, relaying each poll's progress as short `Miles: <action>` milestone lines. Read [full-workflow.md](references/full-workflow.md) for your host's transport pattern before the first long command — not after the user has been staring at nothing.

2. **A present user should watch the design happen.** Before sending the approval that starts design-direction generation, and before `build-site`, open the dashboard: run `connect-browser --json` and open the authenticated `url` in a browser surface **you control** — an internal/in-app browser, preview, webview, or browser MCP tool. An internal browser is strongly preferred over launching the OS browser: you can see the canvas too (inspect designs yourself, watch `connected` flip true), and the user sees it in-context instead of a stray tab. Hosts keep these tools in non-obvious places — check your full tool list (including deferred/searchable tools) and [browser.md](references/browser.md) for your host's mapping BEFORE concluding you have no internal browser. Only then fall back to `connect-browser --open` (the user's OS browser). The dashboard is the live canvas — nothing headless requires it, but a user watching a spinner-free void while their site generates is a product failure. Skip it only for unattended/automation callers, and in every case tell the user roughly how long the step takes before it starts.

## First Run

On a fresh session, check the skill lifecycle, then setup, then auth:

```bash
~/.miles/bin/miles-skill check-update --json   # 24h-gated; prompt user only when shouldPrompt is true
"$MILES_CLI" doctor --json
"$MILES_CLI" auth status
```

If not authenticated, start the non-blocking device login. `auth login` must request a code and exit; it never waits.

```bash
"$MILES_CLI" auth login --json
```

Parse `userCode`, `verificationUrl`, and `pendingState`. Show the user this message, then immediately start the listener — do not wait for the user to say "done":

```text
Code: <userCode>
Open: <verificationUrl>

Open the URL. The page should show this same code; if it matches, click Authorize. I will keep listening for authorization.
```

```bash
"$MILES_CLI" auth poll --json    # 10-minute timeout; polls until authorized
```

The code-match check is a security requirement: never tell the user to authorize a code you did not just generate. On `expired`/`timeout` mint a fresh code; on `rate_limited` wait and re-poll the same code. All poll statuses and edge cases: [auth.md](references/auth.md). If any command reports `SANDBOX_NETWORK_BLOCKED`, stop retrying and follow [sandbox.md](references/sandbox.md) — the remediation must be visible in your final response.

Do not assume the frontmatter hooks ran: non-Claude hosts may ignore them, so walk through `doctor`/`auth status`/login explicitly when state is unclear.

## Working With Results

- `site-create`, `say`, `build-site`, `wait`, and `convert-theme` print Miles' settled response to stdout (and to a hook relay file that some hosts deliver as extra context). Go straight to the next action; do not re-run `messages` or `status` to re-read what you already have.
- When Miles asks a question (`[question: ...]`), relay it to the user with their native question UI when available, or a compact Markdown card; the question must be visible in your final response for that turn. When the user answers, `say` their answer through unchanged. Relay mechanics and templates: [full-workflow.md](references/full-workflow.md).
- When the brief arrives (`phase: brief_review`), show the user the FULL brief plus an approve/request-changes choice as your final response. Never summarize it away — it is the blueprint for the whole site.
- When directions are ready, inspect them (connected dashboard if open, otherwise `screenshot` each preview), give a recommendation tied to the brief with short notes per direction, and let the user choose. Only claim you visually inspected something that actually loaded.
- Progress: relay short `Miles: <action>` milestone lines, not raw logs or paragraphs — see Long-Running Commands above for keeping them visible on your host.
- Credits: surface `[warning: ...]` immediately; on `[error: ...]` about credits, stop and tell the user to top up. `account-status --json` reads balance any time.

## Updating or Uninstalling Miles

Treat "Update Miles" / "Uninstall Miles" as lifecycle requests:

```bash
~/.miles/bin/miles-skill check-update --json --force   # summarize, ask approval
~/.miles/bin/miles-skill update
~/.miles/bin/miles-skill uninstall --dry-run --json    # summarize, ask approval
~/.miles/bin/miles-skill uninstall
```

Never remove `~/.miles/credentials.json` unless the user explicitly asks to purge all local data (`uninstall --purge`). If Miles was installed through a native agent UI, prefer that host's update/uninstall mechanism.
