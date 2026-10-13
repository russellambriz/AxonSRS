/**
 * Split a dataset into Gist files so unchanged history is not re-uploaded
 * and each file stays well inside GitHub's limits.
 *
 *   axon-manifest.json        manifest (sealed like the rest)
 *   axon-records.json         decks, cards, units, links, plans, tombstones, settings
 *   axon-revisions.json       card/deck revision history
 *   axon-events-YYYY-MM.json  review events by UTC month
 *   axon-media-<id>.json      one file per media asset
 */

import { SYNC_FORMAT, SYNC_FORMAT_VERSION, APP_VERSION } from '../../config.js';
import { sha256Hex } from '../util.js';

export const MANIFEST_FILE = 'axon-manifest.json';
export const MAX_FILE_CHARS = 8 * 1024 * 1024;
export const MAX_REQUEST_CHARS = 24 * 1024 * 1024;

const sortById = (list) => list.slice().sort((a, b) => (String(a.id ?? a.key) < String(b.id ?? b.key) ? -1 : 1));

/** Units carry only synced fields; FSRS state is rebuilt from events. */
export function syncUnit(u) {
  return { id: u.id, cardId: u.cardId, deckId: u.deckId, key: u.key, active: u.active, suspended: !!u.suspended, suspendedAt: u.suspendedAt || 0, overlays: u.overlays || {}, overlaysAt: u.overlaysAt || 0, createdAt: u.createdAt };
}

function monthOf(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function datasetToChunks(ds) {
  const chunks = new Map();
  chunks.set('axon-records.json', {
    kind: 'records',
    decks: sortById(ds.decks || []),
    cards: sortById(ds.cards || []),
    units: sortById((ds.units || []).map(syncUnit)),
    links: sortById(ds.links || []),
    plans: sortById(ds.plans || []),
    tombstones: sortById(ds.tombstones || []),
    settings: ds.settings || { values: {}, updatedAt: {} },
  });
  chunks.set('axon-revisions.json', { kind: 'revisions', revisions: sortById(ds.revisions || []) });
  const months = new Map();
  for (const e of ds.events || []) {
    const m = monthOf(e.ts);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(e);
  }
  for (const [m, list] of months) chunks.set(`axon-events-${m}.json`, { kind: 'events', month: m, events: sortById(list) });
  for (const media of ds.media || []) {
    if (media.data) chunks.set(`axon-media-${media.id}.json`, { kind: 'media', media });
  }
  return chunks;
}

export function chunksToDataset(chunks) {
  const ds = { decks: [], cards: [], units: [], links: [], plans: [], tombstones: [], revisions: [], events: [], media: [], settings: { values: {}, updatedAt: {} } };
  for (const c of chunks) {
    if (!c) continue;
    if (c.kind === 'records') {
      for (const k of ['decks', 'cards', 'units', 'links', 'plans', 'tombstones']) ds[k] = c[k] || [];
      ds.settings = c.settings || ds.settings;
    } else if (c.kind === 'revisions') ds.revisions.push(...(c.revisions || []));
    else if (c.kind === 'events') ds.events.push(...(c.events || []));
    else if (c.kind === 'media' && c.media) ds.media.push(c.media);
  }
  return ds;
}

export async function chunkHashes(chunks) {
  const out = {};
  for (const [name, value] of chunks) out[name] = await sha256Hex(JSON.stringify(value));
  return out;
}

export function buildManifest({ hashes, counts, deviceId, encrypted, previous = null }) {
  return {
    format: SYNC_FORMAT,
    version: SYNC_FORMAT_VERSION,
    app: APP_VERSION,
    updatedAt: Date.now(),
    deviceId,
    encrypted: !!encrypted,
    files: Object.fromEntries(Object.entries(hashes).map(([name, sha256]) => [name, { sha256, count: counts[name] ?? null }])),
    devices: { ...(previous?.devices || {}), [deviceId]: { lastSyncAt: Date.now(), app: APP_VERSION } },
  };
}

export function chunkCount(value) {
  if (value.kind === 'events') return value.events.length;
  if (value.kind === 'revisions') return value.revisions.length;
  if (value.kind === 'records') return value.cards.length;
  return 1;
}
