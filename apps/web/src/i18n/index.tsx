/**
 * Languages (item 7).
 *
 * One catalog per language (en.ts is the source). t('key') returns the
 * string in the current language, falls back to English, and never shows a
 * raw key. Which languages can be chosen is decided by the server
 * (LANGUAGES_ENABLED, default English only), so a language appears only
 * after a person has reviewed its translation. Hebrew is shown right to left.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { en, type MessageKey } from './en';
import { fr } from './fr';
import { he } from './he';

export const CATALOGS = { en, fr, he } as const;
export type Locale = keyof typeof CATALOGS;
export const LOCALES = Object.keys(CATALOGS) as Locale[];
export const RTL: ReadonlySet<Locale> = new Set(['he']);
const STORAGE_KEY = 'rvc.locale';

export function isLocale(x: unknown): x is Locale {
  return typeof x === 'string' && (LOCALES as string[]).includes(x);
}

/** Pure lookup, used by the provider and by tests. */
export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const raw = (CATALOGS[locale] as Record<string, string>)[key] ?? (en as Record<string, string>)[key] ?? '';
  return vars ? raw.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? '')) : raw;
}

/** The language to start in: saved choice, else the phone's language, else English. */
export function initialLocale(available: Locale[], saved: string | null, browser: readonly string[]): Locale {
  if (isLocale(saved) && available.includes(saved)) return saved;
  for (const tag of browser) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base) && available.includes(base)) return base;
  }
  return 'en';
}

interface I18nValue {
  locale: Locale;
  available: Locale[];
  dir: 'ltr' | 'rtl';
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  setLocale: (l: Locale) => void;
  /** Dates and times in the reader's language, Montreal time. */
  formatDateTime: (iso: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function readSaved(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function I18nProvider({ available, children }: { available: Locale[]; children: React.ReactNode }): React.JSX.Element {
  const usable = available.length ? available : (['en'] as Locale[]);
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale(usable, readSaved(), typeof navigator === 'undefined' ? [] : navigator.languages ?? []));
  // If a language is switched off while someone uses it, fall back quietly.
  const current: Locale = usable.includes(locale) ? locale : 'en';
  const dir = RTL.has(current) ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = current === 'en' ? 'en-CA' : current === 'fr' ? 'fr-CA' : 'he';
    document.documentElement.dir = dir;
  }, [current, dir]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { window.localStorage.setItem(STORAGE_KEY, l); } catch { /* not worth an error */ }
  }, []);

  const value = useMemo<I18nValue>(() => {
    const intlTag = current === 'en' ? 'en-CA' : current === 'fr' ? 'fr-CA' : 'he-IL';
    const dt = new Intl.DateTimeFormat(intlTag, { timeZone: 'America/Toronto', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return {
      locale: current,
      available: usable,
      dir,
      t: (key, vars) => translate(current, key, vars),
      setLocale,
      formatDateTime: (iso: string) => dt.format(new Date(iso)),
    };
  }, [current, dir, setLocale, usable]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Works outside a provider too (English), so a screen never breaks. */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return {
    locale: 'en', available: ['en'], dir: 'ltr', setLocale: () => {},
    t: (key, vars) => translate('en', key, vars),
    formatDateTime: (iso: string) => new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
  };
}

/** A menu label in the reader's language, or the English label when that
 *  screen is not translated yet (never a raw key). */
export function navLabel(t: I18nValue['t'], to: string, english: string): string {
  const key = `nav.${to}`;
  return key in en ? t(key as MessageKey) : english;
}

export type { MessageKey };
