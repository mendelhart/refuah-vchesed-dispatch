export const HOSPITAL_ROLE = 'Hospital';
export type Filter = 'all' | 'hospitals' | 'other';

export const FILTERS: { value: Filter; label: string }[] = [
  { value: 'hospitals', label: 'Hospitals' },
  { value: 'other', label: 'Other services' },
  { value: 'all', label: 'All' },
];

