/** Export helpers: full/partial JSON backups and Anki plain text. */

import { store } from '../data/store.js';
import { app } from '../app.js';
import { buildBackup } from '../core/backup.js';
import { seal, createKeyring } from '../core/sync/envelope.js';
import { exportAnki } from '../core/anki.js';
import { BACKUP_FORMAT } from '../config.js';
import { downloadBlob } from './dom.js';

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

/**
 * Full backup. options: { compress, passphrase } → .json, .json.gz-in-envelope, or encrypted.
 */
export async function exportBackup({ compress = false, passphrase = null, deckIds = null } = {}) {
  let data = await store.exportDataset({ includeMedia: true, includeCalibration: true });
  if (deckIds) data = filterDataset(data, new Set(deckIds));
  const backup = buildBackup(data, { deviceId: store.deviceId });
  let blob;
  let name;
  if (compress || passphrase) {
    const keyring = passphrase ? await createKeyring(passphrase) : null;
    const env = await seal(backup, { format: BACKUP_FORMAT, compress: true, keyring, deviceId: store.deviceId });
    blob = new Blob([JSON.stringify(env)], { type: 'application/json' });
    name = `axon-backup-${stamp()}${passphrase ? '-encrypted' : ''}.axon`;
  } else {
    blob = new Blob([JSON.stringify(backup, null, 1)], { type: 'application/json' });
    name = `axon-backup-${stamp()}.json`;
  }
  downloadBlob(blob, name);
  if (!deckIds) await store.setDevice({ lastBackupAt: Date.now() });
  return { name, size: blob.size, counts: backup.counts };
}

export function filterDataset(data, deckIds) {
  const cards = data.cards.filter((c) => deckIds.has(c.deckId));
  const cardIds = new Set(cards.map((c) => c.id));
  const units = data.units.filter((u) => cardIds.has(u.cardId));
  const mediaIds = new Set();
  for (const c of cards) {
    for (const m of c.media || []) mediaIds.add(m);
    if (c.occlusion?.imageId) mediaIds.add(c.occlusion.imageId);
    for (const v of Object.values(c.audio || {})) if (v) mediaIds.add(v);
    for (const f of [...c.front, ...c.back, c.hint, c.explanation]) for (const m of String(f).matchAll(/axon-media:([\w-]+)/g)) mediaIds.add(m[1]);
  }
  return {
    ...data,
    decks: data.decks.filter((d) => deckIds.has(d.id)),
    cards,
    units,
    events: data.events.filter((e) => cardIds.has(e.cardId)),
    revisions: data.revisions.filter((r) => cardIds.has(r.recordId) || deckIds.has(r.recordId)),
    tombstones: [],
    links: data.links.filter((l) => cardIds.has(l.a) && cardIds.has(l.b)),
    plans: [],
    media: data.media.filter((m) => mediaIds.has(m.id)),
    calibration: [],
  };
}

export async function exportAnkiFile(deckIds, { separator = '\t' } = {}) {
  await app.cache.ensure();
  const set = new Set(deckIds);
  const cards = [...app.cache.cards.values()].filter((c) => set.has(c.deckId));
  const unitsByCard = new Map();
  for (const u of app.cache.units.values()) {
    if (!set.has(u.deckId)) continue;
    if (!unitsByCard.has(u.cardId)) unitsByCard.set(u.cardId, []);
    unitsByCard.get(u.cardId).push(u);
  }
  const { text, skipped, count } = exportAnki(cards, app.cache.decks, unitsByCard, { separator });
  const deckName = deckIds.length === 1 ? app.cache.decks.get(deckIds[0])?.name || 'deck' : 'decks';
  const safe = deckName.replace(/[^\w-]+/g, '_').slice(0, 40);
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${safe}-anki.${separator === '\t' ? 'txt' : 'csv'}`);
  return { count, skipped };
}
