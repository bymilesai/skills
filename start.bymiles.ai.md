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

The installer downloads the Miles skill from `bymilesai/skills` and copies the `miles/` skill into these common agent skill directories:

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
```

The installer writes an install receipt at `~/.miles/install/receipt.json`. The runtime requires Node.js 20+. The install path does not require `npx`, and the installer does not open a browser.

## Approval Prompt

Agents should ask something like:

```text
Miles recommends this install command:

curl -fsSL https://start.bymiles.ai/install.sh | sh

It will download the Miles skill from GitHub, install it into local agent skill directories such as ~/.codex/skills/miles, and create ~/.miles/bin/miles.

Do you want me to run it?
```

## After Install

Tell the user:

```text
Miles is installed. Restart or reload this agent, then ask: "Use Miles to design my website."
```

## First use

After reload, use the Miles skill for requests like:

```text
Use Miles to design my website.
Use Miles to redesign my WordPress site.
Ask Miles to build a website for my yoga studio.
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
~/.miles/bin/miles login
```

The login flow opens the external browser for bymiles.ai device authorization.

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
