# miles history

Paginated read of the conversation transcript. Plumbing, HEADLESS. The server sanitizes exactly like the web client's history view: hidden bookkeeping messages are filtered and internal metadata is removed, so what you read is what the user saw.

```bash
miles history                       # newest messages (the tail)
miles history --limit 10            # last 10 messages
miles history --offset 0 --limit 20 # from the beginning
miles history --json                # full message parts for inspection
```

```json
{
  "total": 42,
  "offset": 22,
  "limit": 20,
  "messages": [
    { "id": "…", "role": "user", "parts": [{ "type": "text", "text": "…" }] },
    { "id": "…", "role": "assistant", "parts": [{ "type": "text", "text": "…" }] }
  ]
}
```

- **Omitting `--offset` returns the tail** — the most recent turns, which is what you need when resuming a conversation. Page backwards with `--offset` (the human output prints the exact command for the previous page).
- `total`/`offset`/`limit` are measured over the sanitized list, so the arithmetic is always consistent with what you can page through.
- Messages carry full `parts` in `--json`: text, tool activity, and visible data parts (build progress, design previews). The human view prints text and summarizes the rest.
- Limit caps at 100 per page.

## Judgment

- Use `history` to recover context you don't have — what was discussed, what the user already approved — not to re-read responses the long verbs just printed.
- For "where are we and what next?", `site-state` is the right verb; `history` is for "what happened?".
- Supersedes `messages` (text-only, unpaginated) on servers that support it.

## Exit codes

`0` ok · `2` no active conversation / server lacks the primitive · `1` failed.
