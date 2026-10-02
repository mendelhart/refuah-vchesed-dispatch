/**
 * English: the source catalog. Every key used in the app is defined here;
 * French and Hebrew must define the same keys (test/i18n.test.ts fails on a
 * missing or extra key). Keep sentences short and plain.
 */
export const en = {
  'lang.name': 'English',
  'lang.label': 'Language',
  'lang.hint': 'The app speaks this language. Messages we send follow later.',
  'lang.saved': 'Language saved.',

  // Sign in
  'login.subtitle': 'Volunteer medical transport, Montreal',
  'login.identifier': 'Email or mobile number',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.signedIn': 'Signed in.',
  'login.forgot': 'I forgot my password',
  'login.resetRequested': 'Reset link requested',
  'login.enterEmailFirst': 'Enter your email address first, then tap this again.',
  'login.resetSent': 'If that address is registered, a reset link is on its way.',
  'login.newVolunteer': 'New volunteer with an invitation?',
  'login.setUp': 'Set up your account',
  'login.privacy': 'Privacy notice',
  'login.or': 'or',
  'login.google': 'Sign in with Google',
  'login.googleWorking': 'Signing you in with Google…',
  'login.googleFailed': 'Google sign-in did not work. Try again, or sign in with your password.',
  'login.backToSignIn': 'Back to sign-in',

  // Main menu (by route)
  'nav./': 'Home',
  'nav./board': 'Dispatch board',
  'nav./messages': 'Messages',
  'nav./volunteers': 'Volunteers',
  'nav./contacts': 'Contacts',
  'nav./calls': 'Call log',
  'nav./recurring': 'Standing rides',
  'nav./equipment': 'Equipment',
  'nav./my-trips': 'My rides',
  'nav./me': 'My profile',
  'nav./my-availability': 'My availability',
  'nav./my-profile': 'What I can help with',
  'nav./my-id-card': 'My ID card',
  'nav./settings': 'Settings',
  'nav./directory': 'Directory',
  'nav./food': 'Food',
  'nav./kitchen': 'Help in the kitchen',
  'nav./lift-assist': 'Lift assist',
  'nav./duty': 'Phone duty',
  'nav./more': 'More',
  'nav./admin': 'Admin',
  'nav.profileShort': 'Profile',
  'nav.boardShort': 'Board',

  // Hub pages
  'hub.more.title': 'More',
  'hub.more.subtitle': 'Everything else, one tap away',
  'hub.admin.title': 'Admin',
  'hub.admin.subtitle': 'Accounts, messages, records and settings',
  'hub.profile.title': 'My profile',
  'hub.profile.subtitle': 'Your hours, what you can help with, your card and settings',

  // Shared states
  'state.loading': 'Loading',
  'state.retry': 'Try again',
  'state.offline': 'You are offline. What you see may be out of date.',
} as const;

export type MessageKey = keyof typeof en;
