import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { App } from './App';
import { createQueryClient } from './lib/query';
import { AuthProvider } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const queryClient = createQueryClient();

/**
 * Register the service worker.
 *
 * In the old app a <PushNotificationSetup> component existed but was never
 * mounted, so no service worker was ever registered — and since a push
 * subscription requires one, "enable notifications" hung forever with no error.
 * Registration happens here, at startup, for every visitor.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((error: unknown) => {
      // Offline support and push are enhancements; the app runs without them.
      console.warn('Service worker registration failed', error);
    });
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <AuthProvider>
              <App />
              <Toaster richColors position="top-center" closeButton />
            </AuthProvider>
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
