# miles wordpress-setup

Explicit local WordPress setup helper. LOCAL helper, server-gated by `wordpress-bootstrap`.

```bash
miles wordpress-setup --use local --json [--path <dir>] [--site-url <url>] [--open] [--wp-cli <path>] [--admin-user <login>]
miles wordpress-setup --use cloud --json
```

## Capability Gate

`--use local` requires the connected Miles server to advertise `wordpress-bootstrap` in `miles doctor --json` under `server.primitives`. If that primitive is missing, the command exits `2` before copying plugin files, activating WordPress plugins, changing `wp-config.php`, or creating a Miles site.

This matters during staged rollout: the public skill can contain the command before beta has the server primitive, and it must fail cleanly until beta is promoted.

## What Local Setup May Do

Only after the user explicitly chooses local WordPress, the command may:

- run WP-CLI in the selected WordPress root
- copy a local Miles plugin source into `wp-content/plugins/miles`
- download/copy Miles plugin files into `wp-content/plugins/miles`
- install or activate the Miles plugin through WP-CLI when it works
- set `WP_ENVIRONMENT_TYPE=local` for clearly local/dev URLs when WordPress application passwords need it
- call `/api/v2/headless/wordpress-sites/bootstrap`
- pass the returned credentials to `wp miles local-setup --credentials-stdin`
- save the local Miles admin page as the active Miles surface

Do not write plugin options, shared secrets, application passwords, or site tokens yourself.

WP-CLI is optional. If it is missing or cannot load WordPress in the local runtime, the command should still install plugin files when possible and return a manual activation handoff.

## JSON Success

```json
{
  "ok": true,
  "mode": "local",
  "siteId": "site_...",
  "siteUrl": "http://localhost:8888",
  "dashboardUrl": "http://localhost:8888/wp-admin/admin.php?page=miles",
  "cloudDashboardUrl": "https://start.bymiles.ai/sites/site_...",
  "relinked": false,
  "actions": [
    { "action": "activated-plugin" }
  ],
  "setup": { "success": true },
  "activeSite": { "siteId": "site_...", "name": "Local Site" },
  "next": [
    "Run `miles connect-browser --open` to open the local Miles admin page."
  ]
}
```

## Manual Activation Handoff

When WP-CLI cannot activate/pair the plugin, setup exits `2` with plugin files installed when possible:

```json
{
  "ok": false,
  "mode": "local",
  "manualActivationRequired": true,
  "actions": [
    { "action": "copied-plugin", "targetDir": "/path/to/wp-content/plugins/miles" }
  ],
  "adminPluginsUrl": "http://andys-coffee.local/wp-admin/plugins.php",
  "milesAdminUrl": "http://andys-coffee.local/wp-admin/admin.php?page=miles",
  "next": [
    "Open http://andys-coffee.local/wp-admin/plugins.php and activate the Miles plugin.",
    "Then open http://andys-coffee.local/wp-admin/admin.php?page=miles to finish Miles setup in WordPress."
  ]
}
```

Open `adminPluginsUrl` in the browser surface, ask the user to activate Miles if you cannot click it yourself, then open `milesAdminUrl` and finish the plugin setup flow. Use `--site-url` when the local URL cannot be inferred; Local.app paths like `~/Local Sites/<site>/app/public` infer `http://<site>.local`.

## Recovery

- No local WordPress detected: returns `ok: true`, `mode: "cloud"`, and points you to `site-create`.
- Missing auth or missing `wordpress-bootstrap`: exits `2`; do not retry until login/server support is fixed.
- WP-CLI missing or broken: installs/copies plugin files when possible, exits `2` with `manualActivationRequired`, `adminPluginsUrl`, and `next[]`; activate Miles in WordPress admin and continue in the plugin UI.
- Application passwords unavailable: exits `2` with `next[]`; ask the user to enable HTTPS or configure the local environment safely.
- Plugin setup failure after bootstrap: exits `1` and includes the created `siteId` in the sanitized error. Rerun the same command to relink and finish setup after fixing WordPress.

## Remote WordPress

For a WordPress site on a remote domain, do not install or bootstrap from the local filesystem. Provide the plugin link from the setup output or release manifest, ask the user to install it manually, and use the plugin pairing flow after it is installed.

## Exit Codes

`0` setup completed or cloud fallback selected. `2` missing auth, unsupported server primitive, manual activation required, no usable local setup path, or application-password precondition. `1` unexpected failure or plugin local setup failed after bootstrap.
