/**
 * Public volunteer signup. No session, no Layout, no navigation.
 *
 * This link is pasted into a WhatsApp group, so almost everybody arrives on a
 * phone, one-handed, somewhere between other things. It is built in four short
 * steps rather than one long page: a person who gets three screens in and puts
 * the phone down has still answered the questions that matter most, and nobody
 * is scrolled past a required field they never saw.
 *
 * Two anti-abuse fields ride along with the submission. `website` is a honeypot
 * that only a form-filling bot completes, and `elapsedMs` is how long the form
 * was open — the server rejects anything under three seconds. Both are the
 * page's own bookkeeping and neither is ever shown to the applicant.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, HeartHandshake } from 'lucide-react';
import { VOLUNTEER_CAPABILITIES, type VolunteerCapability } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import {
  ErrorState, ListSkeleton, inputClass, labelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';

interface SignupOptions {
  services: { slug: string; name: string; description: string | null }[];
  groups: { slug: string; name: string }[];
  consent: { version: string; text: string };
}

interface AvailabilityWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Rough day parts, so the question can be answered with a thumb in a queue. */
const DAY_PARTS = [
  { key: 'morning', label: 'Morning', startMinute: 8 * 60, endMinute: 12 * 60 },
  { key: 'afternoon', label: 'Afternoon', startMinute: 12 * 60, endMinute: 17 * 60 },
  { key: 'evening', label: 'Evening', startMinute: 17 * 60, endMinute: 22 * 60 },
] as const;

const CAPABILITY_LABELS: Record<VolunteerCapability, string> = {
  wheelchair: 'A folding wheelchair',
  stretcher: 'Somebody who has to stay lying down',
  walker: 'A walker, and an arm to the car',
  oxygen: 'A portable oxygen cylinder',
  attendant: 'An extra seat for a carer or family member',
};

const LANGUAGE_OPTIONS = ['English', 'French', 'Yiddish', 'Hebrew', 'Russian', 'Spanish'] as const;

const CONTACT_OPTIONS = [
  { value: 'sms', label: 'Text message' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'all', label: 'Whichever reaches me fastest' },
] as const;

const STEPS = ['Who you are', 'What you can help with', 'When you are around', 'Confirm'] as const;

interface FormState {
  fullName: string;
  email: string;
  phone: string;
  addressLine: string;
  city: string;
  postalCode: string;
  serviceArea: string;
  requestedServices: string[];
  requestedGroups: string[];
  capabilities: VolunteerCapability[];
  hasVehicle: boolean;
  vehicleType: string;
  vehicleSeats: string;
  availabilityNote: string;
  availabilityParts: string[];
  languages: string[];
  otherLanguage: string;
  referredBy: string;
  notes: string;
  notificationPreference: string;
  consentContact: boolean;
  consentBackgroundCheck: boolean;
  website: string;
}

const EMPTY_FORM: FormState = {
  fullName: '',
  email: '',
  phone: '',
  addressLine: '',
  city: '',
  postalCode: '',
  serviceArea: '',
  requestedServices: [],
  requestedGroups: [],
  capabilities: [],
  hasVehicle: true,
  vehicleType: '',
  vehicleSeats: '',
  availabilityNote: '',
  availabilityParts: [],
  languages: [],
  otherLanguage: '',
  referredBy: '',
  notes: '',
  notificationPreference: 'sms',
  consentContact: false,
  consentBackgroundCheck: false,
  website: '',
};

/** Contiguous day parts become one window, so a full day is one row not three. */
function buildAvailability(parts: string[]): AvailabilityWindow[] {
  const windows: AvailabilityWindow[] = [];
  for (let weekday = 0; weekday < DAY_NAMES.length; weekday += 1) {
    let open: AvailabilityWindow | null = null;
    for (const part of DAY_PARTS) {
      if (!parts.includes(`${weekday}:${part.key}`)) {
        if (open) windows.push(open);
        open = null;
        continue;
      }
      if (open && open.endMinute === part.startMinute) open.endMinute = part.endMinute;
      else {
        if (open) windows.push(open);
        open = { weekday, startMinute: part.startMinute, endMinute: part.endMinute };
      }
    }
    if (open) windows.push(open);
  }
  return windows;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function VolunteerSignupPage(): React.JSX.Element {
  const mountedAt = useRef(Date.now());
  const errorRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [problem, setProblem] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  const options = useQuery({
    queryKey: qk.applications.signupOptions(),
    queryFn: () => api.get<SignupOptions>('/api/public/signup-options'),
    retry: false,
  });

  useEffect(() => {
    if (problem) errorRef.current?.scrollIntoView({ block: 'center' });
  }, [problem]);

  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ reference: string; received: boolean }>('/api/public/volunteer-applications', body),
    onSuccess: (data) => {
      setProblem(null);
      setReference(data.reference);
    },
    onError: (error: unknown) => setProblem(errorMessage(error)),
  });

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const validateStep = (index: number): string | null => {
    if (index === 0) {
      if (form.fullName.trim().length < 2) return 'Enter your full name.';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) return 'Enter an email address we can reach you at.';
      if (form.phone.trim().length < 7) return 'Enter a mobile number we can text.';
    }
    if (index === 1 && form.requestedServices.length === 0) {
      return 'Choose at least one kind of help you would like to give.';
    }
    return null;
  };

  const goNext = (): void => {
    const message = validateStep(step);
    if (message) {
      setProblem(message);
      return;
    }
    setProblem(null);
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
    window.scrollTo({ top: 0 });
  };

  const goBack = (): void => {
    setProblem(null);
    setStep((current) => Math.max(current - 1, 0));
    window.scrollTo({ top: 0 });
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    for (let index = 0; index < STEPS.length; index += 1) {
      const message = validateStep(index);
      if (message) {
        setProblem(message);
        setStep(index);
        return;
      }
    }
    if (!form.consentContact) {
      setProblem('Please agree to the statement below so we can contact you.');
      return;
    }

    const languages = [...form.languages];
    const other = form.otherLanguage.trim();
    if (other && !languages.includes(other)) languages.push(other);
    const availability = buildAvailability(form.availabilityParts);
    const seats = Number.parseInt(form.vehicleSeats, 10);

    submit.mutate({
      fullName: form.fullName.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      ...(form.addressLine.trim() ? { addressLine: form.addressLine.trim() } : {}),
      ...(form.city.trim() ? { city: form.city.trim() } : {}),
      ...(form.postalCode.trim() ? { postalCode: form.postalCode.trim() } : {}),
      ...(form.serviceArea.trim() ? { serviceArea: form.serviceArea.trim() } : {}),
      requestedServices: form.requestedServices,
      requestedGroups: form.requestedGroups,
      capabilities: form.capabilities,
      hasVehicle: form.hasVehicle,
      ...(form.hasVehicle && form.vehicleType.trim() ? { vehicleType: form.vehicleType.trim() } : {}),
      ...(form.hasVehicle && Number.isFinite(seats) && seats > 0 ? { vehicleSeats: seats } : {}),
      ...(form.availabilityNote.trim() ? { availabilityNote: form.availabilityNote.trim() } : {}),
      ...(availability.length > 0 ? { availability } : {}),
      languages,
      ...(form.referredBy.trim() ? { referredBy: form.referredBy.trim() } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      notificationPreference: form.notificationPreference,
      consentContact: true,
      consentBackgroundCheck: form.consentBackgroundCheck,
      website: form.website,
      elapsedMs: Date.now() - mountedAt.current,
    });
  };

  const availabilitySummary = useMemo(() => buildAvailability(form.availabilityParts).length, [form.availabilityParts]);

  if (reference) {
    return <SubmittedPanel reference={reference} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 dark:bg-slate-950">
      <div className="mx-auto w-full max-w-lg space-y-5">
        <header className="text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#E31E24] text-white">
            <HeartHandshake className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-2xl font-bold text-slate-900 dark:text-white">Volunteer with us</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            A few questions, about two minutes. You can say yes to as little or as much as you like.
          </p>
        </header>

        {options.isPending ? (
          <ListSkeleton rows={2} lines={4} />
        ) : options.isError ? (
          <ErrorState error={options.error} onRetry={() => void options.refetch()} what="the signup form" />
        ) : (
          <>
            <ol className="flex items-center gap-2" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
              {STEPS.map((label, index) => (
                <li key={label} className="flex-1">
                  <span
                    className={`block h-1.5 rounded-full ${
                      index <= step ? 'bg-[#E31E24]' : 'bg-slate-200 dark:bg-slate-700'
                    }`}
                  />
                </li>
              ))}
            </ol>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Step {step + 1} of {STEPS.length} · {STEPS[step]}
            </p>

            <div ref={errorRef}>
              {problem ? (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-slate-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-slate-100"
                >
                  <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[#E31E24]" aria-hidden="true" />
                  <p>{problem}</p>
                </div>
              ) : null}
            </div>

            <form
              className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900"
              onSubmit={handleSubmit}
            >
              {/* Honeypot. Hidden from sight and from the tab order; a person never reaches it. */}
              <input
                type="text"
                name="website"
                className="hidden"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={form.website}
                onChange={(event) => update('website', event.target.value)}
              />

              {step === 0 ? <StepWhoYouAre form={form} update={update} /> : null}
              {step === 1 ? (
                <StepWhatYouCanDo form={form} update={update} options={options.data} />
              ) : null}
              {step === 2 ? <StepWhen form={form} update={update} windowCount={availabilitySummary} /> : null}
              {step === 3 ? <StepConfirm form={form} update={update} consent={options.data.consent} /> : null}

              <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
                {step > 0 ? (
                  <button type="button" className={secondaryButtonClass} onClick={goBack} disabled={submit.isPending}>
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Back
                  </button>
                ) : null}
                {step < STEPS.length - 1 ? (
                  <button type="button" className={`${primaryButtonClass} flex-1`} onClick={goNext}>
                    Next
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : (
                  <button type="submit" className={`${primaryButtonClass} flex-1`} disabled={submit.isPending}>
                    <Check className="h-4 w-4" aria-hidden="true" />
                    {submit.isPending ? 'Sending…' : 'Send my details'}
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

type Update = <K extends keyof FormState>(key: K, value: FormState[K]) => void;

function StepWhoYouAre({ form, update }: { form: FormState; update: Update }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="signup-name" className={labelClass}>
          Your full name
        </label>
        <input
          id="signup-name"
          className={inputClass}
          autoComplete="name"
          value={form.fullName}
          onChange={(event) => update('fullName', event.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="signup-phone" className={labelClass}>
          Mobile number
        </label>
        <input
          id="signup-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          className={inputClass}
          placeholder="+1 514 555 1234"
          value={form.phone}
          onChange={(event) => update('phone', event.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="signup-email" className={labelClass}>
          Email
        </label>
        <input
          id="signup-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          className={inputClass}
          value={form.email}
          onChange={(event) => update('email', event.target.value)}
          required
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="signup-city" className={labelClass}>
            City (optional)
          </label>
          <input
            id="signup-city"
            className={inputClass}
            autoComplete="address-level2"
            value={form.city}
            onChange={(event) => update('city', event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="signup-postal" className={labelClass}>
            Postal code (optional)
          </label>
          <input
            id="signup-postal"
            className={inputClass}
            autoComplete="postal-code"
            value={form.postalCode}
            onChange={(event) => update('postalCode', event.target.value)}
          />
        </div>
      </div>
      <div>
        <label htmlFor="signup-address" className={labelClass}>
          Street address (optional)
        </label>
        <input
          id="signup-address"
          className={inputClass}
          autoComplete="address-line1"
          value={form.addressLine}
          onChange={(event) => update('addressLine', event.target.value)}
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Used to work out which rides start near you. Nothing is shown publicly.
        </p>
      </div>
    </div>
  );
}

function StepWhatYouCanDo({
  form,
  update,
  options,
}: {
  form: FormState;
  update: Update;
  options: SignupOptions;
}): React.JSX.Element {
  return (
    <div className="space-y-5">
      <fieldset>
        <legend className={labelClass}>What would you like to help with?</legend>
        <ul className="space-y-2">
          {options.services.map((service) => (
            <li key={service.slug}>
              <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 flex-shrink-0 accent-[#E31E24]"
                  checked={form.requestedServices.includes(service.slug)}
                  onChange={() => update('requestedServices', toggle(form.requestedServices, service.slug))}
                />
                <span className="min-w-0">
                  <span className="block font-medium text-slate-900 dark:text-white">{service.name}</span>
                  {service.description ? (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{service.description}</span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend className={labelClass}>Could you take a passenger who needs any of these?</legend>
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          Only tick what you are genuinely comfortable with. Leaving one unticked simply means we will not ask you about
          that kind of trip.
        </p>
        <ul className="space-y-2">
          {VOLUNTEER_CAPABILITIES.map((capability) => (
            <li key={capability}>
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  className="h-4 w-4 flex-shrink-0 accent-[#E31E24]"
                  checked={form.capabilities.includes(capability)}
                  onChange={() => update('capabilities', toggle(form.capabilities, capability))}
                />
                {CAPABILITY_LABELS[capability]}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className={labelClass}>Your vehicle</legend>
        <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            className="h-4 w-4 flex-shrink-0 accent-[#E31E24]"
            checked={form.hasVehicle}
            onChange={(event) => update('hasVehicle', event.target.checked)}
          />
          I have a car I can use
        </label>
        {form.hasVehicle ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="signup-vehicle" className={labelClass}>
                Make and model (optional)
              </label>
              <input
                id="signup-vehicle"
                className={inputClass}
                value={form.vehicleType}
                onChange={(event) => update('vehicleType', event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="signup-seats" className={labelClass}>
                Passenger seats (optional)
              </label>
              <input
                id="signup-seats"
                type="number"
                inputMode="numeric"
                min={1}
                max={20}
                className={inputClass}
                value={form.vehicleSeats}
                onChange={(event) => update('vehicleSeats', event.target.value)}
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            That is fine. There is plenty to do that does not involve driving, such as phone duty and visits.
          </p>
        )}
      </fieldset>

      {options.groups.length > 0 ? (
        <fieldset>
          <legend className={labelClass}>Any group you already belong to? (optional)</legend>
          <ul className="space-y-2">
            {options.groups.map((group) => (
              <li key={group.slug}>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    className="h-4 w-4 flex-shrink-0 accent-[#E31E24]"
                    checked={form.requestedGroups.includes(group.slug)}
                    onChange={() => update('requestedGroups', toggle(form.requestedGroups, group.slug))}
                  />
                  {group.name}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
    </div>
  );
}

function StepWhen({
  form,
  update,
  windowCount,
}: {
  form: FormState;
  update: Update;
  windowCount: number;
}): React.JSX.Element {
  return (
    <div className="space-y-5">
      <fieldset>
        <legend className={labelClass}>Roughly when are you usually around?</legend>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          A rough guide is plenty. Leave it all blank if your week varies, and you can set exact hours once you are set
          up.
        </p>
        <div className="space-y-2">
          {DAY_NAMES.map((day, weekday) => (
            <div key={day} className="flex items-center gap-2">
              <span className="w-10 flex-shrink-0 text-sm font-medium text-slate-700 dark:text-slate-200">{day}</span>
              <div className="grid flex-1 grid-cols-3 gap-2">
                {DAY_PARTS.map((part) => {
                  const key = `${weekday}:${part.key}`;
                  const active = form.availabilityParts.includes(key);
                  return (
                    <button
                      key={part.key}
                      type="button"
                      aria-pressed={active}
                      className={`min-h-[44px] rounded-lg border px-2 text-sm transition-colors ${
                        active
                          ? 'border-[#E31E24] bg-[#E31E24] font-semibold text-white'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                      }`}
                      onClick={() => update('availabilityParts', toggle(form.availabilityParts, key))}
                    >
                      {part.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {windowCount === 0
            ? 'Nothing chosen, so we will take it that any time could work.'
            : `${windowCount} ${windowCount === 1 ? 'block' : 'blocks'} of time chosen.`}
        </p>
      </fieldset>

      <div>
        <label htmlFor="signup-availability-note" className={labelClass}>
          Anything else about your availability? (optional)
        </label>
        <textarea
          id="signup-availability-note"
          rows={3}
          maxLength={500}
          className={`${inputClass} py-2`}
          placeholder="Not on Friday afternoons. Some flexibility with notice."
          value={form.availabilityNote}
          onChange={(event) => update('availabilityNote', event.target.value)}
        />
      </div>

      <div>
        <label htmlFor="signup-area" className={labelClass}>
          Which areas can you cover? (optional)
        </label>
        <input
          id="signup-area"
          className={inputClass}
          placeholder="Around Côte-Saint-Luc and downtown hospitals"
          value={form.serviceArea}
          onChange={(event) => update('serviceArea', event.target.value)}
        />
      </div>

      <fieldset>
        <legend className={labelClass}>Languages you speak (optional)</legend>
        <div className="grid grid-cols-2 gap-2">
          {LANGUAGE_OPTIONS.map((language) => (
            <label
              key={language}
              className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200"
            >
              <input
                type="checkbox"
                className="h-4 w-4 flex-shrink-0 accent-[#E31E24]"
                checked={form.languages.includes(language)}
                onChange={() => update('languages', toggle(form.languages, language))}
              />
              {language}
            </label>
          ))}
        </div>
        <label htmlFor="signup-other-language" className="sr-only">
          Another language
        </label>
        <input
          id="signup-other-language"
          className={`${inputClass} mt-2`}
          placeholder="Another language"
          maxLength={30}
          value={form.otherLanguage}
          onChange={(event) => update('otherLanguage', event.target.value)}
        />
      </fieldset>
    </div>
  );
}

function StepConfirm({
  form,
  update,
  consent,
}: {
  form: FormState;
  update: Update;
  consent: { version: string; text: string };
}): React.JSX.Element {
  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="signup-contact" className={labelClass}>
          How should we reach you?
        </label>
        <select
          id="signup-contact"
          className={inputClass}
          value={form.notificationPreference}
          onChange={(event) => update('notificationPreference', event.target.value)}
        >
          {CONTACT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="signup-referred" className={labelClass}>
          Who told you about us? (optional)
        </label>
        <input
          id="signup-referred"
          className={inputClass}
          value={form.referredBy}
          onChange={(event) => update('referredBy', event.target.value)}
        />
      </div>

      <div>
        <label htmlFor="signup-notes" className={labelClass}>
          Anything you would like us to know? (optional)
        </label>
        <textarea
          id="signup-notes"
          rows={3}
          maxLength={1000}
          className={`${inputClass} py-2`}
          value={form.notes}
          onChange={(event) => update('notes', event.target.value)}
        />
      </div>

      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Agreement (version {consent.version})
        </p>
        <p className="mt-2 whitespace-pre-line text-sm text-slate-700 dark:text-slate-300">{consent.text}</p>
        <label className="mt-3 flex min-h-[44px] cursor-pointer items-start gap-3 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 flex-shrink-0 accent-[#E31E24]"
            checked={form.consentContact}
            onChange={(event) => update('consentContact', event.target.checked)}
            required
          />
          I have read the above and I agree.
        </label>
      </div>

      <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 flex-shrink-0 accent-[#E31E24]"
          checked={form.consentBackgroundCheck}
          onChange={(event) => update('consentBackgroundCheck', event.target.checked)}
        />
        <span>
          I am willing to have a background check done if it is needed for the kind of help I have chosen. This one is
          optional.
        </span>
      </label>
    </div>
  );
}

function SubmittedPanel({ reference }: { reference: string }): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300">
          <Check className="h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Thank you, we have your details</h1>
        <div>
          <p className="text-sm text-slate-600 dark:text-slate-400">Your reference</p>
          <p className="mt-1 break-all font-mono text-lg font-bold text-slate-900 dark:text-white">{reference}</p>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          A person from the office will read what you have sent and get in touch. Keep this reference in case you need
          to ask about your application.
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          There is nothing else for you to do for now. Nothing has been set up on your side yet.
        </p>
      </div>
    </div>
  );
}
