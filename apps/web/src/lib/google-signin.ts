/**
 * Google sign-in (item 9) in the browser. The page goes to Google with the
 * one-time value the API handed out, and Google sends it back to
 * /auth/google with a signed ID token in the address fragment (never sent to
 * any server by the browser). No Google script is loaded, so the app's
 * content security policy is unchanged.
 */

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const STATE_KEY = 'rvc.google.state';

export function googleRedirectUri(origin: string): string {
  return `${origin}/auth/google`;
}

export function buildGoogleAuthUrl(p: { clientId: string; nonce: string; state: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'id_token',
    scope: 'openid email',
    nonce: p.nonce,
    state: p.state,
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH}?${q.toString()}`;
}

/** Reads Google's answer out of the address fragment. */
export function parseGoogleReturn(hash: string): { idToken?: string; state?: string; error?: string } {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  return {
    ...(q.get('id_token') ? { idToken: q.get('id_token')! } : {}),
    ...(q.get('state') ? { state: q.get('state')! } : {}),
    ...(q.get('error') ? { error: q.get('error')! } : {}),
  };
}

export function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
