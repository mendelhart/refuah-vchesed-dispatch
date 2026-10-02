import React from 'react';
import { MapPin,Pencil,PhoneCall,Trash2 } from 'lucide-react';
import { cardClass,secondaryButtonClass } from '@/components/states';
import type { ContactRow } from '@/types/api';
import { formatPhone } from '@/lib/format';
export function ContactCard({contact,calling,onCall,onEdit,onRemove}:{contact:ContactRow;calling:boolean;onCall:(id:string)=>void;onEdit:(contact:ContactRow)=>void;onRemove:(contact:ContactRow)=>void}):React.JSX.Element { return (
            <li key={contact.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-4`}>
              <div className="min-w-0">
                <p className="font-medium text-slate-900 dark:text-white">{contact.name}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {contact.role ? `${contact.role} · ` : ''}
                  {formatPhone(contact.phone)}
                </p>
                {contact.address ? (
                  <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                    <MapPin className="h-3 w-3" aria-hidden="true" />
                    {contact.address.formatted}
                  </p>
                ) : null}
                {contact.notes ? <p className="text-xs text-slate-500 dark:text-slate-400">{contact.notes}</p> : null}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={secondaryButtonClass}
                  disabled={calling}
                  onClick={() => onCall(contact.id)}
                >
                  <PhoneCall className="h-4 w-4" aria-hidden="true" />
                  Call
                </button>
                <button
                  type="button"
                  aria-label={`Edit ${contact.name}`}
                  className="grid h-11 w-11 place-items-center rounded-lg border border-slate-300 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                  onClick={() => onEdit(contact)}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${contact.name}`}
                  className="grid h-11 w-11 place-items-center rounded-lg border border-slate-300 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                  onClick={() => onRemove(contact)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
); }
