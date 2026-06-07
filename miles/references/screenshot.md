# miles screenshot

Server-rendered JPEG of any Miles preview path, saved locally. Plumbing, HEADLESS. The path it prints is a real file — view it with your host's image-reading capability and/or embed it in responses as a Markdown image with the absolute path.

```bash
miles screenshot /preview/<slug>/previews/<heroId>/index.html
miles screenshot --json /preview/<slug>/index.html
miles screenshot --full-page /preview/<slug>/index.html
miles screenshot --live              # live WordPress frontend (BROWSER)
miles screenshot --live --viewport   # first screen only, faster
```

- Accepts the path portion of any `previewUrl` (design directions, the built site) or a full URL.
- `--full-page` stitches the entire document instead of the first viewport — use it when verifying footers, below-the-fold sections, or whole-page composition.
- Pass URLs exactly as returned by other primitives. Never reconstruct them by hand from IDs or fragments — a URL mangled in shell interpolation 404s at the renderer and reads like a missing preview.
- Saves to `$MILES_HOME/screenshots/screenshot-<timestamp>.jpg` and prints the path.
- `--json` adds `targetUrl`, `bytes`, `contentType`, and structured error `detail` — rerun with `--json` once when a capture fails to see why.

## Live capture (`--live`)

After theme conversion the site runs as WordPress and stored previews show only the old pre-conversion HTML. `--live` captures the running WordPress frontend itself, through the connected dashboard — this is how a headless agent sees the converted site and verifies WordPress-era edits landed.

- BROWSER-gated: needs a connected dashboard (the running WordPress exists in the browser for Playground sites). Fails fast with exit 3 when missing — run `connect-browser`, wait for connected, retry once.
- Takes no URL — it captures the active conversation's site frontend, saving any unsaved editor changes first.
- Full-page by default; `--viewport` opts into the faster first-screen capture.
- Slower than stored-preview screenshots (the page renders in the browser, then full-page capture stitches viewports — allow a couple of minutes on long pages).

## Judgment

- This is how a headless agent "sees" design work: screenshot each direction's `previewUrl` before recommending, and screenshot the built site to verify an edit landed.
- When the user's host has a connected dashboard visible, prefer that canvas for review and skip redundant screenshots; use screenshot when there is no browser, the handoff is blocked, or the final response needs embedded images.
- Never claim visual inspection if the capture failed — say the preview could not be loaded and fall back to names/descriptions/URLs.

## Exit codes

`0` saved · `2` no active site / missing URL / server lacks `--live` · `3` `--live` without a connected dashboard · `1` capture failed (inspect `--json` detail).
