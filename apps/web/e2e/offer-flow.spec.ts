import { expect, request as pwRequest, test, type APIRequestContext } from '@playwright/test';
import { STATE_FILES } from './helpers';

/**
 * Spec §17: the operational core end to end, across three people.
 *
 * Dispatcher creates and offers a ride to two volunteers; volunteer 1 accepts
 * on the phone screen; volunteer 2's accept is refused; the dispatcher sees
 * the assignment; the ride is driven to completion. A second ride is cancelled.
 * Setup and the second volunteer go through the API (their UI is covered
 * elsewhere); the steps a person actually taps are done in the browser.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173';
const VOLUNTEER_2 = { email: 'volunteer2@refuahvchesed.test', password: 'ChangeMeInDev123!' };

function pickupIn(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

async function asRole(file: string): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: BASE, storageState: file });
}

async function volunteerId(dispatch: APIRequestContext, name: string): Promise<string> {
  const res = await dispatch.get('/api/users', { params: { role: 'volunteer', search: name } });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { users: Array<{ id: string; fullName: string }> };
  const hit = body.users.find((u) => u.fullName === name);
  expect(hit, `seeded volunteer ${name}`).toBeTruthy();
  return hit!.id;
}

async function createTrip(dispatch: APIRequestContext, caller: string): Promise<{ id: string; reference: string }> {
  const res = await dispatch.post('/api/trips', {
    data: {
      callerName: caller,
      callerPhone: '514-555-8124',
      pickup: { line1: '1234 Avenue Bernard', city: 'Montreal', province: 'QC' },
      dropoff: { line1: '3755 Chemin de la Côte-Sainte-Catherine', city: 'Montreal', province: 'QC' },
      pickupAt: pickupIn(5),
      tripType: 'ride',
      priority: 'routine',
      groupSlug: 'chesed_on_the_go',
      assignmentMode: 'auto',
      mobilityNeeds: [],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { trip: { id: string; reference: string } };
  return body.trip;
}

test.describe('offer, accept, race, complete, cancel', () => {
  test.use({ storageState: STATE_FILES.volunteer });

  test('two volunteers are offered one ride; only the first accept wins', async ({ page, browser }) => {
    const dispatch = await asRole(STATE_FILES.dispatcher);
    const v1 = await volunteerId(dispatch, 'Yaakov Driver');
    const v2 = await volunteerId(dispatch, 'Rivka Helper');
    const trip = await createTrip(dispatch, `E2E Race ${Date.now().toString().slice(-6)}`);

    const offer = await dispatch.post(`/api/trips/${trip.id}/offer`, {
      data: { volunteerIds: [v1, v2], ignoreTargeting: true },
    });
    expect(offer.ok(), await offer.text()).toBeTruthy();

    // Volunteer 1 sees the offer and accepts it on screen.
    await page.goto('/my-trips');
    const card = page.locator('article', { hasText: trip.reference });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: /accept this ride/i }).click();
    await expect(page.locator('body')).toContainText(/this ride is yours/i, { timeout: 20_000 });

    // Volunteer 2 tries a moment later and is refused.
    const v2ctx = await pwRequest.newContext({ baseURL: BASE });
    const login = await v2ctx.post('/api/auth/login', { data: VOLUNTEER_2 });
    expect(login.ok(), await login.text()).toBeTruthy();
    const late = await v2ctx.post(`/api/trips/${trip.id}/claim`, { data: {} });
    expect(late.ok()).toBeFalsy();
    expect(await late.text()).toMatch(/another volunteer accepted|already/i);

    // The dispatcher sees who has it.
    const detail = await dispatch.get(`/api/trips/${trip.id}`);
    const t = ((await detail.json()) as { trip: { assignedVolunteerId: string | null; status: string } }).trip;
    expect(t.assignedVolunteerId).toBe(v1);
    const dpage = await (await browser.newContext({ storageState: STATE_FILES.dispatcher })).newPage();
    await dpage.goto(`/trips/${trip.id}`);
    await expect(dpage.locator('body')).toContainText('Yaakov Driver', { timeout: 20_000 });

    // Lifecycle to completion by the assigned volunteer.
    const vol = await asRole(STATE_FILES.volunteer);
    for (const step of ['en-route', 'start', 'complete']) {
      const r = await vol.post(`/api/trips/${trip.id}/${step}`, { data: {} });
      expect(r.ok(), `${step}: ${await r.text()}`).toBeTruthy();
    }
    await dpage.reload();
    await expect(dpage.locator('body')).toContainText(/completed/i, { timeout: 20_000 });

    // Volunteer 2 cannot read the completed ride's private details either.
    const peek = await v2ctx.get(`/api/trips/${trip.id}`);
    if (peek.ok()) expect(await peek.text()).not.toContain('514-555-8124');

    await Promise.all([dispatch.dispose(), v2ctx.dispose(), vol.dispose(), dpage.context().close()]);
  });

  test('a dispatcher cancels a ride and the volunteer no longer sees the offer', async ({ page }) => {
    const dispatch = await asRole(STATE_FILES.dispatcher);
    const v1 = await volunteerId(dispatch, 'Yaakov Driver');
    const trip = await createTrip(dispatch, `E2E Cancel ${Date.now().toString().slice(-6)}`);
    const offer = await dispatch.post(`/api/trips/${trip.id}/offer`, { data: { volunteerIds: [v1], ignoreTargeting: true } });
    expect(offer.ok(), await offer.text()).toBeTruthy();

    const cancel = await dispatch.post(`/api/trips/${trip.id}/cancel`, { data: { reason: 'E2E: caller no longer needs the ride' } });
    expect(cancel.ok(), await cancel.text()).toBeTruthy();

    await page.goto('/my-trips');
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    await expect(page.locator('article', { hasText: trip.reference })).toHaveCount(0);

    // And a late accept of the cancelled ride is refused.
    const vol = await asRole(STATE_FILES.volunteer);
    const late = await vol.post(`/api/trips/${trip.id}/claim`, { data: {} });
    expect(late.ok()).toBeFalsy();
    await Promise.all([dispatch.dispose(), vol.dispose()]);
  });
});
