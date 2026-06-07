# miles convert-theme

Convert the built HTML site into a WordPress block theme installed on the site's WordPress. Porcelain, **BROWSER** — this is the one genuinely browser-bound porcelain primitive today: conversion runs WordPress operations through the connected dashboard.

```bash
miles convert-theme [--no-wait]
```

(`build-theme` is the legacy alias.)

The command checks for a connected dashboard, waits up to 60s for the WordPress Playground to connect, then runs the conversion and waits (minutes). If no dashboard connects it exits 3 — run `miles connect-browser --json`, open the authenticated `url`, wait for `connected: true`, and retry.

The flow it caps:

```bash
miles connect-browser --json     # open url, wait for connected: true
miles convert-theme              # HTML site -> block theme, installed on the site
miles export --type theme        # theme slug + download URL
```

## Judgment

- Convert AFTER the user is happy with the HTML site. `say` edits before conversion are cheaper and safer than post-conversion edits (which are themselves browser-backed).
- Keep the dashboard tab open and visible for the whole conversion; closing it mid-conversion can interrupt the run. If a conversion is interrupted, reconnect and check `site-state` before retrying — do not blind-fire a second conversion.
- The conversion reports stage-level progress and may surface audit warnings in its output. Relay warnings honestly; do not promise per-element fidelity data the pipeline does not produce.
- Truly headless environments (no browser surface at all, e.g. CI) cannot run this primitive today. Say so plainly and stop at the HTML deliverable (`export --type html`) instead of faking it.

## Exit codes

`0` completed · `2` no active conversation · `3` need_connection (connect, retry once) · `4` blocked or declined · `5` capacity · `1` failed.
