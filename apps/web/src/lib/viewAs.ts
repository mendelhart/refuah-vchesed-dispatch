/**
 * "View as" preview state for administrators.
 *
 * Kept in sessionStorage so it ends when the tab closes and never follows the
 * admin into another tab. Every API call adds X-View-As while it is set; the
 * server answers as that person and refuses any change (read-only).
 */
const KEY = 'rvc.viewAs';

export interface ViewAs {
  id: string;
  name: string;
  role: string;
}

export function getViewAs(): ViewAs | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ViewAs) : null;
  } catch {
    return null;
  }
}

export function setViewAs(value: ViewAs): void {
  window.sessionStorage.setItem(KEY, JSON.stringify(value));
}

export function clearViewAs(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

/** Leave the preview and go back to the admin's own People screen. */
export function exitViewAs(): void {
  clearViewAs();
  window.location.assign('/admin/people');
}
