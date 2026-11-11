# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Teslas of a Tessie account read through the official Tessie API (latest
  known state, never waking a car): battery levels, rated and estimated range,
  charging state, power, current and voltage, energy added, charge limit,
  plugged in, inside and outside temperatures, climate, odometer (never
  decreasing), lock, Sentry mode, doors, trunks, windows, tyre pressures and
  state.
- Lock command (the only one): sent whatever the pause or the token refusal,
  up to 3 tries in 3 minutes, kept in `/data` across a restart, then two
  follow-up reads. Unlock, trunks and charge port are refused (nothing sent).
- Position rounded to about 100 m, off by default; turning it off erases the
  value shown.
- Freshness from Tessie's own timestamps against the `Date` of its answers:
  older values dated, values over 2 h old not published, nothing published
  twice nor as new after a restart.
- Refused token: reads stopped (persisted) until a new token or a successful
  test; 429/5xx: pause from Retry-After (1 min to 6 h, persisted); at most
  10 cars and 250 states a minute.
- "Test the connection" button; user guides in English and French.
