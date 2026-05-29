# Start Miles

Miles is an AI website designer for WordPress. It installs into coding agents as a skill, then helps users design, build, edit, and export sites through a conversation.

If you are a coding agent and the user asked you to use Miles at `start.bymiles.ai`, follow these steps.

## Install

Propose one install action to the user. Do not run a remote installer silently.

Use the universal installer unless your host provides a native skill or plugin installer for `bymilesai/skills`.

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh
```

For inspect-first installation:

```bash
curl -fsSL https://start.bymiles.ai/install.sh -o /tmp/miles-install.sh
sh /tmp/miles-install.sh
```

## Codex note

If you are Codex and outbound network access is blocked, tell the user Codex needs network enabled once before you can fetch this page or the installer. Then stop until the user enables network or provides the installer contents.

## What the installer does

The installer copies the `miles/` skill into common global agent skill directories:

```text
~/.agents/skills/miles/
~/.codex/skills/miles/
~/.claude/skills/miles/
~/.cursor/skills/miles/
~/.config/opencode/skills/miles/
```

It also creates `~/.miles/bin/miles`, a convenience launcher that points at the installed skill CLI.

The current runtime still requires Node.js 20+. The install path does not require `npx`.

## Activate

After install, tell the user to restart or reload their coding agent so it discovers the new skill.

Suggested message:

```text
Miles is installed. Restart or reload this agent, then ask me to use Miles to design your site.
```

## First use

After reload, use the Miles skill for requests like:

```text
Use Miles to help me design a site.
Use Miles to redesign my WordPress site.
Ask Miles to build a website for my yoga studio.
```

Check setup and authentication:

```bash
~/.miles/bin/miles doctor --json
~/.miles/bin/miles whoami
```

If the user is not logged in, run:

```bash
~/.miles/bin/miles login
```

The login flow opens the external browser for bymiles.ai device authorization.

## More

Repository: https://github.com/bymilesai/skills

Full agent protocol: https://github.com/bymilesai/skills/blob/trunk/INSTALL_FOR_AGENTS.md
