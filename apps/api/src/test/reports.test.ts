import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { addDaysToDateString, localDateString } from '../lib/time.js';
import { toCsv } from '../domain/reports.service.js';

/** Reports (item 8). */
describe('reports', () => {
  let admin: TestUser;
  let coord: TestUser;
  let vol: TestUser;
  let vol2: TestUser;
  const today = localDateString(new Date());
  const original = env.REPORTS_ENABLED;

  /** A trip that happened `daysAgo` days ago, in the given state. */
  async function trip(type: string, status: 'completed' | 'cancelled' | 'pending', daysAgo: number, opts: { isTest?: boolean; volunteer?: TestUser; assignedAfterMinutes?: number } = {}) {
    const res = await api('POST', '/api/trips', {
      cookie: coord.cookie,
      payload: sampleTrip(type === 'hospital_food' ? { tripType: type, callerName: null, callerPhone: null } : { tripType: type, callerPhone: `514-555-${String(1000 + Math.floor(Math.random() * 8999))}` }),
    });
    const id = (res.body.trip as { id: string }).id;
    const when = new Date(Date.now() - daysAgo * 86_400_000);
    const v = opts.volunteer ?? vol;
    await db.execute(raw`
      update trips set pickup_at = ${when.toISOString()}::timestamptz, created_at = ${when.toISOString()}::timestamptz - interval '1 day',
             is_test = ${opts.isTest ?? false}, status = ${status},
             assigned_volunteer_id = ${status === 'completed' ? v.id : null},
             assigned_at = ${status === 'completed' ? new Date(when.getTime() - 86_400_000 + (opts.assignedAfterMinutes ?? 30) * 60_000).toISOString() : null}::timestamptz,
             accepted_at = ${status === 'completed' ? when.toISOString() : null}::timestamptz,
             completed_at = ${status === 'completed' ? when.toISOString() : null}::timestamptz,
             cancelled_at = ${status === 'cancelled' ? when.toISOString() : null}::timestamptz,
             cancellation_reason = ${status === 'cancelled' ? 'test' : null}
       where id = ${id}`);
    return id;
  }

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    env.REPORTS_ENABLED = true;
    admin = await createTestUser({ role: 'admin', groups: [] });
    coord = await createTestUser({ role: 'dispatcher', groups: ['chesed_on_the_go', 'chaim_vchesed'] });
    vol = await createTestUser({ role: 'volunteer', groups: ['chesed_on_the_go', 'chaim_vchesed'] });
    vol2 = await createTestUser({ role: 'volunteer', groups: ['chesed_on_the_go', 'chaim_vchesed'] });
  });
  afterEach(() => { env.REPORTS_ENABLED = original; });

  const get = (path: string, who: TestUser = coord) => api('GET', path, { cookie: who.cookie });

  it('is off by default and 404 while off; volunteers are refused', async () => {
    expect(original).toBe(false);
    expect((await get('/api/reports/summary', vol)).status).toBe(403);
    env.REPORTS_ENABLED = false;
    expect((await get('/api/reports/summary')).status).toBe(404);
  });

  it('department totals for the range, test rides left out', async () => {
    await trip('ride', 'completed', 2, { volunteer: vol });
    await trip('ride', 'completed', 3, { volunteer: vol2 });
    await trip('ride', 'cancelled', 4);
    await trip('ride', 'completed', 5, { isTest: true });
    await trip('hospital_food', 'completed', 1);
    await trip('ride', 'completed', 60); // outside the default 30 days
    const res = await get('/api/reports/summary');
    expect(res.status).toBe(200);
    const d = res.body.departments as Record<string, { completed: number; cancelled: number; requested: number; volunteers: number }>;
    expect(d.rides).toMatchObject({ completed: 2, cancelled: 1, requested: 3, volunteers: 2 });
    expect(d.food).toMatchObject({ completed: 1 });
    const wide = await get(`/api/reports/summary?from=${addDaysToDateString(today, -90)}&to=${today}`);
    expect((wide.body.departments as Record<string, { completed: number }>).rides!.completed).toBe(3);
  });

  it('weekly trends include quiet weeks as zeros', async () => {
    await trip('ride', 'completed', 1);
    await trip('ride', 'completed', 22);
    const res = await get(`/api/reports/trends?from=${addDaysToDateString(today, -27)}&to=${today}&interval=week`);
    const periods = res.body.periods as Array<{ period: string; rides: number }>;
    expect(periods.length).toBeGreaterThanOrEqual(4);
    expect(periods.reduce((n, p) => n + p.rides, 0)).toBe(2);
    expect(periods.some((p) => p.rides === 0)).toBe(true);
  });

  it('staffing: share of rides that got a driver and the median wait', async () => {
    await trip('ride', 'completed', 2, { assignedAfterMinutes: 10 });
    await trip('ride', 'completed', 3, { assignedAfterMinutes: 30 });
    await trip('ride', 'completed', 4, { assignedAfterMinutes: 50 });
    await trip('ride', 'cancelled', 5);
    const res = await get('/api/reports/staffing');
    expect(res.body.rides).toMatchObject({ total: 4, covered: 3, coveredPercent: 75, unfilled: 1, medianMinutesToDriver: 30 });
  });

  it('equipment: status counts and overdue loans; borrower names for admins only', async () => {
    const [eq] = await db.execute<{ id: string }>(raw`insert into equipment (item_code, equipment_type, status) values ('W-1', 'wheelchair', 'loaned') returning id`);
    await db.execute(raw`insert into equipment_loans (equipment_id, borrower_name, borrower_phone, expected_return_at)
                         values (${eq!.id}, 'Private Person', '+15145550199', now() - interval '3 days')`);
    const asCoord = await get('/api/reports/equipment');
    expect(asCoord.body.byStatus).toEqual({ loaned: 1 });
    // The report counts days against the database's current_date but the due date in Toronto time, so
    // the answer is 3 or 4 depending on the hour. Derive it the same way instead of assuming 3.
    const [exp] = await db.execute<{ d: number }>(raw`select (current_date - ((now() - interval '3 days') at time zone 'America/Toronto')::date)::int as d`);
    expect(asCoord.body.overdue).toEqual([{ itemCode: 'W-1', type: 'wheelchair', daysOverdue: exp!.d }]);
    const asAdmin = await get('/api/reports/equipment', admin);
    expect((asAdmin.body.overdue as Array<{ borrower?: string }>)[0]!.borrower).toBe('Private Person');
  });

  it('CSV export: a file with no personal data, formulas neutralised, audited', async () => {
    await trip('ride', 'completed', 2);
    const res = await get('/api/reports/export.csv?report=summary');
    expect(res.status).toBe(200);
    expect(res.raw.headers['content-type']).toMatch(/text\/csv/);
    expect(res.raw.headers['content-disposition']).toMatch(/attachment; filename="rvc-summary-/);
    const text = res.raw.body;
    expect(text.split('\r\n')[0]).toBe('department,requested,completed,cancelled,volunteers,people helped');
    expect(text).toMatch(/^rides,1,1,0,1,1$/m);
    expect(text).not.toMatch(/Sara Klein|514/);
    expect(toCsv(['a'], [['=HYPERLINK("x")'], ['a,b']])).toBe('a\r\n"\'=HYPERLINK(""x"")"\r\n"a,b"\r\n');
    const audit = await db.execute(raw`select 1 from audit_events where action = 'report.exported'`);
    expect(audit.length).toBe(1);
  });

  it('refuses a backwards or enormous range', async () => {
    expect((await get(`/api/reports/summary?from=${today}&to=${addDaysToDateString(today, -1)}`)).status).toBe(422);
    expect((await get(`/api/reports/summary?from=2020-01-01&to=${today}`)).status).toBe(422);
  });

  it('with departments on, only the reports department sees reports', async () => {
    const before = env.DEPARTMENT_SCOPING_ENABLED;
    env.DEPARTMENT_SCOPING_ENABLED = true;
    try {
      await db.execute(raw`insert into department_members (department_id, user_id) select id, ${coord.id} from departments where slug = 'food'`);
      expect((await get('/api/reports/summary')).status).toBe(403);
      await db.execute(raw`insert into department_members (department_id, user_id) select id, ${coord.id} from departments where slug = 'reports'`);
      expect((await get('/api/reports/summary')).status).toBe(200);
    } finally {
      env.DEPARTMENT_SCOPING_ENABLED = before;
    }
  });
});
