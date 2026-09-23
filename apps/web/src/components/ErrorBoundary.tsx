/**
 * A real error boundary around the whole app.
 *
 * The old app had none: one bad render inside a trip card white-screened the
 * dispatch console mid-shift, with no way back except a hard refresh. Here a
 * render error is contained, shown plainly, and recoverable in place.
 */
import React from 'react';
import { isChunkLoadError, reloadForNewVersion } from '@/lib/chunk-reload';

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
  updating?: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, updating: isChunkLoadError(error) };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Console is the only sink available client-side; the server logs its own.
    console.error('Unhandled render error', error, info.componentStack);
    // A new version was deployed while this tab was open: reload to get it.
    if (isChunkLoadError(error) && !reloadForNewVersion()) this.setState({ updating: false });
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): React.ReactNode {
    const { error, updating } = this.state;
    if (!error) return this.props.children;

    if (isChunkLoadError(error)) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">
              {updating ? 'Loading the latest version…' : 'A new version is available'}
            </h1>
            {updating ? null : (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-4 min-h-[44px] rounded-lg bg-[#EA0029] px-4 text-sm font-semibold text-white hover:bg-[#C80023]"
              >
                Reload
              </button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Something broke on this screen</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            Nothing you did was lost — the rest of the app is still running. Try this screen again, or go back to the
            home page.
          </p>
          <p className="mt-3 break-words rounded-lg bg-slate-100 p-3 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {error.message}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="min-h-[44px] rounded-lg bg-[#EA0029] px-4 text-sm font-semibold text-white hover:bg-[#C80023]"
            >
              Try again
            </button>
            <a
              href="/"
              className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Go home
            </a>
          </div>
        </div>
      </div>
    );
  }
}
