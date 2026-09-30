import { StepWhoYouAre,StepWhatYouCanDo,StepWhen,StepConfirm,SubmittedPanel } from './VolunteerSignupSteps';
import { EMPTY_FORM,buildAvailability,type FormState } from './signup-model';
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
import {
ErrorState,ListSkeleton,primaryButtonClass,secondaryButtonClass,
} from '@/components/states';
import { api,errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { useMutation,useQuery } from '@tanstack/react-query';
import { AlertTriangle,ArrowLeft,ArrowRight,Check,HeartHandshake } from 'lucide-react';
import React,{ useEffect,useMemo,useRef,useState } from 'react';

interface SignupOptions {
  services: { slug: string; name: string; description: string | null }[];
  groups: { slug: string; name: string }[];
  consent: { version: string; text: string };
}

const STEPS = ['Who you are', 'What you can help with', 'When you are around', 'Confirm'] as const;

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
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#EA0029] text-white">
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
                      index <= step ? 'bg-[#EA0029]' : 'bg-slate-200 dark:bg-slate-700'
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
                  <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[#EA0029]" aria-hidden="true" />
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
