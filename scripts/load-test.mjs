#!/usr/bin/env node
/* global URL, fetch, URLSearchParams, performance, setTimeout, console, process */
/**
 * load-test.mjs — a busy hour, squeezed into a minute, against a TEST API.
 *
 * Never point this at the live site: it creates rides. It is meant for a
 * local or CI API seeded with `npm run db:seed` (the @refuahvchesed.test
 * accounts).
 *
 * Model: every seeded account is signed in with several open "tabs" (phones),
 * each refreshing its screens about once a second, which is far busier than
 * the real app's 15-30 second refreshes. Meanwhile the dispatcher takes a
 * new call every few seconds. Each account stays under the API's 300
 * requests/minute limit so the numbers measure the app, not the limiter.
 *
 * Usage:
 *   API=http://127.0.0.1:8080 node scripts/load-test.mjs [--seconds 60] [--tabs 4]
 * Exits non-zero on any server error or if p95 exceeds --p95-ms (default 1500).
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
const API = process.env.API ?? 'http://127.0.0.1:8080';
const SECONDS = Number(args.seconds ?? 60);
const TABS = Number(args.tabs ?? 4);
const P95_LIMIT = Number(args['p95-ms'] ?? 1500);
const PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMeInDev123!';

if (/onrender\.com|refuah/i.test(new URL(API).hostname) && !process.env.I_KNOW_THIS_IS_NOT_LIVE) {
  console.error(`Refusing to load-test ${API}: this script creates rides. Use a local or CI API.`);
  process.exit(2);
}

const ACCOUNTS = [
  { email: 'dispatch@refuahvchesed.test', kind: 'staff', createsTrips: true },
  { email: 'admin@refuahvchesed.test', kind: 'staff' },
  { email: 'volunteer1@refuahvchesed.test', kind: 'volunteer' },
  { email: 'volunteer2@refuahvchesed.test', kind: 'volunteer' },
  { email: 'volunteer3@refuahvchesed.test', kind: 'volunteer' },
];

const SCREENS = {
  staff: ['/api/trips?scope=board&limit=100', '/api/trips/summary', '/api/board/context', '/api/auth/me'],
  volunteer: ['/api/trips?scope=available&limit=100', '/api/trips?scope=mine&limit=100', '/api/auth/me'],
};

const timings = new Map(); // label -> ms[]
const failures = new Map(); // label -> { status: count }
let limited = 0;

function record(label, ms, status) {
  if (!timings.has(label)) timings.set(label, []);
  timings.get(label).push(ms);
  if (status === 429) limited += 1;
  else if (status >= 500 || status === 0) {
    const f = failures.get(label) ?? {};
    f[status] = (f[status] ?? 0) + 1;
    failures.set(label, f);
  }
}

async function call(cookie, method, path, body) {
  const started = performance.now();
  let status = 0;
  let json = null;
  try {
    const res = await fetch(API + path, {
      method,
      headers: { Accept: 'application/json', Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  const label = `${method} ${path.split('?')[0]}${path.includes('scope=') ? ` (${new URLSearchParams(path.split('?')[1]).get('scope')})` : ''}`;
  record(label, performance.now() - started, status);
  return { status, json };
}

async function signIn(email) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');
  return cookie;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + SECONDS * 1000;

async function tab(cookie, kind) {
  const screens = SCREENS[kind];
  let i = Math.floor(Math.random() * screens.length);
  while (Date.now() < deadline) {
    await call(cookie, 'GET', screens[i % screens.length]);
    i += 1;
    await sleep(800 + Math.random() * 400);
  }
}

let created = 0;
let createError = null;
async function dispatcherTakingCalls(cookie) {
  while (Date.now() < deadline) {
    const pickupAt = new Date(Date.now() + (1 + Math.random() * 48) * 3600_000).toISOString();
    const n = created + 1;
    const { status, json } = await call(cookie, 'POST', '/api/trips', {
      callerName: `Load test caller ${n}`,
      callerPhone: '514-555-0' + String(100 + (n % 900)).padStart(3, '0'),
      pickup: { line1: '5800 Rue Hutchison', city: 'Montreal', province: 'QC', country: 'CA' },
      dropoff: { line1: '3755 Chemin de la Cote-Sainte-Catherine', city: 'Montreal', province: 'QC', country: 'CA' },
      pickupAt,
      tripType: 'ride',
      priority: n % 7 === 0 ? 'urgent' : 'routine',
      groupSlug: 'chesed_on_the_go',
      // Held for a coordinator, so the test does not fan offers out to volunteers.
      assignmentMode: 'admin_approval',
      mobilityNeeds: [],
      passengerNotes: 'load test',
    });
    if (status >= 200 && status < 300) created += 1;
    else if (!createError) createError = `${status} ${JSON.stringify(json)}`;
    await sleep(3000);
  }
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const sessions = [];
for (const account of ACCOUNTS) sessions.push({ ...account, cookie: await signIn(account.email) });
console.log(`→ ${sessions.length} accounts × ${TABS} tabs for ${SECONDS}s against ${API}`);

const work = [];
for (const s of sessions) {
  for (let t = 0; t < TABS; t += 1) work.push(tab(s.cookie, s.kind));
  if (s.createsTrips) work.push(dispatcherTakingCalls(s.cookie));
}
const startedAt = Date.now();
await Promise.all(work);
const elapsed = (Date.now() - startedAt) / 1000;

let all = [];
let worstP95 = 0;
const rows = [];
for (const [label, ms] of [...timings].sort()) {
  const sorted = [...ms].sort((a, b) => a - b);
  all = all.concat(sorted);
  const p95 = pct(sorted, 95);
  worstP95 = Math.max(worstP95, p95);
  rows.push({ endpoint: label, requests: sorted.length, p50: Math.round(pct(sorted, 50)), p95: Math.round(p95), max: Math.round(sorted.at(-1)) });
}
console.table(rows);
all.sort((a, b) => a - b);
const errors = [...failures.values()].reduce((sum, f) => sum + Object.values(f).reduce((a, b) => a + b, 0), 0);
console.log(
  `total ${all.length} requests in ${elapsed.toFixed(0)}s (${(all.length / elapsed).toFixed(1)}/s), ` +
    `p50 ${Math.round(pct(all, 50))}ms, p95 ${Math.round(pct(all, 95))}ms, rides created ${created}, ` +
    `server errors ${errors}, rate-limited ${limited}`,
);
if (errors) console.log('errors by endpoint:', Object.fromEntries(failures));
if (createError) console.log('first failed ride creation:', createError);
if (errors > 0 || worstP95 > P95_LIMIT || created === 0) {
  console.error(`FAIL: ${errors} server errors, worst p95 ${Math.round(worstP95)}ms (limit ${P95_LIMIT}), ${created} rides created`);
  process.exit(1);
}
console.log('PASS');
