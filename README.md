# gladys-tessie

[Gladys Assistant](https://gladysassistant.com) external integration for
**Tessie**, the paid Tesla management service, through the **official Tessie
API** (`api.tessie.com`, [developer.tessie.com](https://developer.tessie.com)):
battery, range, charge, climate, doors, trunks, windows, lock, Sentry mode,
tyre pressures, odometer and state of each car of the account and, when
allowed, the position rounded to about 100 m. **One command: Lock** (unlock,
trunks and charge port are not in v1). **Never tested with a real car.
Unofficial, not affiliated with Tesla nor with Tessie.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (TessieApp)
                                  ├─ src/tessie.js  HTTPS client: Bearer header, no redirect, bounded size and time
                                  ├─ src/car.js     Tessie vehicle state -> features, strict readers (pure)
                                  └─ src/store.js   /data: refusal (8-bit HMAC), pause, sections seen, pending locks
```

- **Reads**: `GET /vehicles?only_active=true` every interval (60 s to 1 h,
  5 min by default): the state Tessie already knows; Gladys never sends a wake request
  (only the lock may make Tessie wake the car).
  Every value read strictly; null, text or out of range is unknown, never 0.
- **Devices**: `ext:<selector>:car:<16 hex of an HMAC of the VIN keyed by a
random 32-byte key>`; the key is kept in the integration's own config in
  Gladys (`setConfig`, outside the schema, never shown) and in `/data`;
  features `<device>:<key>` (keys in `src/car.js`, frozen). The VIN is never
  in an id, a log, a status nor `/data`; logs name a car by its rank.
- **Freshness**: each section (charge, climate, vehicle, drive) is dated by
  its own timestamp, compared with the `Date` of Tessie's answer: up to 10 min
  old, published as new; older, dated (`created_at`, starts no scene); over
  2 h, not published; never published twice (`/data`).
- **Lock** (protective): sent whatever the pause, the refused token, a read
  in flight or `/data`; Gladys acked within ~3 s; up to 3 tries in 3 minutes,
  kept in `/data` across a restart; done when the car confirms, or a read
  dated after the first POST shows it locked while it was known unlocked.
  Anything short of a confirmation reaches Gladys as an error. Unlock and the
  other commands are refused, nothing sent.
- **Failures**: 401/403 on `/vehicles` stops the reads (persisted, no
  automatic try) until a new token or a successful test; 429/5xx pause the
  reads (Retry-After, 1 min to 6 h, persisted); network errors double the
  interval up to 1 h; the configuration unreadable from Gladys is read again,
  spaced, without end; `/data` unreadable is never taken for empty (no read
  until it is read).

Written from Tessie's public API documentation only (tessie-api, the Python
client, is GPL-3.0 and was not read). Structure of the sibling
[gladys-teslamate](https://github.com/LM1LC3N7/gladys-teslamate).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
node scripts/cover.mjs cover.png                # cover.png, plain Node
memcap node scripts/mutants.mjs                 # mutation check of the guards
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: Tessie is a scripted `fetch`
(`test/helpers/app.js`), Gladys is the SDK's fake, the clock is virtual
(`test/helpers/clock.js`) except in `test/realclock.test.js`.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
(also shipped in the Docker image).
