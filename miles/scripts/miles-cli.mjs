#!/usr/bin/env -S node --experimental-websocket

/**
 * Miles CLI - Conversation transport for external AI agents.
 *
 * Zero-dependency Node.js ES module (uses built-in fetch, fs, child_process).
 * Wraps the Miles headless REST API for agent-to-agent workflows.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

// ============================================================================
// Config
// ============================================================================

const CREDENTIALS_DIR = join(homedir(), '.miles');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');
const LAST_RESPONSE_FILE = join(CREDENTIALS_DIR, 'last-response');
const DEFAULT_SERVER_URL = 'https://api.bymiles.ai';
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
const POLL_TIMEOUT_MS = 10000; // 10 second poll for faster progress updates

// Track hero preview statuses across data parts for aggregate progress display
const heroProgressTracker = new Map();

// ============================================================================
// Credential management
// ============================================================================

function loadCredentials() {
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return {};
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

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const errMsg = data.error || data.message || `HTTP ${res.status}`;
    throw new ApiError(errMsg, res.status, data);
  }

  return data;
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
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
  } catch {
    // Silently fail - URL is printed to console as fallback
  }
}

// ============================================================================
// Commands
// ============================================================================

async function cmdLogin() {
  const serverUrl = DEFAULT_SERVER_URL;
  console.log(`Opening browser for Miles login...`);

  // Request device code
  const data = await apiRequest('POST', '/api/v2/auth/device/device-code', {
    serverUrl,
  });
  const { deviceCode, userCode, verificationUrl, interval } = data;

  console.log(`\nYour code: ${userCode}`);
  console.log(`Opening: ${verificationUrl}\n`);

  openUrl(verificationUrl);

  console.log('Waiting for authorization...');

  // Poll for token
  const pollInterval = (interval || 5) * 1000;
  const maxAttempts = 120; // 10 minutes max

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollInterval));
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
      if (err.data?.error === 'authorization_pending') continue;
      if (err.data?.error === 'expired_token') {
        console.error('\nAuthorization expired. Please try again.');
        process.exit(1);
      }
      throw err;
    }
  }

  console.error('\nAuthorization timed out. Please try again.');
  process.exit(1);
}

async function cmdLogout() {
  saveCredentials({});
  console.log('Logged out. Credentials cleared.');
}

async function cmdWhoami() {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    console.log('Not logged in. Use `miles login`.');
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
  } catch {
    // API key is invalid - clear all credentials
    saveCredentials({});
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
    } catch {
      // Site token is stale - clear site data but keep API key
      delete creds.sites;
      delete creds.activeSite;
      saveCredentials(creds);
    }
  }

  process.exit(0);
}

async function cmdCreateSite(args) {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    console.error(
      'Not logged in. Use `miles login` first.',
    );
    process.exit(1);
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
      } catch {
        console.error(`Could not read brief file: ${briefPath}`);
        process.exit(1);
      }
    } else if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    } else {
      message = args[i];
    }
  }

  if (!message) {
    console.error(
      'Usage: miles create-site "<description>" [--name "Site Name"] [--brief <file>]',
    );
    process.exit(1);
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
    console.error(
      'No active conversation. Use `miles create-site` to start one.',
    );
    process.exit(1);
  }

  const message = args.join(' ');
  if (!message) {
    console.error('Usage: miles reply "<message>"');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;

  await apiRequest(
    'POST',
    `/api/v2/headless/conversations/${site.conversationId}/message`,
    {
      auth: site.siteToken,
      body: { message },
      serverUrl,
    },
  );

  await doWait(creds, site.conversationId, serverUrl);
}

async function cmdWait() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    console.error('No active conversation.');
    process.exit(1);
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
async function doWaitWebSocket(creds, conversationId, serverUrl, maxWaitMs) {
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

    // Helper: fetch final response via REST and output it
    // Use short timeoutMs for race-condition checks, longer for final fetch
    const fetchAndOutput = async (timeoutMs = 2000) => {
      try {
        const data = await apiRequest(
          'GET',
          `/api/v2/headless/conversations/${conversationId}/wait?timeout=${timeoutMs}`,
          { auth: token, serverUrl },
        );
        if (data.status !== 'running') {
          const output = formatWaitResponse(data);
          writeLastResponse(output);
          // Print design direction preview URLs only during direction selection phase
          if (
            data.directions?.length &&
            data.phase === 'design_directions_ready'
          ) {
            console.log('');
            data.directions.forEach((h) => {
              const name = h.directionName || `Design ${h.number}`;
              const previewPath =
                h.previewUrl?.replace(/^https?:\/\/[^/]+/, '') || h.previewUrl;
              console.log(`Design ${h.number}: ${name}`);
              console.log(`  Preview: ${h.previewUrl}`);
              console.log(
                `  Screenshot: miles screenshot ${previewPath}`,
              );
            });
          }
          return true;
        }
      } catch {}
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
          const alreadyDone = await fetchAndOutput(100);
          if (alreadyDone) {
            cleanup();
            clearTimeout(timeoutTimer);
            resolve(true);
            return;
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
          // User input required — print narrative. The server-side fix
          // (pauseRequested propagation) ensures the coordinator stops quickly
          // and emits a finish chunk. The setTimeout is a safety-net fallback.
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
              if (finished) return;
              const done = await fetchAndOutput(5000);
              if (done) {
                cleanup();
                clearTimeout(timeoutTimer);
                resolve(true);
              }
            }, 5000);
          } else if (chunk.type === 'data-brief-editor') {
            console.log(
              `Miles has prepared a design brief for review (${elapsed}s)`,
            );
            lastProgressMsg = 'brief';
            // Safety-net fallback: poll REST if finish chunk is delayed
            setTimeout(async () => {
              if (finished) return;
              const done = await fetchAndOutput(5000);
              if (done) {
                cleanup();
                clearTimeout(timeoutTimer);
                resolve(true);
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
      } catch {}
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
 * reopens the browser if it drops. Runs as a background loop alongside
 * doWait. The server's REST proxy retry logic bridges the gap while
 * the Playground reboots (~15-20s).
 *
 * Returns a stop function to call when the wait is complete.
 */
function startConnectionWatchdog(
  conversationId,
  token,
  serverUrl,
  dashboardUrl,
) {
  if (!dashboardUrl) return () => {};

  let running = true;
  // Only activate once we've seen the connection up at least once.
  // This prevents reopening the browser during early phases (discovery,
  // brief, hero generation) when the browser was never opened.
  let connectionSeenOnce = false;
  (async () => {
    while (running) {
      await new Promise((r) => setTimeout(r, 5000));
      if (!running) break;
      try {
        const status = await apiRequest(
          'GET',
          `/api/v2/headless/conversations/${conversationId}/ws-status`,
          { auth: token, serverUrl },
        );
        if (status.connected) {
          connectionSeenOnce = true;
        } else if (connectionSeenOnce) {
          console.log('  Connection lost. Reopening dashboard...');
          openUrl(dashboardUrl);
          // Wait for reconnection
          const reconnectStart = Date.now();
          while (running && Date.now() - reconnectStart < 30000) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const recheck = await apiRequest(
                'GET',
                `/api/v2/headless/conversations/${conversationId}/ws-status`,
                { auth: token, serverUrl },
              );
              if (recheck.connected) {
                console.log('  Playground reconnected.');
                break;
              }
            } catch {}
          }
        }
      } catch {}
    }
  })();

  return () => {
    running = false;
  };
}

async function doWait(creds, conversationId, serverUrl, maxWaitMs) {
  const maxWait = maxWaitMs || MAX_WAIT_MS;
  const site = getActiveSite(creds);
  const token = site?.siteToken;
  if (!token) {
    console.error('No site token. Use `miles create-site` first.');
    process.exit(1);
  }

  // Start connection watchdog to auto-recover if the browser closes
  const dashboardUrl = site?.dashboardUrl
    ? `${site.dashboardUrl}?agent=true`
    : null;
  const stopWatchdog = startConnectionWatchdog(
    conversationId,
    token,
    serverUrl,
    dashboardUrl,
  );

  try {
    // Try WebSocket first for real-time progress
    const wsHandled = await doWaitWebSocket(
      creds,
      conversationId,
      serverUrl,
      maxWaitMs,
    );
    if (wsHandled) return;

    // Fallback: polling loop
    const startTime = Date.now();
    let lastDirectionCount = 0;
    let announcedPhase = '';
    let lastProgressMsg = '';

    while (Date.now() - startTime < maxWait) {
      const data = await apiRequest(
        'GET',
        `/api/v2/headless/conversations/${conversationId}/wait?timeout=${POLL_TIMEOUT_MS}`,
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
          console.log(`Still working... (${elapsed}s)`);
        }

        continue;
      }

      // Got a response

      const output = formatWaitResponse(data);
      writeLastResponse(output);
      return;
    }

    // Timed out - tell the agent what's happening so it can act
    const statusMsg = announcedPhase
      ? `Miles is still working. [phase: ${announcedPhase}]`
      : 'Miles is still working.';
    console.log(statusMsg);
    console.log('Use `miles wait` to continue polling for the response.');
  } finally {
    stopWatchdog();
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
    console.error('No active conversation.');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/status`,
    { auth: site.siteToken, serverUrl },
  );

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
    console.error('No active conversation.');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/design-directions`,
    { auth: site.siteToken, serverUrl },
  );

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
    console.error('No active conversation.');
    process.exit(1);
  }

  const directionNumber = parseInt(args[0]);
  if (!directionNumber || directionNumber < 1) {
    console.error('Usage: miles select-design-direction <number>');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;

  console.log(`Selecting design direction ${directionNumber}...`);

  // Open the dashboard first — the browser must be connected before we
  // trigger the build so the dashboard can display the live build progress.
  const dashboardUrl = `${site.dashboardUrl}?agent=true`;
  console.log(`Opening dashboard...`);
  openUrl(dashboardUrl);

  // Wait for the dashboard WebSocket connection before starting the build.
  // This ensures the dashboard subscribes to the conversation stream and
  // can display live build progress instead of joining mid-stream.
  console.log(`Waiting for dashboard to connect...`);
  const wsConnectStart = Date.now();
  const WS_CONNECT_TIMEOUT = 30000;
  let dashboardConnected = false;
  while (Date.now() - wsConnectStart < WS_CONNECT_TIMEOUT) {
    try {
      const status = await apiRequest(
        'GET',
        `/api/v2/headless/conversations/${site.conversationId}/ws-status`,
        { auth: site.siteToken, serverUrl },
      );
      if (status.connected) {
        dashboardConnected = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!dashboardConnected) {
    console.log(
      `Dashboard did not connect within ${WS_CONNECT_TIMEOUT / 1000}s — proceeding anyway.`,
    );
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
    console.error('No active site. Use `miles create-site` first.');
    process.exit(1);
  }

  // Extract the URL: first arg that starts with / or http
  const url = args.find((a) => a.startsWith('/') || a.startsWith('http'));
  if (!url) {
    console.error('Usage: miles screenshot <preview-url>');
    console.error(
      'Example: miles screenshot /preview/abc123/previews/hero-xyz/index.html',
    );
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;

  // Fetch screenshot as binary image from the server
  const encodedUrl = encodeURIComponent(url);
  const endpoint = `${serverUrl}/api/v2/headless/screenshot?url=${encodedUrl}`;

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${site.siteToken}` },
  });

  if (!response.ok) {
    let msg = `Screenshot failed (HTTP ${response.status})`;
    try {
      const err = await response.json();
      if (err.error) msg = err.error;
    } catch {}
    console.error(msg);
    process.exit(1);
  }

  // Save to temp file
  const imageBuffer = Buffer.from(await response.arrayBuffer());
  const tmpDir = join(homedir(), '.miles', 'screenshots');
  mkdirSync(tmpDir, { recursive: true });
  const filename = `screenshot-${Date.now()}.jpg`;
  const filepath = join(tmpDir, filename);
  writeFileSync(filepath, imageBuffer);

  console.log(filepath);
}

async function cmdSites() {
  const creds = loadCredentials();
  if (!creds.apiKey) {
    console.error('Not logged in.');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest('GET', '/api/v2/headless/sites', {
    auth: creds.apiKey,
    serverUrl,
  });

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
    console.error('Usage: miles use <siteId>');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds.sites?.[siteId]) {
    console.error(
      `Site ${siteId} not found in local credentials. Use \`miles sites\` to see available sites.`,
    );
    process.exit(1);
  }

  creds.activeSite = siteId;
  saveCredentials(creds);
  console.log(`Switched to site: ${creds.sites[siteId].name || siteId}`);
}

async function cmdPreview() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site) {
    console.error('No active site.');
    process.exit(1);
  }

  const url = `${site.dashboardUrl}?agent=true`;
  console.log(url);
  openUrl(url);
}

async function cmdBalance() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    console.error('No active site.');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;

  // Use the wait endpoint with a quick timeout to get credits
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/wait?timeout=1000`,
    { auth: site.siteToken, serverUrl },
  );

  if (data.credits) {
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
    console.log('Could not retrieve balance.');
  }
}

async function cmdMessages() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    console.error('No active conversation.');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/messages`,
    { auth: site.siteToken, serverUrl },
  );

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
    console.error('No active conversation. Use `miles create-site` first.');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const dashboardUrl = `${site.dashboardUrl}?agent=true`;

  // Check if Playground is already connected (opened during select-design-direction)
  let connected = false;
  try {
    const status = await apiRequest(
      'GET',
      `/api/v2/headless/conversations/${site.conversationId}/ws-status`,
      { auth: site.siteToken, serverUrl },
    );
    connected = status.connected;
  } catch {}

  if (!connected) {
    // Fallback: open browser and wait for connection
    console.log(`Opening dashboard: ${dashboardUrl}`);
    openUrl(dashboardUrl);

    console.log('Waiting for WordPress Playground to connect...');
    const wsStart = Date.now();
    while (Date.now() - wsStart < 60000) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const status = await apiRequest(
          'GET',
          `/api/v2/headless/conversations/${site.conversationId}/ws-status`,
          { auth: site.siteToken, serverUrl },
        );
        if (status.connected) {
          connected = true;
          break;
        }
      } catch {}
      const elapsed = Math.round((Date.now() - wsStart) / 1000);
      if (elapsed > 0 && elapsed % 10 === 0) {
        console.log(`Still waiting for connection... (${elapsed}s)`);
      }
    }

    if (!connected) {
      console.error(
        'Timed out waiting for Playground connection. Make sure the dashboard is open in a browser.',
      );
      process.exit(1);
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

  // Wait for completion — doWait includes a connection watchdog that
  // auto-reopens the browser if the Playground connection drops.
  await doWait(creds, site.conversationId, serverUrl);
  console.log('To edit this site, run: miles reply "describe your changes"');
}

async function cmdExportTheme() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    console.error('No active conversation.');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/export/theme`,
    { auth: site.siteToken, serverUrl },
  );

  console.log(`Theme: ${data.themeSlug}`);
  console.log(`Download: ${data.downloadUrl}`);
  if (data.editorUrl) console.log(`Editor: ${data.editorUrl}`);
  console.log(`Dashboard: ${data.dashboardUrl}`);
}

async function cmdExportSite() {
  const creds = loadCredentials();
  const site = getActiveSite(creds);
  if (!site?.conversationId) {
    console.error('No active conversation.');
    process.exit(1);
  }

  const serverUrl = DEFAULT_SERVER_URL;
  const data = await apiRequest(
    'GET',
    `/api/v2/headless/conversations/${site.conversationId}/export/html`,
    { auth: site.siteToken, serverUrl },
  );

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
  } catch {
    process.exit(0);
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Check if this was a miles CLI command (stdin uses snake_case field names)
  const toolCommand = hookData?.tool_input?.command || '';
  if (!toolCommand.includes('miles') && !toolCommand.includes('.miles/bin/')) {
    // Not a miles command, exit silently
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
  } catch {
    // Ignore errors
  }
  process.exit(0);
}

// ============================================================================
// Main
// ============================================================================

const command = process.argv[2];
const args = process.argv.slice(3);

const commands = {
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  'check-auth': cmdCheckAuth,
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
  miles login [server-url]          Device auth flow (opens browser)
  miles logout                      Clear stored credentials
  miles whoami                      Show current auth + active site

Site Management:
  miles create-site "<description>" Create site + start conversation
  miles create-site --brief <file>  Create with pre-built brief (skip discovery)
  miles sites                       List all sites
  miles use <siteId>                Switch active site
  miles preview                     Get/open dashboard URL
  miles balance                     Show credit balance

Conversation:
  miles reply "<message>"           Send message to Miles, wait for response
  miles wait                        Long-poll for Miles' response
  miles status                      Quick status check (non-blocking)
  miles design-directions             Get design direction preview URLs
  miles select-design-direction <n> Choose a design direction
  miles build-theme                 Build WordPress theme (opens browser, waits, converts)
  miles screenshot <preview-url>    Screenshot a preview URL (saves JPEG, prints path)
  miles messages                    Full conversation history

Export:
  miles export-theme                Download WordPress theme info
  miles export-site                 Get static HTML files info`);
  process.exit(0);
}

const handler = commands[command];
if (!handler) {
  console.error(
    `Unknown command: ${command}. Use \`miles help\` for available commands.`,
  );
  process.exit(1);
}

handler(args).catch((err) => {
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
