import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createTestUser, getApp, resetDb, shutdown, type TestUser } from './harness.js';

// 1x1 white JPEG.
const PHOTO =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

describe('ID card photos', () => {
  let admin: TestUser;
  let volunteer: TestUser;
  let other: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin' });
    volunteer = await createTestUser({ role: 'volunteer' });
    other = await createTestUser({ role: 'volunteer' });
  });

  it('lets a volunteer set their own photo and shows it on the card', async () => {
    expect((await api('PUT', '/api/me/photo', { cookie: volunteer.cookie, payload: { photo: PHOTO } })).status).toBe(200);
    const card = await api('GET', '/api/me/id-card', { cookie: volunteer.cookie });
    expect((card.body.card as { photo: string | null }).photo).toBe(PHOTO);
  });

  it('refuses a volunteer setting someone else\'s photo, allows an admin', async () => {
    expect((await api('PUT', `/api/users/${other.id}/photo`, { cookie: volunteer.cookie, payload: { photo: PHOTO } })).status).toBe(403);
    expect((await api('PUT', `/api/users/${other.id}/photo`, { cookie: admin.cookie, payload: { photo: PHOTO } })).status).toBe(200);
    const img = await api('GET', `/api/users/${other.id}/photo`, { cookie: volunteer.cookie });
    expect(img.status).toBe(200);
  });

  it('rejects something that is not a picture', async () => {
    const res = await api('PUT', '/api/me/photo', { cookie: volunteer.cookie, payload: { photo: 'data:text/html;base64,PGgxPg==' } });
    expect(res.status).toBe(422);
  });

  it('shows the photo on the public QR check page for a current card only', async () => {
    await api('PUT', '/api/me/photo', { cookie: volunteer.cookie, payload: { photo: PHOTO } });
    const card = await api('GET', '/api/me/id-card', { cookie: volunteer.cookie });
    const token = (card.body.card as { verificationCode: string }).verificationCode;
    expect(token).toBeTruthy();
    const check = await api('GET', `/api/id-card/verify/${token}`);
    expect(check.body.valid).toBe(true);
    expect(check.body.photo).toBe(PHOTO);
    expect(check.body).not.toHaveProperty('phone');
  });
});
