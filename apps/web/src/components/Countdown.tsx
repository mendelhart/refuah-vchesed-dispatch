import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { countdown } from '@/lib/format';

/**
 * Live "time left on this offer" chip. A dispatcher needs to know whether an
 * offer is about to lapse without doing arithmetic on a timestamp.
 */
export function OfferCountdown({ expiresAt }: { expiresAt: string | null }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const remaining = countdown(expiresAt, now);

  if (!remaining) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200">
        <Timer className="h-3 w-3" aria-hidden="true" />
        Offer window closed
      </span>
    );
  }

  const urgent = new Date(expiresAt).getTime() - now < 5 * 60_000;
  return (
    <span
      className={
        urgent
          ? 'inline-flex items-center gap-1 rounded-full bg-[#EA0029] px-2 py-1 text-xs font-semibold text-white'
          : 'inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-1 text-xs font-medium text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-300'
      }
      aria-label={`Offer expires in ${remaining}`}
    >
      <Timer className="h-3 w-3" aria-hidden="true" />
      {remaining} left
    </span>
  );
}
