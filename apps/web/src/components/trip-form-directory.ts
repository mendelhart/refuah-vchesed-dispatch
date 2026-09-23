/** Directory rows. Declared here rather than imported so this dialog does not
 *  depend on the Callers screen staying mounted or staying put. */
export interface CallerSearchRow {
  id: string;
  name: string;
  primaryPhone: string | null;
  alternatePhone: string | null;
  language: string;
  notes: string | null;
  accessNotes: string | null;
  tripCount: number;
  lastTripAt: string | null;
}
export interface CallerSearchResponse {
  results: CallerSearchRow[];
}
export interface SavedAddressRow {
  id: string;
  label: string;
  entrance: string | null;
  parking: string | null;
  isDefaultPickup: boolean;
  useCount: number;
  lastUsedAt: string | null;
  address: {
    id: string;
    line1: string;
    unit: string | null;
    city: string;
    province: string;
    postalCode: string | null;
    notes: string | null;
    latitude: number | null;
    longitude: number | null;
  };
}
export interface CallerProfileResponse {
  caller: {
    id: string;
    name: string;
    primaryPhone: string | null;
    alternatePhone: string | null;
    language: string;
    notes: string | null;
    accessNotes: string | null;
  };
  addresses: SavedAddressRow[];
  history: unknown[];
}
