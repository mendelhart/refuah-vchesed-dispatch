/**
 * Admin > Departments (item 4). Which coordinators work on rides, food,
 * equipment or reports. A coordinator ticked nowhere keeps full access; one
 * ticked somewhere works only there. The server enforces it.
 */
import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, primaryButtonClass } from '@/components/states';

interface Department { slug: string; name: string; members: Array<{ id: string; fullName: string }> }
interface Person { id: string; fullName: string; role: string }

const PLAIN: Record<string, string> = {
  rides: 'Rides, standing rides and callers',
  food: 'Hospital food runs',
  equipment: 'Equipment loans and deliveries',
  reports: 'Organization impact and reports',
};

function DepartmentCard({ dept, coordinators }: { dept: Department; coordinators: Person[] }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set(dept.members.map((m) => m.id)));
  useEffect(() => setPicked(new Set(dept.members.map((m) => m.id))), [dept]);
  const save = useMutation({
    mutationFn: () => api.put(`/api/departments/${dept.slug}/members`, { userIds: [...picked] }),
    onSuccess: () => {
      toast.success(`${dept.name} saved.`);
      void queryClient.invalidateQueries({ queryKey: ['departments'] });
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const changed = picked.size !== dept.members.length || dept.members.some((m) => !picked.has(m.id));
  return (
    <section className={`${cardClass} p-4`} aria-labelledby={`dept-${dept.slug}`}>
      <h2 id={`dept-${dept.slug}`} className="text-lg font-semibold text-slate-900 dark:text-white">{dept.name}</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">{PLAIN[dept.slug] ?? ''}</p>
      <fieldset className="mt-3">
        <legend className="sr-only">Coordinators in {dept.name}</legend>
        <ul className="grid gap-2 sm:grid-cols-2">
          {coordinators.map((p) => (
            <li key={p.id}>
              <label className="flex min-h-[44px] items-center gap-3 rounded-lg border border-slate-200 px-3 text-sm text-slate-800 dark:border-slate-700 dark:text-slate-100">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[#C80023]"
                  checked={picked.has(p.id)}
                  onChange={() => setPicked((cur) => {
                    const next = new Set(cur);
                    if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                    return next;
                  })}
                />
                {p.fullName}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <button type="button" className={`${primaryButtonClass} mt-3`} disabled={!changed || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : `Save ${dept.name}`}
      </button>
    </section>
  );
}

export function DepartmentsPage(): React.JSX.Element {
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get<{ departments: Department[] }>('/api/departments') });
  const people = useQuery({ queryKey: ['users', 'coordinators'], queryFn: () => api.get<{ users: Person[] }>('/api/users', { role: 'dispatcher', limit: 500 }) });
  const coordinators = people.data?.users ?? [];
  return (
    <div className="space-y-4">
      <PageHeader title="Departments" subtitle="Who works on what" />
      <p className={`${cardClass} p-4 text-sm text-slate-700 dark:text-slate-200`}>
        A coordinator who is ticked in no department sees and does everything, as today. Tick someone in a department and they work only in the departments they are ticked in. Admins always see everything.
      </p>
      {depts.isPending || people.isPending ? <ListSkeleton rows={4} lines={3} /> : null}
      {depts.isError ? <ErrorState error={depts.error} onRetry={() => void depts.refetch()} what="the departments" /> : null}
      {people.isError ? <ErrorState error={people.error} onRetry={() => void people.refetch()} what="the coordinators" /> : null}
      {depts.data && people.data && coordinators.length === 0 ? (
        <EmptyState title="No coordinators yet" hint="Add a coordinator in People first." />
      ) : null}
      {depts.data && coordinators.length > 0
        ? depts.data.departments.map((d) => <DepartmentCard key={d.slug} dept={d} coordinators={coordinators} />)
        : null}
    </div>
  );
}
