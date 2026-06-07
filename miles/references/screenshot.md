# miles screenshot

Server-rendered JPEG of any Miles preview path, saved locally. Plumbing, HEADLESS. The path it prints is a real file — view it with your host's image-reading capability and/or embed it in responses as a Markdown image with the absolute path.

```bash
miles screenshot /preview/<slug>/previews/<heroId>/index.html
miles screenshot --json /preview/<slug>/index.html
miles screenshot --full-page /preview/<slug>/index.html
```

- Accepts the path portion of any `previewUrl` (design directions, the built site) or a full URL.
- `--full-page` stitches the entire document instead of the first viewport — use it when verifying footers, below-the-fold sections, or whole-page composition.
- Pass URLs exactly as returned by other primitives. Never reconstruct them by hand from IDs or fragments — a URL mangled in shell interpolation 404s at the renderer and reads like a missing preview.
- Saves to `$MILES_HOME/screenshots/screenshot-<timestamp>.jpg` and prints the path.
- `--json` adds `targetUrl`, `bytes`, `contentType`, and structured error `detail` — rerun with `--json` once when a capture fails to see why.

## Judgment

- This is how a headless agent "sees" design work: screenshot each direction's `previewUrl` before recommending, and screenshot the built site to verify an edit landed.
- When the user's host has a connected dashboard visible, prefer that canvas for review and skip redundant screenshots; use screenshot when there is no browser, the handoff is blocked, or the final response needs embedded images.
- Never claim visual inspection if the capture failed — say the preview could not be loaded and fall back to names/descriptions/URLs.

## Exit codes

`0` saved · `2` no active site / missing URL · `1` capture failed (inspect `--json` detail).
