#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import readline from 'readline';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'bymilesai/skills';

function parseArgs(argv) {
  const args = {
    bump: 'patch',
    yes: process.env.MILES_RELEASE_YES === '1',
    urgent: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--yes' || arg === '-y') {
      args.yes = true;
    } else if (arg === '--urgent') {
      args.urgent = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      args.bump = arg;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/release-skill.mjs [--yes|-y] [--urgent] [--dry-run] [patch|YYYY.MM.DD.N]

Creates a versioned Miles skill release:
  1. Bumps version.json, install.sh, and payload-manifest.json
  2. Opens and merges a release PR into trunk
  3. Tags the trunk commit as skill-v<version>
  4. The release-skill GitHub Action publishes immutable source and CLI assets
     and writes sourceSha256 plus binary checksums back to trunk's version.json`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed${options.capture ? `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` : ''}`,
    );
  }

  return result.stdout?.trim() || '';
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function gitOutput(args) {
  return run('git', args, { capture: true });
}

function assertCleanTrunk() {
  const branch = gitOutput(['branch', '--show-current']);
  if (branch !== 'trunk') {
    throw new Error(`Run this from trunk. Current branch is ${branch || '(detached)'}.`);
  }

  const status = gitOutput(['status', '--porcelain']);
  if (status) {
    throw new Error(`Working tree is not clean:\n${status}`);
  }
}

function todayVersionBase() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}.${month}.${day}`;
}

function nextVersion(currentVersion, bump) {
  if (/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(bump)) return bump;
  if (bump !== 'patch') {
    throw new Error('Skill releases support patch or an explicit YYYY.MM.DD.N version.');
  }

  const base = todayVersionBase();
  const match = currentVersion.match(/^(\d{4}\.\d{2}\.\d{2})\.(\d+)$/);
  if (match && match[1] === base) {
    return `${base}.${Number(match[2]) + 1}`;
  }
  return `${base}.1`;
}

function releaseAssetBase(version) {
  return `https://github.com/${repo}/releases/download/skill-v${version}`;
}

function cliBinaryMap(version) {
  const assetBase = releaseAssetBase(version);
  return {
    'darwin-arm64': {
      url: `${assetBase}/miles-cli-${version}-darwin-arm64`,
      sha256: null,
    },
    'darwin-x64': {
      url: `${assetBase}/miles-cli-${version}-darwin-x64`,
      sha256: null,
    },
    'linux-arm64': {
      url: `${assetBase}/miles-cli-${version}-linux-arm64`,
      sha256: null,
    },
    'linux-x64': {
      url: `${assetBase}/miles-cli-${version}-linux-x64`,
      sha256: null,
    },
    'windows-x64': {
      url: `${assetBase}/miles-cli-${version}-windows-x64.exe`,
      sha256: null,
    },
  };
}

function updateReleaseFiles(version, urgent) {
  const versionPath = join(repoRoot, 'version.json');
  const installPath = join(repoRoot, 'install.sh');
  const manifest = readJson(versionPath);
  const assetBase = releaseAssetBase(version);

  manifest.version = version;
  manifest.channel = 'stable';
  manifest.source = `${assetBase}/miles-skill-${version}.tar.gz`;
  manifest.sourceSha256 = null;
  manifest.cliBinaries = cliBinaryMap(version);
  manifest.payloadManifest = `${assetBase}/payload-manifest-${version}.json`;
  manifest.urgent = urgent;
  writeJson(versionPath, manifest);

  const installer = readFileSync(installPath, 'utf8');
  const updatedInstaller = installer.replace(
    /^INSTALLER_VERSION=.+$/m,
    `INSTALLER_VERSION=${version}`,
  );
  if (updatedInstaller === installer) {
    throw new Error('Could not update INSTALLER_VERSION in install.sh');
  }
  writeFileSync(installPath, updatedInstaller);

  run(process.execPath, ['scripts/generate-payload-manifest.mjs']);
}

function runValidation() {
  run(process.execPath, ['--check', 'miles/scripts/miles-cli.mjs']);
  run(process.execPath, ['--check', 'miles/scripts/test-miles-cli.mjs']);
  run(process.execPath, ['--check', 'scripts/package-cli-binaries.mjs']);
  run(process.execPath, ['scripts/generate-payload-manifest.mjs', '--check']);
  run(process.execPath, ['scripts/package-cli-binaries.mjs', '--check']);
  run(process.execPath, ['test-install-lifecycle.mjs']);
  run(process.execPath, ['miles/scripts/test-miles-cli.mjs']);
  run(process.execPath, ['scripts/package-skill-release.mjs', '--json']);
}

function confirmRelease(version, tagName, urgent, yes) {
  console.log(`New version: ${version}`);
  console.log(`Git tag:     ${tagName}`);
  console.log(`Urgent:      ${urgent ? 'yes' : 'no'}`);
  console.log('Will touch:  release branch, trunk PR, GitHub tag, GitHub release assets');
  console.log('Will not:    publish moving trunk archives as install/update source');
  console.log('');

  if (yes) {
    console.log('--yes set, skipping confirmation prompt.');
    return Promise.resolve(true);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Proceed with skill release? (y/N) ', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readJson(join(repoRoot, 'version.json'));
  const version = nextVersion(manifest.version, args.bump);
  const tagName = `skill-v${version}`;
  const releaseBranch = `release/${tagName}`;

  assertCleanTrunk();
  run('git', ['fetch', 'origin', 'trunk', '--tags']);

  try {
    gitOutput(['rev-parse', '--verify', `refs/tags/${tagName}`]);
    throw new Error(`Tag ${tagName} already exists.`);
  } catch (error) {
    if (!String(error.message).includes('rev-parse --verify')) throw error;
  }

  if (args.dryRun) {
    await confirmRelease(version, tagName, args.urgent, true);
    console.log('Dry run only; no files changed.');
    return;
  }

  const confirmed = await confirmRelease(version, tagName, args.urgent, args.yes);
  if (!confirmed) {
    console.log('Aborted.');
    return;
  }

  run('git', ['switch', '-c', releaseBranch]);
  updateReleaseFiles(version, args.urgent);
  runValidation();

  run('git', ['add', 'version.json', 'payload-manifest.json', 'install.sh']);
  run('git', ['commit', '-m', `Release skill ${version}`]);
  run('git', ['push', '-u', 'origin', releaseBranch]);

  const prUrl = run(
    'gh',
    [
      'pr',
      'create',
      '--base',
      'trunk',
      '--repo',
      repo,
      '--title',
      `Release skill ${version}`,
      '--body',
      `Versioned Miles skill release ${version}.`,
    ],
    { capture: true },
  );
  console.log(`PR created: ${prUrl}`);

  run('gh', ['pr', 'merge', prUrl, '--repo', repo, '--squash', '--delete-branch']);

  run('git', ['switch', 'trunk']);
  run('git', ['pull', '--ff-only', 'origin', 'trunk']);
  run('git', ['tag', tagName]);
  run('git', ['push', 'origin', tagName]);

  console.log(`Skill release tag pushed: ${tagName}`);
  console.log('GitHub Actions will publish immutable release assets and update source/binary checksums.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
