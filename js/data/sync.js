/**
 * GitHub Gist synchronisation.
 *
 * Algorithm (idempotent and retry-safe):
 *   1. Pull: read the manifest and every chunk the manifest lists; verify
 *      each chunk's SHA-256; validate records.
 *   2. Merge into the local database (events by id, versioned records with
 *      conflict detection, tombstones) and rebuild affected schedules.
 *   3. Push: re-read the Gist's latest revision. If it moved since step 1,
 *      start again from step 1. Upload only changed chunks, manifest last.
 *   4. Verify: read the Gist back, check the manifest is ours and that the
 *      revision before ours is the one we merged. If another device wrote
 *      in between (Gist has no compare-and-swap), fetch that intervening
 *      revision from the Gist history, merge it and push again.
 * Remote writes never discard work: Gist revision history keeps every
 * previous version, and local data stays intact if anything fails.
 */

import { GistClient, GistError, parseGistId } from '../core/sync/gist.js';
import { seal, open as openEnvelope, createKeyring, EnvelopeError } from '../core/sync/envelope.js';
import { datasetToChunks, chunksToDataset, chunkHashes, buildManifest, chunkCount, MANIFEST_FILE, MAX_FILE_CHARS, MAX_REQUEST_CHARS } from '../core/sync/chunks.js';
import { validateDataset } from '../core/backup.js';
import { SYNC_FORMAT } from '../config.js';
import { sha256Hex, base64ToBytes, bytesToBase64 } from '../core/util.js';

export class SyncError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

const MAX_ATTEMPTS = 3;

export class SyncService {
  constructor(store) {
    this.store = store;
    this.token = null;
    this.keyring = null;
    this.running = null;
    this.status = { state: 'idle', message: '' };
    this.listeners = new Set();
    this.debounceTimer = null;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setStatus(state, message = '', extra = {}) {
    this.status = { state, message, ...extra, at: Date.now() };
    for (const fn of this.listeners) fn(this.status);
  }

  get config() {
    return this.store.device.sync || {};
  }

  isConfigured() {
    return !!this.config.gistId;
  }

  async loadCredentials() {
    if (!this.token && this.config.rememberToken) this.token = await this.store.getSecret('gistToken');
    if (!this.keyring && this.config.encrypt && this.config.rememberPassphrase) {
      const kr = await this.store.getSecret('syncKeyring');
      if (kr && kr.key) this.keyring = { key: kr.key, salt: base64ToBytes(kr.salt), iterations: kr.iterations };
    }
  }

  needsToken() {
    return !this.token;
  }

  needsPassphrase() {
    return !!this.config.encrypt && !this.keyring;
  }

  client() {
    if (!this.token) throw new SyncError('Enter your GitHub token to sync (it is not stored on this device unless you chose to remember it).', 'token-required');
    return new GistClient({ token: this.token });
  }

  /**
   * Connect to an existing Gist or create a new secret Gist.
   * opts: { token, gistId, rememberToken, encrypt, passphrase, rememberPassphrase }
   */
  async connect(opts) {
    this.token = opts.token.trim();
    const client = this.client();
    await client.getUser();
    let gistId = parseGistId(opts.gistId);
    let saltFromRemote = null;
    if (gistId) {
      const gist = await client.getGist(gistId);
      const manifestText = await client.fileContent(gist, MANIFEST_FILE);
      if (manifestText) {
        const env = JSON.parse(manifestText);
        if (env.format !== SYNC_FORMAT) throw new SyncError('That Gist does not contain Axon sync data.', 'remote-invalid');
        if (env.encryption && !opts.encrypt) throw new SyncError('This Gist is encrypted. Turn on encryption and enter its passphrase.', 'passphrase-required');
        if (!env.encryption && opts.encrypt) throw new SyncError('This Gist is not encrypted. Connect without encryption, or create a new encrypted Gist.', 'encryption-mismatch');
        if (env.encryption) saltFromRemote = env.encryption.salt;
      }
    }
    if (opts.encrypt) {
      this.keyring = await createKeyring(opts.passphrase, saltFromRemote ? { salt: base64ToBytes(saltFromRemote) } : {});
      if (gistId && saltFromRemote) {
        // Verify the passphrase now rather than at first sync.
        const gist = await client.getGist(gistId);
        await openEnvelope(JSON.parse(await client.fileContent(gist, MANIFEST_FILE)), { keyring: this.keyring });
      }
    } else {
      this.keyring = null;
    }
    if (!gistId) {
      const manifest = await seal({ ...buildManifest({ hashes: {}, counts: {}, deviceId: this.store.deviceId, encrypted: !!this.keyring }) }, { format: SYNC_FORMAT, keyring: this.keyring, deviceId: this.store.deviceId });
      const created = await client.createGist({ [MANIFEST_FILE]: { content: JSON.stringify(manifest) } });
      gistId = created.id;
    }
    await this.store.setDevice({
      sync: { ...this.config, gistId, rememberToken: !!opts.rememberToken, encrypt: !!opts.encrypt, rememberPassphrase: !!opts.rememberPassphrase, autoSync: this.config.autoSync ?? true, lastError: null },
    });
    await this.store.setSecret('gistToken', opts.rememberToken ? this.token : null);
    if (opts.encrypt && opts.rememberPassphrase && this.keyring) {
      await this.store.setSecret('syncKeyring', { key: this.keyring.key, salt: bytesToBase64(this.keyring.salt), iterations: this.keyring.iterations });
    } else {
      await this.store.setSecret('syncKeyring', null);
    }
    return gistId;
  }

  async unlock({ token, passphrase }) {
    if (token) this.token = token.trim();
    if (passphrase && this.config.encrypt) {
      const client = this.client();
      const gist = await client.getGist(this.config.gistId);
      const env = JSON.parse(await client.fileContent(gist, MANIFEST_FILE));
      const kr = await createKeyring(passphrase, { salt: base64ToBytes(env.encryption.salt) });
      await openEnvelope(env, { keyring: kr });
      this.keyring = kr;
    }
  }

  async disconnect({ forget = true } = {}) {
    this.token = null;
    this.keyring = null;
    if (forget) {
      await this.store.setSecret('gistToken', null);
      await this.store.setSecret('syncKeyring', null);
    }
    await this.store.setDevice({ sync: { ...this.config, gistId: '', lastSyncAt: null, lastError: null } });
    this.setStatus('idle', 'Disconnected');
  }

  /** Debounced background sync after local changes (only when online). */
  schedule(delayMs = 90000) {
    if (!this.isConfigured() || !this.config.autoSync) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.sync({ reason: 'auto' }).catch(() => {}), delayMs);
  }

  async sync({ reason = 'manual' } = {}) {
    if (this.running) return this.running;
    const run = async () => {
      if (!this.isConfigured()) throw new SyncError('Sync is not set up.', 'not-configured');
      if (globalThis.navigator && navigator.onLine === false) throw new SyncError('You are offline. Your data is saved on this device and will sync when you reconnect.', 'offline');
      await this.loadCredentials();
      if (this.needsPassphrase()) throw new SyncError('Enter your sync passphrase to decrypt the Gist.', 'passphrase-required');
      const exec = async () => this.syncOnce(reason);
      if (globalThis.navigator?.locks?.request) return navigator.locks.request('axon-sync', exec);
      return exec();
    };
    this.setStatus('syncing', 'Syncing…');
    this.running = run()
      .then(async (result) => {
        await this.store.setDevice({ sync: { ...this.config, lastSyncAt: Date.now(), lastError: null, lastRemoteVersion: result.remoteVersion } });
        this.setStatus('ok', 'Synced', { result });
        return result;
      })
      .catch(async (err) => {
        const e = err instanceof SyncError ? err : err instanceof GistError ? new SyncError(err.message, err.code, err) : err instanceof EnvelopeError ? new SyncError(err.message, err.code, err) : new SyncError(err?.message || 'Sync failed', 'unknown', err);
        await this.store.setDevice({ sync: { ...this.config, lastError: { code: e.code, message: e.message, at: Date.now() } } }).catch(() => {});
        this.setStatus(e.code === 'offline' ? 'offline' : 'error', e.message, { code: e.code });
        throw e;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async readRemote(client, gist) {
    const manifestText = await client.fileContent(gist, MANIFEST_FILE);
    if (!manifestText) return { manifest: null, dataset: null, errors: [] };
    let env;
    try {
      env = JSON.parse(manifestText);
    } catch {
      throw new SyncError('The Gist manifest is damaged.', 'remote-invalid');
    }
    const manifest = await openEnvelope(env, { keyring: this.keyring, expectedFormat: SYNC_FORMAT });
    const chunks = [];
    for (const [name, info] of Object.entries(manifest.files || {})) {
      const text = await client.fileContent(gist, name);
      if (text == null) throw new SyncError(`Sync file ${name} is missing from the Gist. Another device may be mid-upload; try again shortly.`, 'remote-incomplete');
      const value = await openEnvelope(JSON.parse(text), { keyring: this.keyring, expectedFormat: SYNC_FORMAT });
      if ((await sha256Hex(JSON.stringify(value))) !== info.sha256) throw new SyncError(`Sync file ${name} does not match the manifest (partial upload?). Try again shortly.`, 'remote-incomplete');
      chunks.push(value);
    }
    const raw = chunksToDataset(chunks);
    const { dataset, errors } = validateDataset(raw);
    dataset.media = raw.media;
    return { manifest, dataset, errors };
  }

  async syncOnce(reason) {
    const client = this.client();
    const gistId = this.config.gistId;
    let pulled = { newEvents: 0, conflicts: 0, invalid: 0 };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 1. Pull
      const gist = await client.getGist(gistId);
      const baseVersion = gist.history?.[0]?.version || null;
      const remote = await this.readRemote(client, gist);
      if (remote.dataset) {
        const { report } = await this.store.mergeIn(remote.dataset, { reason: `sync-${reason}` });
        pulled = { newEvents: pulled.newEvents + report.newEvents, conflicts: pulled.conflicts + report.conflicts.length, invalid: remote.errors.length, autoMerged: report.autoMerged };
      }
      // 2. Build upload
      const local = await this.store.exportDataset({ includeMedia: true });
      const chunks = datasetToChunks(local);
      const hashes = await chunkHashes(chunks);
      const counts = {};
      for (const [name, value] of chunks) counts[name] = chunkCount(value);
      const previous = remote.manifest;
      const changed = [...chunks.keys()].filter((n) => previous?.files?.[n]?.sha256 !== hashes[n]);
      const removed = Object.keys(previous?.files || {}).filter((n) => !chunks.has(n));
      if (!changed.length && !removed.length && previous) {
        return { remoteVersion: baseVersion, uploaded: 0, pulled, attempt };
      }
      const files = {};
      for (const name of changed) {
        const sealed = JSON.stringify(await seal(chunks.get(name), { format: SYNC_FORMAT, keyring: this.keyring, deviceId: this.store.deviceId }));
        if (sealed.length > MAX_FILE_CHARS) {
          throw new SyncError(`The sync file ${name} would be ${(sealed.length / 1048576).toFixed(1)} MB, above the ${MAX_FILE_CHARS / 1048576} MB per-file limit. Your data is safe locally; export a backup instead, or remove large media.`, 'too-large');
        }
        files[name] = { content: sealed };
      }
      for (const name of removed) files[name] = null;
      const manifest = buildManifest({ hashes, counts, deviceId: this.store.deviceId, encrypted: !!this.keyring, previous });
      const sealedManifest = JSON.stringify(await seal(manifest, { format: SYNC_FORMAT, keyring: this.keyring, deviceId: this.store.deviceId }));
      // 3. Race check just before writing
      const check = await client.getGist(gistId);
      if ((check.history?.[0]?.version || null) !== baseVersion) continue;
      // Upload in batches (chunks first, manifest last)
      const batches = [];
      let batch = {};
      let size = 0;
      for (const [name, f] of Object.entries(files)) {
        const n = f ? f.content.length : 0;
        if (size + n > MAX_REQUEST_CHARS && Object.keys(batch).length) {
          batches.push(batch);
          batch = {};
          size = 0;
        }
        batch[name] = f;
        size += n;
      }
      if (sealedManifest.length + size > MAX_REQUEST_CHARS && Object.keys(batch).length) {
        batches.push(batch);
        batch = {};
      }
      batch[MANIFEST_FILE] = { content: sealedManifest };
      batches.push(batch);
      for (const b of batches) await client.updateGist(gistId, b);
      // 4. Verify: our manifest must be current, and the revision just
      // before our batches must be the one we merged from.
      const after = await client.getGist(gistId);
      const afterManifest = await client.fileContent(after, MANIFEST_FILE);
      if (afterManifest !== sealedManifest) continue; // someone wrote after us — pull and merge again
      const history = after.history || [];
      if (baseVersion && history[batches.length]?.version !== baseVersion) {
        // Revisions slipped in between our race check and our write. Gist
        // keeps them in history: merge each, then push the union again.
        const baseIndex = history.findIndex((h) => h.version === baseVersion);
        const intervening = history.slice(batches.length, baseIndex < 0 ? history.length : baseIndex);
        for (const h of intervening) {
          const rev = await client.getGistRevision(gistId, h.version);
          const data = await this.readRemote(client, rev);
          if (data.dataset) await this.store.mergeIn(data.dataset, { reason: 'sync-intervening' });
        }
        continue;
      }
      return { remoteVersion: after.history?.[0]?.version || null, uploaded: changed.length, removed: removed.length, pulled, attempt };
    }
    throw new SyncError('Another device kept writing at the same moment. Nothing was lost — the Gist keeps every revision and your local data is intact. Try syncing again.', 'race');
  }
}
