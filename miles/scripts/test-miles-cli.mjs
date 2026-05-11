#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  buildDevicePollingRateLimitMessage,
  buildDevicePollingTimeoutMessage,
  formatDuration,
  formatRetryAfter,
  getDeviceAuthPollingPlan,
  getSlowedDeviceAuthPollIntervalMs,
  parseRetryAfterSeconds,
} from './login-polling.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, '..');
const launcherPath = join(scriptDir, 'miles');
const cliPath = join(scriptDir, 'miles-cli.mjs');
const tempRoots = [];

function makeTempDir(prefix = 'miles-cli-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function envFor(milesHome, overrides = {}) {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:${process.env.PATH || ''}`,
    MILES_HOME: milesHome,
    MILES_CLI: launcherPath,
    MILES_SKILL_DIR: skillDir,
    ...overrides,
  };
}

function run(args, options = {}) {
  const milesHome = options.milesHome || makeTempDir();
  return spawnSync(launcherPath, args, {
    encoding: 'utf8',
    input: options.input,
    env: envFor(milesHome, options.env),
    timeout: options.timeout || 15000,
  });
}

function runJson(args, options = {}) {
  const result = run(args, options);
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `Expected JSON stdout for ${args.join(' ')}: ${err.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { result, json };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes(text, expected, message) {
  assert(
    text.includes(expected),
    `${message}\nExpected to include: ${expected}\nActual:\n${text}`,
  );
}

function hookPayload(command) {
  return JSON.stringify({
    tool_input: {
      command,
    },
  });
}

function runHook(command, milesHome) {
  return run(['hook'], {
    milesHome,
    input: hookPayload(command),
  });
}

try {
  const fallbackPollingPlan = getDeviceAuthPollingPlan();
  assert(
    fallbackPollingPlan.pollIntervalMs === 10000,
    'login polling should clamp the default interval to the safe minimum',
  );
  assert(
    fallbackPollingPlan.maxAttempts === 55,
    'login polling should cap default attempts below the polling rate limit',
  );

  const missingExpiryPollingPlan = getDeviceAuthPollingPlan({
    intervalSeconds: 5,
  });
  assert(
    missingExpiryPollingPlan.maxAttempts === 55,
    'login polling should use the default expiry when Miles omits expiresIn',
  );

  const defaultPollingPlan = getDeviceAuthPollingPlan({
    intervalSeconds: 5,
    expiresInSeconds: 600,
  });
  assert(
    defaultPollingPlan.pollIntervalMs === 10000,
    'login polling should clamp the server interval to the safe minimum',
  );
  assert(
    defaultPollingPlan.maxAttempts === 55,
    'login polling should stop before the server polling rate limit',
  );
  assert(
    formatDuration(defaultPollingPlan.maxWaitMs) === '9m 10s',
    'login polling should expose a readable wait duration',
  );
  const cappedPollingPlan = getDeviceAuthPollingPlan({
    intervalSeconds: 10,
    expiresInSeconds: 3600,
  });
  assert(
    cappedPollingPlan.maxAttempts === 55,
    'login polling should cap attempts even when the device code has a long expiry',
  );
  assertIncludes(
    buildDevicePollingTimeoutMessage(defaultPollingPlan.maxWaitMs),
    'Run `miles login` again',
    'login timeout message should tell users how to recover',
  );
  assert(
    formatRetryAfter(undefined) === '',
    'retry-after formatting should degrade cleanly when Miles omits retry timing',
  );
  assert(
    parseRetryAfterSeconds('120') === 120,
    'retry-after parsing should accept numeric header values',
  );
  assert(
    parseRetryAfterSeconds(
      'Sun, 10 May 2026 16:02:00 GMT',
      Date.parse('Sun, 10 May 2026 16:00:00 GMT'),
    ) === 120,
    'retry-after parsing should accept HTTP-date header values',
  );
  assert(
    getSlowedDeviceAuthPollIntervalMs(10000) === 15000,
    'slow_down should increase the next device poll by the RFC interval',
  );
  assert(
    getSlowedDeviceAuthPollIntervalMs(10000, 30) === 30000,
    'slow_down should honor retry-after timing when it is longer than the default increase',
  );
  const rateLimitWithRetry = buildDevicePollingRateLimitMessage(120);
  assert(
    rateLimitWithRetry ===
      'Miles login polling was rate limited before authorization completed. Wait about 2m before trying again. Run `miles login` again for a fresh code.',
    'login rate limit message should include retry guidance without extra spaces',
  );
  const rateLimitWithoutRetry = buildDevicePollingRateLimitMessage();
  assert(
    rateLimitWithoutRetry ===
      'Miles login polling was rate limited before authorization completed. Run `miles login` again for a fresh code.',
    'login rate limit message should degrade cleanly without retry timing',
  );

  const doctorHome = makeTempDir();
  const { result: doctorResult, json: doctor } = runJson(['doctor', '--json'], {
    milesHome: doctorHome,
  });
  assert(doctorResult.status === 1, 'doctor should fail when setup is incomplete');
  assert(doctor.paths.milesHome === doctorHome, 'doctor should honor MILES_HOME');
  assert(doctor.paths.cli === launcherPath, 'doctor should report the launcher path');
  assert(doctor.runtime.node, 'doctor should report Node version');
  assert(
    doctor.checks.some((check) => check.name === 'milesHome' && check.ok),
    'doctor should verify MILES_HOME writability',
  );
  assert(
    doctor.checks.some((check) => check.name === 'credentials' && !check.ok),
    'doctor should report missing credentials as setup needed',
  );

  const whoamiHome = makeTempDir();
  const { result: whoamiResult, json: whoami } = runJson(['whoami', '--json'], {
    milesHome: whoamiHome,
  });
  assert(whoamiResult.status === 0, 'whoami --json should exit 0 when logged out');
  assert(whoami.authenticated === false, 'whoami should report unauthenticated JSON');
  assert(whoami.milesHome === whoamiHome, 'whoami should honor MILES_HOME');

  const { result: statusResult, json: status } = runJson(['status', '--json']);
  assert(statusResult.status === 1, 'status --json should fail without an active site');
  assert(status.ok === false, 'status --json failure should be structured');
  assertIncludes(status.error, 'No active conversation', 'status should explain the precondition');

  const replyResult = run(['reply', 'Use --json output']);
  assert(replyResult.status === 1, 'reply without an active conversation should fail');
  assert(
    !replyResult.stdout.includes('The --json option'),
    'reply prose containing --json should not be treated as a global option',
  );
  assertIncludes(
    replyResult.stderr,
    'No active conversation',
    'reply should preserve --json inside user prose',
  );

  const { result: unsupportedJsonResult, json: unsupportedJson } = runJson([
    '--json',
    'reply',
    'hello',
  ]);
  assert(
    unsupportedJsonResult.status === 2,
    'global --json should be rejected on streaming commands',
  );
  assertIncludes(
    unsupportedJson.error,
    'only supported for inspection commands',
    'unsupported JSON command should explain the contract',
  );

  const badCredsHome = makeTempDir();
  writeFileSync(join(badCredsHome, 'credentials.json'), '{not json');
  const { result: badCredsResult, json: badCreds } = runJson(['whoami', '--json'], {
    milesHome: badCredsHome,
  });
  assert(badCredsResult.status === 1, 'malformed credentials should fail loudly');
  assertIncludes(
    badCreds.error,
    'Could not read Miles credentials',
    'malformed credentials should not masquerade as logged out',
  );

  const fakeHomeRoot = makeTempDir('miles-cli-home-');
  const tildeMilesHome = '~/isolated-miles-state';
  const expandedMilesHome = join(fakeHomeRoot, 'isolated-miles-state');
  const { json: tildeDoctor } = runJson(['doctor', '--json'], {
    milesHome: tildeMilesHome,
    env: { HOME: fakeHomeRoot },
  });
  assert(
    tildeDoctor.paths.milesHome === expandedMilesHome,
    'doctor should expand MILES_HOME paths that start with ~/',
  );

  run(['hook-init']);

  const positiveHookCommands = [
    '"$MILES_CLI" whoami',
    'MILES_CLI=/tmp/miles "$MILES_CLI" whoami',
    `${cliPath} whoami`,
    `${launcherPath} whoami`,
    `cd /tmp && ${launcherPath} whoami`,
  ];

  for (const command of positiveHookCommands) {
    const hookHome = makeTempDir();
    const responsePath = join(hookHome, 'last-response');
    writeFileSync(responsePath, `[status: completed]\nResponse for ${command}`);

    const hook = runHook(command, hookHome);
    assert(hook.status === 0, `hook should exit 0 for ${command}`);
    const hookOutput = JSON.parse(hook.stdout);
    assertIncludes(
      hookOutput.hookSpecificOutput.additionalContext,
      `Response for ${command}`,
      `hook should relay last response for ${command}`,
    );

    const secondHook = runHook(command, hookHome);
    assert(secondHook.status === 0, `second hook should exit 0 for ${command}`);
    assert(secondHook.stdout === '', `hook should clear relay after ${command}`);
  }

  const negativeHookCommands = [
    'echo miles',
    'git log --author miles',
    'smiles whoami',
    'compiled-miles whoami',
  ];

  for (const command of negativeHookCommands) {
    const hookHome = makeTempDir();
    const responsePath = join(hookHome, 'last-response');
    writeFileSync(responsePath, `[status: completed]\nShould not relay ${command}`);

    const hook = runHook(command, hookHome);
    assert(hook.status === 0, `non-Miles hook should exit 0 for ${command}`);
    assert(hook.stdout === '', `non-Miles hook should not relay for ${command}`);
    assert(
      readFileSync(responsePath, 'utf8').includes('Should not relay'),
      `non-Miles hook should not clear relay for ${command}`,
    );
  }

  const badHook = run(['hook'], {
    input: '{not json',
  });
  assert(badHook.status === 0, 'malformed hook payload should exit 0');
  assert(badHook.stdout === '', 'malformed hook payload should not emit context');
  assertIncludes(
    badHook.stderr,
    'Miles hook warning: could not parse hook payload',
    'malformed hook payload should warn on stderr',
  );

  assert(existsSync(launcherPath), 'launcher should exist');
  console.log('Miles CLI smoke tests passed.');
} finally {
  for (const root of tempRoots.reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
}
