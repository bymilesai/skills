# miles site-pages

Enumerate the built static site's files, or fetch one file's content. Plumbing, HEADLESS — the files live in storage, no browser involved. Available once the site build completes (phase `site_preview` onward).

```bash
miles site-pages [--json]                    # list all files
miles site-pages index.html                  # print one file to stdout
miles site-pages assets/style.css --output style.css   # save to disk
```

List shape:

```json
{
  "slug": "kiln-site",
  "files": [
    { "path": "index.html", "mimeType": "text/html", "sizeBytes": 20480, "previewUrl": "…" },
    { "path": "about/index.html", "mimeType": "text/html", "sizeBytes": 18210, "previewUrl": "…" }
  ]
}
```

## Judgment

- Use the listing to **verify page counts and audit structure** (did every planned page get built?) without rendering anything.
- Fetch individual HTML when you need to **inspect or diff actual markup** — checking that content you supplied made it in verbatim, comparing revisions, or extracting copy.
- For *visual* verification use `miles screenshot <previewUrl>` instead; fetched HTML is for reading, the `previewUrl` is for rendering.
- Binary files (images) print raw bytes — always use `--output` for those.

## Exit codes

`0` ok · `2` site not built yet, or file not found · `1` failed.
