# miles build-site

Commit a design direction and build the complete static HTML site. Porcelain, HEADLESS — the server build pipeline needs no browser. Selection and build are one operation by design: choosing a direction is the commitment that starts the build.

```bash
miles build-site --design <number> [--no-wait]
```

(`select-design-direction <n>` is the legacy alias.)

By default it streams build progress (minutes) and prints the settled response, ending in `[site_ready: true]`-style output when the generated site is ready for preview. The deliverable is a full multi-section HTML site on Miles' hosting, previewable and exportable immediately.

## Judgment

- Build is the expensive step. Before firing: the user (or calling workflow) has chosen a direction, and credits have headroom (`account-status`).
- Tell the user it takes several minutes, set up your host's progress transport first (SKILL.md "Long-Running Commands"), and when the user is present open the dashboard (`connect-browser --open`) before firing so they watch the build live. Only unattended callers run it dark.
- One build at a time per conversation: a second build-ish command while one runs exits 5 (`capacity`). Use `wait-job` or `cancel`, not retries.
- After the build settles, verify before declaring success: `screenshot` the site preview or read the settled response. Then iterate with `say` edits.
- Building a different direction later is possible (it replaces the built site) — but confirm with the user, it spends credits again.

## Exit codes

`0` completed · `2` no active conversation / missing `--design` · `3` need_connection (only when the server gates a rebuild behind a dropped connection) · `4` blocked or declined · `5` already streaming / capacity · `1` failed.
