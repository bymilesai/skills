#!/usr/bin/env node

import {
  chmodSync,
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
import { execFileSync, spawn, spawnSync } from 'child_process';
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
    MILES_RUNTIME_BINARY: join(milesHome, 'missing-runtime'),
    ...overrides,
  };
}

function run(args, options = {}) {
  const milesHome = options.milesHome || makeTempDir();
  return spawnSync(launcherPath, args, {
    encoding: 'utf8',
    input: options.input,
    env: envFor(milesHome, options.env),
    cwd: options.cwd,
    timeout: options.timeout || 15000,
  });
}

function runAsync(args, options = {}) {
  const milesHome = options.milesHome || makeTempDir();
  return new Promise((resolve) => {
    const child = spawn(launcherPath, args, {
      env: envFor(milesHome, options.env),
      cwd: options.cwd,
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

function sendCapabilities(res, primitives = {}) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ primitives }));
}

const WORDPRESS_BOOTSTRAP_PRIMITIVE = {
  'wordpress-bootstrap': { tier: 'plumbing', connection: 'none' },
};

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
    'miles site-plan [--history] [--json]',
    'help should document the lossless Site Plan read',
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
    'miles wordpress-detect [--path <dir>]   LOCAL',
    'help should document local WordPress detection',
  );
  assertIncludes(
    helpResult.stdout,
    'miles wordpress-setup --use local       LOCAL',
    'help should document local WordPress setup',
  );
  assertIncludes(
    helpResult.stdout,
    'miles approval-respond --grant <id> --response approved|declined  CONDITIONAL',
    'help should document approval response as conditionally browser-backed',
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

  // Invariant: this list must match the `commands` map in miles-cli.mjs.
  // A command missing here silently skips help-safety coverage.
  const commandsWithSafeHelp = [
    'auth',
    'account-status',
    'site-create',
    'say',
    'design-directions',
    'build-site',
    'wait-job',
    'approval-respond',
    'site-state',
    'site-plan',
    'site-attach',
    'wordpress-detect',
    'wordpress-setup',
    'screenshot',
    'upload-assets',
    'export',
    'connect-browser',
    'convert-theme',
    'cancel',
    'undo',
    'site-pages',
    'usage-history',
    'rename',
    'history',
    'doctor',
    'wait',
    'status',
    'sites',
    'use',
    'balance',
    'messages',
    'check-auth',
    'hook-init',
    'hook',
    'hook-prompt',
    'login',
    'logout',
    'whoami',
    'create-site',
    'reply',
    'select-design-direction',
    'preview',
    'build-theme',
    'export-theme',
    'export-site',
  ];
  for (const helpCommand of commandsWithSafeHelp) {
    const commandHelp = run([helpCommand, '--help']);
    assert(
      commandHelp.status === 0,
      `${helpCommand} --help should exit 0 before validation or execution`,
    );
    assertIncludes(
      commandHelp.stdout,
      'Miles CLI - Design websites with Miles AI',
      `${helpCommand} --help should print help`,
    );
  }

  const helpSafetyHome = makeTempDir();
  writeFileSync(
    join(helpSafetyHome, 'credentials.json'),
    JSON.stringify({ apiKey: 'mk_live_test_key' }),
    { mode: 0o600 },
  );
  const helpSafetyRequests = [];
  const helpSafetyMock = await startMockServer((req, res) => {
    helpSafetyRequests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'help must not call the API' }));
  });
  const helpSafetyResult = await runAsync(['site-create', '--help'], {
    milesHome: helpSafetyHome,
    env: { MILES_SERVER_URL: helpSafetyMock.url },
  });
  assert(
    helpSafetyResult.status === 0,
    'site-create --help should exit 0 for an authenticated user',
  );
  assert(
    helpSafetyRequests.length === 0,
    'site-create --help must not call capabilities, create a site, or spend credits',
  );
  const shortHelpSafetyResult = await runAsync(['site-create', '-h'], {
    milesHome: helpSafetyHome,
    env: { MILES_SERVER_URL: helpSafetyMock.url },
  });
  assert(
    shortHelpSafetyResult.status === 0 && helpSafetyRequests.length === 0,
    'site-create -h must be just as side-effect free as --help',
  );
  const unknownHelpResult = await runAsync(['no-such-command', '--help'], {
    milesHome: helpSafetyHome,
    env: { MILES_SERVER_URL: helpSafetyMock.url },
  });
  assert(
    unknownHelpResult.status === 0 && helpSafetyRequests.length === 0,
    'an unknown command with --help should print help instead of exiting 1',
  );

  const fakeRuntimeDir = makeTempDir();
  const fakeRuntime = join(fakeRuntimeDir, 'runtime');
  writeFileSync(
    fakeRuntime,
    `#!/bin/sh
printf '%s|%s|%s\\n' "\${MILES_SERVER_URL-unset}" "\${MILES_PLUGIN_SOURCE-unset}" "\${WP_CLI-unset}"
`,
    { mode: 0o755 },
  );
  const dotenvDir = makeTempDir();
  writeFileSync(
    join(dotenvDir, '.env'),
    'MILES_SERVER_URL=http://localhost:3999\nMILES_PLUGIN_SOURCE=/private/source\nWP_CLI=/private/wp\n',
  );
  const shieldedLauncher = run(['doctor'], {
    cwd: dotenvDir,
    env: {
      MILES_RUNTIME_BINARY: fakeRuntime,
      MILES_SERVER_URL: undefined,
      MILES_PLUGIN_SOURCE: undefined,
      WP_CLI: undefined,
    },
  });
  assert(
    shieldedLauncher.status === 0 && shieldedLauncher.stdout.trim() === '||',
    'the launcher should pass explicit empty Miles configuration so bundled Bun cannot import repository .env values',
  );

  const unsupportedLocalHome = makeTempDir();
  const unsupportedLocalAsset = join(unsupportedLocalHome, 'logo.svg');
  writeFileSync(unsupportedLocalAsset, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(
    join(unsupportedLocalHome, 'credentials.json'),
    JSON.stringify({
      apiKey: 'mk_live_test_key',
      activeSite: 'local-site-unsupported',
      sites: {
        'local-site-unsupported': {
          siteToken: 'local-site-token',
          conversationId: null,
          dashboardUrl:
            'http://local-site.test/wp-admin/admin.php?page=miles',
          siteUrl: 'http://local-site.test',
          localWordPressRoot: '/tmp/local-site',
          connection: { kind: 'local-wordpress' },
        },
      },
    }),
    { mode: 0o600 },
  );
  const unsupportedLocalRequests = [];
  const unsupportedLocalMock = await startMockServer((req, res) => {
    unsupportedLocalRequests.push({ method: req.method, url: req.url });
    req.resume();
    if (req.url === '/api/v2/headless/capabilities') {
      sendCapabilities(res, {
        'site-create': { tier: 'porcelain', connection: 'none' },
      });
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected mutation' }));
  });
  const { result: unsupportedLocalResult, json: unsupportedLocalJson } =
    await runJsonAsync(
      [
        'site-create',
        'Build on this local WordPress site',
        '--attach',
        unsupportedLocalAsset,
        '--json',
      ],
      {
        milesHome: unsupportedLocalHome,
        env: { MILES_SERVER_URL: unsupportedLocalMock.url },
      },
    );
  assert(
    unsupportedLocalResult.status === 2,
    'site-create should fail safely when local WordPress creation is not advertised',
  );
  assert(
    unsupportedLocalJson.detail?.code ===
      'primitive_operation_unsupported' &&
      unsupportedLocalJson.detail?.primitive === 'site-create' &&
      unsupportedLocalJson.detail?.operation === 'local-wordpress',
    'the safe local-site refusal should identify the missing server operation',
  );
  assert(
    unsupportedLocalRequests.length === 1 &&
      unsupportedLocalRequests[0].url === '/api/v2/headless/capabilities',
    'unsupported local site-create must stop before uploads, site creation, or credit spend',
  );

  const supportedLocalHome = makeTempDir();
  const supportedLocalDashboard =
    'http://local-site.test/wp-admin/admin.php?page=miles';
  writeFileSync(
    join(supportedLocalHome, 'credentials.json'),
    JSON.stringify({
      apiKey: 'mk_live_test_key',
      activeSite: 'local-site-supported',
      sites: {
        'local-site-supported': {
          siteToken: 'old-local-site-token',
          name: 'Local Site',
          conversationId: null,
          dashboardUrl: supportedLocalDashboard,
          cloudDashboardUrl:
            'https://app.example.test/sites/local-site-supported',
          siteUrl: 'http://local-site.test',
          localWordPressRoot: '/tmp/local-site',
          connection: { kind: 'local-wordpress' },
        },
      },
    }),
    { mode: 0o600 },
  );
  const supportedLocalRequests = [];
  const supportedLocalMock = await startMockServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      supportedLocalRequests.push({
        method: req.method,
        url: req.url,
        body: body ? JSON.parse(body) : null,
      });
      if (req.url === '/api/v2/headless/capabilities') {
        sendCapabilities(res, {
          'site-create': {
            tier: 'porcelain',
            connection: 'none',
            operations: {
              'local-wordpress': { connection: 'none' },
            },
          },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v2/headless/sites') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            siteId: 'local-site-supported',
            siteToken: 'new-local-site-token',
            conversationId: 'local-conversation',
            dashboardUrl:
              'https://app.example.test/sites/local-site-supported',
            status: 'streaming',
          }),
        );
        return;
      }
      if (
        req.method === 'GET' &&
        req.url.startsWith(
          '/api/v2/headless/conversations/local-conversation/wait?',
        )
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'completed',
            outcome: 'completed',
            phase: 'brief_review',
            milesMessage: 'Tell me about the site.',
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const { result: supportedLocalResult, json: supportedLocalJson } =
    await runJsonAsync(
      ['site-create', 'Build on this local WordPress site', '--json'],
      {
        milesHome: supportedLocalHome,
        env: { MILES_SERVER_URL: supportedLocalMock.url },
      },
    );
  assert(
    supportedLocalResult.status === 0 &&
      supportedLocalJson.outcome === 'completed',
    'site-create should start and settle a conversation on the active local WordPress site',
  );
  const localCreateRequest = supportedLocalRequests.find(
    (request) =>
      request.method === 'POST' &&
      request.url === '/api/v2/headless/sites',
  );
  assert(
    localCreateRequest?.body?.siteId === 'local-site-supported',
    'local site-create should send the exact active local WordPress site id',
  );
  const supportedLocalCredentials = JSON.parse(
    readFileSync(join(supportedLocalHome, 'credentials.json'), 'utf8'),
  );
  const persistedLocalSite =
    supportedLocalCredentials.sites['local-site-supported'];
  assert(
    supportedLocalCredentials.activeSite === 'local-site-supported' &&
      Object.keys(supportedLocalCredentials.sites).length === 1,
    'local site-create should not create or activate a second cloud site',
  );
  assert(
    persistedLocalSite.conversationId === 'local-conversation' &&
      persistedLocalSite.dashboardUrl === supportedLocalDashboard &&
      persistedLocalSite.connection?.kind === 'local-wordpress',
    'local site-create should persist the conversation while preserving the local dashboard and connection kind',
  );

  const mismatchHome = makeTempDir();
  writeFileSync(
    join(mismatchHome, 'credentials.json'),
    JSON.stringify({
      apiKey: 'mk_live_test_key',
      activeSite: 'local-site-mismatch',
      sites: {
        'local-site-mismatch': {
          siteToken: 'local-site-token',
          name: 'Local Site',
          conversationId: null,
          dashboardUrl:
            'http://local-site.test/wp-admin/admin.php?page=miles',
          siteUrl: 'http://local-site.test',
          localWordPressRoot: '/tmp/local-site',
          connection: { kind: 'local-wordpress' },
        },
      },
    }),
    { mode: 0o600 },
  );
  const mismatchMock = await startMockServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/api/v2/headless/capabilities') {
        sendCapabilities(res, {
          'site-create': {
            tier: 'porcelain',
            connection: 'none',
            operations: { 'local-wordpress': { connection: 'none' } },
          },
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v2/headless/sites') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            siteId: 'cloud-site-999',
            siteToken: 'runaway-site-token',
            conversationId: 'runaway-conversation',
            dashboardUrl: 'https://app.example.test/sites/cloud-site-999',
            status: 'streaming',
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const { result: mismatchResult, json: mismatchJson } = await runJsonAsync(
    ['site-create', 'Build on this local WordPress site', '--json'],
    {
      milesHome: mismatchHome,
      env: { MILES_SERVER_URL: mismatchMock.url },
    },
  );
  assert(
    mismatchResult.status === 2 &&
      mismatchJson.detail?.code === 'unexpected_site_returned' &&
      mismatchJson.detail?.returnedSiteId === 'cloud-site-999' &&
      mismatchJson.detail?.returnedConversationId === 'runaway-conversation',
    'site-create must refuse a mismatched site id and surface the runaway site/conversation ids',
  );
  assertIncludes(
    mismatchJson.error,
    'miles site-attach cloud-site-999',
    'the mismatch refusal should tell the operator how to inspect the runaway site',
  );
  const mismatchCredentials = JSON.parse(
    readFileSync(join(mismatchHome, 'credentials.json'), 'utf8'),
  );
  assert(
    mismatchCredentials.activeSite === 'local-site-mismatch' &&
      Object.keys(mismatchCredentials.sites).length === 1 &&
      mismatchCredentials.sites['local-site-mismatch'].conversationId === null,
    'a mismatched site-create response must not change the active site or adopt the runaway conversation',
  );

  const unreachableHome = makeTempDir();
  writeFileSync(
    join(unreachableHome, 'credentials.json'),
    JSON.stringify({
      apiKey: 'mk_live_test_key',
      activeSite: 'local-site-unreachable',
      sites: {
        'local-site-unreachable': {
          siteToken: 'local-site-token',
          conversationId: null,
          siteUrl: 'http://local-site.test',
          connection: { kind: 'local-wordpress' },
        },
      },
    }),
    { mode: 0o600 },
  );
  const unreachableRequests = [];
  const unreachableMock = await startMockServer((req, res) => {
    unreachableRequests.push({ method: req.method, url: req.url });
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'capabilities backend down' }));
  });
  const { result: unreachableResult, json: unreachableJson } =
    await runJsonAsync(
      ['site-create', 'Build on this local WordPress site', '--json'],
      {
        milesHome: unreachableHome,
        env: { MILES_SERVER_URL: unreachableMock.url },
      },
    );
  assert(
    unreachableResult.status === 2 &&
      unreachableJson.detail?.code === 'capabilities_unreachable' &&
      unreachableJson.detail?.safeToRetry === true,
    'a failed capabilities fetch must fail closed as a retryable outage, not a missing primitive',
  );
  assert(
    unreachableRequests.every(
      (request) => request.url === '/api/v2/headless/capabilities',
    ),
    'a failed capabilities fetch must stop site-create before uploads or site creation',
  );

  const refusedMock = await startMockServer((req, res) => {
    req.resume();
    res.writeHead(404);
    res.end();
  });
  const refusedUrl = refusedMock.url;
  await new Promise((resolveClose) => refusedMock.server.close(resolveClose));
  const { result: refusedResult, json: refusedJson } = await runJsonAsync(
    ['site-create', 'Build on this local WordPress site', '--json'],
    {
      milesHome: unreachableHome,
      env: { MILES_SERVER_URL: refusedUrl },
    },
  );
  assert(
    refusedResult.status === 2 &&
      refusedJson.detail?.code === 'capabilities_unreachable' &&
      refusedJson.detail?.safeToRetry === true,
    'a connection-refused capabilities fetch must also fail closed as retryable',
  );

  const localConnection = runJson(['connect-browser', '--json'], {
    milesHome: unsupportedLocalHome,
  });
  assert(
    localConnection.result.status === 0 &&
      localConnection.json.authenticated === null,
    'connect-browser should not report local WordPress browser authentication as false when it is unobservable',
  );
  assert(
    localConnection.json.pairing?.paired === true &&
      localConnection.json.dashboard?.available === true &&
      localConnection.json.dashboard?.authenticationKnown === false,
    'connect-browser should report pairing and dashboard availability separately',
  );
  assert(
    localConnection.json.realtime?.available === false &&
      localConnection.json.realtime?.connected === null &&
      localConnection.json.realtime?.reason.includes('No conversation'),
    'connect-browser should explain why realtime status is unavailable before a conversation exists',
  );
  const localStateWithoutConversation = runJson(['site-state', '--json'], {
    milesHome: unsupportedLocalHome,
  });
  assert(
    localStateWithoutConversation.result.status === 2,
    'site-state should fail cleanly before a local conversation exists',
  );
  assertIncludes(
    localStateWithoutConversation.json.error,
    'this exact site',
    'site-state should direct a paired local site to safe local site-create rather than site-attach or cloud creation',
  );

  const accountStatusHome = makeTempDir();
  writeFileSync(
    join(accountStatusHome, 'credentials.json'),
    JSON.stringify({ apiKey: 'mk_live_test_key' }),
    { mode: 0o600 },
  );
  const accountStatusMock = await startMockServer((req, res) => {
    req.resume();
    if (req.url === '/api/v2/headless/capabilities') {
      sendCapabilities(res, {
        'account-status': { tier: 'plumbing', connection: 'none' },
      });
      return;
    }
    if (req.url === '/api/v2/headless/account/balance') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          plan: 'test',
          credits: {
            usagePercent: 100,
            monthlyRemainingCredits: 0,
            topUpBalanceCredits: 32512,
            totalSpendableCredits: 32512,
          },
        }),
      );
      return;
    }
    if (req.url === '/api/v2/headless/sites') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sites: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const { result: accountStatusResult, json: accountStatus } =
    await runJsonAsync(['account-status', '--json'], {
      milesHome: accountStatusHome,
      env: { MILES_SERVER_URL: accountStatusMock.url },
    });
  assert(
    accountStatusResult.status === 0 &&
      accountStatus.canBuild === true &&
      accountStatus.buildHeadroom?.source === 'top_up',
    'account-status should derive build readiness from spendable top-up credits even when monthly usage is 100%',
  );
  assertIncludes(
    accountStatus.buildHeadroom.explanation,
    'monthly allowance is exhausted',
    'account-status should explain why a build can still proceed',
  );

  const missingWpCli = join(makeTempDir(), 'missing-wp');
  const noWordPressDir = makeTempDir();
  const noWordPressDetect = runJson([
    'wordpress-detect',
    '--json',
    '--path',
    noWordPressDir,
    '--wp-cli',
    missingWpCli,
  ]);
  assert(
    noWordPressDetect.result.status === 0,
    'wordpress-detect should succeed when no local WordPress install exists',
  );
  assert(
    noWordPressDetect.json.localWordPress.found === false,
    'wordpress-detect should report found false outside WordPress',
  );
  assert(
    noWordPressDetect.json.localWordPress.wpCli.available === false,
    'wordpress-detect should report unavailable configured WP-CLI',
  );

  const noWordPressSetup = runJson([
    'wordpress-setup',
    '--use',
    'local',
    '--json',
    '--path',
    noWordPressDir,
    '--wp-cli',
    missingWpCli,
  ]);
  assert(
    noWordPressSetup.result.status === 0,
    'wordpress-setup should fall back to cloud guidance without requiring auth when no WordPress install is present',
  );
  assert(
    noWordPressSetup.json.mode === 'cloud',
    'wordpress-setup no-WordPress fallback should use cloud mode',
  );

  const fakeWpRoot = makeTempDir();
  mkdirSync(join(fakeWpRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(fakeWpRoot, 'wp-content', 'themes', 'demo'), {
    recursive: true,
  });
  writeFileSync(join(fakeWpRoot, 'wp-config.php'), "<?php\n");
  const fakeWpDetect = runJson([
    'wordpress-detect',
    '--json',
    '--path',
    join(fakeWpRoot, 'wp-content', 'themes', 'demo'),
    '--wp-cli',
    missingWpCli,
  ]);
  assert(
    fakeWpDetect.result.status === 0,
    'wordpress-detect should succeed inside a WordPress tree',
  );
  assert(
    fakeWpDetect.json.localWordPress.found === true &&
      fakeWpDetect.json.localWordPress.root === fakeWpRoot,
    'wordpress-detect should walk up to the WordPress root',
  );
  assert(
    fakeWpDetect.json.localWordPress.next.some((item) =>
      item.includes('Ask the user'),
    ),
    'wordpress-detect should remind agents to ask which WordPress target to use',
  );
  assert(
    fakeWpDetect.json.localWordPress.detectionMode === 'passive',
    'wordpress-detect should report passive detection mode',
  );

  const executableWpCliDir = makeTempDir();
  const executableWpCli = join(executableWpCliDir, 'wp');
  const wpCliMarker = join(executableWpCliDir, 'executed');
  writeFileSync(
    executableWpCli,
    `#!/bin/sh\nprintf executed > "${wpCliMarker}"\nexit 1\n`,
    { mode: 0o755 },
  );
  const passiveDetectWithExecutableWpCli = runJson([
    'wordpress-detect',
    '--json',
    '--path',
    fakeWpRoot,
    '--wp-cli',
    executableWpCli,
  ]);
  assert(
    passiveDetectWithExecutableWpCli.result.status === 0,
    'wordpress-detect should succeed without executing configured WP-CLI',
  );
  assert(
    !existsSync(wpCliMarker),
    'wordpress-detect must not execute WP-CLI before user chooses local setup',
  );
  assert(
    passiveDetectWithExecutableWpCli.json.localWordPress.site.url === null,
    'passive wordpress-detect should not read database-backed site details',
  );

  const fakePluginSource = makeTempDir();
  writeFileSync(
    join(fakePluginSource, 'miles.php'),
    "<?php\n/*\nPlugin Name: Miles\nVersion: 9.9.9-test\n*/\n",
  );
  mkdirSync(join(fakePluginSource, 'dist'), { recursive: true });
  writeFileSync(join(fakePluginSource, 'dist', 'manifest.json'), '{}\n');
  writeFileSync(join(fakePluginSource, '.env.local'), 'SHOULD_NOT_COPY=1\n');
  writeFileSync(join(fakePluginSource, '.gitignore'), "*.log\n");

  const unsupportedBootstrapMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url === '/api/v2/headless/capabilities') {
        sendCapabilities(res, {});
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const unsupportedBootstrapHome = makeTempDir();
  writeFileSync(
    join(unsupportedBootstrapHome, 'credentials.json'),
    JSON.stringify({ apiKey: 'mk_live_test_key' }),
    { mode: 0o600 },
  );
  const unsupportedBootstrapSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      fakeWpRoot,
      '--wp-cli',
      missingWpCli,
    ],
    {
      milesHome: unsupportedBootstrapHome,
      env: {
        MILES_PLUGIN_SOURCE: fakePluginSource,
        MILES_SERVER_URL: unsupportedBootstrapMock.url,
      },
    },
  );
  assert(
    unsupportedBootstrapSetup.result.status === 2,
    'wordpress-setup should refuse local setup when wordpress-bootstrap is unsupported',
  );
  assert(
    unsupportedBootstrapSetup.json.detail?.code === 'primitive_unsupported' &&
      unsupportedBootstrapSetup.json.detail?.primitive === 'wordpress-bootstrap',
    'wordpress-setup unsupported-server JSON should name wordpress-bootstrap',
  );
  assert(
    !existsSync(join(fakeWpRoot, 'wp-content', 'plugins', 'miles', 'miles.php')),
    'wordpress-setup unsupported-server gate must not copy plugin files',
  );

  const wordpressBootstrapMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url === '/api/v2/headless/capabilities') {
        sendCapabilities(res, WORDPRESS_BOOTSTRAP_PRIMITIVE);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const localCopyHome = makeTempDir();
  mkdirSync(localCopyHome, { recursive: true });
  writeFileSync(
    join(localCopyHome, 'credentials.json'),
    JSON.stringify({ apiKey: 'mk_live_test_key' }),
    { mode: 0o600 },
  );
  const localCopySetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      fakeWpRoot,
      '--wp-cli',
      missingWpCli,
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: fakePluginSource,
        MILES_SERVER_URL: wordpressBootstrapMock.url,
      },
    },
  );
  assert(
    localCopySetup.result.status === 2,
    'wordpress-setup should hand off to manual activation when WP-CLI is unavailable',
  );
  assert(
    localCopySetup.json.actions.some((action) => action.action === 'copied-plugin'),
    'wordpress-setup should report the copied plugin action',
  );
  assert(
    existsSync(join(fakeWpRoot, 'wp-content', 'plugins', 'miles', 'miles.php')),
    'wordpress-setup should copy local plugin files into wp-content/plugins/miles',
  );
  assert(
    existsSync(
      join(
        fakeWpRoot,
        'wp-content',
        'plugins',
        'miles',
        'dist',
        'manifest.json',
      ),
    ),
    'wordpress-setup should preserve plugin runtime assets from local plugin sources',
  );
  assert(
    !existsSync(
      join(fakeWpRoot, 'wp-content', 'plugins', 'miles', '.env.local'),
    ) &&
      !existsSync(
        join(fakeWpRoot, 'wp-content', 'plugins', 'miles', '.gitignore'),
      ),
    'wordpress-setup should not copy env or git metadata files into the plugin directory',
  );
  assert(
    localCopySetup.json.actions.some(
      (action) => action.action === 'copied-plugin' && !action.replaced,
    ),
    'wordpress-setup should report when plugin copy did not replace an existing directory',
  );
  assert(
    localCopySetup.json.manualActivationRequired === true,
    'wordpress-setup should mark manual activation as required after copying without WP-CLI',
  );
  assert(
    localCopySetup.json.next.some(
      (step) =>
        step.includes('Ask the user to open') &&
        step.includes('activate the Miles plugin'),
    ),
    'wordpress-setup should ask for user activation in wp-admin when the agent cannot rely on clicks',
  );
  assert(
    localCopySetup.json.next.some((step) =>
      step.includes('After the user confirms activation'),
    ),
    'wordpress-setup should wait for user confirmation before continuing to Miles setup',
  );

  const legacyWpCliDir = makeTempDir();
  const legacyWpCli = join(legacyWpCliDir, 'wp');
  writeFileSync(
    legacyWpCli,
    `#!/bin/sh
case "$*" in
  *"core is-installed") exit 0 ;;
  *"option get siteurl") printf '%s\\n' 'http://legacy.test' ;;
  *"option get blogname") printf '%s\\n' 'Legacy WordPress' ;;
  *"option get admin_email") printf '%s\\n' 'admin@example.test' ;;
  *"core version") printf '%s\\n' '6.8.3' ;;
  *"eval echo wp_get_environment_type();") printf '%s\\n' 'local' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  const incompatiblePluginSource = makeTempDir();
  writeFileSync(
    join(incompatiblePluginSource, 'miles.php'),
    "<?php\n/*\nPlugin Name: Miles\nVersion: 10.0.0-test\nRequires at least: 7.0\n*/\n",
  );
  const incompatibleSourceRoot = makeTempDir();
  mkdirSync(join(incompatibleSourceRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(incompatibleSourceRoot, 'wp-content', 'plugins'), {
    recursive: true,
  });
  writeFileSync(join(incompatibleSourceRoot, 'wp-config.php'), "<?php\n");
  const incompatibleSourceSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      incompatibleSourceRoot,
      '--wp-cli',
      legacyWpCli,
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: incompatiblePluginSource,
        MILES_SERVER_URL: wordpressBootstrapMock.url,
      },
    },
  );
  assert(
    incompatibleSourceSetup.result.status === 2 &&
      incompatibleSourceSetup.json.code ===
        'wordpress_version_unsupported',
    'wordpress-setup should reject an incompatible plugin before copying it',
  );
  assert(
    incompatibleSourceSetup.json.detectedWordPressVersion === '6.8.3' &&
      incompatibleSourceSetup.json.requiredWordPressVersion === '7.0' &&
      incompatibleSourceSetup.json.pluginVersion === '10.0.0-test',
    'WordPress compatibility failures should report detected, required, and plugin versions',
  );
  assert(
    incompatibleSourceSetup.json.wordpressCompatibilityChecked === true,
    'a rejected incompatible plugin should report that the compatibility gate ran',
  );
  assert(
    !existsSync(
      join(
        incompatibleSourceRoot,
        'wp-content',
        'plugins',
        'miles',
        'miles.php',
      ),
    ),
    'an incompatible local plugin source must not be installed',
  );
  assert(
    incompatibleSourceSetup.json.next.some((step) =>
      step.includes('Upgrade WordPress to 7.0 or newer'),
    ),
    'the compatibility failure should provide a specific upgrade recovery',
  );

  const localAppRoot = join(
    makeTempDir(),
    'Local Sites',
    'sample-site',
    'app',
    'public',
  );
  mkdirSync(join(localAppRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(localAppRoot, 'wp-content', 'plugins'), { recursive: true });
  writeFileSync(join(localAppRoot, 'wp-config.php'), "<?php\n");
  const localAppSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      localAppRoot,
      '--wp-cli',
      missingWpCli,
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: fakePluginSource,
        MILES_SERVER_URL: wordpressBootstrapMock.url,
      },
    },
  );
  assert(
    localAppSetup.json.adminPluginsUrl ===
      'http://sample-site.local/wp-admin/plugins.php',
    'wordpress-setup should infer the Local app plugins page URL',
  );
  assert(
    localAppSetup.json.milesAdminUrl ===
      'http://sample-site.local/wp-admin/admin.php?page=miles',
    'wordpress-setup should infer the Local app Miles admin URL',
  );

  const localSitesRoot = join(
    makeTempDir(),
    'Sites',
    'sample-studio',
    'app',
    'public',
  );
  mkdirSync(join(localSitesRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(localSitesRoot, 'wp-content', 'plugins'), { recursive: true });
  writeFileSync(join(localSitesRoot, 'wp-config.php'), "<?php\n");
  const localSitesSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      localSitesRoot,
      '--wp-cli',
      missingWpCli,
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: fakePluginSource,
        MILES_SERVER_URL: wordpressBootstrapMock.url,
      },
    },
  );
  assert(
    localSitesSetup.json.adminPluginsUrl ===
      'http://sample-studio.local/wp-admin/plugins.php',
    'wordpress-setup should infer the plugins page URL for Sites/<site>/app/public roots',
  );
  assert(
    localSitesSetup.json.milesAdminUrl ===
      'http://sample-studio.local/wp-admin/admin.php?page=miles',
    'wordpress-setup should infer the Miles admin URL for Sites/<site>/app/public roots',
  );

  const fakeZipSourceRoot = makeTempDir();
  const fakeZipPluginDir = join(fakeZipSourceRoot, 'miles');
  mkdirSync(fakeZipPluginDir, { recursive: true });
  writeFileSync(
    join(fakeZipPluginDir, 'miles.php'),
    "<?php\n/*\nPlugin Name: Miles\nVersion: 8.8.8-zip-test\n*/\n",
  );
  mkdirSync(join(fakeZipPluginDir, 'dist'), { recursive: true });
  writeFileSync(join(fakeZipPluginDir, 'dist', 'manifest.json'), '{}\n');
  const fakeZipDir = makeTempDir();
  const fakePluginZip = join(fakeZipDir, 'miles.zip');
  execFileSync('zip', ['-qr', fakePluginZip, 'miles'], {
    cwd: fakeZipSourceRoot,
  });
  const incompatibleZipSourceRoot = makeTempDir();
  const incompatibleZipPluginDir = join(incompatibleZipSourceRoot, 'miles');
  mkdirSync(incompatibleZipPluginDir, { recursive: true });
  writeFileSync(
    join(incompatibleZipPluginDir, 'miles.php'),
    "<?php\n/*\nPlugin Name: Miles\nVersion: 10.0.0-zip-test\nRequires at least: 7.0\n*/\n",
  );
  const incompatiblePluginZip = join(fakeZipDir, 'miles-incompatible.zip');
  execFileSync('zip', ['-qr', incompatiblePluginZip, 'miles'], {
    cwd: incompatibleZipSourceRoot,
  });
  const zipInstallMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url === '/api/v2/headless/capabilities') {
        sendCapabilities(res, WORDPRESS_BOOTSTRAP_PRIMITIVE);
        return;
      }
      if (req.url === '/miles.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(readFileSync(fakePluginZip));
        return;
      }
      if (req.url === '/miles-incompatible.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(readFileSync(incompatiblePluginZip));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const zipInstallRoot = makeTempDir();
  mkdirSync(join(zipInstallRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(zipInstallRoot, 'wp-content', 'plugins'), { recursive: true });
  writeFileSync(join(zipInstallRoot, 'wp-config.php'), "<?php\n");
  const zipInstallSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      zipInstallRoot,
      '--wp-cli',
      missingWpCli,
      '--plugin-url',
      `${zipInstallMock.url}/miles.zip`,
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: '',
        MILES_SERVER_URL: zipInstallMock.url,
      },
    },
  );
  assert(
    zipInstallSetup.result.status === 2 &&
      zipInstallSetup.json.manualActivationRequired === true,
    'wordpress-setup should hand off to manual activation after installing a plugin ZIP without WP-CLI',
  );
  assert(
    zipInstallSetup.json.actions.some(
      (action) => action.action === 'installed-plugin-files',
    ),
    'wordpress-setup should report plugin ZIP file installation',
  );
  assert(
    existsSync(join(zipInstallRoot, 'wp-content', 'plugins', 'miles', 'miles.php')),
    'wordpress-setup should install downloaded plugin files into wp-content/plugins/miles',
  );
  assert(
    existsSync(
      join(
        zipInstallRoot,
        'wp-content',
        'plugins',
        'miles',
        'dist',
        'manifest.json',
      ),
    ),
    'wordpress-setup should preserve plugin runtime assets from downloaded plugin ZIPs',
  );

  const incompatibleZipRoot = makeTempDir();
  mkdirSync(join(incompatibleZipRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(incompatibleZipRoot, 'wp-content', 'plugins'), {
    recursive: true,
  });
  writeFileSync(join(incompatibleZipRoot, 'wp-config.php'), "<?php\n");
  const incompatibleZipSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      incompatibleZipRoot,
      '--wp-cli',
      legacyWpCli,
      '--plugin-url',
      `${zipInstallMock.url}/miles-incompatible.zip`,
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: '',
        MILES_SERVER_URL: zipInstallMock.url,
      },
    },
  );
  assert(
    incompatibleZipSetup.result.status === 2 &&
      incompatibleZipSetup.json.code === 'wordpress_version_unsupported',
    'wordpress-setup should inspect a downloaded plugin ZIP before installation',
  );
  assert(
    !existsSync(
      join(
        incompatibleZipRoot,
        'wp-content',
        'plugins',
        'miles',
        'miles.php',
      ),
    ),
    'an incompatible downloaded plugin must not be copied into WordPress',
  );

  const ancestorRoot = makeTempDir();
  const ancestorPluginSource = join(
    ancestorRoot,
    'packages',
    'miles-plugin',
  );
  const ancestorWpRoot = join(ancestorRoot, 'Sites', 'sample-app', 'app', 'public');
  mkdirSync(ancestorPluginSource, { recursive: true });
  writeFileSync(
    join(ancestorPluginSource, 'miles.php'),
    "<?php\n/*\nPlugin Name: Miles\nVersion: 7.7.7-ancestor-test\n*/\n",
  );
  mkdirSync(join(ancestorWpRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(ancestorWpRoot, 'wp-content', 'plugins'), {
    recursive: true,
  });
  writeFileSync(join(ancestorWpRoot, 'wp-config.php'), "<?php\n");
  const ancestorInstallSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      ancestorWpRoot,
      '--wp-cli',
      missingWpCli,
      '--plugin-url',
      `${zipInstallMock.url}/miles.zip`,
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: '',
        MILES_SERVER_URL: zipInstallMock.url,
      },
    },
  );
  assert(
    ancestorInstallSetup.json.localWordPress.plugin.source === null,
    'wordpress-setup should not auto-discover ancestor Miles plugin sources',
  );
  assert(
    ancestorInstallSetup.json.actions.some(
      (action) => action.action === 'installed-plugin-files',
    ),
    'wordpress-setup should use the plugin ZIP when no source override is explicit',
  );
  assertIncludes(
    readFileSync(
      join(ancestorWpRoot, 'wp-content', 'plugins', 'miles', 'miles.php'),
      'utf8',
    ),
    '8.8.8-zip-test',
    'wordpress-setup should install the ZIP plugin rather than an ancestor source',
  );
  assert(
    existsSync(
      join(
        ancestorWpRoot,
        'wp-content',
        'plugins',
        'miles',
        'dist',
        'manifest.json',
      ),
    ),
    'wordpress-setup should preserve runtime assets when installing the ZIP plugin near an ancestor source tree',
  );

  const stalePluginRoot = makeTempDir();
  mkdirSync(join(stalePluginRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(stalePluginRoot, 'wp-content', 'plugins', 'miles'), {
    recursive: true,
  });
  writeFileSync(join(stalePluginRoot, 'wp-config.php'), "<?php\n");
  writeFileSync(
    join(stalePluginRoot, 'wp-content', 'plugins', 'miles', 'miles.php'),
    "<?php\n/*\nPlugin Name: Miles\nVersion: 0.1.0-stale\n*/\n",
  );
  writeFileSync(
    join(stalePluginRoot, 'wp-content', 'plugins', 'miles', 'local-note.txt'),
    'stale local plugin directory',
  );
  const localReplaceSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      stalePluginRoot,
      '--wp-cli',
      missingWpCli,
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: fakePluginSource,
        MILES_SERVER_URL: wordpressBootstrapMock.url,
      },
    },
  );
  assert(
    localReplaceSetup.json.actions.some(
      (action) => action.action === 'copied-plugin' && action.replaced === true,
    ),
    'wordpress-setup should report when plugin copy replaces an existing directory',
  );
  assertIncludes(
    readFileSync(
      join(stalePluginRoot, 'wp-content', 'plugins', 'miles', 'miles.php'),
      'utf8',
    ),
    '9.9.9-test',
    'wordpress-setup should refresh an installed plugin from an explicit local source',
  );

  const failingWpCliDir = makeTempDir();
  const failingWpCli = join(failingWpCliDir, 'wp');
  writeFileSync(
    failingWpCli,
    `#!/bin/sh\nprintf '%s\\n' 'Error establishing a database connection' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  const wpCliFailureRoot = makeTempDir();
  mkdirSync(join(wpCliFailureRoot, 'wp-admin'), { recursive: true });
  mkdirSync(join(wpCliFailureRoot, 'wp-content', 'plugins'), {
    recursive: true,
  });
  writeFileSync(join(wpCliFailureRoot, 'wp-config.php'), "<?php\n");
  const wpCliFailureSetup = await runJsonAsync(
    [
      'wordpress-setup',
      '--use',
      'local',
      '--json',
      '--path',
      wpCliFailureRoot,
      '--wp-cli',
      failingWpCli,
      '--site-url',
      'http://custom-local.test',
    ],
    {
      milesHome: localCopyHome,
      env: {
        MILES_PLUGIN_SOURCE: fakePluginSource,
        MILES_SERVER_URL: wordpressBootstrapMock.url,
      },
    },
  );
  assert(
    wpCliFailureSetup.result.status === 2 &&
      wpCliFailureSetup.json.manualActivationRequired === true,
    'wordpress-setup should fall back to manual activation when WP-CLI cannot bootstrap WordPress',
  );
  assert(
    existsSync(join(wpCliFailureRoot, 'wp-content', 'plugins', 'miles', 'miles.php')),
    'wordpress-setup should still copy plugin files when WP-CLI fails',
  );
  assert(
    wpCliFailureSetup.json.adminPluginsUrl ===
      'http://custom-local.test/wp-admin/plugins.php',
    'wordpress-setup should honor --site-url for manual activation URLs',
  );

  const fakeFullSetupWpCliDir = makeTempDir();
  const fakeFullSetupWpCli = join(fakeFullSetupWpCliDir, 'wp');
  const fakeFullSetupWpLog = join(fakeFullSetupWpCliDir, 'wp.log');
  writeFileSync(
    fakeFullSetupWpCli,
    `#!/bin/sh
path=""
if [ "$#" -gt 0 ]; then
  case "$1" in
    --path=*) path="\${1#--path=}" ; shift ;;
  esac
fi
cmd="$*"
printf '%s\\n' "$cmd" >> "$WP_LOG"
case "$cmd" in
  "core is-installed") exit 0 ;;
  "option get siteurl") printf '%s\\n' 'http://localhost:9988' ;;
  "option get blogname") printf '%s\\n' 'Local Test Site' ;;
  "option get admin_email") printf '%s\\n' 'admin@example.test' ;;
  "core version") printf '%s\\n' '6.5.0' ;;
  "eval echo wp_get_environment_type();") printf '%s\\n' 'local' ;;
  "plugin is-installed miles")
    test -f "$path/wp-content/plugins/miles/miles.php"
    ;;
  "plugin is-active miles")
    test -f "$path/wp-content/plugins/miles/miles.php"
    ;;
  "plugin get miles --field=version") printf '%s\\n' '9.9.9-test' ;;
  "plugin activate miles") exit 0 ;;
  "eval echo wp_is_application_passwords_available() ? \\"1\\" : \\"0\\";") printf '%s\\n' '1' ;;
  "miles local-setup --credentials-stdin --yes --format=json")
    if [ "$FAIL_LOCAL_SETUP" = "1" ]; then
      printf '%s\\n' 'sharedSecret=should-not-leak' >&2
      exit 1
    fi
    if [ "$REPORT_LOCAL_SETUP_FAILURE" = "1" ]; then
      printf '%s\\n' '{"success":false,"message":"Could not verify the application password with ?token=should-not-leak"}'
      exit 0
    fi
    printf '%s\\n' 'notice sharedSecret=should-not-leak'
    printf '%s\\n' '{"success":true,"sharedSecret":"should-not-leak","message":"Connected with ?token=should-not-leak"}'
    ;;
  *) printf 'unexpected wp command: %s\\n' "$cmd" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  const fullSetupHome = makeTempDir();
  writeFileSync(
    join(fullSetupHome, 'credentials.json'),
    JSON.stringify({
      apiKey: 'mk_live_test_key',
      activeSite: 'local-site-1',
      sites: {
        'local-site-1': {
          siteToken: 'existing-site-token',
          conversationId: 'existing-conversation',
          dashboardUrl:
            'http://localhost:9988/wp-admin/admin.php?page=miles',
          siteUrl: 'http://localhost:9988',
          connection: { kind: 'local-wordpress' },
        },
      },
    }),
    { mode: 0o600 },
  );
  let fullSetupBootstrapPayload = null;
  const fullSetupMock = await startMockServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.url === '/api/v2/headless/capabilities') {
        sendCapabilities(res, WORDPRESS_BOOTSTRAP_PRIMITIVE);
        return;
      }
      if (
        req.method === 'POST' &&
        req.url === '/api/v2/headless/wordpress-sites/bootstrap'
      ) {
        fullSetupBootstrapPayload = JSON.parse(body || '{}');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            siteId: 'local-site-1',
            conversationId: 'server-conversation',
            siteToken: 'site-token-1',
            sharedSecret: 'server-secret-1',
            serverUrl: fullSetupMock.url,
            accountId: 'account-1',
            accountEmail: 'user@example.test',
            siteName: 'Local Test Site',
            dashboardUrl: 'https://example.invalid/sites/local-site-1',
            localDashboardUrl:
              'http://localhost:9988/wp-admin/admin.php?page=miles',
            relinked: false,
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const fullSetupResult = await runAsync([
    'wordpress-setup',
    '--use',
    'local',
    '--json',
    '--path',
    fakeWpRoot,
    '--wp-cli',
    fakeFullSetupWpCli,
  ], {
    milesHome: fullSetupHome,
    timeout: 30000,
    env: {
      MILES_PLUGIN_SOURCE: fakePluginSource,
      MILES_SERVER_URL: fullSetupMock.url,
      WP_LOG: fakeFullSetupWpLog,
    },
  });
  let fullSetupJson;
  try {
    fullSetupJson = JSON.parse(fullSetupResult.stdout);
  } catch (err) {
    throw new Error(
      `Expected JSON stdout for full wordpress-setup: ${err.message}\nstatus: ${fullSetupResult.status}\nsignal: ${fullSetupResult.signal}\nerror: ${fullSetupResult.error?.message ?? 'none'}\nstdout:\n${fullSetupResult.stdout}\nstderr:\n${fullSetupResult.stderr}\nwp log:\n${
        existsSync(fakeFullSetupWpLog)
          ? readFileSync(fakeFullSetupWpLog, 'utf8')
          : '<missing>'
      }`,
    );
  }
  assert(fullSetupResult.status === 0, 'wordpress-setup full local setup should succeed');
  assert(
    fullSetupBootstrapPayload?.siteUrl === 'http://localhost:9988',
    'wordpress bootstrap should use the local site URL from WP-CLI',
  );
  assert(
    fullSetupJson.wordpressVersion === '6.5.0' &&
      fullSetupJson.pluginVersion === '9.9.9-test',
    'wordpress-setup success should report the versions used for compatibility checks',
  );
  assert(
    fullSetupJson.wordpressCompatibilityChecked === false,
    'a plugin without a Requires-at-least header must report the compatibility gate as skipped, not passed',
  );
  assert(
    fullSetupJson.setup.success === true,
    'wordpress-setup should preserve sanitized setup success',
  );
  assert(
    fullSetupJson.setup.message === 'Connected with ?token=[redacted]',
    'wordpress-setup should sanitize plugin setup messages before JSON output',
  );
  assert(
    !JSON.stringify(fullSetupJson).includes('should-not-leak'),
    'wordpress-setup JSON output must not include plugin-returned secrets',
  );
  const fullSetupCredentials = JSON.parse(
    readFileSync(join(fullSetupHome, 'credentials.json'), 'utf8'),
  );
  assert(
    fullSetupCredentials.sites['local-site-1'].conversationId ===
      'server-conversation',
    'wordpress-setup relink should recover the server conversation instead of trusting stale local state',
  );
  assert(
    fullSetupJson.activeSite.conversationId === 'server-conversation',
    'wordpress-setup JSON should return the recovered local conversation',
  );

  const failedSetupHome = makeTempDir();
  writeFileSync(
    join(failedSetupHome, 'credentials.json'),
    JSON.stringify({ apiKey: 'mk_live_test_key' }),
    { mode: 0o600 },
  );
  const failedSetupResult = await runAsync([
    'wordpress-setup',
    '--use',
    'local',
    '--json',
    '--path',
    fakeWpRoot,
    '--wp-cli',
    fakeFullSetupWpCli,
  ], {
    milesHome: failedSetupHome,
    timeout: 30000,
    env: {
      FAIL_LOCAL_SETUP: '1',
      MILES_PLUGIN_SOURCE: fakePluginSource,
      MILES_SERVER_URL: fullSetupMock.url,
      WP_LOG: fakeFullSetupWpLog,
    },
  });
  const failedSetupJson = JSON.parse(failedSetupResult.stdout);
  assert(
    failedSetupResult.status === 1,
    'wordpress-setup should fail when plugin local setup fails after bootstrap',
  );
  assertIncludes(
    failedSetupJson.error,
    'local-site-1',
    'wordpress-setup failure should surface the bootstrapped site id for retry/relink',
  );
  assert(
    !failedSetupJson.error.includes('should-not-leak'),
    'wordpress-setup failure output must sanitize WP-CLI stderr',
  );

  const preserveHome = makeTempDir();
  writeFileSync(
    join(preserveHome, 'credentials.json'),
    JSON.stringify({
      apiKey: 'mk_live_test_key',
      activeSite: 'local-site-1',
      sites: {
        'local-site-1': {
          siteToken: 'existing-site-token',
          conversationId: 'existing-conversation',
          dashboardUrl:
            'http://localhost:9988/wp-admin/admin.php?page=miles',
          siteUrl: 'http://localhost:9988',
          connection: { kind: 'local-wordpress' },
        },
      },
    }),
    { mode: 0o600 },
  );
  const preserveMock = await startMockServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/api/v2/headless/capabilities') {
        sendCapabilities(res, WORDPRESS_BOOTSTRAP_PRIMITIVE);
        return;
      }
      if (
        req.method === 'POST' &&
        req.url === '/api/v2/headless/wordpress-sites/bootstrap'
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            siteId: 'local-site-1',
            siteToken: 'site-token-1',
            sharedSecret: 'server-secret-1',
            serverUrl: preserveMock.url,
            siteName: 'Local Test Site',
            dashboardUrl: 'https://example.invalid/sites/local-site-1',
            localDashboardUrl:
              'http://localhost:9988/wp-admin/admin.php?page=miles',
            relinked: true,
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const preserveResult = await runJsonAsync([
    'wordpress-setup',
    '--use',
    'local',
    '--json',
    '--path',
    fakeWpRoot,
    '--wp-cli',
    fakeFullSetupWpCli,
  ], {
    milesHome: preserveHome,
    timeout: 30000,
    env: {
      MILES_PLUGIN_SOURCE: fakePluginSource,
      MILES_SERVER_URL: preserveMock.url,
      WP_LOG: fakeFullSetupWpLog,
    },
  });
  assert(
    preserveResult.result.status === 0 && preserveResult.json.ok === true,
    'wordpress-setup rerun should succeed when the bootstrap response has no conversationId',
  );
  const preserveCredentials = JSON.parse(
    readFileSync(join(preserveHome, 'credentials.json'), 'utf8'),
  );
  assert(
    preserveCredentials.sites['local-site-1'].conversationId ===
      'existing-conversation' &&
      preserveResult.json.activeSite.conversationId ===
        'existing-conversation',
    'wordpress-setup rerun must preserve the existing local conversation when the server omits one',
  );

  const reportedFailureHome = makeTempDir();
  writeFileSync(
    join(reportedFailureHome, 'credentials.json'),
    JSON.stringify({ apiKey: 'mk_live_test_key' }),
    { mode: 0o600 },
  );
  const reportedFailureResult = await runJsonAsync([
    'wordpress-setup',
    '--use',
    'local',
    '--json',
    '--path',
    fakeWpRoot,
    '--wp-cli',
    fakeFullSetupWpCli,
  ], {
    milesHome: reportedFailureHome,
    timeout: 30000,
    env: {
      REPORT_LOCAL_SETUP_FAILURE: '1',
      MILES_PLUGIN_SOURCE: fakePluginSource,
      MILES_SERVER_URL: fullSetupMock.url,
      WP_LOG: fakeFullSetupWpLog,
    },
  });
  assert(
    reportedFailureResult.result.status === 1 &&
      reportedFailureResult.json.ok === false &&
      reportedFailureResult.json.code === 'plugin_setup_failed' &&
      reportedFailureResult.json.setup?.success === false,
    'wordpress-setup must report ok:false when the plugin setup command reports failure',
  );
  assert(
    reportedFailureResult.json.siteId === 'local-site-1' &&
      reportedFailureResult.json.next?.[0]?.includes('relink'),
    'a reported plugin setup failure should keep the bootstrapped site id and point at the relink rerun',
  );
  assert(
    !JSON.stringify(reportedFailureResult.json).includes('should-not-leak'),
    'a reported plugin setup failure must sanitize plugin-returned secrets',
  );
  const reportedFailureCredentials = JSON.parse(
    readFileSync(join(reportedFailureHome, 'credentials.json'), 'utf8'),
  );
  assert(
    reportedFailureCredentials.sites?.['local-site-1']?.siteToken ===
      'site-token-1',
    'a reported plugin setup failure should still persist the site record so rerun can relink',
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
  const invalidHomeParent = makeTempDir();
  const invalidHomeFile = join(invalidHomeParent, 'not-a-directory');
  writeFileSync(invalidHomeFile, 'blocked');
  const invalidDoctor = runJson(['doctor', '--json'], {
    milesHome: join(invalidHomeFile, 'miles-home'),
  });
  const invalidHomeCheck = invalidDoctor.json.checks.find(
    (check) => check.name === 'milesHome',
  );
  assert(
    invalidDoctor.result.status === 1 &&
      invalidHomeCheck?.ok === false &&
      invalidHomeCheck?.code === 'filesystem_not_writable' &&
      invalidHomeCheck?.retryOutsideSandbox === false &&
      invalidHomeCheck?.remediation,
    'doctor should return structured remediation for a real filesystem path failure',
  );

  // A read-only parent makes the MILES_HOME mkdir fail with EACCES for
  // non-root users, which is the write-denial shape host sandboxes produce.
  // Root ignores mode bits, so skip the probe-based classification checks.
  const isRoot =
    typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isRoot) {
    const readOnlyParent = makeTempDir();
    chmodSync(readOnlyParent, 0o555);
    const deniedHome = join(readOnlyParent, 'miles-home');
    const agentEnvOff = {
      CLAUDECODE: '',
      CLAUDE_CODE: '',
      CODEX_SANDBOX: '',
      CURSOR_AGENT: '',
    };
    const sandboxDoctor = runJson(['doctor', '--json'], {
      milesHome: deniedHome,
      env: { ...agentEnvOff, CLAUDECODE: '1' },
    });
    const sandboxHomeCheck = sandboxDoctor.json.checks.find(
      (check) => check.name === 'milesHome',
    );
    assert(
      sandboxHomeCheck?.ok === false &&
        sandboxHomeCheck?.code === 'host_sandbox_denied' &&
        sandboxHomeCheck?.retryOutsideSandbox === true &&
        sandboxHomeCheck?.sandboxDetected === true,
      'doctor should classify a write denial under Claude Code (CLAUDECODE) as host_sandbox_denied',
    );
    const plainDeniedDoctor = runJson(['doctor', '--json'], {
      milesHome: deniedHome,
      env: agentEnvOff,
    });
    const plainDeniedCheck = plainDeniedDoctor.json.checks.find(
      (check) => check.name === 'milesHome',
    );
    assert(
      plainDeniedCheck?.ok === false &&
        plainDeniedCheck?.code === 'filesystem_not_writable' &&
        plainDeniedCheck?.retryOutsideSandbox === false,
      'doctor should keep a write denial outside any agent host as filesystem_not_writable',
    );
    chmodSync(readOnlyParent, 0o755);
  }

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

  const jsonReconnectHome = makeTempDir();
  writeFileSync(
    join(jsonReconnectHome, 'credentials.json'),
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
  const jsonReconnectMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'dashboard_connection_required',
          error: 'Dashboard connection required.',
        }),
      );
    });
  });
  const { result: jsonReconnectResult, json: jsonReconnect } =
    await runJsonAsync(['--json', 'say', 'Make the form wider'], {
      milesHome: jsonReconnectHome,
      env: { MILES_SERVER_URL: jsonReconnectMock.url },
    });
  assert(
    jsonReconnectResult.status === 3,
    'global --json say should preserve the need_connection exit code',
  );
  assert(
    jsonReconnect.detail?.code === 'need_connection' &&
      jsonReconnect.detail?.dashboardUrl ===
        'https://beta.bymiles.ai/sites/site-1?agent=true',
    'global --json say should return structured recovery details',
  );

  const { result: commandJsonReconnectResult, json: commandJsonReconnect } =
    await runJsonAsync(['say', 'Make the form wider', '--json'], {
      milesHome: jsonReconnectHome,
      env: { MILES_SERVER_URL: jsonReconnectMock.url },
    });
  assert(
    commandJsonReconnectResult.status === 3 &&
      commandJsonReconnect.detail?.code === 'need_connection',
    'command-local say --json should return structured recovery details',
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

  const { result: buildJsonResult, json: buildJson } = await runJsonAsync(
    ['build-site', '--design', '1', '--json'],
    {
      milesHome: buildHome,
      env: { MILES_SERVER_URL: buildMock.url },
    },
  );
  assert(
    buildJsonResult.status === 0,
    'build-site --json should complete headlessly',
  );
  assert(
    buildJson.outcome === 'completed' && buildJson.milesMessage === 'Site built.',
    'build-site --json should return the structured settled wait result',
  );
  assert(
    !buildJsonResult.stdout.includes('Selecting design direction') &&
      !buildJsonResult.stdout.includes('Design 1 selected.'),
    'build-site --json should keep progress prose out of stdout',
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
          code: 'user_declined_plugin_install',
          errorId: 'err-declined-1',
          recovery: ['Respect the decline and do not retry.'],
          milesMessage: 'Understood, skipping that.',
          directionCount: 2,
          directionTotal: 4,
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-3',
          sessionMemory: [
            {
              key: 'wp-rest-agent',
              status: 'blocked',
              summary: 'Plugin install declined',
              unresolved: ['User declined the plugin install'],
              nextRecommendedAction: 'Ask for a different target.',
            },
          ],
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
  assert(
    waitJobJson.code === 'user_declined_plugin_install' &&
      waitJobJson.errorId === 'err-declined-1',
    'wait-job should pass through server recovery identifiers',
  );
  assert(
    waitJobJson.recovery?.[0] === 'Respect the decline and do not retry.' &&
      waitJobJson.sessionMemory?.[0]?.nextRecommendedAction ===
        'Ask for a different target.',
    'wait-job should pass through recovery steps and session memory',
  );
  assert(
    waitJobJson.directionCount === 2 &&
      waitJobJson.directionTotal === 4 &&
      waitJobJson.dashboardUrl === 'https://beta.bymiles.ai/sites/site-3',
    'wait-job should pass through progress counts and dashboard URL',
  );

  // Completed conversion progress may remain the latest data part during a
  // later edit. It must not be presented as current work.
  const staleProgressHome = makeTempDir();
  writeFileSync(
    join(staleProgressHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-stale-progress',
      sites: {
        'site-stale-progress': {
          siteToken: 'site-token',
          conversationId: 'conversation-stale-progress',
        },
      },
    }),
  );
  let staleProgressPollCount = 0;
  const staleProgressMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      staleProgressPollCount += 1;
      if (staleProgressPollCount === 1) {
        res.end(
          JSON.stringify({
            status: 'running',
            phase: 'editing',
            progress: {
              type: 'data-conversion-progress',
              data: {
                phases: [
                  {
                    id: 'theme',
                    label: 'Converting to WordPress theme',
                    status: 'complete',
                  },
                ],
              },
            },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          status: 'completed',
          outcome: 'completed',
          phase: 'complete',
          milesMessage: 'Navigation updated.',
        }),
      );
    });
  });
  const staleProgressResult = await runAsync(['wait-job'], {
    milesHome: staleProgressHome,
    env: { MILES_SERVER_URL: staleProgressMock.url },
  });
  assert(
    staleProgressResult.status === 0,
    `wait-job should settle after stale progress\nstatus: ${staleProgressResult.status}\nstderr:\n${staleProgressResult.stderr}`,
  );
  assert(
    staleProgressResult.stderr.includes('phase: editing') &&
      !staleProgressResult.stderr.includes('Converting to WordPress theme'),
    `wait-job should suppress completed conversion progress\nstderr:\n${staleProgressResult.stderr}`,
  );

  // wait-job surfaces live-protection approvals as blocked structured state,
  // with sensitive/internal action details sanitized from public output.
  const approvalWaitHome = makeTempDir();
  writeFileSync(
    join(approvalWaitHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-approval',
      sites: {
        'site-approval': {
          siteToken: 'site-token',
          conversationId: 'conversation-approval',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-approval',
        },
      },
    }),
  );
  const approvalWaitMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'waiting_for_input',
          outcome: 'blocked',
          outcomeUnresolved: ['Approval required: Publish content changes'],
          phase: 'complete',
          approvalRequired: {
            type: 'live_protection',
            grantId: 'grant-approval',
            category: 'content.publish\nBearer category-secret',
            riskTier: 0,
            summary:
              'Publish content changes with ?token=example-value in the source URL',
            actions: [
              {
                scope: 'content.publish',
                summary:
                  'Publish edited page via /wp/v2/pages/42?token=example-value',
                method: 'POST',
                path: '/wp/v2/pages/42?token=example-value',
              },
            ],
            timestamp: 1_234_567_890,
          },
        }),
      );
    });
  });
  const approvalWaitResult = await runAsync(['wait-job'], {
    milesHome: approvalWaitHome,
    env: { MILES_SERVER_URL: approvalWaitMock.url },
  });
  assert(
    approvalWaitResult.status === 4,
    `wait-job should exit 4 when approval is required\nstatus: ${approvalWaitResult.status}\nstdout:\n${approvalWaitResult.stdout}`,
  );
  const approvalWaitJson = JSON.parse(approvalWaitResult.stdout);
  assert(
    approvalWaitJson.ok === false &&
      approvalWaitJson.approvalRequired?.grantId === 'grant-approval',
    'wait-job should include sanitized approval metadata',
  );
  assert(
    approvalWaitJson.approvalRequired.actions[0].scope === 'content.publish',
    'wait-job should preserve safe approval action scope',
  );
  assert(
    approvalWaitJson.approvalRequired.category ===
      'content.publish Bearer [redacted]',
    'wait-job should sanitize approval category before JSON output',
  );
  assert(
    approvalWaitJson.approvalRequired.riskTier === 0,
    'wait-job should preserve risk tier 0 if the server sends it',
  );
  assert(
    !approvalWaitResult.stdout.includes('example-value') &&
      !approvalWaitResult.stdout.includes('category-secret') &&
      !approvalWaitResult.stdout.includes('"path"') &&
      !approvalWaitResult.stdout.includes('"method"'),
    'wait-job approval JSON should not expose secrets or raw HTTP details',
  );

  // site-state carries the same approval metadata and points agents at the
  // explicit response primitive rather than ordinary say.
  const approvalStateHome = makeTempDir();
  writeFileSync(
    join(approvalStateHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-approval-state',
      sites: {
        'site-approval-state': {
          siteToken: 'site-token',
          conversationId: 'conversation-approval-state',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-approval-state',
        },
      },
    }),
  );
  const approvalStateMock = await startMockServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.includes('/status')) {
        res.end(
          JSON.stringify({
            status: 'waiting_for_input',
            phase: 'complete',
            conversationStatus: 'waiting_for_user_input',
            code: 'approval_required',
            errorId: 'err-approval-state',
            recovery: ['Ask the user to approve or decline.'],
            directionTotal: 1,
            progress: { action: 'Awaiting approval' },
            undoTurnIndex: 7,
            isSiteBuildingActive: false,
            next: ['approval-respond'],
            approvalRequired: {
              type: 'live_protection',
              grantId: 'grant-state',
              summary: 'Publish content changes',
              actions: [{ summary: 'Publish edited page' }],
            },
          }),
        );
        return;
      }
      if (req.url.includes('/design-directions')) {
        res.end(JSON.stringify({ directions: [] }));
        return;
      }
      if (req.url.includes('/ws-status')) {
        res.end(JSON.stringify({ connected: false }));
        return;
      }
      res.end(JSON.stringify({}));
    });
  });
  const { result: approvalStateResult, json: approvalState } =
    await runJsonAsync(['site-state', '--json'], {
      milesHome: approvalStateHome,
      env: { MILES_SERVER_URL: approvalStateMock.url },
    });
  assert(
    approvalStateResult.status === 0,
    'site-state --json should succeed while approval is pending',
  );
  assert(
    approvalState.approvalRequired?.grantId === 'grant-state',
    'site-state should expose the active approval grant',
  );
  assert(
    approvalState.next.some((hint) => hint.includes('approval-respond')) &&
      !approvalState.next.some((hint) => hint.startsWith('miles say')),
    'site-state next[] should route approval through approval-respond, not say',
  );
  assert(
    approvalState.code === 'approval_required' &&
      approvalState.errorId === 'err-approval-state' &&
      approvalState.recovery?.[0] === 'Ask the user to approve or decline.' &&
      approvalState.directionTotal === 1 &&
      approvalState.progress?.action === 'Awaiting approval' &&
      approvalState.undoTurnIndex === 7 &&
      approvalState.isSiteBuildingActive === false,
    'site-state should pass through recovery and status detail fields',
  );

  // site-plan exposes the complete current contract and can reconstruct
  // deduplicated revisions from sanitized history without losing result refs.
  const sitePlanHome = makeTempDir();
  writeFileSync(
    join(sitePlanHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-plan-site',
      sites: {
        'site-plan-site': {
          siteToken: 'site-token',
          conversationId: 'conversation-site-plan',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-plan-site',
        },
      },
    }),
  );
  const planV1 = {
    id: 'site-completion-plan',
    items: [
      {
        id: 'foundation',
        title: 'Visual system and homepage',
        description: 'The visual system and editable homepage are complete.',
        category: 'content',
        status: 'pending',
        source: 'brief',
        curated: true,
      },
    ],
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z',
  };
  const planV2 = {
    ...planV1,
    items: [
      {
        ...planV1.items[0],
        status: 'completed',
        resultRef: {
          pageId: 42,
          pageSlug: 'home',
          sectionMarker: 'miles-sec-home',
          patternId: 99,
          designArtifactKind: 'wordpress-theme',
          designArtifactVersion: 2,
          designArtifactId: 'artifact-home',
          designArtifactItemKey: 'home:hero',
          entityType: 'wp_template',
          entityId: 'theme//home',
        },
      },
      {
        id: 'contact-form',
        title: 'Connect the contact form',
        description: 'The contact form will send real messages.',
        category: 'form',
        status: 'pending',
        source: 'generation',
        curated: false,
        resultRef: {
          intent: 'Connect the contact form to a message delivery workflow',
          evidence: 'Static form controls are present in the contact section',
        },
      },
    ],
    updatedAt: '2026-07-20T10:05:00.000Z',
  };
  const sitePlanRequests = [];
  const sitePlanMock = await startMockServer((req, res) => {
    sitePlanRequests.push(req.url);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/v2/headless/capabilities') {
      res.end(
        JSON.stringify({
          primitives: {
            'site-state': {
              tier: 'plumbing',
              connection: 'none',
              operations: { full: { connection: 'none' } },
            },
            history: { tier: 'plumbing', connection: 'none' },
          },
        }),
      );
      return;
    }
    if (
      req.url ===
      '/api/v2/headless/conversations/conversation-site-plan/state'
    ) {
      res.end(
        JSON.stringify({
          phase: 'complete',
          status: 'idle',
          siteCompletionPlan: planV2,
        }),
      );
      return;
    }
    if (
      req.url ===
      '/api/v2/headless/conversations/conversation-site-plan/history?limit=100&offset=0'
    ) {
      res.end(
        JSON.stringify({
          total: 3,
          offset: 0,
          limit: 100,
          messages: [
            {
              id: 'message-plan-1',
              role: 'assistant',
              parts: [
                { type: 'data-site-completion-plan', data: planV1 },
              ],
            },
            {
              id: 'message-plan-duplicate',
              role: 'assistant',
              parts: [
                { type: 'data-site-completion-plan', data: planV1 },
              ],
            },
            {
              id: 'message-plan-2',
              role: 'assistant',
              parts: [
                { type: 'data-site-completion-plan', data: planV2 },
              ],
            },
          ],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const { result: sitePlanResult, json: sitePlan } = await runJsonAsync(
    ['site-plan', '--history', '--json'],
    {
      milesHome: sitePlanHome,
      env: { MILES_SERVER_URL: sitePlanMock.url },
    },
  );
  assert(
    sitePlanResult.status === 0,
    'site-plan --history --json should return the complete plan',
  );
  assert(
    sitePlan.siteCompletionPlan.items[0].resultRef.designArtifactItemKey ===
      'home:hero',
    'site-plan should preserve the current plan result reference contract',
  );
  assert(
    sitePlan.summary.total === 2 &&
      sitePlan.summary.statuses.completed === 1 &&
      sitePlan.summary.uncurated === 1,
    'site-plan should summarize current status and curation state',
  );
  assert(
    sitePlan.revisions.length === 2,
    'site-plan history should deduplicate repeated plan snapshots',
  );
  assert(
    sitePlan.revisions[1].changes.added[0] === 'contact-form' &&
      sitePlan.revisions[1].changes.changed[0].id === 'foundation' &&
      sitePlan.revisions[1].changes.changed[0].changedFields.includes(
        'status',
      ) &&
      sitePlan.revisions[1].changes.changed[0].changedFields.includes(
        'resultRef',
      ),
    'site-plan history should expose item additions and changed fields',
  );
  assert(
    sitePlan.revisions[1].siteCompletionPlan.items[1].resultRef.evidence ===
      'Static form controls are present in the contact section',
    'site-plan history should retain the full plan snapshot, including uncurated evidence',
  );

  const historyRequestCount = sitePlanRequests.filter((url) =>
    url.includes('/history?'),
  ).length;
  const currentSitePlan = await runJsonAsync(['site-plan', '--json'], {
    milesHome: sitePlanHome,
    env: { MILES_SERVER_URL: sitePlanMock.url },
  });
  assert(
    currentSitePlan.result.status === 0 &&
      currentSitePlan.json.siteCompletionPlan.items.length === 2,
    'site-plan --json should expose the current plan without requiring history',
  );
  assert(
    sitePlanRequests.filter((url) => url.includes('/history?')).length ===
      historyRequestCount,
    'current-only site-plan reads should not fetch conversation history',
  );

  const sitePlanHuman = await runAsync(['site-plan'], {
    milesHome: sitePlanHome,
    env: { MILES_SERVER_URL: sitePlanMock.url },
  });
  assertIncludes(
    sitePlanHuman.stdout,
    'The visual system and editable homepage are complete.',
    'site-plan human output should include the full item description',
  );
  assertIncludes(
    sitePlanHuman.stdout,
    'designArtifactItemKey',
    'site-plan human output should include durable result references',
  );
  assert(
    !sitePlanHuman.stdout.includes(
      'Connect the contact form to a message delivery workflow',
    ),
    'site-plan human output must not paint uncurated machine intent as user copy',
  );

  // A server may return fewer messages per page than requested; the history
  // walk must follow offset/total instead of assuming one page holds all.
  const pagedPlanMessages = [
    {
      id: 'message-plan-1',
      role: 'assistant',
      parts: [{ type: 'data-site-completion-plan', data: planV1 }],
    },
    {
      id: 'message-plan-duplicate',
      role: 'assistant',
      parts: [{ type: 'data-site-completion-plan', data: planV1 }],
    },
    {
      id: 'message-plan-2',
      role: 'assistant',
      parts: [{ type: 'data-site-completion-plan', data: planV2 }],
    },
  ];
  const pagedPlanHistoryRequests = [];
  const pagedPlanMock = await startMockServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/v2/headless/capabilities') {
      res.end(
        JSON.stringify({
          primitives: {
            'site-state': {
              tier: 'plumbing',
              connection: 'none',
              operations: { full: { connection: 'none' } },
            },
            history: { tier: 'plumbing', connection: 'none' },
          },
        }),
      );
      return;
    }
    if (
      req.url ===
      '/api/v2/headless/conversations/conversation-site-plan/state'
    ) {
      res.end(
        JSON.stringify({
          phase: 'complete',
          status: 'idle',
          siteCompletionPlan: planV2,
        }),
      );
      return;
    }
    const pageMatch = req.url.match(
      /\/conversations\/conversation-site-plan\/history\?limit=\d+&offset=(\d+)$/,
    );
    if (pageMatch) {
      const offset = Number(pageMatch[1]);
      pagedPlanHistoryRequests.push(offset);
      res.end(
        JSON.stringify({
          total: pagedPlanMessages.length,
          offset,
          limit: 100,
          messages: pagedPlanMessages.slice(offset, offset + 1),
        }),
      );
      return;
    }
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const pagedSitePlan = await runJsonAsync(
    ['site-plan', '--history', '--json'],
    {
      milesHome: sitePlanHome,
      env: { MILES_SERVER_URL: pagedPlanMock.url },
    },
  );
  assert(
    pagedSitePlan.result.status === 0 &&
      pagedSitePlan.json.revisions.length === 2 &&
      pagedSitePlan.json.revisions[1].changes.added[0] === 'contact-form',
    'site-plan --history must reconstruct all revisions when history arrives one message per page',
  );
  assert(
    pagedPlanHistoryRequests.join(',') === '0,1,2',
    'site-plan --history must page through offsets until total is reached, without over-fetching',
  );

  // approval-respond is an explicit grant response primitive. It cannot be
  // shortened to automation-style --yes/--force flags.
  const shortcutResult = run([
    'approval-respond',
    '--grant',
    'grant-approval',
    '--response',
    'approved',
    '--yes',
  ]);
  assert(
    shortcutResult.status === 2,
    'approval-respond should reject auto-approval shortcut flags',
  );
  assertIncludes(
    shortcutResult.stderr,
    'not allowed',
    'approval-respond shortcut rejection should explain the guard',
  );

  const approvalRespondHome = makeTempDir();
  writeFileSync(
    join(approvalRespondHome, 'credentials.json'),
    JSON.stringify({
      activeSite: 'site-respond',
      sites: {
        'site-respond': {
          siteToken: 'site-token',
          conversationId: 'conversation-respond',
          dashboardUrl: 'https://beta.bymiles.ai/sites/site-respond',
        },
      },
    }),
  );
  const approvalRespondRequests = [];
  const approvalRespondMock = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      approvalRespondRequests.push({
        method: req.method,
        url: req.url,
        body: body ? JSON.parse(body) : null,
      });

      if (req.url === '/api/v2/headless/capabilities') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            primitives: {
              'approval-respond': { tier: 'plumbing', connection: 'conditional' },
            },
          }),
        );
        return;
      }
      if (
        req.url ===
        '/api/v2/headless/conversations/conversation-respond/approval-response'
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            conversationId: 'conversation-respond',
            status: 'streaming',
            sinceMessageId: 'assistant-approval',
          }),
        );
        return;
      }
      if (req.url.includes('/wait')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'completed',
            outcome: 'completed',
            phase: 'complete',
            milesMessage: 'Done.',
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const { result: approvalRespondResult, json: approvalRespondJson } =
    await runJsonAsync(
      [
        'approval-respond',
        '--grant',
        'grant-approval',
        '--response',
        'approved',
        '--json',
      ],
      {
        milesHome: approvalRespondHome,
        env: { MILES_SERVER_URL: approvalRespondMock.url },
      },
    );
  assert(
    approvalRespondResult.status === 0,
    `approval-respond should settle after posting the grant response\nstdout:\n${approvalRespondResult.stdout}\nstderr:\n${approvalRespondResult.stderr}`,
  );
  assert(
    approvalRespondJson.outcome === 'completed',
    'approval-respond --json should reuse the settled wait-job payload',
  );
  assert(
    approvalRespondRequests.some(
      (request) =>
        request.method === 'POST' &&
        request.url ===
          '/api/v2/headless/conversations/conversation-respond/approval-response' &&
        request.body?.grantId === 'grant-approval' &&
        request.body?.response === 'approved',
    ),
    'approval-respond should post the exact grant id and explicit response',
  );
  assert(
    approvalRespondRequests.some(
      (request) =>
        request.method === 'GET' &&
        request.url.includes('/wait?') &&
        request.url.includes('sinceMessageId=assistant-approval'),
    ),
    'approval-respond --json should wait from the approval response boundary',
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
    'hook',
  ]);
  assert(
    unsupportedJsonResult.status === 2,
    'global --json should still be rejected on non-JSON helper commands',
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
