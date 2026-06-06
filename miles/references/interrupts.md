# Interrupts and Orphaned Runs

A fired Miles turn executes server-side. Stopping the agent (Esc, Stop button, closing the session) does NOT stop the run — it keeps working and keeps spending credits until it finishes or `miles cancel` aborts it. No agent host today fires a hook at the moment of interrupt, so recovery happens on the NEXT interaction.

## The recovery model

1. **The marker.** When the CLI fires a turn (`site-create`, `say`, `build-site`, `convert-theme`), it writes an in-flight marker under `MILES_HOME`. The marker clears when a wait settles the turn (`wait`, `wait-job`, the verb's own auto-wait) or `cancel` succeeds. Markers older than an hour are ignored.
2. **The notice.** While a marker is live, Miles inspection and send verbs (`status`, `site-state`, `sites`, `design-directions`, `account-status`, `say`) print a `[note: ...]` on stderr saying a previous run may be in flight or have an unread result.
3. **Your job on seeing it:** run `miles site-state --json`. Streaming → `wait-job` to rejoin, or offer `miles cancel`. Settled → read the result (`wait-job` returns it) and continue from reality. Tell the user either way; never silently fire new work over an unsettled run.

## Per-host proactive hooks

**Claude Code** — automatic. This skill registers a `UserPromptSubmit` hook (frontmatter) that runs `miles hook-prompt`: when the marker is live, the recovery notice is injected into your context on the user's very next message, before you act.

**Codex** — when a user interrupts a turn, Codex itself injects a generic "conversation interrupted" note into your next turn: treat that as the trigger to check the Miles marker (`miles site-state --json`). Codex skills cannot register lifecycle hooks; a user who wants proactive injection can add a `UserPromptSubmit` hook in their Codex hooks configuration that runs `miles hook-prompt` — its output format (`hookSpecificOutput.additionalContext`) is compatible.

**Cursor** — rely on the CLI notices: the first Miles command you run each turn surfaces the marker. Cursor hooks live in `hooks.json` (user/project config, not skill-registrable); a `stop` hook there can observe `status: "aborted"`, but both it and Cursor's context-injection outputs are currently unreliable — treat any such setup as best-effort on top of the notices, not a replacement.

**Any other host** — the notices are host-independent; nothing else is required.

## `miles hook-prompt`

Internal verb for host hooks: reads the marker and, when live, prints a single JSON object with `hookSpecificOutput.additionalContext` containing the recovery notice; prints nothing when the state is clean. Local file check only — no network, safe to run on every prompt.
