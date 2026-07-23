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
- read the installed WordPress version and inspect the Miles plugin's `Requires at least` header before copying or activation
- copy a local Miles plugin source into `wp-content/plugins/miles` when `MILES_PLUGIN_SOURCE` is explicitly set
- download/copy Miles plugin files into `wp-content/plugins/miles`
- install or activate the Miles plugin through WP-CLI when it works
- set `WP_ENVIRONMENT_TYPE=local` for clearly local/dev URLs when WordPress application passwords need it
- call `/api/v2/headless/wordpress-sites/bootstrap`
- pass the returned credentials to `wp miles local-setup --credentials-stdin`
- save the local Miles admin page as the active Miles surface

Do not write plugin options, shared secrets, application passwords, or site tokens yourself.

WP-CLI is optional. If it is missing or cannot load WordPress in the local runtime, the command should still install plugin files when possible and return a manual activation handoff. Normal user installs download the plugin from the release manifest; local source copying is only for explicit `MILES_PLUGIN_SOURCE` overrides. Downloaded ZIPs are extracted to a temporary directory and checked for WordPress compatibility before anything is copied into `wp-content/plugins`.

## Containerized WordPress

The official WordPress web image does not include WP-CLI. Use an executable adapter backed by the official CLI image, then pass its path with `--wp-cli`. The adapter must share the web container's files, network, database environment, and stdin:

```sh
#!/bin/sh
set -eu

case "${1:-}" in
  --path=*) shift ;;
esac

exec docker run --rm -i \
  --network <wordpress-network> \
  --volumes-from <wordpress-container> \
  --user 33:33 \
  -e WORDPRESS_DB_HOST=<database-container>:3306 \
  -e WORDPRESS_DB_USER=<database-user> \
  -e WORDPRESS_DB_PASSWORD=<database-password> \
  -e WORDPRESS_DB_NAME=<database-name> \
  wordpress:cli-php8.3 \
  wp --path=/var/www/html "$@"
```

Save it outside the WordPress document root, make it executable, and supply its absolute path. Refresh or pin the official WordPress image before a clean test; a cached floating `wordpress:latest` can be older than the current Miles plugin minimum.

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
  "wordpressVersion": "7.0.2",
  "pluginVersion": "0.12.3-beta",
  "actions": [
    { "action": "activated-plugin" }
  ],
  "setup": { "success": true },
  "activeSite": { "siteId": "site_...", "name": "Local Site" },
  "next": [
    "Run `miles site-create \"<description>\"` to start a new design on this exact local WordPress site.",
    "Run `miles connect-browser --open` to open the local Miles admin page."
  ]
}
```

Setup pairing does not itself spend build credits. The next `site-create` targets this exact local site only when the server advertises the local operation; otherwise it fails before mutation or spend.

## Compatibility failure

When WordPress is older than the downloaded or selected plugin requires, setup exits `2` before copying or activation:

```json
{
  "ok": false,
  "mode": "local",
  "code": "wordpress_version_unsupported",
  "detectedWordPressVersion": "6.8.3",
  "requiredWordPressVersion": "7.0",
  "pluginVersion": "0.12.3-beta",
  "reason": "Miles 0.12.3-beta requires WordPress 7.0 or newer, but this site is running WordPress 6.8.3. Upgrade WordPress before installing or activating Miles."
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
  "adminPluginsUrl": "http://sample-site.local/wp-admin/plugins.php",
  "milesAdminUrl": "http://sample-site.local/wp-admin/admin.php?page=miles",
  "next": [
    "Ask the user to open http://sample-site.local/wp-admin/plugins.php, sign in to WordPress if prompted, and activate the Miles plugin.",
    "After the user confirms activation, ask them to open http://sample-site.local/wp-admin/admin.php?page=miles and finish Miles setup in WordPress."
  ]
}
```

Do not assume the agent can click WordPress admin controls. The supported fallback is to ask the user to open `adminPluginsUrl`, sign in to WordPress if needed, activate Miles, and confirm when activation is done. Then ask the user to open `milesAdminUrl` and finish the plugin setup flow. Browser automation may assist when available, but user-confirmed activation is the portable path. Use `--site-url` when the local URL cannot be inferred; Local.app paths like `~/Local Sites/<site>/app/public` infer `http://<site>.local`.

## Recovery

- No local WordPress detected: returns `ok: true`, `mode: "cloud"`, and points you to `site-create`.
- Missing auth or missing `wordpress-bootstrap`: exits `2`; do not retry until login/server support is fixed.
- WordPress too old for the plugin: exits `2` with detected and required versions before plugin files are installed; upgrade WordPress and rerun setup.
- WP-CLI missing or broken: installs/copies plugin files when possible, exits `2` with `manualActivationRequired`, `adminPluginsUrl`, and `next[]`; ask the user to activate Miles in WordPress admin and continue in the plugin UI.
- Application passwords unavailable: exits `2` with `next[]`; ask the user to enable HTTPS or configure the local environment safely.
- Plugin setup failure after bootstrap: exits `1` and includes the created `siteId` in the sanitized error. Rerun the same command to relink and finish setup after fixing WordPress.

## Remote WordPress

For a WordPress site on a remote domain, do not install or bootstrap from the local filesystem. Provide the plugin link from the setup output or release manifest, ask the user to install it manually, and use the plugin pairing flow after it is installed.

## Exit Codes

`0` setup completed or cloud fallback selected. `2` missing auth, unsupported server primitive, incompatible WordPress version, manual activation required, no usable local setup path, or application-password precondition. `1` unexpected failure or plugin local setup failed after bootstrap.
