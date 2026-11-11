// The app against the SDK's fake Gladys, a scripted Tessie API and a virtual clock.

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TessieApp } from '../../src/app.js';
import { buildDevice, platformId } from '../../src/car.js';
import { normalizeConfig } from '../../src/config.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { settle, testClock } from './clock.js';

export { settle };

export const SELECTOR = 'test-integration';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const TOKEN = 'tSs-S3cr3t-T0ken-0123456789abcdef';
export const VIN = '5YJ3E7EB0KF123456';
export const VIN2 = '7SAYGDEE9PF654321';
export const START = Date.parse('2026-03-01T12:00:00Z');
export const CONFIG = { api_token: TOKEN };
/** The id key the app makes with the test `random` (bytes of 7). */
export const ID_KEY = '07'.repeat(32);
export const pidOf = (vin = VIN) => platformId(ID_KEY, vin);
export const DEVICE = (vin = VIN) => `ext:${SELECTOR}:car:${pidOf(vin)}`;
export const F = (key, vin = VIN) => `${DEVICE(vin)}:${key}`;

/** One entry of GET /vehicles, shaped like Tessie's documented example; every section dated `ts`. */
export function vehicle({
  vin = VIN,
  ts,
  name = 'Seneca',
  charge = {},
  climate = {},
  vstate = {},
  drive = {},
  top = {},
} = {}) {
  return {
    vin,
    is_active: true,
    last_state: {
      id: 1492931520123456,
      vin,
      state: 'online',
      display_name: name,
      vehicle_config: { car_type: 'model3' },
      ...top,
      drive_state: {
        timestamp: ts,
        latitude: 48.858372,
        longitude: 2.294481,
        speed: 12,
        heading: 194,
        active_route_destination: 'Work',
        ...drive,
      },
      charge_state: {
        timestamp: ts,
        battery_level: 89,
        usable_battery_level: 88,
        battery_range: 269.01,
        est_battery_range: 223.25,
        charging_state: 'Complete',
        charger_power: 0,
        charger_actual_current: 0,
        charger_voltage: 2,
        charge_energy_added: 4.64,
        charge_limit_soc: 90,
        ...charge,
      },
      climate_state: {
        timestamp: ts,
        inside_temp: 24.3,
        outside_temp: 17.5,
        is_climate_on: false,
        ...climate,
      },
      vehicle_state: {
        timestamp: ts,
        df: 0,
        dr: 0,
        pf: 0,
        pr: 0,
        ft: 0,
        rt: 0,
        fd_window: 0,
        fp_window: 0,
        rd_window: 0,
        rp_window: 0,
        locked: true,
        sentry_mode: false,
        odometer: 14096.485641,
        tpms_pressure_fl: 2.9,
        tpms_pressure_fr: 2.875,
        tpms_pressure_rl: 2.9,
        tpms_pressure_rr: 2.85,
        ...vstate,
      },
    },
  };
}

export const json = (body, { status = 200, date, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(date === null ? {} : { date: new Date(date).toUTCString() }),
      ...headers,
    },
  });

/**
 * The Tessie API: `tessie.vehicles` (entries, re-dated at each read unless
 * `frozen`), `tessie.on(req)` may return a Response, 'hang' (never answers,
 * aborted by the app's timeout), an Error (thrown by fetch) or undefined
 * (the default answer). `requests` records every call.
 */
export function createTessie(clock) {
  const tessie = {
    requests: [],
    vehicles: [VIN],
    /** Per VIN: the section timestamp (ms) served; default: the time of the read. */
    ts: {},
    over: {},
    lockAnswer: () => json({ result: true }, { date: clock.now() }),
    on: () => undefined,
    count(method, path) {
      return this.requests.filter(
        (r) => r.method === method && (path === undefined || r.path === path),
      ).length;
    },
  };
  tessie.fetch = async (url, init) => {
    const u = new URL(url);
    const req = {
      method: init.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      url: String(url),
      headers: init.headers,
      redirect: init.redirect,
      at: clock.monotonic(),
    };
    tessie.requests.push(req);
    const special = await tessie.on(req);
    if (special === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    if (special instanceof Error) throw special;
    if (special) return special;
    if (req.method === 'GET' && req.path === '/vehicles') {
      const now = clock.now();
      return json(
        {
          results: tessie.vehicles.map((vin) =>
            vehicle({ vin, ts: tessie.ts[vin] ?? Math.floor(now), ...(tessie.over[vin] ?? {}) }),
          ),
        },
        { date: now },
      );
    }
    if (req.method === 'POST' && /^\/[A-Z0-9]{17}\/command\/lock$/.test(req.path)) {
      return tessie.lockAnswer(req);
    }
    return json({ error: 'not found' }, { status: 404, date: clock.now() });
  };
  return tessie;
}

export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(
        `${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`,
      );
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child() {
      return this;
    },
  };
}

/** A created device of a car, as Gladys keeps it (`odometer`: its last value). */
export function createdCar({ vin = VIN, config = CONFIG, odometer } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(
    gladys,
    { id: pidOf(vin), name: 'Seneca', model: 'Model 3' },
    normalizeConfig(config),
  );
  device.id = `id-${vin}`;
  if (odometer !== undefined) {
    const f = device.features.find((x) => x.external_id.endsWith(':odometer'));
    f.last_value = odometer;
  }
  return device;
}

export async function setup({
  config = CONFIG,
  devices = [createdCar()],
  store = memoryStore(),
  clock = testClock({ start: START }),
  start = true,
  getConfig,
  tessie,
} = {}) {
  const logger = memoryLogger();
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices, logger });
  if (getConfig) {
    const original = gladys.getConfig.bind(gladys);
    // The SDK's own read at connect() passes; the app's reads go through `getConfig`.
    let first = true;
    gladys.getConfig = () => {
      if (first) {
        first = false;
        return original();
      }
      return getConfig(original);
    };
  }
  tessie ??= createTessie(clock);
  const app = new TessieApp({
    gladys,
    store,
    logger,
    fetch: tessie.fetch,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    random: (n) => Buffer.alloc(n, 7),
  });
  registerHandlers(gladys, app, logger);
  gladys.handleShutdown(() => app.stop());
  if (start) {
    await gladys.connect();
    await clock.advance(0);
    await settle(20);
  }
  return { gladys, app, clock, tessie, store, logger };
}

/** Advances the virtual clock, letting the promises run. */
export async function advance(clock, ms) {
  await clock.advance(ms);
  await settle(20);
  // What the callbacks scheduled for "now" runs too.
  await clock.advance(0);
  await settle(20);
}

/** Every state published for a feature. */
export const statesOf = (gladys, id) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === id);

/** Rejects after `ms` of real time: a test fails, never hangs. */
export function within(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
