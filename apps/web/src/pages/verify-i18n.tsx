import React, { useState } from 'react';

export type Lang = 'fr' | 'en';

const KEY = 'rvc-verify-lang';

export function initialLang(): Lang {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === 'fr' || stored === 'en') return stored;
  } catch {
    /* storage unavailable */
  }
  return 'fr';
}

export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang): void => {
    setLangState(l);
    try {
      window.localStorage.setItem(KEY, l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l;
  };
  return [lang, setLang];
}

export const T = {
  checking: { fr: 'Vérification…', en: 'Checking…' },
  unable: { fr: 'Impossible de vérifier cette carte', en: 'Unable to verify this card' },
  lost: { fr: 'Signalée perdue - non valide', en: 'Reported lost - not valid' },
  revoked: { fr: 'Révoquée - non valide', en: 'Revoked - not valid' },
  expired: { fr: 'Expirée - non valide', en: 'Expired - not valid' },
  invalid: { fr: "Cette carte n'est pas valide", en: 'This card is not valid' },
  askId: {
    fr: "Veuillez demander une autre pièce d'identité au titulaire.",
    en: 'Please ask the holder for another form of identification.',
  },
  activeWith: { fr: 'est un bénévole actif de', en: 'is an active volunteer with' },
  vehicle: { fr: 'Véhicule', en: 'Vehicle' },
  plate: { fr: "Plaque d'immatriculation", en: 'License plate' },
  photoMatch: {
    fr: 'Vérifiez que cette photo correspond à la personne devant vous.',
    en: 'Check that this photo matches the person in front of you.',
  },
  noPhoto: {
    fr: "Aucune photo au dossier. Veuillez vérifier une autre pièce d'identité avec photo.",
    en: 'No photo on file. Please check another photo ID.',
  },
  previewBanner: { fr: 'APERÇU SYNTHÉTIQUE - CARTE NON RÉELLE', en: 'SYNTHETIC PREVIEW - NOT A REAL CARD' },
  previewValid: { fr: 'Valide - bénévole actif', en: 'Valid - active volunteer' },
  previewLost: { fr: 'Cette carte a été signalée perdue - non valide', en: 'This card was reported lost - not valid' },
  previewRevoked: { fr: 'Cette carte a été révoquée - non valide', en: 'This card was revoked - not valid' },
  previewNote: {
    fr: "Ceci est un exemple synthétique. Aucune donnée personnelle n'est publiée.",
    en: 'This is a synthetic example. No person data is published by this preview.',
  },
  samplePhoto: { fr: 'Photo exemple', en: 'Sample photo' },
  btnReport: { fr: 'Signaler un comportement / plainte', en: 'Report misbehavior / complaint' },
  btnFound: { fr: "J'ai trouvé cette carte", en: 'I found this card' },
  btnContact: { fr: 'Nous joindre', en: 'Contact us' },
  formNote: {
    fr: "Vos renseignements vont à la boîte privée de l'administration RVC. L'identité du déclarant n'est pas vérifiée. Aucune coordonnée du bénévole n'est partagée. Pour une urgence, communiquez directement avec RVC.",
    en: 'Your information goes to the private RVC admin inbox. Reporter identity is unverified. No volunteer contact details are shared. For urgent help, contact RVC directly.',
  },
  reportType: { fr: 'Type de signalement', en: 'Report type' },
  yourName: { fr: 'Votre nom', en: 'Your name' },
  orgType: { fr: "Type d'organisation", en: 'Organization type' },
  orgName: { fr: "Nom de l'organisation", en: 'Organization name' },
  contact: { fr: 'Courriel ou téléphone', en: 'Email or phone' },
  message: { fr: 'Message', en: 'Message' },
  submit: { fr: 'Envoyer à RVC', en: 'Submit to RVC' },
  saving: { fr: 'Enregistrement…', en: 'Saving…' },
  sampleOnly: { fr: 'Formulaire exemple seulement; envoi désactivé.', en: 'Sample form only; submission disabled.' },
  received: {
    fr: "Reçu dans la boîte privée de l'administration RVC. Aucun message automatique n'a été envoyé.",
    en: 'Received in the private RVC admin inbox. No automated messages were sent.',
  },
  failed: { fr: "Le signalement n'a pas pu être enregistré", en: 'Report could not be saved' },
} as const;

export const REPORT_TYPES: [string, { fr: string; en: string }][] = [
  ['report conduct', { fr: 'Signaler un comportement', en: 'Report conduct' }],
  ['official complaint', { fr: 'Plainte officielle', en: 'Official complaint' }],
  ['comment', { fr: 'Commentaire', en: 'Comment' }],
  ['found card', { fr: 'Carte trouvée', en: 'Found card' }],
];
export const ORG_TYPES: [string, { fr: string; en: string }][] = [
  ['hospital', { fr: 'Hôpital', en: 'Hospital' }],
  ['law enforcement', { fr: 'Forces de l\u2019ordre', en: 'Law enforcement' }],
  ['other agency', { fr: 'Autre organisme', en: 'Other agency' }],
  ['private company', { fr: 'Entreprise privée', en: 'Private company' }],
  ['other', { fr: 'Autre', en: 'Other' }],
];

export function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }): React.JSX.Element {
  return (
    <div className="mb-4 flex justify-end gap-2" role="group" aria-label="Langue / Language">
      {(['fr', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`rounded border px-3 py-1 text-sm ${lang === l ? 'bg-[#ed1925] text-white' : 'bg-white text-slate-800'}`}
        >
          {l === 'fr' ? 'Français' : 'English'}
        </button>
      ))}
    </div>
  );
}
