// -----------------------------------------------------------------------------
// The configuration typed in Gladys, checked and normalized. DEFAULT_CONFIG
// mirrors the manifest defaults (test/manifest.test.js ties them).
// The token is never logged nor shown: only `problem` says what is wrong.
// -----------------------------------------------------------------------------

import { LIMITS, SECOND, TIMINGS } from './constants.js';

export const DEFAULT_CONFIG = {
  api_token: '',
  poll_interval: TIMINGS.pollDefault / SECOND,
  publish_position: false,
  language: 'fr',
};

// eslint-disable-next-line no-control-regex
const BAD_TOKEN = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;

const bool = (value, fallback) =>
  value === true || value === 'true'
    ? true
    : value === false || value === 'false'
      ? false
      : fallback;

/**
 * -> { token, interval (ms), publishPosition, language, problem }; `problem`
 * is 'noToken' or 'badToken' (nothing is sent then), undefined when fine.
 */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  let token = typeof config.api_token === 'string' ? config.api_token.trim() : '';
  let problem;
  if (token === '') {
    problem = 'noToken';
  } else if (Buffer.byteLength(token) > LIMITS.tokenBytes || BAD_TOKEN.test(token)) {
    // A control byte, a space or a line break in the middle: never put in a header.
    problem = 'badToken';
    token = '';
  }
  const seconds = Number(config.poll_interval);
  const interval =
    typeof config.poll_interval === 'number' || /^\d{1,6}$/.test(String(config.poll_interval ?? ''))
      ? Math.min(
          Math.max(
            Number.isFinite(seconds) ? Math.round(seconds) * SECOND : TIMINGS.pollDefault,
            TIMINGS.pollMin,
          ),
          TIMINGS.pollMax,
        )
      : TIMINGS.pollDefault;
  return {
    token,
    interval,
    publishPosition: bool(config.publish_position, DEFAULT_CONFIG.publish_position),
    language: config.language === 'en' ? 'en' : 'fr',
    problem,
  };
}

/** Whether two normalized configurations ask for the same reads. */
export const sameConfig = (a, b) =>
  a.token === b.token &&
  a.interval === b.interval &&
  a.publishPosition === b.publishPosition &&
  a.language === b.language &&
  a.problem === b.problem;
