import { test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ADMIN, DISPATCHER, VOLUNTEER, STATE_FILES, signIn } from './helpers';

/**
 * Sign each role in once and reuse the session.
 *
 * Not only for speed. `POST /api/auth/login` is deliberately rate-limited to a
 * handful of attempts per IP per five minutes, so a suite that signs in at the
 * top of every test throttles itself and fails with timeouts that look like
 * application bugs. Logging in three times total keeps the limiter doing its
 * real job — which is separately tested in the API suite.
 */
setup('authenticate', async ({ browser }) => {
  mkdirSync('e2e/.auth', { recursive: true });

  for (const [who, file] of [
    [ADMIN, STATE_FILES.admin],
    [DISPATCHER, STATE_FILES.dispatcher],
    [VOLUNTEER, STATE_FILES.volunteer],
  ] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, who);
    await context.storageState({ path: file });
    await context.close();
  }
});
