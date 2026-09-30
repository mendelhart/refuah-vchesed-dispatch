import React, { useState } from 'react';
import { Modal } from './Modal';
import { inputClass, primaryButtonClass, secondaryButtonClass } from './states';

interface Request { title: string; reason?: boolean; action: (reason: string) => void }
/** Destructive actions require an explicit, readable phone-sized confirmation. */
export function useConfirmation(): { ask: (request: Request) => void; dialog: React.JSX.Element } {
  const [request, setRequest] = useState<Request | null>(null);
  const [reason, setReason] = useState('');
  const close = (): void => { setRequest(null); setReason(''); };
  return { ask: (next) => { setReason(''); setRequest(next); }, dialog:
    <Modal open={request !== null} title={request?.title ?? 'Confirm'} onClose={close}>
      {request?.reason && <label className="block space-y-2 text-sm">Reason
        <textarea autoFocus className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
      </label>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={primaryButtonClass} disabled={Boolean(request?.reason && !reason.trim())}
          onClick={() => { request?.action(reason.trim()); close(); }}>Confirm</button>
        <button type="button" className={secondaryButtonClass} onClick={close}>Cancel</button>
      </div>
    </Modal> };
}
