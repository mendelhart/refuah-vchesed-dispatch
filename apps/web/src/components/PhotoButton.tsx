import React, { useRef, useState } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { photoFileToDataUrl } from '@/lib/photo';
import { secondaryButtonClass } from '@/components/states';

/** Add / change / remove an ID card photo. `endpoint` is /api/me/photo or /api/users/:id/photo. */
export function PhotoButton({
  endpoint,
  hasPhoto,
  onChanged,
  compact,
}: {
  endpoint: string;
  hasPhoto: boolean;
  onChanged: () => void;
  compact?: boolean;
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const photo = await photoFileToDataUrl(file);
      await api.put(endpoint, { photo });
      toast.success('Photo saved.');
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm('Remove this photo?')) return;
    setBusy(true);
    try {
      await api.del(endpoint);
      toast.success('Photo removed.');
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap gap-2">
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => input.current?.click()}>
        <Camera className="h-4 w-4" aria-hidden="true" />
        {busy ? 'Saving…' : hasPhoto ? (compact ? 'Photo' : 'Change photo') : compact ? 'Add photo' : 'Add a photo'}
      </button>
      {hasPhoto && !compact ? (
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void remove()}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Remove
        </button>
      ) : null}
    </span>
  );
}
