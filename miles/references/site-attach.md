# miles site-attach

Attach this machine to any site the account owns: mints a fresh site token, hydrates local credentials, and makes it the active site. Plumbing, HEADLESS. This is cross-machine resume — the site only needs to exist server-side, not in local credentials.

```bash
miles site-attach <siteId> [--json]
miles site-attach <siteId> --duplicate [--name "Copy name"]
miles sites --json          # list owned sites with ids and phases
miles use <siteId>          # switch between sites already in LOCAL credentials
```

These cloud-site operations are unavailable while a paired local WordPress site is active. In local mode, `sites` shows only the paired local target and both `site-attach` and switching to another site with `use` exit `2` with `code: "local_target_locked"` before any network request. Continue on the active local site, or—only when the user explicitly chooses to leave it—run `miles wordpress-setup --use cloud --json` first.

```json
{
  "ok": true,
  "siteId": "…",
  "conversationId": "…",
  "phase": "site_preview",
  "duplicated": false,
  "next": ["miles site-state --json"]
}
```

## --duplicate: the official branch pattern

Conversation state is append-only — there is no undo or rewind. Before risky or experimental changes to a site the user cares about, fork it:

```bash
miles site-attach <siteId> --duplicate --name "Redesign experiment"
```

The copy (site, conversation, files) becomes the active site; the original is untouched. Duplicating an in-flight site mid-build is not a branch worth taking — fork settled sites.

## Judgment

- Resume flow: `sites --json` → `site-attach <id>` → `site-state --json` → follow `next[]`.
- Before large redesigns, "start over" requests on a site the user still cares about, or ambiguous new-vs-edit intent, prefer duplicating first or asking whether they want a separate site. Do not use a live active site as scratch space.
- Site tokens expire after ~24h; if conversation verbs start failing with auth errors on an old attached site, re-attach to mint a fresh token. If the server says the site is unknown, revoked, suspended, or not repairable, do not keep re-attaching in a loop — follow [auth.md](auth.md) and involve the user.
- `use` only switches between sites this machine already knows; `site-attach` is the one that works from anywhere.

## Exit codes

`0` attached · `2` not logged in / missing siteId · `1` site not found or failed.
