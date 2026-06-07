#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
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
const mockServers = [];

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

function runAsync(args, options = {}) {
  const milesHome = options.milesHome || makeTempDir();
  return new Promise((resolve) => {
    const child = spawn(launcherPath, args, {
      env: envFor(milesHome, options.env),
    });
    let stdout = '';
    let stderr = '';
    let didTimeout = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      child.kill('SIGTERM');
    }, options.timeout || 15000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        error: didTimeout ? new Error('Command timed out') : undefined,
      });
    });
  });
}

function runJson(args, options = {}) {
  const result = run(args, options);
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `Expected JSON stdout for ${args.join(' ')}: ${err.message}\nstatus: ${result.status}\nsignal: ${result.signal}\nerror: ${result.error?.message ?? 'none'}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { result, json };
}

async function runJsonAsync(args, options = {}) {
  const result = await runAsync(args, options);
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `Expected JSON stdout for ${args.join(' ')}: ${err.message}\nstatus: ${result.status}\nsignal: ${result.signal}\nerror: ${result.error?.message ?? 'none'}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
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

function loginStateFile(milesHome) {
  return join(milesHome, 'login-state.json');
}

function writePendingLogin(milesHome, overrides = {}) {
  writeFileSync(
    loginStateFile(milesHome),
    JSON.stringify(
      {
        deviceCode: 'pending-device-123',
        userCode: 'PEND-1234',
        verificationUrl: 'https://beta.bymiles.ai/device?code=PEND-1234',
        intervalSeconds: 5,
        expiresInSeconds: 600,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        requestedAt: new Date().toISOString(),
        ...overrides,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

function startMockServer(handler) {
  const server = createServer(handler);
  mockServers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function sendSandboxNetworkBlock(res) {
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end(
    'Blocked by sandbox network policy\nDestination: api.bymiles.ai:443\nReason: not on allow list',
  );
}

try {
  const fallbackPollingPlan = getDeviceAuthPollingPlan();
  assert(
    fallbackPollingPlan.pollIntervalMs === 5000,
    'login polling should use the default device interval',
  );
  assert(
    fallbackPollingPlan.maxAttempts === 110,
    'login polling should cover the normal device-code window',
  );

  const missingExpiryPollingPlan = getDeviceAuthPollingPlan({
    intervalSeconds: 5,
  });
  assert(
    missingExpiryPollingPlan.maxAttempts === 110,
    'login polling should use the default expiry when Miles omits expiresIn',
  );

  const defaultPollingPlan = getDeviceAuthPollingPlan({
    intervalSeconds: 5,
    expiresInSeconds: 600,
  });
  assert(
    defaultPollingPlan.pollIntervalMs === 5000,
    'login polling should honor the server interval for low-delay authorization',
  );
  assert(
    defaultPollingPlan.maxAttempts === 110,
    'login polling should listen through the normal device-code window',
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
    cappedPollingPlan.maxAttempts === 110,
    'login polling should cap attempts even when the device code has a long expiry',
  );
  assertIncludes(
    buildDevicePollingTimeoutMessage(defaultPollingPlan.maxWaitMs),
    'Run `miles login`',
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
    getSlowedDeviceAuthPollIntervalMs(5000) === 10000,
    'slow_down should increase the next device poll by the RFC interval',
  );
  assert(
    getSlowedDeviceAuthPollIntervalMs(5000, 30) === 30000,
    'slow_down should honor retry-after timing when it is longer than the default increase',
  );
  const rateLimitWithRetry = buildDevicePollingRateLimitMessage(120);
  assert(
    rateLimitWithRetry ===
      'Miles login polling was rate limited before authorization completed. Wait about 2m before trying again. Run `miles login` for a fresh code.',
    'login rate limit message should include retry guidance without extra spaces',
  );
  const rateLimitWithoutRetry = buildDevicePollingRateLimitMessage();
  assert(
    rateLimitWithoutRetry ===
      'Miles login polling was rate limited before authorization completed. Run `miles login` for a fresh code.',
    'login rate limit message should degrade cleanly without retry timing',
  );

  const helpResult = run(['help']);
  assert(helpResult.status === 0, 'help should exit cleanly');
  assertIncludes(
    helpResult.stdout,
    'miles auth [login|poll|status|logout]',
    'help should document the auth umbrella',
  );
  assertIncludes(
    helpResult.stdout,
    'miles connect-browser [--open] [--wait]',
    'help should document the explicit browser gate',
  );
  assertIncludes(
    helpResult.stdout,
    'miles build-site --design <n>',
    'help should document the headless site build',
  );
  assertIncludes(
    helpResult.stdout,
    'miles convert-theme',
    'help should document theme conversion as browser-gated',
  );
  assertIncludes(
    helpResult.stdout,
    'miles wait-job',
    'help should document the composable wait verb',
  );
  assertIncludes(
    helpResult.stdout,
    'miles cancel',
    'help should document turn cancellation',
  );
  assertIncludes(
    helpResult.stdout,
    'Exit codes: 0 ok | 1 failed/aborted | 2 precondition | 3 need connection',
    'help should document the shared exit-code grammar',
  );

  const doctorHome = makeTempDir();
  const { result: doctorResult, json: doctor } = runJson(['doctor', '--json'], {
    milesHome: doctorHome,
  });
  assert(doctorResult.status === 1, 'doctor should fail when setup is incomplete');
  assert(doctor.paths.milesHome === doctorHome, 'doctor should honor MILES_HOME');
  assert(doctor.paths.cli === launcherPath, 'doctor should report the launcher path');
  assert(doctor.runtime.name && doctor.runtime.version, 'doctor should report runtime details');
  assert(
    doctor.checks.some((check) => check.name === 'runtime' && check.ok),
    'doctor should verify the CLI runtime',
  );
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

  const loginMutex = runJson(['login', '--request', '--poll', 'device', '--json']);
  assert(loginMutex.result.status === 2, 'login request/poll modes should be exclusive');
  assertIncludes(
    loginMutex.json.error,
    'either `miles login` to request a code or `miles login --poll [deviceCode]`',
    'login request/poll mutex should explain the conflict',
  );

  const loginMissingPollCode = runJson(['login', '--poll', '--json']);
  assert(loginMissingPollCode.result.status === 2, 'login --poll should require a pending login or device code');
  assertIncludes(
    loginMissingPollCode.json.error,
    'No pending Miles login found',
    'missing pending login should fail fast',
  );

  const loginEmptyPollCode = runJson(['login', '--poll', '', '--json']);
  assert(loginEmptyPollCode.result.status === 2, 'login --poll should reject an explicit empty device code');
  assertIncludes(
    loginEmptyPollCode.json.error,
    '--poll value cannot be empty',
    'empty explicit device code should not fall back to pending state',
  );

  const loginBadTimeout = runJson([
    'login',
    '--poll',
    'device-secret-123',
    '--json',
    '--timeout',
    '--once',
  ]);
  assert(loginBadTimeout.result.status === 2, 'login --timeout should require a value');
  assertIncludes(
    loginBadTimeout.json.error,
    '--timeout requires a value',
    'missing timeout value should not silently fall back to the default wait',
  );

  const loginRequestCalls = [];
  const loginRequestMock = await startMockServer((req, res) => {
    loginRequestCalls.push({ method: req.method, url: req.url });
    req.resume();
    if (req.method === 'POST' && req.url === '/api/v2/auth/device/device-code') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          deviceCode: 'device-secret-123',
          userCode: 'YXQS-SHNK',
          verificationUrl: 'https://beta.bymiles.ai/device',
          interval: 5,
          expiresIn: 600,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const loginJsonHome = makeTempDir();
  const { result: loginRequestResult, json: loginRequest } = await runJsonAsync(
    ['login', '--json'],
    {
      milesHome: loginJsonHome,
      env: { MILES_SERVER_URL: loginRequestMock.url },
    },
  );
  assert(loginRequestResult.status === 0, 'login request should exit immediately');
  assert(loginRequest.ok === true, 'login request should return ok true');
  assert(
    loginRequest.pendingState === 'saved' &&
      loginRequest.pendingStatePath === loginStateFile(loginJsonHome),
    'login request should report saved pending state',
  );
  assert(
    loginRequest.deviceCode === 'device-secret-123',
    'login request should expose deviceCode for the polling command',
  );
  assert(
    loginRequest.userCode === 'YXQS-SHNK',
    'login request should expose the user-facing code',
  );
  assert(
    loginRequest.verificationUrl ===
      'https://beta.bymiles.ai/device?code=YXQS-SHNK',
    'login request should return a complete code-embedded URL',
  );
  assert(
    loginRequest.verificationUrlHasCode === true,
    'login request should confirm the URL includes the code',
  );
  assert(
    loginRequest.intervalSeconds === 5 && loginRequest.expiresInSeconds === 600,
    'login request should normalize polling interval and expiry',
  );
  assert(loginRequest.expiresAt, 'login request should include an expiry timestamp');
  assert(
    loginRequestCalls.length === 1 &&
      loginRequestCalls[0].url === '/api/v2/auth/device/device-code',
    'login request should not poll before the agent shows the code',
  );
  const loginJsonState = JSON.parse(
    readFileSync(join(loginJsonHome, 'login-state.json'), 'utf8'),
  );
  assert(
    loginJsonState.deviceCode === 'device-secret-123' &&
      loginJsonState.userCode === 'YXQS-SHNK',
    'login request should save pending login state for a later poll',
  );
  const duplicateLoginStart = await runJsonAsync(['login', '--json'], {
    milesHome: loginJsonHome,
    env: { MILES_SERVER_URL: loginRequestMock.url },
  });
  assert(
    duplicateLoginStart.result.status === 2,
    'login should refuse to overwrite an active pending login',
  );
  assert(
    loginRequestCalls.length === 1,
    'active pending login refusal should happen before minting another device code',
  );
  assertIncludes(
    duplicateLoginStart.json.error,
    'already pending',
    'active pending login refusal should explain how to recover',
  );
  const unsavedStateHomeRoot = makeTempDir();
  const unsavedStateHome = join(unsavedStateHomeRoot, 'not-a-directory');
  writeFileSync(unsavedStateHome, 'not a directory');
  const { result: unsavedStateResult, json: unsavedStateLogin } =
    await runJsonAsync(['login', '--json'], {
      milesHome: unsavedStateHome,
      env: { MILES_SERVER_URL: loginRequestMock.url },
    });
  assert(
    unsavedStateResult.status === 0,
    'login should still print the code when pending state cannot be saved',
  );
  assert(
    unsavedStateLogin.pendingState === 'unsaved' &&
      unsavedStateLogin.deviceCode === 'device-secret-123' &&
      unsavedStateLogin.pendingStateError,
    'unsaved pending state should be reported while preserving the device code',
  );
  const loginTextHome = makeTempDir();
  const loginTextResult = await runAsync(['login'], {
    milesHome: loginTextHome,
    env: { MILES_SERVER_URL: loginRequestMock.url },
  });
  assert(loginTextResult.status === 0, 'text login should exit immediately');
  assertIncludes(
    loginTextResult.stdout,
    'Code: YXQS-SHNK',
    'text login should show the user-facing code',
  );
  assertIncludes(
    loginTextResult.stdout,
    'Open: https://beta.bymiles.ai/device?code=YXQS-SHNK',
    'text login should show the complete verification URL',
  );
  assertIncludes(
    loginTextResult.stdout,
    'You do not need to type the code.',
    'text login should explain that the code is for confirmation',
  );
  assert(
    loginRequestCalls.length === 3 &&
      loginRequestCalls.every((call) => call.url === '/api/v2/auth/device/device-code'),
    'text login should not poll before the user authorizes',
  );
  const loginTextState = JSON.parse(
    readFileSync(join(loginTextHome, 'login-state.json'), 'utf8'),
  );
  assert(
    loginTextState.deviceCode === 'device-secret-123',
    'text login should also save pending login state',
  );
  const loginSavedStatePollMock = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      assert(
        req.method === 'POST' && req.url === '/api/v2/auth/device/device-token',
        'saved-state login poll should call the device token endpoint',
      );
      assert(
        JSON.parse(body).deviceCode === 'device-secret-123',
        'saved-state login poll should use the locally saved deviceCode',
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          apiKey: 'mk_live_saved_state_1234567890',
          keyPrefix: 'mk_live_saved',
        }),
      );
    });
  });
  const { result: loginSavedStatePollResult, json: loginSavedStatePoll } =
    await runJsonAsync(['login', '--poll', '--json'], {
      milesHome: loginTextHome,
      env: { MILES_SERVER_URL: loginSavedStatePollMock.url },
    });
  assert(
    loginSavedStatePollResult.status === 0,
    'login --poll without a deviceCode should finish from saved pending state',
  );
  assert(
    loginSavedStatePoll.status === 'authorized',
    'saved-state login poll should return authorized',
  );
  assert(
    existsSync(join(loginTextHome, 'credentials.json')),
    'saved-state login poll should save credentials',
  );
  assert(
    !existsSync(join(loginTextHome, 'login-state.json')),
    'successful saved-state login poll should clear pending login state',
  );
  const corruptStateHome = makeTempDir();
  writeFileSync(loginStateFile(corruptStateHome), '{');
  const corruptStatePoll = runJson(['login', '--poll', '--json'], {
    milesHome: corruptStateHome,
  });
  assert(
    corruptStatePoll.result.status === 2,
    'corrupt pending login state should be treated as no pending login',
  );
  assert(
    !existsSync(loginStateFile(corruptStateHome)),
    'corrupt pending login state should be self-healed',
  );
  const expiredStateHome = makeTempDir();
  writePendingLogin(expiredStateHome, {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const expiredStatePoll = runJson(['login', '--poll', '--json'], {
    milesHome: expiredStateHome,
  });
  assert(
    expiredStatePoll.result.status === 2,
    'expired pending login state should be treated as no pending login',
  );
  assert(
    !existsSync(loginStateFile(expiredStateHome)),
    'expired pending login state should be cleared before polling',
  );

  const loginSnakeCaseMock = await startMockServer((req, res) => {
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          device_code: 'device-snake-123',
          user_code: 'SNKE-CASE',
          verification_uri_complete:
            'https://beta.bymiles.ai/device?code=SNKE-CASE',
          interval: 7,
          expires_in: 601,
        }),
      );
    });
    req.resume();
  });
  const { result: loginSnakeResult, json: loginSnake } = await runJsonAsync(
    ['login', '--json'],
    { env: { MILES_SERVER_URL: loginSnakeCaseMock.url } },
  );
  assert(loginSnakeResult.status === 0, 'login request should accept snake_case fields');
  assert(
    loginSnake.verificationUrl ===
      'https://beta.bymiles.ai/device?code=SNKE-CASE',
    'login request should preserve a pre-embedded complete verification URL',
  );
  assert(
    loginSnake.intervalSeconds === 7 && loginSnake.expiresInSeconds === 601,
    'login request should normalize snake_case interval and expiry fields',
  );

  const loginMissingExpiryMock = await startMockServer((req, res) => {
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          deviceCode: 'device-no-expiry',
          userCode: 'NOEX-PIRY',
          verificationUrl: 'https://beta.bymiles.ai/device',
          interval: 5,
        }),
      );
    });
    req.resume();
  });
  const { result: loginMissingExpiryResult, json: loginMissingExpiry } =
    await runJsonAsync(['login', '--json'], {
      env: { MILES_SERVER_URL: loginMissingExpiryMock.url },
    });
  assert(
    loginMissingExpiryResult.status === 1,
    'login request should fail when Miles omits the device-code expiry',
  );
  assertIncludes(
    JSON.stringify(loginMissingExpiry.detail),
    'expiresInSeconds',
    'missing expiry failure should name the missing field',
  );

  const sandboxBlockMock = await startMockServer((req, res) => {
    req.resume();
    sendSandboxNetworkBlock(res);
  });
  const { result: sandboxLoginResult, json: sandboxLogin } =
    await runJsonAsync(['login', '--json'], {
      env: { MILES_SERVER_URL: sandboxBlockMock.url },
    });
  assert(sandboxLoginResult.status === 1, 'sandbox-blocked login should fail');
  assert(
    sandboxLogin.code === 'SANDBOX_NETWORK_BLOCKED' &&
      sandboxLogin.status === 'sandbox_network_blocked',
    'sandbox-blocked login should expose a stable error code and status',
  );
  assert(
    sandboxLogin.host === 'api.bymiles.ai' &&
      sandboxLogin.requiredEgress.includes('*.bymiles.ai'),
    'sandbox-blocked login should report the blocked host and egress allowlist',
  );
  assert(
    sandboxLogin.remediation?.sandboxJson,
    'sandbox-blocked login should include sandbox.json remediation guidance',
  );

  const loginPendingMock = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      assert(
        req.method === 'POST' && req.url === '/api/v2/auth/device/device-token',
        'login poll should call the device token endpoint',
      );
      assert(
        JSON.parse(body).deviceCode === 'device-secret-123',
        'login poll should send the requested deviceCode',
      );
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'authorization_pending' }));
    });
  });
  const { result: loginPendingResult, json: loginPending } = await runJsonAsync(
    ['login', '--poll', 'device-secret-123', '--json', '--once'],
    { env: { MILES_SERVER_URL: loginPendingMock.url } },
  );
  assert(loginPendingResult.status === 0, 'single pending poll should exit 0');
  assert(
    loginPending.ok === false && loginPending.status === 'pending',
    'single pending poll should return a stable pending status',
  );

  const loginSlowDownMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(400, {
        'content-type': 'application/json',
        'retry-after': '30',
      });
      res.end(JSON.stringify({ error: 'slow_down' }));
    });
  });
  const { result: loginSlowDownResult, json: loginSlowDown } =
    await runJsonAsync(
      [
        'login',
        '--poll',
        'device-secret-123',
        '--json',
        '--once',
        '--interval',
        '5',
        '--expires-in',
        '600',
      ],
      { env: { MILES_SERVER_URL: loginSlowDownMock.url } },
    );
  assert(loginSlowDownResult.status === 0, 'slow_down once poll should exit 0');
  assert(
    loginSlowDown.status === 'pending' &&
      loginSlowDown.retryAfterSeconds === 30 &&
      loginSlowDown.nextPollIntervalSeconds === 30,
    'slow_down once poll should return pending with retry/backoff guidance',
  );

  const loginAuthHome = makeTempDir();
  const loginAuthorizedMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          apiKey: 'mk_live_test_1234567890',
          keyPrefix: 'mk_live_test',
        }),
      );
    });
  });
  const { result: loginAuthorizedResult, json: loginAuthorized } = await runJsonAsync(
    ['login', '--poll', 'device-secret-123', '--json', '--once'],
    {
      milesHome: loginAuthHome,
      env: { MILES_SERVER_URL: loginAuthorizedMock.url },
    },
  );
  assert(loginAuthorizedResult.status === 0, 'authorized login poll should exit 0');
  assert(
    loginAuthorized.ok === true && loginAuthorized.status === 'authorized',
    'authorized login poll should return a stable authorized status',
  );
  assert(
    loginAuthorized.apiKeyPrefix === 'mk_live_test',
    'authorized login poll should expose the key prefix',
  );
  const savedLoginCreds = JSON.parse(
    readFileSync(join(loginAuthHome, 'credentials.json'), 'utf8'),
  );
  assert(
    savedLoginCreds.apiKey === 'mk_live_test_1234567890',
    'authorized login poll should save credentials',
  );

  const unsavedHomeRoot = makeTempDir();
  const unsavedMilesHome = join(unsavedHomeRoot, 'not-a-directory');
  writeFileSync(unsavedMilesHome, 'not a directory');
  const loginUnsavedMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          apiKey: 'mk_live_unsaved_1234567890',
          keyPrefix: 'mk_live_unsaved',
        }),
      );
    });
  });
  const { result: loginUnsavedResult, json: loginUnsaved } =
    await runJsonAsync(
      ['login', '--poll', 'device-secret-123', '--json', '--once'],
      {
        milesHome: unsavedMilesHome,
        env: { MILES_SERVER_URL: loginUnsavedMock.url },
      },
    );
  assert(
    loginUnsavedResult.status === 1,
    'authorized-but-unsaved login should fail so agents do not continue unauthenticated',
  );
  assert(
    loginUnsaved.status === 'authorized_but_unsaved' &&
      loginUnsaved.apiKeyPrefix === 'mk_live_unsaved',
    'save failure should preserve the authorized status and key prefix',
  );
  assert(
    !JSON.stringify(loginUnsaved).includes('mk_live_unsaved_1234567890'),
    'save failure should not leak the full API key',
  );
  const unsavedStatePollHome = makeTempDir();
  writePendingLogin(unsavedStatePollHome, {
    deviceCode: 'unsaved-state-device',
  });
  writeFileSync(join(unsavedStatePollHome, 'credentials.json'), '{}', {
    mode: 0o400,
  });
  const { result: loginUnsavedStateResult, json: loginUnsavedState } =
    await runJsonAsync(['login', '--poll', '--json', '--once'], {
      milesHome: unsavedStatePollHome,
      env: { MILES_SERVER_URL: loginUnsavedMock.url },
    });
  assert(
    loginUnsavedStateResult.status === 1 &&
      loginUnsavedState.status === 'authorized_but_unsaved',
    'authorized-but-unsaved saved-state poll should fail with structured status',
  );
  assert(
    existsSync(loginStateFile(unsavedStatePollHome)),
    'authorized-but-unsaved saved-state poll should preserve pending state for diagnosis',
  );

  const loginExpiredMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expired_token' }));
    });
  });
  const { result: loginExpiredResult, json: loginExpired } = await runJsonAsync(
    ['login', '--poll', 'expired-device', '--json', '--once'],
    { env: { MILES_SERVER_URL: loginExpiredMock.url } },
  );
  assert(loginExpiredResult.status === 1, 'expired login poll should fail');
  assert(
    loginExpired.ok === false && loginExpired.status === 'expired',
    'expired login poll should return a recoverable expired status',
  );
  const loginExpiredStateHome = makeTempDir();
  writePendingLogin(loginExpiredStateHome, {
    deviceCode: 'expired-state-device',
  });
  const { result: loginExpiredStateResult, json: loginExpiredState } =
    await runJsonAsync(['login', '--poll', '--json', '--once'], {
      milesHome: loginExpiredStateHome,
      env: { MILES_SERVER_URL: loginExpiredMock.url },
    });
  assert(
    loginExpiredStateResult.status === 1 && loginExpiredState.status === 'expired',
    'expired saved-state poll should return expired',
  );
  assert(
    !existsSync(loginStateFile(loginExpiredStateHome)),
    'expired saved-state poll should clear pending login state',
  );

  const loginDeniedMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'access_denied' }));
    });
  });
  const { result: loginDeniedResult, json: loginDenied } = await runJsonAsync(
    ['login', '--poll', 'denied-device', '--json', '--once'],
    { env: { MILES_SERVER_URL: loginDeniedMock.url } },
  );
  assert(loginDeniedResult.status === 1, 'denied login poll should fail');
  assert(
    loginDenied.ok === false && loginDenied.status === 'denied',
    'denied login poll should return a recoverable denied status',
  );

  const loginRateLimitedMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '120',
      });
      res.end(JSON.stringify({ error: 'rate_limited' }));
    });
  });
  const { result: loginRateLimitedResult, json: loginRateLimited } =
    await runJsonAsync(
      ['login', '--poll', 'rate-limited-device', '--json', '--once'],
      { env: { MILES_SERVER_URL: loginRateLimitedMock.url } },
    );
  assert(loginRateLimitedResult.status === 1, 'rate-limited login poll should fail');
  assert(
    loginRateLimited.status === 'rate_limited' &&
      loginRateLimited.retryAfterSeconds === 120,
    'rate-limited login poll should preserve retry-after guidance',
  );
  const loginRateLimitedStateHome = makeTempDir();
  writePendingLogin(loginRateLimitedStateHome, {
    deviceCode: 'rate-limited-state-device',
  });
  const { result: loginRateLimitedStateResult, json: loginRateLimitedState } =
    await runJsonAsync(['login', '--poll', '--json', '--once'], {
      milesHome: loginRateLimitedStateHome,
      env: { MILES_SERVER_URL: loginRateLimitedMock.url },
    });
  assert(
    loginRateLimitedStateResult.status === 1 &&
      loginRateLimitedState.status === 'rate_limited',
    'rate-limited saved-state poll should return rate_limited',
  );
  assert(
    existsSync(loginStateFile(loginRateLimitedStateHome)),
    'rate-limited saved-state poll should preserve pending login state',
  );

  const loginTransportMock = await startMockServer((req) => {
    req.socket.destroy();
  });
  const { result: loginTransportResult, json: loginTransport } =
    await runJsonAsync(
      ['login', '--poll', 'transport-device', '--json', '--once'],
      { env: { MILES_SERVER_URL: loginTransportMock.url } },
    );
  assert(loginTransportResult.status === 1, 'transport error login poll should fail');
  assert(
    loginTransport.status === 'transport_error',
    'transport error login poll should return a structured status',
  );
  const loginTransportStateHome = makeTempDir();
  writePendingLogin(loginTransportStateHome, {
    deviceCode: 'transport-state-device',
  });
  const { result: loginTransportStateResult, json: loginTransportState } =
    await runJsonAsync(['login', '--poll', '--json', '--once'], {
      milesHome: loginTransportStateHome,
      env: { MILES_SERVER_URL: loginTransportMock.url },
    });
  assert(
    loginTransportStateResult.status === 1 &&
      loginTransportState.status === 'transport_error',
    'transport-error saved-state poll should return transport_error',
  );
  assert(
    existsSync(loginStateFile(loginTransportStateHome)),
    'transport-error saved-state poll should preserve pending login state',
  );

  const sandboxPollHome = makeTempDir();
  writePendingLogin(sandboxPollHome, {
    deviceCode: 'sandbox-blocked-device',
  });
  const { result: sandboxPollResult, json: sandboxPoll } = await runJsonAsync(
    ['login', '--poll', '--json', '--once'],
    {
      milesHome: sandboxPollHome,
      env: { MILES_SERVER_URL: sandboxBlockMock.url },
    },
  );
  assert(sandboxPollResult.status === 1, 'sandbox-blocked poll should fail');
  assert(
    sandboxPoll.code === 'SANDBOX_NETWORK_BLOCKED' &&
      sandboxPoll.status === 'sandbox_network_blocked',
    'sandbox-blocked poll should expose a stable status',
  );
  assert(
    existsSync(loginStateFile(sandboxPollHome)),
    'sandbox-blocked saved-state poll should preserve pending login state',
  );

  const secureCredsHome = makeTempDir();
  writePendingLogin(secureCredsHome);
  writeFileSync(
    join(secureCredsHome, 'credentials.json'),
    JSON.stringify({ apiKey: 'existing-key' }),
    { mode: 0o644 },
  );
  const { result: logoutResult } = runJson(['logout', '--json'], {
    milesHome: secureCredsHome,
  });
  assert(logoutResult.status === 0, 'logout --json should exit cleanly');
  assert(
    (statSync(secureCredsHome).mode & 0o777) === 0o700,
    'Miles home should be restricted to the current user',
  );
  assert(
    (statSync(join(secureCredsHome, 'credentials.json')).mode & 0o777) === 0o600,
    'credentials should be restricted to the current user',
  );
  assert(
    !existsSync(loginStateFile(secureCredsHome)),
    'logout should remove pending login state',
  );
  const logoutCleanupWarningHome = makeTempDir();
  mkdirSync(loginStateFile(logoutCleanupWarningHome));
  const { result: logoutCleanupWarningResult, json: logoutCleanupWarning } =
    runJson(['logout', '--json'], {
      milesHome: logoutCleanupWarningHome,
    });
  assert(
    logoutCleanupWarningResult.status === 0,
    'logout should succeed even when pending-state cleanup fails',
  );
  assert(
    logoutCleanupWarning.cleanupWarning,
    'logout should surface a cleanup warning without failing',
  );

  const { result: statusResult, json: status } = runJson(['status', '--json']);
  assert(
    statusResult.status === 2,
    'status --json should exit 2 without an active site',
  );
  assert(status.ok === false, 'status --json failure should be structured');
  assertIncludes(status.error, 'No active conversation', 'status should explain the precondition');

  const replyResult = run(['reply', 'Use --json output']);
  assert(
    replyResult.status === 2,
    'reply alias without an active conversation should exit 2',
  );
  assert(
    !replyResult.stdout.includes('The --json option'),
    'reply prose containing --json should not be treated as a global option',
  );
  assertIncludes(
    replyResult.stderr,
    'No active conversation',
    'reply should preserve --json inside user prose',
  );

  const sayResult = run(['say', 'Hello there']);
  assert(
    sayResult.status === 2,
    'say without an active conversation should exit 2',
  );

  const reconnectHome = makeTempDir();
  writeFileSync(
    join(reconnectHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-1',
      sites: {
        'site-1': {
          siteToken: 'site-token',
          conversationId: 'conversation-1',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-1',
        },
      },
    }),
  );
  const reconnectRequests = [];
  const reconnectMock = await startMockServer((req, res) => {
    reconnectRequests.push({ method: req.method, url: req.url });
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'dashboard_connection_required' }));
    });
  });
  const reconnectResult = await runAsync(['say', 'Make the form wider'], {
    milesHome: reconnectHome,
    env: { MILES_SERVER_URL: reconnectMock.url },
  });
  assert(
    reconnectResult.status === 3,
    `say should exit 3 (need_connection) when the server requires dashboard reconnection\nstatus: ${reconnectResult.status}\nrequests: ${JSON.stringify(reconnectRequests)}\nstdout:\n${reconnectResult.stdout}\nstderr:\n${reconnectResult.stderr}`,
  );
  assertIncludes(
    reconnectResult.stderr,
    'browser dashboard connection is required',
    'say should explain the dashboard reconnection requirement',
  );
  assertIncludes(
    reconnectResult.stderr,
    'miles connect-browser --json',
    'say should tell agents how to recover from a missing connection',
  );
  assert(
    reconnectRequests.some(
      (request) =>
        request.method === 'POST' &&
        request.url === '/api/v2/headless/conversations/conversation-1/message',
    ),
    'say should send the message to the active conversation endpoint',
  );

  // build-site must be headless: it must POST select-design-direction without
  // checking the dashboard connection first, and exit with the outcome code.
  const buildHome = makeTempDir();
  writeFileSync(
    join(buildHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-2',
      sites: {
        'site-2': {
          siteToken: 'site-token',
          conversationId: 'conversation-2',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-2',
        },
      },
    }),
  );
  const buildRequests = [];
  const buildMock = await startMockServer((req, res) => {
    buildRequests.push({ method: req.method, url: req.url });
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url.includes('/select-design-direction')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Design 1 selected.' }));
        return;
      }
      if (req.url.includes('/wait')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'completed',
            outcome: 'completed',
            phase: 'site_preview',
            milesMessage: 'Site built.',
            siteReady: false,
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const buildResult = await runAsync(['build-site', '--design', '1'], {
    milesHome: buildHome,
    env: { MILES_SERVER_URL: buildMock.url },
  });
  assert(
    buildResult.status === 0,
    `build-site should complete headlessly\nstatus: ${buildResult.status}\nrequests: ${JSON.stringify(buildRequests)}\nstderr:\n${buildResult.stderr}`,
  );
  assert(
    !buildRequests.some((request) => request.url.includes('/ws-status')),
    'build-site must not gate on the dashboard connection',
  );
  assert(
    buildRequests.some(
      (request) =>
        request.method === 'POST' &&
        request.url ===
          '/api/v2/headless/conversations/conversation-2/select-design-direction',
    ),
    'build-site should trigger the design selection build',
  );
  assertIncludes(
    buildResult.stdout,
    '[outcome: completed]',
    'build-site should surface the settled turn outcome',
  );

  // wait-job maps blocked/declined outcomes onto exit 4 with JSON on stdout.
  const waitJobHome = makeTempDir();
  writeFileSync(
    join(waitJobHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-3',
      sites: {
        'site-3': {
          siteToken: 'site-token',
          conversationId: 'conversation-3',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-3',
        },
      },
    }),
  );
  const waitJobMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'waiting_for_input',
          outcome: 'declined',
          outcomeUnresolved: ['User declined the plugin install'],
          phase: 'complete',
          milesMessage: 'Understood, skipping that.',
        }),
      );
    });
  });
  const waitJobResult = await runAsync(['wait-job'], {
    milesHome: waitJobHome,
    env: { MILES_SERVER_URL: waitJobMock.url },
  });
  assert(
    waitJobResult.status === 4,
    `wait-job should exit 4 on a declined outcome\nstatus: ${waitJobResult.status}\nstdout:\n${waitJobResult.stdout}`,
  );
  const waitJobJson = JSON.parse(waitJobResult.stdout);
  assert(
    waitJobJson.outcome === 'declined' && waitJobJson.ok === false,
    'wait-job should report the declined outcome as structured JSON',
  );

  // cancel is gated on the capabilities handshake: a server without the
  // cancel primitive must produce exit 2, not a confusing 404.
  const legacyHome = makeTempDir();
  writeFileSync(
    join(legacyHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-4',
      sites: {
        'site-4': {
          siteToken: 'site-token',
          conversationId: 'conversation-4',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-4',
        },
      },
    }),
  );
  const legacyMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const legacyCancel = await runAsync(['cancel'], {
    milesHome: legacyHome,
    env: { MILES_SERVER_URL: legacyMock.url },
  });
  assert(
    legacyCancel.status === 2,
    `cancel against a legacy server should exit 2\nstatus: ${legacyCancel.status}\nstderr:\n${legacyCancel.stderr}`,
  );
  assertIncludes(
    legacyCancel.stderr,
    'does not support',
    'cancel should explain the missing server capability',
  );

  // --no-wait must refuse to fire-and-forget when cancel is unsupported.
  const noWaitResult = await runAsync(
    ['say', '--no-wait', 'Build the site'],
    {
      milesHome: legacyHome,
      env: { MILES_SERVER_URL: legacyMock.url },
    },
  );
  assert(
    noWaitResult.status === 2,
    `--no-wait against a legacy server should exit 2\nstatus: ${noWaitResult.status}\nstderr:\n${noWaitResult.stderr}`,
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

  // In-flight run marker: hook-prompt injects recovery context while a
  // fired run is unsettled, stays silent when clean, and ignores stale
  // markers. Inspection verbs surface the same notice on stderr.
  const markerHome = makeTempDir();
  const hookPromptClean = run(['hook-prompt'], { milesHome: markerHome });
  assert(
    hookPromptClean.status === 0 && hookPromptClean.stdout === '',
    'hook-prompt should stay silent with no marker',
  );

  writeFileSync(
    join(markerHome, 'active-run.json'),
    JSON.stringify({
      verb: 'build-site',
      siteId: 'site-9',
      conversationId: 'conversation-9',
      firedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    }),
  );
  const hookPromptActive = run(['hook-prompt'], { milesHome: markerHome });
  assert(
    hookPromptActive.status === 0,
    'hook-prompt should exit 0 with a live marker',
  );
  const hookPromptJson = JSON.parse(hookPromptActive.stdout);
  assertIncludes(
    hookPromptJson.hookSpecificOutput.additionalContext,
    'build-site',
    'hook-prompt should describe the in-flight run',
  );
  assertIncludes(
    hookPromptJson.hookSpecificOutput.additionalContext,
    'miles cancel',
    'hook-prompt should offer the cancel recovery path',
  );

  writeFileSync(
    join(markerHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-9',
      sites: {
        'site-9': {
          siteToken: 'site-token',
          conversationId: 'conversation-9',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-9',
        },
      },
    }),
  );
  const markerMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'idle',
          phase: 'site_preview',
          conversationStatus: 'idle',
          directions: [],
        }),
      );
    });
  });
  const noticeResult = await runAsync(['status', '--json'], {
    milesHome: markerHome,
    env: { MILES_SERVER_URL: markerMock.url },
  });
  assertIncludes(
    noticeResult.stderr,
    'continued server-side',
    'inspection verbs should surface the in-flight marker on stderr',
  );
  assert(
    !noticeResult.stdout.includes('continued server-side'),
    'the marker notice must not pollute JSON stdout',
  );

  writeFileSync(
    join(markerHome, 'active-run.json'),
    JSON.stringify({
      verb: 'build-site',
      siteId: 'site-9',
      conversationId: 'conversation-9',
      firedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }),
  );
  const hookPromptStale = run(['hook-prompt'], { milesHome: markerHome });
  assert(
    hookPromptStale.stdout === '',
    'hook-prompt should ignore markers older than an hour',
  );

  assert(existsSync(launcherPath), 'launcher should exist');
  console.log('Miles CLI smoke tests passed.');
} finally {
  for (const server of mockServers.reverse()) {
    server.close();
  }
  for (const root of tempRoots.reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
}
