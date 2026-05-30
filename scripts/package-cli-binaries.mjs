#!/usr/bin/env node

import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'bymilesai/skills';

const targets = [
  { key: 'darwin-arm64', bunTarget: 'bun-darwin-arm64' },
  { key: 'darwin-x64', bunTarget: 'bun-darwin-x64' },
  { key: 'linux-arm64', bunTarget: 'bun-linux-arm64' },
  { key: 'linux-x64', bunTarget: 'bun-linux-x64-baseline' },
  { key: 'windows-x64', bunTarget: 'bun-windows-x64-baseline', extension: '.exe' },
];

function parseArgs(argv) {
  const args = {
    version: null,
    outputDir: join(repoRoot, 'build', 'cli-binaries'),
    json: false,
    check: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') {
      args.version = argv[++index];
    } else if (arg === '--output-dir') {
      args.outputDir = resolve(argv[++index]);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--check') {
      args.check = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/package-cli-binaries.mjs [--version <version>] [--output-dir <dir>] [--json] [--check]

Builds Bun-compiled Miles CLI executables for release assets. --check only
validates version.json binary URLs and does not require Bun.`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function releaseAssetBase(version) {
  return `https://github.com/${repo}/releases/download/skill-v${version}`;
}

function assetName(version, target) {
  return `miles-cli-${version}-${target.key}${target.extension || ''}`;
}

function expectedBinaryMap(version, includeSha = false, built = []) {
  const builtByKey = new Map(built.map((entry) => [entry.key, entry]));
  return Object.fromEntries(
    targets.map((target) => {
      const builtEntry = builtByKey.get(target.key);
      return [
        target.key,
        {
          url: `${releaseAssetBase(version)}/${assetName(version, target)}`,
          sha256: includeSha ? builtEntry?.sha256 || null : null,
        },
      ];
    }),
  );
}

function assertManifestBinaryMap(version) {
  const manifest = readJson(join(repoRoot, 'version.json'));
  const expected = expectedBinaryMap(version);
  const actual = manifest.cliBinaries || {};

  for (const [key, entry] of Object.entries(expected)) {
    if (actual[key]?.url !== entry.url) {
      throw new Error(`version.json cliBinaries.${key}.url is not ${entry.url}`);
    }
    if (actual[key]?.sha256 !== null) {
      throw new Error(`version.json cliBinaries.${key}.sha256 must be null before release packaging`);
    }
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function buildBinary(version, outputDir, target) {
  const name = assetName(version, target);
  const output = join(outputDir, name);
  run(process.env.BUN_BIN || 'bun', [
    'build',
    'miles/scripts/miles-cli.mjs',
    '--compile',
    `--target=${target.bunTarget}`,
    '--outfile',
    output,
  ]);
  chmodSync(output, 0o755);
  return {
    key: target.key,
    target: target.bunTarget,
    name,
    path: output,
    sha256: sha256File(output),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readJson(join(repoRoot, 'version.json'));
  const version = args.version || manifest.version;

  if (!version || manifest.version !== version) {
    throw new Error(
      `version.json version (${manifest.version || 'missing'}) does not match release version (${version || 'missing'})`,
    );
  }

  assertManifestBinaryMap(version);

  if (args.check) {
    if (args.json) {
      console.log(JSON.stringify({ version, targets, cliBinaries: expectedBinaryMap(version) }, null, 2));
    } else {
      console.log('CLI binary release map is valid.');
    }
    return;
  }

  mkdirSync(args.outputDir, { recursive: true });
  const binaries = targets.map((target) => buildBinary(version, args.outputDir, target));

  for (const binary of binaries) {
    if (!existsSync(binary.path)) {
      throw new Error(`Expected binary was not created: ${binary.path}`);
    }
  }

  const result = {
    version,
    binaries,
    cliBinaries: expectedBinaryMap(version, true, binaries),
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Packaged Miles CLI binaries ${version}`);
    for (const binary of binaries) {
      console.log(`${binary.key}: ${binary.path}`);
      console.log(`  SHA-256: ${binary.sha256}`);
    }
  }
}

main();
