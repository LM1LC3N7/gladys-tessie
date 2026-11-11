# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Tessie (the paid Tesla
management service): a Node.js service (Node 22+, ESM, no build step) that
runs in its own sandboxed Docker container, reads the cars of the user's Tessie
account through the official Tessie API (`api.tessie.com`) and sends the lock
command, and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner (memcap on this VM)
node --test test/app.test.js              # one file
node --test --test-name-pattern "lock"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js, handlers before connect())
src/handlers.js                   the SDK handlers -> TessieApp (also used by the tests)
src/app.js                        reads, freshness, Discovery, status, lock, test button
src/tessie.js                     HTTPS client (Bearer header, no redirect, bounded size and time)
src/car.js                        Tessie vehicle state -> features, strict readers, buildDevice (pure)
src/store.js                      /data/tessie-state.json: refusal, pause, sections seen, pending locks
src/config.js, src/constants.js   configuration (DEFAULT_CONFIG mirrors the manifest), keys, timings
src/i18n.js                       feature names, statuses (en/fr)
scripts/mutants.mjs + .json       mutation check of the guards (not in the image, not in CI)
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, SDK fake Gladys, scripted fetch, virtual clock
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`. Here the platform id is an HMAC of
  the VIN keyed by the selector (`platformId()` in `src/car.js`): never change
  it, nor a feature key, a `config_schema` or `actions` key.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log, show or keep the token nor the VIN.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French), kept in sync.
- **Commands.** Only Lock (protective: never blocked by a pause, a refused
  token, a read, `/data`). Unlock, trunks, charge port or any other command
  need a decision of the maintainer, behind an option off by default, never a
  `switch`.
- **Licences.** tessie-api (Python) is GPL-3.0: never read, copy or port it;
  write from developer.tessie.com only.
- **Privacy.** The position stays off by default and rounded to 3 decimals;
  never the navigation.
- **Freshness.** A value is never published twice nor as new when it is old
  (Tessie's timestamps against its `Date`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
