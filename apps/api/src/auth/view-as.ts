import type { FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors.js';
import { loadSessionUser } from './session.js';

/**
 * "View as" preview for administrators.
 *
 * An admin's browser sends `X-View-As: <userId>`; for that request the server
 * answers as that user, so the admin sees exactly what the person sees, with
 * the same server-side permissions. It is read-only: anything other than a
 * read is refused, so a preview can never accept a ride, send a message or
 * change a setting in someone else's name. Only admins can do it, only for
 * active volunteers and dispatchers, and starting a preview is audited
 * (POST /api/admin/view-as/:id, sent without the header).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Signing out must still work mid-preview. */
const ALWAYS_AS_SELF = ['/api/auth/logout'];

export async function applyViewAs(req: FastifyRequest): Promise<void> {
  const raw = req.headers['x-view-as'];
  const target = Array.isArray(raw) ? raw[0] : raw;
  if (!target || !req.user) return;
  if (ALWAYS_AS_SELF.some((p) => req.url.startsWith(p))) return;
  if (req.user.role !== 'admin') throw Errors.forbidden('Only administrators can preview as another user.');
  if (!UUID.test(target)) throw Errors.forbidden('That preview is not valid.');
  if (!READ_METHODS.has(req.method)) {
    throw Errors.forbidden('Preview is read-only. Leave "View as" to make changes.');
  }
  const user = await loadSessionUser(target);
  if (!user || user.status !== 'active' || user.role === 'admin') {
    throw Errors.forbidden('You can preview active volunteers and coordinators only.');
  }
  req.viewAsBy = { id: req.user.id, fullName: req.user.fullName };
  req.user = { ...user, sessionId: req.user.sessionId };
}
