#!/usr/bin/env -S node --experimental-websocket

/**
 * Miles CLI - Conversation transport for external AI agents.
 *
 * Zero-dependency JavaScript CLI (uses built-in fetch, fs, child_process).
 * Wraps the Miles headless REST API for agent-to-agent workflows.
 */

import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, delimiter, dirname, join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import {
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
const LOGIN_STATE_FILE = join(CREDENTIALS_DIR, 'login-state.json');
const LAST_RESPONSE_FILE = join(CREDENTIALS_DIR, 'last-response');
const ACTIVE_RUN_FILE = join(CREDENTIALS_DIR, 'active-run.json');
const SCREENSHOTS_DIR = join(CREDENTIALS_DIR, 'screenshots');
// Ignore in-flight markers older than this — no Miles run takes an hour.
const ACTIVE_RUN_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_SERVER_URL = process.env.MILES_SERVER_URL || 'https://api.bymiles.ai';
const MILES_PLUGIN_MANIFEST_URL =
  process.env.MILES_PLUGIN_MANIFEST_URL ||
  'https://releases.bymiles.ai/plugin/updates.json';
const MILES_PLUGIN_DOWNLOAD_URL = process.env.MILES_PLUGIN_DOWNLOAD_URL || '';
const MILES_PLUGIN_SOURCE = process.env.MILES_PLUGIN_SOURCE || '';
const REQUIRED_EGRESS = [
  '*.bymiles.ai',
  'start.bymiles.ai',
  'github.com',
  '*.githubusercontent.com',
];
const REQUIRED_EGRESS_SANDBOX_JSON = {
  networkPolicy: {
    default: 'deny',
    allow: REQUIRED_EGRESS,
  },
};
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
const POLL_TIMEOUT_MS = 10000; // 10 second poll for faster progress updates
const ERROR_BODY_MAX_CHARS = 2048;
const DASHBOARD_CONNECT_TIMEOUT_MS = 30000;
const PLAYGROUND_CONNECT_TIMEOUT_MS = 60000;

// Shared exit-code grammar. Every verb maps its result onto these so agents
// can branch on exit codes without parsing prose.
const EXIT_OK = 0; // completed
const EXIT_ERROR = 1; // failed / aborted / unexpected error
const EXIT_PRECONDITION = 2; // missing auth, site, argument, or server support
const EXIT_NEED_CONNECTION = 3; // a connection must be established, then retry
const EXIT_BLOCKED = 4; // turn ended blocked or declined
const EXIT_CAPACITY = 5; // server capacity / another run already streaming

const JSON_COMMANDS = new Set([
  'doctor',
  'auth',
  'login',
  'logout',
  'whoami',
  'account-status',
  'status',
  'site-state',
  'site-attach',
  'wordpress-detect',
  'wordpress-setup',
  'design-directions',
  'screenshot',
  'upload-assets',
  'sites',
  'use',
  'preview',
  'connect-browser',
  'balance',
  'messages',
  'wait-job',
  'approval-respond',
  'cancel',
  'export',
  'export-theme',
  'export-site',
  'undo',
  'site-pages',
  'usage-history',
  'rename',
  'history',
]);

// Long-running verbs that accept --no-wait (fire the turn, return a JSON
// handle immediately). Only offered when the connected server supports
// `cancel` — a fire-and-forget surface without cancellation burns credits.
const NO_WAIT_VERBS = new Set([
  'site-create',
  'create-site',
  'say',
  'reply',
  'build-site',
  'select-design-direction',
  'convert-theme',
  'build-theme',
]);

let cliOptions = { json: false };

// Track hero preview statuses across data parts for aggregate progress display
const heroProgressTracker = new Map();
const MAX_PROGRESS_TEXT_CHARS = 110;

function runtimeName() {
  if (process.versions?.bun) return 'bun';
  return 'node';
}

function runtimeVersion() {
  if (process.versions?.bun) return process.versions.bun;
  return process.version;
}

function runtimeDetail() {
  if (runtimeName() === 'bun') {
    return `Bun ${runtimeVersion()} runtime`;
  }
  return `Node ${process.version}`;
}

function runtimeIsSupported() {
  if (runtimeName() === 'bun') return true;
  const nodeMajor = Number(process.versions.node?.split('.')[0]);
  return Number.isFinite(nodeMajor) && nodeMajor >= 20;
}

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
  ensureCredentialsDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  try {
    chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // Best effort on filesystems that do not preserve POSIX modes.
  }
}

function ensureCredentialsDir() {
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CREDENTIALS_DIR, 0o700);
  } catch {
    // Best effort on filesystems that do not preserve POSIX modes.
  }
}

function savePendingLogin(deviceAuth) {
  const existingLogin = loadPendingLogin({ warn: false });
  if (existingLogin?.deviceCode) {
    throw new Error(
      `A Miles login is already pending for code ${existingLogin.userCode || 'unknown'}. Run \`miles login --poll --json\` to finish it, or \`miles logout\` to clear it before starting a new login.`,
    );
  }

  ensureCredentialsDir();
  const pendingLogin = {
    deviceCode: deviceAuth.deviceCode,
    userCode: deviceAuth.userCode,
    verificationUrl: deviceAuth.verificationUrl,
    intervalSeconds: deviceAuth.intervalSeconds,
    expiresInSeconds: deviceAuth.expiresInSeconds,
    expiresAt: deviceAuth.expiresAt,
    requestedAt: new Date().toISOString(),
  };
  const tmpFile = `${LOGIN_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(pendingLogin, null, 2), {
    mode: 0o600,
  });
  try {
    chmodSync(tmpFile, 0o600);
  } catch {
    // Best effort on filesystems that do not preserve POSIX modes.
  }
  renameSync(tmpFile, LOGIN_STATE_FILE);
}

function loadPendingLogin({ warn = true } = {}) {
  if (!existsSync(LOGIN_STATE_FILE)) return null;
  try {
    const pendingLogin = JSON.parse(readFileSync(LOGIN_STATE_FILE, 'utf-8'));
    if (pendingLogin.expiresAt) {
      const expiresAtMs = Date.parse(pendingLogin.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        const warning = `Ignoring expired pending Miles login at ${LOGIN_STATE_FILE}.`;
        clearPendingLogin();
        if (warn && !cliOptions.json) console.error(warning);
        return null;
      }
    }
    return pendingLogin;
  } catch (err) {
    const warning = `Ignoring unreadable pending Miles login at ${LOGIN_STATE_FILE}: ${err.message}`;
    clearPendingLogin();
    if (warn && !cliOptions.json) console.error(warning);
    return null;
  }
}

function clearPendingLogin() {
  try {
    unlinkSync(LOGIN_STATE_FILE);
    return null;
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes(err.code)) return null;
    return `Could not remove pending Miles login at ${LOGIN_STATE_FILE}: ${err.message}`;
  }
}

function attachPendingLoginState(deviceAuth, saveResult) {
  const payload = {
    ...deviceAuth,
    pendingState: saveResult.ok ? 'saved' : 'unsaved',
    pendingStatePath: LOGIN_STATE_FILE,
  };
  if (!saveResult.ok) {
    payload.pendingStateError = saveResult.error;
  }
  return payload;
}

function savePendingLoginForRequest(deviceAuth) {
  try {
    savePendingLogin(deviceAuth);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
    };
  }
}

function ensureNoActivePendingLogin() {
  const pendingLogin = loadPendingLogin();
  if (!pendingLogin?.deviceCode) return;

  exitWithError(
    'A Miles login is already pending. Finish it with `miles login --poll --json`, or run `miles logout` to clear it before starting a new login.',
    2,
    {
      pendingState: 'exists',
      pendingStatePath: LOGIN_STATE_FILE,
      userCode: pendingLogin.userCode || null,
      verificationUrl: pendingLogin.verificationUrl || null,
      expiresAt: pendingLogin.expiresAt || null,
    },
  );
}

function getActiveSite(creds) {
  if (!creds.activeSite || !creds.sites?.[creds.activeSite]) return null;
  return { id: creds.activeSite, ...creds.sites[creds.activeSite] };
}

function writeLastResponse(text) {
  ensureCredentialsDir();
  writeFileSync(LAST_RESPONSE_FILE, text);
}

// ============================================================================
// In-flight run marker
//
// A fired turn runs server-side and outlives this process. The marker lets
// later invocations (and host hooks) tell the agent a run from a previous
// turn may still be in flight or have an unread result — the recovery path
// when the user interrupts the agent mid-run.
// ============================================================================

function writeActiveRun(data) {
  try {
    ensureCredentialsDir();
    writeFileSync(
      ACTIVE_RUN_FILE,
      JSON.stringify({ ...data, firedAt: new Date().toISOString() }),
    );
  } catch {
    // Marker is best-effort; the run itself is unaffected.
  }
}

function clearActiveRun() {
  try {
    if (existsSync(ACTIVE_RUN_FILE)) unlinkSync(ACTIVE_RUN_FILE);
  } catch {
    // Stale markers expire via ACTIVE_RUN_MAX_AGE_MS.
  }
}

function readActiveRun() {
  try {
    if (!existsSync(ACTIVE_RUN_FILE)) return null;
    const data = JSON.parse(readFileSync(ACTIVE_RUN_FILE, 'utf-8'));
    const ageMs = Date.now() - new Date(data.firedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > ACTIVE_RUN_MAX_AGE_MS) return null;
    return { ...data, ageMinutes: Math.max(1, Math.round(ageMs / 60000)) };
  } catch {
    return null;
  }
}

function activeRunNotice(run) {
  return `A Miles run (${run.verb}, started ${run.ageMinutes}m ago) continued server-side and either finished or is finishing now — runs always complete on their own. Quietly rejoin it with \`miles wait-job\` and present the outcome to the user; use \`miles cancel\` only if the user no longer wants that work. Do not start new Miles work over it.`;
}

/** Surface the marker on stderr so JSON stdout stays clean. */
function noteActiveRunIfAny() {
  const run = readActiveRun();
  if (!run) return;
  console.error(`[note: ${activeRunNotice(run)}]`);
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

function getCommandFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    exitWithError(`Usage: ${flag} requires a value.`, 2);
  }
  return value;
}

function getOptionalCommandFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return null;
  if (value === '') {
    exitWithError(`Usage: ${flag} value cannot be empty.`, 2);
  }
  return value;
}

function parsePositiveSecondsFlag(args, flag) {
  const value = getCommandFlagValue(args, flag);
  if (value === null) return null;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    exitWithError(`Usage: ${flag} must be a positive number of seconds.`, 2);
  }
  return seconds;
}

function getDashboardUrl(site) {
  if (!site?.dashboardUrl) return null;
  try {
    const parsed = new URL(site.dashboardUrl);
    parsed.searchParams.set('agent', 'true');
    return parsed.toString();
  } catch {
    const separator = site.dashboardUrl.includes('?') ? '&' : '?';
    return `${site.dashboardUrl}${separator}agent=true`;
  }
}

function getDashboardRedirectPath(dashboardUrl) {
  if (!dashboardUrl) return null;
  try {
    const parsed = new URL(dashboardUrl);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

async function getAuthenticatedDashboardUrl(apiKey, serverUrl, dashboardUrl) {
  if (!apiKey) return null;
  const redirect = getDashboardRedirectPath(dashboardUrl);
  if (!redirect) return null;

  try {
    const data = await apiRequest(
      'POST',
      '/api/v2/headless/auth/session-link',
      {
        auth: apiKey,
        body: { redirect },
        serverUrl,
      },
    );
    return typeof data.url === 'string' && data.url ? data.url : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

async function getDashboardOpenUrl(creds, site, serverUrl) {
  const dashboardUrl = getDashboardUrl(site);
  if (!dashboardUrl) {
    return {
      dashboardUrl: null,
      url: null,
      authenticated: false,
    };
  }
  if (site.connection?.kind === 'local-wordpress') {
    return {
      dashboardUrl,
      url: dashboardUrl,
      authenticated: false,
    };
  }
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
      ? 'A browser dashboard connection is required before this operation.'
      : `Dashboard did not connect within ${timeoutMs / 1000}s.`;
  exitWithError(
    `${prefix} Run \`miles connect-browser --json\`, open the returned authenticated url in your agent browser or regular browser, wait for connected: true, then retry the same command once.`,
    EXIT_NEED_CONNECTION,
    {
      code: 'need_connection',
      connection: { kind: 'browser-dashboard' },
      dashboardUrl,
    },
  );
}

function isDashboardConnectionRequiredError(err) {
  return (
    err instanceof ApiError &&
    (err.data?.code === 'dashboard_connection_required' ||
      err.data?.error === 'dashboard_connection_required')
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
    siteUrl: site.siteUrl || null,
    connection: site.connection || null,
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
      name: runtimeName(),
      version: runtimeVersion(),
      node: process.version,
      nodeCompatibility: process.versions.node || null,
      platform: process.platform,
      websocket: typeof globalThis.WebSocket !== 'undefined',
    },
    auth: {
      authenticated: Boolean(creds.apiKey),
      activeSite: getActiveSiteSummary(creds),
    },
  };
}

// ============================================================================
// Capabilities handshake + turn outcomes
// ============================================================================

let cachedCapabilities;

/**
 * Fetch the connected server's primitive contract. Returns null when the
 * server predates the handshake (404) or the fetch fails — callers treat
 * null as "legacy contract": the pre-handshake primitive set only.
 */
async function getServerCapabilities(serverUrl = DEFAULT_SERVER_URL) {
  if (cachedCapabilities !== undefined) return cachedCapabilities;
  try {
    cachedCapabilities = await apiRequest(
      'GET',
      '/api/v2/headless/capabilities',
      { serverUrl },
    );
  } catch {
    cachedCapabilities = null;
  }
  return cachedCapabilities;
}

/**
 * Exit 2 when the connected server does not advertise a primitive. Keeps the
 * skill honest: never run an operation the API can't deliver.
 */
async function requirePrimitive(name, serverUrl = DEFAULT_SERVER_URL) {
  const capabilities = await getServerCapabilities(serverUrl);
  if (!capabilities?.primitives?.[name]) {
    exitWithError(
      `The connected Miles server does not support \`${name}\` yet. Run \`miles doctor --json\` to see the supported primitive set.`,
      EXIT_PRECONDITION,
      { code: 'primitive_unsupported', primitive: name },
    );
  }
  return capabilities;
}

/**
 * Map a settled turn outcome to the shared exit-code grammar.
 */
function outcomeExitCode(outcome) {
  switch (outcome) {
    case 'completed':
      return EXIT_OK;
    case 'blocked':
    case 'declined':
      return EXIT_BLOCKED;
    case 'need_connection':
      return EXIT_NEED_CONNECTION;
    case 'capacity':
      return EXIT_CAPACITY;
    case 'aborted':
    case 'failed':
      return EXIT_ERROR;
    default:
      // Legacy servers do not send an outcome; preserve exit 0 behavior.
      return EXIT_OK;
  }
}

/**
 * Exit using the settled wait payload. Outcome-aware when the server sent
 * one; silent no-op (exit 0 at process end) otherwise.
 */
function exitWithTurnOutcome(data) {
  const code = outcomeExitCode(data?.approvalRequired ? 'blocked' : data?.outcome);
  if (code !== EXIT_OK) process.exit(code);
}

function parseNoWaitFlag(command, args) {
  const index = args.indexOf('--no-wait');
  if (index === -1) return { noWait: false, args };
  if (!NO_WAIT_VERBS.has(command)) {
    exitWithError(
      `--no-wait is not supported for \`${command}\`.`,
      EXIT_PRECONDITION,
    );
  }
  return {
    noWait: true,
    args: args.filter((_, i) => i !== index),
  };
}

/**
 * --no-wait ships only with cancellation. If the server can't abort a fired
 * turn, refuse to fire-and-forget it.
 */
async function ensureNoWaitSupported(serverUrl = DEFAULT_SERVER_URL) {
  await requirePrimitive('cancel', serverUrl);
}

function emitNoWaitHandle({ siteId, conversationId }) {
  emitJson({
    ok: true,
    status: 'streaming',
    siteId: siteId || null,
    conversationId,
    next: {
      watch:
        'User present? Open the url from `miles connect-browser --json` in a browser surface NOW so they watch this run live.',
      wait: 'miles wait-job',
      state: 'miles site-state --json',
      cancel: 'miles cancel',
    },
  });
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
    exitWithError('Use either `miles say --stdin` or `miles say --file <path>`, not both.', EXIT_PRECONDITION);
  }

  if (stdinIndex !== -1) {
    const remaining = args.filter((_, index) => index !== stdinIndex);
    if (remaining.length > 0) {
      exitWithError('Usage: miles say --stdin', EXIT_PRECONDITION);
    }
    return stripOneTrailingNewline(readFileSync(0, 'utf8'));
  }

  if (fileIndex !== -1) {
    const filePath = args[fileIndex + 1];
    if (!filePath) {
      exitWithError('Usage: miles say --file <path>', EXIT_PRECONDITION);
    }
    const remaining = args.filter(
      (_, index) => index !== fileIndex && index !== fileIndex + 1,
    );
    if (remaining.length > 0) {
      exitWithError('Usage: miles say --file <path>', EXIT_PRECONDITION);
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

async function apiRequest(method, path, { body, formData, auth, serverUrl } = {}) {
  const url = `${serverUrl}${path}`;
  // Multipart bodies set their own Content-Type (with boundary) via fetch.
  const headers = formData ? {} : { 'Content-Type': 'application/json' };

  if (auth) {
    headers['Authorization'] = `Bearer ${auth}`;
  }

  const opts = { method, headers };
  if (formData) {
    opts.body = formData;
  } else if (body) {
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    const sandboxError = buildSandboxNetworkError(err, url);
    if (sandboxError) throw sandboxError;
    throw err;
  }
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
    const sandboxError = buildSandboxNetworkError(
      { message: errMsg, data },
      url,
    );
    if (sandboxError) throw sandboxError;
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

class SandboxNetworkError extends Error {
  constructor(host, rawMessage) {
    super(`Sandbox blocked network access to ${host}.`);
    this.code = 'SANDBOX_NETWORK_BLOCKED';
    this.status = 'sandbox_network_blocked';
    this.host = host;
    this.requiredEgress = REQUIRED_EGRESS;
    this.rawMessage = rawMessage;
    this.remediation = {
      message:
        'Allow Miles network access in the agent sandbox, then rerun the Miles command.',
      cursorSettings:
        'Cursor Settings > Agents > Auto Run > Auto-Run Network Access: choose Allow all, or choose sandbox.json and allow *.bymiles.ai plus GitHub release hosts.',
      sandboxJsonPath: '.cursor/sandbox.json',
      sandboxJson: REQUIRED_EGRESS_SANDBOX_JSON,
      terminalFallbackCommands: [
        '~/.miles/bin/miles login --json',
        '~/.miles/bin/miles login --poll --json',
        '~/.miles/bin/miles whoami',
      ],
    };
  }
}

function collectErrorText(value, seen = new Set()) {
  if (!value || seen.has(value)) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);

  seen.add(value);
  const parts = [];
  for (const key of [
    'message',
    'error',
    'detail',
    'details',
    'stack',
    'code',
    'raw',
    'reason',
  ]) {
    if (value[key]) parts.push(String(value[key]));
  }
  if (value.data) parts.push(collectErrorText(value.data, seen));
  if (value.body) parts.push(collectErrorText(value.body, seen));
  if (value.cause) parts.push(collectErrorText(value.cause, seen));
  return parts.filter(Boolean).join('\n');
}

function extractHostFromSandboxText(text, fallbackUrl) {
  const destinationMatch = text.match(/Destination:\s*([^\s]+)/i);
  if (destinationMatch?.[1]) {
    return destinationMatch[1].replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  }
  try {
    return new URL(fallbackUrl).hostname;
  } catch {
    return 'api.bymiles.ai';
  }
}

function buildSandboxNetworkError(err, url) {
  const text = collectErrorText(err);
  const normalized = text.toLowerCase();
  const isSandboxBlock =
    normalized.includes('blocked by sandbox network policy') ||
    normalized.includes('not on allow list') ||
    normalized.includes('not on allowlist') ||
    (normalized.includes('sandbox') &&
      normalized.includes('network') &&
      normalized.includes('block'));

  if (!isSandboxBlock) return null;
  return new SandboxNetworkError(extractHostFromSandboxText(text, url), text);
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

function normalizePositiveSeconds(value, fallback) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

function buildCompleteVerificationUrl(verificationUrl, userCode) {
  if (!verificationUrl || !userCode) return null;
  try {
    const parsed = new URL(verificationUrl);
    if (parsed.searchParams.get('code') !== userCode) {
      parsed.searchParams.set('code', userCode);
    }
    return parsed.toString();
  } catch {
    throw new ApiError('Invalid login verification URL from Miles.', 502, {
      verificationUrl,
    });
  }
}

function verificationUrlHasCode(verificationUrl, userCode) {
  if (!verificationUrl || !userCode) return false;
  try {
    return new URL(verificationUrl).searchParams.get('code') === userCode;
  } catch {
    return false;
  }
}

function normalizeDeviceCodeResponse(data) {
  const deviceCode = data.deviceCode ?? data.device_code;
  const userCode = data.userCode ?? data.user_code;
  const completeUrl =
    typeof data.verificationUrlComplete === 'string'
      ? data.verificationUrlComplete
      : (data.verificationUriComplete ?? data.verification_uri_complete);
  const verificationUrl = buildCompleteVerificationUrl(
    completeUrl ??
      data.verificationUrl ??
      data.verification_url ??
      data.verificationUri ??
      data.verification_uri,
    userCode,
  );
  const intervalSeconds = normalizePositiveSeconds(
    data.intervalSeconds ?? data.interval_seconds ?? data.interval,
    5,
  );
  const expiresInSeconds = normalizePositiveSeconds(
    data.expiresInSeconds ??
      data.expires_in_seconds ??
      data.expiresIn ??
      data.expires_in,
    null,
  );

  return {
    ok: true,
    deviceCode,
    userCode,
    verificationUrl,
    verificationUrlHasCode: verificationUrlHasCode(verificationUrl, userCode),
    intervalSeconds,
    expiresInSeconds,
    expiresAt: expiresInSeconds
      ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
      : null,
  };
}

async function requestLoginDeviceCode(serverUrl) {
  const data = await apiRequest('POST', '/api/v2/auth/device/device-code', {
    serverUrl,
  });
  const deviceAuth = normalizeDeviceCodeResponse(data);
  if (
    !deviceAuth.deviceCode ||
    !deviceAuth.userCode ||
    !deviceAuth.verificationUrl ||
    !deviceAuth.expiresInSeconds
  ) {
    throw new ApiError('Invalid login response from Miles.', 502, {
      missing: {
        deviceCode: !deviceAuth.deviceCode,
        userCode: !deviceAuth.userCode,
        verificationUrl: !deviceAuth.verificationUrl,
        expiresInSeconds: !deviceAuth.expiresInSeconds,
      },
    });
  }
  return deviceAuth;
}

function printLoginRequest(deviceAuth) {
  if (cliOptions.json) {
    emitJson(deviceAuth);
    return;
  }

  console.log('Miles login requested.\n');
  console.log(`Code: ${deviceAuth.userCode}`);
  console.log(`Open: ${deviceAuth.verificationUrl}\n`);
  console.log('The page should show the same code. If it matches, click Authorize.');
  console.log('You do not need to type the code.');
  if (deviceAuth.pendingState === 'unsaved') {
    console.log(
      `Pending login state could not be saved at ${deviceAuth.pendingStatePath}: ${deviceAuth.pendingStateError}`,
    );
    console.log('Agents must use the JSON deviceCode from this command when polling.');
  } else {
    console.log('Your agent should now run `miles login --poll` and keep listening while you authorize.');
  }
}

function printLoginPollResult(result, exitStatus = 0) {
  if (cliOptions.json) {
    emitJson(result);
    if (exitStatus !== 0) process.exit(exitStatus);
    return;
  }

  if (result.status === 'authorized') {
    console.log('Logged in successfully!');
    if (result.apiKeyPrefix) {
      console.log(`API key: ${result.apiKeyPrefix}`);
    }
    return;
  }

  const messages = {
    pending: 'Authorization is still pending.',
    authorized_but_unsaved: `Authorization succeeded, but Miles could not save credentials to ${result.credentialsPath}.`,
    expired: 'Authorization expired. Start a fresh Miles login.',
    denied: 'Authorization was denied. Start a fresh Miles login to retry.',
    invalid_request: 'Miles could not poll this device code. Start a fresh Miles login.',
    sandbox_network_blocked: result.host
      ? `The agent sandbox blocked network access to ${result.host}.`
      : 'The agent sandbox blocked network access to Miles.',
    rate_limited: result.retryAfterSeconds
      ? `Miles login polling was rate limited. Wait about ${result.retryAfterSeconds}s before polling again.`
      : 'Miles login polling was rate limited. Wait before polling again.',
    transport_error: 'Miles could not reach the login server. Retry polling this same device code.',
    timeout: 'Authorization timed out. Start a fresh Miles login.',
  };
  const detail = result.error ? ` ${result.error}` : '';
  const message = `${messages[result.status] ?? `Login status: ${result.status}`}${detail}`;
  if (exitStatus === 0) {
    console.log(message);
  } else {
    console.error(message);
    process.exit(exitStatus);
  }
}

function buildAuthorizedLoginResult(tokenData) {
  const apiKeyPrefix =
    tokenData.keyPrefix ??
    (tokenData.apiKey ? `${String(tokenData.apiKey).slice(0, 8)}...` : null);
  return {
    ok: true,
    status: 'authorized',
    apiKeyPrefix,
  };
}

function sanitizeLoginErrorMessage(err, deviceCode) {
  const message = err?.message ? String(err.message) : 'Unknown login error';
  return deviceCode ? message.split(deviceCode).join('[deviceCode]') : message;
}

function loginPollResultFromApiError(err, deviceCode) {
  if (!(err instanceof ApiError)) return null;
  const error = err.data?.error;
  if (error === 'authorization_pending') return { ok: false, status: 'pending' };
  if (error === 'slow_down') {
    return {
      ok: false,
      status: 'pending',
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  if (error === 'access_denied') return { ok: false, status: 'denied' };
  if (error === 'expired_token' || error === 'invalid_grant') {
    return { ok: false, status: 'expired' };
  }
  if (
    error === 'invalid_request' ||
    error === 'invalid_client' ||
    error === 'unauthorized_client'
  ) {
    return {
      ok: false,
      status: 'invalid_request',
      error: sanitizeLoginErrorMessage(err, deviceCode),
    };
  }
  if (err.status === 429) {
    return {
      ok: false,
      status: 'rate_limited',
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  if (err.status >= 500) {
    return {
      ok: false,
      status: 'transport_error',
      error: sanitizeLoginErrorMessage(err, deviceCode),
    };
  }
  return null;
}

function loginPollResultFromSandboxError(err) {
  if (!(err instanceof SandboxNetworkError)) return null;
  return {
    ok: false,
    status: err.status,
    code: err.code,
    host: err.host,
    requiredEgress: err.requiredEgress,
    remediation: err.remediation,
    error: err.message,
  };
}

async function pollLoginDeviceCode({
  deviceCode,
  serverUrl,
  intervalSeconds,
  expiresInSeconds,
  timeoutSeconds,
  once,
}) {
  const { pollIntervalMs, maxWaitMs } = getDeviceAuthPollingPlan({
    intervalSeconds,
    expiresInSeconds,
  });
  const timeoutMs = timeoutSeconds ? timeoutSeconds * 1000 : maxWaitMs;
  const deadlineMs = Date.now() + Math.min(timeoutMs, maxWaitMs);
  let nextPollIntervalMs = pollIntervalMs;
  // Poll once immediately; agents often call --poll only after the user authorizes.
  let shouldWait = false;
  let transportFailureCount = 0;
  let lastTransportError = null;
  const maxTransportFailures = once ? 1 : 3;

  while (Date.now() < deadlineMs) {
    if (shouldWait) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((r) =>
        setTimeout(r, Math.min(nextPollIntervalMs, remainingMs)),
      );
    }
    shouldWait = true;

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
        const result = buildAuthorizedLoginResult(tokenData);
        try {
          saveCredentials({ apiKey: tokenData.apiKey });
        } catch (err) {
          return {
            ok: false,
            status: 'authorized_but_unsaved',
            apiKeyPrefix: result.apiKeyPrefix,
            credentialsPath: CREDENTIALS_FILE,
            error: sanitizeLoginErrorMessage(err, deviceCode),
          };
        }
        return result;
      }
    } catch (err) {
      const sandboxResult = loginPollResultFromSandboxError(err);
      if (sandboxResult) return sandboxResult;

      const result = loginPollResultFromApiError(err, deviceCode);
      if (!result) {
        transportFailureCount += 1;
        lastTransportError = err;
        if (transportFailureCount >= maxTransportFailures) {
          return {
            ok: false,
            status: 'transport_error',
            error: sanitizeLoginErrorMessage(err, deviceCode),
          };
        }
        continue;
      }
      transportFailureCount = 0;
      lastTransportError = null;

      if (err instanceof ApiError && err.data?.error === 'slow_down') {
        nextPollIntervalMs = getSlowedDeviceAuthPollIntervalMs(
          nextPollIntervalMs,
          err.retryAfterSeconds,
        );
      }

      if (result.status === 'pending') {
        if (once) {
          if (err instanceof ApiError && err.data?.error === 'slow_down') {
            result.nextPollIntervalSeconds = Math.ceil(nextPollIntervalMs / 1000);
          }
          return result;
        }
        continue;
      }

      return result;
    }
  }

  if (lastTransportError) {
    return {
      ok: false,
      status: 'transport_error',
      error: sanitizeLoginErrorMessage(lastTransportError, deviceCode),
    };
  }

  return {
    ok: false,
    status: 'timeout',
  };
}

async function cmdLogin(args = []) {
  loadCredentials();
  const serverUrl = DEFAULT_SERVER_URL;
  const wantsRequest = hasCommandFlag(args, '--request');
  const wantsPoll = hasCommandFlag(args, '--poll');

  if (wantsRequest && wantsPoll) {
    exitWithError('Use either `miles login` to request a code or `miles login --poll [deviceCode]` to finish an existing login, not both.', 2);
  }

  if (wantsRequest) {
    ensureNoActivePendingLogin();
    const deviceAuth = await requestLoginDeviceCode(serverUrl);
    const saveResult = savePendingLoginForRequest(deviceAuth);
    printLoginRequest(attachPendingLoginState(deviceAuth, saveResult));
    return;
  }

  if (wantsPoll) {
    const explicitDeviceCode = getOptionalCommandFlagValue(args, '--poll');
    const pendingLogin = explicitDeviceCode ? null : loadPendingLogin();
    const deviceCode = explicitDeviceCode ?? pendingLogin?.deviceCode;
    if (!deviceCode) {
      exitWithError('No pending Miles login found. Run `miles login` first, show the code to the user, then run `miles login --poll` after they authorize.', 2);
    }
    const result = await pollLoginDeviceCode({
      deviceCode,
      serverUrl,
      intervalSeconds:
        parsePositiveSecondsFlag(args, '--interval') ??
        pendingLogin?.intervalSeconds ??
        5,
      expiresInSeconds:
        parsePositiveSecondsFlag(args, '--expires-in') ??
        pendingLogin?.expiresInSeconds ??
        600,
      timeoutSeconds: parsePositiveSecondsFlag(args, '--timeout'),
      once: hasCommandFlag(args, '--once'),
    });
    if (['authorized', 'expired', 'denied', 'invalid_request', 'timeout'].includes(result.status)) {
      const cleanupWarning = clearPendingLogin();
      if (cleanupWarning) {
        result.cleanupWarning = cleanupWarning;
        if (!cliOptions.json) console.error(cleanupWarning);
      }
    }
    const exitStatus =
      result.status === 'authorized' || result.status === 'pending' ? 0 : 1;
    printLoginPollResult(result, exitStatus);
    return;
  }

  ensureNoActivePendingLogin();
  const deviceAuth = await requestLoginDeviceCode(serverUrl);
  const saveResult = savePendingLoginForRequest(deviceAuth);
  printLoginRequest(attachPendingLoginState(deviceAuth, saveResult));
}

async function cmdLogout() {
  saveCredentials({});
  const cleanupWarning = clearPendingLogin();
  if (cliOptions.json) {
    const payload = { ok: true, authenticated: false, milesHome: MILES_HOME };
    if (cleanupWarning) payload.cleanupWarning = cleanupWarning;
    emitJson(payload);
  } else {
    if (cleanupWarning) console.error(cleanupWarning);
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
    console.log(
      'Not logged in. Run `miles login` to get a device login code.',
    );
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
  let milesHomeDetail = MILES_HOME;
  let milesHomeWritable = true;
  try {
    ensureCredentialsDir();
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
      name: 'runtime',
      ok: runtimeIsSupported(),
      detail: runtimeDetail(),
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
        : 'Not logged in. Run `miles login` to get a device login code.',
    },
  ];

  // Capabilities handshake: which primitives the connected server supports.
  // Best-effort — a legacy server (or no network) reports contract: null.
  const capabilities = await getServerCapabilities();

  const result = {
    status: checks.every((check) => check.ok) ? 'ok' : 'needs_setup',
    checks,
    ...summary,
    server: {
      url: DEFAULT_SERVER_URL,
      contract: capabilities?.contract ?? null,
      schemaVersion: capabilities?.schemaVersion ?? null,
      primitives: capabilities ? Object.keys(capabilities.primitives) : null,
    },
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

async function cmdCreateSite(rawArgs) {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    exitWithError(
      'Not logged in. Run `miles auth login` to get a device login code.',
      EXIT_PRECONDITION,
    );
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const { noWait, args: argsAfterNoWait } = parseNoWaitFlag(
    'site-create',
    rawArgs,
  );
  if (noWait) await ensureNoWaitSupported(serverUrl);
  const { attachPaths, args } = parseAttachFlags(argsAfterNoWait);

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
        exitWithError(
          `Could not read brief file: ${briefPath}`,
          EXIT_PRECONDITION,
          {
            cause: err.message,
          },
        );
      }
    } else if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    } else {
      message = args[i];
    }
  }

  if (!message) {
    exitWithError(
      'Usage: miles site-create "<description>" [--name "Site Name"] [--brief <file>] [--attach <file>] [--no-wait]',
      EXIT_PRECONDITION,
    );
  }

  // Attachments must exist before the create call: the build fires inside
  // the same request. The API key gives them account scope, which is the
  // only scope create-site accepts (the site doesn't exist yet).
  let uploadedFiles = null;
  if (attachPaths.length) {
    const refs = await uploadAttachments(attachPaths, {
      auth: creds.apiKey,
      serverUrl,
    });
    uploadedFiles = refs.map(toUploadedFileRef);
  }

  if (!noWait) {
    console.log('Creating site and starting conversation with Miles...');
  }

  const body = { message };
  if (name) body.name = name;
  if (brief) body.brief = brief;
  if (uploadedFiles) body.uploadedFiles = uploadedFiles;

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
  writeActiveRun({
    verb: 'site-create',
    siteId: data.siteId,
    conversationId: data.conversationId,
  });

  if (noWait) {
    emitNoWaitHandle({
      siteId: data.siteId,
      conversationId: data.conversationId,
    });
    return;
  }

  console.log(`Dashboard: ${data.dashboardUrl}`);

  const settled = await doWait(creds, data.conversationId, serverUrl);
  exitWithTurnOutcome(settled);
}

async function cmdSay(rawArgs) {
  noteActiveRunIfAny();
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError(
      'No active conversation. Use `miles site-create` to start one, or `miles site-attach <siteId>` to resume an existing site.',
      EXIT_PRECONDITION,
    );
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const { noWait, args: argsAfterNoWait } = parseNoWaitFlag('say', rawArgs);
  if (noWait) await ensureNoWaitSupported(serverUrl);
  const { attachPaths, args } = parseAttachFlags(argsAfterNoWait);

  const message = readReplyMessage(args);
  if (!message) {
    exitWithError(
      'Usage: miles say "<message>" [--attach <file>] | miles say --stdin | miles say --file <path>',
      EXIT_PRECONDITION,
    );
  }

  // The site token scopes uploads to this site — exactly where the refs are
  // about to be used.
  let uploadedFiles = null;
  if (attachPaths.length) {
    const refs = await uploadAttachments(attachPaths, {
      auth: site.siteToken,
      serverUrl,
    });
    uploadedFiles = refs.map(toUploadedFileRef);
  }

  const sayBody = { message };
  if (uploadedFiles) sayBody.uploadedFiles = uploadedFiles;

  let response;
  try {
    response = await apiRequest(
      'POST',
      `/api/v2/headless/conversations/${site.conversationId}/message`,
      {
        auth: site.siteToken,
        body: sayBody,
        serverUrl,
      },
    );
  } catch (err) {
    if (isDashboardConnectionRequiredError(err)) {
      exitWithDashboardConnectionRequired(site);
    }
    throw err;
  }

  writeActiveRun({
    verb: 'say',
    siteId: site.id,
    conversationId: site.conversationId,
  });

  if (noWait) {
    emitNoWaitHandle({
      siteId: site.id,
      conversationId: site.conversationId,
    });
    return;
  }

  const settled = await doWait(creds, site.conversationId, serverUrl, undefined, {
    sinceMessageId: response?.sinceMessageId,
  });
  exitWithTurnOutcome(settled);
}

async function cmdWait() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const settled = await doWait(creds, site.conversationId, serverUrl);
  exitWithTurnOutcome(settled);
}

/**
 * Plumbing wait: poll the settled turn over REST only, progress to stderr,
 * one JSON result on stdout, outcome-mapped exit code. The composable
 * counterpart to the streaming `wait` used by the guided flow.
 */
async function cmdWaitJob(args, options = {}) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const timeoutSeconds = parsePositiveSecondsFlag(args, '--timeout');
  const maxWait = timeoutSeconds ? timeoutSeconds * 1000 : MAX_WAIT_MS;
  const startTime = Date.now();
  let lastProgress = '';
  let consecutiveFailures = 0;

  while (Date.now() - startTime < maxWait) {
    let data;
    try {
      data = await apiRequest(
        'GET',
        `/api/v2/headless/conversations/${site.conversationId}/wait?timeout=${POLL_TIMEOUT_MS}${
          options.sinceMessageId
            ? `&sinceMessageId=${encodeURIComponent(options.sinceMessageId)}`
            : ''
        }`,
        { auth: site.siteToken, serverUrl },
      );
      consecutiveFailures = 0;
    } catch (err) {
      // Transient transport failures (server restart, network blip) should
      // not kill a long wait; only give up after repeated failures.
      if (err instanceof ApiError || ++consecutiveFailures >= 3) {
        throw err;
      }
      console.error(`Poll failed (${err.message}); retrying...`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    if (data.status === 'running') {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const progressMsg =
        formatProgress(data.progress, elapsed) ||
        `phase: ${data.phase || 'working'} (${elapsed}s)`;
      if (progressMsg !== lastProgress) {
        console.error(progressMsg);
        lastProgress = progressMsg;
      }
      continue;
    }

    const approvalRequired = sanitizeApprovalRequired(data.approvalRequired);
    const result = {
      ok: approvalRequired
        ? false
        : data.outcome
          ? data.outcome === 'completed'
          : data.status !== 'failed',
      status: data.status,
      outcome: data.outcome || null,
      outcomeUnresolved: data.outcomeUnresolved || undefined,
      outcomeReason: data.outcomeReason || undefined,
      approvalRequired: approvalRequired || undefined,
      phase: data.phase || null,
      milesMessage: data.milesMessage || null,
      question: data.question || null,
      brief: data.brief || null,
      directions: data.directions || undefined,
      selectedDirectionId: data.selectedDirectionId || null,
      siteReady: Boolean(data.siteReady),
      error: data.error || undefined,
      credits: data.credits || undefined,
    };
    clearActiveRun();
    writeLastResponse(formatWaitResponse(data));
    emitJson(result);
    process.exit(outcomeExitCode(approvalRequired ? 'blocked' : data.outcome));
  }

  emitJson({
    ok: false,
    status: 'running',
    error: `Turn still running after ${Math.round(maxWait / 1000)}s. Run miles wait-job again to keep waiting, or miles cancel to stop the run.`,
  });
  process.exit(EXIT_ERROR);
}

function findApprovalShortcutFlag(args) {
  return args.find((arg) => {
    const [flag] = arg.split('=');
    return ['--yes', '-y', '--force', '--auto', '--approve', '--decline'].includes(
      flag,
    );
  });
}

/**
 * Explicitly answer a live-protection grant. This is intentionally separate
 * from `say`: ordinary chat text must never approve protected live-site writes.
 */
async function cmdApprovalRespond(args) {
  noteActiveRunIfAny();
  const shortcutFlag = findApprovalShortcutFlag(args);
  if (shortcutFlag) {
    exitWithError(
      `Usage: ${shortcutFlag} is not allowed for approval responses. Ask the user, then pass the exact response with --response approved|declined.`,
      EXIT_PRECONDITION,
    );
  }

  const grantId = getCommandFlagValue(args, '--grant');
  const response = getCommandFlagValue(args, '--response');
  if (!grantId || !response) {
    exitWithError(
      'Usage: miles approval-respond --grant <id> --response approved|declined',
      EXIT_PRECONDITION,
    );
  }
  if (response !== 'approved' && response !== 'declined') {
    exitWithError(
      'Usage: --response must be either approved or declined.',
      EXIT_PRECONDITION,
    );
  }

  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await requirePrimitive('approval-respond', serverUrl);

  const start = await apiRequest(
    'POST',
    `/api/v2/headless/conversations/${site.conversationId}/approval-response`,
    {
      auth: site.siteToken,
      body: { grantId, response },
      serverUrl,
    },
  );

  writeActiveRun({
    verb: 'approval-respond',
    siteId: site.id,
    conversationId: site.conversationId,
  });

  if (cliOptions.json) {
    return cmdWaitJob([], { sinceMessageId: start?.sinceMessageId });
  }

  const settled = await doWait(creds, site.conversationId, serverUrl, undefined, {
    sinceMessageId: start?.sinceMessageId,
  });
  if (!settled) {
    exitWithError(
      'Approval response was sent, but Miles did not return a settled result. Run `miles wait-job --json` before continuing.',
      EXIT_ERROR,
    );
  }
  exitWithTurnOutcome(settled);
}

/**
 * Cancel the running turn for the active conversation.
 */
async function cmdCancel() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await requirePrimitive('cancel', serverUrl);

  const data = await apiRequest(
    'POST',
    `/api/v2/headless/conversations/${site.conversationId}/abort`,
    { auth: site.siteToken, serverUrl },
  );

  clearActiveRun();
  if (cliOptions.json) {
    emitJson({ ok: true, message: data.message || 'Aborted.' });
    return;
  }
  console.log(data.message || 'Aborted.');
}

/**
 * Undo the last agent turn: restores the site to the checkpoint captured
 * before the turn AND truncates the chat history to that boundary. One
 * level only — the checkpoint covers the most recent turn, and a
 * successful undo consumes it. `miles site-state --json` reports
 * `undoAvailable` so you can check before calling.
 */
async function cmdUndo() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await requirePrimitive('undo', serverUrl);

  let data;
  try {
    data = await apiRequest(
      'POST',
      `/api/v2/headless/conversations/${site.conversationId}/revert`,
      { auth: site.siteToken, serverUrl },
    );
  } catch (err) {
    // 404 no-checkpoint / 410 checkpoint-corrupt mean there is nothing to
    // undo — a missing precondition, not an internal error.
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      exitWithError(err.message, EXIT_PRECONDITION, {
        code: err.data?.kind || 'no_checkpoint',
      });
    }
    throw err;
  }

  if (cliOptions.json) {
    emitJson({
      ok: true,
      kind: data.kind,
      snapshotVersion: data.snapshotVersion,
      truncatedMessages: data.truncatedMessages,
      browserRefreshRequired: Boolean(data.browserRefreshRequired),
    });
    return;
  }
  console.log('Reverted the site and chat to before the last turn.');
  if (data.browserRefreshRequired) {
    console.log(
      '[note: if a dashboard tab is open, reload it to see the restored site]',
    );
  }
}

/**
 * Enumerate the built static site's files, or fetch one file's content.
 * Listing and fetching are fully headless (the files live in storage).
 */
async function cmdSitePages(args) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await requirePrimitive('site-pages', serverUrl);

  const outputPath = getOptionalCommandFlagValue(args, '--output');
  const path = args.find((a) => !a.startsWith('--') && a !== outputPath);

  if (!path) {
    const data = await apiRequest(
      'GET',
      `/api/v2/headless/conversations/${site.conversationId}/site-pages`,
      { auth: site.siteToken, serverUrl },
    );
    if (cliOptions.json) {
      emitJson({ slug: data.slug, files: data.files || [] });
      return;
    }
    console.log(`[slug: ${data.slug}]`);
    (data.files || []).forEach((f) => {
      console.log(`  ${f.path}  (${f.mimeType}, ${f.sizeBytes} bytes)`);
    });
    return;
  }

  // Fetch one file. Binary-safe: write to --output when given, else print
  // text content to stdout.
  const endpoint = `${serverUrl}/api/v2/headless/conversations/${site.conversationId}/site-pages/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${site.siteToken}` },
  });
  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch {
      // Non-JSON error body.
    }
    exitWithError(
      detail?.error || `Failed to fetch ${path} (HTTP ${response.status})`,
      response.status === 404 ? EXIT_PRECONDITION : EXIT_ERROR,
      detail,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (outputPath) {
    writeFileSync(outputPath, buffer);
    if (cliOptions.json) {
      emitJson({ ok: true, path: outputPath, bytes: buffer.byteLength });
      return;
    }
    console.log(outputPath);
    return;
  }
  process.stdout.write(buffer);
}

/**
 * Account-scoped credit transaction history (requires the API key — site
 * tokens are conversation-scoped and cannot read account billing).
 */
async function cmdUsageHistory(args) {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    exitWithError(
      'Not logged in. Run `miles auth login` first (usage history needs the account API key).',
      EXIT_PRECONDITION,
    );
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await requirePrimitive('usage-history', serverUrl);

  const params = new URLSearchParams();
  const limit = getOptionalCommandFlagValue(args, '--limit');
  const offset = getOptionalCommandFlagValue(args, '--offset');
  const type = getOptionalCommandFlagValue(args, '--type');
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  if (type) params.set('type', type);
  const query = params.toString() ? `?${params.toString()}` : '';

  const data = await apiRequest(
    'GET',
    `/api/v2/headless/account/transactions${query}`,
    { auth: creds.apiKey, serverUrl },
  );

  if (cliOptions.json) {
    emitJson(data);
    return;
  }
  (data.transactions || []).forEach((tx) => {
    const sign = tx.isDeduction ? '-' : '+';
    console.log(
      `${tx.createdAt}  ${sign}${tx.amountCredits} credits  [${tx.type}]  ${tx.description || ''}  (balance: ${tx.balanceAfterCredits})`,
    );
  });
  if (data.pagination?.hasMore) {
    console.log(
      `[more available: rerun with --offset ${(data.pagination.offset || 0) + (data.pagination.limit || 50)}]`,
    );
  }
}

/**
 * Rename the active conversation (1-100 chars). Returns the theme slug so a
 * connected agent can also update the WordPress theme display name.
 */
async function cmdRename(args) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const title = args.find((a) => !a.startsWith('--'));
  if (!title) {
    exitWithError('Usage: miles rename "New site name"', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await requirePrimitive('rename', serverUrl);

  const data = await apiRequest(
    'PATCH',
    `/api/v2/headless/conversations/${site.conversationId}/title`,
    { auth: site.siteToken, serverUrl, body: { title } },
  );

  if (cliOptions.json) {
    emitJson({ ok: true, title: data.title, themeSlug: data.themeSlug });
    return;
  }
  console.log(`Renamed to: ${data.title}`);
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

function sanitizeProgressText(value) {
  if (typeof value !== 'string') return null;
  // Server-side summaries are the source of truth; this client scrubber is a display backstop.
  let text = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[`*_#>]+/g, '')
    .trim();
  if (!text) return null;

  text = text
    .replace(
      /([?&](?:code|token|jwt|key|secret|signature|state|authorization|apiKey|api_key|access_token|refresh_token)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\/Users\/[^\s]+/g, '[local path]')
    .replace(/\/home\/[^\s]+/g, '[local path]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[local path]')
    .replace(/\/app\/[^\s]+/g, '[app path]');

  if (text.startsWith('Miles:')) {
    text = text.slice('Miles:'.length).trim();
  }

  if (text.length > MAX_PROGRESS_TEXT_CHARS) {
    text = `${text.slice(0, MAX_PROGRESS_TEXT_CHARS - 1).trimEnd()}…`;
  }

  return text || null;
}

function sanitizeApprovalRequired(approval) {
  if (!approval || typeof approval !== 'object') return null;

  const grantId =
    typeof approval.grantId === 'string' ? approval.grantId : null;
  const summary = sanitizeProgressText(approval.summary);
  const category =
    typeof approval.category === 'string'
      ? sanitizeProgressText(approval.category)
      : null;
  if (!grantId || !summary) return null;

  const actions = Array.isArray(approval.actions)
    ? approval.actions
        .map((action) => {
          if (!action || typeof action !== 'object') return null;
          const actionSummary = sanitizeProgressText(action.summary);
          if (!actionSummary) return null;
          const item = { summary: actionSummary };
          if (typeof action.scope === 'string') {
            const scope = sanitizeProgressText(action.scope);
            if (scope) item.scope = scope;
          }
          return item;
        })
        .filter(Boolean)
    : [];

  return {
    type: 'live_protection',
    grantId,
    summary,
    actions,
    ...(category ? { category } : {}),
    ...(Number.isInteger(approval.riskTier)
      ? { riskTier: approval.riskTier }
      : {}),
    ...(typeof approval.timestamp === 'number'
      ? { timestamp: approval.timestamp }
      : {}),
    ...(approval.firstWrite === true ? { firstWrite: true } : {}),
  };
}

function appendApprovalRequiredLines(lines, approval) {
  const clean = sanitizeApprovalRequired(approval);
  if (!clean) return;

  lines.push('');
  lines.push('[approval_required]');
  lines.push(`grant: ${clean.grantId}`);
  lines.push(`summary: ${clean.summary}`);
  if (clean.category) lines.push(`category: ${clean.category}`);
  if (clean.riskTier !== undefined) lines.push(`risk_tier: ${clean.riskTier}`);
  if (clean.actions.length) {
    lines.push('actions:');
    clean.actions.forEach((action) => {
      const prefix = action.scope ? `${action.scope}: ` : '';
      lines.push(`  - ${prefix}${action.summary}`);
    });
  }
  lines.push(
    '[note: Ask the user to approve or decline this specific protected change. Do not infer approval from the original request, silence, "continue", or a broad yes.]',
  );
}

function formatActionProgress(text, elapsed) {
  const clean = sanitizeProgressText(text);
  if (!clean) return null;
  return `Miles: ${clean} (${elapsed}s)`;
}

function extractActionDescription(input) {
  if (!input || typeof input !== 'object') return null;
  const value = input._actionDescription;
  return typeof value === 'string' ? value : null;
}

function extractActionDescriptionFromInputText(inputText) {
  if (typeof inputText !== 'string' || !inputText.includes('_actionDescription')) {
    return null;
  }

  try {
    const parsed = JSON.parse(inputText);
    return extractActionDescription(parsed);
  } catch {}

  const match = inputText.match(
    /"_actionDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/,
  );
  if (!match) return null;

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function publicToolProgressLabel(toolName) {
  if (typeof toolName !== 'string' || !toolName) return null;

  const toolLabels = [
    [/getPageOutline/i, 'reading page outline'],
    [/searchBlocks/i, 'locating matching blocks'],
    [/getBlockDetails/i, 'inspecting block structure'],
    [/getBlockStyleDiagnostics/i, 'checking layout styles'],
    [/updateBlockAttributes|patchBlockCss|batchEdit/i, 'applying page changes'],
    [/insertBlock|createPattern|reusePattern/i, 'adding page content'],
    [/removeBlock|deletePattern/i, 'removing page content'],
    [/moveBlock|duplicateBlock/i, 'rearranging page content'],
    [/focusBlock/i, 'selecting page content'],
    [/saveEditor|savePattern|save/i, 'saving changes'],
    [/screenshot/i, 'capturing a visual check'],
    [/generateImage|uploadMedia/i, 'working on images'],
    [/listAvailableBlocks|getSchema|getPatterns|getMilesPatterns/i, 'checking available page components'],
    [/httpRequest|discoverEndpoints|wpRest/i, 'checking WordPress data'],
    [/buildPage|createContent/i, 'building page content'],
    [/task/i, 'coordinating specialist work'],
    [/gutenberg/i, 'working in the WordPress editor'],
  ];

  for (const [pattern, label] of toolLabels) {
    if (pattern.test(toolName)) return label;
  }

  return null;
}

function formatToolProgress(chunk, elapsed) {
  const actionDescription = extractActionDescription(chunk.input);
  return formatActionProgress(
    actionDescription || chunk.title || publicToolProgressLabel(chunk.toolName),
    elapsed,
  );
}

function formatObservationProgress(data, elapsed) {
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'error') {
    return formatActionProgress('encountered an issue while updating progress', elapsed);
  }
  return formatActionProgress(data.content, elapsed);
}

function formatAgentSwitchProgress(data, elapsed) {
  const agentName = data?.agentName;
  if (typeof agentName !== 'string') return null;

  if (/gutenberg|wordpress|editor/i.test(agentName)) {
    return formatActionProgress('checking the WordPress editor', elapsed);
  }
  if (/static|site|design/i.test(agentName)) {
    return formatActionProgress('reviewing the site design', elapsed);
  }
  if (/image/i.test(agentName)) {
    return formatActionProgress('working on images', elapsed);
  }

  return formatActionProgress('coordinating specialist work', elapsed);
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
    let lastProgressKey = '';
    let hasStreamedText = false;
    let hasReasoningProgress = false;
    let finished = false;
    let heartbeatTimer = null;
    let subscribeMessageId = null;
    let settledData = null;
    const activeToolInput = new Map();

    const emitProgress = (message, key = message) => {
      if (!message || key === lastProgressKey) return;
      console.log(message);
      lastProgressKey = key;
    };

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
          settledData = data;
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
      resolve({ handled: true, data: settledData });
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
          const alreadyDone = await fetchAndOutput(100);
          if (alreadyDone) {
            cleanup();
            clearTimeout(timeoutTimer);
            resolve({ handled: true, data: settledData });
            return;
          }

          // Still running — start heartbeat timer
          heartbeatTimer = setInterval(() => {
            if (finished) return;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (elapsed > 0 && elapsed % 30 === 0) {
              emitProgress(
                `Miles: stream active (${elapsed}s)`,
                'stream-active',
              );
            }
          }, 5000);
          return;
        }

        // Handle conversation chunks
        if (msg.type === 'conversation.chunk') {
          const chunk = msg.chunk || msg;
          const elapsed = Math.round((Date.now() - startTime) / 1000);

          if (chunk.type === 'reasoning-start' || chunk.type === 'reasoning-delta') {
            if (!hasReasoningProgress) {
              emitProgress(
                formatActionProgress('planning the edit', elapsed),
                'reasoning',
              );
              hasReasoningProgress = true;
            }
          }
          // Tool activity — show public titles, streamed action descriptions, or safe labels.
          else if (chunk.type === 'tool-input-start') {
            const toolCallId = chunk.toolCallId || chunk.id;
            if (toolCallId) {
              activeToolInput.set(toolCallId, {
                toolName: chunk.toolName,
                inputText: '',
                emittedActionDescription: false,
              });
            }
          } else if (chunk.type === 'tool-input-delta') {
            const toolCallId = chunk.toolCallId || chunk.id;
            const delta = chunk.inputTextDelta || chunk.delta || '';
            if (toolCallId && typeof delta === 'string') {
              const existing = activeToolInput.get(toolCallId) || {
                toolName: chunk.toolName,
                inputText: '',
                emittedActionDescription: false,
              };
              existing.inputText = `${existing.inputText || ''}${delta}`;
              if (chunk.toolName && !existing.toolName) {
                existing.toolName = chunk.toolName;
              }
              activeToolInput.set(toolCallId, existing);

              if (!existing.emittedActionDescription) {
                const desc = extractActionDescriptionFromInputText(
                  existing.inputText,
                );
                const progressMsg = formatActionProgress(desc, elapsed);
                if (progressMsg) {
                  emitProgress(progressMsg, `action:${toolCallId}:${desc}`);
                  existing.emittedActionDescription = true;
                }
              }
            }
          } else if (chunk.type === 'tool-input-available') {
            const toolCallId = chunk.toolCallId || chunk.id;
            const progressMsg = formatToolProgress(chunk, elapsed);
            const key =
              extractActionDescription(chunk.input) ||
              chunk.title ||
              publicToolProgressLabel(chunk.toolName) ||
              progressMsg;
            emitProgress(progressMsg, key ? `tool:${key}` : progressMsg);
            if (toolCallId) activeToolInput.delete(toolCallId);
          } else if (chunk.type === 'tool-input-error') {
            emitProgress(
              formatActionProgress('checking a failed tool input', elapsed),
              `tool-error:${chunk.toolCallId || chunk.id || elapsed}`,
            );
          } else if (chunk.type === 'tool-output-error') {
            emitProgress(
              formatActionProgress('tool step failed', elapsed),
              `tool-output-error:${chunk.toolCallId || chunk.id || elapsed}`,
            );
          }
          // Text streaming — print one narrative line when Miles starts responding.
          // Full text is fetched via REST when the finish chunk arrives.
          else if (
            chunk.type === 'text-delta' &&
            (chunk.delta || chunk.text)
          ) {
            if (!hasStreamedText) {
              emitProgress(
                formatActionProgress('writing the response', elapsed),
                'text-response',
              );
              hasStreamedText = true;
            }
          }
          // User input required. Poll as a fallback in case the finish event is delayed.
          else if (chunk.type === 'data-user-question') {
            const firstQ = chunk.data?.questions?.[0];
            if (firstQ?.question) {
              emitProgress(
                `Miles has a question: ${firstQ.question} (${elapsed}s)`,
                'question',
              );
              if (firstQ.options?.length) {
                firstQ.options.forEach((opt, i) => {
                  console.log(`  ${i + 1}. ${opt.label}`);
                });
              }
            } else {
              emitProgress(
                `Miles has a question for you (${elapsed}s)`,
                'question',
              );
            }
            // Safety-net fallback: poll REST if finish chunk is delayed
            setTimeout(async () => {
              try {
                if (finished) return;
                const done = await fetchAndOutput(5000);
                if (done) {
                  cleanup();
                  clearTimeout(timeoutTimer);
                  resolve({ handled: true, data: settledData });
                }
              } catch (err) {
                fallBackToPolling(err);
              }
            }, 5000);
          } else if (chunk.type === 'data-brief-editor') {
            emitProgress(
              `Miles has prepared a design brief for review (${elapsed}s)`,
              'brief',
            );
            // Safety-net fallback: poll REST if finish chunk is delayed
            setTimeout(async () => {
              try {
                if (finished) return;
                const done = await fetchAndOutput(5000);
                if (done) {
                  cleanup();
                  clearTimeout(timeoutTimer);
                  resolve({ handled: true, data: settledData });
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
            let progressMsg = null;
            if (chunk.type === 'data-observation') {
              progressMsg = formatObservationProgress(chunk.data, elapsed);
            } else if (chunk.type === 'data-agent-switch') {
              progressMsg = formatAgentSwitchProgress(chunk.data, elapsed);
            } else {
              const progress = { type: chunk.type, data: chunk.data };
              progressMsg = formatProgress(progress, elapsed);
            }
            emitProgress(progressMsg, progressMsg);
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
              resolve(false);
              return;
            }
            resolve({ handled: true, data: settledData });
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

  // Try WebSocket first for real-time progress
  const wsHandled = await doWaitWebSocket(
    creds,
    conversationId,
    serverUrl,
    maxWaitMs,
    options,
  );
  if (wsHandled) {
    if (wsHandled.data) clearActiveRun();
    return wsHandled.data ?? null;
  }

  // Fallback: polling loop
  const startTime = Date.now();
  let lastDirectionCount = 0;
  let announcedPhase = '';
  let lastProgressMsg = '';

  while (Date.now() - startTime < maxWait) {
    const data = await apiRequest(
      'GET',
      `/api/v2/headless/conversations/${conversationId}/wait?timeout=${POLL_TIMEOUT_MS}${
        options.sinceMessageId
          ? `&sinceMessageId=${encodeURIComponent(options.sinceMessageId)}`
          : ''
      }`,
      { auth: token, serverUrl },
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
        console.log(`Miles: stream active (${elapsed}s)`);
      }

      continue;
    }

    // Got a response
    clearActiveRun();
    const output = formatWaitResponse(data);
    writeLastResponse(output);
    console.log('');
    console.log(output);
    return data;
  }

  // Timed out - tell the agent what's happening so it can act
  const statusMsg = announcedPhase
    ? `Miles is still working. [phase: ${announcedPhase}]`
    : 'Miles is still working.';
  console.log(statusMsg);
  console.log('Use `miles wait` to continue polling for the response.');
  return null;
}

function formatWaitResponse(data) {
  const lines = [];

  lines.push(`[status: ${data.status}]`);
  if (data.outcome) {
    lines.push(`[outcome: ${data.outcome}]`);
    if (data.outcome === 'blocked' || data.outcome === 'declined') {
      const unresolved = Array.isArray(data.outcomeUnresolved)
        ? data.outcomeUnresolved
        : [];
      for (const item of unresolved) {
        lines.push(`[unresolved: ${item}]`);
      }
      lines.push(
        data.outcome === 'declined'
          ? '[note: The user declined this work. Do not retry or route around the decline.]'
          : '[note: The requested work did not happen. Resolve the blocker before retrying.]',
      );
    } else if (data.outcomeReason) {
      lines.push(`[outcome_reason: ${data.outcomeReason}]`);
    }
  }
  lines.push(`[phase: ${data.phase}]`);

  appendApprovalRequiredLines(lines, data.approvalRequired);

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
      '[edit: To make changes to this WordPress site, run: miles say "describe your changes"]',
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
  noteActiveRunIfAny();
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
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
      approvalRequired: sanitizeApprovalRequired(data.approvalRequired) || null,
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
  const approvalLines = [];
  appendApprovalRequiredLines(approvalLines, data.approvalRequired);
  approvalLines.forEach((line) => console.log(line));

  // Provide actionable hints based on current phase
  if (
    data.conversationStatus === 'waiting_for_user_input' &&
    (data.phase === 'site_preview' || data.phase === 'site_generation')
  ) {
    console.log(
      '[edit: To request changes to the site, run: miles say "describe your changes"]',
    );
    console.log(
      '[build: When edits are done, run: miles convert-theme — to convert the site to a WordPress theme]',
    );
  }
  if (data.siteReady) {
    console.log(
      '[edit: To make changes to this WordPress site, run: miles say "describe your changes"]',
    );
  }
}

async function cmdDesignDirections() {
  noteActiveRunIfAny();
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
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
        directionId: h.directionId || null,
        name: h.directionName || `Design ${h.number}`,
        status: h.status || null,
        selectable: h.selectable !== undefined ? Boolean(h.selectable) : null,
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
    console.log('Use `miles say` to continue the conversation with Miles.');
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
    console.log(`\nUse \`miles build-site --design <number>\` to choose a design and build the full site.`);
  }
}

/**
 * Commit a design direction and build the full HTML site. Fully headless:
 * the server build pipeline does not need a browser. Open the dashboard with
 * `miles connect-browser` only when the user wants to watch progress live.
 */
async function cmdBuildSite(rawArgs) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const { noWait, args } = parseNoWaitFlag('build-site', rawArgs);
  if (noWait) await ensureNoWaitSupported(serverUrl);

  const designFlag = getOptionalCommandFlagValue(args, '--design');
  const positional = args.find((a) => /^\d+$/.test(a));
  const rawDirectionNumber = designFlag ?? positional;
  if (!/^\d+$/.test(rawDirectionNumber || '')) {
    exitWithError(
      'Usage: miles build-site --design <number> [--no-wait]',
      EXIT_PRECONDITION,
    );
  }
  const directionNumber = parseInt(rawDirectionNumber, 10);

  if (!noWait) {
    console.log(
      `Selecting design direction ${directionNumber} and starting the site build...`,
    );
  }

  let data;
  try {
    data = await apiRequest(
      'POST',
      `/api/v2/headless/conversations/${site.conversationId}/select-design-direction`,
      { auth: site.siteToken, body: { directionNumber }, serverUrl },
    );
  } catch (err) {
    if (isDashboardConnectionRequiredError(err)) {
      exitWithDashboardConnectionRequired(site);
    }
    throw err;
  }

  writeActiveRun({
    verb: 'build-site',
    siteId: site.id,
    conversationId: site.conversationId,
  });

  if (noWait) {
    emitNoWaitHandle({
      siteId: site.id,
      conversationId: site.conversationId,
    });
    return;
  }

  console.log(data.message);
  console.log('');
  console.log('Waiting for Miles to build the site...');

  const settled = await doWait(creds, site.conversationId, serverUrl);
  exitWithTurnOutcome(settled);
}

// ============================================================================
// Asset uploads (logos, imagery, content documents)
// ============================================================================

// Best-effort Content-Type for the multipart part. The server re-infers from
// the extension when the type is missing or wrong, so this only needs to
// cover the common cases.
const UPLOAD_EXTENSION_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.rtf': 'application/rtf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function inferUploadMimeType(filename) {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  return (ext && UPLOAD_EXTENSION_MIME[ext]) || 'application/octet-stream';
}

/**
 * Upload one file to POST /headless/assets and return the minimal ref the
 * other routes accept as `uploadedFiles`: s3Key + filename + mimeType (the
 * server rebuilds URLs from the validated key; refs never carry URLs).
 * sizeBytes is included for display only.
 */
async function uploadAssetFile(filePath, { auth, serverUrl }) {
  const buffer = readFileSync(filePath);
  const filename = basename(filePath);
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([buffer], { type: inferUploadMimeType(filename) }),
    filename,
  );

  const data = await apiRequest('POST', '/api/v2/headless/assets', {
    auth,
    formData,
    serverUrl,
  });

  return {
    s3Key: data.s3Key,
    filename: data.filename,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
  };
}

/**
 * Extract repeated `--attach <path>` pairs, returning the remaining args
 * untouched so message/brief parsing sees the grammar it expects.
 */
function parseAttachFlags(args) {
  const attachPaths = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--attach') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        exitWithError('--attach requires a file path.', EXIT_PRECONDITION, {
          example: 'miles site-create "..." --attach ./logo.png',
        });
      }
      attachPaths.push(args[++i]);
    } else {
      rest.push(args[i]);
    }
  }
  return { attachPaths, args: rest };
}

/**
 * Upload a list of local files and return their refs. Gated on the server
 * advertising `upload-assets`; fails fast on a missing file before any
 * network work.
 */
async function uploadAttachments(paths, { auth, serverUrl }) {
  await requirePrimitive('upload-assets', serverUrl);

  const resolved = paths.map((p) => {
    const abs = resolve(p);
    if (!existsSync(abs)) {
      exitWithError(`Attachment not found: ${p}`, EXIT_PRECONDITION);
    }
    return abs;
  });

  const refs = [];
  for (const filePath of resolved) {
    console.error(`Uploading ${basename(filePath)}...`);
    refs.push(await uploadAssetFile(filePath, { auth, serverUrl }));
  }
  return refs;
}

/** Strip a ref down to the wire shape the uploadedFiles schema accepts. */
function toUploadedFileRef(ref) {
  return { s3Key: ref.s3Key, filename: ref.filename, mimeType: ref.mimeType };
}

async function cmdUploadAssets(args) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  // Prefer the API key: account-scoped refs are valid on BOTH site-create
  // and the message route. A site token narrows the refs to that site's
  // conversation only.
  const auth = creds.apiKey || site?.siteToken;
  if (!auth) {
    exitWithError(
      'Not logged in. Run `miles auth login` to get a device login code.',
      EXIT_PRECONDITION,
    );
  }

  const paths = args.filter((a) => !a.startsWith('--'));
  if (!paths.length) {
    exitWithError(
      'Usage: miles upload-assets <file> [<file>...]',
      EXIT_PRECONDITION,
      { example: 'miles upload-assets ./logo.svg ./team-photo.jpg' },
    );
  }

  const refs = await uploadAttachments(paths, {
    auth,
    serverUrl: DEFAULT_SERVER_URL,
  });

  emitJson({
    ok: true,
    files: refs,
    next: 'Pass these refs to Miles via `--attach <file>` on site-create/say, or as the uploadedFiles array when calling the API directly (s3Key, filename, mimeType).',
  });
}

async function cmdScreenshot(args) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.siteToken) {
    exitWithError('No active site. Use `miles site-create` first.', EXIT_PRECONDITION);
  }

  // --live captures the running WordPress frontend through the connected
  // dashboard instead of rendering a stored preview URL server-side.
  if (args.includes('--live')) {
    return cmdScreenshotLive(args, site);
  }

  // Extract the URL: first arg that starts with / or http
  const url = args.find((a) => a.startsWith('/') || a.startsWith('http'));
  if (!url) {
    exitWithError('Usage: miles screenshot <preview-url>', EXIT_PRECONDITION, {
      example: 'miles screenshot /preview/abc123/previews/hero-xyz/index.html',
    });
  }

  const serverUrl = DEFAULT_SERVER_URL;

  // Fetch screenshot as binary image from the server. Freshly generated
  // previews can lag readability by a few seconds; when the renderer reports
  // the target document 404'd, retry briefly before reporting failure.
  const encodedUrl = encodeURIComponent(url);
  // --full-page stitches the whole document (footers, below-the-fold), not
  // just the first viewport.
  const fullPage = args.includes('--full-page');
  const endpoint = `${serverUrl}/api/v2/headless/screenshot?url=${encodedUrl}${fullPage ? '&fullPage=true' : ''}`;

  const SCREENSHOT_RETRY_DELAYS_MS = [3000, 8000];
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${site.siteToken}` },
    });
    if (response.ok || attempt >= SCREENSHOT_RETRY_DELAYS_MS.length) break;

    let retryable = false;
    try {
      const peek = await response.clone().json();
      retryable =
        typeof peek?.targetStatus === 'number' && peek.targetStatus === 404;
    } catch {
      // Non-JSON error body — not the retryable not-ready case.
    }
    if (!retryable) break;

    console.error(
      `Preview not readable yet (HTTP 404 at the renderer); retrying in ${
        SCREENSHOT_RETRY_DELAYS_MS[attempt] / 1000
      }s...`,
    );
    await new Promise((r) => setTimeout(r, SCREENSHOT_RETRY_DELAYS_MS[attempt]));
  }

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

/**
 * Live capture of the running WordPress frontend via the dashboard's
 * screenshotView client tool. Browser-gated: for Playground sites the
 * running WordPress exists only in the browser, so a missing connection
 * fails fast with exit 3. Full-page by default (the whole document, not
 * just the first viewport); --viewport opts into the faster first-screen
 * capture.
 */
async function cmdScreenshotLive(args, site) {
  if (!site?.conversationId) {
    exitWithError(
      'No active conversation. Use `miles site-create` or `miles site-attach <siteId>` first.',
      EXIT_PRECONDITION,
    );
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const capabilities = await requirePrimitive('screenshot', serverUrl);
  if (!capabilities?.primitives?.screenshot?.operations?.live) {
    exitWithError(
      'The connected Miles server does not support live screenshots yet. Use `miles screenshot <preview-url>` for stored previews.',
      EXIT_PRECONDITION,
      { code: 'primitive_unsupported', primitive: 'screenshot.live' },
    );
  }

  let data;
  try {
    data = await apiRequest(
      'POST',
      `/api/v2/headless/conversations/${site.conversationId}/client-screenshot`,
      {
        auth: site.siteToken,
        serverUrl,
        body: { fullPage: !args.includes('--viewport') },
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      exitWithError(
        err.data?.error ||
          'Dashboard connection required for a live screenshot. Run `miles connect-browser`, wait for connected, then retry.',
        EXIT_NEED_CONNECTION,
        { code: 'dashboard_connection_required' },
      );
    }
    throw err;
  }

  if (!data?.success || !data?.image) {
    exitWithError(data?.error || 'Live screenshot capture failed.', EXIT_ERROR);
  }

  const imageBuffer = Buffer.from(data.image, 'base64');
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const filename = `screenshot-live-${Date.now()}.jpg`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  writeFileSync(filepath, imageBuffer);

  if (cliOptions.json) {
    emitJson({
      ok: true,
      path: filepath,
      live: true,
      bytes: imageBuffer.byteLength,
      width: data.width ?? null,
      height: data.height ?? null,
      contentType: data.mimeType || 'image/jpeg',
    });
  } else {
    console.log(filepath);
  }
}

function existingDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function existingFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function looksLikeWordPressRoot(dir) {
  return (
    existingFile(join(dir, 'wp-config.php')) &&
    existingDirectory(join(dir, 'wp-content')) &&
    existingDirectory(join(dir, 'wp-admin'))
  );
}

function findWordPressRoot(startPath = process.cwd()) {
  let current = resolve(expandHomePath(startPath));
  if (existingFile(current)) current = dirname(current);

  while (true) {
    if (looksLikeWordPressRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function executableOnPath(name) {
  const pathEntries = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

function resolveWpCli(args = []) {
  const explicit =
    getOptionalCommandFlagValue(args, '--wp-cli') || process.env.WP_CLI;
  if (explicit) {
    const resolved = resolve(expandHomePath(explicit));
    try {
      accessSync(resolved, constants.X_OK);
      return { available: true, path: resolved };
    } catch {
      return {
        available: false,
        path: resolved,
        error: 'Configured WP-CLI path is not executable.',
      };
    }
  }

  const found = executableOnPath('wp');
  return found
    ? { available: true, path: found }
    : { available: false, path: null, error: 'WP-CLI was not found on PATH.' };
}

function runWpCli(wpCli, root, args, options = {}) {
  return execFileSync(wpCli, [`--path=${root}`, ...args], {
    encoding: 'utf8',
    input: options.input,
    stdio: options.stdio || [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: process.env,
  }).trim();
}

function tryRunWpCli(wpCli, root, args) {
  try {
    return { ok: true, output: runWpCli(wpCli, root, args) };
  } catch (err) {
    return {
      ok: false,
      status: err.status ?? 1,
      output: String(err.stdout || '').trim(),
      error: String(err.stderr || err.message || '').trim(),
    };
  }
}

function getWpOption(wpCli, root, name) {
  const result = tryRunWpCli(wpCli, root, ['option', 'get', name]);
  return result.ok ? result.output : null;
}

function normalizeUrlNoSlash(value) {
  if (!value) return value;
  return String(value).replace(/\/+$/, '');
}

function localMilesDashboardUrl(siteUrl) {
  const base = normalizeUrlNoSlash(siteUrl);
  return base ? `${base}/wp-admin/admin.php?page=miles` : null;
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isLocalWordPressUrl(value) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (hostname === 'localhost' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.test') ||
        hostname.endsWith('.ddev.site') ||
        hostname.endsWith('.lndo.site') ||
        isPrivateIPv4(hostname))
    );
  } catch {
    return false;
  }
}

function isAutoConfigurableLocalWordPressUrl(value) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.test') ||
        hostname.endsWith('.ddev.site') ||
        hostname.endsWith('.lndo.site'))
    );
  } catch {
    return false;
  }
}

function findLocalMilesPluginSource(startPath = process.cwd()) {
  const candidates = [];
  if (MILES_PLUGIN_SOURCE) {
    candidates.push(resolve(expandHomePath(MILES_PLUGIN_SOURCE)));
  }

  let current = resolve(expandHomePath(startPath));
  if (existingFile(current)) current = dirname(current);
  while (true) {
    candidates.push(join(current, 'packages', 'miles-plugin'));
    candidates.push(join(current, 'miles-plugin'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of candidates) {
    if (
      existingDirectory(candidate) &&
      existingFile(join(candidate, 'miles.php'))
    ) {
      return candidate;
    }
  }
  return null;
}

function readMilesPluginVersionFromFile(pluginDir) {
  try {
    const contents = readFileSync(join(pluginDir, 'miles.php'), 'utf8');
    return contents.match(/Version:\s*([^\n]+)/)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function copyMilesPluginSource(sourceDir, wordpressRoot) {
  const pluginsDir = join(wordpressRoot, 'wp-content', 'plugins');
  const targetDir = join(pluginsDir, 'miles');
  const replaced = existingDirectory(targetDir) || existingFile(targetDir);
  mkdirSync(pluginsDir, { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = basename(src);
      if (name === '.env' || name.startsWith('.env.')) return false;
      if (name === '.git' || name.startsWith('.git')) return false;
      return ![
        'node_modules',
        'dist',
        '.DS_Store',
        '.wordpress-org',
      ].includes(name);
    },
  });
  return { targetDir, replaced };
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`Could not fetch ${url}: ${err.message}`);
  }
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function getPluginDownloadUrl() {
  if (MILES_PLUGIN_DOWNLOAD_URL) return MILES_PLUGIN_DOWNLOAD_URL;
  const manifest = await fetchJson(MILES_PLUGIN_MANIFEST_URL);
  return (
    manifest.download_url ||
    manifest.downloadUrl ||
    manifest.zip_url ||
    manifest.zipUrl ||
    null
  );
}

function detectWordPress(args = [], options = {}) {
  const startPath =
    getOptionalCommandFlagValue(args, '--path') ||
    getOptionalCommandFlagValue(args, '--root') ||
    process.cwd();
  const active = options.active === true;
  const root = findWordPressRoot(startPath);
  const wpCli = resolveWpCli(args);
  const pluginSource = findLocalMilesPluginSource(startPath);

  if (!root) {
    return {
      found: false,
      detectionMode: active ? 'active' : 'passive',
      searchedFrom: resolve(expandHomePath(startPath)),
      wpCli,
      plugin: {
        source: pluginSource,
        sourceVersion: pluginSource
          ? readMilesPluginVersionFromFile(pluginSource)
          : null,
      },
      next: ['No local WordPress install detected; use `miles site-create`.'],
    };
  }

  const pluginDir = join(root, 'wp-content', 'plugins', 'miles');
  const detection = {
    found: true,
    detectionMode: active ? 'active' : 'passive',
    root,
    wpCli,
    site: {
      url: null,
      name: null,
      adminEmail: null,
      wordpressVersion: null,
      environment: null,
      dashboardUrl: null,
    },
    plugin: {
      installed: existingFile(join(pluginDir, 'miles.php')),
      active: false,
      version: readMilesPluginVersionFromFile(pluginDir),
      source: pluginSource,
      sourceVersion: pluginSource
        ? readMilesPluginVersionFromFile(pluginSource)
        : null,
    },
    next: [
      'Ask the user whether to use Miles cloud, this local WordPress install, or a remote WordPress site.',
    ],
  };

  if (active && wpCli.available) {
    const coreInstalled = tryRunWpCli(wpCli.path, root, [
      'core',
      'is-installed',
    ]);
    detection.wpCli.coreInstalled = coreInstalled.ok;
    if (!coreInstalled.ok) {
      detection.wpCli.coreInstalledError =
        coreInstalled.error || coreInstalled.output || 'WordPress is not installed.';
    } else {
      detection.site.url = normalizeUrlNoSlash(
        getWpOption(wpCli.path, root, 'siteurl'),
      );
      detection.site.name = getWpOption(wpCli.path, root, 'blogname');
      detection.site.adminEmail = getWpOption(wpCli.path, root, 'admin_email');
      detection.site.wordpressVersion =
        tryRunWpCli(wpCli.path, root, ['core', 'version']).output || null;
      detection.site.environment =
        tryRunWpCli(wpCli.path, root, [
          'eval',
          'echo wp_get_environment_type();',
        ]).output || null;
      detection.site.dashboardUrl = localMilesDashboardUrl(detection.site.url);
      detection.plugin.installed =
        tryRunWpCli(wpCli.path, root, ['plugin', 'is-installed', 'miles']).ok ||
        detection.plugin.installed;
      detection.plugin.active = tryRunWpCli(wpCli.path, root, [
        'plugin',
        'is-active',
        'miles',
      ]).ok;
      detection.plugin.version =
        tryRunWpCli(wpCli.path, root, [
          'plugin',
          'get',
          'miles',
          '--field=version',
        ]).output ||
        detection.plugin.version ||
        null;
    }
  }

  return detection;
}

async function cmdWordPressDetect(args = []) {
  const detection = detectWordPress(args);
  if (cliOptions.json) {
    emitJson({ ok: true, localWordPress: detection });
    return;
  }

  if (!detection.found) {
    console.log('No local WordPress install detected. Use `miles site-create`.');
    return;
  }

  console.log(`WordPress root: ${detection.root}`);
  if (detection.site.url) console.log(`Site URL: ${detection.site.url}`);
  console.log(
    `WP-CLI: ${
      detection.wpCli.available ? detection.wpCli.path : detection.wpCli.error
    }`,
  );
  console.log(
    `Miles plugin: ${
      detection.plugin.active
        ? 'active'
        : detection.plugin.installed
          ? 'installed'
          : 'not installed'
    }`,
  );
  console.log(
    'Ask the user whether to use Miles cloud, this local WordPress install, or a remote WordPress site.',
  );
}

async function ensureMilesPluginInstalled(detection, args = []) {
  const actions = [];
  if (!detection.wpCli.available) {
    if (!detection.plugin.installed && detection.plugin.source) {
      const copyResult = copyMilesPluginSource(
        detection.plugin.source,
        detection.root,
      );
      actions.push({
        action: 'copied-plugin',
        source: detection.plugin.source,
        targetDir: copyResult.targetDir,
        replaced: copyResult.replaced || undefined,
      });
      return {
        ok: false,
        actions,
        reason:
          'WP-CLI is not available, so the plugin was copied but could not be activated or connected automatically.',
      };
    }
    return {
      ok: false,
      actions,
      reason:
        'WP-CLI is required to activate and connect the local plugin automatically.',
    };
  }

  const wpCli = detection.wpCli.path;
  if (!detection.plugin.installed) {
    if (detection.plugin.source) {
      const copyResult = copyMilesPluginSource(
        detection.plugin.source,
        detection.root,
      );
      actions.push({
        action: 'copied-plugin',
        source: detection.plugin.source,
        targetDir: copyResult.targetDir,
        replaced: copyResult.replaced || undefined,
      });
    } else {
      const pluginUrl =
        getOptionalCommandFlagValue(args, '--plugin-url') ||
        (await getPluginDownloadUrl().catch(() => null));
      if (!pluginUrl) {
        return {
          ok: false,
          actions,
          reason:
            'No local Miles plugin source or plugin download URL was available.',
        };
      }
      runWpCli(wpCli, detection.root, [
        'plugin',
        'install',
        pluginUrl,
        '--activate',
        '--force',
      ]);
      actions.push({ action: 'installed-plugin', source: pluginUrl });
      return { ok: true, actions };
    }
  }

  const activate = tryRunWpCli(wpCli, detection.root, [
    'plugin',
    'activate',
    'miles',
  ]);
  if (!activate.ok) {
    return {
      ok: false,
      actions,
      reason:
        activate.error || activate.output || 'Failed to activate the Miles plugin.',
    };
  }
  actions.push({ action: 'activated-plugin' });
  return { ok: true, actions };
}

function wordpressApplicationPasswordsAvailable(detection) {
  if (!detection.wpCli.available) return false;
  const result = tryRunWpCli(detection.wpCli.path, detection.root, [
    'eval',
    'echo wp_is_application_passwords_available() ? "1" : "0";',
  ]);
  return result.ok && result.output.trim() === '1';
}

function ensureLocalApplicationPasswordsAvailable(detection) {
  const actions = [];
  if (wordpressApplicationPasswordsAvailable(detection)) {
    return { ok: true, actions };
  }

  if (!isLocalWordPressUrl(detection.site.url)) {
    return {
      ok: false,
      actions,
      reason:
        'WordPress application passwords are unavailable. Enable HTTPS or configure this WordPress install as a local environment before connecting Miles.',
    };
  }

  if (!isAutoConfigurableLocalWordPressUrl(detection.site.url)) {
    return {
      ok: false,
      actions,
      reason:
        'WordPress application passwords are unavailable. This site URL looks like a LAN, shared, or custom local host, so Miles will not change wp-config.php automatically. Configure WP_ENVIRONMENT_TYPE=local yourself if this is a safe local development install, then rerun setup.',
    };
  }

  const configured = tryRunWpCli(detection.wpCli.path, detection.root, [
    'config',
    'set',
    'WP_ENVIRONMENT_TYPE',
    'local',
    '--type=constant',
  ]);
  if (!configured.ok) {
    return {
      ok: false,
      actions,
      reason:
        configured.error ||
        configured.output ||
        'Could not set WP_ENVIRONMENT_TYPE=local in wp-config.php.',
    };
  }
  actions.push({ action: 'configured-local-environment' });

  if (!wordpressApplicationPasswordsAvailable(detection)) {
    return {
      ok: false,
      actions,
      reason:
        'WordPress application passwords are still unavailable after configuring WP_ENVIRONMENT_TYPE=local.',
    };
  }

  return { ok: true, actions };
}

async function runMilesLocalSetup(detection, bootstrap, args = []) {
  const credentialsJson = JSON.stringify({
    siteId: bootstrap.siteId,
    sharedSecret: bootstrap.sharedSecret,
    serverUrl: bootstrap.serverUrl,
    accountId: bootstrap.accountId,
    accountEmail: bootstrap.accountEmail,
  });

  const wpArgs = [
    'miles',
    'local-setup',
    '--credentials-stdin',
    '--yes',
    '--format=json',
  ];
  const adminUser = getOptionalCommandFlagValue(args, '--admin-user');
  if (adminUser) wpArgs.push(`--admin-user=${adminUser}`);

  const output = runWpCli(detection.wpCli.path, detection.root, wpArgs, {
    input: credentialsJson,
  });
  if (!output) return { success: true };

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      if (index !== 0 || lines.length > 1) {
        parsed.warning =
          parsed.warning ||
          'Miles plugin setup completed but emitted extra output.';
      }
      return parsed;
    } catch {
      // Keep looking for a parseable JSON line.
    }
  }

  return {
    success: true,
    warning: 'Miles plugin setup completed but returned non-JSON output.',
  };
}

function sanitizeLocalSetupResult(setup) {
  if (!setup || typeof setup !== 'object') {
    return { success: true };
  }
  const result = { success: setup.success !== false };
  const message = sanitizeProgressText(setup.message);
  const warning = sanitizeProgressText(setup.warning);
  if (message) result.message = message;
  if (warning) result.warning = warning;
  return result;
}

function sanitizeLocalSetupFailure(err) {
  const raw =
    typeof err?.stderr === 'string' && err.stderr.trim()
      ? err.stderr
      : err?.message || 'Unknown setup error.';
  const scrubbed = String(raw)
    .replace(
      /\b(sharedSecret|shared_secret|appPassword|applicationPassword|password|token|secret)=\S+/gi,
      '$1=[redacted]',
    )
    .replace(
      /\b(sharedSecret|shared_secret|appPassword|applicationPassword|password|token|secret):\s*\S+/gi,
      '$1: [redacted]',
    );
  return sanitizeProgressText(scrubbed) || 'Unknown setup error.';
}

async function cmdWordPressSetup(args = []) {
  const mode = getOptionalCommandFlagValue(args, '--use');
  if (mode === 'cloud') {
    const payload = {
      ok: true,
      mode: 'cloud',
      next: ['Use `miles site-create "<description>"` to create a Miles cloud site.'],
    };
    if (cliOptions.json) emitJson(payload);
    else console.log(payload.next[0]);
    return;
  }
  if (mode !== 'local') {
    exitWithError(
      'Usage: wordpress-setup requires an explicit --use local or --use cloud choice.',
      EXIT_PRECONDITION,
    );
  }

  const detection = detectWordPress(args, { active: true });
  if (!detection.found) {
    const payload = {
      ok: true,
      mode: 'cloud',
      localWordPress: detection,
      next: ['No local WordPress install detected; use `miles site-create`.'],
    };
    if (cliOptions.json) emitJson(payload);
    else console.log(payload.next[0]);
    return;
  }

  const creds = loadCredentials();
  if (!creds.apiKey) {
    exitWithError(
      'Not logged in. Run `miles auth login` to get a device login code.',
      EXIT_PRECONDITION,
    );
  }

  const installResult = await ensureMilesPluginInstalled(detection, args);
  if (!installResult.ok) {
    const pluginUrl =
      getOptionalCommandFlagValue(args, '--plugin-url') ||
      MILES_PLUGIN_DOWNLOAD_URL ||
      MILES_PLUGIN_MANIFEST_URL;
    const payload = {
      ok: false,
      mode: 'local',
      localWordPress: detection,
      actions: installResult.actions,
      reason: installResult.reason,
      pluginUrl,
      next: [
        'Install and activate the Miles plugin in this WordPress admin, or install WP-CLI and rerun `miles wordpress-setup --use local --json`.',
      ],
    };
    if (cliOptions.json) emitJson(payload);
    else {
      console.log(installResult.reason);
      console.log(`Plugin link: ${pluginUrl}`);
    }
    process.exit(EXIT_PRECONDITION);
  }

  let refreshed = detectWordPress(args, { active: true });
  const appPasswordResult = ensureLocalApplicationPasswordsAvailable(refreshed);
  if (!appPasswordResult.ok) {
    const payload = {
      ok: false,
      mode: 'local',
      localWordPress: refreshed,
      actions: [...installResult.actions, ...appPasswordResult.actions],
      reason: appPasswordResult.reason,
      next: [
        'Enable WordPress application passwords for this local install, then rerun `miles wordpress-setup --use local --json`.',
      ],
    };
    if (cliOptions.json) emitJson(payload);
    else console.log(appPasswordResult.reason);
    process.exit(EXIT_PRECONDITION);
  }

  const siteUrl = refreshed.site.url;
  if (!siteUrl) {
    exitWithError(
      'Could not read the local WordPress site URL with WP-CLI.',
      EXIT_PRECONDITION,
    );
  }

  const bootstrap = await apiRequest(
    'POST',
    '/api/v2/headless/wordpress-sites/bootstrap',
    {
      auth: creds.apiKey,
      serverUrl: DEFAULT_SERVER_URL,
      body: {
        siteUrl,
        siteName: refreshed.site.name || undefined,
        adminEmail: refreshed.site.adminEmail || undefined,
        wordpressVersion: refreshed.site.wordpressVersion || undefined,
        pluginVersion: refreshed.plugin.version || undefined,
        environment: appPasswordResult.actions.some(
          (action) => action.action === 'configured-local-environment',
        )
          ? 'local'
          : refreshed.site.environment || 'local',
        localDashboardUrl:
          refreshed.site.dashboardUrl || localMilesDashboardUrl(siteUrl),
      },
    },
  );

  let setupResult;
  try {
    setupResult = await runMilesLocalSetup(refreshed, bootstrap, args);
  } catch (err) {
    throw new Error(
      `Local WordPress plugin setup failed after Miles created site ${bootstrap.siteId}. Rerun \`miles wordpress-setup --use local --json\` to relink and finish setup. ${sanitizeLocalSetupFailure(err)}`,
    );
  }

  if (!creds.sites) creds.sites = {};
  creds.sites[bootstrap.siteId] = {
    siteToken: bootstrap.siteToken,
    name: bootstrap.siteName || refreshed.site.name || siteUrl,
    conversationId: null,
    dashboardUrl:
      bootstrap.localDashboardUrl ||
      refreshed.site.dashboardUrl ||
      localMilesDashboardUrl(siteUrl),
    siteUrl,
    cloudDashboardUrl: bootstrap.dashboardUrl,
    localWordPressRoot: refreshed.root,
    connection: { kind: 'local-wordpress' },
  };
  creds.activeSite = bootstrap.siteId;
  saveCredentials(creds);

  const payload = {
    ok: true,
    mode: 'local',
    siteId: bootstrap.siteId,
    siteUrl,
    dashboardUrl: creds.sites[bootstrap.siteId].dashboardUrl,
    cloudDashboardUrl: bootstrap.dashboardUrl,
    relinked: bootstrap.relinked,
    actions: [...installResult.actions, ...appPasswordResult.actions],
    setup: sanitizeLocalSetupResult(setupResult),
    activeSite: getActiveSiteSummary(creds),
    next: ['Run `miles connect-browser --open` to open the local Miles admin page.'],
  };

  if (cliOptions.json) {
    emitJson(payload);
    return;
  }

  console.log(`Connected local WordPress site: ${siteUrl}`);
  console.log(`Miles admin: ${payload.dashboardUrl}`);
}

async function cmdSites() {
  noteActiveRunIfAny();
  const creds = loadCredentials();
  if (!creds.apiKey) {
    exitWithError('Not logged in.', EXIT_PRECONDITION);
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
    exitWithError('Usage: miles use <siteId>', EXIT_PRECONDITION);
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

async function cmdConnectBrowser(args = []) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site) {
    exitWithError('No active site.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const shouldOpen = hasCommandFlag(args, '--open');
  let waitSeconds = null;
  if (hasCommandFlag(args, '--wait')) {
    const value = getOptionalCommandFlagValue(args, '--wait');
    if (value === null) {
      waitSeconds = DASHBOARD_CONNECT_TIMEOUT_MS / 1000;
    } else {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds <= 0) {
        exitWithError(
          'Usage: --wait accepts an optional positive number of seconds.',
          EXIT_PRECONDITION,
        );
      }
      waitSeconds = seconds;
    }
  }
  const dashboard = await getDashboardOpenUrl(creds, site, serverUrl);
  if (!dashboard.url) {
    exitWithError(
      'Active site is missing its dashboard URL. Run `miles sites` and `miles site-attach <siteId>`, or recreate the site.',
      EXIT_PRECONDITION,
    );
  }

  if (shouldOpen) openUrl(dashboard.url);

  let connected = null;
  let connectionStatusError = null;
  if (site.conversationId) {
    try {
      if (waitSeconds) {
        connected = await waitForDashboardConnection(
          site,
          serverUrl,
          waitSeconds * 1000,
        );
      } else {
        connected = await getDashboardConnectionStatus(site, serverUrl);
      }
    } catch (err) {
      connectionStatusError =
        err.message || 'Could not check dashboard connection.';
      if (!cliOptions.json) {
        console.error(`WebSocket status unavailable: ${connectionStatusError}`);
      }
    }
  }

  if (waitSeconds && connected === false) {
    exitWithDashboardConnectionRequired(site, waitSeconds * 1000);
  }

  if (cliOptions.json) {
    const payload = {
      url: dashboard.url,
      dashboardUrl: dashboard.dashboardUrl,
      authenticated: dashboard.authenticated,
      connected,
      connection: site.connection || { kind: 'browser-dashboard' },
      activeSite: getActiveSiteSummary(creds),
    };
    if (connectionStatusError) {
      payload.connectionStatusError = connectionStatusError;
    }
    emitJson(payload);
    return;
  }
  console.log(dashboard.url);
  if (dashboard.authenticated) {
    console.log('Authentication: browser login handoff');
  }
  if (connected !== null) {
    console.log(`WebSocket: ${connected ? 'connected' : 'not connected'}`);
  }
}

async function cmdBalance() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active site.', EXIT_PRECONDITION);
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

/**
 * Account-scoped status: plan, credits, and site count. No conversation
 * needed — use this for headroom checks before committing to a build.
 */
async function cmdAccountStatus() {
  noteActiveRunIfAny();
  const creds = loadCredentials();
  if (!creds.apiKey) {
    exitWithError(
      'Not logged in. Run `miles auth login` to get a device login code.',
      EXIT_PRECONDITION,
    );
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await requirePrimitive('account-status', serverUrl);

  const data = await apiRequest('GET', '/api/v2/headless/account/balance', {
    auth: creds.apiKey,
    serverUrl,
  });

  let siteCount = null;
  try {
    const sites = await apiRequest('GET', '/api/v2/headless/sites', {
      auth: creds.apiKey,
      serverUrl,
    });
    siteCount = sites.sites?.length ?? 0;
  } catch {
    // Site listing is enrichment only; balance is the primary payload.
  }

  if (cliOptions.json) {
    emitJson({
      plan: data.plan || null,
      credits: data.credits || null,
      siteCount,
      activeSite: getActiveSiteSummary(creds),
    });
    return;
  }

  console.log(`Plan: ${data.plan || 'Unknown'}`);
  if (data.credits) {
    console.log(
      `Credits: ${data.credits.totalSpendableCredits.toLocaleString()} spendable (${data.credits.usagePercent}% of plan allowance used)`,
    );
    if (data.credits.topUpBalanceCredits > 0) {
      console.log(
        `Top-up credits: ${data.credits.topUpBalanceCredits.toLocaleString()}`,
      );
    }
  }
  if (siteCount !== null) {
    console.log(`Sites: ${siteCount}`);
  }
}

/**
 * Attach to any site owned by this account — cross-machine resume. Mints a
 * fresh site token, hydrates local credentials, and makes it the active
 * site. With --duplicate, forks the site instead (the official way to
 * branch an existing site before risky edits).
 */
async function cmdSiteAttach(args) {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    exitWithError(
      'Not logged in. Run `miles auth login` to get a device login code.',
      EXIT_PRECONDITION,
    );
  }

  const siteId = args.find((a) => !a.startsWith('--'));
  if (!siteId) {
    exitWithError(
      'Usage: miles site-attach <siteId> [--duplicate] [--name "Copy name"]. Run `miles sites --json` to list site ids.',
      EXIT_PRECONDITION,
    );
  }
  const duplicate = hasCommandFlag(args, '--duplicate');
  const copyName = getOptionalCommandFlagValue(args, '--name');
  const serverUrl = DEFAULT_SERVER_URL;

  let attachedSiteId;
  let siteToken;
  let conversationId = null;
  let dashboardUrl = null;
  let name = null;
  let phase = null;

  if (duplicate) {
    const body = copyName ? { name: copyName } : {};
    const data = await apiRequest(
      'POST',
      `/api/v2/headless/sites/${siteId}/duplicate`,
      { auth: creds.apiKey, body, serverUrl },
    );
    attachedSiteId = data.siteId;
    siteToken = data.siteToken;
    conversationId = data.conversationId || null;
    dashboardUrl = data.dashboardUrl || null;
    name = copyName || null;
  } else {
    const data = await apiRequest(
      'POST',
      `/api/v2/headless/sites/${siteId}/session-token`,
      { auth: creds.apiKey, serverUrl },
    );
    attachedSiteId = data.siteId;
    siteToken = data.siteToken;

    try {
      const listing = await apiRequest('GET', '/api/v2/headless/sites', {
        auth: creds.apiKey,
        serverUrl,
      });
      const entry = (listing.sites || []).find((s) => s.id === attachedSiteId);
      if (entry) {
        conversationId = entry.conversationId || null;
        dashboardUrl = entry.dashboardUrl || null;
        name = entry.name || null;
        phase = entry.phase || null;
      }
    } catch {
      // Token already minted; metadata enrichment is best-effort.
    }
  }

  if (!creds.sites) creds.sites = {};
  creds.sites[attachedSiteId] = {
    siteToken,
    name,
    conversationId,
    dashboardUrl,
  };
  creds.activeSite = attachedSiteId;
  saveCredentials(creds);

  const payload = {
    ok: true,
    siteId: attachedSiteId,
    conversationId,
    phase,
    duplicated: duplicate,
    next: conversationId
      ? ['miles site-state --json']
      : ['This site has no conversation yet; conversation verbs will not work.'],
  };

  if (cliOptions.json) {
    emitJson(payload);
    return;
  }
  console.log(
    duplicate
      ? `Duplicated site ${siteId} into ${attachedSiteId} (now active).`
      : `Attached to site ${attachedSiteId}${name ? ` (${name})` : ''} (now active).`,
  );
  if (phase) console.log(`Phase: ${phase}`);
  console.log('Run `miles site-state --json` to see where this site is.');
}

/**
 * One JSON snapshot of the active site: phase, streaming status, directions,
 * connection state, and suggested next moves. The `git status` of Miles.
 */
async function cmdSiteState(args = []) {
  noteActiveRunIfAny();
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError(
      'No active conversation. Use `miles site-create` or `miles site-attach <siteId>` first.',
      EXIT_PRECONDITION,
    );
  }

  const serverUrl = DEFAULT_SERVER_URL;

  // --full swaps the poll-oriented /status summary for the complete derived
  // state dump: brief text, per-direction detail, session memory blockers.
  if (args.includes('--full')) {
    return cmdSiteStateFull(site, serverUrl);
  }
  const [status, directions, connected] = await Promise.all([
    apiRequest(
      'GET',
      `/api/v2/headless/conversations/${site.conversationId}/status`,
      { auth: site.siteToken, serverUrl },
    ),
    apiRequest(
      'GET',
      `/api/v2/headless/conversations/${site.conversationId}/design-directions`,
      { auth: site.siteToken, serverUrl },
    ).catch(() => null),
    getDashboardConnectionStatus(site, serverUrl).catch(() => null),
  ]);

  const phase = status.phase || null;
  const streaming = status.status === 'streaming';

  // The server derives next[] (bare primitive names) authoritatively —
  // streaming/unsettled precedence, undo availability, the real phase
  // machine. The CLI only maps names to display hints. Client-side
  // fallback exists for older servers that don't send next[].
  const NEXT_MOVE_HINTS = {
    say: 'miles say "<answer, feedback, or edit>"',
    'design-directions': 'miles design-directions --json',
    'build-site': 'miles build-site --design <number>',
    'wait-job': 'miles wait-job',
    'approval-respond':
      'miles approval-respond --grant <id> --response approved|declined  (only after explicit user approval or refusal)',
    export: 'miles export --type html|theme',
    'convert-theme': 'miles convert-theme  (needs connect-browser first)',
    cancel: 'miles cancel',
    undo: 'miles undo  (revert the last turn)',
  };
  let next;
  if (Array.isArray(status.next)) {
    next = status.next.map((n) => NEXT_MOVE_HINTS[n] ?? `miles ${n}`);
  } else {
    next = [];
    if (streaming) {
      next.push('miles wait-job');
    } else if (status.status === 'aborted' || status.status === 'failed') {
      next.push(
        'miles say "<continue, retry, or redirect the work>"  (last run did not finish)',
      );
    } else if (phase === 'discovery' || phase === 'brief_review') {
      next.push('miles say "<answer or feedback>"');
    } else if (phase === 'design_directions_ready') {
      next.push('miles design-directions --json');
      next.push('miles build-site --design <number>');
    } else if (phase === 'site_preview' || status.siteReady) {
      next.push('miles say "<describe an edit>"');
      next.push('miles export --type html');
      next.push('miles convert-theme  (needs connect-browser first)');
    }
    if (phase === 'complete' || status.siteReady) {
      next.push('miles export --type theme');
    }
  }

  const plan = status.siteCompletionPlan || null;
  const approvalRequired = sanitizeApprovalRequired(status.approvalRequired);
  const planSummary = plan?.items?.length
    ? {
        total: plan.items.length,
        completed: plan.items.filter((i) => i.status === 'completed').length,
        pending: plan.items.filter((i) => i.status === 'pending').length,
        failed: plan.items.filter((i) => i.status === 'failed').length,
      }
    : null;

  const payload = {
    siteId: site.id,
    conversationId: site.conversationId,
    phase,
    status: status.status,
    conversationStatus: status.conversationStatus || null,
    error: status.error || undefined,
    siteReady: Boolean(status.siteReady),
    selectedDirectionId: status.selectedDirectionId || null,
    directionCount: status.directionCount || 0,
    directions: (directions?.directions || []).map((h) => ({
      number: h.number,
      directionId: h.directionId || null,
      name: h.directionName || `Design ${h.number}`,
      previewUrl: h.previewUrl || null,
    })),
    connection: {
      kind: 'browser-dashboard',
      connected,
    },
    storageSlug: status.storageSlug || null,
    themeSlug: status.themeSlug || null,
    siteCompletionPlan: plan,
    credits: status.credits || null,
    approvalRequired,
    undoAvailable: Boolean(status.undoAvailable),
    // Pass-through of server-derived context (present when applicable):
    // the registered logo, files in scope, analyzed reference sites, and
    // conversation length. Useful for verifying what Miles is working from.
    userLogo: status.userLogo || null,
    uploadedFiles: status.uploadedFiles || null,
    siteAnalyses: status.siteAnalyses || null,
    messageCount: status.messageCount ?? null,
    next,
  };

  if (cliOptions.json) {
    emitJson(payload);
    return;
  }

  console.log(`[phase: ${payload.phase}]`);
  console.log(`[status: ${payload.status}]`);
  if (payload.siteReady) console.log('[site_ready: true]');
  if (payload.directionCount > 0) {
    console.log(`[directions: ${payload.directionCount}]`);
  }
  console.log(
    `[browser: ${connected === null ? 'unknown' : connected ? 'connected' : 'not connected'}]`,
  );
  if (planSummary) {
    console.log(
      `[plan: ${planSummary.completed}/${planSummary.total} done${planSummary.failed ? `, ${planSummary.failed} failed` : ''}]`,
    );
    plan.items.forEach((item) => {
      console.log(`  - [${item.status}] ${item.title}`);
    });
  }
  if (payload.undoAvailable) console.log('[undo: available]');
  if (payload.credits) {
    console.log(`[credits: ${payload.credits.usagePercent}% of period used]`);
  }
  const approvalLines = [];
  appendApprovalRequiredLines(approvalLines, payload.approvalRequired);
  approvalLines.forEach((line) => console.log(line));
  if (next.length) {
    console.log('Next:');
    next.forEach((n) => console.log(`  ${n}`));
  }
}

/**
 * The complete derived-state dump behind `site-state --full`. Everything the
 * server derives from the conversation that an agent can act on: brief text,
 * per-direction detail, the completion plan, session-memory blockers, and
 * conversion outcomes. JSON is the primary consumer; the human view renders
 * the highlights.
 */
async function cmdSiteStateFull(site, serverUrl) {
  const capabilities = await requirePrimitive('site-state', serverUrl);
  if (!capabilities?.primitives?.['site-state']?.operations?.full) {
    exitWithError(
      'The connected Miles server does not support `site-state --full` yet. Use `miles site-state` for the summary.',
      EXIT_PRECONDITION,
      { code: 'primitive_unsupported', primitive: 'site-state.full' },
    );
  }

  const [state, connected] = await Promise.all([
    apiRequest(
      'GET',
      `/api/v2/headless/conversations/${site.conversationId}/state`,
      { auth: site.siteToken, serverUrl },
    ),
    getDashboardConnectionStatus(site, serverUrl).catch(() => null),
  ]);

  if (cliOptions.json) {
    emitJson({
      siteId: site.id,
      conversationId: site.conversationId,
      connection: { kind: 'browser-dashboard', connected },
      ...state,
      approvalRequired:
        sanitizeApprovalRequired(state.approvalRequired) || null,
    });
    return;
  }

  console.log(`[phase: ${state.phase}]`);
  console.log(`[status: ${state.status}]`);
  if (state.title) console.log(`[title: ${state.title}]`);
  if (state.strategicBrief) {
    const brief = state.strategicBrief.trim();
    console.log(`[brief${state.briefApproved ? ' (approved)' : ''}]`);
    console.log(
      brief.length > 600 ? `${brief.slice(0, 600)}…` : brief,
    );
  }
  if (state.designDirections?.length) {
    console.log('[directions]');
    state.designDirections.forEach((d) => {
      console.log(
        `  ${d.number}. ${d.directionName || `Design ${d.number}`} [${d.status}]${
          state.selectedDirectionId === d.directionId ? ' (selected)' : ''
        }`,
      );
    });
  }
  if (state.siteCompletionPlan?.items?.length) {
    console.log('[plan]');
    state.siteCompletionPlan.items.forEach((item) => {
      console.log(`  - [${item.status}] ${item.title}`);
    });
  }
  if (state.conversionFailed && state.conversionError) {
    console.log(`[conversion failed: ${state.conversionError}]`);
  }
  if (state.themeSlug) console.log(`[theme: ${state.themeSlug}]`);
  if (state.sessionMemory?.length) {
    console.log('[session memory]');
    state.sessionMemory.forEach((entry) => {
      console.log(`  - [${entry.status}] ${entry.key}: ${entry.summary}`);
    });
  }
  const approvalLines = [];
  appendApprovalRequiredLines(approvalLines, state.approvalRequired);
  approvalLines.forEach((line) => console.log(line));
  console.log(`[messages: ${state.messageCount}]`);
  console.log('Full detail: miles site-state --full --json');
}

/**
 * Export dispatcher over the per-deliverable endpoints.
 * html is fully headless. theme metadata is headless, but downloading the
 * theme zip from a Playground site tunnels through the connected browser.
 */
async function cmdExport(args) {
  const flagType = getOptionalCommandFlagValue(args, '--type');
  const positional = args.find((a) => a === 'html' || a === 'theme');
  const type = flagType || positional || 'html';
  const downloadPath = getOptionalCommandFlagValue(args, '--download');

  if (type === 'html') return cmdExportSite();
  if (type === 'theme') {
    if (downloadPath) return cmdDownloadTheme(downloadPath);
    return cmdExportTheme();
  }

  exitWithError(
    `Unknown export type: ${type}. Supported types: html, theme.`,
    EXIT_PRECONDITION,
  );
}

/**
 * One-step theme ZIP download with the site token. The bytes come from the
 * WordPress plugin, so Playground sites need a connected dashboard — the
 * server fails closed with 409 (exit 3) when it is missing.
 */
async function cmdDownloadTheme(downloadPath) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const capabilities = await requirePrimitive('export', serverUrl);
  if (!capabilities?.primitives?.export?.operations?.['theme-download']) {
    exitWithError(
      'The connected Miles server does not support one-step theme download yet. Use `miles export --type theme` for the download URL.',
      EXIT_PRECONDITION,
      { code: 'primitive_unsupported', primitive: 'export.theme-download' },
    );
  }

  const endpoint = `${serverUrl}/api/v2/headless/conversations/${site.conversationId}/download-theme`;
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${site.siteToken}` },
  });

  if (response.status === 409) {
    let detail = null;
    try {
      detail = await response.json();
    } catch {
      // Non-JSON body.
    }
    exitWithError(
      detail?.error ||
        'Dashboard connection required to download the theme ZIP. Run `miles connect-browser`, wait for connected, then retry.',
      EXIT_NEED_CONNECTION,
      { code: 'dashboard_connection_required' },
    );
  }
  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch {
      // Non-JSON body.
    }
    exitWithError(
      detail?.error || `Theme download failed (HTTP ${response.status})`,
      EXIT_ERROR,
      detail,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(downloadPath, buffer);
  if (cliOptions.json) {
    emitJson({ ok: true, path: downloadPath, bytes: buffer.byteLength });
    return;
  }
  console.log(downloadPath);
}

/**
 * Auth umbrella: status (default), login, poll, logout.
 */
async function cmdAuth(args) {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'status' || sub === 'whoami') return cmdWhoami();
  if (sub === 'login') return cmdLogin(rest);
  if (sub === 'poll') return cmdLogin(['--poll', ...rest]);
  if (sub === 'logout') return cmdLogout();

  exitWithError(
    'Usage: miles auth [status|login|poll|logout]',
    EXIT_PRECONDITION,
  );
}

async function cmdMessages() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
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

/**
 * Paginated transcript read, sanitized exactly like the web client's
 * history view. Defaults to the tail (the most recent turns), which is what
 * an agent resuming a conversation needs first; page backwards with
 * --offset. Supersedes `messages` (text-only, unpaginated) when the server
 * supports it.
 */
async function cmdHistory(args) {
  noteActiveRunIfAny();
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  await requirePrimitive('history', serverUrl);

  const params = new URLSearchParams();
  const limit = getOptionalCommandFlagValue(args, '--limit');
  const offset = getOptionalCommandFlagValue(args, '--offset');
  if (limit) params.set('limit', limit);
  if (offset !== undefined && offset !== null) params.set('offset', offset);
  const query = params.size ? `?${params.toString()}` : '';

  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/history${query}`,
    { auth: site.siteToken, serverUrl },
  );

  if (cliOptions.json) {
    emitJson({
      total: data.total,
      offset: data.offset,
      limit: data.limit,
      messages: data.messages || [],
    });
    return;
  }

  console.log(
    `[messages ${data.offset + 1}-${data.offset + (data.messages?.length || 0)} of ${data.total}]`,
  );
  (data.messages || []).forEach((msg) => {
    const role = msg.role === 'assistant' ? 'Miles' : 'You';
    const texts = (msg.parts || [])
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text.trim())
      .filter(Boolean);
    const otherParts = (msg.parts || [])
      .map((p) => p?.type)
      .filter((t) => t && t !== 'text' && t !== 'step-start');
    console.log(`[${role}]`);
    if (texts.length) console.log(texts.join('\n'));
    if (!texts.length && otherParts.length) {
      console.log(`(${otherParts.join(', ')})`);
    }
    console.log('');
  });
  if (data.offset > 0) {
    console.log(
      `Earlier messages: miles history --offset ${Math.max(0, data.offset - data.limit)} --limit ${data.limit}`,
    );
  }
}

async function cmdConvertTheme(rawArgs = []) {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError(
      'No active conversation. Use `miles site-create` first.',
      EXIT_PRECONDITION,
    );
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const { noWait } = parseNoWaitFlag('convert-theme', rawArgs);
  if (noWait) await ensureNoWaitSupported(serverUrl);

  const dashboardUrl = getDashboardUrl(site);
  if (!dashboardUrl) {
    exitWithError(
      'Active site is missing its dashboard URL. Run `miles sites` and `miles site-attach <siteId>`, or recreate the site.',
      EXIT_PRECONDITION,
    );
  }

  // Keep stdout clean for the JSON handle when --no-wait was requested.
  const logLine = noWait
    ? (line) => console.error(line)
    : (line) => console.log(line);

  // Check if the dashboard is already connected before theme conversion.
  let connected = false;
  const status = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/ws-status`,
    { auth: site.siteToken, serverUrl },
  );
  connected = status.connected;

  if (!connected) {
    logLine(`Dashboard: ${dashboardUrl}`);

    logLine('Waiting for WordPress Playground to connect...');
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
        logLine(`Still waiting for connection... (${elapsed}s)`);
      }
    }

    if (!connected) {
      exitWithDashboardConnectionRequired(site, PLAYGROUND_CONNECT_TIMEOUT_MS);
    }
    logLine('Playground connected.');
  }

  // Trigger theme conversion
  logLine('Converting the site into a WordPress block theme...');
  await apiRequest(
    'POST',
    `/api/v2/headless/conversations/${site.conversationId}/build-theme`,
    { auth: site.siteToken, serverUrl },
  );

  writeActiveRun({
    verb: 'convert-theme',
    siteId: site.id,
    conversationId: site.conversationId,
  });

  if (noWait) {
    emitNoWaitHandle({
      siteId: site.id,
      conversationId: site.conversationId,
    });
    return;
  }

  // Wait for completion after the agent has established the dashboard session.
  const settled = await doWait(creds, site.conversationId, serverUrl);
  console.log('To edit this site, run: miles say "describe your changes"');
  exitWithTurnOutcome(settled);
}

async function cmdExportTheme() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    exitWithError('No active conversation.', EXIT_PRECONDITION);
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
    exitWithError('No active conversation.', EXIT_PRECONDITION);
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

/**
 * UserPromptSubmit hook handler (Claude Code). If a fired run may still be
 * in flight (e.g. the user interrupted the agent mid-run), inject recovery
 * context into the next turn. No network calls — local marker only.
 */
async function cmdHookPrompt() {
  try {
    // Drain stdin (hook payload is unused; the marker is the state source).
    readFileSync(0, 'utf-8');
  } catch {
    // No stdin is fine.
  }

  const run = readActiveRun();
  if (!run) return;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `${activeRunNotice(run)} Handle this yourself: rejoin first, then answer the user with the real state (finished -> show the result; still working -> say so and keep watching). Only surface cancel if their message changes direction.`,
      },
    }),
  );
}

async function cmdHook() {
  // PostToolUse hook handler
  // Reads stdin for the hook payload, checks if it was a miles command,
  // and returns additionalContext if so
  let input = '';
  try {
    input = readFileSync(0, 'utf-8');
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
  // v0 primitive grammar
  auth: cmdAuth,
  'account-status': cmdAccountStatus,
  'site-create': cmdCreateSite,
  say: cmdSay,
  'design-directions': cmdDesignDirections,
  'build-site': cmdBuildSite,
  'wait-job': cmdWaitJob,
  'approval-respond': cmdApprovalRespond,
  'site-state': cmdSiteState,
  'site-attach': cmdSiteAttach,
  'wordpress-detect': cmdWordPressDetect,
  'wordpress-setup': cmdWordPressSetup,
  screenshot: cmdScreenshot,
  'upload-assets': cmdUploadAssets,
  export: cmdExport,
  'connect-browser': cmdConnectBrowser,
  'convert-theme': cmdConvertTheme,
  cancel: cmdCancel,
  undo: cmdUndo,
  'site-pages': cmdSitePages,
  'usage-history': cmdUsageHistory,
  rename: cmdRename,
  history: cmdHistory,

  // Supporting verbs
  doctor: cmdDoctor,
  wait: cmdWait,
  status: cmdStatus,
  sites: cmdSites,
  use: cmdUse,
  balance: cmdBalance,
  messages: cmdMessages,
  'check-auth': cmdCheckAuth,
  'hook-init': cmdHookInit,
  hook: cmdHook,
  'hook-prompt': cmdHookPrompt,

  // Aliases for earlier skill versions
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  'create-site': cmdCreateSite,
  reply: cmdSay,
  'select-design-direction': cmdBuildSite,
  preview: cmdConnectBrowser,
  'build-theme': cmdConvertTheme,
  'export-theme': cmdExportTheme,
  'export-site': cmdExportSite,
};

if (!command || command === 'help' || command === '--help') {
  console.log(`Miles CLI - Design websites with Miles AI

Primitives (HEADLESS = no browser needed, BROWSER = needs connect-browser first):

Account:
  miles auth [login|poll|status|logout]   HEADLESS  Device login lifecycle
  miles account-status [--json]           HEADLESS  Plan, credits, site count
  miles doctor [--json]                   HEADLESS  Check local CLI setup

Sites:
  miles site-create "<description>" [--brief <file>] [--name "Name"]
                    [--attach <file>]     HEADLESS  Create site + conversation
  miles site-attach <siteId> [--duplicate]
                                          HEADLESS  Resume any owned site
  miles wordpress-detect [--path <dir>]   HEADLESS  Detect local WordPress
  miles wordpress-setup --use local       HEADLESS  Connect local WordPress
                    [--path <dir>]                  when user chooses it
  miles site-state [--full] [--json]      HEADLESS  Phase, directions, next moves
                                                    (--full: brief, plan, memory)
  miles history [--limit <n>] [--offset <n>]
                                          HEADLESS  Conversation transcript
                                                    (paginated, newest by default)
  miles sites [--json]                    HEADLESS  List all sites
  miles use <siteId>                      HEADLESS  Switch active site (local)

Design + build:
  miles say "<message>" [--attach <file>] HEADLESS* Talk to Miles (discovery,
                                                    brief feedback, edits)
  miles upload-assets <file> [...]        HEADLESS  Upload brand assets (logo,
                                                    imagery, content docs);
                                                    prints reusable refs
  miles design-directions [--json]        HEADLESS  List design directions
  miles build-site --design <n>           HEADLESS  Commit a design, build site
  miles screenshot <preview-url> [--full-page]
                                          HEADLESS  Capture a preview JPEG
  miles screenshot --live [--viewport]    BROWSER   Capture the live WordPress
                                                    frontend (full-page default)
  miles wait-job [--timeout <s>]          HEADLESS  Wait for the running turn
                                                    (JSON result + exit code)
  miles approval-respond --grant <id> --response approved|declined
                                          HEADLESS  Answer a protected live-site
                                                    approval after explicit user
                                                    consent/refusal
  miles cancel                            HEADLESS  Stop the running turn
  miles undo                              HEADLESS  Revert the last turn (site
                                                    + chat, one level)
  miles site-pages [path] [--output <f>]  HEADLESS  List built-site files, or
                                                    fetch one file's content
  miles rename "New name"                 HEADLESS  Rename the site/conversation
  miles usage-history [--limit <n>]       HEADLESS  Credit transaction history

WordPress:
  miles connect-browser [--open] [--wait] BROWSER   Dashboard URL + connection
  miles convert-theme                     BROWSER   HTML site -> block theme

Export:
  miles export [--type html|theme]        HEADLESS  Deliverable URLs (theme zip
                                                    download needs the browser)
  miles export --type theme --download <file>
                                          BROWSER   Stream the theme ZIP to disk

* say is headless before the site is built; edits on a built WordPress site
  need the browser connection and fail fast with exit 3 when it is missing.

Long verbs accept --no-wait to return a JSON handle immediately (requires a
server with cancel support). Pair with wait-job and cancel.

Exit codes: 0 ok | 1 failed/aborted | 2 precondition | 3 need connection
(open connect-browser url, wait for connected, retry once) | 4 blocked,
approval required, or declined by user | 5 capacity/already running.

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

/**
 * Map API rejections onto the shared exit-code grammar so agents can branch
 * without parsing error prose.
 */
function apiErrorExitCode(err) {
  if (!(err instanceof ApiError)) return EXIT_ERROR;
  const code = err.data?.code;
  if (code === 'dashboard_connection_required') return EXIT_NEED_CONNECTION;
  if (code === 'conversation_execution_locked') return EXIT_CAPACITY;
  if (code === 'approval_response_required') return EXIT_BLOCKED;
  if (code === 'approval_not_active') return EXIT_PRECONDITION;
  if (code === 'approval_not_answerable') return EXIT_BLOCKED;
  if (code === 'CONTENT_POLICY_VIOLATION') return EXIT_BLOCKED;
  if (err.status === 429 || err.status === 503) return EXIT_CAPACITY;
  if (err.status === 401) return EXIT_PRECONDITION;
  return EXIT_ERROR;
}

handler(args).catch((err) => {
  if (cliOptions.json) {
    if (err instanceof SandboxNetworkError) {
      emitJson({
        ok: false,
        code: err.code,
        status: err.status,
        host: err.host,
        error: err.message,
        requiredEgress: err.requiredEgress,
        remediation: err.remediation,
      });
    } else if (err instanceof ApiError) {
      const approvalRequired =
        sanitizeApprovalRequired(err.data?.approvalRequired) || undefined;
      const detail = err.data
        ? { ...err.data, approvalRequired }
        : null;
      emitJson({
        ok: false,
        error: err.message,
        status: err.status,
        approvalRequired,
        detail,
      });
    } else {
      emitJson({
        ok: false,
        error: err.message,
      });
    }
    process.exit(apiErrorExitCode(err));
  }

  if (err instanceof SandboxNetworkError) {
    console.error(`Error: ${err.message}`);
    console.error(`Code: ${err.code}`);
    console.error(`Required egress: ${err.requiredEgress.join(', ')}`);
    console.error(
      'Cursor fix: Settings > Agents > Auto Run > Auto-Run Network Access, then choose Allow all or allow these hosts through sandbox.json.',
    );
    console.error('Create or update .cursor/sandbox.json:');
    console.error(JSON.stringify(REQUIRED_EGRESS_SANDBOX_JSON, null, 2));
    console.error(
      'Terminal fallback: run the same Miles command in the user terminal outside the agent sandbox.',
    );
  } else if (err instanceof ApiError) {
    console.error(`Error: ${err.message}`);
    const approvalLines = [];
    appendApprovalRequiredLines(approvalLines, err.data?.approvalRequired);
    approvalLines.forEach((line) => console.error(line));
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
  process.exit(apiErrorExitCode(err));
});
