/** Package details in the new-trip form (item 6). Unit-tested. */
export type PackageSize = 'small' | 'medium' | 'large';

export interface PackageDraft {
  isPackage: boolean;
  description: string;
  size: PackageSize;
  weightKg: string;
  recipientName: string;
  recipientPhone: string;
  handlingNotes: string;
}

export function blankPackage(): PackageDraft {
  return { isPackage: false, description: '', size: 'small', weightKg: '', recipientName: '', recipientPhone: '', handlingNotes: '' };
}

export function buildPackagePayload(trip: Record<string, unknown>, p: PackageDraft): Record<string, unknown> {
  const weight = p.weightKg.trim() ? Number(p.weightKg.replace(',', '.')) : null;
  return {
    trip: { ...trip, tripType: 'equipment_delivery', mobilityNeeds: [] },
    package: {
      description: p.description.trim(),
      size: p.size,
      weightKg: weight,
      recipientName: p.recipientName.trim(),
      recipientPhone: p.recipientPhone.trim() || null,
      handlingNotes: p.handlingNotes.trim() || null,
    },
  };
}

export const SIZE_LABELS: Record<PackageSize, string> = {
  small: 'Small: fits on a seat',
  medium: 'Medium: needs the back seat or trunk',
  large: 'Large: needs a big trunk or two people',
};
