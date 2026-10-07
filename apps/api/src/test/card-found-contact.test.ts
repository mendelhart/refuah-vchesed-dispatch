import { it, expect } from 'vitest';
import { cardReportSchema } from '../domain/card-report-schema.js';
const found = { reporterName: 'Synthetic Finder', organizationType: 'private person', contact: 'See phone number', reportType: 'found card', message: 'Synthetic found card', phone: '+1 514 555 0101', preferredContactMethod: 'text' };
it('accepts private found-card reporters without an organization', () => { expect(cardReportSchema.parse(found).organizationName).toBe(''); });
it('requires phone and an explicit preferred contact method for every found-card reporter', () => {
  for (const organizationType of ['private person', 'hospital']) {
    const v = { ...found, organizationType, organizationName: 'Synthetic Organization' };
    expect(cardReportSchema.safeParse({ ...v, phone: undefined }).success).toBe(false);
    expect(cardReportSchema.safeParse({ ...v, phone: 'letters-only' }).success).toBe(false);
    expect(cardReportSchema.safeParse({ ...v, preferredContactMethod: undefined }).success).toBe(false);
    expect(cardReportSchema.safeParse({ ...v, preferredContactMethod: 'email' }).success).toBe(false);
    expect(cardReportSchema.safeParse({ ...v, preferredContactMethod: 'email', contact: 'synthetic@example.invalid' }).success).toBe(true);
  }
});
it('retains organization requirements for complaints and disallows person-only complaints', () => {
  expect(cardReportSchema.safeParse({ ...found, reportType: 'official complaint' }).success).toBe(false);
  expect(cardReportSchema.safeParse({ ...found, organizationType: 'hospital', organizationName: '' }).success).toBe(false);
  expect(cardReportSchema.safeParse({ ...found, reportType: 'comment', organizationType: 'hospital', organizationName: 'Synthetic Hospital', phone: undefined, preferredContactMethod: undefined }).success).toBe(true);
});
