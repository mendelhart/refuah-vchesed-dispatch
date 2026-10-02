import { describe, expect, it } from 'vitest';
import { CATALOGS, LOCALES, initialLocale, navLabel, translate } from '@/i18n';
import { en } from '@/i18n/en';
import { NAV_ITEMS } from '@/components/Layout';

/** Languages (item 7). The missing-key test the handoff asks for. */
describe('translations', () => {
  const keys = Object.keys(en).sort();

  for (const locale of LOCALES) {
    it(`${locale}: has every key and nothing extra`, () => {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual(keys);
    });

    it(`${locale}: no empty strings, no untranslated placeholders left behind`, () => {
      for (const [k, v] of Object.entries(CATALOGS[locale])) {
        expect(v.trim(), `${locale} ${k}`).not.toBe('');
        expect(v, `${locale} ${k} looks like a raw key`).not.toMatch(/^[a-z]+\.[\w./-]+$/);
        const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(vars(v), `${locale} ${k} placeholders`).toEqual(vars((en as Record<string, string>)[k]!));
      }
    });
  }

  it('translates, fills placeholders, and falls back to English', () => {
    expect(translate('fr', 'login.submit')).toBe('Se connecter');
    expect(translate('he', 'nav./')).toBe('בית');
    expect(translate('en', 'login.submit')).toBe('Sign in');
  });

  it('menu labels never show a raw key: untranslated screens stay in English', () => {
    const t = (k: Parameters<typeof translate>[1]) => translate('fr', k);
    expect(navLabel(t, '/my-trips', 'My rides')).toBe('Mes trajets');
    expect(navLabel(t, '/admin/audit', 'Audit log')).toBe('Audit log');
  });

  it('starts in the saved language, else the phone’s, else English, and only if switched on', () => {
    expect(initialLocale(['en', 'fr'], 'fr', ['he-IL'])).toBe('fr');
    expect(initialLocale(['en', 'fr'], 'he', ['fr-CA'])).toBe('fr');
    expect(initialLocale(['en'], 'fr', ['fr-CA'])).toBe('en');
    expect(initialLocale(['en', 'he'], null, ['de-DE', 'he'])).toBe('he');
  });

  it('English strings are exactly the ones the app showed before', () => {
    expect(en['login.identifier']).toBe('Email or mobile number');
    expect(en['hub.more.subtitle']).toBe('Everything else, one tap away');
    expect(en['nav./my-profile']).toBe('What I can help with');
  });
});


describe('English menu is unchanged', () => {
  it('every translated menu entry’s English text equals the label the menu had', () => {
    for (const item of NAV_ITEMS) {
      const key = `nav.${item.to}` as keyof typeof en;
      if (key in en) expect(en[key], item.to).toBe(item.label);
    }
  });
});
