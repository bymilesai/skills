# miles say

The conversational verb: discovery answers, brief feedback, approval, free-form edit requests on the generated site. Porcelain. One capability among many — not the container everything must pass through.

```bash
miles say "<message>"
miles say --file <path>     # for $, quotes, backticks, Markdown, long answers
miles say --stdin
miles say --no-wait "<message>"
miles say "Use the attached photo in the hero" --attach ./team.jpg
```

(`reply` is the legacy alias.)

By default it sends the message, streams progress, and prints Miles' settled response. Use `--file` whenever the text contains shell-sensitive characters — write the exact text to a temp file rather than fighting quoting. `--attach <path>` (repeatable) uploads a brand asset and hands it to Miles with the message — say what the file is so Miles uses it correctly ([upload-assets.md](upload-assets.md)).

## Headless vs browser

- Discovery answers, brief feedback/approval, direction feedback: HEADLESS.
- Edits on a built/converted WordPress site are browser-backed. The CLI does not pre-check; it fails fast with **exit 3** (`need_connection`) when the dashboard WebSocket is missing. Recovery: `miles connect-browser --json`, open the authenticated `url`, wait for `connected: true`, retry the same `say` once. Do not run `connect-browser` before every edit — let the failure tell you.

## Judgment

- Pass the user's words through unchanged. If they answered "2", send the exact option text for 2; if they wrote a custom answer, send it verbatim. Miles calibrates tone from their phrasing.
- For edits: send a focused, specific request ("remove the card around the Visit section and make its background edge-to-edge") rather than a vague one ("improve the visit area").
- After an edit settles, check the outcome. `[outcome: declined]` means the user (or a confirmation step) said no — do not resend or rephrase to route around it.
- Asking for new design directions is just `say` with the feedback ("None of these feel right — more minimal, less color").

## Exit codes

`0` completed · `2` no active conversation / empty message · `3` need_connection (retry once after connecting) · `4` blocked or declined · `5` already streaming / capacity · `1` failed.
