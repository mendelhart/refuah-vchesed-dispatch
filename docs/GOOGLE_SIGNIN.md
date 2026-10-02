# Google sign-in (item 9)

**Status: built, switched off. Needs Mendel's OK, with the exact diff, before it is merged or switched on.**

## What it does

- The sign-in page shows **Sign in with Google** under the usual form, only when Google sign-in is switched on.
- Only people an administrator approved by name (Admin > Google sign-in) can get in this way. The Google address must be the same as the email on their account.
- It signs in an **existing, active account** and nothing else. It never creates an account, never changes a role, and does not skip the app's own two-step check for the roles that need it.
- Password sign-in is unchanged. Nobody loses the password route.

## What it does not change

- No existing table or column. Two new tables (migration `0030_google_signin.sql`): `google_signin_approvals` and `google_signin_nonces`.
- The login route, the session cookie, the lockout rules and two-step checks are unchanged. Google sign-in creates the same kind of session through the same function.
- No Google script is loaded in the app, and the content security policy (`deploy/security-headers.conf`) is unchanged. The browser goes to Google's sign-in page and comes back.
- No client secret. The only setting is the client ID, which Google treats as public.

## How it works

1. The sign-in page asks the API for a one-time value (`POST /api/auth/google/start`). The API keeps a hash of it and puts the value in a short-lived cookie that only the Google sign-in routes can read.
2. The browser goes to Google and asks only for an ID token (`response_type=id_token`, `scope=openid email`), with that one-time value and a random state kept in the tab.
3. Google sends the browser back to `/auth/google` with the signed token in the part of the address that browsers never send to servers. The page checks the state, removes the token from the address bar, and sends the token to `POST /api/auth/google`.
4. The API checks five things:
   - the signature against Google's published keys
   - that the token was issued by Google for our client ID
   - that it has not expired
   - that Google verified the email address
   - that it carries the one-time value from step 1, which is then used up
5. The API looks for a live approval whose address matches both the token and the account email, on an active account. It then signs the person in exactly as a password sign-in would, and records `auth.login` with `method: google` in the audit log.

## To switch it on (Mendel)

1. In Google Cloud console, create an OAuth client of type **Web application**.
   - Authorised JavaScript origin: the app's address, e.g. `https://dispatch.example.org`.
   - Authorised redirect URI: `https://<the app's address>/auth/google`.
2. On the API service, set:
   - `GOOGLE_CLIENT_ID=<the client ID ending in .apps.googleusercontent.com>`
   - `GOOGLE_SIGNIN_ENABLED=true`
3. In the app, go to Admin > Google sign-in and approve people one by one.

To switch it off, set `GOOGLE_SIGNIN_ENABLED=false`. Approvals stay stored, unused.

## Decisions for Mendel

- **Who can be approved.** Any active account with an email address, volunteers included. Should it be staff only?
- **Existing sessions.** Removing someone's approval stops new Google sign-ins. It does not end sessions already open. Should it also sign them out everywhere?
- **One Google address per account.** The account email must be the Google address. People whose Google address differs from their account email need their account email changed first.
