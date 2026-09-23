/**
 * My profile: what I want to be asked about, what I can physically handle, and
 * my driver's licence.
 *
 * The licence card is the part that has to stay honest. "On file" means an
 * administrator has looked at a photograph, which is not the same thing as a
 * licence having been checked against a provincial register, and the two must
 * never be shown with the same tick. Only `verified` — reachable solely when an
 * external service confirmed it — is allowed to say verified, and it names the
 * service that said so.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, BadgeCheck, Camera, FileClock, IdCard, ShieldQuestion, XCircle } from 'lucide-react';
import { VOLUNTEER_CAPABILITIES, type VolunteerCapability } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  ErrorState, InlineSpinner, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass,
} from '@/components/states';

interface ServiceType {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  dispatchable: boolean;
}

interface MyService extends ServiceType {
  optedInAt: string | null;
}

type LicenceStatus = 'pending_review' | 'on_file' | 'verified' | 'rejected' | 'expired';

interface Licence {
  id: string;
  province: string;
  numberLast4: string | null;
  expiresOn: string | null;
  status: LicenceStatus;
  frontFileId: string | null;
  backFileId: string | null;
  reviewedAt: string | null;
  verificationProvider: string | null;
  verifiedAt: string | null;
}

interface IdCardSummary {
  card: { capabilities: string[] };
}

const CAPABILITY_LABELS: Record<VolunteerCapability, string> = {
  wheelchair: 'Wheelchair',
  stretcher: 'Stretcher',
  walker: 'Walker',
  oxygen: 'Oxygen',
  attendant: 'Passenger brings an attendant',
};

const CAPABILITY_HINTS: Record<VolunteerCapability, string> = {
  wheelchair: 'You can load and secure a folding wheelchair, or your vehicle takes one.',
  stretcher: 'You can carry a passenger who has to stay lying down.',
  walker: 'You can stow a walker and give an arm between the door and the car.',
  oxygen: 'You are comfortable travelling with a portable oxygen cylinder.',
  attendant: 'You have room for a family member or carer to come along.',
};

const PROVINCES = ['QC', 'ON', 'NB', 'NS', 'PE', 'NL', 'MB', 'SK', 'AB', 'BC', 'YT', 'NT', 'NU'] as const;

/**
 * The API rejects an oversized body long before the schema sees it, and a phone
 * photograph is several megabytes, so every image is re-encoded before it is
 * sent. The loop steps down until the data URL fits a conservative budget
 * rather than trusting a single quality setting to be enough.
 */
const IMAGE_BUDGET_BYTES = 320_000;

async function prepareImage(file: File): Promise<string> {
  const original = await readAsDataUrl(file);
  if (original.length <= IMAGE_BUDGET_BYTES && file.size <= 2_000_000) return original;

  const image = await loadImage(original);
  for (const [maxEdge, quality] of [[1600, 0.8], [1280, 0.7], [1024, 0.6], [800, 0.5]] as const) {
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not resize the photo. Try a smaller image.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const encoded = canvas.toDataURL('image/jpeg', quality);
    if (encoded.length <= IMAGE_BUDGET_BYTES) return encoded;
  }
  throw new Error('That photo is too large even after shrinking. Try again with less of the background in frame.');
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read. Try taking the photo again.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('That file could not be read. Try taking the photo again.'));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That does not look like a photo we can read.'));
    image.src = dataUrl;
  });
}

export function MyProfilePage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader title="My profile" subtitle="What you are asked about, what you can help with, and your licence" />
      <ServicesCard />
      <CapabilitiesCard />
      <LicenceCard />
    </div>
  );
}

function ServicesCard(): React.JSX.Element {
  const queryClient = useQueryClient();

  const catalogue = useQuery({
    queryKey: qk.services.list(),
    queryFn: () => api.get<{ services: ServiceType[] }>('/api/services'),
  });
  const mine = useQuery({
    queryKey: qk.meExtras.services(),
    queryFn: () => api.get<{ services: MyService[] }>('/api/me/services'),
  });

  // The tick has to move under the finger straight away, but a failed write
  // must not leave a tick standing for something the server never recorded, so
  // the local override only survives until the server has been asked again.
  const [pending, setPending] = useState<Set<string> | null>(null);
  const serverSelected = useMemo(() => new Set((mine.data?.services ?? []).map((s) => s.slug)), [mine.data]);
  const selected = pending ?? serverSelected;

  const save = useMutation({
    mutationFn: (slugs: string[]) => api.put<{ services: MyService[] }>('/api/me/services', { services: slugs }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.meExtras.idCard() });
      toast.success('Saved.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.meExtras.services() });
      setPending(null);
    },
  });

  const toggle = (slug: string): void => {
    const next = new Set(selected);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    setPending(next);
    save.mutate([...next]);
  };

  const isPending = catalogue.isPending || mine.isPending;
  const error = catalogue.error ?? mine.error;

  return (
    <section className={cardClass}>
      <div className="space-y-4 p-5 md:p-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">What you would like to be asked about</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Tick the kinds of help you are happy to take on. You will only hear about the ones you have ticked.
          </p>
        </div>

        {isPending ? (
          <ListSkeleton rows={2} lines={2} />
        ) : catalogue.isError || mine.isError ? (
          <ErrorState
            error={error}
            onRetry={() => {
              void catalogue.refetch();
              void mine.refetch();
            }}
            what="the list of services"
          />
        ) : (
          <>
            <ul className="space-y-2">
              {catalogue.data.services.map((service) => (
                <li key={service.slug}>
                  <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800/60">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 flex-shrink-0 accent-[#EA0029]"
                      checked={selected.has(service.slug)}
                      disabled={save.isPending}
                      onChange={() => toggle(service.slug)}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900 dark:text-white">{service.name}</span>
                      {service.description ? (
                        <span className="block text-xs text-slate-500 dark:text-slate-400">{service.description}</span>
                      ) : null}
                      {service.dispatchable ? null : (
                        <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                          Arranged by a coordinator rather than sent out as a ride offer.
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {save.isPending ? <InlineSpinner label="Saving your choices" /> : null}
            {selected.size === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-400">
                With nothing ticked you will not be sent any requests. Tick at least one to start hearing from us again.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function CapabilitiesCard(): React.JSX.Element {
  const queryClient = useQueryClient();

  // There is no GET for capabilities on its own; the ID card endpoint is the
  // only place the server publishes the volunteer's current list back.
  const card = useQuery({
    queryKey: qk.meExtras.idCard(),
    queryFn: () => api.get<IdCardSummary>('/api/me/id-card'),
  });

  const [pending, setPending] = useState<Set<VolunteerCapability> | null>(null);
  const serverSelected = useMemo(() => {
    const current = new Set(card.data?.card.capabilities ?? []);
    return new Set(VOLUNTEER_CAPABILITIES.filter((capability) => current.has(capability)));
  }, [card.data]);
  const selected = pending ?? serverSelected;

  const save = useMutation({
    mutationFn: (capabilities: VolunteerCapability[]) =>
      api.put<{ capabilities: string[] }>('/api/me/capabilities', { capabilities }),
    onSuccess: () => toast.success('Saved.'),
    onError: (error: unknown) => toast.error(errorMessage(error)),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.meExtras.idCard() });
      setPending(null);
    },
  });

  const toggle = (capability: VolunteerCapability): void => {
    const next = new Set(selected);
    if (next.has(capability)) next.delete(capability);
    else next.add(capability);
    setPending(next);
    save.mutate([...next]);
  };

  return (
    <section className={cardClass}>
      <div className="space-y-4 p-5 md:p-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">What you can help with</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            A trip that needs a wheelchair only reaches volunteers who have said they can take one. Leaving a box
            unticked does not count against you; it keeps a request you could not manage from landing on your phone.
          </p>
        </div>

        {card.isPending ? (
          <ListSkeleton rows={1} lines={3} />
        ) : card.isError ? (
          <ErrorState error={card.error} onRetry={() => void card.refetch()} what="what you can help with" />
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {VOLUNTEER_CAPABILITIES.map((capability) => (
                <li key={capability}>
                  <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800/60">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 flex-shrink-0 accent-[#EA0029]"
                      checked={selected.has(capability)}
                      disabled={save.isPending}
                      onChange={() => toggle(capability)}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900 dark:text-white">
                        {CAPABILITY_LABELS[capability]}
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {CAPABILITY_HINTS[capability]}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {save.isPending ? <InlineSpinner label="Saving your choices" /> : null}
          </>
        )}
      </div>
    </section>
  );
}

interface StatusPresentation {
  label: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
  chipClass: string;
}

function presentStatus(licence: Licence): StatusPresentation {
  if (licence.status === 'verified') {
    return {
      label: licence.verificationProvider ? `Verified by ${licence.verificationProvider}` : 'Verified',
      detail: licence.verificationProvider
        ? `${licence.verificationProvider} confirmed this licence${licence.verifiedAt ? ` on ${formatDate(licence.verifiedAt)}` : ''}.`
        : 'This licence is marked verified, but the service that confirmed it was not recorded. An administrator can tell you which one it was.',
      icon: BadgeCheck,
      chipClass: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
    };
  }
  if (licence.status === 'on_file') {
    return {
      label: 'On file — an administrator has seen it',
      detail: `An administrator opened your photographs${licence.reviewedAt ? ` on ${formatDate(licence.reviewedAt)}` : ''} and kept them on file. Nothing has been checked against a provincial register, so this is not a verified licence.`,
      icon: IdCard,
      chipClass: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    };
  }
  if (licence.status === 'rejected') {
    return {
      label: 'Not accepted',
      detail: `An administrator could not accept what was uploaded${licence.reviewedAt ? ` on ${formatDate(licence.reviewedAt)}` : ''}. Upload clearer photographs, or speak to the office if you think this is a mistake.`,
      icon: XCircle,
      chipClass: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    };
  }
  if (licence.status === 'expired') {
    return {
      label: 'Expired',
      detail: 'The expiry date on file has passed. Upload your renewed licence so you can keep being offered rides.',
      icon: AlertTriangle,
      chipClass: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    };
  }
  return {
    label: 'Waiting for review',
    detail: 'Your photographs are with an administrator. Nothing has been checked yet, automatically or otherwise.',
    icon: FileClock,
    chipClass: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  };
}

function LicenceCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  const frontInput = useRef<HTMLInputElement>(null);
  const backInput = useRef<HTMLInputElement>(null);

  const [licenceNumber, setLicenceNumber] = useState('');
  const [province, setProvince] = useState('QC');
  const [expiresOn, setExpiresOn] = useState('');
  const [frontImage, setFrontImage] = useState<string | null>(null);
  const [backImage, setBackImage] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const licence = useQuery({
    queryKey: qk.meExtras.licence(),
    queryFn: () => api.get<{ licence: Licence | null }>('/api/me/licence'),
  });

  const existing = licence.data?.licence ?? null;
  useEffect(() => {
    if (!existing) return;
    setProvince(existing.province);
    setExpiresOn(existing.expiresOn ?? '');
  }, [existing]);

  const upload = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<{ note?: string }>('/api/me/licence', body),
    onSuccess: (data) => {
      // The write returns a trimmed licence, so the card is re-read rather than
      // patched from the response — a half-shaped object here would render as a
      // missing status, which on this card is the one thing that must not happen.
      void queryClient.invalidateQueries({ queryKey: qk.meExtras.licence() });
      setFrontImage(null);
      setBackImage(null);
      setLicenceNumber('');
      if (frontInput.current) frontInput.current.value = '';
      if (backInput.current) backInput.current.value = '';
      setNote(data.note ?? null);
      toast.success('Sent for review.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handleFile = async (file: File | undefined, side: 'front' | 'back'): Promise<void> => {
    if (!file) return;
    setPreparing(true);
    try {
      const prepared = await prepareImage(file);
      if (side === 'front') setFrontImage(prepared);
      else setBackImage(prepared);
    } catch (error) {
      toast.error(errorMessage(error));
      if (side === 'front' && frontInput.current) frontInput.current.value = '';
      if (side === 'back' && backInput.current) backInput.current.value = '';
    } finally {
      setPreparing(false);
    }
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!existing && !frontImage) {
      toast.error('Add a photo of the front of your licence.');
      return;
    }
    setNote(null);
    upload.mutate({
      ...(licenceNumber.trim() ? { licenceNumber: licenceNumber.trim() } : {}),
      province,
      country: 'CA',
      ...(expiresOn ? { expiresOn } : {}),
      ...(frontImage ? { frontImage } : {}),
      ...(backImage ? { backImage } : {}),
    });
  };

  const expiringSoon =
    existing?.expiresOn != null &&
    new Date(existing.expiresOn).getTime() - Date.now() < 60 * 24 * 60 * 60 * 1000 &&
    new Date(existing.expiresOn).getTime() > Date.now();

  return (
    <section className={cardClass}>
      <div className="space-y-4 p-5 md:p-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Driver&rsquo;s licence</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Photographs of your licence are held for administrators only, every time one is opened it is written to the
            audit log, and they are never shown to a caller or another volunteer.
          </p>
        </div>

        {licence.isPending ? (
          <ListSkeleton rows={1} lines={3} />
        ) : licence.isError ? (
          <ErrorState error={licence.error} onRetry={() => void licence.refetch()} what="your licence record" />
        ) : (
          <>
            {existing ? (
              <LicenceStatusPanel licence={existing} expiringSoon={expiringSoon} />
            ) : (
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <ShieldQuestion className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-400" aria-hidden="true" />
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Nothing on file yet. Add your licence below so an administrator can put it on your record.
                </p>
              </div>
            )}

            {note ? (
              <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {note}
              </p>
            ) : null}

            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="licence-number" className={labelClass}>
                    Licence number (optional)
                  </label>
                  <input
                    id="licence-number"
                    className={inputClass}
                    value={licenceNumber}
                    maxLength={40}
                    autoComplete="off"
                    onChange={(event) => setLicenceNumber(event.target.value)}
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Only the last four digits are kept where anyone can read them.
                  </p>
                </div>
                <div>
                  <label htmlFor="licence-province" className={labelClass}>
                    Province
                  </label>
                  <select
                    id="licence-province"
                    className={inputClass}
                    value={province}
                    onChange={(event) => setProvince(event.target.value)}
                  >
                    {PROVINCES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="licence-expiry" className={labelClass}>
                  Expires on (optional)
                </label>
                <input
                  id="licence-expiry"
                  type="date"
                  className={inputClass}
                  value={expiresOn}
                  onChange={(event) => setExpiresOn(event.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="licence-front" className={labelClass}>
                    Photo of the front
                  </label>
                  <input
                    id="licence-front"
                    ref={frontInput}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className={`${inputClass} py-2 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:text-slate-700 dark:file:bg-slate-700 dark:file:text-slate-200`}
                    onChange={(event) => void handleFile(event.target.files?.[0], 'front')}
                  />
                  {frontImage ? (
                    <p className="mt-1 text-xs text-green-700 dark:text-green-400">Front ready to send.</p>
                  ) : null}
                </div>
                <div>
                  <label htmlFor="licence-back" className={labelClass}>
                    Photo of the back (optional)
                  </label>
                  <input
                    id="licence-back"
                    ref={backInput}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className={`${inputClass} py-2 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:text-slate-700 dark:file:bg-slate-700 dark:file:text-slate-200`}
                    onChange={(event) => void handleFile(event.target.files?.[0], 'back')}
                  />
                  {backImage ? (
                    <p className="mt-1 text-xs text-green-700 dark:text-green-400">Back ready to send.</p>
                  ) : null}
                </div>
              </div>

              <p className="text-xs text-slate-500 dark:text-slate-400">
                Photos are shrunk on your phone before they are sent, so a large picture is fine. Keep the whole card in
                frame and the writing readable.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" className={primaryButtonClass} disabled={preparing || upload.isPending}>
                  <Camera className="h-4 w-4" aria-hidden="true" />
                  {upload.isPending ? 'Sending…' : existing ? 'Send an updated licence' : 'Send my licence'}
                </button>
                {preparing ? <InlineSpinner label="Getting the photo ready" /> : null}
              </div>
            </form>
          </>
        )}
      </div>
    </section>
  );
}

function LicenceStatusPanel({
  licence,
  expiringSoon,
}: {
  licence: Licence;
  expiringSoon: boolean;
}): React.JSX.Element {
  const presentation = presentStatus(licence);
  const Icon = presentation.icon;
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-5 w-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
        <span className={`rounded-full px-2 py-1 text-xs font-medium ${presentation.chipClass}`}>
          {presentation.label}
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{presentation.detail}</p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4 sm:justify-start sm:gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Province</dt>
          <dd className="text-slate-900 dark:text-white">{licence.province}</dd>
        </div>
        <div className="flex justify-between gap-4 sm:justify-start sm:gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Number ends in</dt>
          <dd className="text-slate-900 dark:text-white">{licence.numberLast4 ?? '—'}</dd>
        </div>
        <div className="flex justify-between gap-4 sm:justify-start sm:gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Expires</dt>
          <dd className="text-slate-900 dark:text-white">{licence.expiresOn ? formatDate(licence.expiresOn) : '—'}</dd>
        </div>
        <div className="flex justify-between gap-4 sm:justify-start sm:gap-2">
          <dt className="text-slate-500 dark:text-slate-400">Last looked at</dt>
          <dd className="text-slate-900 dark:text-white">
            {licence.reviewedAt ? formatDateTime(licence.reviewedAt) : 'Not yet'}
          </dd>
        </div>
      </dl>
      {expiringSoon ? (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          This licence expires within two months. Send the renewed one when you have it.
        </p>
      ) : null}
    </div>
  );
}
