# Miles AI – Agent Skill

Design complete websites through conversation with [Miles AI](https://bymiles.ai). This skill lets AI coding agents (Claude Code, Cursor, etc.) create professional websites — from initial brief through design direction selection to a fully built site.

## What it does

Miles conducts a design interview, generates a strategic brief, creates multiple design directions for review, then builds a complete static HTML website. Optionally converts it to a WordPress block theme.

## Install

```bash
npx skills add bymilesai/skills
```

Or manually place the `miles/` directory in your Claude Code skills folder:

```
~/.claude/skills/miles/    # personal (all projects)
.claude/skills/miles/      # project-specific
```

## Requirements

- Node.js 20+
- A Miles AI account — sign up at [bymiles.ai](https://bymiles.ai)

## Usage

Once installed, just ask your AI agent to build a website:

> "Build a website for my yoga studio in Portland"

The skill handles authentication, the design conversation with Miles, and the full build process. Your agent will relay Miles' questions to you and present design options for your approval.

## How it works

The skill bundles a lightweight CLI client (`miles/scripts/miles-cli.mjs`) that communicates with the Miles API over REST and WebSocket. When your agent runs a Miles command, a PostToolUse hook automatically captures Miles' response and delivers it as structured context — including questions, options, design direction previews, and build progress.

The workflow looks like:

1. **Authentication** — `miles login` opens a browser for device auth
2. **Create site** — `miles create-site "description"` starts a conversation with Miles
3. **Discovery** — Miles asks questions, your agent relays them to you, sends your answers back
4. **Brief review** — Miles presents a design brief for your approval
5. **Design directions** — Miles generates multiple design directions with preview URLs
6. **Build** — You pick a direction, Miles builds the full site
7. **Export** — Download as static HTML or convert to a WordPress block theme

See [commands.md](miles/commands.md) for the full command reference and [examples.md](miles/examples.md) for workflow examples.

## License

MIT
