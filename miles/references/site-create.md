# miles site-create

Create a new site plus its conversation with Miles. Porcelain, HEADLESS. This is the canonical start for new work — and `--brief` is the content-injection seam for agents that already own the content.

```bash
miles site-create "<description>" [--name "Site Name"] [--brief <file>] [--no-wait]
```

- `<description>`: pass the user's words through. The richer the description, the fewer discovery questions Miles asks.
- `--name`: optional site name (defaults to the first 50 chars of the description).
- `--brief <file>`: a markdown design brief. Miles treats it as approved, **skips discovery entirely**, and goes straight to design-direction generation. Use this whenever the user already has content, copy, or a written brief — Miles designs around their words instead of interviewing them.
- `--no-wait`: return a JSON handle immediately instead of streaming (see [wait-job.md](wait-job.md)).

By default the command streams progress and prints Miles' first settled response (a discovery question, or direction-generation progress when `--brief` was used). The new site becomes the active site in local credentials.

## Writing a good `--brief`

The brief is the blueprint Miles designs from. Include what the site is for, who it serves, the actual content/copy when the user supplied it (verbatim — Miles designs around their words, it does not rewrite them), page structure, tone, and any constraints (colors, fonts, things to avoid). Markdown headings and lists survive intact.

## Judgment

- With `--brief`, this command immediately starts design-direction generation — a multi-minute run. Before firing: set up your host's progress transport (SKILL.md "Long-Running Commands"), tell the user it takes several minutes, and if they are present open the dashboard (`connect-browser --open`) right after the handle exists so they watch the directions appear.
- User present and wanting the experience → no `--brief`; relay the interview ([full-workflow.md](full-workflow.md)).
- User supplied content/brief → write it to a temp file, use `--brief`. Do not answer interview questions yourself from content you were given; inject it as the brief instead.
- Only answer discovery questions on the user's behalf if they explicitly said "you decide" — and even then still show the brief and directions for approval.
- Each site is one deliverable. Variations for the same business: prefer one site and rerolled directions over fan-out site creation (each build costs credits).

## Exit codes

`0` settled · `2` not logged in / missing description · `4` turn blocked or declined · `5` capacity (another run already streaming) · `1` failed.
