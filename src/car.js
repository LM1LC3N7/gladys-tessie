// -----------------------------------------------------------------------------
// A vehicle of the Tessie account, as Gladys sees it: which field of Tessie's
// documented vehicle state (developer.tessie.com, "Get Vehicles") feeds which
// feature, how it is read, and the device built from it.
//
// Written from Tessie's public API documentation only. Every value is
// checked strictly: a number must be a finite JSON number (or, for the tyre
// pressures typed "string" in the docs, a strict decimal text), a boolean a
// JSON boolean; anything else, null or out of range is UNKNOWN (nothing
// published, the last value stays), never 0.
//
// Each feature belongs to one section of the state (charge_state,
// climate_state, vehicle_state, drive_state): the section's `timestamp`
// (ms) dates its values (src/app.js decides on it).
//
// Never read: the VIN (only an HMAC of it, keyed by a random key kept in
// /data, is the platform id; the VIN stays in memory to address the
// commands), the navigation (active_route_*), speed, heading, shift state,
// the user id. The position is read only when the configuration allows it,
// rounded to POSITION_DECIMALS before anything keeps it.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, KM_PER_MILE, LIMITS, POSITION_DECIMALS } from './constants.js';
import { FEATURE_NAMES } from './i18n.js';

/** Gladys' charging-station charging states (OCPP values, server/utils/constants.js). */
export const CHARGING = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
};

/** Tesla `charging_state` -> Gladys charging state, and whether the cable is in. */
const CHARGING_STATES = {
  Charging: [CHARGING.CHARGING, 1],
  Starting: [CHARGING.EV_CONNECTED, 1],
  Stopped: [CHARGING.PAUSED_BY_VEHICLE, 1],
  NoPower: [CHARGING.PAUSED_BY_CHARGER, 1],
  Complete: [CHARGING.IDLE, 1],
  Disconnected: [CHARGING.IDLE, 0],
};

/** A VIN: 17 characters, no I, O nor Q (it goes in the path of the commands). */
export const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const round = (value, decimals) => {
  const factor = 10 ** decimals;
  const r = Math.round(value * factor) / factor;
  return Object.is(r, -0) ? 0 : r;
};

const number =
  ({ min, max, decimals = 2, factor = 1 }) =>
  (raw) => {
    const value = finite(raw);
    if (value === undefined) return undefined;
    const converted = value * factor;
    return converted < min || converted > max ? undefined : { state: round(converted, decimals) };
  };

const integer =
  ({ min, max }) =>
  (raw) =>
    Number.isInteger(raw) && raw >= min && raw <= max ? { state: raw } : undefined;

const boolean = (raw) => (raw === true ? { state: 1 } : raw === false ? { state: 0 } : undefined);

/** A door, trunk or window: an integer, 0 closed, anything else open. */
const opening = (raw) => (Number.isInteger(raw) && raw >= 0 ? raw !== 0 : undefined);

/** Several openings: open if one is, closed if all are known closed, unknown otherwise. */
const anyOpen = (keys) => (section) => {
  const states = keys.map((k) => opening(own(section, k)));
  if (states.includes(true)) return { state: 1 };
  return states.every((s) => s === false) ? { state: 0 } : undefined;
};

/** A tyre pressure in bar: a JSON number, or a strict decimal text (typed "string" in the docs). */
const pressure = (raw) => {
  const value =
    typeof raw === 'string' && /^\d{1,2}(\.\d{1,6})?$/.test(raw) ? Number(raw) : finite(raw);
  // 0 is "no sensor reading", not a flat tyre.
  return value === undefined || value <= 0 || value > 10 ? undefined : { state: round(value, 2) };
};

const charging = (raw) =>
  typeof raw === 'string' && Object.hasOwn(CHARGING_STATES, raw)
    ? { state: CHARGING_STATES[raw][0] }
    : undefined;

const plugged = (raw) =>
  typeof raw === 'string' && Object.hasOwn(CHARGING_STATES, raw)
    ? { state: CHARGING_STATES[raw][1] }
    : undefined;

/** latitude / longitude of drive_state -> "48.857, 2.352" (rounded), or unknown. */
export function roundedPosition(section) {
  const lat = finite(own(section, 'latitude'));
  const lon = finite(own(section, 'longitude'));
  if (
    lat === undefined ||
    lon === undefined ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (lat === 0 && lon === 0)
  ) {
    return undefined;
  }
  const r = (v) => round(v, POSITION_DECIMALS).toFixed(POSITION_DECIMALS);
  return { text: `${r(lat)}, ${r(lon)}` };
}

const field = (name, parse) => (section) => parse(own(section, name));

const feature = (
  section,
  read,
  category,
  type,
  { unit, min = 0, max = 1, kind = 'binary', option, writable } = {},
) => ({
  section,
  read,
  category,
  type,
  unit,
  min,
  max,
  kind,
  option,
  writable: writable === true,
});

/**
 * Feature key (frozen, part of the external id) -> its section, its reader
 * (section object -> { state } | { text } | undefined), its Gladys
 * category/type/unit. `kind`: 'measurement', 'binary', 'enum', 'text',
 * 'counter' (never decreasing). `option`: the configuration switch it needs.
 */
export const FEATURES = {
  battery_level: feature(
    'charge',
    field('battery_level', integer({ min: 0, max: 100 })),
    C.ELECTRICAL_VEHICLE_BATTERY,
    T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL,
    { unit: U.PERCENT, max: 100, kind: 'measurement' },
  ),
  usable_battery_level: feature(
    'charge',
    field('usable_battery_level', integer({ min: 0, max: 100 })),
    C.ELECTRICAL_VEHICLE_BATTERY,
    T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL,
    { unit: U.PERCENT, max: 100, kind: 'measurement' },
  ),
  rated_range: feature(
    'charge',
    field('battery_range', number({ min: 0, max: 2000, decimals: 1, factor: KM_PER_MILE })),
    C.ELECTRICAL_VEHICLE_BATTERY,
    T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_RANGE_ESTIMATE,
    { unit: U.KM, max: 2000, kind: 'measurement' },
  ),
  estimated_range: feature(
    'charge',
    field('est_battery_range', number({ min: 0, max: 2000, decimals: 1, factor: KM_PER_MILE })),
    C.ELECTRICAL_VEHICLE_BATTERY,
    T.ELECTRICAL_VEHICLE_BATTERY.BATTERY_RANGE_ESTIMATE,
    { unit: U.KM, max: 2000, kind: 'measurement' },
  ),
  charging_state: feature(
    'charge',
    field('charging_state', charging),
    C.CHARGING_STATION,
    T.CHARGING_STATION.CHARGING_STATE,
    { max: 5, kind: 'enum' },
  ),
  plugged_in: feature(
    'charge',
    field('charging_state', plugged),
    C.ELECTRICAL_VEHICLE_CHARGE,
    T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
  ),
  charger_power: feature(
    'charge',
    field('charger_power', number({ min: 0, max: 400, decimals: 1 })),
    C.ELECTRICAL_VEHICLE_CHARGE,
    T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_POWER,
    { unit: U.KILOWATT, max: 400, kind: 'measurement' },
  ),
  charger_current: feature(
    'charge',
    field('charger_actual_current', number({ min: 0, max: 1000, decimals: 1 })),
    C.ELECTRICAL_VEHICLE_CHARGE,
    T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_CURRENT,
    { unit: U.AMPERE, max: 1000, kind: 'measurement' },
  ),
  charger_voltage: feature(
    'charge',
    field('charger_voltage', number({ min: 0, max: 1000, decimals: 0 })),
    C.ELECTRICAL_VEHICLE_CHARGE,
    T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_VOLTAGE,
    { unit: U.VOLT, max: 1000, kind: 'measurement' },
  ),
  charge_energy_added: feature(
    'charge',
    field('charge_energy_added', number({ min: 0, max: 500, decimals: 2 })),
    C.ELECTRICAL_VEHICLE_CHARGE,
    T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    { unit: U.KILOWATT_HOUR, max: 500, kind: 'measurement' },
  ),
  charge_limit: feature(
    'charge',
    field('charge_limit_soc', integer({ min: 0, max: 100 })),
    C.ELECTRICAL_VEHICLE_CHARGE,
    T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CHARGE_LIMIT,
    { unit: U.PERCENT, max: 100, kind: 'measurement' },
  ),
  inside_temperature: feature(
    'climate',
    field('inside_temp', number({ min: -60, max: 100, decimals: 1 })),
    C.ELECTRICAL_VEHICLE_CLIMATE,
    T.ELECTRICAL_VEHICLE_CLIMATE.INDOOR_TEMPERATURE,
    { unit: U.CELSIUS, min: -60, max: 100, kind: 'measurement' },
  ),
  outside_temperature: feature(
    'climate',
    field('outside_temp', number({ min: -60, max: 70, decimals: 1 })),
    C.TEMPERATURE_SENSOR,
    T.SENSOR.DECIMAL,
    { unit: U.CELSIUS, min: -60, max: 70, kind: 'measurement' },
  ),
  climate_on: feature(
    'climate',
    field('is_climate_on', boolean),
    C.ELECTRICAL_VEHICLE_CLIMATE,
    T.ELECTRICAL_VEHICLE_CLIMATE.CLIMATE_ON,
  ),
  odometer: feature(
    'vehicle',
    field('odometer', number({ min: 0, max: 5_000_000, decimals: 1, factor: KM_PER_MILE })),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.ODOMETER,
    { unit: U.KM, max: 5_000_000, kind: 'counter' },
  ),
  locked: feature(
    'vehicle',
    field('locked', boolean),
    C.ELECTRICAL_VEHICLE_COMMAND,
    T.ELECTRICAL_VEHICLE_COMMAND.LOCK,
    { writable: true },
  ),
  sentry_mode: feature(
    'vehicle',
    field('sentry_mode', boolean),
    C.ELECTRICAL_VEHICLE_COMMAND,
    T.ELECTRICAL_VEHICLE_COMMAND.ALARM,
  ),
  doors_open: feature(
    'vehicle',
    anyOpen(['df', 'dr', 'pf', 'pr']),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.DOOR_OPENED,
  ),
  trunk_open: feature(
    'vehicle',
    anyOpen(['rt']),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.DOOR_OPENED,
  ),
  frunk_open: feature(
    'vehicle',
    anyOpen(['ft']),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.DOOR_OPENED,
  ),
  windows_open: feature(
    'vehicle',
    anyOpen(['fd_window', 'fp_window', 'rd_window', 'rp_window']),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.WINDOW_OPENED,
  ),
  tyre_front_left: feature(
    'vehicle',
    field('tpms_pressure_fl', pressure),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.TIRE_PRESSURE,
    { unit: U.BAR, max: 10, kind: 'measurement' },
  ),
  tyre_front_right: feature(
    'vehicle',
    field('tpms_pressure_fr', pressure),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.TIRE_PRESSURE,
    { unit: U.BAR, max: 10, kind: 'measurement' },
  ),
  tyre_rear_left: feature(
    'vehicle',
    field('tpms_pressure_rl', pressure),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.TIRE_PRESSURE,
    { unit: U.BAR, max: 10, kind: 'measurement' },
  ),
  tyre_rear_right: feature(
    'vehicle',
    field('tpms_pressure_rr', pressure),
    C.ELECTRICAL_VEHICLE_STATE,
    T.ELECTRICAL_VEHICLE_STATE.TIRE_PRESSURE,
    { unit: U.BAR, max: 10, kind: 'measurement' },
  ),
  state: feature(
    'top',
    field('state', (raw) =>
      typeof raw === 'string' && /^[a-z_]{2,20}$/.test(raw) ? { text: raw } : undefined,
    ),
    C.TEXT,
    T.TEXT.TEXT,
    { kind: 'text' },
  ),
  position: feature('drive', roundedPosition, C.TEXT, T.TEXT.TEXT, {
    kind: 'text',
    option: 'publishPosition',
  }),
};

export const FEATURE_KEYS = Object.keys(FEATURES);

/** The dated sections of a state, and the Tesla object each one reads. */
export const SECTIONS = {
  charge: 'charge_state',
  climate: 'climate_state',
  vehicle: 'vehicle_state',
  drive: 'drive_state',
};

/** Whether a feature may be read and published with this configuration. */
export const allowed = (key, config) => {
  const option = FEATURES[key]?.option;
  return option === undefined || config[option] === true;
};

/**
 * The platform id of a car: 16 hex of an HMAC-SHA256 of the VIN keyed by a
 * random 32-byte key made once and kept in /data (`idKey`): the VIN cannot be
 * found back from the id without that key. Losing /data only renames the cars.
 */
export const platformId = (idKey, vin) =>
  createHmac('sha256', Buffer.from(idKey, 'hex')).update(vin).digest('hex').slice(0, 16);

/** A section timestamp: integer ms after 2015, or undefined. */
const timestamp = (raw) => (Number.isInteger(raw) && raw > 1_420_000_000_000 ? raw : undefined);

const shortText = (raw) => {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value === '' || value.length > LIMITS.text || CONTROL.test(value) ? undefined : value;
};

const MODELS = {
  models: 'Model S',
  model3: 'Model 3',
  modelx: 'Model X',
  modely: 'Model Y',
  cybertruck: 'Cybertruck',
};

/**
 * One entry of GET /vehicles -> { vin, name, model, top, sections } or
 * undefined (no valid VIN). `sections[key]` = { ts, values: { feature: value } }
 * for each section with a valid timestamp; `top` = { values } (the state).
 */
export function parseVehicle(entry, config) {
  const state = own(entry, 'last_state');
  const vin = own(entry, 'vin');
  if (typeof vin !== 'string' || !VIN.test(vin) || !isObject(state)) {
    return undefined;
  }
  const name =
    shortText(own(state, 'display_name')) ??
    shortText(own(own(state, 'vehicle_state'), 'vehicle_name'));
  const carType = own(own(state, 'vehicle_config'), 'car_type');
  const model =
    typeof carType === 'string' && Object.hasOwn(MODELS, carType) ? MODELS[carType] : undefined;
  const sections = {};
  for (const [key, field] of Object.entries(SECTIONS)) {
    const section = own(state, field);
    const ts = timestamp(own(section, 'timestamp'));
    if (ts !== undefined) {
      sections[key] = { ts, values: {} };
    }
  }
  const top = { values: {} };
  for (const key of FEATURE_KEYS) {
    const f = FEATURES[key];
    if (!allowed(key, config)) continue;
    if (f.section === 'top') {
      const value = f.read(state);
      if (value) top.values[key] = value;
    } else if (sections[f.section]) {
      const value = f.read(own(state, SECTIONS[f.section]));
      if (value) sections[f.section].values[key] = value;
    }
  }
  return { vin, name, model, top, sections };
}

/** The Gladys device of a car (every feature the configuration allows), names in its language. */
export function buildDevice(gladys, { id, name, model }, config) {
  const ids = gladys.externalIds(DEVICE_TYPE, id);
  const names = FEATURE_NAMES[config.language === 'en' ? 'en' : 'fr'];
  return {
    name: name || 'Tesla',
    external_id: ids.device,
    model: model ? `Tesla ${model}` : 'Tesla',
    should_poll: false,
    params: model ? [{ name: 'TESSIE_MODEL', value: model }] : [],
    features: FEATURE_KEYS.filter((key) => allowed(key, config)).map((key) => {
      const f = FEATURES[key];
      return {
        name: names[key],
        external_id: ids.feature(key),
        category: f.category,
        type: f.type,
        ...(f.unit ? { unit: f.unit } : {}),
        min: f.min,
        max: f.max,
        read_only: !f.writable,
        has_feedback: f.writable,
        keep_history: f.kind !== 'text',
      };
    }),
  };
}
