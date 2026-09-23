import React from 'react';
import { inputClass, labelClass } from './states';

/**
 * Date and time as two cells, the way a dispatcher actually reads them back
 * to a caller. Internally the form keeps the combined `datetime-local`
 * wall-clock value; this component only splits and rejoins it.
 */
export function DateTimeFields(props: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: React.ReactNode;
}): React.JSX.Element {
  const [datePart, timePart] = props.value ? props.value.split('T') : ['', ''];
  const join = (d: string, t: string): string => (d || t ? `${d}T${t || '00:00'}` : '');
  return (
    <div>
      <span id={`${props.id}-label`} className={labelClass}>
        {props.label} {props.required ? <span aria-hidden="true">*</span> : null}
      </span>
      <div className="grid grid-cols-2 gap-2" role="group" aria-labelledby={`${props.id}-label`}>
        <input
          id={`${props.id}-date`}
          type="date"
          aria-label={`${props.label} date`}
          className={inputClass}
          value={datePart ?? ''}
          onChange={(event) => props.onChange(join(event.target.value, timePart ?? ''))}
        />
        <input
          id={`${props.id}-time`}
          type="time"
          aria-label={`${props.label} time`}
          className={inputClass}
          value={timePart ?? ''}
          onChange={(event) => props.onChange(join(datePart ?? '', event.target.value))}
        />
      </div>
      {props.hint ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{props.hint}</p>
      ) : null}
      {props.error}
    </div>
  );
}
