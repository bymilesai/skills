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

The manifest names the Miles source archive, optional `sourceSha256`, and payload manifest. When `sourceSha256` is present, the installer verifies the downloaded archive before extracting it.

The payload manifest is:

```text
https://start.bymiles.ai/payload-manifest.json
```

Dry runs show the payload root, file count, total bytes, and included files before writing anything.

## What It Writes

The installer copies the `miles/` skill into selected local agent skill directories. Default universal install targets:

```text
~/.agents/skills/miles/
~/.codex/skills/miles/
~/.claude/skills/miles/
~/.cursor/skills/miles/
~/.config/opencode/skills/miles/
```

It also creates:

```text
~/.miles/bin/miles
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
