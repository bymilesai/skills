#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
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
  const result = spawnSync('sh', [installer, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: options.home,
      MILES_INSTALL_SOURCE_DIR: repoRoot,
      MILES_SKILL_MANIFEST_URL: options.manifest || join(repoRoot, 'version.json'),
      MILES_UPDATE_CHECK_INTERVAL_SECONDS: options.interval || '86400',
    },
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
  const result = spawnSync(manager, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      MILES_INSTALL_SOURCE_DIR: repoRoot,
      MILES_SKILL_MANIFEST_URL: options.manifest || join(repoRoot, 'version.json'),
      MILES_UPDATE_CHECK_INTERVAL_SECONDS: options.interval || '86400',
    },
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
