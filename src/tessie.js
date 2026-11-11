// -----------------------------------------------------------------------------
// The Tessie API (https://api.tessie.com, developer.tessie.com), written from
// its public documentation: the token goes in the Authorization header only
// (never in the URL), redirects are never followed (the token would go with
// them), every answer is bounded in size and in time, and an error never
// carries the token nor the VIN (only a kind and a status code).
// -----------------------------------------------------------------------------

import { API, LIMITS, USER_AGENT } from './constants.js';

export class TessieError extends Error {
  /**
   * kind: 'auth' (401/403), 'rate' (429), 'server' (5xx), 'client' (other
   * 4xx, a redirect), 'timeout', 'network', 'invalid' (unreadable, too large).
   * `sent`: false when the request surely never left (refused connection,
   * unknown host), true otherwise (it may have reached Tessie).
   */
  constructor(kind, { status, retryAfter, sent = true } = {}) {
    super(status ? `${kind} (${status})` : kind);
    this.name = 'TessieError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.sent = sent;
  }

  /** A short reason for the status (no secret, no URL). */
  get reason() {
    return this.status ? `HTTP ${this.status}` : this.kind;
  }
}

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/** Retry-After: seconds, or an HTTP date read against the Date of the answer. */
export function parseRetryAfter(value, date) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (!Number.isFinite(at) || date === undefined) return undefined;
  return Math.max(0, at - date);
}

/** The Date header in ms, or undefined (never guessed). */
export function parseDate(value) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

async function readBounded(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TessieError('invalid');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One request. -> { status, date, body } (body: parsed JSON). Throws a
 * TessieError. `timers.setTimeout` bounds the whole exchange, body included.
 */
export async function tessieRequest({
  fetch,
  timers,
  token,
  method = 'GET',
  path,
  query,
  timeout,
  maxBytes = LIMITS.bodyBytes,
  signal,
}) {
  const url = new URL(path, API.base);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  // The app stopping aborts what is in flight.
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new TessieError('timeout');
      const code = err?.cause?.code ?? err?.code;
      throw new TessieError('network', { sent: !NOT_SENT.has(code) });
    }
    const { status } = response;
    const date = parseDate(response.headers.get('date'));
    if (status < 200 || status > 299) {
      await response.body?.cancel().catch(() => {});
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), date);
      const kind =
        status === 401 || status === 403
          ? 'auth'
          : status === 429
            ? 'rate'
            : status >= 500
              ? 'server'
              : 'client';
      throw new TessieError(kind, { status, retryAfter });
    }
    let text;
    try {
      text = await readBounded(response, maxBytes);
    } catch (err) {
      if (err instanceof TessieError) throw err;
      throw new TessieError(timedOut ? 'timeout' : 'invalid');
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TessieError('invalid', { status });
    }
    return { status, date, body };
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
