/**
 * Recovering from "new version deployed while the app was open".
 *
 * Each deploy renames the screen files (Volunteers-<hash>.js). A tab that
 * loaded the old version asks for the old file name when you open a screen
 * for the first time, the server no longer has it, and the import fails. The
 * fix is to reload the page once, which picks up the new version. A short
 * guard stops a reload loop if the failure is something else (e.g. offline).
 */
const KEY = 'rvc-chunk-reload-at';
const GUARD_MS = 30_000;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Unable to preload CSS/i.test(
    message,
  );
}

/** Reloads once. Returns false if we already reloaded in the last 30 seconds. */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < GUARD_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Private mode without storage: still reload, the browser will cope.
  }
  window.location.reload();
  return true;
}
