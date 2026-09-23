import { describe, expect, it } from 'vitest';
import { parseTypedAddress } from '../services/providers/nominatim.js';

describe('parseTypedAddress', () => {
  it('pulls the street out of a full typed address', () => {
    expect(parseTypedAddress('760 querbes av Outremont Quebec H2V 3W9')).toEqual({
      street: '760 querbes av', postal: 'H2V 3W9', cleaned: '760 querbes av Outremont',
    });
  });
  it('handles commas and a postal code without a space', () => {
    const r = parseTypedAddress('760 Querbes Av, Outremont, QC h2v3w9');
    expect(r.street).toBe('760 Querbes Av');
    expect(r.postal).toBe('H2V 3W9');
  });
  it('leaves French order and place names alone', () => {
    expect(parseTypedAddress('760 avenue Querbes').street).toBe('760 avenue Querbes');
    expect(parseTypedAddress('Jewish General').street).toBe('Jewish General');
  });
});
