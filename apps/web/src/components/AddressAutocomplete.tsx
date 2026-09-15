/**
 * Address entry with server-side suggestions.
 *
 * Two defects from the original component are fixed here.
 *
 * 1. The suggestion list rendered bare `<button>` elements with no `type`.
 *    Inside a form a button defaults to `type="submit"`, so tapping a
 *    suggestion submitted a half-filled trip. Every button below is
 *    `type="button"`.
 *
 * 2. The typed address was thrown away: the old form rebuilt the address from
 *    geocoder components (`buildFullAddress(street_number, street_name, …)`),
 *    so "3175 Cote-Ste-Catherine, back entrance by the ramp" became whatever
 *    the geocoder decided, and anything the geocoder did not model was lost.
 *    Here `line1` is whatever the dispatcher typed, verbatim, and the geocoder
 *    only fills the *optional* enrichment fields (city, province, postal code,
 *    coordinates). Picking a suggestion is an explicit act and does replace
 *    line1; typing afterwards wins again and drops the stale coordinates.
 */
import React, { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { inputClass } from './states';
import type { AddressSearchResponse, AddressSuggestion } from '@/types/api';

export interface AddressDraft {
  line1: string;
  unit: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  notes: string;
  latitude: number | null;
  longitude: number | null;
}

export function emptyAddress(): AddressDraft {
  return {
    line1: '',
    unit: '',
    city: 'Montreal',
    province: 'QC',
    postalCode: '',
    country: 'CA',
    notes: '',
    latitude: null,
    longitude: null,
  };
}

/** Shape the API expects: line1 verbatim, everything else optional. */
export function toAddressInput(draft: AddressDraft): {
  line1: string;
  unit: string | null;
  city: string;
  province: string;
  postalCode: string | null;
  country: string;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
} {
  return {
    // Verbatim. Never rebuilt from components — see the note at the top.
    line1: draft.line1.trim(),
    unit: draft.unit.trim() || null,
    city: draft.city.trim() || 'Montreal',
    province: draft.province.trim() || 'QC',
    postalCode: draft.postalCode.trim() || null,
    country: draft.country.trim() || 'CA',
    notes: draft.notes.trim() || null,
    latitude: draft.latitude,
    longitude: draft.longitude,
  };
}

interface Props {
  id: string;
  label: string;
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  notesPlaceholder?: string;
  required?: boolean;
}

export function AddressFields({ id, label, value, onChange, notesPlaceholder, required }: Props): React.JSX.Element {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typedRef = useRef(false);

  useEffect(() => {
    if (!typedRef.current) return;
    const query = value.line1.trim();
    if (query.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const controller = new AbortController();
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      api
        .get<AddressSearchResponse>('/api/addresses/search', { q: query }, controller.signal)
        .then((data) => {
          setSuggestions(data.results);
          setOpen(data.results.length > 0);
          setLookupFailed(false);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          // Lookup is a convenience; a failure must never block typing.
          setSuggestions([]);
          setOpen(false);
          setLookupFailed(true);
        })
        .finally(() => setLoading(false));
    }, 300);

    return () => {
      controller.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value.line1]);

  const applySuggestion = (suggestion: AddressSuggestion): void => {
    typedRef.current = false;
    onChange({
      ...value,
      line1: suggestion.line1 || suggestion.formatted,
      unit: suggestion.unit ?? value.unit,
      city: suggestion.city || value.city,
      province: suggestion.province || value.province,
      postalCode: suggestion.postalCode ?? '',
      country: suggestion.country || value.country,
      latitude: suggestion.latitude,
      longitude: suggestion.longitude,
    });
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <fieldset className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <legend className="px-1 text-sm font-semibold text-slate-900 dark:text-white">{label}</legend>

      <div className="relative">
        <label htmlFor={`${id}-line1`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
          Street address {required ? <span aria-hidden="true">*</span> : null}
        </label>
        <div className="relative">
          <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            id={`${id}-line1`}
            className={cn(inputClass, 'pl-10')}
            value={value.line1}
            required={required ?? false}
            autoComplete="off"
            placeholder="e.g. 3175 Chemin de la Côte-Sainte-Catherine"
            onChange={(event) => {
              typedRef.current = true;
              onChange({
                ...value,
                line1: event.target.value,
                // Coordinates belonged to the suggestion the dispatcher just
                // typed over; keeping them would pin the trip to the wrong spot.
                latitude: null,
                longitude: null,
              });
            }}
            onFocus={() => setOpen(suggestions.length > 0)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          />
          {loading ? (
            <span className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300 border-t-[#E31E24]" />
          ) : null}
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Typed exactly as entered. Suggestions only fill in the city, postal code and map pin.
        </p>
        {lookupFailed ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Address lookup is unavailable right now — what you type is still saved.
          </p>
        ) : null}

        {open && suggestions.length > 0 ? (
          <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-600 dark:bg-slate-800">
            {suggestions.map((suggestion, index) => (
              <li key={`${suggestion.formatted}-${index}`}>
                {/* FIX: type="button". Without it this submitted the form. */}
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applySuggestion(suggestion)}
                  className="flex w-full items-start gap-2 border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-700"
                >
                  <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900 dark:text-white">{suggestion.line1 || suggestion.formatted}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {[suggestion.city, suggestion.postalCode].filter(Boolean).join(', ')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-unit`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            Unit / apt
          </label>
          <input
            id={`${id}-unit`}
            className={inputClass}
            value={value.unit}
            onChange={(event) => onChange({ ...value, unit: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${id}-city`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            City
          </label>
          <input
            id={`${id}-city`}
            className={inputClass}
            value={value.city}
            onChange={(event) => onChange({ ...value, city: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${id}-postal`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            Postal code
          </label>
          <input
            id={`${id}-postal`}
            className={inputClass}
            value={value.postalCode}
            onChange={(event) => onChange({ ...value, postalCode: event.target.value })}
          />
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor={`${id}-notes`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
          Entrance / parking notes
        </label>
        <input
          id={`${id}-notes`}
          className={inputClass}
          value={value.notes}
          placeholder={notesPlaceholder ?? 'Which door, where to park, who to ask for'}
          onChange={(event) => onChange({ ...value, notes: event.target.value })}
        />
      </div>
    </fieldset>
  );
}
