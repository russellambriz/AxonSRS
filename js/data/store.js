/**
 * Domain data store on top of IndexedDB.
 *
 * All multi-record changes happen in single transactions. Reviews are
 * idempotent (event id) and guarded against stale state (the unit's head
 * event must match the review's parent), which also prevents duplicate
 * scheduling from two tabs. Deletions go to a trash record so they can be
 * undone, and leave tombstones so they propagate through sync.
 */

import { DB_VERSION, APP_VERSION } from '../config.js';
import { openWithSafety, transaction, StorageError, dumpDatabase, writeSnapshot, listSnapshots, readSnapshot, deleteSnapshot, STORES } from './db.js';
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_DEVICE_SETTINGS, mergeSettings } from './settings.js';
import { uuid, sha256Hex, bytesToBase64, base64ToBytes } from '../core/util.js';
import { createDeck, createCard, unitKeys, unitId, DEFAULT_DECK_SETTINGS } from '../core/model.js';
import { stamp, revisionFor } from '../core/sync/versioning.js';
import { mergeDatasets, emptyDataset } from '../core/sync/merge.js';
import { replayUnit, statesEqual } from '../core/history.js';
import { createBaseline, addSample, removeSample } from '../core/fluency.js';
import { studyDay, systemTimeZone } from '../core/time.js';
import { schedulerParams } from '../core/scheduler.js';
import { dailyActivity } from '../core/stats.js';

const UNIT_REVIEW_FIELDS = ['state', 'headEventId', 'lastReviewAt', 'perf', 'practiceSinceLast', 'lastPracticeAt', 'lastScheduled', 'introducedDay', 'leech', 'leechSince', 'suspended', 'suspendedAt', 'siblingExposedAt'];
const TRASH_DAYS = 30;

/** A fresh, never-reviewed unit for one direction/cloze/mask of a card. */
function newUnitRecord(card, key, now) {
  return { id: unitId(card.id, key), cardId: card.id, deckId: card.deckId, key, state: null, headEventId: null, active: true, suspended: false, suspendedAt: 0, overlays: {}, overlaysAt: 0, perf: { recent: [] }, createdAt: now, updatedAt: now };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

export class AxonStore {
  constructor() {
    this.db = null;
    this.deviceId = null;
    this.global = { ...DEFAULT_GLOBAL_SETTINGS };
    this.globalMeta = { values: {}, updatedAt: {} };
    this.device = { ...DEFAULT_DEVICE_SETTINGS };
    this.listeners = new Set();
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('axon-data') : null;
    this.upgradeInfo = null;
    if (this.channel) {
      this.channel.onmessage = (e) => {
        if (e.data?.origin !== this.instanceId) this.emit(e.data.type, { ...e.data.detail, remote: true }, false);
      };
    }
    this.instanceId = uuid();
  }

  /* ---------------- lifecycle ---------------- */

  async init({ onVersionChange } = {}) {
    const { db, upgradedFrom, snapshotId } = await openWithSafety({ onVersionChange: () => {
      this.emit('versionchange', {}, false);
      if (onVersionChange) onVersionChange();
    } });
    this.db = db;
    this.upgradeInfo = upgradedFrom ? { from: upgradedFrom, to: DB_VERSION, snapshotId } : null;
    await transaction(db, ['meta'], 'readwrite', async (t) => {
      let dev = await t.get('meta', 'deviceId');
      if (!dev) {
        dev = { key: 'deviceId', value: uuid(), createdAt: Date.now() };
        await t.put('meta', dev);
      }
      this.deviceId = dev.value;
      const created = await t.get('meta', 'createdAt');
      if (!created) await t.put('meta', { key: 'createdAt', value: Date.now(), app: APP_VERSION });
      await t.put('meta', { key: 'lastOpenedApp', value: APP_VERSION, at: Date.now() });
    });
    await this.loadSettings();
    this.cleanTrash().catch(() => {});
    return this;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, detail = {}, broadcast = true) {
    for (const fn of this.listeners) {
      try {
        fn(type, detail);
      } catch (err) {
        console.error(err);
      }
    }
    if (broadcast && this.channel) {
      try {
        this.channel.postMessage({ type, detail: JSON.parse(JSON.stringify(detail || {})), origin: this.instanceId });
      } catch {
        /* ignore */
      }
    }
  }

  tx(stores, mode, fn) {
    if (!this.db) throw new StorageError('Database is not open', 'closed');
    return transaction(this.db, stores, mode, fn);
  }

  /* ---------------- settings ---------------- */

  async loadSettings() {
    const [g, d] = await this.tx(['settings'], 'readonly', async (t) => [await t.get('settings', 'global'), await t.get('settings', 'device')]);
    this.globalMeta = { values: g?.values || {}, updatedAt: g?.updatedAt || {} };
    this.global = mergeSettings(DEFAULT_GLOBAL_SETTINGS, this.globalMeta.values);
    this.device = mergeSettings(DEFAULT_DEVICE_SETTINGS, d?.values || {});
  }

  async setGlobal(patch) {
    const now = Date.now();
    await this.tx(['settings'], 'readwrite', async (t) => {
      const g = (await t.get('settings', 'global')) || { key: 'global', values: {}, updatedAt: {} };
      for (const [k, v] of Object.entries(patch)) {
        g.values[k] = v;
        g.updatedAt[k] = now;
      }
      await t.put('settings', g);
    });
    await this.loadSettings();
    this.emit('settings', { scope: 'global', keys: Object.keys(patch) });
  }

  async setDevice(patch) {
    await this.tx(['settings'], 'readwrite', async (t) => {
      const d = (await t.get('settings', 'device')) || { key: 'device', values: {} };
      d.values = { ...d.values, ...patch };
      await t.put('settings', d);
    });
    await this.loadSettings();
    this.emit('settings', { scope: 'device', keys: Object.keys(patch) }, false);
  }

  timeOptions() {
    return { timeZone: this.global.timeZone || systemTimeZone(), rolloverHour: this.global.rolloverHour ?? 4 };
  }

  today(now = Date.now()) {
    return studyDay(now, this.timeOptions());
  }

  paramsFor(deck) {
    const s = { ...DEFAULT_DECK_SETTINGS, ...(deck?.settings || {}) };
    return schedulerParams({
      desiredRetention: s.desiredRetention || this.global.desiredRetention || 0.9,
      learningSteps: s.learningSteps,
      relearningSteps: s.relearningSteps,
      maximumInterval: this.global.maximumInterval || 36500,
    });
  }

  /* ---------------- generic reads ---------------- */

  getAll(store) {
    return this.tx([store], 'readonly', (t) => t.getAll(store));
  }

  get(store, key) {
    return this.tx([store], 'readonly', (t) => t.get(store, key));
  }

  async getMeta(key) {
    return (await this.get('meta', key))?.value;
  }

  setMeta(key, value) {
    return this.tx(['meta'], 'readwrite', (t) => t.put('meta', { key, value, at: Date.now() }));
  }

  /* ---------------- decks ---------------- */

  listDecks() {
    return this.getAll('decks');
  }

  getDeck(id) {
    return this.get('decks', id);
  }

  async createDeck(fields) {
    const deck = createDeck(fields, this.deviceId);
    return this.saveDeck(deck);
  }

  /**
   * Save a deck. A direction change creates/activates the matching units
   * (existing history is kept; units outside the direction go inactive).
   */
  async saveDeck(deck) {
    const now = Date.now();
    const result = await this.tx(['decks', 'revisions', 'cards', 'units'], 'readwrite', async (t) => {
      const before = await t.get('decks', deck.id);
      const { record, revision } = stamp('decks', { ...deck, deviceId: this.deviceId }, { deviceId: this.deviceId, ts: now });
      await t.put('decks', record);
      await t.put('revisions', revision);
      if (before && before.settings?.direction !== record.settings?.direction) {
        const cards = await t.getAllFromIndex('cards', 'deckId', deck.id);
        for (const card of cards) await this.syncUnitsInTx(t, card, record, now);
      }
      return record;
    });
    this.emit('decks', { id: deck.id });
    return result;
  }

  async deleteDeck(id) {
    const now = Date.now();
    const trashId = uuid();
    await this.tx(['decks', 'cards', 'units', 'links', 'tombstones', 'trash'], 'readwrite', async (t) => {
      const deck = await t.get('decks', id);
      if (!deck) return;
      const cards = await t.getAllFromIndex('cards', 'deckId', id);
      const units = await t.getAllFromIndex('units', 'deckId', id);
      const cardIds = new Set(cards.map((c) => c.id));
      const links = (await t.getAll('links')).filter((l) => cardIds.has(l.a) || cardIds.has(l.b));
      await t.put('trash', { id: trashId, kind: 'deck', label: deck.name, createdAt: now, records: { decks: [deck], cards, units, links } });
      await t.delete('decks', id);
      await t.put('tombstones', { id, type: 'decks', deletedAt: now, deviceId: this.deviceId, lastHash: deck.version?.hash || null });
      for (const c of cards) {
        await t.delete('cards', c.id);
        await t.put('tombstones', { id: c.id, type: 'cards', deletedAt: now, deviceId: this.deviceId, lastHash: c.version?.hash || null });
      }
      for (const u of units) await t.delete('units', u.id);
      for (const l of links) {
        await t.delete('links', l.id);
        await t.put('tombstones', { id: l.id, type: 'links', deletedAt: now, deviceId: this.deviceId, lastHash: l.version?.hash || null });
      }
    });
    this.emit('decks', { id, deleted: true });
    this.emit('cards', { deckId: id });
    return trashId;
  }

  async duplicateDeck(id) {
    const deck = await this.getDeck(id);
    if (!deck) throw new StorageError('Deck not found', 'not-found');
    const cards = await this.listCards({ deckId: id });
    const copy = createDeck({ name: `${deck.name} (copy)`, description: deck.description, color: deck.color, group: deck.group, settings: deck.settings }, this.deviceId);
    const saved = await this.saveDeck(copy);
    await this.saveCards(cards.map((c) => createCard({ ...c, id: undefined, version: null, deckId: saved.id, createdAt: undefined }, this.deviceId)));
    return saved;
  }

  /* ---------------- cards & units ---------------- */

  async listCards({ deckId = null } = {}) {
    if (deckId) return this.tx(['cards'], 'readonly', (t) => t.getAllFromIndex('cards', 'deckId', deckId));
    return this.getAll('cards');
  }

  getCard(id) {
    return this.get('cards', id);
  }

  async syncUnitsInTx(t, card, deck, now) {
    const keys = unitKeys(card, deck);
    const existing = await t.getAllFromIndex('units', 'cardId', card.id);
    const byId = new Map(existing.map((u) => [u.id, u]));
    for (const key of keys) {
      const id = unitId(card.id, key);
      const u = byId.get(id);
      if (!u) {
        await t.put('units', newUnitRecord(card, key, now));
      } else if (!u.active || u.deckId !== card.deckId) {
        await t.put('units', { ...u, active: true, deckId: card.deckId, updatedAt: now });
      }
      byId.delete(id);
    }
    for (const u of byId.values()) if (u.active) await t.put('units', { ...u, active: false, updatedAt: now });
  }

  /**
   * Save one or more cards (create or update) atomically.
   * `resets`: Map cardId → unit keys whose schedule should restart
   * (recorded as 'reset' events so replay stays faithful).
   */
  async saveCards(cards, { resets = new Map(), sessionId = null } = {}) {
    const now = Date.now();
    const saved = await this.tx(['cards', 'decks', 'units', 'revisions', 'events', 'meta'], 'readwrite', async (t) => {
      const decks = new Map();
      const out = [];
      for (const raw of cards) {
        let deck = decks.get(raw.deckId);
        if (!deck) {
          deck = await t.get('decks', raw.deckId);
          if (!deck) throw new StorageError('The card’s deck no longer exists', 'not-found');
          decks.set(raw.deckId, deck);
        }
        const { record, revision } = stamp('cards', { ...raw, deviceId: this.deviceId }, { deviceId: this.deviceId, ts: now });
        await t.put('cards', record);
        await t.put('revisions', revision);
        await this.syncUnitsInTx(t, record, deck, now);
        for (const key of resets.get(record.id) || []) {
          const uid = unitId(record.id, key);
          const unit = await t.get('units', uid);
          if (!unit || !unit.state) continue;
          const seq = await this.nextSeqInTx(t);
          const ev = { id: uuid(), type: 'reset', ts: now, deviceId: this.deviceId, seq, unitId: uid, cardId: record.id, deckId: record.deckId, studyDay: this.today(now), parentId: unit.headEventId || null, prevState: unit.state, reason: 'content-changed', sessionId, cardRevision: record.version.hash };
          await t.add('events', ev);
          await t.put('units', { ...unit, state: null, headEventId: ev.id, lastScheduled: null, leech: false, updatedAt: now });
        }
        out.push(record);
      }
      return out;
    });
    this.emit('cards', { ids: saved.map((c) => c.id) });
    return saved;
  }

  async saveCard(card, opts) {
    return (await this.saveCards([card], opts))[0];
  }

  async deleteCards(ids) {
    const now = Date.now();
    const trashId = uuid();
    await this.tx(['cards', 'units', 'links', 'tombstones', 'trash'], 'readwrite', async (t) => {
      const cards = [];
      const units = [];
      const links = [];
      const all = await t.getAll('links');
      for (const id of ids) {
        const c = await t.get('cards', id);
        if (!c) continue;
        cards.push(c);
        units.push(...(await t.getAllFromIndex('units', 'cardId', id)));
        links.push(...all.filter((l) => (l.a === id || l.b === id) && !links.includes(l)));
      }
      if (!cards.length) return;
      await t.put('trash', { id: trashId, kind: 'cards', label: cards.length === 1 ? 'card' : `${cards.length} cards`, createdAt: now, records: { cards, units, links } });
      for (const c of cards) {
        await t.delete('cards', c.id);
        await t.put('tombstones', { id: c.id, type: 'cards', deletedAt: now, deviceId: this.deviceId, lastHash: c.version?.hash || null });
      }
      for (const u of units) await t.delete('units', u.id);
      for (const l of links) {
        await t.delete('links', l.id);
        await t.put('tombstones', { id: l.id, type: 'links', deletedAt: now, deviceId: this.deviceId, lastHash: l.version?.hash || null });
      }
    });
    this.emit('cards', { ids, deleted: true });
    return trashId;
  }

  /** Undo a deletion: records come back with a resurrecting version. */
  async restoreTrash(trashId) {
    const now = Date.now();
    const item = await this.get('trash', trashId);
    if (!item) throw new StorageError('Nothing to restore (the undo window has passed)', 'not-found');
    await this.tx(['decks', 'cards', 'units', 'links', 'tombstones', 'trash', 'revisions'], 'readwrite', async (t) => {
      for (const type of ['decks', 'cards', 'links']) {
        for (const rec of item.records[type] || []) {
          const { record, revision } = stamp(type, rec, { deviceId: this.deviceId, ts: now, resurrects: true });
          await t.put(type, record);
          await t.put('revisions', revision);
          const tomb = await t.get('tombstones', rec.id);
          if (tomb) await t.put('tombstones', { ...tomb, revoked: true, revokedAt: now });
        }
      }
      for (const u of item.records.units || []) await t.put('units', u);
      await t.delete('trash', trashId);
    });
    this.emit('decks', {});
    this.emit('cards', {});
  }

  async cleanTrash() {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    await this.tx(['trash'], 'readwrite', async (t) => {
      for (const item of await t.getAll('trash')) if (item.createdAt < cutoff) await t.delete('trash', item.id);
    });
  }

  listUnits() {
    return this.getAll('units');
  }

  unitsForCard(cardId) {
    return this.tx(['units'], 'readonly', (t) => t.getAllFromIndex('units', 'cardId', cardId));
  }

  /** Overlay changes (bury, defer, postpone) and unit suspension; LWW-synced. */
  async patchUnits(changes) {
    const now = Date.now();
    await this.tx(['units'], 'readwrite', async (t) => {
      for (const ch of changes) {
        const u = await t.get('units', ch.unitId);
        if (!u) continue;
        const next = { ...u, updatedAt: now };
        if (ch.overlays) {
          next.overlays = { ...(u.overlays || {}), ...ch.overlays };
          for (const k of Object.keys(next.overlays)) if (next.overlays[k] == null) delete next.overlays[k];
          next.overlaysAt = now;
        }
        if ('suspended' in ch) {
          next.suspended = ch.suspended;
          next.suspendedAt = now;
        }
        if ('siblingExposedAt' in ch) next.siblingExposedAt = ch.siblingExposedAt;
        await t.put('units', next);
      }
    });
    this.emit('units', { ids: changes.map((c) => c.unitId) });
  }

  revisionsFor(recordId) {
    return this.tx(['revisions'], 'readonly', (t) => t.getAllFromIndex('revisions', 'recordId', recordId));
  }

  /* ---------------- links ---------------- */

  listLinks() {
    return this.getAll('links');
  }

  async addLink(a, b) {
    if (a === b) return null;
    const existing = (await this.listLinks()).find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    if (existing) return existing;
    const now = Date.now();
    const rec = { id: uuid(), a, b, kind: 'related', createdAt: now };
    const { record, revision } = stamp('links', rec, { deviceId: this.deviceId, ts: now });
    await this.tx(['links', 'revisions'], 'readwrite', async (t) => {
      await t.put('links', record);
      await t.put('revisions', revision);
    });
    this.emit('links', {});
    return record;
  }

  async removeLink(id) {
    const now = Date.now();
    await this.tx(['links', 'tombstones'], 'readwrite', async (t) => {
      const l = await t.get('links', id);
      if (!l) return;
      await t.delete('links', id);
      await t.put('tombstones', { id, type: 'links', deletedAt: now, deviceId: this.deviceId, lastHash: l.version?.hash || null });
    });
    this.emit('links', {});
  }

  /* ---------------- events & reviews ---------------- */

  async nextSeqInTx(t) {
    const m = (await t.get('meta', 'seq')) || { key: 'seq', value: 0 };
    m.value += 1;
    await t.put('meta', m);
    return m.value;
  }

  allEvents() {
    return this.getAll('events');
  }

  eventsForUnit(uid) {
    return this.tx(['events'], 'readonly', (t) => t.getAllFromIndex('events', 'unitId', uid));
  }

  eventsForCard(cardId) {
    return this.tx(['events'], 'readonly', (t) => t.getAllFromIndex('events', 'cardId', cardId));
  }

  eventsSince(ts) {
    return this.tx(['events'], 'readonly', (t) => t.getAllFromIndex('events', 'ts', IDBKeyRange.lowerBound(ts)));
  }

  /**
   * Per-study-day activity (reviews, practice, correct, study time) for the
   * home heatmap and streak, without loading the whole history each time.
   * Cached in meta and topped up with events newer than the cache; if the
   * event count shows anything else changed (sync merge, restore), it is
   * rebuilt from scratch.
   */
  async activitySummary() {
    const total = await this.tx(['events'], 'readonly', (t) => t.count('events'));
    const cache = await this.getMeta('activity');
    const toMap = (obj) => new Map(Object.entries(obj));
    if (cache?.v === 1 && cache.count === total) return toMap(cache.days);
    let days = null;
    let lastTs = 0;
    if (cache?.v === 1 && cache.count < total) {
      const fresh = await this.tx(['events'], 'readonly', (t) => t.getAllFromIndex('events', 'ts', IDBKeyRange.lowerBound(cache.lastTs, true)));
      if (cache.count + fresh.length === total) {
        days = dailyActivity(fresh, toMap(cache.days));
        lastTs = Math.max(cache.lastTs, ...fresh.map((e) => e.ts));
      }
    }
    if (!days) {
      const all = await this.allEvents();
      days = dailyActivity(all);
      for (const e of all) if (e.ts > lastTs) lastTs = e.ts;
    }
    await this.setMeta('activity', { v: 1, count: total, lastTs, days: Object.fromEntries(days) });
    return days;
  }

  /** The most recent `limit` reviews and practice answers (for time estimates). */
  recentRetrievals(limit = 300) {
    return this.tx(['events'], 'readonly', (t) => t.lastFromIndex('events', 'ts', limit, (e) => e.type === 'review' || e.type === 'practice')).then((list) => list.reverse());
  }

  eventsForDay(day) {
    return this.tx(['events'], 'readonly', (t) => t.getAllFromIndex('events', 'studyDay', day));
  }

  /**
   * Commit a planned review atomically: event + unit + calibration +
   * session. Returns { duplicate } when the same review was already saved
   * (safe retry). Throws code 'stale' if another tab or device changed
   * the unit since the card was shown.
   */
  async commitReview(plan, { session = null } = {}) {
    const now = Date.now();
    const result = await this.tx(['events', 'units', 'calibration', 'sessions', 'meta'], 'readwrite', async (t) => {
      const existing = await t.get('events', plan.event.id);
      if (existing) return { duplicate: true, event: existing };
      const current = await t.get('units', plan.unit.id);
      if (!current) throw new StorageError('This card no longer exists', 'not-found');
      if (plan.event.type === 'review' && (current.headEventId || null) !== (plan.event.parentId || null)) {
        throw new StorageError('This card was just reviewed in another tab or on another device. Its schedule was not changed twice.', 'stale');
      }
      const event = { ...plan.event, seq: await this.nextSeqInTx(t) };
      await t.add('events', event);
      await t.put('units', { ...current, ...pick(plan.unit, UNIT_REVIEW_FIELDS), updatedAt: now });
      if (plan.calibration) {
        const key = plan.calibration.key;
        const base = (await t.get('calibration', key)) || createBaseline(key);
        await t.put('calibration', addSample(base, plan.calibration.sample));
      }
      if (session) await t.put('sessions', { ...session, updatedAt: now });
      return { duplicate: false, event };
    });
    this.emit('review', { unitId: plan.unit.id, eventId: plan.event.id });
    return result;
  }

  /** Commit a correction (override/undo) with optional card + calibration changes. */
  async commitCorrection(plan, { session = null, expectedHead, removeCalibration = null, card = null } = {}) {
    const now = Date.now();
    const result = await this.tx(['events', 'units', 'calibration', 'sessions', 'meta', 'cards', 'revisions', 'decks'], 'readwrite', async (t) => {
      const existing = await t.get('events', plan.event.id);
      if (existing) return { duplicate: true };
      const current = await t.get('units', plan.unit.id);
      if (current && expectedHead !== undefined && (current.headEventId || null) !== (expectedHead || null)) {
        throw new StorageError('This card changed in another tab; reload before correcting it.', 'stale');
      }
      const event = { ...plan.event, seq: await this.nextSeqInTx(t) };
      await t.add('events', event);
      if (current) await t.put('units', { ...current, ...pick(plan.unit, UNIT_REVIEW_FIELDS), updatedAt: now });
      if (removeCalibration) {
        const base = await t.get('calibration', removeCalibration.key);
        if (base) await t.put('calibration', removeSample(base, removeCalibration.eventId));
      }
      if (card) {
        const { record, revision } = stamp('cards', { ...card, deviceId: this.deviceId }, { deviceId: this.deviceId, ts: now });
        await t.put('cards', record);
        await t.put('revisions', revision);
      }
      if (session) await t.put('sessions', { ...session, updatedAt: now });
      return { duplicate: false, event };
    });
    this.emit('review', { unitId: plan.unit.id, correction: true });
    if (card) this.emit('cards', { ids: [card.id] });
    return result;
  }

  /** Non-scheduling exposure events (hint, reveal, copy, skip, …). */
  async addEvents(events, { session = null, unitPatches = [] } = {}) {
    if (!events.length && !session) return [];
    const now = Date.now();
    const saved = await this.tx(['events', 'meta', 'sessions', 'units'], 'readwrite', async (t) => {
      const out = [];
      for (const e of events) {
        if (await t.get('events', e.id)) continue;
        const ev = { ...e, seq: await this.nextSeqInTx(t) };
        await t.add('events', ev);
        out.push(ev);
      }
      for (const p of unitPatches) {
        const u = await t.get('units', p.unitId);
        if (u) await t.put('units', { ...u, ...p.patch, updatedAt: now });
      }
      if (session) await t.put('sessions', { ...session, updatedAt: now });
      return out;
    });
    if (saved.length) this.emit('events', { count: saved.length });
    return saved;
  }

  /* ---------------- sessions ---------------- */

  saveSession(session) {
    return this.tx(['sessions'], 'readwrite', (t) => t.put('sessions', { ...session, updatedAt: Date.now() }));
  }

  getSession(id) {
    return this.get('sessions', id);
  }

  async activeSessions() {
    const list = await this.tx(['sessions'], 'readonly', (t) => t.getAll('sessions'));
    return list.filter((s) => s.status === 'active' || s.status === 'paused').sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /* ---------------- calibration ---------------- */

  getBaseline(key) {
    return this.get('calibration', key);
  }

  listBaselines() {
    return this.getAll('calibration');
  }

  async resetCalibration() {
    await this.tx(['calibration'], 'readwrite', async (t) => {
      for (const b of await t.getAll('calibration')) await t.delete('calibration', b.key);
    });
    this.emit('calibration', {});
  }

  /* ---------------- plans ---------------- */

  listPlans() {
    return this.getAll('plans');
  }

  async savePlan(plan) {
    const now = Date.now();
    const rec = { id: plan.id || uuid(), createdAt: plan.createdAt || now, ...plan };
    const { record, revision } = stamp('plans', rec, { deviceId: this.deviceId, ts: now });
    await this.tx(['plans', 'revisions'], 'readwrite', async (t) => {
      await t.put('plans', record);
      await t.put('revisions', revision);
    });
    this.emit('plans', {});
    return record;
  }

  async deletePlan(id) {
    const now = Date.now();
    await this.tx(['plans', 'tombstones'], 'readwrite', async (t) => {
      const p = await t.get('plans', id);
      if (!p) return;
      await t.delete('plans', id);
      await t.put('tombstones', { id, type: 'plans', deletedAt: now, deviceId: this.deviceId, lastHash: p.version?.hash || null });
    });
    this.emit('plans', {});
  }

  /* ---------------- media ---------------- */

  /** Store a blob content-addressed by SHA-256 (deduplicated). */
  async putMedia(blob, { name = '' } = {}) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = `sha256-${await sha256Hex(bytes)}`;
    await this.tx(['media'], 'readwrite', async (t) => {
      const existing = await t.get('media', id);
      if (!existing) await t.put('media', { id, type: blob.type, size: bytes.length, name, blob, createdAt: Date.now() });
    });
    this.emit('media', { id });
    return id;
  }

  async getMedia(id) {
    return this.get('media', id);
  }

  /* ---------------- imports ---------------- */

  async beginImport(record) {
    const rec = { id: uuid(), status: 'in-progress', startedAt: Date.now(), ...record };
    await this.tx(['imports'], 'readwrite', (t) => t.put('imports', rec));
    return rec;
  }

  /**
   * Commit an import atomically: new decks, new cards, updated cards
   * (existing history preserved), and the import record → 'complete'.
   */
  async commitImport(importRecord, { newDecks = [], newCards = [], updates = [] }) {
    const now = Date.now();
    if (updates.length) await this.snapshot(`before import ${importRecord.id} (updates ${updates.length} cards)`);
    await this.tx(['decks', 'cards', 'units', 'revisions', 'imports'], 'readwrite', async (t) => {
      const decks = new Map();
      for (const d of newDecks) {
        const { record, revision } = stamp('decks', d, { deviceId: this.deviceId, ts: now });
        await t.put('decks', record);
        await t.put('revisions', revision);
        decks.set(record.id, record);
      }
      const getDeck = async (id) => {
        if (!decks.has(id)) decks.set(id, await t.get('decks', id));
        return decks.get(id);
      };
      // New cards have new ids, so their units are created directly and
      // everything is written in batches (large imports stay fast).
      const cardRecords = [];
      const revisions = [];
      const units = [];
      for (const c of newCards) {
        const deck = await getDeck(c.deckId);
        if (!deck) throw new StorageError('Import target deck is missing', 'not-found');
        const { record, revision } = stamp('cards', c, { deviceId: this.deviceId, ts: now });
        cardRecords.push(record);
        revisions.push(revision);
        for (const key of unitKeys(record, deck)) units.push(newUnitRecord(record, key, now));
      }
      await t.putMany('cards', cardRecords);
      await t.putMany('revisions', revisions);
      await t.putMany('units', units);
      for (const c of updates) {
        const before = await t.get('cards', c.id);
        if (!before) continue;
        const { record, revision } = stamp('cards', { ...before, ...c, version: before.version }, { deviceId: this.deviceId, ts: now });
        await t.put('cards', record);
        await t.put('revisions', revision);
        await this.syncUnitsInTx(t, record, await getDeck(record.deckId), now);
      }
      await t.put('imports', { ...importRecord, status: 'complete', completedAt: now, counts: { decks: newDecks.length, created: newCards.length, updated: updates.length }, source: undefined });
    });
    this.emit('cards', { import: importRecord.id });
    this.emit('decks', {});
  }

  async listImports() {
    return (await this.getAll('imports')).sort((a, b) => b.startedAt - a.startedAt);
  }

  async discardImport(id) {
    await this.tx(['imports'], 'readwrite', (t) => t.delete('imports', id));
  }

  /* ---------------- conflicts ---------------- */

  listConflicts() {
    return this.getAll('conflicts');
  }

  /**
   * Resolve an edit conflict. choice: 'local' | 'remote' | { content }.
   * The resolution is a new version descending from both sides.
   */
  async resolveConflict(conflictId, choice) {
    const now = Date.now();
    await this.tx(['conflicts', 'cards', 'decks', 'links', 'plans', 'revisions', 'tombstones', 'units'], 'readwrite', async (t) => {
      const c = await t.get('conflicts', conflictId);
      if (!c) return;
      const type = c.recordType;
      if (c.kind === 'edit') {
        const local = await t.get(type, c.recordId);
        if (!local) {
          await t.delete('conflicts', conflictId);
          return;
        }
        let content = local;
        if (choice === 'remote') content = { ...local, ...c.remote };
        else if (choice && typeof choice === 'object') content = { ...local, ...choice.content };
        const parent = local.version.hash === c.localHash ? c.localHash : local.version.hash;
        const { record, revision } = stamp(type, { ...content, version: { ...local.version, hash: parent } }, { deviceId: this.deviceId, ts: now, mergeParent: c.remoteHash });
        await t.put(type, record);
        await t.put('revisions', revision);
        if (type === 'cards') {
          const deck = await t.get('decks', record.deckId);
          if (deck) await this.syncUnitsInTx(t, record, deck, now);
        }
      } else if (c.kind === 'delete-edit') {
        const rec = await t.get(type, c.recordId);
        if (choice === 'delete') {
          if (rec) {
            await t.delete(type, c.recordId);
            await t.put('tombstones', { id: c.recordId, type, deletedAt: now, deviceId: this.deviceId, lastHash: rec.version?.hash || null });
            if (type === 'cards') for (const u of await t.getAllFromIndex('units', 'cardId', c.recordId)) await t.delete('units', u.id);
          }
        } else if (rec) {
          const { record, revision } = stamp(type, rec, { deviceId: this.deviceId, ts: now, resurrects: true });
          await t.put(type, record);
          await t.put('revisions', revision);
          const tomb = await t.get('tombstones', c.recordId);
          if (tomb) await t.put('tombstones', { ...tomb, revoked: true, revokedAt: now });
        }
      }
      await t.delete('conflicts', conflictId);
    });
    this.emit('conflicts', {});
    this.emit('cards', {});
  }

  /* ---------------- dataset export / merge ---------------- */

  /** Everything that belongs in a backup or sync payload (no secrets). */
  async exportDataset({ includeMedia = true, includeCalibration = false } = {}) {
    const stores = ['decks', 'cards', 'units', 'events', 'revisions', 'tombstones', 'links', 'plans', 'media', 'settings', 'calibration'];
    const data = await this.tx(stores, 'readonly', async (t) => {
      const out = {};
      for (const s of stores) out[s] = await t.getAll(s);
      return out;
    });
    const media = [];
    if (includeMedia) {
      for (const m of data.media) {
        const bytes = new Uint8Array(await m.blob.arrayBuffer());
        media.push({ id: m.id, type: m.type, size: m.size, name: m.name || '', createdAt: m.createdAt, data: bytesToBase64(bytes) });
      }
    }
    const g = data.settings.find((s) => s.key === 'global');
    return {
      decks: data.decks,
      cards: data.cards,
      units: data.units,
      events: data.events,
      revisions: data.revisions,
      tombstones: data.tombstones,
      links: data.links,
      plans: data.plans,
      media,
      calibration: includeCalibration ? data.calibration : [],
      settings: { values: g?.values || {}, updatedAt: g?.updatedAt || {} },
    };
  }

  /**
   * Merge an incoming dataset (sync pull or backup restore) into the
   * local database in one transaction, then rebuild affected schedules
   * from the merged event history.
   */
  async mergeIn(incoming, { reason = 'merge' } = {}) {
    const local = await this.exportDataset({ includeMedia: false });
    const { dataset, report } = mergeDatasets(local, { ...emptyDataset(), ...incoming, media: (incoming.media || []).map((m) => ({ ...m })) });
    const eventsByUnit = new Map();
    for (const e of dataset.events) {
      if (!e.unitId) continue;
      if (!eventsByUnit.has(e.unitId)) eventsByUnit.set(e.unitId, []);
      eventsByUnit.get(e.unitId).push(e);
    }
    const unitsOut = [];
    const concurrent = [];
    for (const u of dataset.units) {
      if (!report.unitsToReplay.has(u.id)) continue;
      const replay = replayUnit(eventsByUnit.get(u.id) || []);
      unitsOut.push({ ...u, state: replay.state, headEventId: replay.headEventId, lastReviewAt: replay.applied.length ? replay.applied[replay.applied.length - 1].event.ts : null, updatedAt: Date.now() });
      for (const group of replay.concurrent) {
        concurrent.push({ id: `concurrent:${u.id}:${group.map((e) => e.id).sort().join(':')}`, kind: 'concurrent-review', recordType: 'units', recordId: u.id, cardId: u.cardId, events: group.map((e) => ({ id: e.id, ts: e.ts, deviceId: e.deviceId, rating: e.rating, correct: e.response?.correct })), createdAt: Date.now() });
      }
    }
    const replayedIds = new Set(unitsOut.map((u) => u.id));
    const localIds = {};
    for (const type of ['decks', 'cards', 'links', 'plans']) localIds[type] = new Set(local[type].map((r) => r.id));
    // Only records that differ from this device's copy are written.
    const localById = {};
    for (const type of ['decks', 'cards', 'links', 'plans', 'units', 'tombstones']) localById[type] = new Map((local[type] || []).map((r) => [r.id, r]));
    const changed = (type, r) => {
      const mine = localById[type].get(r.id);
      return !mine || JSON.stringify(mine) !== JSON.stringify(r);
    };
    await this.tx(['decks', 'cards', 'units', 'events', 'revisions', 'tombstones', 'links', 'plans', 'media', 'settings', 'conflicts'], 'readwrite', async (t) => {
      for (const type of ['decks', 'cards', 'links', 'plans']) {
        const keep = new Set(dataset[type].map((r) => r.id));
        await t.putMany(type, dataset[type].filter((r) => changed(type, r)));
        for (const id of localIds[type]) if (!keep.has(id)) await t.delete(type, id);
      }
      const existingEvents = new Set(await t.keys('events'));
      await t.putMany('events', dataset.events.filter((e) => !existingEvents.has(e.id)));
      const existingRevisions = new Set(await t.keys('revisions'));
      await t.putMany('revisions', dataset.revisions.filter((r) => !existingRevisions.has(r.id)));
      await t.putMany('tombstones', dataset.tombstones.filter((tb) => changed('tombstones', tb)));
      const cardIds = new Set(dataset.cards.map((c) => c.id));
      const unitPuts = [];
      for (const u of dataset.units) {
        if (!cardIds.has(u.cardId)) {
          if (localById.units.has(u.id)) await t.delete('units', u.id);
          continue;
        }
        if (replayedIds.has(u.id)) continue;
        if (changed('units', u)) unitPuts.push(u);
      }
      await t.putMany('units', unitPuts);
      await t.putMany('units', unitsOut.filter((u) => cardIds.has(u.cardId)));
      for (const m of incoming.media || []) {
        if (!m.data) continue;
        const existing = await t.get('media', m.id);
        if (!existing) await t.put('media', { id: m.id, type: m.type, size: m.size, name: m.name || '', createdAt: m.createdAt || Date.now(), blob: new Blob([base64ToBytes(m.data)], { type: m.type }) });
      }
      await t.put('settings', { key: 'global', values: dataset.settings.values, updatedAt: dataset.settings.updatedAt });
      for (const c of [...report.conflicts, ...concurrent]) {
        const prev = await t.get('conflicts', c.id);
        if (!prev) await t.put('conflicts', { ...c, createdAt: Date.now(), reason });
      }
    });
    await this.loadSettings();
    this.emit('decks', {});
    this.emit('cards', {});
    this.emit('review', {});
    if (report.conflicts.length || concurrent.length) this.emit('conflicts', {});
    return { report, concurrent: concurrent.length };
  }

  /** Replace all study data with a dataset (after a snapshot). */
  async replaceAll(dataset, { reason = 'replace' } = {}) {
    await this.snapshot(`before ${reason}`);
    const stores = ['decks', 'cards', 'units', 'events', 'revisions', 'tombstones', 'links', 'plans', 'conflicts', 'sessions'];
    await this.tx([...stores, 'media', 'settings'], 'readwrite', async (t) => {
      for (const s of stores) await t.clear(s);
      for (const s of ['decks', 'cards', 'units', 'events', 'revisions', 'tombstones', 'links', 'plans']) await t.putMany(s, dataset[s] || []);
      for (const m of dataset.media || []) if (m.data) await t.put('media', { id: m.id, type: m.type, size: m.size, name: m.name || '', createdAt: m.createdAt || Date.now(), blob: new Blob([base64ToBytes(m.data)], { type: m.type }) });
      // Synced (global) settings come from the backup; device settings
      // (sync connection, appearance on this device) stay as they are.
      if (dataset.settings?.values) await t.put('settings', { key: 'global', values: dataset.settings.values, updatedAt: dataset.settings.updatedAt || {} });
    });
    await this.rebuildSchedules();
    await this.loadSettings();
    this.emit('settings', { scope: 'global', keys: Object.keys(dataset.settings?.values || {}) });
    this.emit('decks', {});
    this.emit('cards', {});
  }

  /* ---------------- integrity ---------------- */

  /** Replay every unit and compare with stored state. */
  async verifySchedules() {
    const [units, events] = await Promise.all([this.listUnits(), this.allEvents()]);
    const byUnit = new Map();
    for (const e of events) {
      if (!e.unitId) continue;
      if (!byUnit.has(e.unitId)) byUnit.set(e.unitId, []);
      byUnit.get(e.unitId).push(e);
    }
    const mismatches = [];
    for (const u of units) {
      const replay = replayUnit(byUnit.get(u.id) || []);
      if (!statesEqual(u.state, replay.state)) mismatches.push({ unitId: u.id, stored: u.state, replayed: replay.state, headEventId: replay.headEventId });
    }
    return { checked: units.length, mismatches };
  }

  async rebuildSchedules(unitIds = null) {
    const [units, events] = await Promise.all([this.listUnits(), this.allEvents()]);
    const byUnit = new Map();
    for (const e of events) {
      if (!e.unitId) continue;
      if (!byUnit.has(e.unitId)) byUnit.set(e.unitId, []);
      byUnit.get(e.unitId).push(e);
    }
    const out = [];
    for (const u of units) {
      if (unitIds && !unitIds.includes(u.id)) continue;
      const replay = replayUnit(byUnit.get(u.id) || []);
      out.push({ ...u, state: replay.state, headEventId: replay.headEventId });
    }
    await this.tx(['units'], 'readwrite', (t) => t.putMany('units', out));
    this.emit('review', {});
    return out.length;
  }

  /* ---------------- snapshots ---------------- */

  async snapshot(reason) {
    try {
      const dump = await dumpDatabase(this.db);
      delete dump.secrets;
      return await writeSnapshot({ reason, dump });
    } catch (err) {
      console.warn('Snapshot failed', err);
      return null;
    }
  }

  listSnapshots() {
    return listSnapshots();
  }

  deleteSnapshot(id) {
    return deleteSnapshot(id);
  }

  /** Restore a snapshot (after snapshotting current state). */
  async restoreSnapshot(id) {
    const snap = await readSnapshot(id);
    if (!snap) throw new StorageError('Snapshot not found', 'not-found');
    await this.snapshot(`before restoring ${id}`);
    const names = Object.keys(STORES).filter((n) => n !== 'secrets' && n !== 'meta');
    await this.tx(names, 'readwrite', async (t) => {
      for (const n of names) {
        await t.clear(n);
        await t.putMany(n, snap.dump[n] || []);
      }
    });
    await this.loadSettings();
    this.emit('decks', {});
    this.emit('cards', {});
  }

  /* ---------------- secrets (explicit consent only) ---------------- */

  async getSecret(key) {
    return (await this.get('secrets', key))?.value ?? null;
  }

  setSecret(key, value) {
    return this.tx(['secrets'], 'readwrite', (t) => (value == null ? t.delete('secrets', key) : t.put('secrets', { key, value, storedAt: Date.now() })));
  }

  /* ---------------- storage persistence ---------------- */

  static async storageStatus() {
    const s = globalThis.navigator?.storage;
    const out = { supported: !!s, persisted: null, quota: null, usage: null };
    if (!s) return out;
    try {
      if (s.persisted) out.persisted = await s.persisted();
    } catch {
      out.persisted = null;
    }
    try {
      if (s.estimate) {
        const e = await s.estimate();
        out.quota = e.quota ?? null;
        out.usage = e.usage ?? null;
      }
    } catch {
      /* unsupported */
    }
    return out;
  }

  /** Ask the browser to protect storage from eviction. Never blocks study. */
  static async requestPersistence() {
    const s = globalThis.navigator?.storage;
    if (!s || typeof s.persist !== 'function') return { result: 'unsupported' };
    try {
      if (s.persisted && (await s.persisted())) return { result: 'granted' };
      const granted = await s.persist();
      return { result: granted ? 'granted' : 'denied' };
    } catch (err) {
      return { result: 'error', error: err?.message };
    }
  }
}

export const store = new AxonStore();
export { StorageError };
