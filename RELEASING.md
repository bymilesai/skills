# Releasing Skill Updates

Maintainer documentation. If you just want to install or use Miles, see [README.md](README.md).

Skill updates ship as versioned releases, not moving branch archives:

1. Run the release script from a clean `trunk` checkout.
2. The script bumps `version.json`, `install.sh`, and `payload-manifest.json`.
3. The script opens and merges a release PR, then pushes a `skill-v<version>` tag.
4. GitHub Actions packages an immutable `miles-skill-<version>.tar.gz` release asset plus Bun-compiled CLI binaries, computes SHA-256 values, and writes those checksums back to `trunk`'s `version.json`.
5. Installed helpers compare their receipt version with `https://start.bymiles.ai/version.json` and prompt users when a newer release is available.

Default patch release:

```bash
node scripts/release-skill.mjs patch
```

Urgent release that keeps prompting users until they update:

```bash
node scripts/release-skill.mjs --urgent patch
```

Preview the next version without changing files:

```bash
node scripts/release-skill.mjs --dry-run patch
```

## Development

When files under `miles/` change during normal development, regenerate the payload manifest before testing:

```bash
node scripts/generate-payload-manifest.mjs
```

For an isolated clean-machine test of the bundled CLI, point `MILES_HOME` at a scratch directory:

```bash
export MILES_HOME=/tmp/miles-skill-smoke
export MILES_CLI=/path/to/installed/miles/scripts/miles
"$MILES_CLI" doctor --json
```

See [miles/smoke-checklist.md](miles/smoke-checklist.md) for clean-environment validation.
