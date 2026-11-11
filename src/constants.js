// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their scenes and
// configuration) and the tuning of the integration.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const VERSION = '0.1.0';
export const USER_AGENT = `gladys-tessie/${VERSION} (+https://github.com/LM1LC3N7/gladys-tessie)`;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** The `type` part of the external ids: ext:<selector>:car:<fingerprint of the VIN> (forever). */
export const DEVICE_TYPE = 'car';

export const API = {
  base: 'https://api.tessie.com',
};

export const LIMITS = {
  /** Gladys accepts 300 states per minute: a margin for the other paths. */
  statesPerMinute: 250,
  /** The largest answer read from Tessie (a vehicle state is about 10 KB). */
  bodyBytes: 1024 * 1024,
  /** Vehicles followed at once (the others are ignored, said in the status). */
  vehicles: 10,
  /** Texts published (name, state). */
  text: 100,
  /** The longest token accepted (Tessie tokens are about 40 characters). */
  tokenBytes: 512,
};

/** Decimal places of the published position: 3 = about 110 m north-south, less east-west. */
export const POSITION_DECIMALS = 3;

/** Miles -> km (the Tesla data is in miles whatever the car shows). */
export const KM_PER_MILE = 1.609344;

export const TIMINGS = {
  /** Default, smallest and largest interval between two reads of the vehicles. */
  pollDefault: 5 * MINUTE,
  pollMin: MINUTE,
  pollMax: HOUR,
  /** A read of the vehicles gives up after this long. */
  readTimeout: 20 * SECOND,
  /** A lock command (Tessie wakes the car first, then waits for it) gives up after this long. */
  lockTimeout: 90 * SECOND,
  /** Gladys cuts a command at 5 s: the answer to Gladys is given after this long at most. */
  lockAck: 3 * SECOND,
  /** A lock is tried this many times at most, the next tries spaced this much. */
  lockAttempts: 3,
  lockRetry: [10 * SECOND, 30 * SECOND],
  /** A lock not sent (no token, configuration not read) is kept this long, in /data too. */
  lockWindow: 3 * MINUTE,
  /** The reads after a lock, to show the new state. */
  followUp: [5 * SECOND, 20 * SECOND],
  /** Pause after a 429 or a 5xx: bounds, and the first one without Retry-After. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** A network error: the next read after the interval, doubled at each failure up to this. */
  backoffMax: HOUR,
  /** A value this old (from the Date of Tessie's answer) is published as new; older, dated. */
  fresh: 10 * MINUTE,
  /** A value older than this is never published. */
  staleMax: 2 * HOUR,
  /** A timestamp this far after Tessie's Date is invalid. */
  futureSkew: 5 * MINUTE,
  /** An unchanged value is published again after this long (dated reads excepted). */
  heartbeat: HOUR,
  /** Two connection tests at least this far apart. */
  testCooldown: 10 * SECOND,
  /** The configuration could not be read from Gladys: next tries (the last one repeats). */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE, 5 * MINUTE],
  /** A write of /data is waited for this long at most on the path of a read. */
  saveWait: 5 * SECOND,
  /** /data unreadable: read again this often, and give up keeping it after this many tries. */
  dataRetry: 10 * SECOND,
  dataTries: 6,
};
