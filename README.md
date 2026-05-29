# Miles (bymiles.ai) Agent Skill

Design and build beautiful WordPress websites with [Miles](https://bymiles.ai). This skill allows coding agents such as Codex, Claude Code, OpenCode, Cursor, and similar tools to create professional WordPress websites — from initial brief through design direction selection to a fully built WordPress site.

Miles provides instant cloud sandboxes for WordPress so you can build and experiment with WordPress immediately. When you're ready you can export to a local environment or push to a host.

## What it does

Miles can conduct a design interview, generates a strategic website brief, create multiple design directions for review. You or your agent can decide which design to build and continue to iterate on the design and structure.

## Install

The easiest path is to ask your coding agent to install Miles from the public setup URL:

> "Install Miles from start.bymiles.ai"

Your agent should fetch `https://start.bymiles.ai` as Markdown or plain text, propose one install command, ask for your approval, then tell you to ask for Miles. It should not open the page in a browser during install unless text fetching fails or you explicitly ask to view it.

The universal install command is:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh
```

For an inspect-first install:

```bash
curl -fsSL https://start.bymiles.ai/install.sh -o /tmp/miles-install.sh
sh /tmp/miles-install.sh
```

To preview the install without writing files:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run
```

The dry run shows the source archive, checksum status, destination directories, launcher paths, Node.js status, and payload file list.
It performs read-only GETs for the install and payload manifests unless a local source override is provided; if those fetches fail, it still prints the local plan and says the payload could not be inspected.

To install only for Codex:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --agent codex
```

This installs the `miles/` skill into common agent skill directories such as:

```
~/.agents/skills/miles/
~/.codex/skills/miles/
~/.claude/skills/miles/
~/.cursor/skills/miles/
~/.config/opencode/skills/miles/
```

It also creates `~/.miles/bin/miles-skill`, a local helper for status, update checks, updates, and uninstall. The installer reads `https://start.bymiles.ai/version.json` and verifies the source archive SHA-256 when the manifest publishes `sourceSha256`.

Security summary: [INSTALL_SECURITY.md](INSTALL_SECURITY.md)

After install, tell your agent what you want to build. A useful prompt includes the business or project, desired style, primary visitor goal, and any existing WordPress URL.

> "Use Miles to design a warm, modern website for my yoga studio in Portland that helps visitors book intro classes."

If your agent does not see the new skill, start a new chat or reload the agent window.

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

The installer also writes a lifecycle helper:

```bash
~/.miles/bin/miles-skill status --json
~/.miles/bin/miles-skill check-update --json
~/.miles/bin/miles-skill update
~/.miles/bin/miles-skill uninstall
```

Agents should run `check-update --json` when Miles is first used in a session. The check is cached for 24 hours and should only prompt the user when it returns `"shouldPrompt": true`. Urgent updates may keep returning `"shouldPrompt": true` from the cached result until the user updates. Updates and uninstall always require user approval.

When files under `miles/` change during normal development, regenerate the payload manifest before testing:

```bash
/opt/homebrew/bin/node scripts/generate-payload-manifest.mjs
```

## Releasing Skill Updates

Skill updates should ship as versioned releases, not moving branch archives. The release workflow mirrors the Miles plugin release model:

1. Run the release script from a clean `trunk` checkout.
2. The script bumps `version.json`, `install.sh`, and `payload-manifest.json`.
3. The script opens and merges a release PR, then pushes a `skill-v<version>` tag.
4. GitHub Actions packages an immutable `miles-skill-<version>.tar.gz` release asset, computes its SHA-256, and writes that checksum back to `trunk`'s `version.json`.
5. Installed helpers compare their receipt version with `https://start.bymiles.ai/version.json` and prompt users when a newer release is available.

Default patch release:

```bash
/opt/homebrew/bin/node scripts/release-skill.mjs patch
```

Urgent release that keeps prompting users until they update:

```bash
/opt/homebrew/bin/node scripts/release-skill.mjs --urgent patch
```

Preview the next version without changing files:

```bash
/opt/homebrew/bin/node scripts/release-skill.mjs --dry-run patch
```

The workflow looks like:

1. **Authentication** — agents use `miles login --request --json`, show the device code, then finish with `miles login --poll`
2. **Create site** — `miles create-site "description"` starts a conversation with Miles
3. **Discovery** — Miles asks questions, your agent relays them to you, sends your answers back
4. **Brief review** — Miles presents a design brief for your approval
5. **Design directions** — Miles generates multiple design directions with preview URLs
6. **Build** — You pick a direction, Miles builds the full site in both HTML and as a WordPress block theme
7. **Export** — Download as static HTML site or export a full WordPress sandbox instance you can drop into Local or WP Studio
8. **Edit** - Continue to make direct edits to your WordPress using Miles and the cloud sandbox it provides

See [commands.md](miles/commands.md) for the full command reference, [examples.md](miles/examples.md) for workflow examples, and [smoke-checklist.md](miles/smoke-checklist.md) for clean-environment validation.
