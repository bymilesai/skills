# Miles Skill Smoke Checklist

Use this checklist from a clean environment before treating a skill revision as safe for normal installs.

## Install

```bash
npx skills add bymilesai/skills --skill miles
```

For branch or tag validation:

```bash
npx skills add bymilesai/skills#branch-or-tag --skill miles
```

## Isolate State

Use a fresh Miles state directory so credentials, screenshots, and hook relay files do not come from a development machine.

```bash
export MILES_HOME=/tmp/miles-skill-smoke
export MILES_CLI=/path/to/installed/miles/scripts/miles
"$MILES_CLI" doctor --json
"$MILES_CLI" auth status
```

`doctor --json` must report the expected `MILES_HOME`, the CLI path, and a `server` section listing the connected server's supported primitives.

## Guided Flow (user present)

1. Authenticate.

   ```bash
   "$MILES_CLI" auth login
   "$MILES_CLI" auth poll --json
   "$MILES_CLI" auth status
   ```

2. Request a design.

   ```bash
   "$MILES_CLI" site-create "Build a small website for a local service business."
   ```

   During long commands, verify the agent gives one short start line, then either uses host-rendered progress or sends compact action-log lines based on meaningful Miles milestones. A single edit should have at most three progress lines plus a compact completion checklist. It should not turn streamed output into a transcript or explanatory paragraphs.

3. Relay Miles' questions to the user. Send the user's exact answers back with:

   ```bash
   "$MILES_CLI" say "user answer"
   ```

4. When Miles presents a brief, verify the agent shows the FULL brief and requires explicit approval or requested changes as its final response for that turn.

5. Optionally open the live dashboard so the user can watch generation (generation itself is headless).

   ```bash
   "$MILES_CLI" connect-browser --json
   # Open the returned authenticated url with the host's browser/navigation tool.
   "$MILES_CLI" say "Looks good, approved"
   ```

   If no internal browser is available, `"$MILES_CLI" connect-browser --open` is the fallback.

6. When design directions are ready, inspect them before recommending.

   ```bash
   "$MILES_CLI" design-directions --json
   ```

   With a connected dashboard, the visible canvas is the primary review surface; otherwise the agent should `"$MILES_CLI" screenshot "<preview-url-or-path>" --json` each direction. Verify the agent gives a recommendation tied to the brief and lets the user choose.

7. Build the chosen design — verify no browser is required for this step.

   ```bash
   "$MILES_CLI" build-site --design 1
   "$MILES_CLI" site-state --json
   ```

8. Verify the built site and request one multi-page or content update.

   ```bash
   "$MILES_CLI" screenshot "<site-preview-url-or-path>" --json
   "$MILES_CLI" say "Add an About page and keep the visual style consistent."
   "$MILES_CLI" site-state --json
   ```

   For a second small edit immediately afterward, verify the agent sends the edit directly instead of running a redundant `connect-browser`. If the CLI exits 3 (`need_connection`), verify the agent opens the authenticated URL from `connect-browser --json`, waits for `connected: true`, and retries the same edit once.

9. Convert and export.

   ```bash
   "$MILES_CLI" export --type html --json
   "$MILES_CLI" connect-browser --json
   # Open the returned authenticated url; rerun until connected is true.
   "$MILES_CLI" convert-theme
   "$MILES_CLI" export --type theme --json
   ```

## Headless Chain (no browser at all)

From a brief file, the whole HTML deliverable must complete with zero browser interaction:

```bash
"$MILES_CLI" site-create --brief ./brief.md "Site per attached brief"
"$MILES_CLI" design-directions --json
"$MILES_CLI" screenshot "<direction-preview-path>" --json
"$MILES_CLI" build-site --design 1
"$MILES_CLI" export --type html --json
```

Also verify:

- `"$MILES_CLI" site-attach <siteId>` from a second `MILES_HOME` resumes the same site and `site-state --json` reports the correct phase with sensible `next[]` hints.
- On a server with `cancel` support: `say --no-wait` returns a JSON handle, `wait-job` settles with an `outcome`, and `cancel` stops a running turn (`wait-job` then reports `outcome: "aborted"`).
- Old verb aliases still work: `create-site`, `reply`, `select-design-direction`, `preview`, `build-theme`, `export-site`, `export-theme`.

## Pass Criteria

- The skill is discoverable after install.
- `doctor --json` reports the expected `MILES_HOME`, CLI path, and server primitives.
- Authentication does not reuse development credentials unless intentionally pointed at the same `MILES_HOME`.
- Brief approval and design selection are explicit user decisions.
- `build-site` completes without any dashboard connection.
- Screenshot output includes a readable local file path.
- Exit codes follow the shared grammar (2 preconditions, 3 need_connection, 4 blocked/declined, 5 capacity).
- The flow works without relying on host-specific skill path variables as the primary command contract.
