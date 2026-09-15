import { and, eq, isNull, sql as raw } from 'drizzle-orm';
import { ORG_TIMEZONE, SETTING_KEYS } from '@rvc/shared';
import { db } from '../db/client.js';
import { equipment, equipmentCategories, equipmentLoans, organizationInfo } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from '../lib/audit.js';
import { getNumberSetting } from '../lib/settings.js';
import { renderTemplate } from '../services/templates.service.js';
import { smsProvider } from '../services/providers/index.js';
import { localDateString } from '../lib/time.js';
import { pgArray } from '../lib/pg.js';
import { logger } from '../lib/logger.js';

/**
 * Equipment lending.
 *
 * Wheelchairs, walkers, hospital beds, crutches. The loans themselves were
 * already modelled correctly — a row with a lifecycle, and a partial unique
 * index making a double loan impossible. What was missing is everything that
 * makes an item come back: barcodes to find it, labels to put on it, and
 * reminders to the person who has it.
 *
 * Borrowers are not users and often never will be — a family borrows a
 * wheelchair once. So reminders go out by SMS directly, and the attempt is
 * audited rather than recorded as a notification delivery, for the same reason
 * as applicant messages (see applications.service.ts).
 */

/**
 * Generates the barcode for an item.
 *
 * Code 128 over a short alphanumeric string: it is what every cheap USB
 * scanner reads out of the box, and the value doubles as something a person can
 * type when the label is scuffed — which, on equipment that lives in the back
 * of cars, it will be.
 */
export function barcodeFor(itemCode: string): string {
  return `RVC${itemCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12)}`;
}

/** Resolves a scanned barcode or a typed item code to one item. */
export async function findByBarcode(code: string) {
  const clean = code.trim().toUpperCase();
  if (!clean) throw Errors.validation('Scan or type a code.');

  const [item] = await db
    .select({
      id: equipment.id,
      itemCode: equipment.itemCode,
      barcode: equipment.barcode,
      equipmentType: equipment.equipmentType,
      status: equipment.status,
      condition: equipment.condition,
      notes: equipment.notes,
      categoryName: equipmentCategories.name,
    })
    .from(equipment)
    .leftJoin(equipmentCategories, eq(equipmentCategories.id, equipment.categoryId))
    .where(
      and(
        isNull(equipment.deletedAt),
        raw`(upper(${equipment.barcode}) = ${clean} or upper(${equipment.itemCode}) = ${clean})`,
      ),
    )
    .limit(1);

  if (!item) throw Errors.notFound(`Nothing on file with the code ${clean}.`);

  const [openLoan] = await db
    .select()
    .from(equipmentLoans)
    .where(and(eq(equipmentLoans.equipmentId, item.id), isNull(equipmentLoans.returnedAt)))
    .limit(1);

  return { item, openLoan: openLoan ?? null };
}

/**
 * Printable label data for an item.
 *
 * Returns the payload rather than a rendered image: the browser draws the
 * barcode, which keeps a canvas library out of the server and lets the label
 * sheet be printed from any machine.
 */
export async function labelData(ids: string[]) {
  if (!ids.length) return [];
  const [org] = await db.select().from(organizationInfo).limit(1);
  const rows = await db
    .select({
      id: equipment.id,
      itemCode: equipment.itemCode,
      barcode: equipment.barcode,
      equipmentType: equipment.equipmentType,
      categoryName: equipmentCategories.name,
    })
    .from(equipment)
    .leftJoin(equipmentCategories, eq(equipmentCategories.id, equipment.categoryId))
    .where(raw`${equipment.id} = any(${pgArray(ids)}::uuid[])`);

  return rows.map((r) => ({
    ...r,
    barcode: r.barcode ?? barcodeFor(r.itemCode ?? r.id.slice(0, 8)),
    orgName: org?.name ?? "Refuah V'Chesed",
    orgPhone: org?.phone ?? null,
  }));
}

async function textBorrower(
  phone: string,
  key: 'equipment.loan_confirmed' | 'equipment.due_reminder' | 'equipment.overdue' | 'equipment.returned',
  vars: Record<string, unknown>,
): Promise<boolean> {
  try {
    const rendered = await renderTemplate(key, 'sms', vars);
    await smsProvider.send(phone, rendered.body);
    return true;
  } catch (err) {
    logger.error({ err, key }, 'equipment SMS to borrower failed');
    return false;
  }
}

export async function confirmLoanBySms(
  actor: AuditActor,
  loanId: string,
): Promise<{ sent: boolean }> {
  const [loan] = await db
    .select({
      id: equipmentLoans.id,
      borrowerName: equipmentLoans.borrowerName,
      borrowerPhone: equipmentLoans.borrowerPhone,
      expectedReturnAt: equipmentLoans.expectedReturnAt,
      equipmentType: equipment.equipmentType,
    })
    .from(equipmentLoans)
    .innerJoin(equipment, eq(equipment.id, equipmentLoans.equipmentId))
    .where(eq(equipmentLoans.id, loanId))
    .limit(1);
  if (!loan) throw Errors.notFound('That loan is not on file.');

  const [org] = await db.select().from(organizationInfo).limit(1);
  const sent = await textBorrower(loan.borrowerPhone, 'equipment.loan_confirmed', {
    itemName: loan.equipmentType,
    borrowerName: loan.borrowerName,
    dueDate: loan.expectedReturnAt ? localDateString(loan.expectedReturnAt) : 'the agreed date',
    orgName: org?.name ?? "Refuah V'Chesed",
  });

  await recordAudit({
    actor,
    action: 'equipment.loan_confirmation_sent',
    entityType: 'equipment_loan',
    entityId: loanId,
    metadata: { sent },
  });
  return { sent };
}

/**
 * Daily scan: due-soon reminders and overdue chases.
 *
 * Reminder state lives on the loan's notes-free columns rather than a separate
 * table: `reminder_sent_at` would have been cleaner, but the loan row already
 * carries the due date and the scan is idempotent per day through the job's
 * dedupe key, so a second run the same day sends nothing twice.
 */
export async function scanEquipmentDue(now = new Date()): Promise<{
  reminded: number;
  overdue: number;
}> {
  /**
   * Both sides of every date comparison below are Montreal calendar dates.
   *
   * `expected_return_at` is a timestamptz, so `::date` alone renders it in the
   * DATABASE's timezone — UTC on every deployment we run. Comparing that to a
   * Montreal "today" is correct for most of the day and wrong for the five
   * hours after 19:00 local, when UTC has already rolled over. A reminder that
   * fires a day early or not at all is the kind of defect nobody reports; they
   * just stop trusting the reminders. `at time zone` on each column keeps the
   * comparison in one calendar.
   */
  const todayLocal = localDateString(now);
  const leadDays = await getNumberSetting(SETTING_KEYS.equipmentDueReminderDays);
  const [org] = await db.select().from(organizationInfo).limit(1);

  const dueSoon = (await db.execute(raw`
    select l.id, l.borrower_name, l.borrower_phone, l.expected_return_at, e.equipment_type
      from equipment_loans l
      join equipment e on e.id = l.equipment_id
     where l.returned_at is null
       and l.expected_return_at is not null
       and (l.expected_return_at at time zone ${ORG_TIMEZONE})::date
           = (${todayLocal}::date + ${leadDays}::int)
  `)) as unknown as Array<{
    id: string; borrower_name: string; borrower_phone: string;
    expected_return_at: string; equipment_type: string;
  }>;

  let reminded = 0;
  for (const loan of dueSoon) {
    const ok = await textBorrower(loan.borrower_phone, 'equipment.due_reminder', {
      itemName: loan.equipment_type,
      borrowerName: loan.borrower_name,
      dueDate: localDateString(new Date(loan.expected_return_at)),
      orgPhone: org?.phone ?? '',
    });
    if (ok) reminded++;
  }

  // Overdue: chase once a week rather than every day. Daily texts about a
  // wheelchair get a family to block the number, and then the wheelchair is
  // gone for good.
  const overdueRows = (await db.execute(raw`
    select l.id, l.borrower_name, l.borrower_phone, l.expected_return_at, e.equipment_type,
           (${todayLocal}::date - (l.expected_return_at at time zone ${ORG_TIMEZONE})::date)
             as days_overdue
      from equipment_loans l
      join equipment e on e.id = l.equipment_id
     where l.returned_at is null
       and l.expected_return_at is not null
       and (l.expected_return_at at time zone ${ORG_TIMEZONE})::date < ${todayLocal}::date
       and ((${todayLocal}::date - (l.expected_return_at at time zone ${ORG_TIMEZONE})::date) % 7) = 0
  `)) as unknown as Array<{
    id: string; borrower_name: string; borrower_phone: string;
    expected_return_at: string; equipment_type: string; days_overdue: number;
  }>;

  let overdue = 0;
  for (const loan of overdueRows) {
    const ok = await textBorrower(loan.borrower_phone, 'equipment.overdue', {
      itemName: loan.equipment_type,
      borrowerName: loan.borrower_name,
      dueDate: localDateString(new Date(loan.expected_return_at)),
      daysOverdue: loan.days_overdue,
      orgPhone: org?.phone ?? '',
    });
    if (ok) overdue++;
  }

  if (reminded || overdue) {
    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: 'equipment.due_scan',
      entityType: 'equipment_loan',
      entityId: 'batch',
      metadata: { reminded, overdue },
    });
    logger.info({ reminded, overdue }, 'equipment due scan complete');
  }
  return { reminded, overdue };
}

/** Overdue items for the dispatcher board. */
export async function overdueLoans() {
  return (await db.execute(raw`
    select l.id, l.borrower_name, l.borrower_phone, l.expected_return_at,
           e.item_code, e.equipment_type,
           ((now() at time zone ${ORG_TIMEZONE})::date
            - (l.expected_return_at at time zone ${ORG_TIMEZONE})::date) as days_overdue
      from equipment_loans l
      join equipment e on e.id = l.equipment_id
     where l.returned_at is null
       and l.expected_return_at is not null
       and l.expected_return_at < now()
     order by l.expected_return_at
  `)) as unknown as Array<Record<string, unknown>>;
}
