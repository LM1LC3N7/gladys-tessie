# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## Tessie API (not included)

The integration calls the public HTTP API of Tessie (<https://api.tessie.com>),
as documented at <https://developer.tessie.com> (its OpenAPI description
declares the Apache License 2.0; read on 2026-11-11). The endpoints
used (`GET /vehicles`, `POST /{vin}/command/lock`), the field names and their
meaning come from that documentation only. Using the API is subject to the
terms of Tessie (<https://tessie.com/terms>) and needs the user's own access
token.

## tessie-api (not used, not read)

`tessie-api`, the Python client of the API, is licensed under the GNU General
Public License v3 (GPL-3.0). **Nothing of it was read, copied or ported**: the
code here was written from the public API documentation above.

## Runtime dependencies (npm)

Installed by `npm ci` into the image, not modified, under its own licence
file in `node_modules`:

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys SDK.

## Gladys-testkit (tests only)

`test/helpers/clock.js` is a copy of `src/clock.mjs` of gladys-testkit
(Apache-2.0, the same author as this integration). It is not part of the
image.
