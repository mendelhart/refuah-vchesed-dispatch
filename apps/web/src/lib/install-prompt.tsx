import React from 'react';
import { Download, X } from 'lucide-react';

/**
 * The "add to home screen" prompt.
 *
 * Timing is the whole design. Prompting a volunteer on their first visit, before
 * they have any reason to want the app on their home screen, is how an install
 * prompt gets dismissed permanently — and once dismissed, the browser will not
 * offer it again. So this waits until they have actually completed a ride: at
 * that moment installing means "get the next one as a notification instead of a
 * text", which is a sentence that makes sense to them.
 *
 * `beforeinstallprompt` only fires on Chromium, and only when the browser
 * considers the app installable. iOS Safari never fires it, so that path shows
 * the manual instructions instead — which is the platform most volunteers here
 * are actually on.
 */

const DISMISSED_KEY = 'rvc.install.dismissed';
const ELIGIBLE_KEY = 'rvc.install.eligible';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    // Private browsing, or storage disabled. Not a reason to break the app.
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    /* ignore */
  }
}

/** Call this when a volunteer completes a ride. */
export function markInstallEligible(): void {
  writeFlag(ELIGIBLE_KEY);
  window.dispatchEvent(new Event('rvc:install-eligible'));
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS reports installed apps this way rather than through display-mode.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

export function InstallPrompt(): React.JSX.Element | null {
  const [deferred, setDeferred] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [eligible, setEligible] = React.useState(() => readFlag(ELIGIBLE_KEY));
  const [dismissed, setDismissed] = React.useState(() => readFlag(DISMISSED_KEY));

  React.useEffect(() => {
    const onBeforeInstall = (event: Event): void => {
      // Stop Chrome showing its own mini-infobar; we choose the moment.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onEligible = (): void => setEligible(true);

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('rvc:install-eligible', onEligible);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('rvc:install-eligible', onEligible);
    };
  }, []);

  if (dismissed || !eligible || isStandalone()) return null;
  if (!deferred && !isIos()) return null;

  const dismiss = (): void => {
    writeFlag(DISMISSED_KEY);
    setDismissed(true);
  };

  const install = async (): Promise<void> => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    // Either way the event is spent and cannot be reused.
    setDeferred(null);
    dismiss();
  };

  return (
    <div
      role="dialog"
      aria-label="Add Refuah V'Chesed to your home screen"
      className="fixed inset-x-3 bottom-20 z-50 rounded-xl border border-slate-200 bg-white p-4 shadow-lg lg:inset-x-auto lg:right-6 lg:bottom-6 lg:max-w-sm dark:border-slate-700 dark:bg-slate-900"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 h-5 w-5 shrink-0 text-[#E31E24]" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900 dark:text-white">
            Thank you for that ride
          </p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {isIos() && !deferred
              ? 'Add this to your home screen and the next request arrives as a notification instead of a text. Tap Share, then “Add to Home Screen”.'
              : 'Add this to your home screen and the next request arrives as a notification instead of a text.'}
          </p>
          {deferred ? (
            <button
              type="button"
              onClick={() => void install()}
              className="mt-3 min-h-[44px] w-full rounded-lg bg-[#E31E24] px-4 text-sm font-semibold text-white hover:bg-[#c41a1f]"
            >
              Add to home screen
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now"
          className="-m-1 rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
