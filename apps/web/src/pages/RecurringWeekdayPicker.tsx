import React from 'react';
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function WeekdayPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Days of the week">
      {WEEKDAY_INITIALS.map((initial, day) => {
        const active = value.includes(day);
        return (
          <button
            key={WEEKDAY_NAMES[day]}
            type="button"
            aria-pressed={active}
            aria-label={WEEKDAY_NAMES[day]}
            onClick={() => onChange(active ? value.filter((d) => d !== day) : [...value, day])}
            className={`h-11 w-11 rounded-lg border text-sm font-semibold transition-colors ${
              active
                ? 'border-[#EA0029] bg-[#EA0029] text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            {initial}
          </button>
        );
      })}
    </div>
  );
}

