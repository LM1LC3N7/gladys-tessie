// -----------------------------------------------------------------------------
// The app end to end: the SDK's fake Gladys, a scripted Tessie API and a
// virtual clock (testClock: every read moves 1 µs, timers fire in order).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import {
  CONFIG,
  DEVICE,
  F,
  HOUR,
  MINUTE,
  SECOND,
  START,
  TOKEN,
  VIN,
  VIN2,
  advance,
  createTessie,
  createdCar,
  json,
  pidOf,
  settle,
  setup,
  statesOf,
  within,
} from './helpers/app.js';
import { testClock } from './helpers/clock.js';

const reads = (tessie) => tessie.count('GET', '/vehicles');
const locks = (tessie) => tessie.requests.filter((r) => r.method === 'POST').length;
const lockedFeature = (gladys) =>
  gladys.fake.devices[0].features.find((f) => f.external_id === F('locked'));

async function stopAll(t, ctx) {
  t.after(async () => {
    await ctx.app.stop();
  });
  return ctx;
}

test('first read: Discovery, fresh states as new, status; the token only in the header', async (t) => {
  const { gladys, tessie } = await stopAll(t, await setup());
  assert.equal(reads(tessie), 1);
  const [req] = tessie.requests;
  assert.equal(req.query.only_active, 'true');
  assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
  assert.match(
    req.headers['user-agent'],
    /^gladys-tessie\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-tessie\)$/,
  );
  assert.equal(req.headers.accept, 'application/json');
  assert.equal(req.redirect, 'manual');
  assert.ok(!req.url.includes(TOKEN));
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE());
  assert.ok(!JSON.stringify(device).includes(VIN), 'never the VIN');
  assert.equal(device.name, 'Seneca');
  assert.equal(gladys.fake.lastState(F('battery_level')), 89);
  assert.equal(gladys.fake.lastState(F('rated_range')), 432.9); // 269.01 mi
  assert.equal(gladys.fake.lastState(F('odometer')), 22686.1);
  assert.equal(gladys.fake.lastState(F('locked')), 1);
  assert.equal(gladys.fake.lastState(F('doors_open')), 0);
  assert.equal(gladys.fake.lastState(F('tyre_front_right')), 2.88);
  assert.equal(gladys.fake.lastState(F('charging_state')), 4);
  assert.equal(gladys.fake.lastState(F('plugged_in')), 1);
  assert.equal(gladys.fake.lastState(F('state')), 'online');
  assert.ok(
    gladys.fake.states.every((s) => s.created_at === undefined),
    'fresh: as new',
  );
  assert.equal(statesOf(gladys, F('position')).length, 0, 'position off by default');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /1 vehicle/);
});

test('never faster than the interval; the next read one interval after the start of the last', async (t) => {
  const { tessie, clock, gladys } = await stopAll(
    t,
    await setup({ config: { ...CONFIG, poll_interval: 120 } }),
  );
  await advance(clock, 2 * MINUTE - SECOND);
  assert.equal(reads(tessie), 1);
  await advance(clock, SECOND);
  assert.equal(reads(tessie), 2);
  const gap = tessie.requests[1].at - tessie.requests[0].at;
  assert.ok(gap >= 2 * MINUTE && gap < 2 * MINUTE + 1, `${gap}`);
  // Scan, Gladys reconnecting, the same config saved again: no read sooner.
  await gladys.fake.scanRequest();
  await gladys.fake.configUpdated({ ...CONFIG, poll_interval: 120 });
  await gladys.disconnect();
  await gladys.connect();
  await advance(clock, MINUTE);
  assert.equal(reads(tessie), 2);
  await advance(clock, MINUTE);
  assert.equal(reads(tessie), 3);
});

test('the interval is bounded: 10 s typed reads every minute', async (t) => {
  const { tessie, clock } = await stopAll(
    t,
    await setup({ config: { ...CONFIG, poll_interval: 10 } }),
  );
  await advance(clock, 59 * SECOND);
  assert.equal(reads(tessie), 1);
  await advance(clock, SECOND);
  assert.equal(reads(tessie), 2);
});

test('a section already published is not published again; a changed value is', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.ts[VIN] = START - SECOND;
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  const first = gladys.fake.states.length;
  assert.ok(first > 20);
  await advance(clock, 5 * MINUTE);
  assert.equal(gladys.fake.states.length, first, 'same timestamps: nothing');
  tessie.ts[VIN] = START + 5 * MINUTE;
  tessie.over[VIN] = { charge: { battery_level: 70 } };
  await advance(clock, 5 * MINUTE);
  const added = gladys.fake.states.slice(first);
  assert.deepEqual(
    added.map((s) => s.device_feature_external_id),
    [F('battery_level')],
    'only the changed value',
  );
});

test('freshness against the Date of Tessie: old values dated, very old ones never published', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.ts[VIN] = START - 30 * MINUTE;
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  const battery = statesOf(gladys, F('battery_level'));
  assert.equal(battery.length, 1);
  assert.equal(battery[0].created_at, new Date(START - 30 * MINUTE).toISOString());
  assert.equal(statesOf(gladys, F('position')).length, 0);
  // Older than 2 h: nothing.
  const clock2 = testClock({ start: START });
  const tessie2 = createTessie(clock2);
  tessie2.ts[VIN] = START - 3 * HOUR;
  const second = await stopAll(t, await setup({ clock: clock2, tessie: tessie2 }));
  assert.deepEqual(
    second.gladys.fake.states.map((s) => s.device_feature_external_id),
    [F('state')],
    'only the current state (online/asleep), never the 3 h old values',
  );
});

test('our clock far off is not used: freshness is read against the Date header', async (t) => {
  // Our wall clock 1 day ahead; Tessie's Date and timestamps agree: fresh.
  const clock = testClock({ start: START + 24 * HOUR });
  const tessie = createTessie(clock);
  tessie.fetch = ((inner) => async (url, init) => {
    const res = await inner(url, init);
    if (init.method === 'GET') {
      const body = await res.json();
      return json(body, { date: START });
    }
    return res;
  })(tessie.fetch);
  tessie.ts[VIN] = START - MINUTE;
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  assert.equal(gladys.fake.lastState(F('battery_level')), 89);
  assert.ok(statesOf(gladys, F('battery_level')).every((s) => s.created_at === undefined));
});

test('without a Date header, values are published dated, never dropped as stale', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) =>
    req.path === '/vehicles'
      ? json({ results: [createVehicle(START - 5 * HOUR)] }, { date: null })
      : undefined;
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  const battery = statesOf(gladys, F('battery_level'));
  assert.equal(battery.length, 1);
  assert.equal(battery[0].created_at, new Date(START - 5 * HOUR).toISOString());
});

function createVehicle(ts, over = {}) {
  return {
    vin: VIN,
    last_state: {
      state: 'asleep',
      display_name: 'Seneca',
      charge_state: { timestamp: ts, battery_level: 55, ...over },
    },
  };
}

test('unknown is never 0: null, text and out-of-range values publish nothing', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.over[VIN] = {
    charge: {
      battery_level: null,
      battery_range: '269',
      charger_power: 'Aus',
      charge_limit_soc: 150,
    },
    climate: { inside_temp: '', outside_temp: null },
    vstate: { locked: 'true', tpms_pressure_fl: 0, tpms_pressure_fr: 'string', df: null },
  };
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  for (const key of [
    'battery_level',
    'rated_range',
    'charger_power',
    'charge_limit',
    'inside_temperature',
    'outside_temperature',
    'locked',
    'tyre_front_left',
    'tyre_front_right',
    'doors_open',
  ]) {
    assert.equal(statesOf(gladys, F(key)).length, 0, key);
  }
  assert.equal(gladys.fake.lastState(F('usable_battery_level')), 88);
});

test('a door open is open even when another is unknown; the odometer never goes down', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.over[VIN] = { vstate: { df: null, pr: 1, odometer: 1000 } };
  const { gladys } = await stopAll(
    t,
    await setup({ clock, tessie, devices: [createdCar({ odometer: 2000 })] }),
  );
  assert.equal(gladys.fake.lastState(F('doors_open')), 1);
  assert.equal(statesOf(gladys, F('odometer')).length, 0, '1609 km < 2000 km known by Gladys');
});

test('states only for the devices the user created; a creation replays the known values, dated', async (t) => {
  const { gladys, clock } = await stopAll(t, await setup({ devices: [] }));
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  await advance(clock, MINUTE);
  await gladys.fake.deviceCreated(createdCar());
  await settle(20);
  const battery = statesOf(gladys, F('battery_level'));
  assert.equal(battery.length, 1);
  assert.equal(battery[0].created_at, new Date(START).toISOString(), 'dated: starts no scene');
  assert.equal(statesOf(gladys, F('state')).length, 0, 'a text is not replayed');
});

test('401 on /vehicles: refused, persisted, no try until a new token or the test button', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) =>
    req.path === '/vehicles' ? json({}, { status: 401, date: clock.now() }) : undefined;
  const store = memoryStore();
  const { gladys, app } = await setup({ clock, tessie, store });
  assert.equal(reads(tessie), 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the token \(401\)/);
  await advance(clock, 6 * HOUR);
  assert.equal(reads(tessie), 1, 'never tried again by itself');
  assert.match(store.data.refused.fp, /^[0-9a-f]{2}$/);
  assert.ok(!JSON.stringify(store.data).includes(TOKEN));
  await app.stop();

  // Restart, same token: still stopped. Another token: tried.
  const again = await setup({ clock, tessie, store });
  await advance(clock, 10 * MINUTE);
  assert.equal(reads(tessie), 1);
  await again.app.stop();
  tessie.on = () => undefined;
  const other = await setup({ clock, tessie, store, config: { api_token: 'another-token-123' } });
  t.after(() => other.app.stop());
  assert.equal(reads(tessie), 2);
  assert.equal(store.data.refused, undefined, 'erased at the success');
});

test('a new token saved while refused is tried at once; the old answer is dropped', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) =>
    req.headers.authorization === `Bearer ${TOKEN}`
      ? json({}, { status: 403, date: clock.now() })
      : undefined;
  const { gladys, app } = await stopAll(t, await setup({ clock, tessie }));
  assert.match(gladys.fake.connectionStatus.message.en, /refused/);
  await gladys.fake.configUpdated({ api_token: 'new-token-abc' });
  await advance(clock, 0);
  assert.equal(reads(tessie), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(app.memory.refused, undefined);
});

test('the test button lifts a refusal on success; cooldown of 10 s', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  let refuse = true;
  tessie.on = (req) =>
    refuse && req.path === '/vehicles' ? json({}, { status: 401, date: clock.now() }) : undefined;
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  await advance(clock, 20 * SECOND);
  let answer = await gladys.fake.action('test_connection', {});
  assert.match(answer.data.message.en, /refused the token \(401\)/);
  answer = await gladys.fake.action('test_connection', {});
  assert.match(answer.data.message.en, /try again in 10 s/);
  assert.equal(reads(tessie), 2);
  refuse = false;
  await advance(clock, 10 * SECOND);
  answer = await gladys.fake.action('test_connection', {});
  assert.match(answer.data.message.en, /1 vehicle/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // The reads go on by themselves again.
  await advance(clock, 5 * MINUTE);
  assert.equal(reads(tessie), 4);
});

test('429 with Retry-After: paused that long (persisted), whatever the restarts', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) =>
    req.path === '/vehicles' && reads(tessie) === 1
      ? json({}, { status: 429, date: clock.now(), headers: { 'retry-after': '1800' } })
      : undefined;
  const store = memoryStore();
  const first = await setup({ clock, tessie, store });
  assert.match(first.gladys.fake.connectionStatus.message.en, /\(429\).*30 min/);
  assert.equal(store.data.pause.status, 429);
  await advance(clock, 10 * MINUTE);
  await first.app.stop();
  const second = await setup({ clock, tessie, store });
  t.after(() => second.app.stop());
  const answer = await second.gladys.fake.action('test_connection', {});
  assert.match(answer.data.message.en, /asked to wait/);
  await advance(clock, 20 * MINUTE - 2 * SECOND);
  assert.equal(reads(tessie), 1);
  await advance(clock, 3 * SECOND);
  assert.equal(reads(tessie), 2);
  assert.equal(store.data.pause, undefined);
});

test('5xx: a pause of at least a minute, growing; a huge Retry-After is capped to 6 h', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) =>
    req.path === '/vehicles' ? json({}, { status: 503, date: clock.now() }) : undefined;
  const { app } = await stopAll(t, await setup({ clock, tessie }));
  await advance(clock, MINUTE - SECOND);
  assert.equal(reads(tessie), 1);
  await advance(clock, 2 * SECOND);
  assert.equal(reads(tessie), 2);
  await advance(clock, 2 * MINUTE + SECOND);
  assert.equal(reads(tessie), 3);
  tessie.on = (req) =>
    req.path === '/vehicles'
      ? json({}, { status: 429, date: clock.now(), headers: { 'retry-after': '999999' } })
      : undefined;
  await advance(clock, 4 * MINUTE + SECOND);
  assert.equal(reads(tessie), 4);
  assert.ok(app.pauseUntil - clock.monotonic() <= TIMINGS.pauseMax);
});

test('network failure and timeout: tried again later, status says so; a hung read is cut', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) => (req.path === '/vehicles' ? 'hang' : undefined);
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  await advance(clock, TIMINGS.readTimeout);
  assert.match(gladys.fake.connectionStatus.message.en, /could not be read \(timeout\)/);
  tessie.on = () =>
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  await advance(clock, 5 * MINUTE);
  assert.match(gladys.fake.connectionStatus.message.en, /\(network\)/);
  tessie.on = () => undefined;
  await advance(clock, 10 * MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an oversized or unreadable answer is not read; a redirect is not followed', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  const big = JSON.stringify({ results: [], pad: 'x'.repeat(1024 * 1024 + 10) });
  tessie.on = () =>
    new Response(big, { status: 200, headers: { date: new Date(clock.now()).toUTCString() } });
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  assert.match(gladys.fake.connectionStatus.message.en, /\(invalid\)/);
  tessie.on = () =>
    new Response('', {
      status: 302,
      headers: { location: 'https://evil.example/', date: new Date(clock.now()).toUTCString() },
    });
  await advance(clock, 10 * MINUTE);
  assert.match(gladys.fake.connectionStatus.message.en, /HTTP 302/);
  tessie.on = () => json({ nope: 1 }, { date: clock.now() });
  await advance(clock, 20 * MINUTE);
  assert.match(gladys.fake.connectionStatus.message.en, /\(invalid\)/);
});

test('the token never appears in logs, status, /data nor Discovery', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  let n = 0;
  tessie.on = () => {
    n += 1;
    return n === 1 ? json({}, { status: 401, date: clock.now() }) : undefined;
  };
  const store = memoryStore();
  const { gladys, logger } = await stopAll(t, await setup({ clock, tessie, store }));
  await gladys.fake.action('test_connection', {});
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await advance(clock, MINUTE);
  const everything = JSON.stringify([
    logger.lines,
    gladys.fake.connectionStatuses,
    store.data,
    gladys.fake.discoveredDevices,
    gladys.fake.states,
  ]);
  assert.ok(!everything.includes(TOKEN));
  assert.ok(!everything.includes(VIN), 'nor the VIN');
});

test('no token or a bad one: nothing sent, the status says so', async (t) => {
  const a = await stopAll(t, await setup({ config: {} }));
  assert.equal(a.tessie.requests.length, 0);
  assert.match(a.gladys.fake.connectionStatus.message.en, /Type your Tessie access token/);
  const b = await stopAll(t, await setup({ config: { api_token: 'abc\r\nX-Evil: 1' } }));
  assert.equal(b.tessie.requests.length, 0);
  assert.match(b.gladys.fake.connectionStatus.message.en, /not valid/);
});

test('getConfig failing in connected: tried again, spaced, without end; then the reads start', async (t) => {
  let fails = 3;
  const { gladys, tessie, clock } = await stopAll(
    t,
    await setup({
      getConfig: (original) => (fails-- > 0 ? Promise.reject(new Error('503')) : original()),
    }),
  );
  assert.equal(reads(tessie), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /configuration could not be read/);
  await advance(clock, 5 * SECOND);
  await advance(clock, 15 * SECOND);
  assert.equal(reads(tessie), 0);
  await advance(clock, MINUTE);
  assert.equal(reads(tessie), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('/data unreadable: no read (a refusal may be in it), tried every 10 s, one read at a time', async (t) => {
  const store = memoryStore({ refused: { fp: '00' } }, { unreadable: true });
  const { gladys, tessie, clock } = await stopAll(t, await setup({ store }));
  assert.equal(reads(tessie), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /\/data folder cannot be read/);
  await advance(clock, 10 * SECOND);
  assert.equal(store.loads, 2);
  assert.equal(store.saves, 0, 'never written over while unreadable');
  store.unreadable = false;
  await advance(clock, 10 * SECOND);
  assert.equal(reads(tessie), 1);
});

test('/data unreadable for long: still no read, no Discovery, never a new identity', async (t) => {
  const store = memoryStore(null, { unreadable: true });
  const { gladys, tessie, clock } = await stopAll(t, await setup({ store }));
  await advance(clock, 5 * MINUTE);
  assert.equal(reads(tessie), 0);
  assert.equal(store.saves, 0);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /\/data folder cannot be read/);
});

test('S10: /data readable but not writable from the first start: the reads go on, the status says so', async (t) => {
  const store = memoryStore(null, { failing: true });
  const { gladys, tessie, clock } = await stopAll(t, await setup({ store }));
  assert.equal(reads(tessie), 1);
  assert.equal(gladys.fake.lastState(F('battery_level')), 89);
  assert.match(gladys.fake.connectionStatus.message.en, /\/data folder cannot be written/);
  assert.equal(gladys.fake.config.tessie_id_key, '07'.repeat(32), 'the key kept in Gladys');
  await advance(clock, 5 * MINUTE);
  assert.equal(reads(tessie), 2);
});

test('S7: restart with /data unreadable: the key comes from Gladys, the lock goes at once', async (t) => {
  const store = memoryStore(null, { unreadable: true });
  const config = { ...CONFIG, tessie_id_key: '07'.repeat(32) };
  const { gladys, tessie } = await stopAll(t, await setup({ store, config }));
  assert.equal(reads(tessie), 0, 'no read while /data is unreadable');
  const ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(ack.success, true);
  assert.equal(locks(tessie), 1);
});

test('S9: /data lost, the key in Gladys: the same devices, states and lock', async (t) => {
  const config = { ...CONFIG, tessie_id_key: '07'.repeat(32) };
  const ctx = await stopAll(
    t,
    await setup({ store: memoryStore(), config, random: (n) => Buffer.alloc(n, 9) }),
  );
  assert.equal(ctx.gladys.fake.discoveredDevices[0].external_id, DEVICE());
  assert.equal(ctx.gladys.fake.lastState(F('battery_level')), 89);
  assert.equal(ctx.store.data.idKey, '07'.repeat(32));
  const ack = await ctx.gladys.fake.setValue(
    ctx.gladys.fake.devices[0],
    lockedFeature(ctx.gladys),
    1,
  );
  assert.equal(ack.success, true);
});

test('S9b: both copies of the key lost, one car and one device: the lock still goes', async (t) => {
  const ctx = await stopAll(
    t,
    await setup({ store: memoryStore(), random: (n) => Buffer.alloc(n, 9) }),
  );
  assert.notEqual(ctx.gladys.fake.discoveredDevices[0].external_id, DEVICE(), 'new ids');
  const ack = await ctx.gladys.fake.setValue(
    ctx.gladys.fake.devices[0],
    lockedFeature(ctx.gladys),
    1,
  );
  assert.equal(ack.success, true);
  assert.equal(locks(ctx.tessie), 1);
});

test('a slow /data never holds a read nor a lock', async (t) => {
  const store = memoryStore();
  const { gladys, tessie, clock } = await stopAll(t, await setup({ store }));
  store.save = () => new Promise(() => {});
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(locks(tessie), 1);
  await advance(clock, 5 * MINUTE + 10 * SECOND);
  assert.ok(reads(tessie) >= 3);
  store.save = async () => {};
});

test('position: off by default; on, rounded to 3 decimals; off again, erased', async (t) => {
  const config = { ...CONFIG, publish_position: true };
  const { gladys, clock } = await stopAll(
    t,
    await setup({ config, devices: [createdCar({ config })] }),
  );
  assert.equal(gladys.fake.lastState(F('position')), '48.858, 2.294');
  const discovered = gladys.fake.discoveredDevices[0].features.map((f) => f.external_id);
  assert.ok(discovered.includes(F('position')));
  await gladys.fake.configUpdated({ ...CONFIG, publish_position: false });
  await settle(20);
  assert.equal(gladys.fake.lastState(F('position')), '');
  assert.ok(
    !gladys.fake.discoveredDevices[0].features.some((f) => f.external_id === F('position')),
  );
  await advance(clock, 10 * MINUTE);
  assert.equal(gladys.fake.lastState(F('position')), '');
});

test('the navigation, speed and heading are never read', async (t) => {
  const { gladys } = await stopAll(t, await setup());
  const text = JSON.stringify([gladys.fake.states, gladys.fake.discoveredDevices]);
  assert.ok(!text.includes('Work'));
  assert.ok(!text.includes('speed'));
});

test('the budget of 250 states a minute holds with ten cars', async (t) => {
  const vins = Array.from({ length: 10 }, (_, i) => `5YJ3E7EB0KF1234${String(i).padStart(2, '0')}`);
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.vehicles = vins;
  const { gladys } = await stopAll(
    t,
    await setup({ clock, tessie, devices: vins.map((vin) => createdCar({ vin })) }),
  );
  assert.ok(gladys.fake.states.length <= 250, `${gladys.fake.states.length}`);
  assert.ok(gladys.fake.states.length > 200);
  await advance(clock, 5 * MINUTE);
  // The cars left out get their values at the next read (sections not marked).
  const cars = new Set(gladys.fake.states.map((s) => s.device_feature_external_id.split(':')[3]));
  assert.equal(cars.size, 10);
});

test('more than 10 cars: the first 10 followed, the status says how many are left out', async (t) => {
  const vins = Array.from({ length: 12 }, (_, i) => `5YJ3E7EB0KF1234${String(i).padStart(2, '0')}`);
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.vehicles = vins;
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  assert.equal(gladys.fake.discoveredDevices.length, 10);
  assert.match(gladys.fake.connectionStatus.message.en, /10 vehicle\(s\), 2 more ignored/);
});

// ---------------------------------------------------------------------------- lock

test('lock: sent at once, acked to Gladys, then two follow-up reads', async (t) => {
  const { gladys, tessie, clock } = await stopAll(t, await setup());
  const ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(ack.success, true);
  const post = tessie.requests.find((r) => r.method === 'POST');
  assert.equal(post.path, `/${VIN}/command/lock`);
  assert.equal(post.query.wait_for_completion, 'true');
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(reads(tessie), 1);
  await advance(clock, 5 * SECOND);
  assert.equal(reads(tessie), 2);
  await advance(clock, 15 * SECOND);
  assert.equal(reads(tessie), 3);
  assert.equal(locks(tessie), 1, 'confirmed: never sent again');
});

test('unlock and the other features are refused: nothing sent', async (t) => {
  const { gladys, tessie } = await stopAll(t, await setup());
  const before = tessie.requests.length;
  const ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Unlocking is not available/);
  const climate = gladys.fake.devices[0].features.find((f) => f.external_id === F('climate_on'));
  const other = await gladys.fake.setValue(gladys.fake.devices[0], climate, 1);
  assert.equal(other.success, false);
  assert.equal(tessie.requests.length, before);
});

test('lock goes during a 429 pause, with the car never read, and past a hung read', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) =>
    req.path === '/vehicles' && reads(tessie) === 1
      ? json({}, { status: 429, date: clock.now(), headers: { 'retry-after': '3600' } })
      : undefined;
  const { gladys, app } = await stopAll(t, await setup({ clock, tessie }));
  assert.ok(app.pauseUntil > clock.monotonic());
  // The car was never read (paused at the first read): looked up, then locked.
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(locks(tessie), 1);
  // A read hanging: the lock does not wait for it.
  tessie.on = (req) => (req.path === '/vehicles' ? 'hang' : undefined);
  app.pauseUntil = undefined;
  app.poll('test', { test: true });
  await settle(5);
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(locks(tessie), 2);
  await advance(clock, MINUTE);
});

test('lock goes with the token refused for the reads', async (t) => {
  const salt = '07'.repeat(16);
  const fp = createHmac('sha256', salt).update(TOKEN).digest('hex').slice(0, 2);
  const store = memoryStore({ salt, refused: { fp, status: 401 } });
  const { gladys, tessie } = await stopAll(t, await setup({ store }));
  assert.equal(reads(tessie), 0, 'refused: no read');
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(locks(tessie), 1);
});

test('lock answered late: Gladys acked within 3.5 s, the answer handled behind', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  let release;
  tessie.lockAnswer = () =>
    new Promise((resolve) => {
      release = () => resolve(json({ result: true }, { date: clock.now() }));
    });
  const { gladys, logger } = await stopAll(t, await setup({ clock, tessie }));
  const pending = gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await settle(10);
  await clock.advance(TIMINGS.lockAck);
  const ack = await within(pending, 2000);
  assert.equal(ack.success, false, 'never a success without confirmation');
  assert.match(ack.error, /sent, no confirmation yet/);
  assert.ok(TIMINGS.lockAck <= 3500);
  release();
  await settle(20);
  assert.ok(logger.lines.some((l) => /Lock of car .*: confirmed/.test(l)));
});

test('lock: retried after a 503 or result false, 3 tries at most, never after a 4xx', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.over[VIN] = { vstate: { locked: false } };
  tessie.lockAnswer = () => json({}, { status: 503, date: clock.now() });
  const { gladys, logger } = await stopAll(t, await setup({ clock, tessie }));
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(locks(tessie), 1);
  tessie.lockAnswer = () => json({ result: false }, { date: clock.now() });
  await advance(clock, 10 * SECOND);
  assert.equal(locks(tessie), 2);
  await advance(clock, 30 * SECOND);
  assert.equal(locks(tessie), 3);
  await advance(clock, 5 * MINUTE);
  assert.equal(locks(tessie), 3);
  assert.ok(logger.lines.some((l) => /notConfirmed/.test(l)));
  // A 403 on the command: not retried, and the reads go on.
  tessie.lockAnswer = () => json({}, { status: 403, date: clock.now() });
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await advance(clock, 2 * MINUTE);
  assert.equal(locks(tessie), 4);
  const r = reads(tessie);
  await advance(clock, 5 * MINUTE);
  assert.ok(reads(tessie) > r, '403 on a command never stops the reads');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('lock not confirmed but a later read shows the car locked: no more tries', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.over[VIN] = { vstate: { locked: false } };
  tessie.lockAnswer = () => {
    tessie.over[VIN] = { vstate: { locked: true } };
    return json({ result: false }, { date: clock.now() });
  };
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  await advance(clock, SECOND);
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await advance(clock, 5 * SECOND);
  assert.equal(gladys.fake.lastState(F('locked')), 1);
  await advance(clock, MINUTE);
  assert.equal(locks(tessie), 1);
});

test('lock kept in /data: a restart sends it again (3 tries in all), within its window', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.lockAnswer = () => 'hang';
  tessie.on = (req) => (req.method === 'POST' ? 'hang' : undefined);
  const store = memoryStore();
  const first = await setup({ clock, tessie, store });
  const press = first.gladys.fake.setValue(
    first.gladys.fake.devices[0],
    lockedFeature(first.gladys),
    1,
  );
  await settle(10);
  await clock.advance(TIMINGS.lockAck);
  await within(press, 2000);
  assert.equal(store.data.locks[pidOf()].attempts, 1);
  await first.app.stop();
  tessie.on = () => undefined;
  tessie.lockAnswer = () => json({ result: true }, { date: clock.now() });
  await advance(clock, 30 * SECOND);
  const second = await setup({ clock, tessie, store });
  t.after(() => second.app.stop());
  await settle(20);
  assert.equal(locks(tessie), 2);
  assert.equal(store.data.locks[pidOf()], undefined);
  // Past its window, a lock in /data is not sent.
  store.data.locks = { [pidOf()]: { until: clock.now() + MINUTE, attempts: 0 } };
  await second.app.stop();
  await advance(clock, 2 * MINUTE);
  const third = await setup({ clock, tessie, store });
  t.after(() => third.app.stop());
  assert.equal(locks(tessie), 2);
});

test('lock with the configuration not read yet: sent as soon as it is read', async (t) => {
  let fails = 2;
  const { gladys, tessie, clock } = await stopAll(
    t,
    await setup({
      getConfig: (original) => (fails-- > 0 ? Promise.reject(new Error('503')) : original()),
    }),
  );
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(locks(tessie), 0);
  await advance(clock, 15 * SECOND);
  assert.equal(locks(tessie), 1);
});

test('lock with a failing /data save: still sent', async (t) => {
  const store = memoryStore();
  const { gladys, tessie } = await stopAll(t, await setup({ store }));
  store.failing = true;
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(locks(tessie), 1);
});

test('lock of a car no longer in the account: refused, nothing sent', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.vehicles = [VIN2];
  const config = { ...CONFIG, tessie_id_key: '07'.repeat(32) };
  const { gladys } = await stopAll(t, await setup({ clock, tessie, config }));
  const ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(ack.success, false);
  assert.equal(locks(tessie), 0);
});

test('two clicks while a lock is running: one command', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) => (req.method === 'POST' ? 'hang' : undefined);
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  const a = gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  const b = gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await clock.advance(TIMINGS.lockAck);
  await within(Promise.all([a, b]), 2000);
  assert.equal(locks(tessie), 1);
  await advance(clock, TIMINGS.lockTimeout);
});

test('stop: nothing runs after it', async () => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.lockAnswer = () => json({}, { status: 503, date: clock.now() });
  const { gladys, app } = await setup({ clock, tessie });
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await app.stop();
  assert.equal(clock.pending, 0);
  const count = tessie.requests.length;
  await advance(clock, HOUR);
  assert.equal(tessie.requests.length, count);
});

test('Gladys reconnecting: status and Discovery sent again, nothing republished as new', async (t) => {
  const { gladys, tessie } = await stopAll(t, await setup());
  const statuses = gladys.fake.connectionStatuses.length;
  const states = gladys.fake.states.length;
  const discoveries = gladys.fake.requests.filter((r) => r.path.includes('discover')).length;
  await gladys.disconnect();
  await gladys.connect();
  await settle(20);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.states.length, states);
  assert.ok(gladys.fake.requests.filter((r) => r.path.includes('discover')).length > discoveries);
  assert.equal(reads(tessie), 1);
});

test('lock not confirmed: a read as old as the request, or equal to the state before, ends nothing', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.ts[VIN] = START;
  tessie.over[VIN] = { vstate: { locked: false } };
  tessie.lockAnswer = () => {
    // Shown locked, but with the timestamp of before the request.
    tessie.over[VIN] = { vstate: { locked: true } };
    return json({ result: false }, { date: clock.now() });
  };
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await advance(clock, 2 * MINUTE);
  assert.equal(locks(tessie), 3);
  // Locked before the request: a newer read showing locked is "not yet applied".
  const clock2 = testClock({ start: START });
  const tessie2 = createTessie(clock2);
  tessie2.lockAnswer = () => json({ result: false }, { date: clock2.now() });
  const second = await stopAll(t, await setup({ clock: clock2, tessie: tessie2 }));
  await second.gladys.fake.setValue(second.gladys.fake.devices[0], lockedFeature(second.gladys), 1);
  await advance(clock2, 2 * MINUTE);
  assert.equal(locks(tessie2), 3);
});

test('a restart right after a read never reads sooner than the interval', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  const store = memoryStore();
  const first = await setup({ clock, tessie, store });
  await advance(clock, MINUTE);
  await first.app.stop();
  const second = await stopAll(t, await setup({ clock, tessie, store }));
  assert.equal(reads(tessie), 1);
  await advance(clock, 4 * MINUTE - SECOND);
  assert.equal(reads(tessie), 1);
  await advance(clock, 2 * SECOND);
  assert.equal(reads(tessie), 2);
  assert.ok(second);
});

test('the follow-up reads of a lock respect a refused token and a pause', async (t) => {
  const salt = '07'.repeat(16);
  const fp = createHmac('sha256', salt).update(TOKEN).digest('hex').slice(0, 2);
  const refused = await stopAll(
    t,
    await setup({ store: memoryStore({ salt, refused: { fp, status: 401 } }) }),
  );
  await refused.gladys.fake.setValue(
    refused.gladys.fake.devices[0],
    lockedFeature(refused.gladys),
    1,
  );
  const afterLookUp = reads(refused.tessie);
  await advance(refused.clock, 30 * SECOND);
  assert.equal(reads(refused.tessie), afterLookUp, 'no read while refused');

  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.on = (req) =>
    req.path === '/vehicles' && reads(tessie) === 1
      ? json({}, { status: 429, date: clock.now(), headers: { 'retry-after': '3600' } })
      : undefined;
  const paused = await stopAll(t, await setup({ clock, tessie }));
  await paused.gladys.fake.setValue(paused.gladys.fake.devices[0], lockedFeature(paused.gladys), 1);
  const count = reads(tessie);
  await advance(clock, 30 * SECOND);
  assert.equal(reads(tessie), count, 'no read during the pause');
});

test('a dated section is published once; a timestamp after the Date of Tessie is not published', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.ts[VIN] = START - 30 * MINUTE;
  const config = { ...CONFIG, publish_position: true };
  const { gladys } = await stopAll(
    t,
    await setup({ clock, tessie, config, devices: [createdCar({ config })] }),
  );
  const count = gladys.fake.states.length;
  assert.equal(statesOf(gladys, F('position')).length, 0, 'a text is never published old');
  await advance(clock, 5 * MINUTE);
  assert.equal(gladys.fake.states.length, count, 'the same dated values not sent again');
  tessie.ts[VIN] = START + HOUR;
  await advance(clock, 5 * MINUTE);
  assert.equal(gladys.fake.states.length, count, 'from the future: not published');
});

test('a new token saved is tried even when its fingerprint matches the refused one', async (t) => {
  const salt = '07'.repeat(16);
  const fpOf = (token) => createHmac('sha256', salt).update(token).digest('hex').slice(0, 2);
  const fp = fpOf(TOKEN);
  let other;
  for (let i = 0; ; i += 1) {
    if (fpOf(`other-token-${i}`) === fp) {
      other = `other-token-${i}`;
      break;
    }
  }
  const { gladys, tessie, clock } = await stopAll(
    t,
    await setup({ store: memoryStore({ salt, refused: { fp, status: 401 } }) }),
  );
  assert.equal(reads(tessie), 0);
  await gladys.fake.configUpdated({ api_token: other });
  await advance(clock, 0);
  assert.equal(reads(tessie), 1);
});

test('S1: lock asked during the first read, car shown locked 20 min ago: the POST goes, no read proves it', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.ts[VIN] = START - 20 * MINUTE;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  tessie.on = async (req) => {
    if (req.method === 'GET') await gate;
    return undefined;
  };
  tessie.lockAnswer = () => json({ result: false }, { date: clock.now() });
  const { gladys, logger } = await stopAll(t, await setup({ clock, tessie }));
  const press = gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await settle(10);
  release();
  await settle(20);
  await clock.advance(TIMINGS.lockAck);
  const ack = await within(press, 2000);
  assert.equal(ack.success, false);
  assert.equal(locks(tessie), 1, 'the POST went');
  await advance(clock, 2 * MINUTE);
  assert.equal(locks(tessie), 3, 'an old read never ends the tries');
  assert.ok(!logger.lines.some((l) => /confirmedByRead/.test(l)));
});

test('S2: restart with a lock in /data, car shown locked before: sent again, never ended by that read', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.ts[VIN] = START - 20 * MINUTE;
  tessie.lockAnswer = () => json({ result: false }, { date: clock.now() });
  const store = memoryStore({
    idKey: '07'.repeat(32),
    locks: { [pidOf()]: { until: START + 2 * MINUTE, attempts: 1 } },
  });
  const { logger } = await stopAll(t, await setup({ clock, tessie, store }));
  await advance(clock, 2 * MINUTE);
  assert.equal(locks(tessie), 2, '2 more tries: 3 in all');
  assert.ok(!logger.lines.some((l) => /confirmedByRead/.test(l)));
  assert.equal(store.data.locks[pidOf()], undefined);
});

test('a VIN that is not 17 plain characters is ignored: no device, no command', async (t) => {
  const bad = [
    '//evil.example/x',
    '5YJ3E7EB0KF12345/',
    '../5YJ3E7EB0KF1234',
    '5YJ3E7EB0KF1234567',
    '5yj3e7eb0kf123456',
    `${VIN}\n`,
    `x${VIN}`,
  ];
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.vehicles = bad;
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  const ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(ack.success, false);
  assert.equal(locks(tessie), 0);
  assert.ok(tessie.requests.every((r) => new URL(r.url).host === 'api.tessie.com'));
});

test('lock: a 429 Retry-After is waited for; beyond the window, the tries end at once', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.over[VIN] = { vstate: { locked: false } };
  tessie.lockAnswer = () =>
    json({}, { status: 429, date: clock.now(), headers: { 'retry-after': '25' } });
  const store = memoryStore();
  const { gladys } = await stopAll(t, await setup({ clock, tessie, store }));
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await advance(clock, 24 * SECOND);
  assert.equal(locks(tessie), 1, 'not before 25 s');
  await advance(clock, 2 * SECOND);
  assert.equal(locks(tessie), 2);
  tessie.lockAnswer = () =>
    json({}, { status: 429, date: clock.now(), headers: { 'retry-after': '600' } });
  await advance(clock, 60 * SECOND);
  assert.equal(locks(tessie), 3);
  await advance(clock, SECOND);
  // 3 tries used anyway; a fresh lock with a Retry-After past its window ends at once.
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  await advance(clock, SECOND);
  assert.equal(store.data.locks[pidOf()], undefined, 'ended at once, not kept 3 minutes');
  await advance(clock, 5 * MINUTE);
  assert.equal(locks(tessie), 4);
});

test('lock: 409 is passing (tried again), 403 ends it; the error reaches Gladys', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.over[VIN] = { vstate: { locked: false } };
  tessie.lockAnswer = () => json({}, { status: 409, date: clock.now() });
  const { gladys } = await stopAll(t, await setup({ clock, tessie }));
  let ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.match(ack.error, /Lock sent, not confirmed by the car: tried again/);
  await advance(clock, 11 * SECOND);
  assert.equal(locks(tessie), 2);
  await advance(clock, 5 * MINUTE);
  tessie.lockAnswer = () => json({}, { status: 403, date: clock.now() });
  ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.match(ack.error, /Tessie refused the lock \(403\)/);
  const n = locks(tessie);
  await advance(clock, 2 * MINUTE);
  assert.equal(locks(tessie), n);
});

test('lock waiting for a token: ended at its window, removed from /data', async (t) => {
  const store = memoryStore();
  const { gladys, clock, tessie } = await stopAll(t, await setup({ config: {}, store }));
  const ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.match(ack.error, /Nothing sent yet/);
  assert.ok(store.data.locks[pidOf()]);
  await advance(clock, TIMINGS.lockWindow + SECOND);
  assert.equal(store.data.locks[pidOf()], undefined);
  assert.equal(tessie.requests.length, 0);
});

test('lock asked before /data is read: sent at once, kept in /data once read', async (t) => {
  const store = memoryStore({ idKey: '07'.repeat(32) }, { unreadable: true });
  const { gladys, clock, tessie } = await stopAll(t, await setup({ store }));
  const ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(locks(tessie), 1, 'never waits for /data');
  assert.equal(ack.success, true);
  tessie.lockAnswer = () => json({ result: false }, { date: clock.now() });
  await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  store.unreadable = false;
  await advance(clock, 10 * SECOND);
  assert.ok(store.data.locks[pidOf()], 'the pending lock written to /data');
});

test('stop with a lock in flight: the request is aborted, no timer left', async () => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  let aborted = false;
  tessie.on = (req) => {
    if (req.method !== 'POST') return undefined;
    return new Promise((_, reject) => {
      tessie.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  };
  const inner = tessie.fetch;
  tessie.fetch = (url, init) => {
    tessie.signal = init.signal;
    return inner(url, init);
  };
  const { gladys, app, logger } = await setup({ clock, tessie });
  gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1).catch(() => {});
  await settle(10);
  await app.stop();
  await settle(20);
  assert.ok(aborted);
  assert.equal(clock.pending, 0);
  assert.ok(!logger.lines.some((l) => /no confirmation/.test(l)));
});

test('stop while the answer of the lock is being read: no follow-up timer, no log', async () => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  let app;
  tessie.lockAnswer = () => {
    const bytes = new TextEncoder().encode('{"result": false}');
    let sent = false;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(bytes);
            return;
          }
          await app.stop();
          controller.close();
        },
      }),
      { status: 200, headers: { date: new Date(clock.now()).toUTCString() } },
    );
  };
  const ctx = await setup({ clock, tessie });
  app = ctx.app;
  ctx.gladys.fake
    .setValue(ctx.gladys.fake.devices[0], lockedFeature(ctx.gladys), 1)
    .catch(() => {});
  await settle(40);
  assert.equal(locks(tessie), 1);
  assert.equal(clock.pending, 0);
  assert.ok(!ctx.logger.lines.some((l) => /not confirmed by the car/.test(l)));
});

test('S7b: /data unreadable, key in Gladys, two cars: the lock of the second goes to that car', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.vehicles = [VIN, VIN2];
  const store = memoryStore(null, { unreadable: true });
  const config = { ...CONFIG, tessie_id_key: '07'.repeat(32) };
  const devices = [createdCar(), createdCar({ vin: VIN2 })];
  const { gladys } = await stopAll(t, await setup({ clock, tessie, store, config, devices }));
  assert.equal(reads(tessie), 0);
  const second = gladys.fake.devices.find((d) => d.external_id === DEVICE(VIN2));
  const feature = second.features.find((f) => f.external_id === F('locked', VIN2));
  const ack = await gladys.fake.setValue(second, feature, 1);
  assert.equal(ack.success, true);
  const posts = tessie.requests.filter((r) => r.method === 'POST');
  assert.deepEqual(
    posts.map((r) => r.path),
    [`/${VIN2}/command/lock`],
  );
});

test('S9d: /data unreadable, key in Gladys, the only car of the account is another one: refused, nothing sent', async (t) => {
  const clock = testClock({ start: START });
  const tessie = createTessie(clock);
  tessie.vehicles = [VIN2];
  const store = memoryStore(null, { unreadable: true });
  const config = { ...CONFIG, tessie_id_key: '07'.repeat(32) };
  const { gladys } = await stopAll(t, await setup({ clock, tessie, store, config }));
  const ack = await gladys.fake.setValue(gladys.fake.devices[0], lockedFeature(gladys), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /not in the Tessie account: nothing sent/);
  assert.equal(locks(tessie), 0);
});
