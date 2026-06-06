# The Guided Workflow

Load this when a user is present and wants the full Miles experience: interview → brief → design directions → build → theme. The primitives are the same ones the menu lists; what this file adds is the interaction judgment that makes the result good.

## Your role during discovery: relay, not participant

Miles conducts a design interview where each question builds on previous answers. Even when you think you know the answer from the user's prompt, Miles needs to hear it from the user — the specific phrasing calibrates tone, formality, and design direction. Skipping the conversation produces worse designs.

- A detailed initial prompt is a description to pass to `site-create`, not permission to answer the follow-up questions yourself.
- Only if the user explicitly says "you decide" may you answer using judgment — and even then show the brief and directions for approval.
- If the user already HAS the content or a brief, the right move is `site-create --brief`, not you answering interview questions from their material.
- Send answers through unchanged: a number means "send the exact option text for that number"; custom words go verbatim. Skip commentary like "Great choice!" — go straight to the next action.

## Relaying questions

Miles responses include `[question: …]` tags with text and numbered options. Prefer the host's native question UI (Claude Code: `askUserQuestion`; Codex: `request_user_input` when present, callable, and the question has 2-3 options; other hosts: their equivalent) when it can represent ALL options without distortion. Otherwise use this Markdown card — and the card must be the final assistant response for the turn (never only a progress update), with nothing about tools or fallbacks mentioned:

```markdown
**Miles asks:** <question text>

Choose one option.

| # | Option |
|---:|---|
| 1 | <option one> |
| 2 | <option two> |

Reply with one number, or type a custom answer.
```

Use exactly the `#` and `Option` columns; add a `Details` column only from descriptions Miles actually provided. Assume single-choice unless Miles says otherwise. Never drop or invent options.

## Brief review (phase: brief_review)

The brief is the blueprint for the entire site. The next user-visible response MUST contain the full brief content and the approval request together — never a summary, never approval-prompt-only:

```markdown
---

## Design Brief

<full brief content from Miles — preserve headings, bullets, pricing, contact details>

---

**Miles needs approval:** Does this brief look right?

| # | Option |
|---:|---|
| 1 | Approve |
| 2 | Request changes |

Reply with one number, or describe the changes.
```

Self-check before sending: if the actual brief content is missing, revise. Stop after the card and wait.

## Design directions

Before sending the approval that starts generation, tell the user it takes several minutes. If a browser surface exists, open the dashboard ([browser.md](browser.md)) so they can watch — generation is headless either way.

When `design_directions_ready`: inspect (dashboard canvas when connected and visible, else `miles screenshot` each preview), then recommend:

```markdown
My recommendation: **Direction N, Name**.

Why: <rationale tied to the user's brief>.

| # | Direction | Notes |
|---:|---|---|
| 1 | Name | Short visual assessment |
| 2 | Name | Short visual assessment |

Reply with one design number, or describe changes you want before we build.
```

Evaluate visual hierarchy, tone match with the brief, layout quality, imagery, polish, and audience fit. Only claim visual inspection when something loaded. None fit → `miles say` the feedback for new directions. User picks → `miles build-site --design N`.

## Edits on the built site

Send focused `say` requests directly; the CLI fails fast with exit 3 when an edit needs the dashboard — connect ([browser.md](browser.md)) and retry once. For straightforward visual edits skip long preflights: identify the target, apply, verify desktop and mobile. After `convert-theme`, finish with `export --type theme`.

## Progress visibility

Keep the chat calm while showing Miles is alive. Translate the stream into short action-log lines, never raw logs or paragraphs:

```text
Miles: locating Visit section...
Miles: removing card styling...
Miles: verifying desktop and mobile...
```

- One start line, up to ~3 progress lines, one compact completion checklist per edit.
- Lines under ~12 words; if a CLI line already starts with `Miles:`, do not add a second prefix.
- No new meaningful action → stay quiet or one neutral `Miles: stream active...`; never "waiting for milestone" talk.
- Meaningful milestones during generation: started, first design complete, halfway, all complete, or >90s of silence.
- Completion shape:

```markdown
Done:

- Removed Visit card container
- Made background edge-to-edge
- Verified desktop and mobile layout
```

## Long-running command transport by host

Signals worth filtering for: `Miles:` lines, `[phase: …]`, `[status: …]`, `[outcome: …]`, `[question: …]`, `[directions]`, `[site_ready: true]`, `[warning:`, `[error:`, `No credits`.

**Codex**: run long commands normally with a 10-minute timeout — live stdout shows in its activity surface.

**Claude Code**: foreground stdout is buffered, hiding progress. Run long commands (`site-create`, `say`, `build-site`, `convert-theme`, `wait`) with `run_in_background: true`, merge stderr (`2>&1 | tee "$log"`), Monitor the log with a line-buffered selective filter including error/completion signatures, relay concise milestones, read the final response from the result or log, clean up the log:

```bash
log="${TMPDIR:-/tmp}/miles-$(date +%s)-build.log"
"$MILES_CLI" build-site --design 2 2>&1 | tee "$log"
tail -f "$log" | grep --line-buffered -E "Miles:|\[phase:|\[status:|\[outcome:|\[question:|\[directions\]|\[site_ready: true\]|\[warning:|\[error:|No credits|complete|failed"
```

**Cursor / OpenCode**: use the native streaming job surface when it shows live stdout; otherwise the same background + temp-log pattern, polling the log when no monitor tool exists.

**Fallback**: generous timeout, no invented progress; `miles status --json` between steps for coarse phase. An alternative on any host: fire with `--no-wait` and poll `miles wait-job` ([wait-job.md](wait-job.md)).

## The chain, end to end

```bash
miles auth status                          # login if needed (references/auth.md)
miles account-status --json                # credit headroom
miles site-create "<user's description>"   # relay interview via say ...
miles say "Looks good, approved"           # brief approved -> directions generate
miles design-directions --json             # inspect + recommend + user picks
miles build-site --design 2                # headless build
miles say "Make the hero headline shorter" # iterate
miles connect-browser --json               # open url, wait connected
miles convert-theme                        # WordPress block theme
miles export --type theme
```
