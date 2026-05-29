#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = resolve(new URL('.', import.meta.url).pathname);
const installer = join(repoRoot, 'install.sh');
const tempRoots = [];

function makeTempDir(prefix = 'miles-install-lifecycle-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function run(args, options = {}) {
  const env = {
    ...process.env,
    HOME: options.home,
    MILES_SKILL_MANIFEST_URL: options.manifest || join(repoRoot, 'version.json'),
    MILES_UPDATE_CHECK_INTERVAL_SECONDS: options.interval || '86400',
  };

  if (options.sourceDir !== null) {
    env.MILES_INSTALL_SOURCE_DIR = options.sourceDir || repoRoot;
  }

  const result = spawnSync('sh', [installer, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: 15000,
  });

  if (options.expectStatus === undefined && result.status !== 0) {
    throw new Error(
      `Command failed: sh install.sh ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  if (options.expectStatus !== undefined && result.status !== options.expectStatus) {
    throw new Error(
      `Unexpected status ${result.status} for ${args.join(' ')}; expected ${options.expectStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result;
}

function runManager(home, args, options = {}) {
  const manager = join(home, '.miles/bin/miles-skill');
  const env = {
    ...process.env,
    HOME: home,
    MILES_SKILL_MANIFEST_URL: options.manifest || join(repoRoot, 'version.json'),
    MILES_UPDATE_CHECK_INTERVAL_SECONDS: options.interval || '86400',
  };

  if (options.sourceDir !== null) {
    env.MILES_INSTALL_SOURCE_DIR = options.sourceDir || repoRoot;
  }

  const result = spawnSync(manager, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: 15000,
  });

  if (result.status !== 0) {
    throw new Error(
      `Manager command failed: ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result;
}

function runJson(args, options = {}) {
  const result = run(args, options);
  return parseJson(result.stdout, `install.sh ${args.join(' ')}`);
}

function runManagerJson(home, args, options = {}) {
  const result = runManager(home, args, options);
  return parseJson(result.stdout, `miles-skill ${args.join(' ')}`);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON for ${label}: ${error.message}\n${text}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function writeManifest(dir, version, urgent = false) {
  const path = join(dir, `version-${version}-${urgent ? 'urgent' : 'normal'}.json`);
  writeFileSync(
    path,
    JSON.stringify({ name: 'miles', version, urgent }, null, 2),
  );
  return path;
}

function writeSourceManifest(dir, version, source, sourceSha256) {
  const path = join(dir, `source-version-${version}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        name: 'miles',
        version,
        source,
        sourceSha256,
        urgent: false,
      },
      null,
      2,
    ),
  );
  return path;
}

function createSourceArchive(dir) {
  const packageDir = join(dir, 'skills-source');
  mkdirSync(packageDir, { recursive: true });
  for (const entry of [
    'install.sh',
    'version.json',
    'payload-manifest.json',
    'INSTALL_FOR_AGENTS.md',
    'start.bymiles.ai.md',
    'miles',
  ]) {
    cpSync(join(repoRoot, entry), join(packageDir, entry), { recursive: true });
  }

  const archive = join(dir, 'skills-source.tar.gz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', dir, 'skills-source'], {
    encoding: 'utf8',
  });
  if (tar.status !== 0) {
    throw new Error(`Could not create source archive\nstdout:\n${tar.stdout}\nstderr:\n${tar.stderr}`);
  }
  return archive;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function currentPayloadFiles() {
  const files = [];

  function walk(relativeDir) {
    const absoluteDir = join(repoRoot, relativeDir);
    for (const name of readdirSync(absoluteDir).sort()) {
      const relativePath = join(relativeDir, name);
      const absolutePath = join(repoRoot, relativePath);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        walk(relativePath);
        continue;
      }
      files.push({
        path: relativePath,
        size: stats.size,
        sha256: sha256File(absolutePath),
      });
    }
  }

  walk('miles');
  return files;
}

function writeLastCheck(home, value) {
  writeFileSync(join(home, '.miles/install/last-update-check'), `${value}\n`);
}

try {
  const installerVersion = readFileSync(installer, 'utf8').match(
    /^INSTALLER_VERSION=(.+)$/m,
  )?.[1];
  const manifestVersion = JSON.parse(
    readFileSync(join(repoRoot, 'version.json'), 'utf8'),
  ).version;
  assert(
    installerVersion === manifestVersion,
    'install.sh INSTALLER_VERSION should match version.json',
  );
  const payloadManifest = JSON.parse(
    readFileSync(join(repoRoot, 'payload-manifest.json'), 'utf8'),
  );
  assert(
    payloadManifest.version === manifestVersion,
    'payload-manifest.json version should match version.json',
  );
  const actualPayloadFiles = currentPayloadFiles();
  assert(
    payloadManifest.fileCount === actualPayloadFiles.length,
    'payload-manifest.json fileCount should match miles/ contents',
  );
  assert(
    payloadManifest.totalBytes === actualPayloadFiles.reduce((sum, file) => sum + file.size, 0),
    'payload-manifest.json totalBytes should match miles/ contents',
  );
  assert(
    JSON.stringify(payloadManifest.files) === JSON.stringify(actualPayloadFiles),
    'payload-manifest.json files should match miles/ contents',
  );
  const payloadCheck = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/generate-payload-manifest.mjs'), '--check'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  assert(
    payloadCheck.status === 0,
    `payload manifest generator check should pass\nstdout:\n${payloadCheck.stdout}\nstderr:\n${payloadCheck.stderr}`,
  );

  const dryRun = run(['--dry-run'], { home: makeTempDir() });
  assert(
    dryRun.stdout.includes('Payload:') && dryRun.stdout.includes('miles/SKILL.md'),
    'dry run should show payload contents',
  );
  const dryRunJson = runJson(['--dry-run', '--json'], { home: makeTempDir() });
  assert(
    dryRunJson.payload?.files?.some((file) => file.path === 'miles/SKILL.md'),
    'JSON dry run should include payload files',
  );

  const missingHome = makeTempDir();
  const missing = runJson(['--check-update', '--json', '--force'], {
    home: missingHome,
  });
  assert(missing.ok === false, 'missing receipt check should be an error');
  assert(
    missing.updateAvailable === false && missing.shouldPrompt === false,
    'missing receipt check should not claim an update is available',
  );

  const home = makeTempDir();
  run(['--agent', 'all'], { home });

  const status = runManagerJson(home, ['status', '--json']);
  assert(status.installed === true, 'status should report installed after install');
  assert(status.destinations.length === 5, 'all-agent install should record destinations');

  const archiveDir = makeTempDir('miles-install-archive-');
  const archive = createSourceArchive(archiveDir);
  const archiveHash = sha256File(archive);
  const sourceManifest = writeSourceManifest(
    archiveDir,
    manifestVersion,
    `file://${archive}`,
    archiveHash,
  );
  const archiveHome = makeTempDir();
  run(['--agent', 'codex'], {
    home: archiveHome,
    manifest: sourceManifest,
    sourceDir: null,
  });
  assert(
    existsSync(join(archiveHome, '.codex/skills/miles/SKILL.md')),
    'install should support checksum-verified archive manifests',
  );

  const badSourceManifest = writeSourceManifest(
    archiveDir,
    '2099.03.01',
    `file://${archive}`,
    '0000000000000000000000000000000000000000000000000000000000000000',
  );
  const badArchiveHome = makeTempDir();
  const badArchive = run(['--agent', 'codex'], {
    home: badArchiveHome,
    manifest: badSourceManifest,
    sourceDir: null,
    expectStatus: 1,
  });
  assert(
    badArchive.stderr.includes('checksum mismatch'),
    'install should fail when sourceSha256 does not match',
  );

  const current = runManagerJson(home, ['check-update', '--json', '--force']);
  assert(current.updateAvailable === false, 'current manifest should not prompt');

  const newManifest = writeManifest(home, '2099.01.01');
  const fresh = runManagerJson(home, ['check-update', '--json', '--force'], {
    manifest: newManifest,
  });
  assert(fresh.updateAvailable === true, 'newer manifest should show update');
  assert(fresh.shouldPrompt === true, 'fresh newer manifest should prompt');

  const gated = runManagerJson(home, ['check-update', '--json'], {
    manifest: newManifest,
  });
  assert(gated.skipped === true, 'fresh cache should skip repeated check');
  assert(gated.shouldPrompt === false, 'non-urgent cached update should not re-prompt');

  const urgentManifest = writeManifest(home, '2099.02.01', true);
  writeLastCheck(home, 0);
  const urgentFresh = runManagerJson(home, ['check-update', '--json'], {
    manifest: urgentManifest,
  });
  assert(urgentFresh.urgent === true, 'urgent manifest should be surfaced');
  assert(urgentFresh.shouldPrompt === true, 'fresh urgent update should prompt');

  const urgentCached = runManagerJson(home, ['check-update', '--json'], {
    manifest: urgentManifest,
  });
  assert(urgentCached.skipped === true, 'urgent cached check should still use cache');
  assert(
    urgentCached.shouldPrompt === true,
    'cached urgent update should continue prompting until updated',
  );

  writeLastCheck(home, 0);
  const badManifest = join(home, 'missing-version.json');
  const failed = runManagerJson(home, ['check-update', '--json'], {
    manifest: badManifest,
  });
  assert(failed.ok === false, 'manifest fetch failure should be reported');
  assert(
    !existsSync(badManifest),
    'test setup sanity check: missing manifest should stay missing',
  );

  const afterFailure = runManagerJson(home, ['check-update', '--json'], {
    manifest: newManifest,
  });
  assert(
    afterFailure.checked === true && afterFailure.shouldPrompt === true,
    'failed check should not consume the update-check gate',
  );

  runManager(home, ['update']);
  const updated = runManagerJson(home, ['status', '--json']);
  assert(updated.installed === true, 'status should still work after update');

  const foreignDir = join(home, '.cursor/skills/miles');
  rmSync(foreignDir, { recursive: true, force: true });
  mkdirSync(foreignDir, { recursive: true });
  writeFileSync(join(foreignDir, 'SKILL.md'), 'name: something-else\n');

  const uninstallPlan = runManagerJson(home, ['uninstall', '--dry-run', '--json']);
  const cursorPlan = uninstallPlan.destinations.find((entry) =>
    entry.path.includes('.cursor/skills/miles'),
  );
  assert(cursorPlan, 'uninstall plan should include recorded cursor destination');
  assert(cursorPlan.exists === true, 'foreign cursor dir should exist in plan');
  assert(cursorPlan.owned === false, 'foreign cursor dir should not be owned');
  assert(cursorPlan.willRemove === false, 'foreign cursor dir should not be removed');

  writeFileSync(join(home, '.miles/credentials.json'), '{"token":"keep"}\n');
  runManager(home, ['uninstall', '--json']);
  assert(!existsSync(join(home, '.codex/skills/miles')), 'owned codex skill should be removed');
  assert(existsSync(foreignDir), 'foreign skill dir should be preserved');
  assert(
    existsSync(join(home, '.miles/credentials.json')),
    'non-purge uninstall should preserve credentials',
  );
  assert(!existsSync(join(home, '.miles/bin/miles-skill')), 'manager should be removed');

  console.log('Miles install lifecycle tests passed.');
} finally {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
}
