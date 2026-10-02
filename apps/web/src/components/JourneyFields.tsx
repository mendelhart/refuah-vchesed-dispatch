/**
 * New-trip form, "More than one ride": a ride home, extra stops and the people
 * riding. Shown only when the journeys feature is on and only for a new trip.
 * Everything here is optional; left untouched, the form creates one ride
 * exactly as before.
 */
import React from 'react';
import { MOBILITY_NEEDS, type MobilityNeed } from '@rvc/shared';
import { Plus, Trash2 } from 'lucide-react';
import { mobilityLabel } from '@/lib/format';
import { inputClass, labelClass, secondaryButtonClass } from './states';
import { rideCount, seatsNeeded, type JourneyDraft, type ReturnChoice } from './journey-model';

const RETURN_CHOICES: Array<{ id: ReturnChoice; label: string; hint: string }> = [
  { id: 'none', label: 'No ride home', hint: 'One ride, there only.' },
  { id: 'scheduled', label: 'Ride home at a set time', hint: 'A second ride, back the other way.' },
  { id: 'call_when_ready', label: 'Ride home when they call', hint: 'Nothing is booked until they call; it shows on the board as waiting.' },
];

const chip = 'flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm text-slate-800 dark:border-slate-600 dark:text-slate-100';

export function JourneyFields({ value, onChange, errors }: {
  value: JourneyDraft;
  onChange: (next: JourneyDraft) => void;
  errors: Record<string, string>;
}): React.JSX.Element {
  const set = (patch: Partial<JourneyDraft>): void => onChange({ ...value, ...patch });
  const err = (key: string): React.JSX.Element | null =>
    errors[key] ? <p className="mt-1 text-xs text-[#C80023] dark:text-red-400">{errors[key]}</p> : null;
  const seats = seatsNeeded(value);
  const rides = rideCount(value);

  return (
    <section aria-labelledby="journey-heading" className="space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <div>
        <h3 id="journey-heading" className="text-sm font-semibold text-slate-900 dark:text-white">More than one ride</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">Optional. Each ride is offered and driven on its own, so one driver can take them there and another bring them home.</p>
      </div>

      <fieldset>
        <legend className={labelClass}>Ride home</legend>
        <div className="grid gap-2">
          {RETURN_CHOICES.map((c) => (
            <label key={c.id} className={`${chip} py-2`}>
              <input
                type="radio"
                name="return-choice"
                className="h-5 w-5 flex-shrink-0 accent-[#C80023]"
                checked={value.returnChoice === c.id}
                onChange={() => set({ returnChoice: c.id })}
              />
              <span>
                <span className="block font-medium">{c.label}</span>
                <span className="block text-xs text-slate-600 dark:text-slate-300">{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {value.returnChoice === 'scheduled' ? (
          <div className="mt-3">
            <label htmlFor="journey-return-at" className={labelClass}>Pick them up to go home at</label>
            <input id="journey-return-at" type="datetime-local" className={inputClass} value={value.returnAt}
              onChange={(e) => set({ returnAt: e.target.value })} />
            {err('return.pickupAt')}
          </div>
        ) : null}
        {value.returnChoice === 'call_when_ready' ? (
          <div className="mt-3">
            <label htmlFor="journey-expected-at" className={labelClass}>Roughly when they expect to call (optional)</label>
            <input id="journey-expected-at" type="datetime-local" className={inputClass} value={value.expectedAt}
              onChange={(e) => set({ expectedAt: e.target.value })} />
          </div>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className={labelClass}>Stops on the way</legend>
        {value.stops.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">None. Add one if they need to stop somewhere first, such as a pharmacy.</p> : null}
        <ol className="space-y-3">
          {value.stops.map((stop, i) => (
            <li key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <label htmlFor={`stop-${i}-line1`} className={labelClass}>Stop {i + 1}: address</label>
              <input id={`stop-${i}-line1`} className={inputClass} value={stop.line1} autoComplete="off"
                onChange={(e) => set({ stops: value.stops.map((s, j) => (j === i ? { ...s, line1: e.target.value } : s)) })} />
              {err(`stops.${i}.address.line1`)}
              <label htmlFor={`stop-${i}-depart`} className={`${labelClass} mt-2`}>Leaves this stop at</label>
              <input id={`stop-${i}-depart`} type="datetime-local" className={inputClass} value={stop.departAt}
                onChange={(e) => set({ stops: value.stops.map((s, j) => (j === i ? { ...s, departAt: e.target.value } : s)) })} />
              {err(`stops.${i}.departAt`)}
              <button type="button" className={`${secondaryButtonClass} mt-2`}
                onClick={() => set({ stops: value.stops.filter((_, j) => j !== i) })}>
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove stop {i + 1}
              </button>
            </li>
          ))}
        </ol>
        {value.stops.length < 4 ? (
          <button type="button" className={`${secondaryButtonClass} mt-2`}
            onClick={() => set({ stops: [...value.stops, { line1: '', departAt: '' }] })}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add a stop
          </button>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className={labelClass}>Who is riding</legend>
        {value.passengers.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">Just the caller. Add people if several are riding, so the driver's car has room.</p> : null}
        <ul className="space-y-3">
          {value.passengers.map((p, i) => (
            <li key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <label htmlFor={`pass-${i}-name`} className={labelClass}>Person {i + 1}: name</label>
              <input id={`pass-${i}-name`} className={inputClass} value={p.name}
                onChange={(e) => set({ passengers: value.passengers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <label htmlFor={`pass-${i}-seats`} className={`${labelClass} mt-2`}>Seats they need</label>
              <input id={`pass-${i}-seats`} type="number" inputMode="numeric" min={1} max={8} className={inputClass} value={p.seats}
                onChange={(e) => set({ passengers: value.passengers.map((x, j) => (j === i ? { ...x, seats: Number(e.target.value) } : x)) })} />
              <div role="group" aria-label={`Help person ${i + 1} needs`} className="mt-2 flex flex-wrap gap-2">
                {MOBILITY_NEEDS.filter((n) => n !== 'none').map((need: MobilityNeed) => (
                  <label key={need} className={chip}>
                    <input type="checkbox" className="h-4 w-4 accent-[#C80023]" checked={p.mobilityNeeds.includes(need)}
                      onChange={() => set({
                        passengers: value.passengers.map((x, j) => j !== i ? x : {
                          ...x, mobilityNeeds: x.mobilityNeeds.includes(need) ? x.mobilityNeeds.filter((n) => n !== need) : [...x.mobilityNeeds, need],
                        }),
                      })} />
                    {mobilityLabel(need)}
                  </label>
                ))}
              </div>
              <button type="button" className={`${secondaryButtonClass} mt-2`}
                onClick={() => set({ passengers: value.passengers.filter((_, j) => j !== i) })}>
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove person {i + 1}
              </button>
            </li>
          ))}
        </ul>
        {value.passengers.length < 8 ? (
          <button type="button" className={`${secondaryButtonClass} mt-2`}
            onClick={() => set({ passengers: [...value.passengers, { name: '', mobilityNeeds: [], seats: 1 }] })}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add a person
          </button>
        ) : null}
      </fieldset>

      <p className="text-sm font-medium text-slate-800 dark:text-slate-100" aria-live="polite">
        This makes {rides} {rides === 1 ? 'ride' : 'rides'}{seats > 0 ? `, needing ${seats} ${seats === 1 ? 'seat' : 'seats'}` : ''}.
        {value.returnChoice === 'call_when_ready' ? ' The ride home is added when they call.' : ''}
      </p>
    </section>
  );
}
