import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Plain-language privacy notice. Public (no sign-in), linked from the sign-in
 * page, the volunteer signup form and the menu.
 *
 * Keep it in step with docs/SECURITY.md "Retention". It says only what the
 * app actually does; anything the organisation decides outside the app (who
 * the privacy officer is) belongs to the office, and
 * the page tells people to ask the office.
 */

const LAST_UPDATED = 'October 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{children}</div>
    </section>
  );
}

export function PrivacyPage(): React.JSX.Element {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 dark:bg-slate-950">
      <article className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-8">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Privacy notice</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Refuah V&apos;Chesed dispatch app · last updated {LAST_UPDATED}</p>

        <p className="mt-4 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
          This app helps Refuah V&apos;Chesed match people who need a ride, a delivery or a visit with volunteers who can
          help. This page explains, in plain words, what the app keeps about you, who can see it and how long it is kept.
        </p>

        <Section title="What we keep">
          <p><strong>Volunteers and staff:</strong> your name, phone, email, the area you live in, the services and groups you
            help with, when you are available, how you like to be contacted, your vehicle if you drive, and an optional
            photo for your ID card. If a service needs it, we may also keep driver licence details, stored encrypted.</p>
          <p><strong>People we help:</strong> the name, phone, pickup and drop-off addresses and notes needed to arrange each
            ride or delivery.</p>
          <p><strong>Activity:</strong> which rides were offered, accepted and completed, messages sent through the app,
            the call log, and a record of important changes (who changed what, and when).</p>
        </Section>

        <Section title="Why we keep it">
          <p>Only to organise volunteering: to offer rides to the right volunteers, to contact you about them, to keep
            people safe, and to answer questions later about what happened on a ride. We do not sell your information, show
            ads, or use tracking or analytics tools.</p>
        </Section>

        <Section title="Who can see it">
          <p><strong>Volunteers</strong> see their own details and the rides they are offered or have taken. A volunteer only
            sees a passenger&apos;s details for a ride they have been offered.</p>
          <p><strong>Coordinators</strong> see volunteers and the rides they arrange. <strong>Admins</strong> can see
            everything and are the only ones who can export data.</p>
          <p>If a hospital or reception desk scans your volunteer ID card, they see only your name, volunteer number and
            photo, and whether the card is current. Nothing else.</p>
          <p>To send messages, the app may pass your phone number or email and the message text to the text, WhatsApp or
            email service that delivers it.</p>
        </Section>

        <Section title="How long we keep it">
          <ul className="list-disc space-y-1 pl-5">
            <li>App notifications: 180 days.</li>
            <li>Text and WhatsApp messages: 1 year.</li>
            <li>Call log: after 1 year the name and number are wiped; only the count is kept.</li>
            <li>Data exports: deleted after 7 days.</li>
            <li>Signup details such as your internet address are wiped once your application is approved.</li>
            <li>If you stop volunteering and are removed, your phone and email are cleared and you can no longer sign in.
              Your name stays on past rides so the history still makes sense.</li>
            <li>The record of important changes is kept permanently so it cannot be quietly edited.</li>
            <li>An encrypted manual backup is kept separately. Automatic backup scheduling and a fixed backup-retention period are not yet configured.</li>
          </ul>
        </Section>

        <Section title="Where it is stored">
          <p>The app runs on servers in Ohio, in the United States. It is not hosted in Canada.</p>
        </Section>

        <Section title="Keeping it safe">
          <p>Everything travels over an encrypted connection. Passwords are never stored in readable form. Sensitive items
            like licence details are encrypted. Authenticator-app sign-in is available, but is not currently required for coordinators and admins.</p>
        </Section>

        <Section title="Your choices">
          <p>You can see and correct most of your details yourself under your profile. You can change how you are
            contacted, or pause messages, at any time. To get a copy of what we keep about you, to have something
            corrected, or to be removed, contact the Refuah V&apos;Chesed office.</p>
        </Section>

        <p className="mt-8 text-sm">
          <Link to="/" className="font-medium text-[#C80023] dark:text-red-400 underline-offset-2 hover:underline">Back to the app</Link>
        </p>
      </article>
    </main>
  );
}
