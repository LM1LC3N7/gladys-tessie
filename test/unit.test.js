// -----------------------------------------------------------------------------
// The pieces alone: configuration, reading of a vehicle, /data, the client.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, parseVehicle, platformId, roundedPosition } from '../src/car.js';
import { normalizeConfig } from '../src/config.js';
import { HOUR, MINUTE, TIMINGS } from '../src/constants.js';
import { memoryStore, normalizeMemory, serializeMemory } from '../src/store.js';
import { TessieError, parseRetryAfter, tessieRequest } from '../src/tessie.js';
import { ID_KEY, START, VIN, vehicle } from './helpers/app.js';
import { testClock } from './helpers/clock.js';

const config = normalizeConfig({ api_token: 'x' });

test('configuration: token checked, interval bounded, position off by default', () => {
  assert.equal(normalizeConfig({}).problem, 'noToken');
  assert.equal(normalizeConfig({ api_token: '   ' }).problem, 'noToken');
  for (const bad of ['a b', 'a\nb', 'a\rb', 'a b', 'x'.repeat(513)]) {
    const c = normalizeConfig({ api_token: bad });
    assert.equal(c.problem, 'badToken', JSON.stringify(bad).slice(0, 20));
    assert.equal(c.token, '');
  }
  const c = normalizeConfig({ api_token: ' tok ' });
  assert.equal(c.token, 'tok');
  assert.equal(c.publishPosition, false);
  assert.equal(c.interval, 5 * MINUTE);
  assert.equal(normalizeConfig({ api_token: 't', poll_interval: 5 }).interval, MINUTE);
  assert.equal(normalizeConfig({ api_token: 't', poll_interval: 99999 }).interval, HOUR);
  assert.equal(normalizeConfig({ api_token: 't', poll_interval: '' }).interval, 5 * MINUTE);
  assert.equal(normalizeConfig({ api_token: 't', poll_interval: 'abc' }).interval, 5 * MINUTE);
  assert.equal(normalizeConfig({ api_token: 't', poll_interval: '120' }).interval, 2 * MINUTE);
  assert.equal(normalizeConfig({ api_token: 't', publish_position: 'true' }).publishPosition, true);
  assert.equal(normalizeConfig({ api_token: 't', language: 'de' }).language, 'fr');
});

test('a vehicle: strict values, sections dated, the VIN never in the id', () => {
  const v = parseVehicle(vehicle({ ts: START }), config);
  assert.equal(v.vin, VIN);
  assert.equal(v.model, 'Model 3');
  assert.equal(v.sections.charge.ts, START);
  assert.deepEqual(v.sections.charge.values.battery_level, { state: 89 });
  assert.deepEqual(v.top.values.state, { text: 'online' });
  assert.equal(v.sections.drive.values.position, undefined, 'position off');
  const pid = platformId(ID_KEY, VIN);
  assert.match(pid, /^[0-9a-f]{16}$/);
  assert.notEqual(pid, platformId('08'.repeat(32), VIN), 'keyed by the random key of /data');
  assert.equal(parseVehicle({ vin: 'short', last_state: {} }, config), undefined);
  assert.equal(parseVehicle({ vin: 'IIIIIIIIIIIIIIIII', last_state: {} }, config), undefined);
  assert.equal(parseVehicle({ vin: '../../x/command/u', last_state: {} }, config), undefined);
  // A section without a valid timestamp is not read.
  const noTs = parseVehicle(vehicle({ ts: '1643590652755' }), config);
  assert.deepEqual(noTs.sections, {});
});

test('values: numbers strict, booleans strict, ranges, units converted', () => {
  const read = (key, raw, section = {}) => FEATURES[key].read({ ...section, ...raw });
  assert.equal(read('battery_level', { battery_level: 89.5 }), undefined);
  assert.equal(read('battery_level', { battery_level: '89' }), undefined);
  assert.equal(read('battery_level', { battery_level: 101 }), undefined);
  assert.deepEqual(read('battery_level', { battery_level: 0 }), { state: 0 });
  assert.deepEqual(read('rated_range', { battery_range: 100 }), { state: 160.9 });
  assert.equal(read('rated_range', { battery_range: NaN }), undefined);
  assert.equal(read('locked', { locked: 1 }), undefined);
  assert.deepEqual(read('locked', { locked: false }), { state: 0 });
  assert.deepEqual(read('tyre_front_left', { tpms_pressure_fl: '2.875' }), { state: 2.88 });
  assert.equal(read('tyre_front_left', { tpms_pressure_fl: '' }), undefined);
  assert.equal(read('tyre_front_left', { tpms_pressure_fl: ' 2.8' }), undefined);
  assert.equal(read('windows_open', { fd_window: 0, fp_window: 0, rd_window: 0 }), undefined);
  assert.deepEqual(
    read('windows_open', { fd_window: 0, fp_window: 0, rd_window: 0, rp_window: 2 }),
    { state: 1 },
  );
  assert.equal(read('charging_state', { charging_state: 'toString' }), undefined);
  assert.equal(read('charging_state', { charging_state: '__proto__' }), undefined);
  assert.deepEqual(read('plugged_in', { charging_state: 'Disconnected' }), { state: 0 });
  assert.equal(read('state', { state: 'Online!' }), undefined);
  assert.equal(read('inside_temperature', { inside_temp: -61 }), undefined);
});

test('position: rounded to 3 decimals, (0, 0) and out of range unknown', () => {
  assert.deepEqual(roundedPosition({ latitude: 48.858372, longitude: 2.294481 }), {
    text: '48.858, 2.294',
  });
  assert.deepEqual(roundedPosition({ latitude: -0.0001, longitude: -0.0004 }), {
    text: '0.000, 0.000',
  });
  assert.equal(roundedPosition({ latitude: 0, longitude: 0 }), undefined);
  assert.equal(roundedPosition({ latitude: 91, longitude: 2 }), undefined);
  assert.equal(roundedPosition({ latitude: '48', longitude: 2 }), undefined);
  assert.equal(roundedPosition(null), undefined);
});

test('/data: bounded on reading, never a prototype key, a future date brought to now', () => {
  const now = START;
  const m = normalizeMemory(
    {
      salt: 'ab'.repeat(16),
      refused: { fp: 'zz' },
      pause: { until: now + 100 * HOUR, status: 503 },
      lastRead: now + HOUR,
      seen: JSON.parse(
        `{"__proto__": {"charge": 1}, "${'a'.repeat(16)}": {"charge": ${now}, "drive": ${now + HOUR}}}`,
      ),
      locks: {
        ['b'.repeat(16)]: { until: now + HOUR, attempts: 0 },
        ['c'.repeat(16)]: { until: now + MINUTE, attempts: 1 },
      },
    },
    now,
  );
  assert.equal(m.refused, undefined);
  assert.equal(m.pause.until, now + TIMINGS.pauseMax);
  assert.equal(m.pause.status, 503);
  assert.equal(m.lastRead, now);
  assert.deepEqual(m.seen, { ['a'.repeat(16)]: { charge: now } });
  assert.deepEqual(m.locks, { ['c'.repeat(16)]: { until: now + MINUTE, attempts: 1 } });
  assert.equal(
    normalizeMemory({ refused: { fp: 'ab' } }, now).refused,
    undefined,
    'no salt, no refusal',
  );
  const used = normalizeMemory(
    { locks: { ['d'.repeat(16)]: { until: now + MINUTE, attempts: 3 } } },
    now,
  );
  assert.deepEqual(used.locks, {}, 'a lock with its 3 tries used is never sent again');
  assert.equal(normalizeMemory({ idKey: 'ab' }, now).idKey, undefined);
  assert.equal(normalizeMemory({ idKey: 'ab'.repeat(32) }, now).idKey, 'ab'.repeat(32));
  const empty = normalizeMemory(null, now);
  assert.deepEqual(serializeMemory({ ...empty, salt: 'x' }), { salt: 'x', seen: {}, locks: {} });
});

test('memoryStore: unreadable rejects, failing save rejects', async () => {
  await assert.rejects(memoryStore(null, { unreadable: true }).load());
  await assert.rejects(memoryStore(null, { failing: true }).save({}));
});

test('Retry-After: seconds or a date against the answer Date', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter(new Date(START + MINUTE).toUTCString(), START), MINUTE);
  assert.equal(parseRetryAfter('soon', START), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
});

const realTimers = { setTimeout, clearTimeout };

test('client: a body over the limit is cut before the end, never parsed', async () => {
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (pulled > 1000) controller.close();
    },
  });
  const fetch = async () => new Response(stream, { status: 200 });
  await assert.rejects(
    tessieRequest({
      fetch,
      timers: realTimers,
      token: 't',
      path: '/vehicles',
      timeout: 5000,
      maxBytes: 256 * 1024,
    }),
    (err) => err instanceof TessieError && err.kind === 'invalid',
  );
  assert.ok(pulled < 20, `${pulled} chunks read`);
});

test('client: errors carry a kind and a status, never the token', async () => {
  const token = 'SECRET-123';
  const cases = [
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate'],
    [500, 'server'],
    [404, 'client'],
    [302, 'client'],
  ];
  for (const [status, kind] of cases) {
    const fetch = async () => new Response('{}', { status, headers: { 'retry-after': '7' } });
    await assert.rejects(
      tessieRequest({ fetch, timers: realTimers, token, path: '/vehicles', timeout: 5000 }),
      (err) =>
        err.kind === kind &&
        err.status === status &&
        !err.message.includes(token) &&
        (status !== 429 || err.retryAfter === 7000),
    );
  }
  const refused = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(
    tessieRequest({ fetch: refused, timers: realTimers, token, path: '/x', timeout: 5000 }),
    (err) => err.kind === 'network' && err.sent === false,
  );
});

test('client: the timeout cuts a hung exchange, even mid-body', async () => {
  const clock = testClock();
  const fetch = (url, init) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"results":'));
            init.signal.addEventListener('abort', () =>
              c.error(new DOMException('aborted', 'AbortError')),
            );
          },
        }),
        { status: 200 },
      ),
    );
  const pending = tessieRequest({
    fetch,
    timers: clock.timers,
    token: 't',
    path: '/vehicles',
    timeout: 1000,
  });
  const checked = assert.rejects(pending, (err) => err.kind === 'timeout');
  await clock.advance(1000);
  await checked;
});
