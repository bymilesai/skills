#!/usr/bin/env node

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(scriptDir, 'miles-cli.mjs');
const milesHome = mkdtempSync(join(tmpdir(), 'miles-cli-test-'));

function run(args, options = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MILES_HOME: milesHome,
      MILES_CLI: cliPath,
      MILES_SKILL_DIR: resolve(scriptDir, '..'),
    },
    ...options,
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  const doctor = JSON.parse(run(['doctor', '--json']));
  assert(doctor.paths.milesHome === milesHome, 'doctor should honor MILES_HOME');
  assert(doctor.paths.cli === cliPath, 'doctor should report MILES_CLI');
  assert(doctor.runtime.node, 'doctor should report Node version');

  const whoami = JSON.parse(run(['whoami', '--json']));
  assert(whoami.authenticated === false, 'whoami should report unauthenticated JSON');
  assert(whoami.milesHome === milesHome, 'whoami should honor MILES_HOME');

  run(['hook-init']);
  const responsePath = join(milesHome, 'last-response');
  writeFileSync(responsePath, '[status: completed]\nMiles response body');

  const hook = spawnSync(process.execPath, [cliPath, 'hook'], {
    encoding: 'utf8',
    input: JSON.stringify({
      tool_input: {
        command: '"$MILES_CLI" whoami',
      },
    }),
    env: {
      ...process.env,
      MILES_HOME: milesHome,
      MILES_CLI: cliPath,
      MILES_SKILL_DIR: resolve(scriptDir, '..'),
    },
  });

  assert(hook.status === 0, 'hook should exit 0');
  const hookOutput = JSON.parse(hook.stdout);
  assert(
    hookOutput.hookSpecificOutput.additionalContext.includes('Miles response body'),
    'hook should relay last response for MILES_CLI commands',
  );

  mkdirSync(join(milesHome, 'screenshots'), { recursive: true });
  console.log('Miles CLI smoke tests passed.');
} finally {
  rmSync(milesHome, { recursive: true, force: true });
}
