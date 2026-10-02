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
import { navLabel, useI18n, type MessageKey } from '@/i18n';

const TITLES: Record<Exclude<NavSection, 'main'>, { title: MessageKey; subtitle: MessageKey }> = {
  more: { title: 'hub.more.title', subtitle: 'hub.more.subtitle' },
  admin: { title: 'hub.admin.title', subtitle: 'hub.admin.subtitle' },
  profile: { title: 'hub.profile.title', subtitle: 'hub.profile.subtitle' },
};

export function HubPage({ section }: { section: Exclude<NavSection, 'main'> }): React.JSX.Element {
  const { user } = useAuth();
  const features = useFeatures(Boolean(user));
  const role = user?.role ?? 'volunteer';
  const items = sectionItems(role, user?.navHidden, section, features);
  const { t } = useI18n();
  const title = t(TITLES[section].title);
  const subtitle = t(TITLES[section].subtitle);
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
                <Icon className="h-5 w-5 flex-shrink-0 text-[#C80023] dark:text-red-400" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-slate-900 dark:text-white">{navLabel(t, item.to, item.label)}</span>
                  {item.hint ? (
                    <span className="block text-sm text-slate-500 dark:text-slate-400">{item.hint}</span>
                  ) : null}
                </span>
                <ChevronRight className="h-5 w-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
      {section === 'more' ? (
        <p className="pt-2 text-center text-sm text-slate-500 dark:text-slate-400">
          <Link to="/privacy" className="underline">Privacy notice</Link>
        </p>
      ) : null}
    </div>
  );
}
