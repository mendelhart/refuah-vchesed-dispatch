/**
 * Volunteer applications, and the decision a reviewer makes about each one.
 *
 * The duplicate check leads the panel on purpose. Nearly every bad approval in
 * the legacy system was the same mistake: a volunteer who already existed
 * applied again from a new phone, got a second account, and then had two
 * records with two availability settings and one of them unread. The server
 * already computes the matches, so they are the first thing on screen rather
 * than something the reviewer has to think to look for.
 *
 * Approval is the trust boundary — it creates a real account — so it is admin
 * only on the server, and this screen shows a dispatcher why the button is not
 * theirs instead of failing them with a 403 after they have written notes.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle, ArrowLeft, Car, ClipboardList, Inbox, Mail, MapPin, Phone, ShieldCheck,
} from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDate, formatDateTime, telHref, titleCase, formatPhone } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, InlineSpinner, ListSkeleton, PageHeader, cardClass, inputClass, labelClass,
  panelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';
import type { GroupsResponse } from '@/types/api';

interface ApplicationRow {
  id: string;
  reference: string;
  status: string;
  fullName: string;
  email: string;
  phone: string;
  addressLine: string | null;
  city: string | null;
  postalCode: string | null;
  serviceArea: string | null;
  requestedServices: string[];
  requestedGroups: string[];
  capabilities: string[];
  hasVehicle: boolean;
  vehicleType: string | null;
  vehicleSeats: number | null;
  availabilityNote: string | null;
  availability: Record<string, unknown> | string | null;
  languages: string[];
  referredBy: string | null;
  notes: string | null;
  notificationPreference: string | null;
  consentBackgroundCheck: boolean;
  duplicateOfUserId: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  infoRequestMessage: string | null;
  convertedUserId: string | null;
  createdAt: string;
}

interface ApplicationLicence {
  id: string;
  province: string | null;
  numberLast4: string | null;
  expiresOn: string | null;
  status: string;
  frontFileId: string | null;
  backFileId: string | null;
}

interface PossibleMatch {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
}

interface ApplicationListResponse {
  applications: ApplicationRow[];
  counts: Record<string, number>;
}

interface ApplicationDetailResponse {
  application: ApplicationRow;
  licence: ApplicationLicence | null;
  possibleMatches: PossibleMatch[];
}

interface ServicesResponse {
  services: { id: string; slug: string; name: string; description: string | null }[];
}

interface ApproveResponse {
  userId: string;
  volunteerNumber: string | null;
  status: string;
}

const TABS = ['submitted', 'info_requested', 'approved', 'rejected', 'all'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  submitted: 'New',
  info_requested: 'Waiting on them',
  approved: 'Approved',
  rejected: 'Rejected',
  all: 'All',
};

const STATUS_CLASSES: Record<string, string> = {
  submitted: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  info_requested: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  approved: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  withdrawn: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

const chipClass = 'inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200';

function statusChip(status: string): string {
  return `rounded-full px-3 py-1 text-xs font-medium ${STATUS_CLASSES[status] ?? STATUS_CLASSES.withdrawn}`;
}

export function ApplicationsPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('submitted');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: qk.applications.list(tab),
    queryFn: () => api.get<ApplicationListResponse>('/api/applications', { status: tab, limit: 100 }),
  });

  const counts = list.data?.counts;
  const countFor = (value: Tab): number | null => {
    if (!counts) return null;
    if (value === 'all') return Object.values(counts).reduce((sum, n) => sum + n, 0);
    return counts[value] ?? 0;
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Applications" subtitle="People who have asked to volunteer, and what happens next" />

      <div className="-mx-4 overflow-x-auto px-4">
        <div role="tablist" aria-label="Application statuses" className="flex w-max gap-2 pb-1">
          {TABS.map((value) => {
            const count = countFor(value);
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={value === tab}
                onClick={() => {
                  setTab(value);
                  setSelectedId(null);
                }}
                className={`min-h-[44px] whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors ${
                  value === tab
                    ? 'bg-[#E31E24] text-white'
                    : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
                }`}
              >
                {TAB_LABELS[value]}
                {count === null ? '' : ` (${count})`}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        {/* On a phone the list steps aside for the review panel; there is not
            room for both, and the panel is where the work happens. */}
        <div className={selectedId ? 'hidden lg:block' : 'block'}>
          {list.isPending ? (
            <ListSkeleton rows={4} lines={2} />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} what="the applications" />
          ) : list.data.applications.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing in this pile."
              hint="New applications from the signup form land here the moment they are submitted."
            />
          ) : (
            <ul className="space-y-2">
              {list.data.applications.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    aria-current={row.id === selectedId}
                    className={`${cardClass} w-full p-4 text-left ${
                      row.id === selectedId ? 'ring-2 ring-[#E31E24]' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900 dark:text-white">{row.fullName}</p>
                        <p className="truncate text-sm text-slate-600 dark:text-slate-400">
                          {row.city ?? 'No city given'} · {row.phone}
                        </p>
                        <p className="font-mono text-xs text-slate-400 dark:text-slate-500">{row.reference}</p>
                      </div>
                      <span className={statusChip(row.status)}>{titleCase(row.status)}</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Applied {formatDateTime(row.createdAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={selectedId ? 'block' : 'hidden lg:block'}>
          {selectedId ? (
            <ReviewPanel id={selectedId} onClose={() => setSelectedId(null)} />
          ) : (
            <EmptyState
              icon={ClipboardList}
              title="Pick an application to review."
              hint="Everything the applicant sent, and anybody on the roster who looks like them, shows up here."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewPanel({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { hasRole } = useAuth();
  const isAdmin = hasRole(['admin']);
  const [infoOpen, setInfoOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);

  const detail = useQuery({
    queryKey: qk.applications.detail(id),
    queryFn: () => api.get<ApplicationDetailResponse>(`/api/applications/${id}`),
  });

  const afterDecision = (message: string): void => {
    void queryClient.invalidateQueries({ queryKey: qk.applications.all() });
    void queryClient.invalidateQueries({ queryKey: qk.applications.detail(id) });
    toast.success(message);
  };

  const requestInfo = useMutation({
    mutationFn: (message: string) => api.post(`/api/applications/${id}/request-info`, { message }),
    onSuccess: () => {
      setInfoOpen(false);
      afterDecision('We have asked them for more detail.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const reject = useMutation({
    mutationFn: (body: { notes?: string; message?: string }) => api.post(`/api/applications/${id}/reject`, body),
    onSuccess: () => {
      setRejectOpen(false);
      afterDecision('Application rejected.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const approve = useMutation({
    mutationFn: (body: { role: string; groupSlugs: string[]; serviceSlugs: string[]; notes?: string }) =>
      api.post<ApproveResponse>(`/api/applications/${id}/approve`, body),
    onSuccess: (data) => {
      setApproveOpen(false);
      void queryClient.invalidateQueries({ queryKey: qk.people.list({}) });
      void queryClient.invalidateQueries({ queryKey: qk.volunteers.all() });
      afterDecision(
        data.volunteerNumber
          ? `Approved. Volunteer number ${data.volunteerNumber}.`
          : 'Approved. The account has been created.',
      );
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (detail.isPending) return <ListSkeleton rows={2} lines={5} />;
  if (detail.isError) {
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} what="this application" />;
  }

  const { application: app, licence, possibleMatches } = detail.data;
  const decided = app.status === 'approved' || app.status === 'rejected';

  return (
    <div className="space-y-4">
      <button type="button" className={`${secondaryButtonClass} lg:hidden`} onClick={onClose}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to the list
      </button>

      <section className={panelClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">{app.fullName}</h2>
            <p className="font-mono text-xs text-slate-400 dark:text-slate-500">{app.reference}</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Applied {formatDateTime(app.createdAt)}
              {app.reviewedAt ? ` · reviewed ${formatDateTime(app.reviewedAt)}` : ''}
            </p>
          </div>
          <span className={statusChip(app.status)}>{titleCase(app.status)}</span>
        </div>
      </section>

      <DuplicateMatches matches={possibleMatches} phone={app.phone} email={app.email} />

      <section className={panelClass}>
        <h3 className="mb-3 font-semibold text-slate-900 dark:text-white">How to reach them</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Phone className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <dt className="sr-only">Phone</dt>
            <dd>
              <a className="min-h-[44px] font-medium text-[#E31E24] underline" href={telHref(app.phone)}>
                {formatPhone(app.phone)}
              </a>
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Mail className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <dt className="sr-only">Email</dt>
            <dd>
              <a className="break-all text-slate-700 underline dark:text-slate-200" href={`mailto:${app.email}`}>
                {app.email}
              </a>
            </dd>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <MapPin className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
            <dt className="sr-only">Address</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {[app.addressLine, app.city, app.postalCode].filter(Boolean).join(', ') || 'No address given'}
              {app.serviceArea ? ` · works in ${app.serviceArea}` : ''}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          Prefers {app.notificationPreference ? titleCase(app.notificationPreference) : 'no stated channel'}
          {' · '}
          {app.languages.length > 0 ? `speaks ${app.languages.map(titleCase).join(', ')}` : 'no languages given'}
        </p>
      </section>

      <section className={panelClass}>
        <h3 className="mb-3 font-semibold text-slate-900 dark:text-white">What they asked to do</h3>
        <FieldChips label="Services" values={app.requestedServices} empty="No services chosen" />
        <FieldChips label="Groups" values={app.requestedGroups} empty="No group chosen" />
        <FieldChips label="Can handle" values={app.capabilities} empty="No special capabilities stated" />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <Car className="h-4 w-4 text-slate-400" aria-hidden="true" />
          {app.hasVehicle
            ? `Has a vehicle${app.vehicleType ? ` · ${app.vehicleType}` : ''}${
                app.vehicleSeats ? ` · ${app.vehicleSeats} seats` : ''
              }`
            : 'No vehicle'}
        </div>
        {app.availabilityNote ? (
          <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
            <span className="font-medium">When they are free: </span>
            {app.availabilityNote}
          </p>
        ) : null}
        {app.availability && typeof app.availability === 'object' ? (
          <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {JSON.stringify(app.availability, null, 2)}
          </pre>
        ) : typeof app.availability === 'string' && app.availability ? (
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{app.availability}</p>
        ) : null}
        {app.referredBy ? (
          <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
            <span className="font-medium">Referred by: </span>
            {app.referredBy}
          </p>
        ) : null}
        {app.notes ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
            <span className="font-medium">What they told us: </span>
            {app.notes}
          </p>
        ) : null}
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <ShieldCheck className="h-4 w-4 text-slate-400" aria-hidden="true" />
          {app.consentBackgroundCheck
            ? 'Agreed to a background check.'
            : 'Did not agree to a background check.'}
        </p>
      </section>

      <LicencePanel licence={licence} isAdmin={isAdmin} />

      {app.infoRequestMessage ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <h3 className="font-semibold text-amber-900 dark:text-amber-200">We asked them for more</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{app.infoRequestMessage}</p>
        </section>
      ) : null}

      {app.reviewNotes ? (
        <section className={panelClass}>
          <h3 className="font-semibold text-slate-900 dark:text-white">Reviewer notes</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{app.reviewNotes}</p>
        </section>
      ) : null}

      {app.convertedUserId ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          This application became an account. Find them on the people screen.
        </p>
      ) : null}

      {decided ? null : (
        <section className={panelClass}>
          <h3 className="mb-3 font-semibold text-slate-900 dark:text-white">Decide</h3>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!isAdmin}
              onClick={() => setApproveOpen(true)}
            >
              Approve and create the account
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setInfoOpen(true)}>
              Ask for more
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={!isAdmin}
              onClick={() => setRejectOpen(true)}
            >
              Reject
            </button>
          </div>
          {isAdmin ? null : (
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Approving and rejecting are an administrator&rsquo;s call. You can still ask the applicant for more
              detail.
            </p>
          )}
        </section>
      )}

      <RequestInfoModal
        open={infoOpen}
        busy={requestInfo.isPending}
        name={app.fullName}
        onClose={() => setInfoOpen(false)}
        onSubmit={(message) => requestInfo.mutate(message)}
      />
      <RejectModal
        open={rejectOpen}
        busy={reject.isPending}
        name={app.fullName}
        onClose={() => setRejectOpen(false)}
        onSubmit={(body) => reject.mutate(body)}
      />
      <ApproveModal
        open={approveOpen}
        busy={approve.isPending}
        application={app}
        onClose={() => setApproveOpen(false)}
        onSubmit={(body) => approve.mutate(body)}
      />
    </div>
  );
}

/**
 * The most useful thing on the screen: the people already on the roster who
 * share this applicant's phone or email, and which of the two matched.
 */
function DuplicateMatches({
  matches,
  phone,
  email,
}: {
  matches: PossibleMatch[];
  phone: string;
  email: string;
}): React.JSX.Element {
  if (matches.length === 0) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
        Nobody on the roster shares this phone number or email address.
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <h3 className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        We may already have this person
      </h3>
      <ul className="mt-3 space-y-2">
        {matches.map((match) => {
          const samePhone = Boolean(match.phone) && match.phone === phone;
          const sameEmail = Boolean(match.email) && match.email?.toLowerCase() === email.toLowerCase();
          return (
            <li key={match.id} className="rounded-lg bg-white p-3 text-sm dark:bg-slate-900">
              <p className="font-medium text-slate-900 dark:text-white">
                {samePhone
                  ? `This phone number already belongs to ${match.fullName}.`
                  : sameEmail
                    ? `This email address already belongs to ${match.fullName}.`
                    : `${match.fullName} looks like the same person.`}
              </p>
              <p className="mt-1 text-slate-600 dark:text-slate-400">
                {match.phone ?? 'No phone'} · {match.email ?? 'No email'} · account {titleCase(match.status)}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">
        Approving makes a second, separate account. If this is the same person, fix their existing record instead.
      </p>
    </section>
  );
}

function LicencePanel({
  licence,
  isAdmin,
}: {
  licence: ApplicationLicence | null;
  isAdmin: boolean;
}): React.JSX.Element | null {
  if (!licence) return null;

  const images = [
    { id: licence.frontFileId, label: 'Front of the licence' },
    { id: licence.backFileId, label: 'Back of the licence' },
  ].filter((image): image is { id: string; label: string } => Boolean(image.id));

  return (
    <section className={panelClass}>
      <h3 className="font-semibold text-slate-900 dark:text-white">Driving licence</h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {licence.province ?? 'Province not given'}
        {licence.numberLast4 ? ` · ending ${licence.numberLast4}` : ''}
        {licence.expiresOn ? ` · expires ${formatDate(`${licence.expiresOn}T00:00:00`)}` : ''}
        {' · '}
        {titleCase(licence.status)}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Nothing here has been checked against a licensing authority. It is a photograph somebody sent us.
      </p>
      {images.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">No images were uploaded.</p>
      ) : isAdmin ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {images.map((image) => (
            <figure key={image.id}>
              <img
                src={`/api/files/${image.id}?reason=application%20review`}
                alt={image.label}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700"
              />
              <figcaption className="mt-1 text-xs text-slate-500 dark:text-slate-400">{image.label}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          Licence images are shown to administrators only, and every viewing is recorded.
        </p>
      )}
    </section>
  );
}

function FieldChips({
  label,
  values,
  empty,
}: {
  label: string;
  values: string[];
  empty: string;
}): React.JSX.Element {
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      {values.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{empty}</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-2">
          {values.map((value) => (
            <li key={value} className={chipClass}>
              {titleCase(value)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RequestInfoModal({
  open,
  busy,
  name,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  name: string;
  onClose: () => void;
  onSubmit: (message: string) => void;
}): React.JSX.Element {
  const [message, setMessage] = useState('');

  return (
    <Modal open={open} title="Ask for more detail" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!message.trim()) {
            toast.error('Say what you need from them.');
            return;
          }
          onSubmit(message.trim());
        }}
      >
        <div>
          <label htmlFor="info-message" className={labelClass}>
            What do you need from {name}?
          </label>
          <textarea
            id="info-message"
            rows={5}
            maxLength={1000}
            className={`${inputClass} py-2`}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="We need the postal code and a photo of your licence."
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            They get this exactly as written, so write it to them, not about them.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryButtonClass} disabled={busy}>
            {busy ? 'Sending…' : 'Send the request'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RejectModal({
  open,
  busy,
  name,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  name: string;
  onClose: () => void;
  onSubmit: (body: { notes?: string; message?: string }) => void;
}): React.JSX.Element {
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');

  return (
    <Modal open={open} title={`Reject ${name}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            ...(message.trim() ? { message: message.trim() } : {}),
          });
        }}
      >
        <div>
          <label htmlFor="reject-notes" className={labelClass}>
            Why (internal)
          </label>
          <textarea
            id="reject-notes"
            rows={3}
            maxLength={1000}
            className={`${inputClass} py-2`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Kept on the application. The applicant never sees this.
          </p>
        </div>
        <div>
          <label htmlFor="reject-message" className={labelClass}>
            Message to them (optional)
          </label>
          <textarea
            id="reject-message"
            rows={3}
            maxLength={1000}
            className={`${inputClass} py-2`}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryButtonClass} disabled={busy}>
            {busy ? 'Rejecting…' : 'Reject the application'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Approval is the one place groups and services can be corrected before an
 * account exists, so the applicant's own choices are shown pre-ticked rather
 * than applied silently — people tick every box on a signup form.
 */
function ApproveModal({
  open,
  busy,
  application,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  application: ApplicationRow;
  onClose: () => void;
  onSubmit: (body: { role: string; groupSlugs: string[]; serviceSlugs: string[]; notes?: string }) => void;
}): React.JSX.Element {
  const [role, setRole] = useState<'volunteer' | 'dispatcher'>('volunteer');
  const [groupSlugs, setGroupSlugs] = useState<string[]>(application.requestedGroups);
  const [serviceSlugs, setServiceSlugs] = useState<string[]>(application.requestedServices);
  const [notes, setNotes] = useState('');

  const groups = useQuery({
    queryKey: qk.people.groups(),
    queryFn: () => api.get<GroupsResponse>('/api/groups'),
    enabled: open,
  });
  const services = useQuery({
    queryKey: qk.services.list(),
    queryFn: () => api.get<ServicesResponse>('/api/services'),
    enabled: open,
  });

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <Modal open={open} title={`Approve ${application.fullName}`} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ role, groupSlugs, serviceSlugs, ...(notes.trim() ? { notes: notes.trim() } : {}) });
        }}
      >
        <div>
          <label htmlFor="approve-role" className={labelClass}>
            Role
          </label>
          <select
            id="approve-role"
            className={inputClass}
            value={role}
            onChange={(event) => setRole(event.target.value as 'volunteer' | 'dispatcher')}
          >
            <option value="volunteer">Volunteer</option>
            <option value="dispatcher">Dispatcher</option>
          </select>
        </div>

        <fieldset>
          <legend className={labelClass}>Groups</legend>
          {groups.isPending ? (
            <InlineSpinner label="Loading groups" />
          ) : groups.isError ? (
            <p className="text-sm text-[#E31E24]">{errorMessage(groups.error)}</p>
          ) : (
            <ul className="space-y-1">
              {groups.data.groups.map((group) => (
                <li key={group.slug}>
                  <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      className="h-5 w-5 rounded border-slate-300 text-[#E31E24] focus:ring-[#E31E24] dark:border-slate-600 dark:bg-slate-800"
                      checked={groupSlugs.includes(group.slug)}
                      onChange={() => setGroupSlugs((current) => toggle(current, group.slug))}
                    />
                    {group.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset>
          <legend className={labelClass}>Services</legend>
          {services.isPending ? (
            <InlineSpinner label="Loading services" />
          ) : services.isError ? (
            <p className="text-sm text-[#E31E24]">{errorMessage(services.error)}</p>
          ) : (
            <ul className="space-y-1">
              {services.data.services.map((service) => (
                <li key={service.slug}>
                  <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      className="h-5 w-5 rounded border-slate-300 text-[#E31E24] focus:ring-[#E31E24] dark:border-slate-600 dark:bg-slate-800"
                      checked={serviceSlugs.includes(service.slug)}
                      onChange={() => setServiceSlugs((current) => toggle(current, service.slug))}
                    />
                    {service.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <div>
          <label htmlFor="approve-notes" className={labelClass}>
            Notes (internal, optional)
          </label>
          <textarea
            id="approve-notes"
            rows={3}
            maxLength={1000}
            className={`${inputClass} py-2`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-400">
          This creates a real account and sends {application.fullName} a welcome message.
        </p>

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryButtonClass} disabled={busy}>
            {busy ? 'Approving…' : 'Approve and create the account'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
