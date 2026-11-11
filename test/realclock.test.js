// -----------------------------------------------------------------------------
// The app on the REAL clock (sped up 200 times): the period of the reads is
// measured, not assumed. Wide margins (a timer is late under load, never
// early); everything is stopped in t.after, so a failure never leaves a timer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import { createTessie, setup, within } from './helpers/app.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';

test('real clock: one read per interval (60 s), measured', async (t) => {
  const clock = realClock({ speed: 200 });
  const tessie = createTessie(clock);
  const ctx = await setup({
    clock,
    tessie,
    config: { api_token: 'tok-123', poll_interval: 60 },
    start: false,
  });
  const spy = spyOn(ctx.app, 'read', clock);
  t.after(async () => {
    await ctx.app.stop();
    clock.close();
  });
  await ctx.gladys.connect();
  await within(measurePeriod(spy, { count: 3, period: 60_000 }), 15_000);
});
