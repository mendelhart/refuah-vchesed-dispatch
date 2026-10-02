/** Language choice: on the sign-in page and in Settings. Hidden while only
 *  English is switched on. */
import React from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { CATALOGS, useI18n, type Locale } from './index';

export function LanguagePicker({ saveToAccount = false }: { saveToAccount?: boolean }): React.JSX.Element | null {
  const { available, locale, setLocale, t } = useI18n();
  if (available.length < 2) return null;
  const choose = async (l: Locale): Promise<void> => {
    setLocale(l);
    if (!saveToAccount) return;
    try {
      await api.put('/api/me/locale', { locale: l });
      toast.success(CATALOGS[l]['lang.saved']);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <fieldset>
      <legend className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">{t('lang.label')}</legend>
      <div className="flex flex-wrap gap-2">
        {available.map((l) => (
          <label key={l} lang={l} className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm text-slate-800 dark:border-slate-600 dark:text-slate-100">
            <input type="radio" name="language" className="h-5 w-5 accent-[#C80023]" checked={locale === l} onChange={() => void choose(l)} />
            {CATALOGS[l]['lang.name']}
          </label>
        ))}
      </div>
      {saveToAccount ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t('lang.hint')}</p> : null}
    </fieldset>
  );
}
