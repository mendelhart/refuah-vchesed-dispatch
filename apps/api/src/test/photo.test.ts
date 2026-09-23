import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createTestUser, getApp, resetDb, shutdown, type TestUser } from './harness.js';

// 1x1 white JPEG.
const PHOTO =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

describe('ID card photos', () => {
  let admin: TestUser;
  let volunteer: TestUser;
  let other: TestUser;
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin' });
    volunteer = await createTestUser({ role: 'volunteer' });
    other = await createTestUser({ role: 'volunteer' });
    dispatcher = await createTestUser({ role: 'dispatcher' });
  });

  const cardPhoto = async (who: TestUser) =>
    ((await api('GET', '/api/me/id-card', { cookie: who.cookie })).body.card as { photo: string | null }).photo;

  it("a volunteer's new photo waits for approval, then shows on the card", async () => {
    const put = await api('PUT', '/api/me/photo', { cookie: volunteer.cookie, payload: { photo: PHOTO } });
    expect(put.status).toBe(200);
    expect(put.body.pending).toBe(true);
    expect(await cardPhoto(volunteer)).toBeNull();
    const mine = await api('GET', '/api/me/photo', { cookie: volunteer.cookie });
    expect((mine.body.pending as { action: string }).action).toBe('set');

    const list = await api('GET', '/api/photo-requests', { cookie: dispatcher.cookie });
    expect((list.body.requests as Array<{ userId: string }>).map((r) => r.userId)).toContain(volunteer.id);
    expect((await api('POST', `/api/photo-requests/${volunteer.id}/approve`, { cookie: dispatcher.cookie })).status).toBe(200);
    expect(await cardPhoto(volunteer)).toBe(PHOTO);
    expect((await api('GET', '/api/me/photo', { cookie: volunteer.cookie })).body.pending).toBeNull();
  });

  it('a removal also waits; a rejected change leaves the card as it was', async () => {
    await api('PUT', `/api/users/${volunteer.id}/photo`, { cookie: admin.cookie, payload: { photo: PHOTO } });
    await api('DELETE', '/api/me/photo', { cookie: volunteer.cookie });
    expect(await cardPhoto(volunteer)).toBe(PHOTO);
    expect((await api('POST', `/api/photo-requests/${volunteer.id}/reject`, { cookie: admin.cookie })).status).toBe(200);
    expect(await cardPhoto(volunteer)).toBe(PHOTO);
    await api('DELETE', '/api/me/photo', { cookie: volunteer.cookie });
    await api('POST', `/api/photo-requests/${volunteer.id}/approve`, { cookie: admin.cookie });
    expect(await cardPhoto(volunteer)).toBeNull();
  });

  it('a volunteer can withdraw a pending change', async () => {
    await api('PUT', '/api/me/photo', { cookie: volunteer.cookie, payload: { photo: PHOTO } });
    await api('DELETE', '/api/me/photo/pending', { cookie: volunteer.cookie });
    expect((await api('POST', `/api/photo-requests/${volunteer.id}/approve`, { cookie: admin.cookie })).status).toBe(409);
  });

  it('volunteers cannot approve; coordinators cannot approve their own; admins apply their own directly', async () => {
    await api('PUT', '/api/me/photo', { cookie: other.cookie, payload: { photo: PHOTO } });
    expect((await api('GET', '/api/photo-requests', { cookie: volunteer.cookie })).status).toBe(403);
    expect((await api('POST', `/api/photo-requests/${other.id}/approve`, { cookie: volunteer.cookie })).status).toBe(403);

    await api('PUT', '/api/me/photo', { cookie: dispatcher.cookie, payload: { photo: PHOTO } });
    expect((await api('POST', `/api/photo-requests/${dispatcher.id}/approve`, { cookie: dispatcher.cookie })).status).toBe(403);
    const list = await api('GET', '/api/photo-requests', { cookie: dispatcher.cookie });
    expect((list.body.requests as Array<{ userId: string }>).map((r) => r.userId)).not.toContain(dispatcher.id);

    const own = await api('PUT', '/api/me/photo', { cookie: admin.cookie, payload: { photo: PHOTO } });
    expect(own.body.pending).toBe(false);
    expect((await api('GET', '/api/me/photo', { cookie: admin.cookie })).body.photo).toBe(PHOTO);
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
    await api('POST', `/api/photo-requests/${volunteer.id}/approve`, { cookie: admin.cookie });
    const card = await api('GET', '/api/me/id-card', { cookie: volunteer.cookie });
    const token = (card.body.card as { verificationCode: string }).verificationCode;
    expect(token).toBeTruthy();
    const check = await api('GET', `/api/id-card/verify/${token}`);
    expect(check.body.valid).toBe(true);
    expect(check.body.photo).toBe(PHOTO);
    expect(check.body).not.toHaveProperty('phone');
  });
});
