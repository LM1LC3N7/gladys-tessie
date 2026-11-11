// -----------------------------------------------------------------------------
// The integration: reads the vehicles of the Tessie account (GET /vehicles,
// Tessie's latest known state, which never wakes a car), publishes them to
// Gladys, and locks a car on demand (the only command of v1).
//
// Two clocks: `now` (wall clock) only for what /data keeps; `monotonic`
// paces the reads, the pauses, the lock window and the cooldowns, so that a
// wall clock set back or forward never stops nor hurries them. The freshness
// of a value compares Tessie's own timestamps to the Date of Tessie's answer
// (never to our clock); without a readable Date, a value is published dated,
// never dropped as stale.
//
// Lock (protective, never blocked): sent whatever the pause (429/5xx), a
// refused token, a read in flight, /data unreadable or a save failing; out
// of the read schedule. Tried 3 times at most within 3 minutes, kept in /data
// so a restart sends it again, done when the car confirms (`result: true`)
// or a read made after it shows the car locked. Unlock, trunks, charge port:
// not in v1 (refused, nothing sent).
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { logger as sdkLogger } from '@gladysassistant/integration-sdk';
import { FEATURES, SECTIONS, allowed, buildDevice, parseVehicle, platformId } from './car.js';
import { normalizeConfig, sameConfig } from './config.js';
import { DEVICE_TYPE, LIMITS, MINUTE, TIMINGS } from './constants.js';
import { LOCK, STATUS, TEST } from './i18n.js';
import { fileStore, normalizeMemory, serializeMemory } from './store.js';
import { TessieError, tessieRequest } from './tessie.js';

const SECTION_ORDER = Object.keys(SECTIONS);

export class TessieApp {
  constructor({
    gladys,
    store = fileStore(),
    fetch = globalThis.fetch,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = { setTimeout, clearTimeout },
    logger = sdkLogger,
    random = (n) => randomBytes(n),
  }) {
    this.gladys = gladys;
    this.store = store;
    this.fetch = fetch;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.logger = logger;
    this.random = random;

    /** Normalized configuration, undefined until read from Gladys. */
    this.config = undefined;
    /** /data content (normalized), undefined until read. */
    this.memory = undefined;
    this.dataBroken = false;
    this.dataTries = 0;
    this.dataLoading = false;
    this.configTries = 0;

    /** pid -> { pid, vin, name, model, snap, date }. */
    this.cars = new Map();
    /** External ids of the devices the user created. */
    this.created = new Set();
    /** Feature id -> { value, at (monotonic) } of the last undated publication. */
    this.published = new Map();
    /** Feature id -> highest odometer known (never published lower). */
    this.highest = new Map();
    /** Monotonic times of the states published in the last minute. */
    this.sent = [];

    this.pollTimer = undefined;
    this.configTimer = undefined;
    this.dataTimer = undefined;
    this.followUps = new Set();
    this.inFlight = undefined;
    this.failures = 0;
    this.lastReadMono = undefined;
    this.pauseUntil = undefined;
    this.lastTest = undefined;
    this.statusText = undefined;
    this.discovery = undefined;
    /** pid -> pending lock. */
    this.locks = new Map();
    this.generation = 0;
    this.stopped = false;
    /** Aborted at stop: every request in flight ends. */
    this.aborter = new AbortController();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Gladys connected (first time or again): configuration, /data, devices, then the reads. */
  async gladysConnected() {
    if (this.stopped) return;
    // A new connection: Gladys may have lost what it was sent; nothing is sent again as new.
    this.published.clear();
    this.statusText = undefined;
    this.discovery = undefined;
    await this.refreshCreated();
    if (!this.config) {
      await this.readConfig();
    }
    await this.loadData();
    if (this.cars.size > 0) {
      await this.publishDiscovery();
    }
    this.kick();
    // Gladys keeps the status in memory only: sent again on every connection.
    if (this.statusText === undefined && this.lastStatus) {
      await this.setStatus(this.lastStatus.key, this.lastStatus.params);
    }
  }

  async stop() {
    this.stopped = true;
    this.generation += 1;
    this.aborter.abort();
    for (const timer of [this.pollTimer, this.configTimer, this.dataTimer, ...this.followUps]) {
      this.timers.clearTimeout(timer);
    }
    this.followUps.clear();
    for (const entry of this.locks.values()) {
      this.timers.clearTimeout(entry.timer);
      entry.done = true;
    }
    // The pending locks stay in /data: a restart sends them again within their window.
    await this.bounded(this.saveMemory(), TIMINGS.saveWait);
  }

  async readConfig() {
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped) return false;
      this.logger.warn(
        `Configuration not read from Gladys (${err?.status ?? err?.code ?? 'error'})`,
      );
      await this.setStatus('configUnread');
      const delays = TIMINGS.configRetry;
      const delay = delays[Math.min(this.configTries, delays.length - 1)];
      this.configTries += 1;
      this.configTimer = this.timers.setTimeout(async () => {
        this.configTimer = undefined;
        if (await this.readConfig()) {
          await this.loadData();
          this.kick();
        }
      }, delay);
      return false;
    }
    if (this.stopped) return false;
    this.configTries = 0;
    await this.applyConfig(normalizeConfig(raw));
    return true;
  }

  async configUpdated(raw) {
    if (this.stopped) return;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    this.configTries = 0;
    await this.applyConfig(normalizeConfig(raw ?? (await this.gladys.getConfig())), {
      fromUser: true,
    });
    await this.loadData();
    this.kick();
  }

  async applyConfig(next, { fromUser = false } = {}) {
    const previous = this.config;
    this.config = next;
    if (previous && sameConfig(previous, next)) {
      // Saved again unchanged: no read sooner, no new status.
      return;
    }
    if (previous && previous.token !== next.token) {
      // A new token: the answers for the old one are dropped, it is tried at once.
      this.generation += 1;
      this.inFlight = undefined;
      this.lastReadMono = undefined;
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (fromUser && previous?.token !== next.token && this.memory?.refused) {
      this.memory.refused = undefined;
      await this.saveMemory();
    }
    if (previous && previous.publishPosition !== next.publishPosition) {
      await this.positionChanged(next.publishPosition);
    }
    if (
      previous &&
      (previous.language !== next.language || previous.publishPosition !== next.publishPosition)
    ) {
      await this.publishDiscovery();
    }
    if (previous && previous.interval !== next.interval) {
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.resumeLocks();
  }

  /** Position turned off: the value shown is erased; on: the next read publishes it. */
  async positionChanged(on) {
    for (const car of this.cars.values()) {
      if (this.memory?.seen[car.pid]) {
        delete this.memory.seen[car.pid].drive;
      }
      const ids = this.gladys.externalIds(DEVICE_TYPE, car.pid);
      if (!on && this.created.has(ids.device)) {
        try {
          await this.gladys.publishStates([
            { device_feature_external_id: ids.feature('position'), text: '' },
          ]);
        } catch (err) {
          this.logger.warn(`Position not erased (${err?.status ?? 'error'})`);
        }
      }
      this.published.delete(ids.feature('position'));
    }
  }

  async loadData() {
    if (this.memory || this.dataLoading || this.stopped) return;
    this.dataLoading = true;
    // One read of /data at a time: a slow one still running is waited for again, never doubled.
    if (!this.loadPromise) {
      const loading = this.store.load().then(
        (value) => ({ value }),
        () => ({ failed: true }),
      );
      this.loadPromise = loading;
      loading.then(() => {
        if (this.loadPromise === loading) this.loadPromise = undefined;
      });
    }
    // Slower than a few seconds is not "empty": tried again later.
    const result = await this.bounded(this.loadPromise, TIMINGS.saveWait);
    this.dataLoading = false;
    let raw = result?.value;
    const failed = !result || result.failed === true;
    if (this.stopped || this.memory) return;
    if (failed) {
      this.dataTries += 1;
      if (this.dataTries < TIMINGS.dataTries) {
        await this.setStatus('dataUnreadable');
        this.timers.clearTimeout(this.dataTimer);
        this.dataTimer = this.timers.setTimeout(async () => {
          this.dataTimer = undefined;
          await this.loadData();
          this.kick();
        }, TIMINGS.dataRetry);
        return;
      }
      // Unreadable for a minute: run without it, and never write over it.
      this.logger.warn('/data unreadable: running without the saved state, never writing over it');
      this.dataBroken = true;
      raw = null;
    }
    const wall = this.now();
    const mono = this.monotonic();
    const memory = normalizeMemory(raw, wall);
    memory.salt ??= this.random(16).toString('hex');
    this.memory = memory;
    if (memory.pause) {
      this.pauseUntil = mono + Math.min(memory.pause.until - wall, TIMINGS.pauseMax);
    }
    if (memory.lastRead !== undefined) {
      this.lastReadMono = mono - (wall - memory.lastRead);
    }
    for (const [pid, saved] of Object.entries(memory.locks)) {
      if (!this.locks.has(pid)) {
        this.startLock(pid, {
          untilMono: mono + (saved.until - wall),
          untilWall: saved.until,
          attempts: saved.attempts,
        });
      }
    }
  }

  saveMemory() {
    if (!this.memory || this.dataBroken) return Promise.resolve(false);
    return this.store.save(serializeMemory(this.memory)).then(
      () => true,
      (err) => {
        this.logger.warn(`/data not written (${err?.code ?? err?.message ?? 'error'})`);
        return false;
      },
    );
  }

  // ---------------------------------------------------------------- devices

  prefix() {
    return this.gladys.externalIds(DEVICE_TYPE, 'x').device.slice(0, -1);
  }

  async refreshCreated() {
    let devices;
    try {
      devices = await this.gladys.getDevices();
    } catch (err) {
      this.logger.warn(`Devices not read from Gladys (${err?.status ?? 'error'})`);
      return;
    }
    const prefix = this.prefix();
    this.created.clear();
    for (const device of devices ?? []) {
      this.deviceKnown(device, prefix);
    }
  }

  deviceKnown(device, prefix = this.prefix()) {
    if (typeof device?.external_id !== 'string' || !device.external_id.startsWith(prefix))
      return false;
    this.created.add(device.external_id);
    for (const f of device.features ?? []) {
      if (f?.external_id === `${device.external_id}:odometer`) {
        const value = Number(f.last_value);
        if (f.last_value !== null && f.last_value !== '' && Number.isFinite(value)) {
          this.highest.set(f.external_id, Math.max(this.highest.get(f.external_id) ?? 0, value));
        }
      }
    }
    return true;
  }

  /** A device created or updated by the user: its known values, dated, never as new. */
  async deviceCreated(device) {
    if (this.stopped || !this.deviceKnown(device)) return;
    const pid = device.external_id.slice(this.prefix().length);
    for (const key of Object.keys(FEATURES)) {
      this.published.delete(`${device.external_id}:${key}`);
    }
    const car = this.cars.get(pid);
    if (car && this.memory) {
      await this.publishCar(car, { replay: true });
    }
  }

  deviceDeleted(device) {
    if (typeof device?.external_id === 'string') {
      this.created.delete(device.external_id);
    }
  }

  /** Scan: the cars known from the last read (a scan never reads Tessie sooner). */
  async scan() {
    this.discovery = undefined;
    await this.publishDiscovery();
  }

  async publishDiscovery() {
    if (!this.config) return;
    const devices = [...this.cars.values()].map((car) =>
      buildDevice(this.gladys, { id: car.pid, name: car.name, model: car.model }, this.config),
    );
    const signature = JSON.stringify(devices);
    if (signature === this.discovery) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovery = signature;
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.status ?? 'error'})`);
    }
  }

  // ---------------------------------------------------------------- status

  async setStatus(key, params = {}) {
    if (this.stopped) return;
    const message = STATUS[key](params);
    this.lastStatus = { key, params };
    if (message.en === this.statusText) return;
    this.statusText = message.en;
    try {
      await this.gladys.setConnectionStatus(key === 'connected', message);
    } catch (err) {
      this.statusText = undefined;
      this.logger.warn(`Status not sent (${err?.status ?? 'error'})`);
    }
  }

  // ---------------------------------------------------------------- reads

  fingerprint(token) {
    return createHmac('sha256', this.memory.salt).update(token).digest('hex').slice(0, 2);
  }

  isRefused() {
    return Boolean(
      this.memory?.refused &&
      this.config?.token &&
      this.fingerprint(this.config.token) === this.memory.refused.fp,
    );
  }

  /** Puts the next read at its place (interval, pause), or says why there is none. */
  kick() {
    if (this.stopped || !this.config || !this.memory) return;
    if (this.config.problem) {
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      this.setStatus(this.config.problem);
      return;
    }
    if (this.isRefused()) {
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      this.setStatus('refused', { status: this.memory.refused.status });
      return;
    }
    if (this.pollTimer !== undefined || this.inFlight) return;
    const mono = this.monotonic();
    if (this.pauseUntil !== undefined && this.pauseUntil > mono) {
      this.setStatus('paused', {
        left: this.pauseUntil - mono,
        status: this.memory.pause?.status ?? 429,
      });
      this.schedule(this.pauseUntil, mono);
      return;
    }
    if (this.lastReadMono === undefined) {
      this.setStatus('starting');
    }
    const due = this.lastReadMono === undefined ? mono : this.lastReadMono + this.config.interval;
    this.schedule(Math.max(due, mono), mono);
  }

  schedule(at, mono) {
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = this.timers.setTimeout(
      () => {
        this.pollTimer = undefined;
        this.poll('timer');
      },
      Math.max(0, at - mono),
    );
  }

  /** One read of the vehicles (one at a time). -> { ok, count } | { error } | { skipped } */
  poll(reason, { test = false } = {}) {
    if (this.inFlight) return this.inFlight;
    const run = this.read(reason, test);
    this.inFlight = run;
    run.finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    return run;
  }

  async read(reason, test) {
    const mono = this.monotonic();
    const gen = this.generation;
    if (
      this.stopped ||
      !this.config ||
      !this.memory ||
      this.config.problem ||
      (!test && this.isRefused()) ||
      (this.pauseUntil !== undefined && this.pauseUntil > mono)
    ) {
      return { skipped: true };
    }
    this.lastReadMono = mono;
    this.memory.lastRead = this.now();
    // The time of the try is in /data before the request (a restart never reads sooner);
    // a slow /data never holds the read more than a few seconds.
    await this.bounded(this.saveMemory(), TIMINGS.saveWait);
    if (gen !== this.generation) return { skipped: true };
    this.schedule(mono + this.config.interval, mono);
    let res;
    try {
      res = await this.request({
        path: '/vehicles',
        query: { only_active: true },
        timeout: TIMINGS.readTimeout,
      });
      if (!Array.isArray(res.body?.results)) throw new TessieError('invalid');
    } catch (err) {
      if (gen !== this.generation) return { skipped: true };
      await this.readFailed(err, mono);
      return { error: err };
    }
    if (gen !== this.generation) return { skipped: true };
    this.failures = 0;
    if (this.memory.refused || this.memory.pause) {
      this.memory.refused = undefined;
      this.memory.pause = undefined;
      this.pauseUntil = undefined;
    }
    const count = await this.handleVehicles(res, gen);
    return { ok: true, count };
  }

  /** `promise`, or undefined after `ms` (never an unbounded wait). */
  bounded(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, ms);
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  request({ method = 'GET', path, query, timeout }) {
    return tessieRequest({
      fetch: this.fetch,
      timers: this.timers,
      token: this.config.token,
      method,
      path,
      query,
      timeout,
      signal: this.aborter.signal,
    });
  }

  async readFailed(err, mono) {
    const kind = err instanceof TessieError ? err.kind : 'invalid';
    if (kind === 'auth') {
      // The main route refused the token: no automatic try until a new token or a test.
      this.memory.refused = { fp: this.fingerprint(this.config.token), status: err.status };
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      this.logger.warn(`Tessie refused the token (${err.status}): reads stopped`);
      await this.bounded(this.saveMemory(), TIMINGS.saveWait);
      await this.setStatus('refused', { status: err.status });
      return;
    }
    this.failures += 1;
    if (kind === 'rate' || kind === 'server') {
      const fallback = TIMINGS.pauseMin * 2 ** Math.min(this.failures - 1, 10);
      const wait = Math.min(
        Math.max(err.retryAfter ?? fallback, TIMINGS.pauseMin),
        TIMINGS.pauseMax,
      );
      this.pauseUntil = mono + wait;
      this.memory.pause = { until: this.now() + wait, status: err.status };
      this.logger.warn(`Tessie answered ${err.status}: paused ${Math.ceil(wait / 1000)} s`);
      await this.bounded(this.saveMemory(), TIMINGS.saveWait);
      this.schedule(this.pauseUntil, this.monotonic());
      await this.setStatus('paused', { left: wait, status: err.status });
      return;
    }
    const wait = Math.min(
      this.config.interval * 2 ** Math.min(this.failures - 1, 10),
      Math.max(TIMINGS.backoffMax, this.config.interval),
    );
    this.logger.warn(`Tessie not read (${err?.reason ?? kind})`);
    this.schedule(mono + wait, this.monotonic());
    await this.setStatus('unreachable', { left: wait, reason: err?.reason ?? kind });
  }

  /** The answer of GET /vehicles: the cars, the Discovery, the states. -> the number of cars. */
  async handleVehicles(res, gen) {
    const selector = this.gladys.selector;
    const cars = new Map();
    let ignored = 0;
    for (const entry of res.body.results.slice(0, 100)) {
      const parsed = parseVehicle(entry, this.config);
      if (!parsed) continue;
      const pid = platformId(selector, parsed.vin);
      if (cars.has(pid)) continue;
      if (cars.size >= LIMITS.vehicles) {
        ignored += 1;
        continue;
      }
      cars.set(pid, {
        pid,
        vin: parsed.vin,
        name: parsed.name,
        model: parsed.model,
        snap: parsed,
        date: res.date,
      });
    }
    this.cars = cars;
    for (const pid of Object.keys(this.memory.seen)) {
      if (!cars.has(pid)) delete this.memory.seen[pid];
    }
    await this.publishDiscovery();
    for (const car of cars.values()) {
      if (gen !== this.generation) break;
      await this.publishCar(car);
      this.lockSeen(car);
    }
    await this.bounded(this.saveMemory(), TIMINGS.saveWait);
    if (gen === this.generation) {
      await this.setStatus('connected', { count: cars.size, ignored });
    }
    return cars.size;
  }

  /** Takes `n` states from the budget of the minute, or false. */
  takeBudget(n, mono = this.monotonic()) {
    while (this.sent.length && this.sent[0] <= mono - MINUTE) this.sent.shift();
    if (this.sent.length + n > LIMITS.statesPerMinute) return false;
    for (let i = 0; i < n; i += 1) this.sent.push(mono);
    return true;
  }

  /**
   * The states of one car, section by section, each dated by its own
   * timestamp: a section already published (`seen`) is skipped; older than
   * 2 h (against Tessie's Date), never published; older than 10 min or
   * without a Date, published dated (created_at, starts no scene); fresh,
   * published as new when the value changed (or after an hour).
   * `replay` (device just created): every section known, dated.
   */
  async publishCar(car, { replay = false } = {}) {
    const ids = this.gladys.externalIds(DEVICE_TYPE, car.pid);
    if (!this.created.has(ids.device)) return;
    const seen = (this.memory.seen[car.pid] ??= {});
    const wall = this.now();
    const ref = car.date;
    for (const section of SECTION_ORDER) {
      const s = car.snap.sections[section];
      if (!s) continue;
      if (!replay && seen[section] !== undefined && s.ts <= seen[section]) continue;
      if (s.ts > (ref ?? wall) + TIMINGS.futureSkew) continue;
      const age = ref === undefined ? undefined : ref - s.ts;
      if (age !== undefined && age > TIMINGS.staleMax) {
        seen[section] = Math.max(seen[section] ?? 0, s.ts);
        continue;
      }
      const dated = replay || age === undefined || age > TIMINGS.fresh;
      const mono = this.monotonic();
      const states = [];
      const marks = [];
      for (const [key, value] of Object.entries(s.values)) {
        if (!allowed(key, this.config)) continue;
        const id = ids.feature(key);
        if (FEATURES[key].kind === 'counter') {
          const highest = this.highest.get(id);
          if (highest !== undefined && value.state < highest) continue;
        }
        if (value.text !== undefined) {
          // A text cannot be dated: published only when fresh.
          if (dated) continue;
          const last = this.published.get(id);
          if (last && last.value === value.text && mono - last.at < TIMINGS.heartbeat) continue;
          states.push({ device_feature_external_id: id, text: value.text });
          marks.push([id, value.text, value]);
          continue;
        }
        if (dated) {
          states.push({
            device_feature_external_id: id,
            state: value.state,
            created_at: new Date(Math.min(s.ts, wall)).toISOString(),
          });
          marks.push([id, undefined, value]);
          continue;
        }
        const last = this.published.get(id);
        if (last && last.value === value.state && mono - last.at < TIMINGS.heartbeat) continue;
        states.push({ device_feature_external_id: id, state: value.state });
        marks.push([id, value.state, value]);
      }
      if (states.length > 0) {
        if (!this.takeBudget(states.length, mono)) {
          // Over 250 states this minute: this section waits for the next read.
          this.logger.warn(
            'State budget of the minute reached: some values wait for the next read',
          );
          break;
        }
        try {
          await this.gladys.publishStates(states);
        } catch (err) {
          this.logger.warn(`States not published (${err?.status ?? 'error'})`);
          continue;
        }
        for (const [id, published, value] of marks) {
          if (published !== undefined) this.published.set(id, { value: published, at: mono });
          else this.published.delete(id);
          if (FEATURES[id.slice(id.lastIndexOf(':') + 1)]?.kind === 'counter') {
            this.highest.set(id, Math.max(this.highest.get(id) ?? 0, value.state));
          }
        }
      }
      seen[section] = Math.max(seen[section] ?? 0, s.ts);
    }
    if (!replay) {
      // The state (online, asleep...) is Tessie's current one: published when it changes.
      const value = car.snap.top.values.state;
      const id = ids.feature('state');
      const last = this.published.get(id);
      const mono = this.monotonic();
      if (
        value &&
        !(last && last.value === value.text && mono - last.at < TIMINGS.heartbeat) &&
        this.takeBudget(1, mono)
      ) {
        try {
          await this.gladys.publishStates([{ device_feature_external_id: id, text: value.text }]);
          this.published.set(id, { value: value.text, at: mono });
        } catch (err) {
          this.logger.warn(`State not published (${err?.status ?? 'error'})`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- test button

  async testConnection() {
    const mono = this.monotonic();
    if (this.lastTest !== undefined && mono - this.lastTest < TIMINGS.testCooldown) {
      return TEST.tooSoon;
    }
    this.lastTest = mono;
    if (!this.config && !(await this.readConfig())) {
      return TEST.configUnread;
    }
    if (this.config.problem) return TEST[this.config.problem];
    await this.loadData();
    if (!this.memory) return STATUS.dataUnreadable();
    if (this.pauseUntil !== undefined && this.pauseUntil > mono) {
      return TEST.paused({
        left: this.pauseUntil - mono,
        status: this.memory.pause?.status ?? 429,
      });
    }
    const result = await this.poll('test', { test: true });
    if (result.ok) return TEST.ok({ count: result.count });
    if (result.error?.kind === 'auth') return TEST.refused({ status: result.error.status });
    if (result.error) return TEST.failed({ reason: result.error.reason ?? 'error' });
    return TEST.failed({ reason: 'not read' });
  }

  // ---------------------------------------------------------------- lock

  /** onSetValue: only `locked` = 1 (lock). */
  async setValue(device, feature, value) {
    const id = feature?.external_id;
    const prefix = this.prefix();
    const rest = typeof id === 'string' && id.startsWith(prefix) ? id.slice(prefix.length) : '';
    const match = /^([0-9a-f]{16}):([a-z_]+)$/.exec(rest);
    if (!match || match[2] !== 'locked') {
      throw new Error(LOCK.readOnly);
    }
    if (value !== 1) {
      throw new Error(LOCK.unlock);
    }
    return this.lock(match[1]);
  }

  /** Lock a car: answered within ~3 s (Gladys cuts at 5 s), the tries go on behind. */
  async lock(pid) {
    let entry = this.locks.get(pid);
    if (!entry || entry.done) {
      const untilWall = this.now() + TIMINGS.lockWindow;
      if (this.memory) {
        this.memory.locks[pid] = { until: untilWall, attempts: 0 };
      }
      entry = this.startLock(pid, { untilWall });
    }
    let timer;
    const ack = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('pending'), TIMINGS.lockAck);
    });
    // Answered once the first try is over (or ~3 s at most): the tries go on behind.
    const outcome = await Promise.race([
      entry.finished,
      entry.firstTry.then(() => 'retrying'),
      ack,
    ]);
    this.timers.clearTimeout(timer);
    if (outcome === 'unknownCar') throw new Error(LOCK.unknownCar);
    return outcome;
  }

  startLock(pid, { untilMono, untilWall, attempts = 0 }) {
    const mono = this.monotonic();
    const entry = {
      pid,
      attempts,
      untilMono: untilMono ?? mono + TIMINGS.lockWindow,
      untilWall: untilWall ?? this.now() + TIMINGS.lockWindow,
      baseTs: this.cars.get(pid)?.snap.sections.vehicle?.ts ?? 0,
      // Locked already when asked: a read equal to that proves nothing (only `result: true` does).
      baseLocked: this.cars.get(pid)?.snap.sections.vehicle?.values.locked?.state === 1,
      done: false,
      waiting: false,
      running: false,
      timer: undefined,
    };
    entry.finished = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    entry.firstTry = new Promise((resolve) => {
      entry.firstTried = resolve;
    });
    this.locks.set(pid, entry);
    this.runLock(entry);
    return entry;
  }

  finishLock(entry, outcome) {
    if (entry.done) return;
    entry.done = true;
    this.timers.clearTimeout(entry.timer);
    if (this.locks.get(entry.pid) === entry) this.locks.delete(entry.pid);
    if (this.memory?.locks[entry.pid]) {
      delete this.memory.locks[entry.pid];
      this.saveMemory();
    }
    const level = outcome === 'confirmed' || outcome === 'confirmedByRead' ? 'info' : 'warn';
    this.logger[level](`Lock of car ${entry.pid}: ${outcome}`);
    entry.resolve(outcome);
    entry.firstTried();
  }

  /**
   * A read showing the car locked, newer than when the lock was asked and
   * different from the state then (unlocked or unknown), ends the tries.
   */
  lockSeen(car) {
    const entry = this.locks.get(car.pid);
    const vehicle = car.snap.sections.vehicle;
    if (
      entry &&
      !entry.done &&
      vehicle &&
      vehicle.ts > entry.baseTs &&
      !entry.baseLocked &&
      vehicle.values.locked?.state === 1
    ) {
      this.finishLock(entry, 'confirmedByRead');
    }
  }

  resumeLocks() {
    for (const entry of this.locks.values()) {
      if (entry.waiting && !entry.done) {
        entry.waiting = false;
        this.runLock(entry);
      }
    }
  }

  wait(entry, delay) {
    return new Promise((resolve) => {
      entry.timer = this.timers.setTimeout(() => {
        entry.timer = undefined;
        resolve();
      }, delay);
    });
  }

  followUp() {
    for (const delay of TIMINGS.followUp) {
      const timer = this.timers.setTimeout(() => {
        this.followUps.delete(timer);
        if (!this.stopped) this.poll('followUp');
      }, delay);
      this.followUps.add(timer);
    }
  }

  async runLock(entry) {
    if (entry.running) return;
    entry.running = true;
    try {
      await this.lockLoop(entry);
    } catch (err) {
      this.logger.error(`Lock of car ${entry.pid} failed: ${err?.message ?? 'error'}`);
      this.finishLock(entry, 'failed');
    } finally {
      entry.running = false;
      // Waiting for a token, done, or stopped: Gladys gets its answer now.
      entry.firstTried();
    }
  }

  async lockLoop(entry) {
    while (!entry.done && !this.stopped) {
      const mono = this.monotonic();
      if (mono >= entry.untilMono) {
        this.finishLock(entry, entry.attempts > 0 ? 'notConfirmed' : 'expiredNothingSent');
        return;
      }
      if (!this.config) {
        await this.readConfig();
        if (entry.done || this.stopped) return;
      }
      if (!this.config?.token) {
        // Kept until a token is read (resumeLocks), within its window.
        this.logger.warn(LOCK.noToken);
        entry.waiting = true;
        this.timers.clearTimeout(entry.timer);
        entry.timer = this.timers.setTimeout(
          () => {
            if (entry.waiting) this.finishLock(entry, 'expiredNothingSent');
          },
          Math.max(0, entry.untilMono - mono),
        );
        return;
      }
      let car = this.cars.get(entry.pid);
      if (!car) {
        // Not read yet (just started, paused, refused...): its VIN is looked up now, whatever the pause.
        car = await this.lookUp(entry.pid);
        if (entry.done || this.stopped) return;
        if (car === null) {
          this.finishLock(entry, 'unknownCar');
          return;
        }
      }
      let error;
      let answered = false;
      if (car) {
        entry.attempts += 1;
        if (this.memory?.locks[entry.pid]) {
          this.memory.locks[entry.pid].attempts = entry.attempts;
          this.saveMemory();
        }
        try {
          const res = await this.request({
            method: 'POST',
            path: `/${car.vin}/command/lock`,
            query: { wait_for_completion: true, max_attempts: 3 },
            timeout: TIMINGS.lockTimeout,
          });
          answered = true;
          if (res.body?.result === true) {
            this.finishLock(entry, 'confirmed');
            this.followUp();
            return;
          }
          this.logger.warn(`Lock of car ${entry.pid}: sent, not confirmed by the car`);
        } catch (err) {
          error = err;
          this.logger.warn(
            `Lock of car ${entry.pid}: ${err?.sent === false ? 'nothing sent' : 'sent, no confirmation'} (${err?.reason ?? 'error'})`,
          );
          if (err?.kind === 'auth' || err?.kind === 'client') {
            this.finishLock(entry, `refused ${err.status}`);
            return;
          }
        }
        if (answered || error?.sent !== false) {
          this.followUp();
        }
      } else {
        // The look-up failed (network): counts as a try.
        entry.attempts += 1;
      }
      entry.firstTried();
      if (entry.done || this.stopped) return;
      if (entry.attempts >= TIMINGS.lockAttempts) {
        this.finishLock(entry, 'notConfirmed');
        return;
      }
      const base = TIMINGS.lockRetry[Math.min(entry.attempts - 1, TIMINGS.lockRetry.length - 1)];
      const delay = error?.retryAfter !== undefined ? Math.max(base, error.retryAfter) : base;
      const now = this.monotonic();
      if (now + delay >= entry.untilMono) {
        this.finishLock(entry, 'notConfirmed');
        return;
      }
      await this.wait(entry, delay);
    }
  }

  /** The car of a platform id, read now (no pause, no refusal check): car | null (not in the account) | undefined (not read). */
  async lookUp(pid) {
    let res;
    try {
      res = await this.request({
        path: '/vehicles',
        query: { only_active: true },
        timeout: TIMINGS.readTimeout,
      });
    } catch (err) {
      this.logger.warn(`Lock: vehicles not read (${err?.reason ?? 'error'})`);
      return undefined;
    }
    const results = Array.isArray(res.body?.results) ? res.body.results.slice(0, 100) : [];
    for (const entry of results) {
      const parsed = parseVehicle(entry, this.config);
      if (parsed && platformId(this.gladys.selector, parsed.vin) === pid) {
        const car = {
          pid,
          vin: parsed.vin,
          name: parsed.name,
          model: parsed.model,
          snap: parsed,
          date: res.date,
        };
        // Kept for the next commands (the next read replaces it); nothing published from it.
        if (!this.cars.has(pid) && this.cars.size < LIMITS.vehicles) this.cars.set(pid, car);
        return car;
      }
    }
    return null;
  }
}
