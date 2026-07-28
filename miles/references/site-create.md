# miles site-create

Create a new cloud site plus its conversation, or start a conversation on the active paired local WordPress site. Porcelain, HEADLESS. This is the canonical start for new work — and `--brief` is the content-injection seam for agents that already own the content.

```bash
miles site-create "<description>" [--name "Site Name"] [--brief <file>] [--attach <file>] [--no-wait]
```

- `<description>`: pass the user's words through. The richer the description, the fewer discovery questions Miles asks.
- `--name`: optional site name (defaults to the first 50 chars of the description).
- `--brief <file>`: a markdown design brief. Miles treats it as approved, **skips discovery entirely**, and goes straight to design-direction generation. Use this whenever the user already has content, copy, or a written brief — Miles designs around their words instead of interviewing them.
- `--attach <file>`: upload a brand asset (logo, imagery, content document) and hand it to Miles with the message. Repeat for multiple files. Mention what each file is in the description ("the attached SVG is their logo") so Miles uses it correctly. Details: [upload-assets.md](upload-assets.md).
- `--no-wait`: return a JSON handle immediately instead of streaming (see [wait-job.md](wait-job.md)).

By default the command streams progress and prints Miles' first settled response (a discovery question, or direction-generation progress when `--brief` was used). For cloud work, the new site becomes active. When the active connection is `local-wordpress`, the command sends that exact site id and preserves its local dashboard, filesystem root, and connection kind.

## Local WordPress safety

The server must advertise `site-create.operations.local-wordpress`. If it does not, the command exits `2` before uploading attachments, creating remote state, starting generation, changing the active site, or spending credits. There is no cloud fallback.

This guard is intentional. A successful `wordpress-setup --use local` may exist before the server has deployed local-site conversation creation; the CLI must report that rollout gap instead of silently creating a different cloud site.

If the server ever returns a different site id than the paired local site, the CLI exits `2` with `code: "unexpected_site_returned"` and refuses to change the active site. The response includes the returned site and conversation ids because a conversation may already be running there. Keep the local target locked; inspect or cancel the unexpected remote run through an account administration surface instead of attaching it into the local session.

While the local target is active, cloud sites are excluded from the CLI session: `sites` lists only the local site, `use` cannot switch away, `site-attach` cannot attach or duplicate another site, and account status does not fetch the cloud site list. Only an explicit user-requested `wordpress-setup --use cloud` releases this lock.

## Writing a good `--brief`

The brief is the blueprint Miles designs from. Include what the site is for, who it serves, the actual content/copy when the user supplied it (verbatim — Miles designs around their words, it does not rewrite them), page structure, tone, and any constraints (colors, fonts, things to avoid). Markdown headings and lists survive intact.

## Judgment

- This is the primitive that starts fresh design work. On an active local WordPress connection it targets that exact site. On a cloud connection it creates a separate cloud deliverable. Never switch a local request to cloud implicitly.
- If the user may mean a redesign of the active site rather than a new deliverable, ask one direct clarification before spending credits or changing the current site.
- With `--brief`, this command immediately starts design-direction generation — a multi-minute run. Before firing: set up your host's progress transport (SKILL.md "Long-Running Commands"), tell the user it takes several minutes, and if they are present open the dashboard (`connect-browser --open`) right after the handle exists so they watch the directions appear.
- User present and wanting the experience → no `--brief`; relay the interview ([full-workflow.md](full-workflow.md)).
- User supplied content/brief → write it to a temp file, use `--brief`. Do not answer interview questions yourself from content you were given; inject it as the brief instead.
- User supplied a logo or imagery → `--attach` it here, at create time, so the design directions are built around the real brand mark instead of a described one.
- Only answer discovery questions on the user's behalf if they explicitly said "you decide" — and even then still show the brief and directions for approval.
- Each site is one deliverable. Variations for the same business: prefer one site and rerolled directions over fan-out site creation (each build costs credits).

## Exit codes

`0` settled · `2` not logged in / missing description / local operation unavailable · `4` turn blocked or declined · `5` capacity (another run already streaming) · `1` failed.
