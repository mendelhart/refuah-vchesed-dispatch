import { describe, expect, it } from 'vitest';
import { blankPackage, buildPackagePayload } from '@/components/package-model';

describe('package model', () => {
  it('a package always travels as an equipment delivery, with no mobility needs', () => {
    const body = buildPackagePayload({ tripType: 'ride', mobilityNeeds: ['wheelchair'], callerName: 'A' }, {
      ...blankPackage(), isPackage: true, description: ' Box ', recipientName: ' Leah ', weightKg: '1,5', recipientPhone: '', handlingNotes: '',
    });
    expect(body.trip).toMatchObject({ tripType: 'equipment_delivery', mobilityNeeds: [], callerName: 'A' });
    expect(body.package).toEqual({ description: 'Box', size: 'small', weightKg: 1.5, recipientName: 'Leah', recipientPhone: null, handlingNotes: null });
  });

  it('weight is optional', () => {
    expect((buildPackagePayload({}, { ...blankPackage(), weightKg: '' }).package as { weightKg: number | null }).weightKg).toBeNull();
  });
});
