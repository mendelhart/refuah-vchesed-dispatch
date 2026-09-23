/**
 * Password field with a Show/Hide button, so people typing on a phone can
 * check what they entered. The button's name is "Show"/"Hide" on purpose:
 * it must not contain the word "password", or it would compete with the
 * field for the field's label.
 */
import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { inputClass } from '@/components/states';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function PasswordInput({ className, ...props }: Props): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={visible ? 'text' : 'password'} className={`${className ?? inputClass} pr-20`} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-controls={props.id}
        className="absolute inset-y-0 right-1 my-auto flex h-10 items-center gap-1 rounded-md px-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
