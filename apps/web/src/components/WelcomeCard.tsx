import React from 'react';
import { Link } from 'react-router-dom';
import { CalendarRange, ChevronRight, IdCard, ListChecks, X } from 'lucide-react';
import { cardClass } from '@/components/states';

/**
 * First-time help for a new volunteer, on Home. Shown until they close it or
 * complete a first ride. Remembered per person on this device only; there is
 * nothing to store on the server.
 */
const STEPS = [
  { to: '/my-availability', icon: CalendarRange, title: 'Tell us when you are free', hint: 'We only ask you at those times.' },
  { to: '/my-profile', icon: ListChecks, title: 'Say what you can help with', hint: 'Rides, deliveries, your car and how many seats.' },
  { to: '/my-id-card', icon: IdCard, title: 'Add a photo to your ID card', hint: 'Hospital desks use it to check who you are.' },
];

function storageKey(userId: string): string {
  return `rvc.welcome.closed.${userId}`;
}

export function WelcomeCard({ userId, completedRides }: { userId: string; completedRides: number | undefined }): React.JSX.Element | null {
  const [closed, setClosed] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem(storageKey(userId)) === '1';
    } catch {
      return false;
    }
  });
  // Wait for the numbers, then only show to someone who has not done a ride yet.
  if (closed || completedRides === undefined || completedRides > 0) return null;

  const close = (): void => {
    try {
      window.localStorage.setItem(storageKey(userId), '1');
    } catch {
      /* private mode: just hide it for now */
    }
    setClosed(true);
  };

  return (
    <section className={`${cardClass} border-[#EA0029]/30`} aria-label="Getting started">
      <div className="p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Welcome! Three quick steps</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              When a ride comes up that fits you, we send it to you. Tap it to see the details and say yes if you can.
              The first volunteer to say yes gets it, and the office can see who took it.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="-m-2 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close getting started"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <ul className="mt-4 space-y-2">
          {STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <li key={step.to}>
                <Link
                  to={step.to}
                  className="flex min-h-[56px] items-center gap-3 rounded-lg bg-slate-50 p-3 hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800"
                >
                  <Icon className="h-5 w-5 flex-shrink-0 text-[#EA0029]" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-slate-900 dark:text-white">{step.title}</span>
                    <span className="block text-sm text-slate-500 dark:text-slate-400">{step.hint}</span>
                  </span>
                  <ChevronRight className="h-5 w-5 text-slate-400" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Questions? Call the office. You can close this and find these screens later under My profile.
        </p>
      </div>
    </section>
  );
}
