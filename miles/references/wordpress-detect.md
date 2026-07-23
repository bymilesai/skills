# miles wordpress-detect

Passive local WordPress shape check. LOCAL helper, no server call, no browser, no WP-CLI execution.

```bash
miles wordpress-detect --json [--path <dir>] [--wp-cli <path>]
```

## JSON

```json
{
  "ok": true,
  "localWordPress": {
    "found": true,
    "detectionMode": "passive",
    "root": "/path/to/site",
    "wpCli": { "path": "/usr/local/bin/wp", "available": true, "error": null },
    "site": {
      "url": null,
      "name": null,
      "adminEmail": null,
      "wordpressVersion": null,
      "environment": null,
      "dashboardUrl": null
    },
    "plugin": {
      "installed": false,
      "active": false,
      "version": null,
      "source": "/path/to/miles-plugin",
      "sourceVersion": "0.0.0"
    },
    "next": [
      "Ask the user whether to use Miles cloud, this local WordPress install, or a remote WordPress site."
    ]
  }
}
```

`found: false` means continue with Miles cloud (`site-create`) unless the user explicitly points you at another WordPress path.

The `site` fields intentionally remain `null` during passive detection, including `wordpressVersion`. `wordpress-setup --use local` is the consent boundary that runs WP-CLI, reports the detected version, and checks it against the plugin requirement before installation.

## Rules

- Treat this as passive only: no PHP, WP-CLI, plugin, theme, or database execution.
- Do not choose local WordPress just because it was detected. Ask the user to choose Miles cloud, the detected local install, or a remote WordPress site.
- For remote WordPress domains, do not use filesystem setup. Ask the user to install the Miles plugin manually and use the plugin pairing flow.

## Exit Codes

`0` detection completed, including `found: false`. `1` unexpected CLI/runtime failure.
