/** Vehicles roster. Carried over from the old Vehicles screen, same columns. */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Car, Plus, Wrench } from 'lucide-react';
import { vehicleSchema } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDate, titleCase } from '@/lib/format';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';
import type { VehiclesResponse } from '@/types/api';

const STATUS_CLASSES: Record<string, string> = {
  available: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  in_use: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  maintenance: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  retired: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

export function VehiclesPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ label: '', vehicleType: 'standard', plate: '', capacity: '', notes: '' });

  const vehicles = useQuery({
    queryKey: qk.vehicles.list(),
    queryFn: () => api.get<VehiclesResponse>('/api/vehicles'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/vehicles', {
        label: form.label.trim(),
        vehicleType: form.vehicleType.trim() || 'standard',
        plate: form.plate.trim() || null,
        capacity: form.capacity ? Number(form.capacity) : null,
        status: 'available',
        notes: form.notes.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.vehicles.list() });
      toast.success('Vehicle added.');
      setOpen(false);
      setForm({ label: '', vehicleType: 'standard', plate: '', capacity: '', notes: '' });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/api/vehicles/${id}`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.vehicles.list() });
      toast.success('Vehicle updated.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vehicles"
        subtitle="What is on the road and what is in the shop"
        actions={
          <button type="button" className={primaryButtonClass} onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add vehicle
          </button>
        }
      />

      {vehicles.isPending ? (
        <ListSkeleton rows={3} lines={2} />
      ) : vehicles.isError ? (
        <ErrorState error={vehicles.error} onRetry={() => void vehicles.refetch()} what="the vehicle list" />
      ) : vehicles.data.vehicles.length === 0 ? (
        <EmptyState icon={Car} title="No vehicles on the books." hint="Add the organisation's vehicles so dispatch knows what is available." />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {vehicles.data.vehicles.map((vehicle) => (
            <li key={vehicle.id} className={`${cardClass} p-4`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 dark:text-white">{vehicle.label}</p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {titleCase(vehicle.vehicleType)}
                    {vehicle.plate ? ` · ${vehicle.plate}` : ''}
                    {vehicle.capacity ? ` · seats ${vehicle.capacity}` : ''}
                  </p>
                  {vehicle.nextMaintenanceAt ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                      <Wrench className="h-3 w-3" aria-hidden="true" />
                      Service due {formatDate(vehicle.nextMaintenanceAt)}
                    </p>
                  ) : null}
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_CLASSES[vehicle.status] ?? STATUS_CLASSES.retired}`}>
                  {titleCase(vehicle.status)}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {vehicle.status !== 'available' ? (
                  <button type="button" className={secondaryButtonClass} onClick={() => setStatus.mutate({ id: vehicle.id, status: 'available' })}>
                    Mark available
                  </button>
                ) : null}
                {vehicle.status !== 'maintenance' ? (
                  <button type="button" className={secondaryButtonClass} onClick={() => setStatus.mutate({ id: vehicle.id, status: 'maintenance' })}>
                    Send to maintenance
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={open} title="Add a vehicle" onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = vehicleSchema.safeParse({
              label: form.label,
              vehicleType: form.vehicleType || 'standard',
              plate: form.plate || null,
              capacity: form.capacity ? Number(form.capacity) : null,
              status: 'available',
              notes: form.notes || null,
            });
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            create.mutate();
          }}
        >
          <div>
            <label htmlFor="vehicle-label" className={labelClass}>
              Name or number
            </label>
            <input id="vehicle-label" className={inputClass} value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} required />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="vehicle-type" className={labelClass}>
                Type
              </label>
              <input id="vehicle-type" className={inputClass} value={form.vehicleType} onChange={(event) => setForm({ ...form, vehicleType: event.target.value })} />
            </div>
            <div>
              <label htmlFor="vehicle-plate" className={labelClass}>
                Plate
              </label>
              <input id="vehicle-plate" className={inputClass} value={form.plate} onChange={(event) => setForm({ ...form, plate: event.target.value })} />
            </div>
          </div>
          <div>
            <label htmlFor="vehicle-capacity" className={labelClass}>
              Seats
            </label>
            <input
              id="vehicle-capacity"
              type="number"
              min={0}
              className={inputClass}
              value={form.capacity}
              onChange={(event) => setForm({ ...form, capacity: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="vehicle-notes" className={labelClass}>
              Notes
            </label>
            <input id="vehicle-notes" className={inputClass} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={create.isPending}>
              Save vehicle
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
