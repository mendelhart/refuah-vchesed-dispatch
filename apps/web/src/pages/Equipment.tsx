/**
 * Equipment: the stock list and what is out on loan.
 *
 * A loan is a row with a lifecycle (loan → return), which is what the API
 * models, so this screen never edits fields on the item to fake a loan.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Package, PackageCheck, Plus } from 'lucide-react';
import { equipmentSchema, loanEquipmentSchema } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDate, titleCase } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';
import type { EquipmentCategoriesResponse, EquipmentLoansResponse, EquipmentResponse } from '@/types/api';

const STATUS_CLASSES: Record<string, string> = {
  available: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  loaned: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  maintenance: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  retired: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

export function EquipmentPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isDispatch = user?.role === 'dispatcher' || user?.role === 'admin';

  const [addOpen, setAddOpen] = useState(false);
  const [loanFor, setLoanFor] = useState<string | null>(null);
  const [item, setItem] = useState({ equipmentType: '', itemCode: '', categoryId: '', condition: 'good', notes: '' });
  const [loan, setLoan] = useState({ borrowerName: '', borrowerPhone: '', borrowerAddress: '', expectedReturnAt: '', notes: '' });

  const equipment = useQuery({
    queryKey: qk.equipment.list({}),
    queryFn: () => api.get<EquipmentResponse>('/api/equipment', { limit: 200 }),
  });
  const categories = useQuery({
    queryKey: qk.equipment.categories(),
    queryFn: () => api.get<EquipmentCategoriesResponse>('/api/equipment/categories'),
  });
  const loans = useQuery({
    queryKey: qk.equipment.loans(true),
    queryFn: () => api.get<EquipmentLoansResponse>('/api/equipment/loans', { open: true }),
    enabled: isDispatch,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.equipment.list({}) });
    void queryClient.invalidateQueries({ queryKey: qk.equipment.loans(true) });
  };

  const createItem = useMutation({
    mutationFn: () =>
      api.post('/api/equipment', {
        equipmentType: item.equipmentType.trim(),
        itemCode: item.itemCode.trim() || null,
        categoryId: item.categoryId || null,
        condition: item.condition,
        notes: item.notes.trim() || null,
      }),
    onSuccess: () => {
      invalidate();
      toast.success('Item added.');
      setAddOpen(false);
      setItem({ equipmentType: '', itemCode: '', categoryId: '', condition: 'good', notes: '' });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const lendItem = useMutation({
    mutationFn: (equipmentId: string) =>
      api.post(`/api/equipment/${equipmentId}/loan`, {
        borrowerName: loan.borrowerName.trim(),
        borrowerPhone: loan.borrowerPhone.trim(),
        borrowerAddress: loan.borrowerAddress.trim() || null,
        expectedReturnAt: loan.expectedReturnAt ? new Date(loan.expectedReturnAt).toISOString() : null,
        notes: loan.notes.trim() || null,
      }),
    onSuccess: () => {
      invalidate();
      toast.success('Loan recorded.');
      setLoanFor(null);
      setLoan({ borrowerName: '', borrowerPhone: '', borrowerAddress: '', expectedReturnAt: '', notes: '' });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const returnItem = useMutation({
    mutationFn: (equipmentId: string) => api.post(`/api/equipment/${equipmentId}/return`, {}),
    onSuccess: () => {
      invalidate();
      toast.success('Item marked returned.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Equipment"
        subtitle="Wheelchairs, walkers and everything else on loan"
        actions={
          isDispatch ? (
            <button type="button" className={primaryButtonClass} onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add item
            </button>
          ) : undefined
        }
      />

      {isDispatch ? (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-white">Out on loan</h2>
          {loans.isPending ? (
            <ListSkeleton rows={2} lines={1} />
          ) : loans.isError ? (
            <ErrorState error={loans.error} onRetry={() => void loans.refetch()} what="open loans" />
          ) : loans.data.loans.length === 0 ? (
            <EmptyState icon={PackageCheck} title="Nothing is out on loan." hint="Everything on the shelf is accounted for." />
          ) : (
            <ul className="space-y-2">
              {loans.data.loans.map((row) => {
                const overdue = row.expectedReturnAt ? new Date(row.expectedReturnAt).getTime() < Date.now() : false;
                return (
                  <li key={row.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-4`}>
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 dark:text-white">
                        {titleCase(row.equipmentType)}
                        {row.itemCode ? ` · ${row.itemCode}` : ''}
                      </p>
                      <p className="text-sm text-slate-600 dark:text-slate-400">
                        {row.borrowerName} · {row.borrowerPhone}
                      </p>
                      <p className={`text-xs ${overdue ? 'font-medium text-[#E31E24]' : 'text-slate-500 dark:text-slate-400'}`}>
                        {row.expectedReturnAt ? `${overdue ? 'Overdue since' : 'Due back'} ${formatDate(row.expectedReturnAt)}` : 'No return date set'}
                      </p>
                    </div>
                    <button type="button" className={secondaryButtonClass} onClick={() => returnItem.mutate(row.equipmentId)}>
                      Mark returned
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-white">Stock</h2>
        {equipment.isPending ? (
          <ListSkeleton rows={4} lines={1} />
        ) : equipment.isError ? (
          <ErrorState error={equipment.error} onRetry={() => void equipment.refetch()} what="the equipment list" />
        ) : equipment.data.equipment.length === 0 ? (
          <EmptyState icon={Package} title="No equipment has been catalogued yet." hint="Add wheelchairs, walkers and other loan items to track where they are." />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {equipment.data.equipment.map((row) => (
              <li key={row.id} className={`${cardClass} p-4`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900 dark:text-white">{titleCase(row.equipmentType)}</p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {row.itemCode ?? 'No code'} · {titleCase(row.condition)}
                    </p>
                    {row.notes ? <p className="text-xs text-slate-500 dark:text-slate-400">{row.notes}</p> : null}
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_CLASSES[row.status] ?? STATUS_CLASSES.retired}`}>
                    {titleCase(row.status)}
                  </span>
                </div>
                {isDispatch ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {row.status === 'available' ? (
                      <button type="button" className={secondaryButtonClass} onClick={() => setLoanFor(row.id)}>
                        Lend out
                      </button>
                    ) : null}
                    {row.status === 'loaned' ? (
                      <button type="button" className={secondaryButtonClass} onClick={() => returnItem.mutate(row.id)}>
                        Mark returned
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal open={addOpen} title="Add an item" onClose={() => setAddOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = equipmentSchema.safeParse({
              equipmentType: item.equipmentType,
              itemCode: item.itemCode || null,
              categoryId: item.categoryId || null,
              condition: item.condition,
              notes: item.notes || null,
            });
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            createItem.mutate();
          }}
        >
          <div>
            <label htmlFor="equipment-type" className={labelClass}>
              What is it?
            </label>
            <input
              id="equipment-type"
              className={inputClass}
              value={item.equipmentType}
              placeholder="Wheelchair, walker, oxygen tank…"
              onChange={(event) => setItem({ ...item, equipmentType: event.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="equipment-code" className={labelClass}>
                Item code
              </label>
              <input id="equipment-code" className={inputClass} value={item.itemCode} onChange={(event) => setItem({ ...item, itemCode: event.target.value })} />
            </div>
            <div>
              <label htmlFor="equipment-category" className={labelClass}>
                Category
              </label>
              <select id="equipment-category" className={inputClass} value={item.categoryId} onChange={(event) => setItem({ ...item, categoryId: event.target.value })}>
                <option value="">No category</option>
                {(categories.data?.categories ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="equipment-condition" className={labelClass}>
              Condition
            </label>
            <select id="equipment-condition" className={inputClass} value={item.condition} onChange={(event) => setItem({ ...item, condition: event.target.value })}>
              {['new', 'good', 'fair', 'poor', 'damaged'].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={createItem.isPending}>
              Save item
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setAddOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={loanFor !== null} title="Lend this item out" onClose={() => setLoanFor(null)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!loanFor) return;
            const parsed = loanEquipmentSchema.safeParse({
              borrowerName: loan.borrowerName,
              borrowerPhone: loan.borrowerPhone,
              borrowerAddress: loan.borrowerAddress || null,
              expectedReturnAt: loan.expectedReturnAt ? new Date(loan.expectedReturnAt) : null,
              notes: loan.notes || null,
            });
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            lendItem.mutate(loanFor);
          }}
        >
          <div>
            <label htmlFor="loan-name" className={labelClass}>
              Borrower name
            </label>
            <input id="loan-name" className={inputClass} value={loan.borrowerName} onChange={(event) => setLoan({ ...loan, borrowerName: event.target.value })} required />
          </div>
          <div>
            <label htmlFor="loan-phone" className={labelClass}>
              Borrower phone
            </label>
            <input id="loan-phone" type="tel" className={inputClass} value={loan.borrowerPhone} onChange={(event) => setLoan({ ...loan, borrowerPhone: event.target.value })} required />
          </div>
          <div>
            <label htmlFor="loan-address" className={labelClass}>
              Address
            </label>
            <input id="loan-address" className={inputClass} value={loan.borrowerAddress} onChange={(event) => setLoan({ ...loan, borrowerAddress: event.target.value })} />
          </div>
          <div>
            <label htmlFor="loan-due" className={labelClass}>
              Expected back
            </label>
            <input id="loan-due" type="date" className={inputClass} value={loan.expectedReturnAt} onChange={(event) => setLoan({ ...loan, expectedReturnAt: event.target.value })} />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={lendItem.isPending}>
              Record loan
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setLoanFor(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
