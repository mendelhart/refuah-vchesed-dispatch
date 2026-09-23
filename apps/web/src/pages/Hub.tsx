/**
 * One-tap hubs that keep the main menu short: More, Admin and My profile.
 * Each lists the screens of its section for the signed-in person.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useFeatures } from '@/lib/features';
import { sectionItems, type NavSection } from '@/components/Layout';
import { PageHeader, cardClass } from '@/components/states';

const TITLES: Record<Exclude<NavSection, 'main'>, { title: string; subtitle: string }> = {
  more: { title: 'More', subtitle: 'Everything else, one tap away' },
  admin: { title: 'Admin', subtitle: 'Accounts, messages, records and settings' },
  profile: { title: 'My profile', subtitle: 'Your hours, what you can help with, your card and settings' },
};

export function HubPage({ section }: { section: Exclude<NavSection, 'main'> }): React.JSX.Element {
  const { user } = useAuth();
  const features = useFeatures(Boolean(user));
  const role = user?.role ?? 'volunteer';
  const items = sectionItems(role, user?.navHidden, section, features);
  const { title, subtitle } = TITLES[section];
  return (
    <div className="space-y-4">
      <PageHeader title={title} subtitle={subtitle} />
      <ul className="space-y-2">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                className={`${cardClass} flex min-h-[56px] items-center gap-3 p-4 hover:bg-slate-50 dark:hover:bg-slate-800`}
              >
                <Icon className="h-5 w-5 flex-shrink-0 text-[#EA0029]" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-slate-900 dark:text-white">{item.label}</span>
                  {item.hint ? (
                    <span className="block text-sm text-slate-500 dark:text-slate-400">{item.hint}</span>
                  ) : null}
                </span>
                <ChevronRight className="h-5 w-5 text-slate-400" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
