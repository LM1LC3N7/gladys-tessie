// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in tessie-state.json, readable by the container user only (0600):
//   - `salt` + `refused`: after Tessie refused the token, an 8-bit HMAC of it
//     (keyed by the random salt): the same token is not tried again after a
//     restart; a new token (another fingerprint, or any token saved in the
//     configuration while running) is always tried. Erased at the next success.
//   - `pause`: `{ until, status }` after a 429 / 5xx (wall clock, bounded).
//   - `lastRead`: when the last read of Tessie started (never faster than the
//     interval across a restart).
//   - `seen`: per car (platform id), the timestamp of each section already
//     published: a value is never published twice nor as new after a restart.
//   - `locks`: per car, a lock asked and not yet done: `{ until, attempts }`.
// Never a secret: no token (8 bits of an HMAC are no use to guess it), no VIN.
// Read back bounded (a clock moved or a file edited by hand never gives a
// pause longer than its maximum), only known keys of the expected shape
// (never an inherited or `__proto__` key).
// -----------------------------------------------------------------------------

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';
import { SECTIONS } from './car.js';

export const STATE_FILE = '/data/tessie-state.json';
const MAX_FILE = 16 * 1024;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /**
     * The saved state: null when there is none (no file, or a file that is
     * not ours: too large or not JSON, rewritten at the next save). Any other
     * error (EIO, EACCES...) REJECTS: unreadable is not empty.
     */
    async load() {
      let size;
      try {
        size = (await stat(path)).size;
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      if (size > MAX_FILE) return null;
      const text = await readFile(path, 'utf8');
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failing` refuses saves, `unreadable` loads. */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    loads: 0,
    failing,
    unreadable,
    async load() {
      this.loads += 1;
      if (this.unreadable) throw new Error('EIO');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const PID = /^[0-9a-f]{16}$/;

/** The persisted state, repaired and bounded against the wall clock `now`. */
export function normalizeMemory(raw, now) {
  const salt = own(raw, 'salt');
  const goodSalt = typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt) ? salt : undefined;
  const fp = own(own(raw, 'refused'), 'fp');
  const refusedStatus = own(own(raw, 'refused'), 'status');
  const until = own(own(raw, 'pause'), 'until');
  const pauseStatus = own(own(raw, 'pause'), 'status');
  const lastRead = own(raw, 'lastRead');
  const seen = {};
  const rawSeen = own(raw, 'seen');
  for (const pid of isObject(rawSeen) ? Object.keys(rawSeen).slice(0, LIMITS.vehicles * 2) : []) {
    if (!PID.test(pid)) continue;
    const entry = {};
    for (const section of Object.keys(SECTIONS)) {
      const ts = own(rawSeen[pid], section);
      // A timestamp in the future (clock set back, file edited) would hide the next values: dropped.
      if (Number.isInteger(ts) && ts > 0 && ts <= now + TIMINGS.futureSkew) entry[section] = ts;
    }
    seen[pid] = entry;
  }
  const locks = {};
  const rawLocks = own(raw, 'locks');
  for (const pid of isObject(rawLocks) ? Object.keys(rawLocks).slice(0, LIMITS.vehicles * 2) : []) {
    const lockUntil = own(rawLocks[pid], 'until');
    const attempts = own(rawLocks[pid], 'attempts');
    if (
      PID.test(pid) &&
      Number.isFinite(lockUntil) &&
      lockUntil > now &&
      lockUntil <= now + TIMINGS.lockWindow &&
      Number.isInteger(attempts) &&
      attempts >= 0 &&
      attempts < TIMINGS.lockAttempts
    ) {
      locks[pid] = { until: lockUntil, attempts };
    }
  }
  return {
    salt: goodSalt,
    refused:
      goodSalt && typeof fp === 'string' && /^[0-9a-f]{2}$/.test(fp)
        ? { fp, status: refusedStatus === 403 ? 403 : 401 }
        : undefined,
    pause:
      Number.isFinite(until) && until > now
        ? {
            until: Math.min(until, now + TIMINGS.pauseMax),
            status:
              Number.isInteger(pauseStatus) && pauseStatus >= 400 && pauseStatus < 600
                ? pauseStatus
                : 429,
          }
        : undefined,
    // A date in the future (a clock set back) is brought to now: the next read waits a full interval.
    lastRead: Number.isFinite(lastRead) && lastRead > 0 ? Math.min(lastRead, now) : undefined,
    seen,
    locks,
  };
}

export const serializeMemory = (m) => ({
  salt: m.salt,
  ...(m.refused ? { refused: { fp: m.refused.fp, status: m.refused.status } } : {}),
  ...(m.pause ? { pause: { until: m.pause.until, status: m.pause.status } } : {}),
  ...(m.lastRead ? { lastRead: m.lastRead } : {}),
  seen: m.seen,
  locks: m.locks,
});
