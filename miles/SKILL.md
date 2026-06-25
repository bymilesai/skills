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
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "MILES_SKILL_DIR=\"${MILES_SKILL_DIR:-${CLAUDE_SKILL_DIR:-}}\"; MILES_CLI=\"${MILES_CLI:-${MILES_SKILL_DIR}/scripts/miles}\"; \"$MILES_CLI\" hook-prompt 2>/dev/null || true"
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

## Command Surface

This is the supported public command surface. Do not invent other commands. HEADLESS = works with no browser. CONDITIONAL = can finish headlessly only when the underlying turn is not browser-backed. BROWSER = needs a connected dashboard via `connect-browser` first. LOCAL = filesystem helper; any Miles server operation inside it is still capability-gated. Reference files in `references/` carry each command's flags, JSON schema, and judgment — load them when you use the command.

| Command | Mode | What it does | Reference |
|---|---|---|---|
| `miles auth [login\|poll\|status\|logout]` | HEADLESS | Device-code login lifecycle | [auth.md](references/auth.md) |
| `miles account-status --json` | HEADLESS | Plan, credits, site count — headroom check | [account-status.md](references/account-status.md) |
| `miles site-create "<description>" [--brief <file>] [--attach <file>]` | HEADLESS | New site + conversation; `--brief` skips discovery; `--attach` sends brand assets | [site-create.md](references/site-create.md) |
| `miles say "<message>" [--attach <file>]` | HEADLESS* | Talk to Miles: answers, brief feedback, edits | [say.md](references/say.md) |
| `miles upload-assets <file> [...]` | HEADLESS | Upload brand assets (logo, imagery, content docs) → reusable refs | [upload-assets.md](references/upload-assets.md) |
| `miles design-directions --json` | HEADLESS | List generated design directions with ids + previews | [design-directions.md](references/design-directions.md) |
| `miles build-site --design <n>` | HEADLESS | Commit a design → full HTML site build | [build-site.md](references/build-site.md) |
| `miles wait-job` / `miles cancel` | HEADLESS | Wait for / stop the running turn (JSON + exit codes) | [wait-job.md](references/wait-job.md) |
| `miles approval-respond --grant <id> --response approved\|declined` | CONDITIONAL | Answer a protected live-site approval after explicit user consent/refusal | [live-protection.md](references/live-protection.md) |
| `miles undo` | HEADLESS | Revert the last turn: site + chat together, one level | [undo.md](references/undo.md) |
| `miles site-state [--full] --json` | HEADLESS | Phase, directions, connection, site plan, suggested next moves; `--full` adds brief text, direction detail, session memory | [site-state.md](references/site-state.md) |
| `miles site-attach <siteId> [--duplicate]` | HEADLESS | Resume any owned site; fork before risky changes | [site-attach.md](references/site-attach.md) |
| `miles wordpress-detect --json` | LOCAL | Passively detect a local WordPress install in/above the current folder | [wordpress-detect.md](references/wordpress-detect.md) |
| `miles wordpress-setup --use local --json` | LOCAL | Install/activate/connect Miles on a chosen local WordPress install | [wordpress-setup.md](references/wordpress-setup.md) |
| `miles site-pages [path]` | HEADLESS | List built-site files, or fetch one file's content | [site-pages.md](references/site-pages.md) |
| `miles history [--limit <n>] [--offset <n>]` | HEADLESS | Paginated conversation transcript, newest turns by default | [history.md](references/history.md) |
| `miles screenshot <preview-url> [--full-page]` | HEADLESS | Capture any preview to a local JPEG | [screenshot.md](references/screenshot.md) |
| `miles screenshot --live [--viewport]` | BROWSER | Capture the live WordPress frontend through the connected dashboard | [screenshot.md](references/screenshot.md) |
| `miles export [--type html\|theme] [--download <file>]` | HEADLESS* | Deliverable URLs; `--download` streams the theme ZIP (browser-backed) | [export.md](references/export.md) |
| `miles rename "<name>"` | HEADLESS | Rename the site's conversation | [rename.md](references/rename.md) |
| `miles usage-history` | HEADLESS | Credit transaction history for the account | [usage-history.md](references/usage-history.md) |
| `miles connect-browser [--open] [--wait]` | — | The one explicit browser gate: authenticated dashboard URL + connection state | [connect-browser.md](references/connect-browser.md) |
| `miles convert-theme` | BROWSER | HTML site → WordPress block theme | [convert-theme.md](references/convert-theme.md) |

Supporting verbs: `doctor`, `status`, `sites`, `use`, `messages`, `balance`, `wait`. Earlier verb names (`create-site`, `reply`, `select-design-direction`, `preview`, `build-theme`, `export-site`, `export-theme`, `login`, `whoami`, `logout`) still work as aliases.

\* `say` is headless through discovery, brief, and pre-build feedback. Edits on a built WordPress site are browser-backed: the CLI fails fast with exit 3 when the connection is missing. `approval-respond` can answer the grant headlessly, but the resumed protected work may still need the dashboard. `export --type html` is fully headless.

The CLI checks the connected server's supported primitives automatically (`miles doctor --json` shows them under `server.primitives`). If a server-backed primitive is missing there, the server predates it — do not work around it; tell the user. `wordpress-setup --use local` specifically requires `wordpress-bootstrap`; before the beta server includes that primitive, it exits 2 rather than touching a local WordPress install.

## Exit Codes and Outcomes

Every verb shares one exit-code grammar. Branch on codes, not prose:

- `0` — completed
- `1` — failed or aborted (read the error, do not blindly retry)
- `2` — precondition missing (not logged in, no active site, unsupported primitive, bad usage)
- `3` — need_connection: open the URL from `connect-browser --json`, wait for `connected: true`, retry the same command once
- `4` — blocked, approval required, or declined: the requested work did NOT happen
- `5` — capacity: another turn is already running, or the server is saturated; wait, then retry

Settled turns also carry an `outcome` (`completed | blocked | declined | aborted | need_connection | capacity | failed`) in `wait-job` JSON and as `[outcome: ...]` in streamed output. **Never assume success because a command printed text.** A `declined` outcome means the user said no — do not retry it or route around it. Details: [outcomes.md](references/outcomes.md).

## The Headless/Browser Boundary

Everything up to and including the built HTML site is headless: discovery, brief, design directions, the full site build, screenshots, HTML export. The browser fault line sits exactly between "built HTML site" and "WordPress": theme conversion and edits to a converted WordPress site run through a connected dashboard browser.

`connect-browser` is the single, explicit, queryable gate — never a mid-command surprise. Commands that need it fail fast with exit 3; you connect and retry once. Do not pre-emptively open the dashboard for headless work; do open it when the user wants to watch design generation or builds live (it is the best progress surface). Per-host browser tool mapping and connection recovery: [browser.md](references/browser.md).

Live-protection approvals are a separate safety gate from browser connection. When `wait-job`, `status`, or `site-state` returns `approvalRequired`, stop and ask the user to approve or decline that specific protected change. **Never answer it with `say`, and never infer approval from the original task, silence, "continue", or a broad yes.** Only after the latest user message explicitly approves or declines the specific pending change may you run `miles approval-respond --grant <id> --response approved|declined`. Locking or unlocking Miles itself is not available through this skill; tell the user to use the Miles app control. Details: [live-protection.md](references/live-protection.md).

## WordPress Site Choice

When the user wants to use WordPress, first decide the WordPress target with the user. The safe default is Miles cloud unless the user explicitly chooses a local or remote WordPress site.

You may run the passive local shape check before asking:

```bash
"$MILES_CLI" wordpress-detect --json
```

This command must be treated as passive only: it can inspect filenames and report whether the current folder looks like WordPress, but it must not execute WordPress, WP-CLI, PHP, plugins, themes, or database-backed checks. If `localWordPress.found` is `false`, continue with the normal cloud flow (`site-create`). If it is `true`, ask the user one direct question: use Miles cloud, this local WordPress install, or a remote WordPress site? Do not assume local just because it was detected. Details: [wordpress-detect.md](references/wordpress-detect.md).

When the user chooses local, run:

```bash
"$MILES_CLI" wordpress-setup --use local --json
```

The setup command is the explicit local-consent boundary. It requires server `wordpress-bootstrap` support before copying or activating anything. It may run WP-CLI in the selected folder, copy a local Miles plugin source into `wp-content/plugins/miles`, activate it with WP-CLI, configure `WP_ENVIRONMENT_TYPE=local` for clearly local/dev URLs when application passwords need it, ask the Miles API for local-site credentials, hand those credentials to `wp miles local-setup`, and save the local WordPress admin page as the active Miles surface. If WP-CLI is missing, it may copy the plugin files but must ask the user to activate/connect in WordPress admin or install WP-CLI before retrying. Do not write plugin options or secrets yourself. Details: [wordpress-setup.md](references/wordpress-setup.md).

For a WordPress site on a remote domain, do not try to install or bootstrap it from the filesystem. Provide the Miles plugin link from `wordpress-setup` output or the release manifest, ask the user to install it manually, and use the plugin's pairing flow after it is installed.

## Pick Your Entry Point

State is derived from the conversation and monotonic — you can enter at whatever job matches what you already have. The interview is one primitive among many, not the container.

- **"Build me a website" (user present, wants the experience)** → run the full guided workflow: relay Miles' interview to the user, show the brief, present directions, build. Load [full-workflow.md](references/full-workflow.md) — it carries the relay rules, brief-review template, and progress style.
- **"Build me a new website" while another Miles site is active** → do **not** send that prompt through `say` on the current site. Ask one short clarification if intent is ambiguous; if they want a separate deliverable, use `site-create`. If they want to redesign the current site, say that plainly and consider `site-attach <siteId> --duplicate` before risky changes.
- **"I already have the content / a brief — design around it"** → write the brief to a file → `site-create --brief brief.md "<summary>"` (add `--attach logo.svg` for any logo/imagery the user supplied, and say what each file is) → discovery never runs → `design-directions` → present → `build-site`.
- **"Give me design options for this"** → `site-create --brief ...` → `design-directions --json` → `screenshot` each preview → present in your own UI. Never build until something is chosen.
- **"Edit my Miles site" / "resume where I left off"** → `site-attach <siteId>` (cross-machine) or `use <siteId>` (local) → `site-state --json` → follow its `next[]` hints. When you need the full picture (brief text, what was discussed), add `site-state --full --json` and `history`.
- **"What should we work on next?"** → `site-state --json` → read `siteCompletionPlan` → present the pending/failed items and let the user pick → `say` the chosen work.
- **"Make it a WordPress theme"** → `connect-browser` → `convert-theme` → `export --type theme`.
- **"Undo that last change"** → `miles undo` reverts the most recent turn (site + chat together, one level). For anything deeper, `site-attach <siteId> --duplicate` first — the fork is the branch.
- **"Show me how the site looks now" (after conversion)** → `screenshot --live` captures the running WordPress frontend through the connected dashboard; stored-preview screenshots only show the pre-conversion HTML site.

Judgment that holds across all entries: protect the active site from intent drift; check `account-status` headroom before firing a build; directions before build (users react to options faster than they articulate preferences); content before layout; present design choices to the user rather than choosing silently, unless they explicitly delegated the decision.

## The Full Workflow as a Chain

Each arrow is one primitive; reorder or skip according to what you already have:

```text
auth → account-status                     # headroom before committing
site-create "<description>"               # --brief skips discovery; --attach
                                          # sends the user's logo/imagery
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

Know this: **a fired run lives on the server, not in your process — and it always completes on its own.** A turn is bounded work: if the user interrupts you mid-run, Miles finishes the turn and stops; there is no runaway cost. The CLI tracks this with an in-flight marker that survives your process; the next Miles command prints a `[note: ...]` for an unsettled run (on some hosts a hook injects it automatically). **Recovery is YOUR job, not the user's**: quietly rejoin (`miles wait-job`), then respond from reality — finished means present the result, still working means say so and keep watching. Mention `miles cancel` only when the user's message shows they no longer want that work; do not interrogate them about it, and never silently fire new Miles work over an unsettled run. Details and per-host hook setup: [interrupts.md](references/interrupts.md).

2. **A present user should watch the design happen.** This applies to EVERY long run, however it starts — `site-create --brief` (generation begins immediately), the brief approval, `build-site`, `convert-theme`. The moment such a run is in flight with a user present, the dashboard should be open: run `connect-browser --json` and open the authenticated `url` in a browser surface **you control** — an internal/in-app browser, preview, webview, or browser MCP tool. With `--no-wait`, do this right after the handle returns, before the first `wait-job` poll. An internal browser is strongly preferred over launching the OS browser: you can see the canvas too (inspect designs yourself, watch `connected` flip true), and the user sees it in-context instead of a stray tab. Hosts keep these tools in non-obvious places — check your full tool list (including deferred/searchable tools) and [browser.md](references/browser.md) for your host's mapping BEFORE concluding you have no internal browser. Fall back to `connect-browser --open` (the user's OS browser) rather than showing nothing. The dashboard is the live canvas — nothing headless requires it, but a user watching a spinner-free void while their site generates is a product failure. Skip it only for unattended/automation callers, and in every case tell the user roughly how long the step takes before it starts.

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
- When Miles returns `[approval_required]` or `approvalRequired`, relay the protected-change summary and ask for approval or decline. This is not a normal chat question: do not use `say`; use [live-protection.md](references/live-protection.md).
- When the brief arrives (`phase: brief_review`), show the user the FULL brief plus an approve/request-changes choice as your final response. Never summarize it away — it is the blueprint for the whole site.
- When directions are ready, inspect them (connected dashboard if open, otherwise `screenshot` each preview), give a recommendation tied to the brief with short notes per direction, and let the user choose. Only claim you visually inspected something that actually loaded.
- When Miles returns a consent, terms, risk, backup, or destructive-confirmation blocker, show the user the actual user-facing risk/confirmation text, ask for an explicit decision, and treat "no" as final. Do not approve on behalf of the user, collapse legal/safety wording into a vague summary, or retry with different phrasing to bypass the blocker.
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
