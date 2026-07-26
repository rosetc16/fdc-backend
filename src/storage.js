// The app persists its state through `window.storage` (get/set), an interface from the original
// prototype host. In this standalone app we back it with localStorage so everything works and
// persists in the browser with zero setup. (Per-user server persistence happens via the API in
// api.js when a backend is configured; this local store is the always-available fallback and
// holds UI state like the current league list between visits.)
const KEY_PREFIX = 'fdc:';

if (typeof window !== 'undefined' && !window.storage) {
  window.storage = {
    async get(key) {
      try {
        const v = localStorage.getItem(KEY_PREFIX + key);
        return v == null ? null : { key, value: v };
      } catch { return null; }
    },
    async set(key, value) {
      try { localStorage.setItem(KEY_PREFIX + key, value); return { key, value }; }
      catch { return null; }
    },
    async delete(key) {
      try { localStorage.removeItem(KEY_PREFIX + key); return { key, deleted: true }; }
      catch { return null; }
    },
  };
}
