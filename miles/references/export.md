# miles export

Deliverable URLs, dispatched per type. Plumbing.

```bash
miles export [--type html]   [--json]   # default type
miles export --type theme    [--json]
miles export --type theme --download theme.zip   # stream the ZIP to disk
miles export theme                      # positional form
```

(`export-site` and `export-theme` are the legacy aliases.)

## --type html — HEADLESS

Available once the site build settles. Returns the static-site preview URL and storage slug:

```json
{ "previewUrl": "…", "slug": "…" }
```

This is the complete built HTML site — the first deliverable, exportable with no browser ever involved.

## --type theme — metadata headless, download browser-backed

Available only after `convert-theme` completes. Returns:

```json
{ "themeSlug": "…", "downloadUrl": "…", "editorUrl": "…", "dashboardUrl": "…" }
```

Reading this metadata is headless. **Downloading the theme zip is browser-backed for Playground sites** — the zip is assembled through the connected dashboard. If a download fails without a connected browser, that is the gate, not an error to retry: `connect-browser`, then retry once.

`--download <file>` does the download in one step with your site token and saves to disk; it fails fast with exit 3 when the browser gate is closed. The `downloadUrl` in the metadata points at the same authenticated endpoint (send your site token as a Bearer header).

## Not supported

There is no blueprint or WXR/content export, and no other export types. Do not invent flags; if a workflow needs those artifacts, tell the user they are not available yet.

## Exit codes

`0` ok · `2` no active conversation / unknown type · `1` not available yet (build/conversion has not produced the deliverable) or failed.
