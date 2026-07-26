import './storage.js';          // installs window.storage (localStorage-backed) before App loads

// ---- Stale-deploy self-heal --------------------------------------------------------------------------
// After a new deploy, a browser (or an intermediate CDN like Cloudflare) can still hold the OLD index.html,
// which references JS chunks whose hashed filenames no longer exist on the server. Loading one then fails and
// nothing renders — a black screen. We catch that failure and do ONE cache-busting reload to fetch the fresh
// build. A sessionStorage guard ensures we never loop if the reload doesn't resolve it (a genuine error, not a
// stale chunk). This is belt-and-suspenders on top of the no-cache headers, and works even when a CDN ignores
// them.
(function installStaleDeployHeal() {
  const KEY = 'fdc:chunkReloaded';
  const looksLikeChunkError = (msg) => {
    const m = String(msg || '').toLowerCase();
    return m.includes('failed to fetch dynamically imported module')
      || m.includes('error loading dynamically imported module')
      || m.includes('failed to load module script')
      || m.includes("unexpected token '<'")            // server returned index.html where JS was expected
      || (m.includes('importing') && m.includes('module'))
      || (m.includes('chunk') && m.includes('load'));
  };
  const heal = () => {
    try {
      if (sessionStorage.getItem(KEY)) return false; // already tried once this session — don't loop
      sessionStorage.setItem(KEY, '1');
    } catch (e) { /* if sessionStorage is unavailable, still attempt a single reload */ }
    try {
      if (typeof caches !== 'undefined' && caches.keys) {
        caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).finally(() => {
          const u = new URL(window.location.href); u.searchParams.set('_r', Date.now().toString());
          window.location.replace(u.toString());
        });
        return true;
      }
    } catch (e) { /* fall through */ }
    const u = new URL(window.location.href); u.searchParams.set('_r', Date.now().toString());
    window.location.replace(u.toString());
    return true;
  };
  window.addEventListener('error', (e) => {
    // module script load failures surface as error events on the failing <script>/module
    const msg = (e && (e.message || (e.error && e.error.message))) || '';
    const isScript = e && e.target && (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK');
    if (looksLikeChunkError(msg) || (isScript && e.target.src && /assets\/.*\.js/.test(e.target.src))) heal();
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e && e.reason && (e.reason.message || e.reason)) || '';
    if (looksLikeChunkError(msg)) heal();
  });
  // Clear the guard once the app has clearly booted OK, so a future stale deploy can self-heal again.
  window.addEventListener('load', () => { setTimeout(() => { try { sessionStorage.removeItem(KEY); } catch (e) {} }, 4000); });
})();

import '@tabler/icons-webfont/dist/tabler-icons.min.css'; // bundle icons locally (no slow CDN fetch)
import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
