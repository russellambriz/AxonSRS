/**
 * Versioned backup format, validation and record-level migrations.
 *
 * A backup is either plain JSON ({ format: 'axon-backup', … }) or the same
 * object sealed in an envelope (compressed and optionally encrypted).
 * Validation is per record: invalid records are reported and skipped,
 * valid ones are kept, so a partially damaged backup still restores
 * everything that can be trusted. Secrets (Gist token, passphrases) are
 * never part of a backup.
 */

import { APP_VERSION, BACKUP_FORMAT, BACKUP_FORMAT_VERSION, DB_VERSION, RECORD_VERSION, SCHEDULER_VERSION, GRADING_VERSION, MATCHER_VERSION } from '../config.js';
import { DEFAULT_DECK_SETTINGS, TASK_TYPES, ANSWER_MODES } from './model.js';
import { VERSIONED_TYPES } from './sync/versioning.js';

export const EVENT_TYPES = new Set(['review', 'reset', 'practice', 'hint', 'reveal', 'copy', 'sibling-exposure', 'correction', 'edit', 'skip', 'abandon', 'self-rating']);
export const COLLECTIONS = ['decks', 'cards', 'units', 'events', 'revisions', 'tombstones', 'links', 'plans', 'media', 'calibration'];
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function fsrsStateOk(s) {
  if (s == null) return true;
  return typeof s === 'object' && isNum(s.due) && isNum(s.stability) && isNum(s.difficulty) && isNum(s.reps) && isNum(s.lapses) && [0, 1, 2, 3].includes(s.state);
}

export const VALIDATORS = {
  decks(d) {
    if (!isStr(d.id)) return 'missing id';
    if (typeof d.name !== 'string') return 'missing name';
    return null;
  },
  cards(c) {
    if (!isStr(c.id)) return 'missing id';
    if (!isStr(c.deckId)) return 'missing deckId';
    if (!isStrArray(c.front) || !isStrArray(c.back)) return 'front/back must be lists of strings';
    if (c.tags && !isStrArray(c.tags)) return 'tags must be strings';
    if (c.kind && !['basic', 'cloze', 'occlusion'].includes(c.kind)) return `unknown kind ${c.kind}`;
    return null;
  },
  units(u) {
    if (!isStr(u.id) || !isStr(u.cardId) || !isStr(u.key)) return 'missing id/cardId/key';
    if (!u.id.startsWith(`${u.cardId}:`)) return 'id does not match card';
    if (!fsrsStateOk(u.state)) return 'invalid scheduling state';
    return null;
  },
  events(e) {
    if (!isStr(e.id)) return 'missing id';
    if (!EVENT_TYPES.has(e.type)) return `unknown event type ${e.type}`;
    if (!isNum(e.ts)) return 'missing timestamp';
    if (!isStr(e.deviceId)) return 'missing deviceId';
    if (e.type === 'review') {
      if (!isStr(e.unitId)) return 'review without unit';
      if (![1, 2, 3, 4].includes(e.rating)) return 'review without valid rating';
      if (!e.params || !Array.isArray(e.params.w)) return 'review without scheduler parameters';
    }
    if (e.type === 'correction' && (!isStr(e.targetId) || !['override', 'void', 'restore'].includes(e.kind))) return 'invalid correction';
    return null;
  },
  revisions(r) {
    if (!isStr(r.id) || !isStr(r.recordId) || !isStr(r.hash)) return 'missing id/recordId/hash';
    return null;
  },
  tombstones(t) {
    if (!isStr(t.id) || !VERSIONED_TYPES.includes(t.type) || !isNum(t.deletedAt)) return 'invalid tombstone';
    return null;
  },
  links(l) {
    if (!isStr(l.id) || !isStr(l.a) || !isStr(l.b)) return 'invalid link';
    return null;
  },
  plans(p) {
    if (!isStr(p.id) || !/^\d{4}-\d{2}-\d{2}$/.test(p.examDate || '')) return 'invalid exam plan';
    return null;
  },
  media(m) {
    if (!isStr(m.id) || !isStr(m.type)) return 'missing id/type';
    if (!/^(image\/(png|jpeg|gif|webp|avif)|audio\/(mpeg|mp4|ogg|webm|wav|x-wav|aac))$/.test(m.type)) return `unsupported media type ${m.type}`;
    if (m.data != null && typeof m.data !== 'string') return 'media data must be base64';
    if ((m.size || 0) > MAX_MEDIA_BYTES) return 'media asset too large';
    return null;
  },
  calibration(c) {
    if (!isStr(c.key) || !Array.isArray(c.samples)) return 'invalid calibration baseline';
    return null;
  },
};

/** Normalise records whose optional fields are missing. */
function normalize(collection, r) {
  if (collection === 'decks') return { description: '', group: '', archived: false, ...r, settings: { ...DEFAULT_DECK_SETTINGS, ...(r.settings || {}) } };
  if (collection === 'cards') {
    return {
      kind: 'basic', hint: '', explanation: '', tags: [], match: {}, media: [], audio: {}, occlusion: null, suspended: false, flags: {},
      ...r,
      taskType: TASK_TYPES.includes(r.taskType) ? r.taskType : 'recall',
      answerMode: ANSWER_MODES.includes(r.answerMode) ? r.answerMode : null,
    };
  }
  if (collection === 'units') return { active: true, suspended: false, overlays: {}, overlaysAt: 0, suspendedAt: 0, perf: { recent: [] }, ...r };
  return r;
}

/**
 * Record-level migrations, keyed by the version they upgrade *from*.
 * 0 → 1: data from early or foreign exporters lacking task types,
 * answer modes or unit overlays (task type defaults to Recall).
 */
export const RECORD_MIGRATIONS = {
  0: (data) => ({
    ...data,
    cards: (data.cards || []).map((c) => ({ ...c, taskType: c.taskType || 'recall', recordVersion: 1 })),
    units: (data.units || []).map((u) => ({ ...u, overlays: u.overlays || {}, recordVersion: 1 })),
  }),
};

export function migrateData(data, fromVersion) {
  let v = fromVersion ?? 0;
  let out = data;
  const applied = [];
  while (v < RECORD_VERSION) {
    const step = RECORD_MIGRATIONS[v];
    if (!step) throw new Error(`No migration from record version ${v}`);
    out = step(out);
    applied.push(`${v}→${v + 1}`);
    v++;
  }
  return { data: out, applied };
}

/**
 * Validate every record. Returns the trusted subset and a list of
 * problems (collection, index, id, message). Cards whose deck is missing
 * are re-homed into a "Recovered cards" deck rather than dropped.
 */
export function validateDataset(data, { recoveredDeckId = 'recovered-cards' } = {}) {
  const dataset = {};
  const errors = [];
  for (const c of COLLECTIONS) {
    const list = Array.isArray(data?.[c]) ? data[c] : [];
    if (data?.[c] != null && !Array.isArray(data[c])) errors.push({ collection: c, index: -1, message: 'expected a list' });
    dataset[c] = [];
    const seen = new Set();
    list.forEach((r, index) => {
      if (!r || typeof r !== 'object') {
        errors.push({ collection: c, index, message: 'not an object' });
        return;
      }
      const problem = VALIDATORS[c](r);
      const id = r.id ?? r.key;
      if (problem) {
        errors.push({ collection: c, index, id, message: problem });
        return;
      }
      if (seen.has(id)) {
        errors.push({ collection: c, index, id, message: 'duplicate id' });
        return;
      }
      seen.add(id);
      dataset[c].push(normalize(c, r));
    });
  }
  const s = data?.settings;
  dataset.settings = s && typeof s === 'object' && s.values ? { values: { ...s.values }, updatedAt: { ...(s.updatedAt || {}) } } : { values: {}, updatedAt: {} };
  // Orphans
  const deckIds = new Set(dataset.decks.map((d) => d.id));
  let recovered = 0;
  for (const card of dataset.cards) {
    if (!deckIds.has(card.deckId)) {
      card.deckId = recoveredDeckId;
      recovered++;
    }
  }
  if (recovered) {
    dataset.decks.push(normalize('decks', { id: recoveredDeckId, name: 'Recovered cards', createdAt: Date.now(), updatedAt: Date.now() }));
    errors.push({ collection: 'cards', index: -1, message: `${recovered} card(s) referenced a missing deck and were placed in “Recovered cards”` });
  }
  const cardIds = new Set(dataset.cards.map((c) => c.id));
  const before = dataset.units.length;
  dataset.units = dataset.units.filter((u) => cardIds.has(u.cardId));
  if (dataset.units.length < before) errors.push({ collection: 'units', index: -1, message: `${before - dataset.units.length} scheduling record(s) without a card were skipped (history is kept)` });
  return { dataset, errors };
}

export function buildBackup(data, { deviceId }) {
  const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, (data[c] || []).length]));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    app: APP_VERSION,
    schema: DB_VERSION,
    recordVersion: RECORD_VERSION,
    scheduler: SCHEDULER_VERSION,
    grading: GRADING_VERSION,
    matcher: MATCHER_VERSION,
    exportedAt: Date.now(),
    deviceId,
    counts,
    data,
  };
}

/**
 * Parse and check a backup object (already decoded from an envelope).
 * @returns {{ ok, dataset, errors, meta, migrations }}
 */
export function readBackup(obj) {
  if (!obj || obj.format !== BACKUP_FORMAT) return { ok: false, errors: [{ message: 'Not an Axon backup file' }] };
  if (obj.version > BACKUP_FORMAT_VERSION) return { ok: false, errors: [{ message: 'This backup was made by a newer version of Axon. Update the app to restore it.' }] };
  const { data, applied } = migrateData(obj.data || {}, obj.recordVersion ?? 0);
  const { dataset, errors } = validateDataset(data);
  return {
    ok: true,
    dataset,
    errors,
    migrations: applied,
    meta: { app: obj.app, exportedAt: obj.exportedAt, deviceId: obj.deviceId, counts: obj.counts, scheduler: obj.scheduler, grading: obj.grading },
  };
}
