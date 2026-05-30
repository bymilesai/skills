# Install Miles for Coding Agents

Miles installs into a coding agent as an Agent Skill. If the user says something like:

> Install Miles from start.bymiles.ai

follow this procedure. Do not ask the user which agent they are using; decide from your own runtime when possible.

## 1. Read the setup URL

Fetch `https://start.bymiles.ai` as Markdown or plain text. Do not open the page in a browser unless the user explicitly asks, text fetching fails and browser inspection is the only available fallback, or Miles is already installed and the user is doing login, dashboard, preview, or design-review work.

The URL should serve the same instructions as [start.bymiles.ai.md](start.bymiles.ai.md), with clean Markdown for agents.

If you are Codex and network access is blocked, tell the user that Codex needs network enabled once before it can fetch the setup page or installer. Then stop and wait for the user to enable network or provide the file contents.

## 2. Pick the install path

Use the native agent installer only when it is available in your runtime and can install this repo directly. Otherwise use the universal bootstrap.

### Path A: native skill or plugin installer

If your host agent has a native plugin or skill installer that can install `bymilesai/skills`, prefer that path. Explain the exact command or slash command before running it, and ask for approval when your host requires approval.

After native install, continue in the current chat if your host discovers new skills live. If the skill is not visible, start a new chat or use the host's lightweight reload command.

### Path B: universal bootstrap

For Codex, Cursor, OpenCode, Claude Code without a native plugin path, and other agents that support `SKILL.md`, summarize the side effects and propose this command:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh
```

If the user or host prefers inspect-first installation, use:

```bash
curl -fsSL https://start.bymiles.ai/install.sh -o /tmp/miles-install.sh
sh /tmp/miles-install.sh
```

To inspect planned actions without writing files:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run
```

The dry run prints the source archive, checksum status, destination directories, launcher paths, Node.js status, and payload file list. It writes no files.
It performs read-only GETs for the install and payload manifests unless a local source override is provided. If those fetches fail, it still prints the local plan and says the payload could not be inspected.

To get a machine-readable plan:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run --json
```

To install only for a specific host:

```bash
curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --agent codex
```

Supported explicit agents are `codex`, `claude`, `cursor`, `opencode`, and `shared`. The default `all` mode installs into the shared universal skill directory plus Claude Code's dedicated skill directory. `codex`, `cursor`, and `opencode` target the universal `~/.agents/skills` path.

The installer reads `https://start.bymiles.ai/version.json`, downloads the Miles skill source archive named by that manifest, verifies the archive SHA-256 when the manifest publishes `sourceSha256`, copies the `miles/` skill into the shared universal and Claude Code global skill directories, and creates a convenience launcher at `~/.miles/bin/miles`. The runtime requires Node.js 20+. It does not use `sudo`, `npx`, `eval`, base64 payloads, or browser automation.

Use this canonical summary for security explanations instead of inventing one from scratch:

```text
https://start.bymiles.ai/install-security.md
```

It also creates a local lifecycle helper:

```bash
~/.miles/bin/miles-skill
```

That helper supports:

```bash
~/.miles/bin/miles-skill status --json
~/.miles/bin/miles-skill check-update --json
~/.miles/bin/miles-skill update
~/.miles/bin/miles-skill uninstall
```

Default destinations:

```text
~/.agents/skills/miles/
~/.claude/skills/miles/
```

The shared `~/.agents/skills` path covers universal agents such as Codex, Cursor, OpenCode, Amp, Cline, GitHub Copilot, Gemini CLI, Warp, and Zed. Claude Code uses `~/.claude/skills`.

Ask for approval before running any installer.

Suggested approval prompt:

```text
Miles recommends this install command:

curl -fsSL https://start.bymiles.ai/install.sh | sh

It will download the Miles skill from GitHub, install it into local agent skill directories such as ~/.agents/skills/miles, and create ~/.miles/bin/miles.

Do you want me to run it?
```

## 3. Activate

Tell the user they can try Miles now. Codex and Claude Code commonly pick up new or updated skills without a restart. For OpenCode, try the current session first. For Cursor, try the current session first; if the skill is not visible, start a new chat or use `Developer: Reload Window` before trying a full restart.

Suggested wording:

> Miles is installed. What site should we design? Tell me the business or project, the style you want, the main visitor goal, and any existing WordPress URL. For example: "Use Miles to design a warm, modern website for my yoga studio in Portland that helps visitors book intro classes." If this agent does not see the new skill, start a new chat or reload the agent window.

## 4. First use

After install, use the Miles skill when the user asks to design, build, redesign, edit, or export a WordPress website with Miles.

First run the gated update check:

```bash
~/.miles/bin/miles-skill check-update --json
```

The update check is locally cached for 24 hours. If it returns `"shouldPrompt": true`, tell the user an update is available, summarize that it updates the local Miles skill files and launcher, and ask approval before running. Urgent updates may keep returning `"shouldPrompt": true` from the cached result until the user updates.

```bash
~/.miles/bin/miles-skill update
```

If the user approves the update, continue with Miles. If the host does not see the updated skill, start a new chat or reload the agent window. If they decline, continue with the current installed skill and do not ask again in the same turn.

Run:

```bash
~/.miles/bin/miles doctor --json
~/.miles/bin/miles whoami
```

If unauthenticated, run:

```bash
~/.miles/bin/miles login --json
```

Show the returned `userCode` and complete `verificationUrl` to the user. The page should show the same code; if it matches, the user can click Authorize. The CLI stores a private pending-login receipt locally; immediately run `~/.miles/bin/miles login --poll --json` to listen while the user authorizes, then continue when it returns `authorized`.

## 5. What to tell the user

Keep it short and concrete:

```text
Miles is installed. What site should we design? Tell me the business or project, the style you want, the main visitor goal, and any existing WordPress URL. On first use I may ask you to log in at bymiles.ai.
```

## 6. Uninstall

If the user says "Uninstall Miles" or "Remove Miles from this agent", do not send them back to `start.bymiles.ai`. Prefer the host agent's native skill/plugin UI when Miles was installed that way. Otherwise inspect the local uninstall plan:

```bash
~/.miles/bin/miles-skill uninstall --dry-run --json
```

Summarize the directories and launchers that will be removed, then ask approval before running:

```bash
~/.miles/bin/miles-skill uninstall
```

Do not delete `~/.miles/credentials.json` unless the user explicitly wants to remove local Miles login state. If the user asks to remove all Miles local data, use:

```bash
~/.miles/bin/miles-skill uninstall --purge
```

## 7. Update

If the user says "Update Miles" or "Check Miles for updates", use the local lifecycle helper rather than asking them to reference the setup URL:

```bash
~/.miles/bin/miles-skill check-update --json --force
```

If an update is available, ask approval before running:

```bash
~/.miles/bin/miles-skill update
```

After update, continue with Miles. If the host does not see the updated skill, start a new chat or reload the agent window.
