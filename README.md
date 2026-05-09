# Miles (bymiles.ai) Agent Skill

Design and build beautiful WordPress websites with [Miles](https://bymiles.ai). This skill allows coding agents such as Codex, Claude Code, OpenCode, Cursor, and similar tools to create professional WordPress websites — from initial brief through design direction selection to a fully built WordPress site.

Miles provides instant cloud sandboxes for WordPress so you can build and experiment with WordPress immediately. When you're ready you can export to a local environment or push to a host.

## What it does

Miles can conduct a design interview, generates a strategic website brief, create multiple design directions for review. You or your agent can decide which design to build and continue to iterate on the design and structure.

## Install

```bash
npx skills add bymilesai/skills
```

To validate a specific branch or tag before it becomes the default install:

```bash
npx skills add bymilesai/skills#branch-or-tag --skill miles
```

Or manually place the `miles/` directory in your agent's documented skills folder:

```
~/.codex/skills/miles/
~/.claude/skills/miles/
<agent-skills-dir>/miles/
```

## Requirements

- Node.js 20+
- A Miles AI account — sign up at [bymiles.ai](https://bymiles.ai)

## Usage

Once installed, just ask your AI agent to build a website with Miles:

> "Ask Miles to build a website for my yoga studio in Portland"

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
