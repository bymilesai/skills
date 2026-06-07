# miles upload-assets

Upload the user's actual brand assets — logo, imagery, content documents — so Miles designs with their real material instead of a description of it. Plumbing, HEADLESS.

```bash
miles upload-assets <file> [<file>...]
miles site-create "..." --attach ./logo.svg          # upload + create in one step
miles say "Use this photo in the hero" --attach ./team.jpg
```

Most of the time you won't run this verb directly — `--attach <path>` on `site-create` and `say` uploads and attaches in one move (repeat the flag for multiple files). Run `upload-assets` standalone when you want to upload once and reuse the refs across several turns, or when you're driving the HTTP API yourself.

- Accepted types: png, jpg, gif, svg, webp, pdf, html, css, txt, csv, md, rtf, docx. Max 20MB per file.
- Output is JSON: `{ ok, files: [{ s3Key, filename, mimeType, sizeBytes }] }`. Those three fields (`s3Key`, `filename`, `mimeType`) are the complete ref — pass them back as the `uploadedFiles` array on the create-site or message API routes. URLs are derived server-side from the key; refs never carry them.
- `filename` in the output is the stored name (uniquified server-side) — use it, not your local filename, when referring to the upload later.
- Images run through content moderation at upload time; a policy block fails the command with the reason.

## Judgment

- A logo changes the design conversation: attach it at `site-create` time when the user has one, and mention it in the message ("the attached file is their logo") so Miles treats it as the brand mark rather than generic imagery.
- Same for content documents: a PDF or docx of their copy attached alongside `--brief` gives Miles the source material verbatim.
- Don't re-upload the same file every turn. Upload once; the asset stays available to the conversation.
- Uploads with your API key are account-scoped (usable on any of your sites' conversations and at site-create). Uploads made with only a site token are scoped to that one site.

## Exit codes

`0` uploaded · `2` not logged in / no files / server lacks `upload-assets` · `1` upload failed (moderation block, quota, storage).
