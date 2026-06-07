# miles rename

Rename the active site's conversation (1-100 characters). Plumbing, HEADLESS.

```bash
miles rename "Kiln & Co Pottery" [--json]
```

```json
{ "ok": true, "title": "Kiln & Co Pottery", "themeSlug": "kiln-and-co" }
```

## Judgment

- Rename when the user gives the project a real name mid-flight, or when you created the site from a terse prompt and the brief later settled on proper naming — keeps their dashboard legible.
- `themeSlug` (non-null once a theme is installed) is returned so a browser-connected session can also update the WordPress theme's display name; without a connection the site rename still sticks.

## Exit codes

`0` ok · `2` no active conversation or empty/over-length title · `1` failed.
