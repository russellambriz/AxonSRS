/**
 * Study-session creation and persistence helpers (between the queue
 * builders in core/queue.js and the study screen).
 */

import { app } from '../app.js';
import { store } from '../data/store.js';
import { uuid } from '../core/util.js';
import { buildDailyQueue, buildCramQueue, buildDrillQueue, buildSpeedQueue, buildInterleaveQueue } from '../core/queue.js';
import { siblingGroups } from '../core/queue.js';

export const MODES = Object.freeze({
  daily: { label: 'Daily Review', practice: false, icon: 'calendar', desc: 'Everything due today, plus new cards up to each deck’s daily limit.' },
  catchup: { label: 'Catch-up', practice: false, icon: 'refresh', desc: 'A manageable slice of an overdue backlog. Real due dates are kept for the rest.' },
  cram: { label: 'Cram', practice: true, icon: 'layers', desc: 'Any cards in a deck, regardless of due dates. Does not change the schedule by default.' },
  drill: { label: 'Drill Weakest', practice: true, icon: 'target', desc: 'Recent failures, low retrievability, slow or corrected answers, high difficulty.' },
  speed: { label: 'Speed Practice', practice: true, icon: 'zap', desc: 'Build fluent retrieval of material you already know, with an optional timer.' },
  interleave: { label: 'Interleaving', practice: true, icon: 'shuffle', desc: 'Mix topics from several decks or tags, keeping related cards apart.' },
  exam: { label: 'Exam practice', practice: true, icon: 'book', desc: 'Weak and unintroduced cards from an exam plan. Recorded as exposure.' },
});

/** Counts needed for daily limits and sibling spacing (from today's events). */
export async function todayContext() {
  const ctx = app.timeCtx();
  const events = await store.eventsForDay(ctx.today);
  const introducedToday = new Map();
  const reviewedToday = new Map();
  const reviewedGroupsToday = new Set();
  const voided = new Set(events.filter((e) => e.type === 'correction' && e.kind === 'void').map((e) => e.targetId));
  const groups = siblingGroups([...app.cache.units.values()], app.cache.links, { includeLinks: store.global.relatedSpacing !== false });
  for (const e of events) {
    if (e.type !== 'review' || voided.has(e.id)) continue;
    if (e.wasNew) introducedToday.set(e.deckId, (introducedToday.get(e.deckId) || 0) + 1);
    else reviewedToday.set(e.deckId, (reviewedToday.get(e.deckId) || 0) + 1);
    reviewedGroupsToday.add(groups.get(e.unitId) || e.cardId);
  }
  return { ...ctx, introducedToday, reviewedToday, reviewedGroupsToday, events };
}

function queueContext(extra) {
  return {
    units: [...app.cache.units.values()],
    cardsById: app.cache.cards,
    decksById: app.cache.decks,
    links: app.cache.links,
    relatedSpacing: store.global.relatedSpacing !== false,
    retrievabilityOf: (u) => app.retrievability(u),
    ...extra,
  };
}

/**
 * Create and persist a session. Returns the session record.
 * opts: { mode, deckIds, tags, order, includeNew, keepSiblingsTogether, limit, recordAsReviews, planId }
 */
export async function createSession(opts) {
  await app.cache.ensure();
  const tctx = await todayContext();
  const qctx = queueContext(tctx);
  const mode = opts.mode || 'daily';
  const deckIds = opts.deckIds && opts.deckIds.length ? opts.deckIds : null;
  let built;
  if (mode === 'daily') built = buildDailyQueue({ ...qctx, deckIds });
  else if (mode === 'catchup') built = buildDailyQueue({ ...qctx, deckIds, catchUpLimit: opts.limit || 50, catchUpOrder: opts.catchUpOrder || 'overdue' });
  else if (mode === 'cram') built = buildCramQueue(qctx, { deckIds, tags: opts.tags, order: opts.order || 'shuffled', includeNew: opts.includeNew !== false, keepSiblingsTogether: !!opts.keepSiblingsTogether, limit: opts.limit || null });
  else if (mode === 'drill') built = buildDrillQueue(qctx, { deckIds, tags: opts.tags, limit: opts.limit || 20, retrievabilityOf: qctx.retrievabilityOf });
  else if (mode === 'speed') built = buildSpeedQueue(qctx, { deckIds, tags: opts.tags, limit: opts.limit || 20 });
  else if (mode === 'interleave') built = buildInterleaveQueue(qctx, { deckIds: deckIds || [], tags: opts.tags || [], limit: opts.limit || 30, includeNew: !!opts.includeNew });
  else if (mode === 'exam') built = buildExamQueue(qctx, opts);
  else throw new Error(`Unknown mode ${mode}`);
  const practiceMode = MODES[mode]?.practice;
  const configured = store.global.practiceAffectsSchedule?.[mode];
  const live = !practiceMode || !!(opts.recordAsReviews ?? configured);
  const session = {
    id: uuid(),
    mode,
    live,
    config: { deckIds, tags: opts.tags || [], order: opts.order || null, limit: opts.limit || null, planId: opts.planId || null, timer: !!opts.timer, focusMinutes: opts.focusMinutes || null },
    queue: built.queue,
    index: 0,
    results: [],
    requeues: {},
    attempts: {},
    skipped: [],
    deferred: built.deferred || [],
    counts: built.counts || null,
    backlog: built.backlog || 0,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedDay: tctx.today,
    activeMs: 0,
    warmupPending: true,
  };
  await store.saveSession(session);
  return session;
}

function buildExamQueue(qctx, opts) {
  const plan = opts.plan;
  const scope = { deckIds: plan?.deckIds?.length ? plan.deckIds : null, tags: plan?.tags || [] };
  const drill = buildDrillQueue(qctx, { ...scope, limit: Math.ceil((opts.limit || 30) * 0.7), retrievabilityOf: qctx.retrievabilityOf });
  const fresh = buildCramQueue(qctx, { ...scope, order: 'shuffled', includeNew: true, limit: null });
  const newOnes = fresh.queue.filter((id) => !app.cache.units.get(id)?.state).slice(0, Math.max(0, (opts.limit || 30) - drill.queue.length));
  return { queue: [...drill.queue, ...newOnes], deferred: [] };
}

/** Quick start of today's review from Home/Deck screens. */
export async function startDaily(deckIds = null) {
  const s = await createSession({ mode: 'daily', deckIds });
  app.navigate(`/study/session/${s.id}`);
  return s;
}
