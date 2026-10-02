/**
 * Puts the language provider around the app: asks the server which languages
 * are switched on (public, so the sign-in page can offer them) and, once
 * someone is signed in, follows the language saved on their account.
 */
import React, { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { I18nProvider, isLocale, useI18n, type Locale } from './index';

function FollowAccount(): null {
  const { user } = useAuth();
  const { available, locale, setLocale } = useI18n();
  const q = useQuery({
    queryKey: ['me', 'locale', user?.id],
    queryFn: () => api.get<{ locale: string }>('/api/me/locale'),
    enabled: Boolean(user) && available.length > 1,
    staleTime: 300_000,
  });
  // Apply the account's language once per sign-in; after that the person's
  // own choice on this device wins until it is saved back.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const saved = q.data?.locale;
    if (!user || applied.current === user.id || !isLocale(saved)) return;
    applied.current = user.id;
    if (available.includes(saved) && saved !== locale) setLocale(saved);
  }, [q.data, available, locale, setLocale, user]);
  return null;
}

export function LanguageRoot({ children }: { children: React.ReactNode }): React.JSX.Element {
  const q = useQuery({
    queryKey: ['public', 'languages'],
    queryFn: () => api.get<{ available: string[] }>('/api/public/languages'),
    staleTime: 300_000,
    retry: 1,
  });
  const available = (q.data?.available ?? ['en']).filter(isLocale) as Locale[];
  return (
    <I18nProvider available={available}>
      <FollowAccount />
      {children}
    </I18nProvider>
  );
}
