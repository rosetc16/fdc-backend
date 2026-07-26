// App-wide error boundary. If any component throws during render (a bad data edge case mid-draft), React
// would otherwise unmount the entire tree and leave a blank white screen — and the user would lose their
// draft view. This catches that, keeps the page alive, and offers a one-click recovery. Because the app
// continuously persists state to localStorage (and the backend), reloading restores the draft where it
// left off, so a transient render error is a small bump instead of a lost draft.
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Log for diagnostics; never rethrow (that would white-screen again). Also stash the message + stack in
    // localStorage and in component state so it can be surfaced to the user — turning "it hiccuped" into an
    // actual, reportable error string. Keep a small ring of the last few so an intermittent bug is traceable.
    try { console.error('[FDC] render error caught by boundary:', error, info); } catch (e) {}
    try {
      const rec = { t: new Date().toISOString(), msg: String(error && error.message || error), stack: String((error && error.stack) || '').split('\n').slice(0, 6).join('\n'), comp: String((info && info.componentStack) || '').split('\n').slice(0, 6).join('\n') };
      const prev = JSON.parse(localStorage.getItem('fdc:errlog') || '[]');
      prev.unshift(rec); localStorage.setItem('fdc:errlog', JSON.stringify(prev.slice(0, 5)));
      this.setState({ detail: rec });
    } catch (e) {}
  }
  hardReload = () => {
    // Cache-busting reload. After a deploy, a stale cached bundle can throw a chunk/render error; a plain
    // reload might just re-serve the same stale files. Clear the Cache Storage first (if present), then
    // reload with a cache-busting query so the browser fetches the fresh build.
    try {
      if (typeof caches !== 'undefined' && caches.keys) {
        caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).finally(() => {
          const u = new URL(window.location.href); u.searchParams.set('_r', Date.now().toString());
          window.location.replace(u.toString());
        });
        return;
      }
    } catch (e) { /* fall through to plain reload */ }
    const u = new URL(window.location.href); u.searchParams.set('_r', Date.now().toString());
    window.location.replace(u.toString());
  };
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0E1217', color: '#EEF2F6', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
          <div style={{ maxWidth: 460, textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Something hiccuped</div>
            <div style={{ fontSize: 14, lineHeight: 1.55, color: '#9AA7B5', marginBottom: 20 }}>
              The app hit an unexpected error, but <b style={{ color: '#EEF2F6' }}>your draft is safe</b> — it's saved automatically. Refresh the page to pick up right where you left off.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={this.hardReload} style={{ background: '#F2B63C', color: '#151002', border: 'none', borderRadius: 8, padding: '11px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Refresh the page</button>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: '#6b7683', marginTop: 14 }}>
              If this problem persists, please restart your browser or open the website in a new tab.
            </div>
            {this.state.detail && (
              <details style={{ marginTop: 18, textAlign: 'left', fontSize: 11, color: '#6b7683' }}>
                <summary style={{ cursor: 'pointer', color: '#9AA7B5' }}>Error details (for support)</summary>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8, fontSize: 10.5, lineHeight: 1.4 }}>{this.state.detail.msg}{'\n'}{this.state.detail.comp}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
