import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql as raw } from 'drizzle-orm';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { announcements, dataExports, dutyShifts, equipment, equipmentCategories } from '../db/schema.js';
import { captured } from '../services/providers/inmemory.js';
import { scanEquipmentDue } from '../domain/equipment.service.js';
import { runExport } from '../domain/exports.service.js';
import { deliverAnnouncement } from '../domain/announcements.service.js';
import { restPeriodsBetween, zmanimFor } from '../lib/hebcal.js';

describe('operations: roster, equipment, exports, broadcasts, calendar', () => {
  let admin: TestUser;
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin' });
    dispatcher = await createTestUser({ role: 'dispatcher' });
    captured.reset();
  });

  // --- duty roster ---------------------------------------------------------

  it('rosters a phone shift and reports who is on now', async () => {
    const start = new Date(Date.now() - 3_600_000);
    const end = new Date(Date.now() + 3_600_000);
    const created = await api('POST', '/api/duty', {
      cookie: dispatcher.cookie,
      payload: { kind: 'phone', userId: dispatcher.id, startsAt: start.toISOString(), endsAt: end.toISOString() },
    });
    expect(created.status).toBe(201);

    const list = await api('GET', '/api/duty', { cookie: dispatcher.cookie });
    expect((list.body.onDutyNow as { userId: string }).userId).toBe(dispatcher.id);
  });

  it('refuses two people on the phone at the same time', async () => {
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);
    const first = await api('POST', '/api/duty', {
      cookie: dispatcher.cookie,
      payload: { userId: dispatcher.id, startsAt: start.toISOString(), endsAt: end.toISOString() },
    });
    expect(first.status).toBe(201);

    const overlapping = await api('POST', '/api/duty', {
      cookie: dispatcher.cookie,
      payload: {
        userId: admin.id,
        startsAt: new Date(start.getTime() + 1_800_000).toISOString(),
        endsAt: new Date(end.getTime() + 1_800_000).toISOString(),
      },
    });
    // Two people believing they are on the phone is the same failure as nobody
    // being on it. The database refuses it; the message names the clash.
    expect(overlapping.status).toBe(409);
    expect((overlapping.body.error as { message: string }).message).toMatch(/already on phone duty/i);
  });

  it('allows different kinds of duty to overlap', async () => {
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);
    await api('POST', '/api/duty', {
      cookie: dispatcher.cookie,
      payload: { kind: 'phone', userId: dispatcher.id, startsAt: start.toISOString(), endsAt: end.toISOString() },
    });
    const backup = await api('POST', '/api/duty', {
      cookie: dispatcher.cookie,
      payload: { kind: 'backup', userId: admin.id, startsAt: start.toISOString(), endsAt: end.toISOString() },
    });
    expect(backup.status).toBe(201);
  });

  it('frees the slot again when a shift is removed', async () => {
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);
    const created = await api('POST', '/api/duty', {
      cookie: dispatcher.cookie,
      payload: { userId: dispatcher.id, startsAt: start.toISOString(), endsAt: end.toISOString() },
    });
    const id = (created.body.shift as { id: string }).id;
    await api('DELETE', `/api/duty/${id}`, { cookie: dispatcher.cookie });

    const replacement = await api('POST', '/api/duty', {
      cookie: dispatcher.cookie,
      payload: { userId: admin.id, startsAt: start.toISOString(), endsAt: end.toISOString() },
    });
    expect(replacement.status).toBe(201);
    const [removed] = await db.select().from(dutyShifts).where(eq(dutyShifts.id, id));
    expect(removed!.deletedAt).not.toBeNull();
  });

  // --- equipment -----------------------------------------------------------

  async function makeItem(over: Record<string, unknown> = {}) {
    const [category] = await db.insert(equipmentCategories).values({ name: `Mobility ${Date.now()}` }).returning();
    const [item] = await db
      .insert(equipment)
      .values({
        categoryId: category!.id,
        itemCode: `WC-${Math.floor(Math.random() * 9000 + 1000)}`,
        equipmentType: 'wheelchair',
        ...over,
      })
      .returning();
    await db.update(equipment).set({ barcode: `RVC${item!.itemCode}` }).where(eq(equipment.id, item!.id));
    return item!;
  }

  it('finds an item by barcode or by its printed code', async () => {
    const item = await makeItem();
    const byBarcode = await api('GET', `/api/equipment/scan/RVC${item.itemCode}`, { cookie: dispatcher.cookie });
    expect(byBarcode.status).toBe(200);
    expect((byBarcode.body.item as { id: string }).id).toBe(item.id);

    const byCode = await api('GET', `/api/equipment/scan/${item.itemCode!.toLowerCase()}`, {
      cookie: dispatcher.cookie,
    });
    expect((byCode.body.item as { id: string }).id).toBe(item.id);
  });

  it('says plainly when a scanned code is not on file', async () => {
    const res = await api('GET', '/api/equipment/scan/NOTATHING', { cookie: dispatcher.cookie });
    expect(res.status).toBe(404);
    expect((res.body.error as { message: string }).message).toMatch(/NOTATHING/);
  });

  it('shows the open loan alongside a scanned item', async () => {
    const item = await makeItem();
    await api('POST', `/api/equipment/${item.id}/loan`, {
      cookie: dispatcher.cookie,
      payload: {
        borrowerName: 'Miriam Stein',
        borrowerPhone: '514-555-2233',
        expectedReturnAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    });
    const res = await api('GET', `/api/equipment/scan/RVC${item.itemCode}`, { cookie: dispatcher.cookie });
    expect((res.body.openLoan as { borrowerName: string }).borrowerName).toBe('Miriam Stein');
    expect((res.body.item as { status: string }).status).toBe('loaned');
  });

  it('produces label data a printer can use', async () => {
    const item = await makeItem();
    const res = await api('POST', '/api/equipment/labels', {
      cookie: dispatcher.cookie,
      payload: { ids: [item.id] },
    });
    expect(res.status).toBe(200);
    const labels = res.body.labels as Array<{ barcode: string; orgName: string }>;
    expect(labels[0]!.barcode).toBeTruthy();
    expect(labels[0]!.orgName).toBeTruthy();
  });

  it('reminds a borrower before the item is due', async () => {
    const item = await makeItem();
    await api('POST', `/api/equipment/${item.id}/loan`, {
      cookie: dispatcher.cookie,
      payload: {
        borrowerName: 'Miriam Stein',
        borrowerPhone: '514-555-2233',
        // The default reminder lead time is two days.
        expectedReturnAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    });
    captured.reset();

    const result = await scanEquipmentDue();
    expect(result.reminded).toBe(1);
    expect(captured.sms.some((m) => m.to === '+15145552233' && /wheelchair/i.test(m.body))).toBe(true);
  });

  it('chases an overdue item weekly, not daily', async () => {
    const item = await makeItem();
    await api('POST', `/api/equipment/${item.id}/loan`, {
      cookie: dispatcher.cookie,
      payload: {
        borrowerName: 'Miriam Stein',
        borrowerPhone: '514-555-2233',
        expectedReturnAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      },
    });
    captured.reset();

    const sevenDaysOverdue = await scanEquipmentDue();
    expect(sevenDaysOverdue.overdue).toBe(1);

    // Eight days overdue: nothing, because daily texts get the number blocked
    // and then the wheelchair is gone for good.
    captured.reset();
    const eightDaysOverdue = await scanEquipmentDue(new Date(Date.now() + 86_400_000));
    expect(eightDaysOverdue.overdue).toBe(0);
  });

  it('lists overdue loans for the board', async () => {
    const item = await makeItem();
    await api('POST', `/api/equipment/${item.id}/loan`, {
      cookie: dispatcher.cookie,
      payload: {
        borrowerName: 'Late Borrower',
        borrowerPhone: '514-555-2244',
        expectedReturnAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      },
    });
    const res = await api('GET', '/api/equipment/overdue', { cookie: dispatcher.cookie });
    expect((res.body.loans as unknown[]).length).toBe(1);
  });

  // --- exports -------------------------------------------------------------

  it('runs an export in the background and stores it with an expiry', async () => {
    await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });

    const requested = await api('POST', '/api/exports', {
      cookie: dispatcher.cookie,
      payload: { kind: 'trips' },
    });
    expect(requested.status).toBe(202);
    const exportId = (requested.body.export as { id: string }).id;

    await runExport(exportId);

    const [row] = await db.select().from(dataExports).where(eq(dataExports.id, exportId));
    expect(row!.status).toBe('ready');
    expect(row!.rowCount).toBeGreaterThan(0);
    expect(row!.fileId).toBeTruthy();
    expect(row!.expiresAt).not.toBeNull();

    const download = await api('GET', `/api/exports/${exportId}/download`, { cookie: dispatcher.cookie });
    expect(download.status).toBe(200);
    expect(String(download.raw.body)).toMatch(/reference/);
  });

  it('produces the monthly board report', async () => {
    await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const requested = await api('POST', '/api/exports', {
      cookie: admin.cookie,
      payload: { kind: 'monthly_board' },
    });
    await runExport((requested.body.export as { id: string }).id);

    const download = await api('GET', `/api/exports/${(requested.body.export as { id: string }).id}/download`, {
      cookie: admin.cookie,
    });
    expect(download.status).toBe(200);
    expect(String(download.raw.body)).toMatch(/month/);
    expect(String(download.raw.body)).toMatch(/avg_minutes_to_accept/);
  });

  it('keeps one dispatcher’s export away from another', async () => {
    const other = await createTestUser({ role: 'dispatcher' });
    const requested = await api('POST', '/api/exports', {
      cookie: dispatcher.cookie,
      payload: { kind: 'volunteers' },
    });
    const exportId = (requested.body.export as { id: string }).id;
    await runExport(exportId);

    const res = await api('GET', `/api/exports/${exportId}/download`, { cookie: other.cookie });
    expect(res.status).toBe(403);
  });

  it('audits the request and the download separately', async () => {
    const requested = await api('POST', '/api/exports', {
      cookie: admin.cookie,
      payload: { kind: 'volunteers' },
    });
    const exportId = (requested.body.export as { id: string }).id;
    await runExport(exportId);
    await api('GET', `/api/exports/${exportId}/download`, { cookie: admin.cookie });

    const audit = await api('GET', '/api/audit?limit=100', { cookie: admin.cookie });
    const actions = (audit.body.events as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('export.requested');
    expect(actions).toContain('export.completed');
    expect(actions).toContain('file.read');
  });

  it('refuses a volunteer any export at all', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const res = await api('POST', '/api/exports', { cookie: volunteer.cookie, payload: { kind: 'volunteers' } });
    expect(res.status).toBe(403);
  });

  // --- broadcasts ----------------------------------------------------------

  it('shows the recipient count before anything is sent', async () => {
    await createTestUser({ role: 'volunteer' });
    await createTestUser({ role: 'volunteer' });
    const res = await api('POST', '/api/announcements/preview', {
      cookie: admin.cookie,
      payload: { groupSlugs: ['chesed_on_the_go'] },
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect((res.body.sample as unknown[]).length).toBe(2);
  });

  it('refuses to send when the audience has changed since drafting', async () => {
    await createTestUser({ role: 'volunteer' });
    const draft = await api('POST', '/api/announcements', {
      cookie: admin.cookie,
      payload: {
        title: 'Sunday drive needed',
        body: 'We are short of drivers this Sunday morning.',
        audience: { groupSlugs: ['chesed_on_the_go'] },
        channels: ['sms'],
      },
    });
    const id = (draft.body.announcement as { id: string }).id;

    // Somebody joins between drafting and sending.
    await createTestUser({ role: 'volunteer' });

    const res = await api('POST', `/api/announcements/${id}/send`, {
      cookie: admin.cookie,
      payload: { confirmRecipientCount: 1 },
    });
    expect(res.status).toBe(409);
    expect((res.body.error as { message: string }).message).toMatch(/now reaches 2/i);
  });

  it('sends a broadcast through the normal delivery path', async () => {
    const one = await createTestUser({ role: 'volunteer' });
    const two = await createTestUser({ role: 'volunteer' });
    const draft = await api('POST', '/api/announcements', {
      cookie: admin.cookie,
      payload: {
        title: 'Sunday drive needed',
        body: 'We are short of drivers this Sunday morning.',
        audience: { groupSlugs: ['chesed_on_the_go'] },
        channels: ['sms'],
      },
    });
    const id = (draft.body.announcement as { id: string }).id;

    const sent = await api('POST', `/api/announcements/${id}/send`, {
      cookie: admin.cookie,
      payload: { confirmRecipientCount: 2 },
    });
    expect(sent.status).toBe(200);

    await deliverAnnouncement(id);
    await drainJobs();

    const [row] = await db.select().from(announcements).where(eq(announcements.id, id));
    expect(row!.status).toBe('sent');
    expect(captured.sms.some((m) => m.to === one.phone)).toBe(true);
    expect(captured.sms.some((m) => m.to === two.phone)).toBe(true);
  });

  it('leaves a snoozed volunteer out of a broadcast', async () => {
    const awake = await createTestUser({ role: 'volunteer' });
    const snoozed = await createTestUser({ role: 'volunteer' });
    await db.execute(raw`update users set muted_until = now() + interval '1 hour' where id = ${snoozed.id}::uuid`);

    const preview = await api('POST', '/api/announcements/preview', {
      cookie: admin.cookie,
      payload: { groupSlugs: ['chesed_on_the_go'] },
    });
    // A broadcast is by definition not urgent enough to override somebody's
    // evening — unlike a cancellation for a trip they accepted.
    expect(preview.body.count).toBe(1);
    expect((preview.body.sample as string[])[0]).toBe(awake.fullName);
  });

  it('refuses a dispatcher the ability to broadcast', async () => {
    const res = await api('POST', '/api/announcements', {
      cookie: dispatcher.cookie,
      payload: { title: 'x', body: 'y', audience: {}, channels: ['sms'] },
    });
    expect(res.status).toBe(403);
  });

  // --- bulk operations -----------------------------------------------------

  it('reports per-trip outcomes for a bulk assign', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await api('POST', '/api/trips', {
        cookie: dispatcher.cookie,
        payload: sampleTrip({ pickupAt: new Date(Date.now() + (4 + i * 4) * 3_600_000).toISOString() }),
      });
      ids.push((created.body.trip as { id: string }).id);
    }
    // Complete one, so it can no longer be assigned.
    await api('POST', `/api/trips/${ids[2]}/assign`, {
      cookie: dispatcher.cookie,
      payload: { volunteerId: volunteer.id },
    });
    await api('POST', `/api/trips/${ids[2]}/complete`, { cookie: dispatcher.cookie, payload: {} });

    const res = await api('POST', '/api/trips/bulk/assign', {
      cookie: dispatcher.cookie,
      payload: { tripIds: ids, volunteerId: volunteer.id },
    });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(2);
    expect(res.body.failed).toBe(1);

    // One trip moving on must not abort the others, and must not be hidden.
    const results = res.body.results as Array<{ tripId: string; ok: boolean; error?: string }>;
    expect(results.find((r) => r.tripId === ids[2])!.ok).toBe(false);
    expect(results.find((r) => r.tripId === ids[2])!.error).toBeTruthy();
  });

  // --- calendar ------------------------------------------------------------

  it('gives the dispatcher board the Hebrew date and zmanim', async () => {
    const res = await api('GET', '/api/board/context', { cookie: dispatcher.cookie });
    expect(res.status).toBe(200);
    expect((res.body.hebrewToday as { hebrewDate: string }).hebrewDate).toMatch(/\d/);
    expect((res.body.zmanim as { sunset: string }).sunset).toBeTruthy();
    expect(Array.isArray(res.body.restPeriods)).toBe(true);
  });

  it('finds the Shabbos boundary for a known week in Montreal', () => {
    const periods = restPeriodsBetween(new Date('2026-12-14'), new Date('2026-12-21'));
    expect(periods.length).toBe(1);
    expect(periods[0]!.kind).toBe('shabbat');
    // Friday candle lighting, Saturday night havdalah.
    expect(new Date(periods[0]!.startsAt).getUTCDay()).toBe(5);
    expect(new Date(periods[0]!.endsAt).getUTCDay()).toBe(6);
  });

  it('runs a three-day yom tov into one rest period', () => {
    // Rosh Hashana 5787 falls Friday to Sunday night.
    const periods = restPeriodsBetween(new Date('2026-09-10'), new Date('2026-09-15'));
    expect(periods.length).toBe(1);
    expect(periods[0]!.kind).toBe('yomtov');
    const hours = (new Date(periods[0]!.endsAt).getTime() - new Date(periods[0]!.startsAt).getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(40);
  });

  it('computes zmanim for Montreal, not for UTC', () => {
    const z = zmanimFor(new Date('2026-06-21T12:00:00Z'));
    const sunsetHourUtc = new Date(z.sunset!).getUTCHours();
    // Montreal midsummer sunset is around 20:45 EDT, i.e. ~00:45 UTC.
    expect(sunsetHourUtc === 0 || sunsetHourUtc === 1).toBe(true);
    expect(z.hebrewDate).toMatch(/Tamuz|Sivan/);
  });

  it('serves the calendar to any signed-in user but not to the public', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const ok = await api('GET', '/api/calendar/zmanim', { cookie: volunteer.cookie });
    expect(ok.status).toBe(200);

    const anonymous = await api('GET', '/api/calendar/zmanim');
    expect(anonymous.status).toBe(401);
  });
});
