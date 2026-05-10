const DEFAULT_DEVICE_AUTH_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_AUTH_EXPIRY_SECONDS = 10 * 60;
const MIN_DEVICE_AUTH_POLL_INTERVAL_MS = 10 * 1000;
const MAX_DEVICE_AUTH_POLLS = 55;
const DEVICE_AUTH_SLOW_DOWN_INCREMENT_MS = 5 * 1000;

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function getDeviceAuthPollingPlan({
  intervalSeconds,
  expiresInSeconds,
} = {}) {
  const requestedIntervalSeconds =
    toPositiveNumber(intervalSeconds) || DEFAULT_DEVICE_AUTH_INTERVAL_SECONDS;
  const expiresSeconds =
    toPositiveNumber(expiresInSeconds) || DEFAULT_DEVICE_AUTH_EXPIRY_SECONDS;
  const pollIntervalMs = Math.max(
    Math.ceil(requestedIntervalSeconds * 1000),
    MIN_DEVICE_AUTH_POLL_INTERVAL_MS,
  );
  const expiryBoundPolls = Math.max(
    1,
    Math.floor((expiresSeconds * 1000) / pollIntervalMs) - 1,
  );
  const maxAttempts = Math.min(MAX_DEVICE_AUTH_POLLS, expiryBoundPolls);

  return {
    pollIntervalMs,
    maxAttempts,
    maxWaitMs: pollIntervalMs * maxAttempts,
  };
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export function parseRetryAfterSeconds(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!text) return null;

  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;

  const retryAtMs = Date.parse(text);
  if (!Number.isFinite(retryAtMs)) return null;

  const delaySeconds = Math.ceil((retryAtMs - nowMs) / 1000);
  return delaySeconds > 0 ? delaySeconds : null;
}

export function getSlowedDeviceAuthPollIntervalMs(
  currentPollIntervalMs,
  retryAfterSeconds,
) {
  const currentMs = Math.max(
    Math.ceil(toPositiveNumber(currentPollIntervalMs) || 0),
    MIN_DEVICE_AUTH_POLL_INTERVAL_MS,
  );
  const retryAfterMs = toPositiveNumber(retryAfterSeconds)
    ? Math.ceil(retryAfterSeconds * 1000)
    : 0;

  return Math.max(currentMs + DEVICE_AUTH_SLOW_DOWN_INCREMENT_MS, retryAfterMs);
}

export function formatRetryAfter(retryAfterSeconds) {
  const seconds = toPositiveNumber(retryAfterSeconds);
  if (!seconds) return '';
  return `Wait about ${formatDuration(seconds * 1000)} before trying again.`;
}

export function buildDevicePollingTimeoutMessage(maxWaitMs) {
  return [
    `Authorization was not completed within ${formatDuration(maxWaitMs)}.`,
    'Run `miles login` again for a fresh code.',
  ].join(' ');
}

export function buildDevicePollingRateLimitMessage(retryAfterSeconds) {
  const retryAfter = formatRetryAfter(retryAfterSeconds);
  const message = [
    'Miles login polling was rate limited before authorization completed.',
  ];
  if (retryAfter) message.push(retryAfter);
  message.push('Run `miles login` again for a fresh code.');
  return message.join(' ');
}
