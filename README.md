# Miles (bymiles.ai) Agent Skill

Design and build beautiful WordPress websites with [Miles](https://bymiles.ai). This skill allows coding agents such as Codex, Claude Code, OpenCode, Cursor, and similar tools to create professional WordPress websites — from initial brief through design direction selection to a fully built WordPress site.

Miles provides instant cloud sandboxes for WordPress so you can build and experiment with WordPress immediately. When you're ready you can export to a local environment or push to a host.

## What it does

Miles can conduct a design interview, generates a strategic website brief, create multiple design directions for review. You or your agent can decide which design to build and continue to iterate on the design and structure.

## Install

The easiest path is to ask your coding agent to install Miles from the public setup URL:

> "Use Miles at start.bymiles.ai to help me design a site."

Your agent should read the instructions at `https://start.bymiles.ai`, propose one install command, ask for your approval, then tell you to restart or reload the agent so the skill is discovered.

The universal install command is:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh
```

For an inspect-first install:

```bash
curl -fsSL https://start.bymiles.ai/install.sh -o /tmp/miles-install.sh
sh /tmp/miles-install.sh
```

This installs the `miles/` skill into common agent skill directories such as:

```
~/.agents/skills/miles/
~/.codex/skills/miles/
~/.claude/skills/miles/
~/.cursor/skills/miles/
~/.config/opencode/skills/miles/
```

After install, restart or reload your coding agent and ask for Miles again.

If you already use the Vercel skills CLI, this still works:

```bash
npx skills add bymilesai/skills
```

To validate a specific branch or tag with the skills CLI before it becomes the default install:

```bash
npx skills add bymilesai/skills#branch-or-tag --skill miles
```

See [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) for the agent-facing install protocol and [start.bymiles.ai.md](start.bymiles.ai.md) for the content intended to be served at `https://start.bymiles.ai`.

## Requirements

- Node.js 20+
- A Miles AI account — sign up at [bymiles.ai](https://bymiles.ai)

The current skill ships a zero-dependency Node CLI. The installer removes `npx` from the primary install path, but the runtime still needs Node 20+ until prebuilt binaries are published.

## Usage

Once installed, just ask your AI agent to build a website with Miles:

> "Use Miles to design a website for my yoga studio in Portland."

The skill handles authentication, the design conversation with Miles, and the full build process. Your agent will relay Miles' questions to you and present design options for your approval. You can continue to make changes to your WordPress site with Miles.

The bundled CLI lives at `miles/scripts/miles`. Use `doctor --json` to check the local setup. Set `MILES_HOME` when you want an isolated clean-machine test:

```bash
export MILES_HOME=/tmp/miles-skill-smoke
export MILES_CLI=/path/to/installed/miles/scripts/miles
"$MILES_CLI" doctor --json
```

The workflow looks like:

1. **Authentication** — `miles login` opens a browser for device auth
2. **Create site** — `miles create-site "description"` starts a conversation with Miles
3. **Discovery** — Miles asks questions, your agent relays them to you, sends your answers back
4. **Brief review** — Miles presents a design brief for your approval
5. **Design directions** — Miles generates multiple design directions with preview URLs
6. **Build** — You pick a direction, Miles builds the full site in both HTML and as a WordPress block theme
7. **Export** — Download as static HTML site or export a full WordPress sandbox instance you can drop into Local or WP Studio
8. **Edit** - Continue to make direct edits to your WordPress using Miles and the cloud sandbox it provides

See [commands.md](miles/commands.md) for the full command reference, [examples.md](miles/examples.md) for workflow examples, and [smoke-checklist.md](miles/smoke-checklist.md) for clean-environment validation.
