/** Address draft shape and pure helpers, kept free of React so tests can import them. */
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
