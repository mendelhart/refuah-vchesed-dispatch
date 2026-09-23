import { Errors } from './errors.js';

/**
 * Volunteer photos for the ID card.
 *
 * The browser shrinks the picture to a small JPEG before upload (about
 * 30-60 KB), and it is stored on the user row as a data URL. That keeps it in
 * the database, which survives redeploys, instead of on a server disk that
 * does not.
 */
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
export const MAX_PHOTO_BYTES = 400 * 1024;

export function parsePhotoDataUrl(input: string): { mime: string; bytes: Buffer } {
  const m = DATA_URL.exec(input);
  if (!m) throw Errors.validation('That photo could not be read. Use a JPEG or PNG picture.', { field: 'photo' });
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length === 0) throw Errors.validation('That photo is empty.', { field: 'photo' });
  if (bytes.length > MAX_PHOTO_BYTES) throw Errors.validation('That photo is too large.', { field: 'photo' });
  return { mime: m[1]!, bytes };
}

export function isStoredPhoto(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith('data:image/');
}

/** What lists send instead of the photo itself: a URL to fetch it from. */
export function photoUrlFor(userId: string, stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!isStoredPhoto(stored)) return stored;
  // Short version tag so a changed photo is not served from the browser cache.
  let h = 0;
  for (let i = stored.length - 200; i < stored.length; i += 1) h = (h * 31 + stored.charCodeAt(Math.max(i, 0))) | 0;
  return `/api/users/${userId}/photo?v=${(h >>> 0).toString(36)}`;
}
