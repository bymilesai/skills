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
"$MILES_CLI" whoami --json
```

## End-To-End Flow

1. Authenticate.

   ```bash
   "$MILES_CLI" login
   "$MILES_CLI" whoami --json
   ```

2. Request a design.

   ```bash
   "$MILES_CLI" create-site "Build a small website for a local service business."
   ```

3. Relay Miles' questions to the user. Send the user's exact answers back with:

   ```bash
   "$MILES_CLI" reply "user answer"
   ```

4. When Miles presents a brief, show it to the user and require explicit approval or requested changes. Before sending an approval reply that starts design-direction generation, open the dashboard URL and wait for the WebSocket to connect.

5. Open the active dashboard progress URL in the agent browser.

   ```bash
   "$MILES_CLI" preview --json
   # Open the returned url with the host's browser/navigation tool.
   # Rerun preview --json until connected is true.
   "$MILES_CLI" reply "Looks good, approved"
   ```

   If no internal browser is available, run `"$MILES_CLI" preview --open`.

6. When design directions are ready, inspect them before selection.

   ```bash
   "$MILES_CLI" design-directions --json
   "$MILES_CLI" screenshot "<preview-url-or-path>" --json
   ```

7. Select the approved design direction.

   ```bash
   "$MILES_CLI" preview --json
   # Open the returned url with the host's browser/navigation tool.
   # Rerun preview --json until connected is true.
   "$MILES_CLI" select-design-direction 1
   "$MILES_CLI" status --json
   ```

8. Verify the built site and request one multi-page or content update.

   ```bash
   "$MILES_CLI" preview --json
   # Open the returned url with the host's browser/navigation tool.
   # Rerun preview --json until connected is true.
   "$MILES_CLI" screenshot "<site-preview-url-or-path>" --json
   "$MILES_CLI" reply "Add an About page and keep the visual style consistent."
   "$MILES_CLI" wait
   "$MILES_CLI" status --json
   ```

9. Export the result when needed.

   ```bash
   "$MILES_CLI" export-site --json
   "$MILES_CLI" preview --json
   # Open the returned url with the host's browser/navigation tool.
   # Rerun preview --json until connected is true.
   "$MILES_CLI" build-theme
   "$MILES_CLI" export-theme --json
   ```

## Pass Criteria

- The skill is discoverable after install.
- `doctor --json` reports the expected `MILES_HOME` and CLI path.
- Authentication does not reuse development credentials unless intentionally pointed at the same `MILES_HOME`.
- Brief approval and design selection are explicit user decisions.
- Screenshot output includes a readable local file path.
- Multi-page or post-build update commands return a clear status.
- The flow works without relying on host-specific skill path variables as the primary command contract.
