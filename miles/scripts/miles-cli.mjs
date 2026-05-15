#!/usr/bin/env -S node --experimental-websocket

/**
 * Miles CLI - Conversation transport for external AI agents.
 *
 * Zero-dependency Node.js ES module (uses built-in fetch, fs, child_process).
 * Wraps the Miles headless REST API for agent-to-agent workflows.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import {
  buildDevicePollingRateLimitMessage,
  buildDevicePollingTimeoutMessage,
  getDeviceAuthPollingPlan,
  getSlowedDeviceAuthPollIntervalMs,
  parseRetryAfterSeconds,
} from './login-polling.mjs';

// ============================================================================
// Config
// ============================================================================

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DEFAULT_SKILL_DIR = resolve(SCRIPT_DIR, '..');
const MILES_SKILL_DIR =
  process.env.MILES_SKILL_DIR || process.env.CLAUDE_SKILL_DIR || DEFAULT_SKILL_DIR;
const MILES_CLI = process.env.MILES_CLI || SCRIPT_PATH;

function expandHomePath(path) {
  if (!path) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

const MILES_HOME = resolve(
  expandHomePath(process.env.MILES_HOME || join(homedir(), '.miles')),
);
const CREDENTIALS_DIR = MILES_HOME;
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');
const LAST_RESPONSE_FILE = join(CREDENTIALS_DIR, 'last-response');
const SCREENSHOTS_DIR = join(CREDENTIALS_DIR, 'screenshots');
const DEFAULT_SERVER_URL = 'https://api.bymiles.ai';
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
const POLL_TIMEOUT_MS = 10000; // 10 second poll for faster progress updates
const ERROR_BODY_MAX_CHARS = 2048;
const DASHBOARD_CONNECT_TIMEOUT_MS = 30000;
const PLAYGROUND_CONNECT_TIMEOUT_MS = 60000;
const JSON_COMMANDS = new Set([
  'doctor',
  'logout',
  'whoami',
  'status',
  'design-directions',
  'screenshot',
  'sites',
  'use',
  'preview',
  'balance',
  'messages',
  'export-theme',
  'export-site',
]);

let cliOptions = { json: false };

// Track hero preview statuses across data parts for aggregate progress display
const heroProgressTracker = new Map();

// ============================================================================
// Credential management
// ============================================================================

function loadCredentials() {
  if (!existsSync(CREDENTIALS_FILE)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Could not read Miles credentials at ${CREDENTIALS_FILE}: ${err.message}`,
    );
  }
}

function saveCredentials(creds) {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
}

function getActiveSite(creds) {
  if (!creds.activeSite || !creds.sites?.[creds.activeSite]) return null;
  return { id: creds.activeSite, ...creds.sites[creds.activeSite] };
}

function writeLastResponse(text) {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(LAST_RESPONSE_FILE, text);
}

function emitJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function exitWithError(message, status = 1, detail = null) {
  if (cliOptions.json) {
    const payload = { ok: false, error: message };
    if (detail !== null) payload.detail = detail;
    emitJson(payload);
  } else {
    console.error(message);
  }
  process.exit(status);
}

function parseGlobalArgs(argv) {
  const globalJson = argv[0] === '--json';
  const rawCommand = globalJson ? argv[1] : argv[0];
  const rawArgs = globalJson ? argv.slice(2) : argv.slice(1);
  const commandSupportsJson = JSON_COMMANDS.has(rawCommand);
  const argsContainJson = commandSupportsJson && rawArgs.includes('--json');
  const json = commandSupportsJson && (globalJson || argsContainJson);

  if (globalJson && !commandSupportsJson) {
    return {
      command: rawCommand,
      args: rawArgs,
      options: {
        json: true,
        unsupportedJson: true,
      },
    };
  }

  return {
    command: rawCommand,
    args: json ? rawArgs.filter((arg) => arg !== '--json') : rawArgs,
    options: { json, unsupportedJson: false },
  };
}

function hasCommandFlag(args, flag) {
  return args.includes(flag);
}

function findPositiveIntegerArg(args) {
  const value = args.find((arg) => /^\d+$/.test(arg));
  return value ? parseInt(value, 10) : null;
}

function getDashboardUrl(site) {
  return `${site.dashboardUrl}?agent=true`;
}

function getDashboardRedirectPath(dashboardUrl) {
  const parsed = new URL(dashboardUrl);
  return `${parsed.pathname}${parsed.search}`;
}

async function getAuthenticatedDashboardUrl(apiKey, serverUrl, dashboardUrl) {
  if (!apiKey) return null;
  try {
    const data = await apiRequest(
      'POST',
      '/api/v2/headless/auth/session-link',
      {
        auth: apiKey,
        body: { redirect: getDashboardRedirectPath(dashboardUrl) },
        serverUrl,
      },
    );
    return typeof data.url === 'string' && data.url ? data.url : null;
  } catch {
    return null;
  }
}

async function getDashboardOpenUrl(creds, site, serverUrl) {
  const dashboardUrl = getDashboardUrl(site);
  const authenticatedUrl = await getAuthenticatedDashboardUrl(
    creds.apiKey,
    serverUrl,
    dashboardUrl,
  );
  return {
    dashboardUrl,
    url: authenticatedUrl || dashboardUrl,
    authenticated: Boolean(authenticatedUrl),
  };
}

async function getDashboardConnectionStatus(site, serverUrl) {
  const status = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/ws-status`,
    { auth: site.siteToken, serverUrl },
  );
  return Boolean(status.connected);
}

async function waitForDashboardConnection(
  site,
  serverUrl,
  timeoutMs = DASHBOARD_CONNECT_TIMEOUT_MS,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await getDashboardConnectionStatus(site, serverUrl)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function exitWithDashboardConnectionRequired(site, timeoutMs = null) {
  const dashboardUrl = getDashboardUrl(site);
  const prefix =
    timeoutMs === null
      ? 'Dashboard connection required before this browser-backed operation.'
      : `Dashboard did not connect within ${timeoutMs / 1000}s.`;
  exitWithError(
    `${prefix} Run \`miles preview --json\`, open the returned authenticated url in your agent browser or regular browser, then retry the same command.`,
    1,
    {
      code: 'dashboard_connection_required',
      dashboardUrl,
    },
  );
}

function getActiveSiteSummary(creds) {
  const site = getActiveSite(creds);
  if (!site) return null;

  return {
    id: site.id,
    name: site.name || null,
    conversationId: site.conversationId || null,
    dashboardUrl: site.dashboardUrl || null,
  };
}

function getLocalRuntimeSummary(creds = loadCredentials()) {
  return {
    paths: {
      milesHome: MILES_HOME,
      credentialsFile: CREDENTIALS_FILE,
      lastResponseFile: LAST_RESPONSE_FILE,
      screenshotsDir: SCREENSHOTS_DIR,
      skillDir: MILES_SKILL_DIR,
      cli: MILES_CLI,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      websocket: typeof globalThis.WebSocket !== 'undefined',
    },
    auth: {
      authenticated: Boolean(creds.apiKey),
      activeSite: getActiveSiteSummary(creds),
    },
  };
}

function truncateText(text, maxChars = ERROR_BODY_MAX_CHARS) {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars - '...[truncated]'.length)}...[truncated]`,
    truncated: true,
  };
}

function stripOneTrailingNewline(text) {
  return text.replace(/\r?\n$/, '');
}

function readReplyMessage(args) {
  const stdinIndex = args.indexOf('--stdin');
  const fileIndex = args.indexOf('--file');

  if (stdinIndex !== -1 && fileIndex !== -1) {
    exitWithError('Use either `miles reply --stdin` or `miles reply --file <path>`, not both.');
  }

  if (stdinIndex !== -1) {
    const remaining = args.filter((_, index) => index !== stdinIndex);
    if (remaining.length > 0) {
      exitWithError('Usage: miles reply --stdin');
    }
    return stripOneTrailingNewline(readFileSync(0, 'utf8'));
  }

  if (fileIndex !== -1) {
    const filePath = args[fileIndex + 1];
    if (!filePath) {
      exitWithError('Usage: miles reply --file <path>');
    }
    const remaining = args.filter(
      (_, index) => index !== fileIndex && index !== fileIndex + 1,
    );
    if (remaining.length > 0) {
      exitWithError('Usage: miles reply --file <path>');
    }
    return stripOneTrailingNewline(readFileSync(filePath, 'utf8'));
  }

  return args.join(' ');
}

function collectScreenshotErrorLines(status, targetUrl, errorBody) {
  const body = errorBody?.body;
  const detail = body?.detail;
  const lines = [`Screenshot failed (HTTP ${status})`];
  const messages = [];

  if (body?.error) messages.push(body.error);
  if (body?.message) messages.push(body.message);

  for (const message of messages) {
    if (!message || lines.some((line) => line.endsWith(message))) continue;
    lines.push(`Message: ${message}`);
  }

  if (typeof detail === 'string' && detail) {
    lines.push(`Server detail: ${detail}`);
  } else if (detail && typeof detail === 'object') {
    if (detail.error && !messages.includes(detail.error)) {
      lines.push(`Server error: ${detail.error}`);
    }
    if (detail.detail) {
      lines.push(`Server detail: ${detail.detail}`);
    }
  }

  const nestedTarget =
    body?.targetUrl ||
    (detail && typeof detail === 'object' ? detail.targetUrl : null) ||
    targetUrl;
  if (nestedTarget) {
    lines.push(`Target: ${nestedTarget}`);
  }
  if (errorBody?.contentType) {
    lines.push(`Content-Type: ${errorBody.contentType}`);
  }
  if (body?.raw) {
    lines.push(`Body: ${body.raw}`);
  }

  return lines;
}

async function readResponseErrorBody(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  if (!text) {
    return { contentType, body: null };
  }

  try {
    return { contentType, body: JSON.parse(text) };
  } catch {
    const { text: truncatedText, truncated } = truncateText(text);
    return {
      contentType,
      body: {
        raw: truncatedText,
        truncated,
      },
    };
  }
}

// ============================================================================
// HTTP helpers
// ============================================================================

async function apiRequest(method, path, { body, auth, serverUrl } = {}) {
  const url = `${serverUrl}${path}`;
  const headers = { 'Content-Type': 'application/json' };

  if (auth) {
    headers['Authorization'] = `Bearer ${auth}`;
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const errMsg = data.error || data.message || `HTTP ${res.status}`;
    const retryAfterSeconds =
      parseRetryAfterSeconds(res.headers.get('retry-after')) ??
      parseRetryAfterSeconds(data.retryAfter ?? data.retry_after);
    throw new ApiError(errMsg, res.status, data, { retryAfterSeconds });
  }

  if (text && !contentType.includes('application/json')) {
    throw new ApiError('Expected JSON response from Miles.', 502, {
      contentType,
      raw: truncateText(text).text,
    });
  }

  return data;
}

class ApiError extends Error {
  constructor(message, status, data, { retryAfterSeconds } = {}) {
    super(message);
    this.status = status;
    this.data = data;
    this.retryAfterSeconds = retryAfterSeconds ?? null;
  }
}

// ============================================================================
// Browser helpers
// ============================================================================

function openUrl(url) {
  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [url], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch (err) {
    console.error(
      `Could not open browser automatically. Open this URL manually: ${url}`,
    );
    if (process.env.MILES_DEBUG) {
      console.error(`Browser open error: ${err.message}`);
    }
  }
}

// ============================================================================
// Commands
// ============================================================================

async function cmdLogin(args = []) {
  loadCredentials();
  const shouldOpen = !hasCommandFlag(args, '--no-open');
  const serverUrl = DEFAULT_SERVER_URL;
  console.log(
    shouldOpen ? 'Opening browser for Miles login...' : 'Starting Miles login...',
  );

  // Request device code
  const data = await apiRequest('POST', '/api/v2/auth/device/device-code', {
    serverUrl,
  });
  const { deviceCode, userCode, verificationUrl, interval } = data;
  const expiresIn = data.expiresIn ?? data.expires_in;
  if (!deviceCode || !userCode || !verificationUrl) {
    throw new ApiError('Invalid login response from Miles.', 502, {
      missing: {
        deviceCode: !deviceCode,
        userCode: !userCode,
        verificationUrl: !verificationUrl,
      },
    });
  }

  console.log(`\nYour code: ${userCode}`);
  console.log(`Login URL: ${verificationUrl}\n`);

  if (shouldOpen) {
    openUrl(verificationUrl);
  } else {
    console.log(
      'Open this URL in a browser and confirm the code matches.',
    );
  }

  console.log('Waiting for authorization...');

  const { pollIntervalMs, maxAttempts, maxWaitMs } =
    getDeviceAuthPollingPlan({
      intervalSeconds: interval,
      expiresInSeconds: expiresIn,
    });

  let nextPollIntervalMs = pollIntervalMs;
  const pollDeadlineMs = Date.now() + maxWaitMs;
  for (let i = 0; i < maxAttempts; i++) {
    const remainingMs = pollDeadlineMs - Date.now();
    if (remainingMs <= 0) break;

    await new Promise((r) =>
      setTimeout(r, Math.min(nextPollIntervalMs, remainingMs)),
    );

    try {
      const tokenData = await apiRequest(
        'POST',
        '/api/v2/auth/device/device-token',
        {
          body: { deviceCode },
          serverUrl,
        },
      );

      if (tokenData.apiKey) {
        // Start fresh - clear stale site data from previous sessions
        const creds = { apiKey: tokenData.apiKey };
        saveCredentials(creds);
        console.log(`\nLogged in successfully!`);
        console.log(`API key: ${tokenData.keyPrefix}...`);
        return;
      }
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.data?.error === 'authorization_pending'
      ) {
        continue;
      }
      if (err instanceof ApiError && err.data?.error === 'slow_down') {
        nextPollIntervalMs = getSlowedDeviceAuthPollIntervalMs(
          nextPollIntervalMs,
          err.retryAfterSeconds,
        );
        continue;
      }
      if (err instanceof ApiError && err.data?.error === 'access_denied') {
        console.error('\nAuthorization was denied. Please try again.');
        process.exit(1);
      }
      if (err instanceof ApiError && err.data?.error === 'expired_token') {
        console.error('\nAuthorization expired. Please try again.');
        process.exit(1);
      }
      if (err instanceof ApiError && err.status === 429) {
        console.error(
          `\n${buildDevicePollingRateLimitMessage(err.retryAfterSeconds)}`,
        );
        process.exit(1);
      }
      throw err;
    }
  }

  console.error(`\n${buildDevicePollingTimeoutMessage(maxWaitMs)}`);
  process.exit(1);
}

async function cmdLogout() {
  saveCredentials({});
  if (cliOptions.json) {
    emitJson({ ok: true, authenticated: false, milesHome: MILES_HOME });
  } else {
    console.log('Logged out. Credentials cleared.');
  }
}

async function cmdWhoami() {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    if (cliOptions.json) {
      emitJson({
        authenticated: false,
        activeSite: null,
        milesHome: MILES_HOME,
      });
      return;
    }
    console.log('Not logged in. Use `miles login`.');
    return;
  }

  if (cliOptions.json) {
    emitJson({
      authenticated: true,
      apiKeyPrefix: `${creds.apiKey.substring(0, 16)}...`,
      activeSite: getActiveSiteSummary(creds),
      milesHome: MILES_HOME,
    });
    return;
  }

  console.log(`API Key: ${creds.apiKey.substring(0, 16)}...`);

  const site = getActiveSite(creds);
  if (site) {
    console.log(`Active site: ${site.name || site.id}`);
    console.log(`Conversation: ${site.conversationId || 'none'}`);
  } else {
    console.log('No active site. Use `miles create-site` to start.');
  }
}

async function cmdDoctor() {
  let creds = {};
  let credentialsError = null;
  try {
    creds = loadCredentials();
  } catch (err) {
    credentialsError = err;
  }
  const summary = getLocalRuntimeSummary(creds);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  let milesHomeDetail = MILES_HOME;
  let milesHomeWritable = true;
  try {
    mkdirSync(MILES_HOME, { recursive: true });
    accessSync(MILES_HOME, constants.W_OK);
  } catch (err) {
    milesHomeWritable = false;
    milesHomeDetail = `${MILES_HOME} (${err.message})`;
  }
  let credentialsReadable = true;
  let credentialsDetail = 'No credentials file found';
  if (existsSync(CREDENTIALS_FILE)) {
    if (credentialsError) {
      credentialsReadable = false;
      credentialsDetail = credentialsError.message;
    } else {
      credentialsDetail = 'Credentials file is readable';
    }
  }
  const checks = [
    {
      name: 'node',
      ok: nodeMajor >= 20,
      detail: `Node ${process.version}`,
    },
    {
      name: 'websocket',
      ok: summary.runtime.websocket,
      detail: summary.runtime.websocket
        ? 'WebSocket is available'
        : 'WebSocket is not available; polling fallback will be used',
    },
    {
      name: 'milesHome',
      ok: milesHomeWritable,
      detail: milesHomeDetail,
    },
    {
      name: 'credentialsFile',
      ok: credentialsReadable,
      detail: credentialsDetail,
    },
    {
      name: 'credentials',
      ok: summary.auth.authenticated,
      detail: summary.auth.authenticated
        ? 'Miles credentials are present'
        : 'Not logged in. Run `miles login`.',
    },
  ];

  const result = {
    status: checks.every((check) => check.ok) ? 'ok' : 'needs_setup',
    checks,
    ...summary,
  };

  if (cliOptions.json) {
    emitJson(result);
    process.exit(result.status === 'ok' ? 0 : 1);
  }

  console.log(`Miles CLI doctor: ${result.status}`);
  checks.forEach((check) => {
    console.log(`${check.ok ? 'ok' : 'needs setup'} - ${check.name}: ${check.detail}`);
  });
  console.log(`Miles home: ${summary.paths.milesHome}`);
  console.log(`CLI: ${summary.paths.cli}`);
  if (summary.auth.activeSite) {
    console.log(`Active site: ${summary.auth.activeSite.name || summary.auth.activeSite.id}`);
  }
  process.exit(result.status === 'ok' ? 0 : 1);
}

async function cmdHookInit() {
  writeLastResponse('');
  if (cliOptions.json) {
    emitJson({
      ok: true,
      lastResponseFile: LAST_RESPONSE_FILE,
      milesHome: MILES_HOME,
    });
  }
}

async function cmdCheckAuth() {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;

  // Validate API key against server
  try {
    await apiRequest('GET', '/api/v2/headless/sites', {
      auth: creds.apiKey,
      serverUrl,
    });
  } catch (err) {
    if (err instanceof ApiError && [401, 403].includes(err.status)) {
      saveCredentials({});
    }
    process.exit(1);
  }

  // If there's an active site, validate the site token
  const site = getActiveSite(creds);
  if (site?.siteToken && site?.conversationId) {
    try {
      await apiRequest(
        'GET',
        `/api/v2/headless/conversations/${site.conversationId}/status`,
        { auth: site.siteToken, serverUrl },
      );
    } catch (err) {
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        delete creds.sites;
        delete creds.activeSite;
        saveCredentials(creds);
      }
    }
  }

  process.exit(0);
}

async function cmdCreateSite(args) {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    exitWithError('Not logged in. Use `miles login` first.');
  }

  const serverUrl = DEFAULT_SERVER_URL;

  // Parse args
  let message = '';
  let brief = null;
  let name = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--brief' && args[i + 1]) {
      const briefPath = args[++i];
      try {
        brief = readFileSync(briefPath, 'utf-8');
      } catch (err) {
        exitWithError(`Could not read brief file: ${briefPath}`, 1, {
          cause: err.message,
        });
      }
    } else if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    } else {
      message = args[i];
    }
  }

  if (!message) {
    exitWithError(
      'Usage: miles create-site "<description>" [--name "Site Name"] [--brief <file>]',
    );
  }

  console.log('Creating site and starting conversation with Miles...');

  const body = { message };
  if (name) body.name = name;
  if (brief) body.brief = brief;

  const data = await apiRequest('POST', '/api/v2/headless/sites', {
    auth: creds.apiKey,
    body,
    serverUrl,
  });

  // Save site credentials
  if (!creds.sites) creds.sites = {};
  creds.sites[data.siteId] = {
    siteToken: data.siteToken,
    name: name || message.substring(0, 50),
    conversationId: data.conversationId,
    dashboardUrl: data.dashboardUrl,
  };
  creds.activeSite = data.siteId;
  saveCredentials(creds);

  console.log(`Dashboard: ${data.dashboardUrl}`);

  await doWait(creds, data.conversationId, serverUrl);
}

async function cmdReply(args) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError(
      'No active conversation. Use `miles create-site` to start one.',
    );
  }

  const message = readReplyMessage(args);
  if (!message) {
    exitWithError('Usage: miles reply "<message>" | miles reply --stdin | miles reply --file <path>');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  let response;
  try {
    response = await apiRequest(
      'POST',
      `/api/v2/headless/conversations/${site.conversationId}/message`,
      {
        auth: site.siteToken,
        body: { message },
        serverUrl,
      },
    );
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.data?.code === 'dashboard_connection_required'
    ) {
      exitWithDashboardConnectionRequired(site);
    }
    throw err;
  }

  await doWait(creds, site.conversationId, serverUrl, undefined, {
    sinceMessageId: response?.sinceMessageId,
    skipInitialRestCheck: true,
  });
}

async function cmdWait() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await doWait(creds, site.conversationId, serverUrl);
}

/**
 * Format a progress data part into a human-readable status string.
 * The server returns the latest raw data part from Miles' message stream.
 */
function formatProgress(progress, elapsed) {
  if (!progress || !progress.data) return null;
  const { type, data } = progress;

  if (type === 'data-build-progress' && data.phases) {
    const active = data.phases.find((p) => p.status === 'active');
    if (!active) return null;
    const labels = {
      structure: 'Writing page content',
      design: 'Creating design & layout',
      interactivity: 'Adding interactivity',
      images: 'Generating images',
    };
    if (active.id === 'images' && active.imageProgress) {
      const img = active.imageProgress;
      return img.description
        ? `${img.description} (${img.current}/${img.total} images, ${elapsed}s)`
        : `Generating images (${img.current}/${img.total}, ${elapsed}s)`;
    }
    const section = active.sections?.length
      ? ` — ${active.sections[active.sections.length - 1]}`
      : '';
    return `${labels[active.id] || 'Building'}${section} (${elapsed}s)`;
  }

  if (type === 'data-conversion-progress' && data.phases) {
    const active = data.phases.find((p) => p.status === 'active');
    if (active) {
      const section = active.sections?.length
        ? ` — ${active.sections[active.sections.length - 1]}`
        : '';
      return `${active.label}${section} (${elapsed}s)`;
    }
    return `Converting to WordPress theme (${elapsed}s)`;
  }

  if (type === 'data-hero-preview-gallery' && data.previews) {
    const complete = data.previews.filter(
      (p) => p.status === 'complete',
    ).length;
    const total = data.previews.length;
    if (complete < total) {
      return `Generating design directions (${complete}/${total} complete, ${elapsed}s)`;
    }
  }

  // Individual hero preview status updates (streamed via WebSocket)
  if (type === 'data-hero-preview' && data.heroId) {
    const statusLabels = {
      starting: 'Starting',
      thinking: 'Thinking about design',
      generating: 'Generating code',
      images: 'Generating images',
      complete: 'Complete',
      failed: 'Failed',
    };
    const label = statusLabels[data.status] || data.status;
    // Track hero statuses for aggregate progress
    heroProgressTracker.set(data.heroId, {
      status: data.status,
      variationIndex: data.variationIndex,
      designNumber: data.designNumber,
    });
    // Use designNumber if available (set on complete), otherwise variationIndex + 1
    const displayNum =
      data.designNumber ??
      (data.variationIndex != null ? data.variationIndex + 1 : null);
    const completedCount = [...heroProgressTracker.values()].filter(
      (e) => e.status === 'complete',
    ).length;
    const totalCount = heroProgressTracker.size;
    const prefix = displayNum != null ? `Design ${displayNum}: ` : '';
    const errorSuffix =
      data.status === 'failed' && data.error ? ` - ${data.error}` : '';
    if (completedCount > 0 && totalCount > 1) {
      return `${prefix}${label}${errorSuffix} (${completedCount}/${totalCount} complete, ${elapsed}s)`;
    }
    return `${prefix}${label}${errorSuffix} (${elapsed}s)`;
  }

  if (type === 'data-task-status-display') {
    if (data.isStreaming && data.title) return `${data.title} (${elapsed}s)`;
  }

  if (type === 'data-create-content-progress') {
    if (data.actionDescription)
      return `${data.actionDescription} (${elapsed}s)`;
    const active = data.phases?.find((p) => p.status === 'active');
    if (active) return `${active.label} (${elapsed}s)`;
  }

  return null;
}

/**
 * WebSocket-based wait: connects to the server's WS endpoint, subscribes to
 * conversation chunks, and shows real-time progress from data parts.
 * Returns true if handled successfully, false if WS is unavailable.
 */
async function doWaitWebSocket(
  creds,
  conversationId,
  serverUrl,
  maxWaitMs,
  options = {},
) {
  // WebSocket global is available in Node 22+ or Node 20 with --experimental-websocket
  if (typeof globalThis.WebSocket === 'undefined') {
    return false;
  }

  // Clear hero progress tracker from any previous wait
  heroProgressTracker.clear();

  const maxWait = maxWaitMs || MAX_WAIT_MS;
  const site = getActiveSite(creds);
  const token = site?.siteToken;

  // Build WS URL from server URL
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';

  return new Promise((resolve) => {
    const startTime = Date.now();
    let lastProgressMsg = '';
    let hasStreamedText = false;
    let finished = false;
    let heartbeatTimer = null;
    let subscribeMessageId = null;

    const cleanup = () => {
      finished = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        ws.close();
      } catch {}
    };
    const fallBackToPolling = (err) => {
      if (finished) return;
      console.error(
        `Miles stream error. Falling back to polling: ${err?.message || err}`,
      );
      cleanup();
      clearTimeout(timeoutTimer);
      resolve(false);
    };

    // Helper: fetch final response via REST and output it
    // Use short timeoutMs for race-condition checks, longer for final fetch
    const fetchAndOutput = async (timeoutMs = 2000) => {
      try {
        const since = options.sinceMessageId
          ? `&sinceMessageId=${encodeURIComponent(options.sinceMessageId)}`
          : '';
        const data = await apiRequest(
          'GET',
          `/api/v2/headless/conversations/${conversationId}/wait?timeout=${timeoutMs}${since}`,
          { auth: token, serverUrl },
        );
        if (data.status !== 'running') {
          const output = formatWaitResponse(data);
          writeLastResponse(output);
          console.log('');
          console.log(output);
          return true;
        }
      } catch (err) {
        console.error(
          `Could not fetch Miles response over HTTP: ${err?.message || err}`,
        );
      }
      return false;
    };

    const ws = new WebSocket(wsUrl);

    // Timeout: if we exceed maxWait, close WS and fetch final status via REST
    const timeoutTimer = setTimeout(async () => {
      if (finished) return;
      cleanup();
      const got = await fetchAndOutput();
      if (!got) {
        console.log(`Miles is still working.`);
        console.log('Use `miles wait` to continue polling for the response.');
      }
      resolve(true);
    }, maxWait);

    ws.onopen = () => {
      // Authenticate with headless token
      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: 'auth',
          token,
          timestamp: Date.now(),
        }),
      );
    };

    ws.onmessage = async (event) => {
      if (finished) return;
      try {
        const msg = JSON.parse(
          typeof event.data === 'string' ? event.data : event.data.toString(),
        );

        // Handle auth acknowledgment
        if (msg.type === 'auth_ack') {
          if (!msg.success) {
            // Auth failed, fall back to polling
            cleanup();
            clearTimeout(timeoutTimer);
            resolve(false);
            return;
          }
          // Subscribe to conversation chunks
          subscribeMessageId = randomUUID();
          ws.send(
            JSON.stringify({
              id: subscribeMessageId,
              type: 'subscribe_conversation',
              conversationId,
              timestamp: Date.now(),
            }),
          );
          return;
        }

        // Handle subscription ack — check if response already arrived before we subscribed
        if (msg.type === 'ack' && msg.originalId === subscribeMessageId) {
          // Race condition guard: the agent may have finished before we subscribed.
          // Do an immediate non-blocking REST check (100ms timeout = just check status, no long-poll).
          if (!options.skipInitialRestCheck) {
            const alreadyDone = await fetchAndOutput(100);
            if (alreadyDone) {
              cleanup();
              clearTimeout(timeoutTimer);
              resolve(true);
              return;
            }
          }

          // Still running — start heartbeat timer
          heartbeatTimer = setInterval(() => {
            if (finished) return;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (elapsed > 0 && elapsed % 30 === 0) {
              console.log(`Still working... (${elapsed}s)`);
            }
          }, 5000);
          return;
        }

        // Handle conversation chunks
        if (msg.type === 'conversation.chunk') {
          const chunk = msg.chunk || msg;
          const elapsed = Math.round((Date.now() - startTime) / 1000);

          // Tool activity — show _actionDescription from tool input
          if (chunk.type === 'tool-input-available' && chunk.input) {
            const desc = chunk.input?._actionDescription;
            if (typeof desc === 'string' && desc) {
              console.log(`${desc} (${elapsed}s)`);
              lastProgressMsg = desc;
            }
          }
          // Text streaming — print one narrative line when Miles starts responding.
          // Full text is fetched via REST when the finish chunk arrives.
          else if (chunk.type === 'text-delta' && chunk.delta) {
            if (!hasStreamedText) {
              console.log(`Miles is responding... (${elapsed}s)`);
              hasStreamedText = true;
            }
          }
          // User input required. Poll as a fallback in case the finish event is delayed.
          else if (chunk.type === 'data-user-question') {
            const firstQ = chunk.data?.questions?.[0];
            if (firstQ?.question) {
              console.log(
                `Miles has a question: ${firstQ.question} (${elapsed}s)`,
              );
              if (firstQ.options?.length) {
                firstQ.options.forEach((opt, i) => {
                  console.log(`  ${i + 1}. ${opt.label}`);
                });
              }
            } else {
              console.log(`Miles has a question for you (${elapsed}s)`);
            }
            lastProgressMsg = 'question';
            // Safety-net fallback: poll REST if finish chunk is delayed
            setTimeout(async () => {
              try {
                if (finished) return;
                const done = await fetchAndOutput(5000);
                if (done) {
                  cleanup();
                  clearTimeout(timeoutTimer);
                  resolve(true);
                }
              } catch (err) {
                fallBackToPolling(err);
              }
            }, 5000);
          } else if (chunk.type === 'data-brief-editor') {
            console.log(
              `Miles has prepared a design brief for review (${elapsed}s)`,
            );
            lastProgressMsg = 'brief';
            // Safety-net fallback: poll REST if finish chunk is delayed
            setTimeout(async () => {
              try {
                if (finished) return;
                const done = await fetchAndOutput(5000);
                if (done) {
                  cleanup();
                  clearTimeout(timeoutTimer);
                  resolve(true);
                }
              } catch (err) {
                fallBackToPolling(err);
              }
            }, 5000);
          }
          // Data parts — build/conversion progress (existing handler)
          else if (
            typeof chunk.type === 'string' &&
            chunk.type.startsWith('data-')
          ) {
            const progress = { type: chunk.type, data: chunk.data };
            const progressMsg = formatProgress(progress, elapsed);
            if (progressMsg && progressMsg !== lastProgressMsg) {
              console.log(`${progressMsg}`);
              lastProgressMsg = progressMsg;
            }
          }

          // Stream finished — fetch structured response via REST
          // Only the root agent's finish means the response is complete
          if (chunk.type === 'finish' && chunk.isRootAgent !== false) {
            cleanup();
            clearTimeout(timeoutTimer);
            const got = await fetchAndOutput();
            if (!got) {
              console.error(
                'Failed to fetch final response after finish chunk.',
              );
            }
            resolve(true);
            return;
          }
        }
      } catch (err) {
        fallBackToPolling(err);
      }
    };

    ws.onerror = () => {
      if (finished) return;
      // WS failed, fall back to polling
      cleanup();
      clearTimeout(timeoutTimer);
      resolve(false);
    };

    ws.onclose = () => {
      if (finished) return;
      // Unexpected close, fall back to polling
      cleanup();
      clearTimeout(timeoutTimer);
      resolve(false);
    };
  });
}

/**
 * Connection watchdog: monitors the Playground WebSocket connection and
 * reports when the browser connection drops. Runs as a background loop alongside
 * doWait for commands that explicitly opt into browser monitoring.
 *
 * Returns a stop function to call when the wait is complete.
 */
function startConnectionWatchdog(
  conversationId,
  token,
  serverUrl,
  dashboardUrl,
) {
  let rejectFailure;
  const failurePromise = new Promise((_, reject) => {
    rejectFailure = reject;
  });

  if (!dashboardUrl) {
    return {
      stop() {},
      failurePromise,
    };
  }

  let running = true;
  // Only activate once we've seen the connection up at least once.
  // This prevents lost-connection noise during early phases when the
  // dashboard has not been opened yet.
  let connectionSeenOnce = false;

  const fail = (err) => {
    if (!running) return;
    running = false;
    rejectFailure(err);
  };

  const watch = async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, 5000));
      if (!running) break;

      const status = await apiRequest(
        'GET',
        `/api/v2/headless/conversations/${conversationId}/ws-status`,
        { auth: token, serverUrl },
      );
      if (status.connected) {
        connectionSeenOnce = true;
      } else if (connectionSeenOnce) {
        console.log(`  Connection lost. Reopen dashboard: ${dashboardUrl}`);
        // Wait for reconnection
        const reconnectStart = Date.now();
        while (running && Date.now() - reconnectStart < 30000) {
          await new Promise((r) => setTimeout(r, 2000));
          const recheck = await apiRequest(
            'GET',
            `/api/v2/headless/conversations/${conversationId}/ws-status`,
            { auth: token, serverUrl },
          );
          if (recheck.connected) {
            console.log('  Playground reconnected.');
            break;
          }
        }
      }
    }
  };

  watch().catch(fail);

  return {
    stop() {
      running = false;
    },
    failurePromise,
  };
}

async function doWait(
  creds,
  conversationId,
  serverUrl,
  maxWaitMs,
  options = {},
) {
  const maxWait = maxWaitMs || MAX_WAIT_MS;
  const site = getActiveSite(creds);
  const token = site?.siteToken;
  if (!token) {
    exitWithError('No site token. Use `miles create-site` first.');
  }

  // Start connection watchdog to auto-recover if the CLI owns browser opening.
  const dashboardUrl =
    options.allowExternalBrowserOpen === true && site?.dashboardUrl
      ? `${site.dashboardUrl}?agent=true`
      : null;
  const watchdog = startConnectionWatchdog(
    conversationId,
    token,
    serverUrl,
    dashboardUrl,
  );

  try {
    // Try WebSocket first for real-time progress
    const wsHandled = await Promise.race(
      [
        doWaitWebSocket(creds, conversationId, serverUrl, maxWaitMs, options),
        watchdog.failurePromise,
      ],
    );
    if (wsHandled) return;

    // Fallback: polling loop
    const startTime = Date.now();
    let lastDirectionCount = 0;
    let announcedPhase = '';
    let lastProgressMsg = '';

    while (Date.now() - startTime < maxWait) {
      const data = await Promise.race(
        [
          apiRequest(
            'GET',
            `/api/v2/headless/conversations/${conversationId}/wait?timeout=${POLL_TIMEOUT_MS}${
              options.sinceMessageId
                ? `&sinceMessageId=${encodeURIComponent(options.sinceMessageId)}`
                : ''
            }`,
            { auth: token, serverUrl },
          ),
          watchdog.failurePromise,
        ],
      );

      if (data.status === 'running') {
        // Show phase-aware progress to stdout so it's visible in agent UIs
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const phase = data.phase || 'working';

        // Announce phase transitions
        if (phase !== announcedPhase) {
          announcedPhase = phase;
          const phaseLabels = {
            discovery: 'Miles is thinking...',
            brief_review: 'Miles is creating the design brief...',
            generating_design_directions:
              'Miles is generating new design directions...',
            design_directions_ready: 'Design directions are ready for review.',
            building: 'Miles is building the full site...',
            site_preview: 'Site generated, preparing preview...',
            converting: 'Miles is converting to WordPress theme...',
          };
          console.log(phaseLabels[phase] || `Miles is working... [${phase}]`);
        }

        // Show progress from data parts if available
        const progressMsg = formatProgress(data.progress, elapsed);
        if (progressMsg && progressMsg !== lastProgressMsg) {
          console.log(`${progressMsg}`);
          lastProgressMsg = progressMsg;
        } else if (data.directionCount > lastDirectionCount) {
          lastDirectionCount = data.directionCount;
          const total = data.directionTotal || '?';
          const msg = `${data.directionCount} of ${total} design directions ready (${elapsed}s)`;
          console.log(`${msg}`);
          lastProgressMsg = msg;
        } else if (elapsed > 0 && elapsed % 30 === 0) {
          console.log(`Still working... (${elapsed}s)`);
        }

        continue;
      }

      // Got a response

      const output = formatWaitResponse(data);
      writeLastResponse(output);
      console.log('');
      console.log(output);
      return;
    }

    // Timed out - tell the agent what's happening so it can act
    const statusMsg = announcedPhase
      ? `Miles is still working. [phase: ${announcedPhase}]`
      : 'Miles is still working.';
    console.log(statusMsg);
    console.log('Use `miles wait` to continue polling for the response.');
  } finally {
    watchdog.stop();
  }
}

function formatWaitResponse(data) {
  const lines = [];

  lines.push(`[status: ${data.status}]`);
  lines.push(`[phase: ${data.phase}]`);

  if (data.milesMessage) {
    lines.push('');
    lines.push(data.milesMessage);
  }

  // Show brief content when in brief_review phase
  if (data.brief) {
    lines.push('');
    lines.push('[brief]');
    lines.push(data.brief);
    lines.push('[/brief]');
  }

  if (data.question) {
    lines.push('');
    // Show the actual question text
    if (data.question.text) {
      lines.push(`[question: ${data.question.text}]`);
    } else {
      lines.push(`[question: ${data.question.type}]`);
    }
    // Show options if available
    if (data.question.options?.length) {
      data.question.options.forEach((opt, i) => {
        lines.push(
          `  ${i + 1}. ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`,
        );
      });
    }
  }

  if (data.directions?.length) {
    lines.push('');
    lines.push('[directions]');
    data.directions.forEach((h) => {
      const name = h.directionName || `Design ${h.number}`;
      // Extract the path portion from the preview URL for the screenshot command
      const previewPath =
        h.previewUrl?.replace(/^https?:\/\/[^/]+/, '') || h.previewUrl;
      lines.push(`  ${h.number}. ${name}`);
      lines.push(`     Preview: ${h.previewUrl}`);
      lines.push(
        `     Screenshot: miles screenshot ${previewPath}`,
      );
    });
  }

  if (data.selectedDirectionId) {
    lines.push(`[selected_direction: ${data.selectedDirectionId}]`);
  }

  if (data.siteReady) {
    lines.push('[site_ready: true]');
    lines.push(`[dashboard: ${data.dashboardUrl}]`);
    lines.push(
      '[edit: To make changes to this WordPress site, run: miles reply "describe your changes"]',
    );
  }

  if (data.credits && data.credits.usagePercent >= 95) {
    if (data.credits.topUpCredits > 0) {
      lines.push(
        `[warning: Plan credits ${data.credits.usagePercent}% used. ${data.credits.topUpCredits.toLocaleString()} top-up credits available.]`,
      );
    } else {
      lines.push(
        `[error: Plan credits ${data.credits.usagePercent}% used with no top-up credits. STOP and ask the user to top up credits at their dashboard billing page before continuing.]`,
      );
    }
  }

  return lines.join('\n');
}

async function cmdStatus() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/status`,
    { auth: site.siteToken, serverUrl },
  );

  if (cliOptions.json) {
    emitJson({
      status: data.status,
      phase: data.phase,
      conversationStatus: data.conversationStatus,
      directionCount: data.directionCount || 0,
      selectedDirectionId: data.selectedDirectionId || null,
      siteReady: Boolean(data.siteReady),
      activeSite: getActiveSiteSummary(creds),
    });
    return;
  }

  console.log(`[status: ${data.status}]`);
  console.log(`[phase: ${data.phase}]`);
  console.log(`[conversation_status: ${data.conversationStatus}]`);
  if (data.directionCount > 0)
    console.log(`[directions: ${data.directionCount}]`);
  if (data.selectedDirectionId)
    console.log(`[selected_direction: ${data.selectedDirectionId}]`);
  if (data.siteReady) console.log('[site_ready: true]');

  // Provide actionable hints based on current phase
  if (
    data.conversationStatus === 'waiting_for_user_input' &&
    (data.phase === 'site_preview' || data.phase === 'site_generation')
  ) {
    console.log(
      '[edit: To request changes to the site, run: miles reply "describe your changes"]',
    );
    console.log(
      '[build: When edits are done, run: miles build-theme — to convert the site to a WordPress theme]',
    );
  }
  if (data.siteReady) {
    console.log(
      '[edit: To make changes to this WordPress site, run: miles reply "describe your changes"]',
    );
  }
}

async function cmdDesignDirections() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/design-directions`,
    { auth: site.siteToken, serverUrl },
  );

  if (cliOptions.json) {
    emitJson({
      phase: data.phase || null,
      selectedDirectionId: data.selectedDirectionId || null,
      directions: (data.directions || []).map((h) => ({
        number: h.number,
        name: h.directionName || `Design ${h.number}`,
        previewUrl: h.previewUrl || null,
        screenshotCommand: h.previewUrl
          ? `miles screenshot ${h.previewUrl.replace(/^https?:\/\/[^/]+/, '')}`
          : null,
      })),
    });
    return;
  }

  if (data.directions?.length === 0) {
    console.log(
      `No design directions generated yet. Current phase: ${data.phase || 'unknown'}.`,
    );
    console.log('Use `miles reply` to continue the conversation with Miles.');
    return;
  }

  data.directions.forEach((h) => {
    const previewPath =
      h.previewUrl?.replace(/^https?:\/\/[^/]+/, '') || h.previewUrl;
    console.log(`${h.number}. ${h.directionName || `Design ${h.number}`}`);
    console.log(`   Preview: ${h.previewUrl}`);
    console.log(`   Screenshot: miles screenshot ${previewPath}`);
  });

  if (data.selectedDirectionId) {
    console.log(`\nSelected: ${data.selectedDirectionId}`);
  } else {
    console.log(
      `\nUse \`miles select-design-direction <number>\` to choose a design.`,
    );
  }
}

async function cmdSelectDesignDirection(args) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.');
  }

  const directionNumber = findPositiveIntegerArg(args);
  if (!directionNumber || directionNumber < 1) {
    exitWithError('Usage: miles select-design-direction <number>');
  }

  const serverUrl = DEFAULT_SERVER_URL;

  console.log(`Selecting design direction ${directionNumber}...`);

  // Wait for the dashboard WebSocket connection before starting the build.
  // This ensures the dashboard subscribes to the conversation stream and
  // can display live build progress instead of joining mid-stream.
  const dashboardUrl = getDashboardUrl(site);
  console.log(`Dashboard: ${dashboardUrl}`);
  console.log(`Waiting for dashboard to connect...`);
  const dashboardConnected = await waitForDashboardConnection(
    site,
    serverUrl,
    DASHBOARD_CONNECT_TIMEOUT_MS,
  );
  if (!dashboardConnected) {
    exitWithDashboardConnectionRequired(site, DASHBOARD_CONNECT_TIMEOUT_MS);
  }

  const data = await apiRequest(
    'POST',
    `/api/v2/headless/conversations/${site.conversationId}/select-design-direction`,
    { auth: site.siteToken, body: { directionNumber }, serverUrl },
  );

  console.log(data.message);
  console.log('');
  console.log('Waiting for Miles to build the site...');

  await doWait(creds, site.conversationId, serverUrl);
}

async function cmdScreenshot(args) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.siteToken) {
    exitWithError('No active site. Use `miles create-site` first.');
  }

  // Extract the URL: first arg that starts with / or http
  const url = args.find((a) => a.startsWith('/') || a.startsWith('http'));
  if (!url) {
    exitWithError(
      'Usage: miles screenshot <preview-url>',
      1,
      {
        example:
          'miles screenshot /preview/abc123/previews/hero-xyz/index.html',
      },
    );
  }

  const serverUrl = DEFAULT_SERVER_URL;

  // Fetch screenshot as binary image from the server
  const encodedUrl = encodeURIComponent(url);
  const endpoint = `${serverUrl}/api/v2/headless/screenshot?url=${encodedUrl}`;

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${site.siteToken}` },
  });

  if (!response.ok) {
    const errorBody = await readResponseErrorBody(response);
    const body = errorBody.body;
    let msg = `Screenshot failed (HTTP ${response.status})`;
    if (body?.error) msg = body.error;
    if (body?.message) msg = body.message;
    if (cliOptions.json) {
      emitJson({
        ok: false,
        error: msg,
        status: response.status,
        targetUrl: url,
        detail: body,
        contentType: errorBody.contentType,
      });
    } else {
      for (const line of collectScreenshotErrorLines(response.status, url, errorBody)) {
        console.error(line);
      }
    }
    process.exit(1);
  }

  const screenshotContentType = response.headers.get('content-type') || '';
  if (!screenshotContentType.startsWith('image/')) {
    if (cliOptions.json) {
      emitJson({
        ok: false,
        error: 'Screenshot service returned non-image content.',
        targetUrl: url,
        contentType: screenshotContentType || null,
      });
    } else {
      console.error('Screenshot service returned non-image content.');
      if (screenshotContentType) {
        console.error(`Content-Type: ${screenshotContentType}`);
      }
    }
    process.exit(1);
  }

  // Save to temp file
  const imageBuffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filename = `screenshot-${Date.now()}.jpg`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  writeFileSync(filepath, imageBuffer);

  if (cliOptions.json) {
    emitJson({
      ok: true,
      path: filepath,
      targetUrl: url,
      bytes: imageBuffer.byteLength,
      contentType: screenshotContentType,
    });
  } else {
    console.log(filepath);
  }
}

async function cmdSites() {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    exitWithError('Not logged in.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest('GET', '/api/v2/headless/sites', {
    auth: creds.apiKey,
    serverUrl,
  });

  if (cliOptions.json) {
    emitJson({
      activeSiteId: creds.activeSite || null,
      sites: (data.sites || []).map((site) => ({
        id: site.id,
        name: site.name || null,
        phase: site.phase || null,
        dashboardUrl: site.dashboardUrl || null,
        active: site.id === creds.activeSite,
      })),
    });
    return;
  }

  if (!data.sites?.length) {
    console.log('No sites found. Use `miles create-site` to create one.');
    return;
  }

  data.sites.forEach((site) => {
    const active = site.id === creds.activeSite ? ' (active)' : '';
    console.log(`${site.name || 'Unnamed'}${active}`);
    console.log(`  ID: ${site.id}`);
    console.log(`  Phase: ${site.phase}`);
    console.log(`  Dashboard: ${site.dashboardUrl}`);
    console.log('');
  });
}

async function cmdUse(args) {
  const siteId = args[0];
  if (!siteId) {
    exitWithError('Usage: miles use <siteId>');
  }

  const creds = loadCredentials();
  if (!creds.sites?.[siteId]) {
    exitWithError(
      `Site ${siteId} not found in local credentials. Use \`miles sites\` to see available sites.`,
    );
  }

  creds.activeSite = siteId;
  saveCredentials(creds);
  if (cliOptions.json) {
    emitJson({
      ok: true,
      activeSite: getActiveSiteSummary(creds),
    });
  } else {
    console.log(`Switched to site: ${creds.sites[siteId].name || siteId}`);
  }
}

async function cmdPreview(args = []) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site) {
    exitWithError('No active site.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const shouldOpen = hasCommandFlag(args, '--open');
  const dashboard = await getDashboardOpenUrl(creds, site, serverUrl);
  const connected = site.conversationId
    ? await getDashboardConnectionStatus(site, serverUrl)
    : null;
  if (cliOptions.json) {
    emitJson({
      url: dashboard.url,
      dashboardUrl: dashboard.dashboardUrl,
      authenticated: dashboard.authenticated,
      connected,
      activeSite: getActiveSiteSummary(creds),
    });
    return;
  }
  console.log(dashboard.url);
  if (dashboard.authenticated) {
    console.log('Authentication: browser login handoff');
  }
  if (connected !== null) {
    console.log(`WebSocket: ${connected ? 'connected' : 'not connected'}`);
  }
  if (shouldOpen) openUrl(dashboard.url);
}

async function cmdBalance() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active site.');
  }

  const serverUrl = DEFAULT_SERVER_URL;

  // Use the wait endpoint with a quick timeout to get credits
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/wait?timeout=1000`,
    { auth: site.siteToken, serverUrl },
  );

  if (data.credits) {
    if (cliOptions.json) {
      emitJson({
        planUsagePercent: data.credits.usagePercent,
        topUpCredits: data.credits.topUpCredits || 0,
        billingUrl:
          data.credits.usagePercent >= 95 && data.credits.topUpCredits === 0
            ? `${site.dashboardUrl}/settings/billing`
            : null,
      });
      return;
    }
    console.log(`Plan usage: ${data.credits.usagePercent}%`);
    if (data.credits.topUpCredits > 0) {
      console.log(
        `Top-up credits: ${data.credits.topUpCredits.toLocaleString()}`,
      );
    }
    if (data.credits.usagePercent >= 95 && data.credits.topUpCredits === 0) {
      console.log(
        `Running low! Top up at: ${site.dashboardUrl}/settings/billing`,
      );
    }
  } else {
    if (cliOptions.json) {
      emitJson({ ok: false, error: 'Could not retrieve balance.' });
      process.exit(1);
    }
    console.log('Could not retrieve balance.');
  }
}

async function cmdMessages() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/messages`,
    { auth: site.siteToken, serverUrl },
  );

  if (cliOptions.json) {
    emitJson({
      messages: (data.messages || []).map((msg) => ({
        role: msg.role,
        text: msg.text || '',
      })),
    });
    return;
  }

  data.messages?.forEach((msg) => {
    const role = msg.role === 'assistant' ? 'Miles' : 'You';
    console.log(`[${role}]`);
    console.log(msg.text);
    console.log('');
  });
}

async function cmdBuildTheme() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation. Use `miles create-site` first.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const dashboardUrl = getDashboardUrl(site);

  // Check if Playground is already connected (opened during select-design-direction)
  let connected = false;
  const status = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/ws-status`,
    { auth: site.siteToken, serverUrl },
  );
  connected = status.connected;

  if (!connected) {
    console.log(`Dashboard: ${dashboardUrl}`);

    console.log('Waiting for WordPress Playground to connect...');
    const wsStart = Date.now();
    while (Date.now() - wsStart < PLAYGROUND_CONNECT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 2000));
      const currentStatus = await apiRequest(
        'GET',
        `/api/v2/headless/conversations/${site.conversationId}/ws-status`,
        { auth: site.siteToken, serverUrl },
      );
      if (currentStatus.connected) {
        connected = true;
        break;
      }
      const elapsed = Math.round((Date.now() - wsStart) / 1000);
      if (elapsed > 0 && elapsed % 10 === 0) {
        console.log(`Still waiting for connection... (${elapsed}s)`);
      }
    }

    if (!connected) {
      exitWithDashboardConnectionRequired(site, PLAYGROUND_CONNECT_TIMEOUT_MS);
    }
    console.log('Playground connected.');
  }

  // Trigger theme conversion
  console.log('Building WordPress theme...');
  await apiRequest(
    'POST',
    `/api/v2/headless/conversations/${site.conversationId}/build-theme`,
    { auth: site.siteToken, serverUrl },
  );

  // Wait for completion after the agent has established the dashboard session.
  await doWait(creds, site.conversationId, serverUrl);
  console.log('To edit this site, run: miles reply "describe your changes"');
}

async function cmdExportTheme() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/export/theme`,
    { auth: site.siteToken, serverUrl },
  );

  if (cliOptions.json) {
    emitJson(data);
    return;
  }

  console.log(`Theme: ${data.themeSlug}`);
  console.log(`Download: ${data.downloadUrl}`);
  if (data.editorUrl) console.log(`Editor: ${data.editorUrl}`);
  console.log(`Dashboard: ${data.dashboardUrl}`);
}

async function cmdExportSite() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.');
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/export/html`,
    { auth: site.siteToken, serverUrl },
  );

  if (cliOptions.json) {
    emitJson(data);
    return;
  }

  console.log(`Preview: ${data.previewUrl}`);
  console.log(`Slug: ${data.slug}`);
  if (data.message) console.log(data.message);
}

async function cmdHook() {
  // PostToolUse hook handler
  // Reads stdin for the hook payload, checks if it was a miles command,
  // and returns additionalContext if so
  let input = '';
  try {
    input = readFileSync('/dev/stdin', 'utf-8');
  } catch (err) {
    console.error(`Miles hook warning: could not read hook payload: ${err.message}`);
    process.exit(0);
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    console.error(`Miles hook warning: could not parse hook payload: ${err.message}`);
    process.exit(0);
  }

  // Check if this was a miles CLI command (stdin uses snake_case field names)
  const toolCommand = hookData?.tool_input?.command || '';
  if (!isMilesToolCommand(toolCommand)) {
    process.exit(0);
  }

  // Check if there's a last response to inject
  try {
    if (existsSync(LAST_RESPONSE_FILE)) {
      const lastResponse = readFileSync(LAST_RESPONSE_FILE, 'utf-8');
      if (lastResponse.trim()) {
        // Clear the file so we don't inject the same response twice
        writeFileSync(LAST_RESPONSE_FILE, '');
        const output = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `Miles response:\n${lastResponse}`,
          },
        });
        process.stdout.write(output);
      }
    }
  } catch (err) {
    console.error(`Miles hook warning: could not relay last response: ${err.message}`);
  }
  process.exit(0);
}

function isMilesToolCommand(commandText) {
  if (typeof commandText !== 'string') return false;
  return commandText
    .split(/&&|\|\||;|\n/)
    .some((segment) => isMilesCommandSegment(segment));
}

function isMilesCommandSegment(segment) {
  const command = segment
    .trim()
    .replace(
      /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/,
      '',
    );
  return (
    /^["']?\$MILES_CLI["']?(?:\s|$)/i.test(command) ||
    /^["']?[^"'\s;]*miles-cli\.mjs["']?(?:\s|$)/i.test(command) ||
    /^["']?(?:[^"'\s;]*\/)?miles["']?(?:\s|$)/i.test(command) ||
    /^["']?[^"'\s;]*\.miles\/bin\/[^"'\s;]+["']?(?:\s|$)/i.test(command)
  );
}

// ============================================================================
// Main
// ============================================================================

const parsed = parseGlobalArgs(process.argv.slice(2));
const { command, args } = parsed;
cliOptions = parsed.options;

const commands = {
  doctor: cmdDoctor,
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  'check-auth': cmdCheckAuth,
  'hook-init': cmdHookInit,
  'create-site': cmdCreateSite,
  reply: cmdReply,
  wait: cmdWait,
  status: cmdStatus,
  'design-directions': cmdDesignDirections,
  'select-design-direction': cmdSelectDesignDirection,
  screenshot: cmdScreenshot,
  sites: cmdSites,
  use: cmdUse,
  preview: cmdPreview,
  balance: cmdBalance,
  messages: cmdMessages,
  'build-theme': cmdBuildTheme,
  'export-theme': cmdExportTheme,
  'export-site': cmdExportSite,
  hook: cmdHook,
};

if (!command || command === 'help' || command === '--help') {
  console.log(`Miles CLI - Design websites with Miles AI

Authentication:
  miles doctor                      Check local CLI setup
  miles login                       Device auth flow (opens browser)
  miles logout                      Clear stored credentials
  miles whoami                      Show current auth + active site

Site Management:
  miles create-site "<description>" Create site + start conversation
  miles create-site --brief <file>  Create with pre-built brief (skip discovery)
  miles sites                       List all sites
  miles use <siteId>                Switch active site
  miles preview [--open]            Get dashboard URL
  miles balance                     Show credit balance

Conversation:
  miles reply "<message>"           Send message to Miles, wait for response
  miles reply --stdin               Read reply text from stdin
  miles reply --file <path>         Read reply text from a file
  miles wait                        Long-poll for Miles' response
  miles status                      Quick status check (non-blocking)
  miles design-directions           Get design direction preview URLs
  miles select-design-direction <n> Choose a design direction
  miles build-theme                 Build WordPress theme (waits, converts)
  miles screenshot <preview-url>    Screenshot a preview URL (saves JPEG, prints path)
  miles messages                    Full conversation history

Export:
  miles export-theme                Download WordPress theme info
  miles export-site                 Get static HTML files info

Options:
  --json                            Emit JSON for inspection commands`);
  process.exit(0);
}

if (cliOptions.unsupportedJson) {
  exitWithError(
    'The --json option is only supported for inspection commands.',
    2,
    {
      command: command || null,
      supportedCommands: Array.from(JSON_COMMANDS).sort(),
    },
  );
}

const handler = commands[command];
if (!handler) {
  console.error(
    `Unknown command: ${command}. Use \`miles help\` for available commands.`,
  );
  process.exit(1);
}

handler(args).catch((err) => {
  if (cliOptions.json) {
    if (err instanceof ApiError) {
      emitJson({
        ok: false,
        error: err.message,
        status: err.status,
        detail: err.data || null,
      });
    } else {
      emitJson({
        ok: false,
        error: err.message,
      });
    }
    process.exit(1);
  }

  if (err instanceof ApiError) {
    console.error(`Error: ${err.message}`);
    if (err.data?.details) {
      console.error(`Details: ${JSON.stringify(err.data.details)}`);
    }
    // Self-correcting guidance
    if (err.status === 401) {
      console.error('Try: miles login');
    } else if (err.status === 400 && err.data?.phase) {
      console.error(`Current phase: ${err.data.phase}`);
    }
  } else {
    console.error(`Error: ${err.message}`);
  }
  process.exit(1);
});
