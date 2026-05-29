#!/usr/bin/env node

import {
  existsSync,
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
    'Run `miles login --request --json`',
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
      'Miles login polling was rate limited before authorization completed. Wait about 2m before trying again. Run `miles login --request --json` for a fresh code.',
    'login rate limit message should include retry guidance without extra spaces',
  );
  const rateLimitWithoutRetry = buildDevicePollingRateLimitMessage();
  assert(
    rateLimitWithoutRetry ===
      'Miles login polling was rate limited before authorization completed. Run `miles login --request --json` for a fresh code.',
    'login rate limit message should degrade cleanly without retry timing',
  );

  const helpResult = run(['help']);
  assert(helpResult.status === 0, 'help should exit cleanly');
  assertIncludes(
    helpResult.stdout,
    'miles login --request --json      Request a device login code',
    'help should document split login code requests',
  );
  assertIncludes(
    helpResult.stdout,
    'miles login --poll <deviceCode>   Poll for device authorization',
    'help should document split login polling',
  );
  assertIncludes(
    helpResult.stdout,
    'miles preview [--open]',
    'help should document host-controlled preview opening',
  );
  assertIncludes(
    helpResult.stdout,
    'miles select-design-direction <n> Choose a design direction',
    'help should document design selection without browser side effects',
  );
  assertIncludes(
    helpResult.stdout,
    'miles build-theme                 Build WordPress theme',
    'help should document theme conversion without browser side effects',
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

  const loginJsonRefusal = runJson(['login', '--json']);
  assert(
    loginJsonRefusal.result.status === 2,
    'login --json should reject the ambiguous legacy blocking flow',
  );
  assertIncludes(
    loginJsonRefusal.json.error,
    'login --request --json',
    'login --json refusal should point agents at the split flow',
  );

  const loginRequestTextRefusal = run(['login', '--request']);
  assert(
    loginRequestTextRefusal.status === 2,
    'login --request without JSON should fail before minting an unusable device code',
  );
  assertIncludes(
    loginRequestTextRefusal.stderr,
    'login --request --json',
    'non-JSON request refusal should explain the agent command',
  );

  const loginMutex = runJson(['login', '--request', '--poll', 'device', '--json']);
  assert(loginMutex.result.status === 2, 'login request/poll modes should be exclusive');
  assertIncludes(
    loginMutex.json.error,
    'either `miles login --request` or `miles login --poll <deviceCode>`',
    'login request/poll mutex should explain the conflict',
  );

  const loginMissingPollCode = runJson(['login', '--poll', '--json']);
  assert(loginMissingPollCode.result.status === 2, 'login --poll should require a device code');
  assertIncludes(
    loginMissingPollCode.json.error,
    '--poll requires a value',
    'missing device code should fail fast',
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
  const { result: loginRequestResult, json: loginRequest } = await runJsonAsync(
    ['login', '--request', '--json'],
    { env: { MILES_SERVER_URL: loginRequestMock.url } },
  );
  assert(loginRequestResult.status === 0, 'login request should exit immediately');
  assert(loginRequest.ok === true, 'login request should return ok true');
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
    ['login', '--request', '--json'],
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
    await runJsonAsync(['login', '--request', '--json'], {
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

  const secureCredsHome = makeTempDir();
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
  const reconnectResult = await runAsync(['reply', 'Make the form wider'], {
    milesHome: reconnectHome,
    env: { MILES_SERVER_URL: reconnectMock.url },
  });
  assert(
    reconnectResult.status === 1,
    `reply should fail fast when the server requires dashboard reconnection\nstatus: ${reconnectResult.status}\nrequests: ${JSON.stringify(reconnectRequests)}\nstdout:\n${reconnectResult.stdout}\nstderr:\n${reconnectResult.stderr}`,
  );
  assertIncludes(
    reconnectResult.stderr,
    'Dashboard connection required',
    'reply should explain the dashboard reconnection requirement',
  );
  assertIncludes(
    reconnectResult.stderr,
    'miles preview --json',
    'reply should tell agents how to recover from dashboard_connection_required',
  );
  assert(
    reconnectRequests.some(
      (request) =>
        request.method === 'POST' &&
        request.url === '/api/v2/headless/conversations/conversation-1/message',
    ),
    'reply should send the message to the active conversation endpoint',
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
  for (const server of mockServers.reverse()) {
    server.close();
  }
  for (const root of tempRoots.reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
}
