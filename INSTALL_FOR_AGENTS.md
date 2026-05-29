# Install Miles for Coding Agents

Miles installs into a coding agent as an Agent Skill. If the user says something like:

> Use Miles at start.bymiles.ai to help me design a site.

follow this procedure. Do not ask the user which agent they are using; decide from your own runtime when possible.

## 1. Read the setup URL

Fetch `https://start.bymiles.ai`. It should serve the same instructions as [start.bymiles.ai.md](start.bymiles.ai.md), with clean Markdown for agents.

If you are Codex and network access is blocked, tell the user that Codex needs network enabled once before it can fetch the setup page or installer. Then stop and wait for the user to enable network or provide the file contents.

## 2. Pick the install path

Use the native agent installer only when it is available in your runtime and can install this repo directly. Otherwise use the universal bootstrap.

### Path A: native skill or plugin installer

If your host agent has a native plugin or skill installer that can install `bymilesai/skills`, prefer that path. Explain the exact command or slash command before running it, and ask for approval when your host requires approval.

After native install, restart or reload the agent so new skills are discovered.

### Path B: universal bootstrap

For Codex, Cursor, OpenCode, Claude Code without a native plugin path, and other agents that support `SKILL.md`, propose this command:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh
```

If the user or host prefers inspect-first installation, use:

```bash
curl -fsSL https://start.bymiles.ai/install.sh -o /tmp/miles-install.sh
sh /tmp/miles-install.sh
```

The installer copies the `miles/` skill into common global skill directories:

```text
~/.agents/skills/miles/
~/.codex/skills/miles/
~/.claude/skills/miles/
~/.cursor/skills/miles/
~/.config/opencode/skills/miles/
```

It also creates a convenience launcher at `~/.miles/bin/miles`.

## 3. Reload

Tell the user to restart or reload their coding agent. New skills are usually scanned at startup, so this is the reliable activation step.

Suggested wording:

> Miles is installed. Please restart or reload this agent, then ask me: "Use Miles to design a site."

## 4. First use

After reload, use the Miles skill when the user asks to design, build, redesign, edit, or export a WordPress website with Miles.

Run:

```bash
~/.miles/bin/miles doctor --json
~/.miles/bin/miles whoami
```

If unauthenticated, run:

```bash
~/.miles/bin/miles login
```

`miles login` opens the external browser for device authorization. Keep it in the external browser because in-agent browsers may not support hardware security keys or identity-provider flows.

## 5. What to tell the user

Keep it short and concrete:

```text
Miles is installed. Restart or reload this agent, then ask me to use Miles to design your site. On first use I may ask you to log in at bymiles.ai.
```

## 6. Uninstall

Delete the installed skill directories and optional launcher:

```bash
rm -rf ~/.agents/skills/miles \
  ~/.codex/skills/miles \
  ~/.claude/skills/miles \
  ~/.cursor/skills/miles \
  ~/.config/opencode/skills/miles \
  ~/.miles/bin/miles
```

Do not delete `~/.miles/credentials.json` unless the user explicitly wants to remove local Miles login state.
