import { z } from 'zod';
export const cardReportSchema = z.object({
  reporterName: z.string().trim().min(1).max(120),
  organizationType: z.enum(['hospital', 'law enforcement', 'other agency', 'private company', 'private person', 'other']),
  organizationName: z.string().trim().max(160).default(''),
  contact: z.string().trim().min(3).max(180),
  phone: z.string().trim().max(40).optional(),
  preferredContactMethod: z.enum(['phone', 'text', 'WhatsApp', 'email']).optional(),
  reportType: z.enum(['report conduct', 'official complaint', 'comment', 'found card']),
  message: z.string().trim().min(1).max(4000),
}).strict().superRefine((v, ctx) => {
  const fail = (path: string, message: string): void => { ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message }); };
  if (v.organizationType !== 'private person' && !v.organizationName) fail('organizationName', 'Organization name is required');
  if (v.organizationType === 'private person' && v.reportType !== 'found card') fail('organizationType', 'Private person is available for found cards');
  if (v.reportType === 'found card') {
    if (!v.phone || !/^[+()\d .-]+$/.test(v.phone) || (v.phone.match(/\d/g) ?? []).length < 7) fail('phone', 'A phone number is required');
    if (!v.preferredContactMethod) fail('preferredContactMethod', 'Choose a preferred contact method');
    if (v.preferredContactMethod === 'email' && !z.string().email().safeParse(v.contact).success) fail('contact', 'An email address is required for email contact');
  }
});
