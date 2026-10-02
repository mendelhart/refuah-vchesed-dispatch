import { describe, expect, it } from 'vitest';
import { buildGoogleAuthUrl, googleRedirectUri, parseGoogleReturn, randomState } from '../lib/google-signin';

describe('Google sign-in in the browser', () => {
  it('asks Google for an ID token only, with our one-time value and state', () => {
    const url = new URL(buildGoogleAuthUrl({ clientId: 'abc.apps.googleusercontent.com', nonce: 'N', state: 'S', redirectUri: googleRedirectUri('https://dispatch.example.org') }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'abc.apps.googleusercontent.com', redirect_uri: 'https://dispatch.example.org/auth/google',
      response_type: 'id_token', scope: 'openid email', nonce: 'N', state: 'S', prompt: 'select_account',
    });
  });

  it('reads the answer from the fragment, including a refusal', () => {
    expect(parseGoogleReturn('#state=S&id_token=a.b.c&authuser=0')).toEqual({ idToken: 'a.b.c', state: 'S' });
    expect(parseGoogleReturn('#error=access_denied&state=S')).toEqual({ error: 'access_denied', state: 'S' });
    expect(parseGoogleReturn('')).toEqual({});
  });

  it('makes a fresh random state each time', () => {
    const a = randomState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(randomState()).not.toBe(a);
  });
});
