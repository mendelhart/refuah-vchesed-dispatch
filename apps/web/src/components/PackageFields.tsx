/** New-trip form: "This is a package" (item 6). Shown for equipment
 *  deliveries when package delivery is switched on. */
import React from 'react';
import { inputClass, labelClass } from './states';
import { SIZE_LABELS, type PackageDraft, type PackageSize } from './package-model';

export function PackageFields({ value, onChange, errors }: {
  value: PackageDraft; onChange: (next: PackageDraft) => void; errors: Record<string, string>;
}): React.JSX.Element {
  const set = (patch: Partial<PackageDraft>): void => onChange({ ...value, ...patch });
  const err = (key: string): React.JSX.Element | null =>
    errors[key] ? <p className="mt-1 text-xs text-[#C80023] dark:text-red-400">{errors[key]}</p> : null;
  return (
    <section aria-labelledby="package-heading" className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <label className="flex min-h-[44px] items-center gap-3 text-sm font-semibold text-slate-900 dark:text-white">
        <input type="checkbox" className="h-5 w-5 accent-[#C80023]" checked={value.isPackage} onChange={(e) => set({ isPackage: e.target.checked })} />
        <span id="package-heading">This is a package to deliver</span>
      </label>
      {value.isPackage ? (
        <>
          <div>
            <label htmlFor="pkg-desc" className={labelClass}>What is it</label>
            <input id="pkg-desc" className={inputClass} value={value.description} placeholder="Box of medication" onChange={(e) => set({ description: e.target.value })} />
            {err('package.description')}
          </div>
          <fieldset>
            <legend className={labelClass}>Size</legend>
            <div className="grid gap-2">
              {(Object.keys(SIZE_LABELS) as PackageSize[]).map((s) => (
                <label key={s} className="flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm text-slate-800 dark:border-slate-600 dark:text-slate-100">
                  <input type="radio" name="pkg-size" className="h-5 w-5 accent-[#C80023]" checked={value.size === s} onChange={() => set({ size: s })} />
                  {SIZE_LABELS[s]}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="pkg-weight" className={labelClass}>Weight in kg (optional)</label>
            <input id="pkg-weight" type="number" inputMode="decimal" min={0} className={inputClass} value={value.weightKg} onChange={(e) => set({ weightKg: e.target.value })} />
          </div>
          <div>
            <label htmlFor="pkg-recipient" className={labelClass}>Who receives it</label>
            <input id="pkg-recipient" className={inputClass} value={value.recipientName} onChange={(e) => set({ recipientName: e.target.value })} />
            {err('package.recipientName')}
          </div>
          <div>
            <label htmlFor="pkg-phone" className={labelClass}>Their phone (optional)</label>
            <input id="pkg-phone" type="tel" inputMode="tel" className={inputClass} value={value.recipientPhone} onChange={(e) => set({ recipientPhone: e.target.value })} />
          </div>
          <div>
            <label htmlFor="pkg-notes" className={labelClass}>Handling (optional)</label>
            <input id="pkg-notes" className={inputClass} value={value.handlingNotes} placeholder="Keep upright, fragile, keep cold" onChange={(e) => set({ handlingNotes: e.target.value })} />
          </div>
        </>
      ) : null}
    </section>
  );
}
