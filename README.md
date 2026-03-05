# Miles AI – Agent Skill

Design complete websites through conversation with [Miles AI](https://bymiles.ai). This skill lets AI coding agents (Claude Code, Cursor, etc.) create professional websites — from initial brief through design direction selection to a fully built site.

## What it does

Miles conducts a design interview, generates a strategic brief, creates multiple design directions for review, then builds a complete static HTML website. Optionally converts it to a WordPress block theme.

## Install

```bash
npx skills add bymilesai/miles-skill
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

The skill bundles a CLI client that communicates with the Miles API over WebSocket. A PostToolUse hook automatically captures Miles' responses and delivers them as context to your AI agent, enabling a seamless conversational flow.

## License

MIT
