# Miles Installer Security Summary

This is the canonical summary for agents and humans inspecting the Miles install flow.

## Recommended Command

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh
```

Agents must explain the side effects and ask approval before running this command.

## What It Downloads

The installer reads:

```text
https://start.bymiles.ai/version.json
```

The manifest names the Miles source archive, optional `sourceSha256`, bundled CLI runtime assets, and payload manifest. Released versions use immutable GitHub Release assets such as:

```text
https://github.com/bymilesai/skills/releases/download/skill-v2026.05.29.5/miles-skill-2026.05.29.5.tar.gz
```

When `sourceSha256` is present, the installer verifies the downloaded archive before extracting it. Development manifests may temporarily use `sourceSha256: null`, but production releases should publish a checksum before users are asked to update.

On supported platforms, the installer also downloads a Bun-compiled Miles CLI runtime from the same release and verifies that binary with its published SHA-256 before placing it at:

```text
~/.miles/bin/miles-runtime
```

If no verified binary is available, the launcher falls back to the auditable JavaScript CLI source and requires Node.js 20+.

The payload manifest is versioned with the release. During local development and pre-release inspection it may also be served from:

```text
https://start.bymiles.ai/payload-manifest.json
```

Dry runs show the payload root, file count, total bytes, and included files before writing anything.
Dry runs perform read-only GETs for the install and payload manifests unless a local source override is provided. If those fetches fail, the dry run still prints the local plan and says the payload could not be inspected.

## What It Writes

The installer copies the `miles/` skill into selected local agent skill directories. Default install targets:

```text
~/.agents/skills/miles/
~/.claude/skills/miles/
```

The shared `~/.agents/skills` path covers universal agents such as Codex, Cursor, and OpenCode. Claude Code uses `~/.claude/skills`.

It also creates:

```text
~/.miles/bin/miles
~/.miles/bin/miles-runtime
~/.miles/bin/miles-skill
~/.miles/install/receipt.json
```

The `miles-skill` helper supports status, gated update checks, updates, and uninstall.

## What It Does Not Do

The installer does not use `sudo`, `npx`, `eval`, base64-encoded payloads, shell profile edits, background daemons, launch agents, or browser automation.

It does not remove local Miles login state during normal uninstall. `~/.miles/credentials.json` is removed only when the user explicitly requests purge mode.

## Inspect Before Install

```bash
curl -fsSL https://start.bymiles.ai/install.sh -o /tmp/miles-install.sh
sh /tmp/miles-install.sh --dry-run
sh /tmp/miles-install.sh --dry-run --json
```

## Update And Uninstall

Agents should not send users back to `start.bymiles.ai` for lifecycle commands.

```bash
~/.miles/bin/miles-skill check-update --json
~/.miles/bin/miles-skill update
~/.miles/bin/miles-skill uninstall
```

Ask approval before running update or uninstall.
