/**
 * IndexedDB access: versioned schema, migrations and transaction helpers.
 *
 * Guarantees
 *  - Migrations run inside the versionchange transaction; if one throws,
 *    the whole upgrade aborts and the database stays at its old version
 *    with its data intact.
 *  - Before upgrading an existing database a full snapshot is written to
 *    a separate database (axon-snapshots), so a failed or faulty
 *    migration can be recovered from.
 *  - A database that cannot be opened is never deleted or replaced with an
 *    empty one; the caller shows the recovery screen instead.
 */

import { DB_NAME, DB_VERSION } from '../config.js';

export const STORES = Object.freeze({
  meta: { keyPath: 'key' },
  settings: { keyPath: 'key' },
  decks: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] },
  cards: { keyPath: 'id', indexes: [['deckId', 'deckId'], ['updatedAt', 'updatedAt'], ['tags', 'tags', { multiEntry: true }]] },
  units: { keyPath: 'id', indexes: [['cardId', 'cardId'], ['deckId', 'deckId'], ['due', 'state.due']] },
  events: { keyPath: 'id', indexes: [['unitId', 'unitId'], ['ts', 'ts'], ['studyDay', 'studyDay'], ['type', 'type'], ['targetId', 'targetId'], ['sessionId', 'sessionId'], ['cardId', 'cardId'], ['deviceSeq', ['deviceId', 'seq']]] },
  revisions: { keyPath: 'id', indexes: [['recordId', 'recordId']] },
  tombstones: { keyPath: 'id' },
  links: { keyPath: 'id', indexes: [['a', 'a'], ['b', 'b']] },
  media: { keyPath: 'id' },
  calibration: { keyPath: 'key' },
  sessions: { keyPath: 'id', indexes: [['status', 'status']] },
  imports: { keyPath: 'id' },
  conflicts: { keyPath: 'id' },
  plans: { keyPath: 'id' },
  secrets: { keyPath: 'key' },
  trash: { keyPath: 'id' },
});

/**
 * Structural migrations, applied in order inside onupgradeneeded.
 * Each receives (db, tx, oldVersion). Never delete user data here.
 */
export const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema',
    upgrade(db) {
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [indexName, keyPath, opts] of def.indexes || []) store.createIndex(indexName, keyPath, opts || {});
      }
    },
  },
];

export class StorageError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

export function classifyError(err) {
  const name = err?.name || '';
  if (name === 'QuotaExceededError' || /quota/i.test(err?.message || '')) return new StorageError('Device storage is full. Free up space or export a backup, then try again.', 'quota', err);
  if (name === 'VersionError') return new StorageError('Your data was created by a newer version of Axon. Reload to update the app.', 'version', err);
  if (name === 'InvalidStateError') return new StorageError('The database connection was closed. Reload Axon.', 'closed', err);
  if (name === 'ConstraintError') return new StorageError('This record already exists.', 'constraint', err);
  if (name === 'AbortError') return new StorageError('A storage operation was interrupted; nothing was saved.', 'aborted', err);
  if (err instanceof StorageError) return err;
  return new StorageError(err?.message || 'Storage error', 'unknown', err);
}

export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(classifyError(req.error));
  });
}

function idb() {
  const f = globalThis.indexedDB;
  if (!f) throw new StorageError('This browser does not provide IndexedDB storage, which Axon needs.', 'unsupported');
  return f;
}

/** Current on-disk version without upgrading (0 if absent). */
export async function currentVersion(name = DB_NAME) {
  const factory = idb();
  if (typeof factory.databases === 'function') {
    const list = await factory.databases();
    const found = list.find((d) => d.name === name);
    return found ? found.version : 0;
  }
  // Fallback: open without a version (creates v1 empty DB if missing).
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    let created = false;
    req.onupgradeneeded = () => {
      created = true;
      req.transaction.abort();
    };
    req.onsuccess = () => {
      const v = req.result.version;
      req.result.close();
      resolve(v);
    };
    req.onerror = () => (created ? resolve(0) : reject(classifyError(req.error)));
  });
}

/**
 * Open (and if needed upgrade) the database.
 * @param {object} opts { name, version, migrations, onVersionChange, beforeUpgrade }
 */
export function openDatabase({ name = DB_NAME, version = DB_VERSION, migrations = MIGRATIONS, onVersionChange = null, onBlocked = null } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb().open(name, version);
    } catch (err) {
      reject(classifyError(err));
      return;
    }
    let migrationError = null;
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      const oldVersion = event.oldVersion;
      try {
        for (const m of migrations) {
          if (m.version > oldVersion && m.version <= version) m.upgrade(db, tx, oldVersion);
        }
      } catch (err) {
        migrationError = err;
        tx.abort();
      }
    };
    req.onblocked = () => onBlocked && onBlocked();
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        if (onVersionChange) onVersionChange();
      };
      resolve(db);
    };
    req.onerror = () => {
      if (migrationError) reject(new StorageError(`Database upgrade failed: ${migrationError.message}. Your data was left unchanged.`, 'migration', migrationError));
      else reject(classifyError(req.error));
    };
  });
}

/**
 * Run `fn` inside one transaction. `fn` receives a helper bound to the
 * transaction; it may await IndexedDB requests made through the helper
 * but must not await unrelated work, or the transaction would commit
 * early. Resolves with fn's result after the transaction commits.
 */
export function transaction(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    } catch (err) {
      reject(classifyError(err));
      return;
    }
    let result;
    let failure = null;
    const helper = {
      tx,
      store: (n) => tx.objectStore(n),
      get: (n, key) => request(tx.objectStore(n).get(key)),
      getAll: (n, query, count) => request(tx.objectStore(n).getAll(query, count)),
      getAllFromIndex: (n, index, query) => request(tx.objectStore(n).index(index).getAll(query)),
      getKeysFromIndex: (n, index, query) => request(tx.objectStore(n).index(index).getAllKeys(query)),
      count: (n, query) => request(tx.objectStore(n).count(query)),
      keys: (n, query) => request(tx.objectStore(n).getAllKeys(query)),
      put: (n, value) => request(tx.objectStore(n).put(value)),
      // Bulk write: queue every request at once (IndexedDB applies them in
      // order) instead of waiting for each one — orders of magnitude
      // faster for imports, restores and schedule rebuilds.
      putMany: (n, values) => {
        const os = tx.objectStore(n);
        let last = null;
        for (const v of values) last = os.put(v);
        return last ? request(last) : Promise.resolve();
      },
      add: (n, value) => request(tx.objectStore(n).add(value)),
      delete: (n, key) => request(tx.objectStore(n).delete(key)),
      clear: (n) => request(tx.objectStore(n).clear()),
      abort: (reason) => {
        failure = reason;
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
      },
    };
    // Settle only when the transaction has finished AND fn has settled, so
    // an error thrown after an early commit is never reported as success.
    let completed = false;
    let settled = false;
    let aborted = false;
    const finish = () => {
      if (aborted || !completed || !settled) return;
      if (failure) reject(failure);
      else resolve(result);
    };
    tx.oncomplete = () => {
      completed = true;
      finish();
    };
    tx.onabort = () => {
      aborted = true;
      reject(failure || classifyError(tx.error || new DOMException('Transaction aborted', 'AbortError')));
    };
    tx.onerror = (e) => {
      if (e && typeof e.preventDefault === 'function' && failure) e.preventDefault();
    };
    Promise.resolve()
      .then(() => fn(helper))
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        // Browser storage errors (quota, clone, closed connection) get a
        // clear message; Axon's own errors pass through unchanged.
        helper.abort(typeof DOMException !== 'undefined' && err instanceof DOMException ? classifyError(err) : err);
      })
      .finally(() => {
        settled = true;
        finish();
      });
  });
}

/* ------------------------------------------------------------------ */
/* Snapshots (separate database so they survive main-schema problems)  */
/* ------------------------------------------------------------------ */

export const SNAPSHOT_DB = 'axon-snapshots';

export function openSnapshotDb() {
  return new Promise((resolve, reject) => {
    const req = idb().open(SNAPSHOT_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('snapshots')) req.result.createObjectStore('snapshots', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(classifyError(req.error));
  });
}

/** Read every store of an open database into plain arrays. */
export async function dumpDatabase(db) {
  const names = [...db.objectStoreNames];
  return transaction(db, names, 'readonly', async (t) => {
    const out = {};
    for (const n of names) out[n] = await t.getAll(n);
    return out;
  });
}

/**
 * Open the database, snapshotting existing data before any upgrade.
 * Returns { db, upgradedFrom, snapshotId }.
 */
export async function openWithSafety(opts = {}) {
  const name = opts.name || DB_NAME;
  const version = opts.version || DB_VERSION;
  const existing = await currentVersion(name);
  if (existing > version) {
    throw new StorageError('Your data was saved by a newer version of Axon. Reload to load the latest app; nothing was changed.', 'version');
  }
  let snapshotId = null;
  if (existing > 0 && existing < version) {
    const old = await openDatabase({ name, version: existing, migrations: [] });
    try {
      const dump = await dumpDatabase(old);
      snapshotId = await writeSnapshot({ reason: `before upgrade v${existing} → v${version}`, dump, schemaVersion: existing });
    } finally {
      old.close();
    }
  }
  const db = await openDatabase({ ...opts, name, version });
  return { db, upgradedFrom: existing && existing < version ? existing : null, snapshotId };
}

export async function writeSnapshot({ reason, dump, schemaVersion = DB_VERSION, keep = 3 }) {
  const sdb = await openSnapshotDb();
  try {
    const id = `snap-${Date.now()}`;
    const size = JSON.stringify(dump).length;
    await transaction(sdb, ['snapshots'], 'readwrite', async (t) => {
      await t.put('snapshots', { id, createdAt: Date.now(), reason, schemaVersion, size, dump });
      const all = await t.getAll('snapshots');
      all.sort((a, b) => b.createdAt - a.createdAt);
      for (const old of all.slice(keep)) await t.delete('snapshots', old.id);
    });
    return id;
  } finally {
    sdb.close();
  }
}

export async function listSnapshots() {
  const sdb = await openSnapshotDb();
  try {
    const all = await transaction(sdb, ['snapshots'], 'readonly', (t) => t.getAll('snapshots'));
    return all.map(({ dump, ...meta }) => ({ ...meta, counts: Object.fromEntries(Object.entries(dump || {}).map(([k, v]) => [k, v.length])) })).sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    sdb.close();
  }
}

export async function readSnapshot(id) {
  const sdb = await openSnapshotDb();
  try {
    return await transaction(sdb, ['snapshots'], 'readonly', (t) => t.get('snapshots', id));
  } finally {
    sdb.close();
  }
}

export async function deleteSnapshot(id) {
  const sdb = await openSnapshotDb();
  try {
    await transaction(sdb, ['snapshots'], 'readwrite', (t) => t.delete('snapshots', id));
  } finally {
    sdb.close();
  }
}
