# TODO — Tessie v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-11): cars of the Tessie account read
      from `GET /vehicles` (strict readers, freshness per section against the
      `Date` of Tessie), Discovery, lock command (protective, persisted,
      retried, confirmed), rounded position option, refused token stop,
      429/5xx pause, "Test the connection", docs en/fr. Tested on a scripted
      `fetch`, the SDK's fake Gladys and a virtual clock (plus a real-clock
      test).
- [ ] **Milestone 2 — real account**: run against a real Tessie account
      (testers): check the units (miles for ranges and odometer, °C, bar,
      kW), the `charger_power` of a fast charge, what a sleeping car returns,
      the error bodies and whether Tessie sends `Retry-After`, the time a
      lock takes with `wait_for_completion` on a sleeping car.
- [ ] **Milestone 3 — more**: miles / °F option, `time_to_full_charge`,
      software update available, per-door states; maybe Fleet Telemetry
      streaming (`wss://streaming.tessie.com`) instead of polling.
- [ ] **Milestone 4 — first release**: Release workflow, topic, GHCR public.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- Written from developer.tessie.com only; tessie-api (GPL-3.0) never read
  (brief of lot 22). No `keywords` / `countries` in the manifest (world).
- Identity: `car:<16 hex of HMAC-SHA256(VIN), key "gladys-tessie:<selector>">`:
  stable without `/data`, the VIN never in an id. The VIN stays in memory only
  (it is the path of the lock command).
- Read only except Lock (brief): `locked` is the only writable feature
  (`electrical-vehicle-command/lock`, never a switch); 1 sends the lock, 0 is
  refused ("not available"), nothing sent. Unlock, trunks, charge port,
  climate, wake: not in v1.
- Lock is protective: independent of the 429/5xx pause, of a refused token
  (it is still sent: a refusal only stops the automatic reads), of a read in
  flight (its own request), of `/data` (never awaited). A car not read yet is
  looked up by a `GET /vehicles` at once. Without a token (configuration not
  read yet) it waits, at most 3 minutes, and leaves when the token is read.
  3 tries at most (10 s, 30 s apart, longer if Retry-After says so), kept in
  `/data` so a restart sends it again within its window. Done when Tessie
  answers `result: true` (`wait_for_completion=true`) or a read newer than
  the request shows the car locked. A 401/403/4xx on the command ends it
  without stopping the reads. Gladys acked after the first try or 3 s.
- Reads: `GET /vehicles?only_active=true` (never wakes a car), one at a time,
  at the interval measured from the start of the last (60 s to 1 h, default
  5 min), the time of the try in `/data` before the request. A changed token
  is read at once; Scan, reconnection to Gladys, the same configuration saved
  again never read sooner. Two follow-up reads (5 s, 20 s) after a lock.
- Freshness: Tessie's section timestamps against the `Date` header; ≤ 10 min
  as new (changed values only, unchanged after 1 h); older, dated; > 2 h,
  never; without `Date`, dated (never dropped as stale). Texts (state,
  position) cannot be dated: published only when fresh. A device created is
  replayed dated. Sections seen kept in `/data`.
- Unknown is never 0: JSON numbers / booleans only (tyre pressures also as a
  strict decimal text, typed "string" in the docs); 0 bar = no reading.
  Odometer never decreasing (Gladys' last value included). Miles → km.
- Errors: 401/403 on `/vehicles` = refused token (8-bit HMAC with a random
  salt in `/data`; a new token saved is always tried; a restart with the same
  token does not try); 429/5xx = pause 1 min doubling, or Retry-After,
  bounded to 6 h, persisted; network / timeout / unreadable = interval
  doubled up to 1 h. Answers bounded to 1 MB and 20 s; redirects never
  followed (the token would go with them).
- At most 10 cars (the others ignored, said in the status), 250 states a
  minute (a section over the budget waits for the next read).
- Position off by default, rounded to 3 decimals, only when fresh; turned
  off, erased ('' text). Navigation, speed, heading never read.
- `/data` unreadable: no read for up to a minute (a refusal or a pause may be
  in it), read again every 10 s, one read at a time; then run without it and
  never write over it.
- CI: `timeout-minutes: 20` added to the jobs of `ci.yml` (as the sibling
  integrations).
