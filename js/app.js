/**
 * Application context shared by views: data store, sync service,
 * shortcuts, router, an in-memory cache of decks/cards/units for fast
 * rendering, and the "busy" registry used to apply app updates only at
 * safe moments.
 */

import { store } from './data/store.js';
import { SyncService } from './data/sync.js';
import { Shortcuts } from './ui/keyboard.js';
import { unitStatus } from './core/queue.js';
import { studyDayStart, studyDayEnd } from './core/time.js';
import { buildVocabulary } from './core/model.js';
import { retrievability } from './core/scheduler.js';

class DataCache {
  constructor() {
    this.decks = new Map();
    this.cards = new Map();
    this.units = new Map();
    this.unitsByCard = new Map();
    this.links = [];
    this.loaded = false;
    this.loading = null;
    this.version = 0;
    this.vocabCache = new Map();
  }

  async load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [decks, cards, units, links] = await Promise.all([store.listDecks(), store.listCards(), store.listUnits(), store.listLinks()]);
      this.decks = new Map(decks.map((d) => [d.id, d]));
      this.cards = new Map(cards.map((c) => [c.id, c]));
      this.units = new Map(units.map((u) => [u.id, u]));
      this.unitsByCard = new Map();
      for (const u of units) {
        const list = this.unitsByCard.get(u.cardId);
        if (list) list.push(u);
        else this.unitsByCard.set(u.cardId, [u]);
      }
      this.links = links;
      this.loaded = true;
      this.version++;
      this.vocabCache.clear();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async ensure() {
    if (!this.loaded) await this.load();
  }

  unitsOfCard(cardId) {
    return this.unitsByCard?.get(cardId) || [];
  }

  vocabulary(deckId) {
    if (!this.vocabCache.has(deckId)) {
      const cards = [...this.cards.values()].filter((c) => c.deckId === deckId);
      this.vocabCache.set(deckId, buildVocabulary(cards));
    }
    return this.vocabCache.get(deckId);
  }

  allTags() {
    const tags = new Map();
    for (const c of this.cards.values()) for (const t of c.tags) tags.set(t, (tags.get(t) || 0) + 1);
    return [...tags.entries()].sort((a, b) => b[1] - a[1]);
  }
}

export const app = {
  store,
  sync: new SyncService(store),
  shortcuts: null,
  router: null,
  cache: new DataCache(),
  busy: new Map(),
  pendingUpdate: null,
  studyLock: null,

  init() {
    this.shortcuts = new Shortcuts();
    this.shortcuts.setOverrides(store.global.shortcuts || {});
    let timer = null;
    store.on((type) => {
      if (['decks', 'cards', 'units', 'review', 'links'].includes(type)) {
        clearTimeout(timer);
        timer = setTimeout(() => this.cache.load().then(() => this.emitChange()), 30);
        this.sync.schedule();
      }
      if (type === 'settings') this.shortcuts.setOverrides(store.global.shortcuts || {});
    });
  },

  changeListeners: new Set(),
  onChange(fn) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  },
  emitChange() {
    for (const fn of this.changeListeners) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  },

  /** Mark the app busy (unanswered card, import, pending write…). */
  setBusy(key, reason) {
    if (reason) this.busy.set(key, reason);
    else this.busy.delete(key);
    if (!this.busy.size && this.pendingUpdate?.autoWhenIdle) this.pendingUpdate.apply();
  },

  isBusy() {
    return this.busy.size > 0;
  },

  timeCtx(now = Date.now()) {
    const opts = store.timeOptions();
    const today = store.today(now);
    return { now, today, dayStart: studyDayStart(today, opts), dayEnd: studyDayEnd(today, opts), ...opts };
  },

  /** Due/new/learning counts per deck (and total) from the cache. */
  counts({ deckId = null } = {}) {
    const ctx = this.timeCtx();
    const out = { total: 0, due: 0, overdue: 0, learning: 0, newAvailable: 0, suspended: 0, postponed: 0, buried: 0, cards: 0, leeches: 0 };
    for (const u of this.cache.units.values()) {
      if (deckId && u.deckId !== deckId) continue;
      const card = this.cache.cards.get(u.cardId);
      if (!card) continue;
      const st = unitStatus(u, card, ctx);
      if (st === 'inactive') continue;
      out.total++;
      if (u.leech) out.leeches++;
      if (st === 'due' || st === 'overdue') out.due++;
      if (st === 'overdue') out.overdue++;
      if (st === 'learning-due' || st === 'learning-later') out.learning++;
      if (st === 'new') out.newAvailable++;
      if (st === 'suspended') out.suspended++;
      if (st === 'postponed') out.postponed++;
      if (st === 'buried' || st === 'deferred') out.buried++;
    }
    for (const c of this.cache.cards.values()) if (!deckId || c.deckId === deckId) out.cards++;
    return out;
  },

  /** New cards still available today for a deck (limit minus introduced). */
  newToday(deck, introducedToday) {
    const limit = deck.settings?.newPerDay ?? 20;
    return Math.max(0, limit - (introducedToday.get(deck.id) || 0));
  },

  retrievability(unit, now = Date.now()) {
    const deck = this.cache.decks.get(unit.deckId);
    return retrievability(unit.state, now, store.paramsFor(deck));
  },

  navigate(path) {
    this.router.navigate(path);
  },
};
