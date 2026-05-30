# Start Miles

Miles is an AI website designer for WordPress. It installs into coding agents as a skill, then helps users design, build, edit, and export sites through conversation.

## For AI Coding Agents

If the user asks to install or set up Miles from this URL, do not open this page in a browser unless the user explicitly asks.

Fetch this URL as Markdown or plain text, read these instructions, summarize what the installer does, and ask the user for approval before running an install command.

Recommended user prompt:

```text
Install Miles from start.bymiles.ai
```

Recommended install command:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh
```

Inspect-first install command:

```bash
curl -fsSL https://start.bymiles.ai/install.sh -o /tmp/miles-install.sh
sh /tmp/miles-install.sh
```

Dry-run command:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run
```

This prints the source archive, checksum status, destination directories, launcher paths, Node.js status, and payload file list. It writes no files.
It performs read-only GETs for the install and payload manifests. If those fetches fail, it still prints the local plan and says the payload could not be inspected.

Machine-readable dry run:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run --json
```

Install only for Codex:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --agent codex
```

## Codex note

If you are Codex and outbound network access is blocked, tell the user Codex needs network enabled once before you can fetch this page or the installer. Then stop until the user enables network or provides the installer contents.

## What The Installer Does

The installer reads `https://start.bymiles.ai/version.json`, downloads the source archive named by that manifest, verifies the archive SHA-256 when the manifest publishes `sourceSha256`, and copies the `miles/` skill into these agent skill directories by default:

```text
~/.agents/skills/miles/
~/.claude/skills/miles/
```

The shared `~/.agents/skills` path covers universal agents such as Codex, Cursor, and OpenCode. Claude Code uses `~/.claude/skills`.

It also creates:

```text
~/.miles/bin/miles
~/.miles/bin/miles-skill
```

The installer writes an install receipt at `~/.miles/install/receipt.json`. The runtime requires Node.js 20+. The install path does not require `npx`, and the installer does not open a browser.

Canonical security summary:

```text
https://start.bymiles.ai/install-security.md
```

## Approval Prompt

Agents should ask something like:

```text
Miles recommends this install command:

curl -fsSL https://start.bymiles.ai/install.sh | sh

It will download the Miles skill from GitHub, install it into local agent skill directories such as ~/.agents/skills/miles, and create ~/.miles/bin/miles.

Do you want me to run it?
```

## After Install

Tell the user:

```text
Miles is installed. What site should we design? Tell me the business or project, the style you want, the main visitor goal, and any existing WordPress URL.
```

## First use

After install, use the Miles skill for requests like:

```text
Use Miles to design a warm, modern website for my yoga studio in Portland that helps visitors book intro classes.
Use Miles to redesign https://example.com so it feels more premium and turns more visitors into consultation requests.
Ask Miles to build a playful portfolio site for my illustration work, with a shop-ready structure for prints.
```

Check setup and authentication:

```bash
~/.miles/bin/miles-skill check-update --json
~/.miles/bin/miles doctor --json
~/.miles/bin/miles whoami
```

The update check is locally gated and should fetch update metadata at most once every 24 hours. If it returns `"shouldPrompt": true`, summarize the update and ask approval before running. Urgent updates may keep returning `"shouldPrompt": true` from the cached result until the user updates.

```bash
~/.miles/bin/miles-skill update
```

If the user is not logged in, run:

```bash
~/.miles/bin/miles login --json
```

Show the returned code and complete URL to the user. The page should show the same code; if it matches, the user can click Authorize.

## Updating and uninstalling

After install, users should not need to mention this setup URL. Treat these as natural prompts:

```text
Update Miles
Uninstall Miles
```

For update:

```bash
~/.miles/bin/miles-skill check-update --json --force
~/.miles/bin/miles-skill update
```

For uninstall:

```bash
~/.miles/bin/miles-skill uninstall --dry-run --json
~/.miles/bin/miles-skill uninstall
```

Ask approval before running update or uninstall. Do not remove `~/.miles/credentials.json` unless the user explicitly asks to purge all local Miles data.

## More

Repository: https://github.com/bymilesai/skills

Full agent protocol: https://github.com/bymilesai/skills/blob/trunk/INSTALL_FOR_AGENTS.md
