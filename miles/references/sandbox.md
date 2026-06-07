# Sandboxed Agent Network Access

Miles is an online product: the CLI must reach Miles over HTTPS for everything. Command approval does not always grant network egress inside sandboxed agents such as Cursor.

Required egress:

| Host | Needed for |
|------|------------|
| `api.bymiles.ai` or `*.bymiles.ai` | auth, sites, chat, builds, exports, dashboard handoff |
| `start.bymiles.ai` | first install from the memorable URL |
| `github.com` and `*.githubusercontent.com` | release assets, install/update manifests |

## When a command reports a block

Signatures: `SANDBOX_NETWORK_BLOCKED`, `sandbox_network_blocked`, `Blocked by sandbox network policy`, `not on allow list`, or a proxy 403 for a Miles host. JSON errors include `requiredEgress` and `remediation.sandboxJson` — copy those rather than inventing an allowlist.

1. Stop retrying the same command.
2. Tell the user which host was blocked.
3. Make the remediation visible in the FINAL user response for that turn — never only in an intermediate progress note.
4. Offer exactly two paths: allow the Miles hosts in the agent sandbox, or run the command in the user's normal terminal outside the sandbox.

## Cursor remediation

```json
{
  "networkPolicy": {
    "default": "deny",
    "allow": [
      "*.bymiles.ai",
      "start.bymiles.ai",
      "github.com",
      "*.githubusercontent.com"
    ]
  }
}
```

Ask approval before creating or editing `.cursor/sandbox.json`; if it exists, merge these hosts into the existing `networkPolicy.allow` instead of replacing unrelated settings. Then have the user set Cursor Settings > Agents > Auto Run > Auto-Run Network Access to `sandbox.json`/`sandbox.json + Defaults` (or Allow all if they accept broader access). A `sandbox.json.example` ships with this skill.

Response shape when blocked:

````markdown
Miles is installed, but Cursor blocked network access to `<host>`.

To use Miles inside Cursor, allow these hosts in Cursor's sandbox network settings:

```json
{ "networkPolicy": { "default": "deny", "allow": ["*.bymiles.ai", "start.bymiles.ai", "github.com", "*.githubusercontent.com"] } }
```

Save that as `.cursor/sandbox.json` in this project, then set Cursor Settings > Agents > Auto Run > Auto-Run Network Access to use `sandbox.json` or `sandbox.json + Defaults`.

I can create or merge that file for you if you approve. The alternative is to run the Miles command in your normal terminal outside Cursor's sandbox.
````

## Terminal fallback for login

See [auth.md](auth.md) — the user can complete the device login from their own terminal with `~/.miles/bin/miles`; opening the browser URL alone does not finish auth.
