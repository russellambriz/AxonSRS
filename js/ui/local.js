/**
 * localStorage wrapper for per-device conveniences only (theme before
 * first paint, an unsaved review awaiting retry, remembered tabs). Every
 * access is guarded: storage can be unavailable in private windows or
 * when site data is blocked, and the app must keep working.
 */

export const local = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  getJSON(key) {
    const v = local.get(key);
    if (!v) return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  },
  setJSON(key, value) {
    return local.set(key, JSON.stringify(value));
  },
};
