/**
 * Study queue construction for every study mode.
 *
 * Status vocabulary (kept deliberately distinct):
 *   suspended — excluded until the user unsuspends it
 *   buried    — manually hidden until the next study day
 *   deferred  — automatically held to a later day by sibling spacing
 *   postponed — vacation/postpone overlay; FSRS due date is untouched
 * None of these change FSRS state or due dates, and none ever marks a
 * card as reviewed.
 */

import { State } from './scheduler.js';
import { shuffle, seededRandom } from './util.js';

export const LEARN_AHEAD_MS = 20 * 60 * 1000;

export function unitStatus(unit, card, { now, today, dayStart, dayEnd, learnAheadMs = LEARN_AHEAD_MS }) {
  if (!unit.active) return 'inactive';
  if (card?.suspended || unit.suspended) return 'suspended';
  const o = unit.overlays || {};
  if (o.postponedUntil && o.postponedUntil > today) return 'postponed';
  if (o.buriedUntil && o.buriedUntil > today) return 'buried';
  if (o.deferredUntil && o.deferredUntil > today) return 'deferred';
  const s = unit.state;
  if (!s || s.state === State.New) return 'new';
  if (s.state === State.Learning || s.state === State.Relearning) {
    if (s.due <= now + learnAheadMs) return 'learning-due';
    return s.due < dayEnd ? 'learning-later' : 'scheduled';
  }
  if (s.due < dayEnd) return s.due < dayStart ? 'overdue' : 'due';
  return 'scheduled';
}

/**
 * Sibling groups: units of one card share a group; manual "related"
 * links join groups (union-find) when relatedSpacing is enabled.
 */
export function siblingGroups(units, links = [], { includeLinks = true } = {}) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let c = x;
    while (parent.has(c) && parent.get(c) !== r) {
      const n = parent.get(c);
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const u of units) if (!parent.has(u.cardId)) parent.set(u.cardId, u.cardId);
  if (includeLinks) {
    for (const l of links) {
      if (!parent.has(l.a) || !parent.has(l.b)) continue;
      const ra = find(l.a);
      const rb = find(l.b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    }
  }
  const out = new Map();
  for (const u of units) out.set(u.id, find(u.cardId));
  return out;
}

/**
 * Reorder so that units of the same group are at least `gap` positions
 * apart where possible. Deterministic; order is otherwise preserved.
 */
export function spreadSiblings(list, groupOf, gap) {
  if (gap <= 0) return list.slice();
  const pending = list.slice();
  const out = [];
  while (pending.length) {
    let idx = pending.findIndex((u) => {
      const g = groupOf(u);
      for (let k = out.length - 1; k >= Math.max(0, out.length - gap); k--) if (groupOf(out[k]) === g) return false;
      return true;
    });
    if (idx < 0) idx = 0; // only siblings left; nothing better available
    out.push(pending.splice(idx, 1)[0]);
  }
  return out;
}

function interleaveNew(reviews, news, order) {
  if (order === 'before') return [...news, ...reviews];
  if (order === 'after' || !reviews.length) return [...reviews, ...news];
  const out = [];
  const step = Math.max(1, Math.floor(reviews.length / (news.length + 1)));
  let ni = 0;
  reviews.forEach((r, i) => {
    out.push(r);
    if ((i + 1) % step === 0 && ni < news.length) out.push(news[ni++]);
  });
  while (ni < news.length) out.push(news[ni++]);
  return out;
}

/**
 * Daily Review queue (and catch-up sessions).
 * @param {object} ctx
 *   units, cardsById, decksById, links, now, today, dayStart, dayEnd,
 *   introducedToday: Map(deckId → n), reviewedToday: Map(deckId → n),
 *   reviewedGroupsToday: Set(groupId), deckIds: string[]|null,
 *   catchUpLimit: number|null, catchUpOrder: 'overdue'|'retrievability',
 *   retrievabilityOf: (unit) => number|null
 */
export function buildDailyQueue(ctx) {
  const { units, cardsById, decksById, now, today, dayStart, dayEnd } = ctx;
  const deckFilter = ctx.deckIds ? new Set(ctx.deckIds) : null;
  const learning = [];
  const reviews = [];
  const newByDeck = new Map();
  const excluded = { suspended: 0, postponed: 0, buried: 0, deferred: 0, inactive: 0 };
  let overdue = 0;
  for (const u of units) {
    if (deckFilter && !deckFilter.has(u.deckId)) continue;
    const card = cardsById.get(u.cardId);
    if (!card) continue;
    const status = unitStatus(u, card, { now, today, dayStart, dayEnd });
    if (status in excluded) excluded[status]++;
    else if (status === 'learning-due') learning.push(u);
    else if (status === 'due' || status === 'overdue') {
      reviews.push(u);
      if (status === 'overdue') overdue++;
    } else if (status === 'new') {
      if (!newByDeck.has(u.deckId)) newByDeck.set(u.deckId, []);
      newByDeck.get(u.deckId).push(u);
    }
  }
  learning.sort((a, b) => a.state.due - b.state.due);
  if (ctx.catchUpOrder === 'retrievability' && ctx.retrievabilityOf) {
    reviews.sort((a, b) => (ctx.retrievabilityOf(b) ?? 0) - (ctx.retrievabilityOf(a) ?? 0) || a.state.due - b.state.due);
  } else {
    reviews.sort((a, b) => a.state.due - b.state.due || (a.id < b.id ? -1 : 1));
  }

  // Per-deck review limits
  const reviewCount = new Map();
  const limitedReviews = [];
  let backlog = 0;
  for (const u of reviews) {
    const deck = decksById.get(u.deckId);
    const limit = deck?.settings?.reviewsPerDay ?? 9999;
    const done = (ctx.reviewedToday?.get(u.deckId) || 0) + (reviewCount.get(u.deckId) || 0);
    if (done >= limit) {
      backlog++;
      continue;
    }
    reviewCount.set(u.deckId, (reviewCount.get(u.deckId) || 0) + 1);
    limitedReviews.push(u);
  }
  let chosenReviews = limitedReviews;
  if (ctx.catchUpLimit != null && chosenReviews.length > ctx.catchUpLimit) {
    backlog += chosenReviews.length - ctx.catchUpLimit;
    chosenReviews = chosenReviews.slice(0, ctx.catchUpLimit);
  }

  // Per-deck new limits; new cards in creation order
  const news = [];
  let newAvailable = 0;
  for (const [deckId, list] of newByDeck) {
    const deck = decksById.get(deckId);
    const limit = deck?.settings?.newPerDay ?? 20;
    const remaining = Math.max(0, limit - (ctx.introducedToday?.get(deckId) || 0));
    newAvailable += list.length;
    list.sort((a, b) => (cardsById.get(a.cardId)?.createdAt || 0) - (cardsById.get(b.cardId)?.createdAt || 0) || (a.id < b.id ? -1 : 1));
    news.push(...list.slice(0, ctx.catchUpLimit != null ? 0 : remaining));
  }

  const firstDeck = decksById.get(ctx.deckIds?.[0]) || decksById.values().next().value;
  const newOrder = firstDeck?.settings?.newOrder || 'mixed';
  let queue = [...learning, ...interleaveNew(chosenReviews, news, newOrder)];
  const spaced = applySiblingSpacing(queue, ctx);
  queue = spaced.queue;
  return {
    queue: queue.map((u) => u.id),
    counts: { learning: learning.length, review: chosenReviews.length, new: news.length, overdue, newAvailable },
    backlog,
    excluded,
    deferred: spaced.deferred,
  };
}

/**
 * Sibling spacing. Setting comes from the first unit's deck.
 *  'spread'  — keep siblings ≥ gap apart in the queue
 *  'nextDay' — at most one unit per sibling group per study day; the
 *              others are listed as deferred (their due dates unchanged)
 *  'off'     — no spacing
 */
export function applySiblingSpacing(queue, ctx, { override = null } = {}) {
  if (!queue.length) return { queue, deferred: [] };
  const groups = siblingGroups(ctx.units, ctx.links || [], { includeLinks: ctx.relatedSpacing !== false });
  const groupOf = (u) => groups.get(u.id) || u.cardId;
  const deck = ctx.decksById.get(queue[0].deckId);
  const mode = override || deck?.settings?.siblingSpacing || 'spread';
  const gap = deck?.settings?.siblingGap ?? 4;
  if (mode === 'off') return { queue, deferred: [] };
  if (mode === 'nextDay') {
    const seen = new Set(ctx.reviewedGroupsToday || []);
    const kept = [];
    const deferred = [];
    for (const u of queue) {
      const g = groupOf(u);
      const isLearning = u.state && (u.state.state === State.Learning || u.state.state === State.Relearning);
      if (seen.has(g) && !isLearning) deferred.push({ unitId: u.id, reason: 'sibling-next-day', group: g });
      else {
        seen.add(g);
        kept.push(u);
      }
    }
    return { queue: spreadSiblings(kept, groupOf, gap), deferred };
  }
  return { queue: spreadSiblings(queue, groupOf, gap), deferred: [] };
}

function inScope(u, card, { deckIds, tags }) {
  if (deckIds && deckIds.length && !deckIds.includes(u.deckId)) return false;
  if (tags && tags.length && !tags.some((t) => card.tags.includes(t))) return false;
  return true;
}

function activeUnits(ctx, scope) {
  const out = [];
  for (const u of ctx.units) {
    if (!u.active) continue;
    const card = ctx.cardsById.get(u.cardId);
    if (!card || card.suspended || u.suspended) continue;
    if (!inScope(u, card, scope)) continue;
    out.push(u);
  }
  return out;
}

/** Cram: any cards in scope regardless of due dates. */
export function buildCramQueue(ctx, { deckIds, tags, order = 'shuffled', includeNew = true, keepSiblingsTogether = false, limit = null, seed = String(ctx.now) }) {
  let list = activeUnits(ctx, { deckIds, tags });
  if (!includeNew) list = list.filter((u) => u.state && u.state.state !== State.New);
  if (order === 'shuffled') list = shuffle(list, seed);
  else list.sort((a, b) => (ctx.cardsById.get(a.cardId).createdAt - ctx.cardsById.get(b.cardId).createdAt) || (a.id < b.id ? -1 : 1));
  if (limit) list = list.slice(0, limit);
  const spaced = keepSiblingsTogether ? { queue: list } : applySiblingSpacing(list, ctx, { override: 'spread' });
  return { queue: spaced.queue.map((u) => u.id), deferred: [] };
}

/**
 * Weakness priority for Drill Weakest. Components are documented and
 * shown in the UI; weights are deliberately simple.
 */
export function weaknessScore(unit, { retrievability }) {
  const perf = unit.perf || { recent: [] };
  const recent = perf.recent.slice(-6);
  const failRate = recent.length ? recent.filter((r) => !r.c).length / recent.length : 0;
  const slow = recent.length ? recent.reduce((s, r) => s + Math.max(0, r.h ?? 0), 0) / recent.length : 0;
  const corrections = recent.length ? recent.reduce((s, r) => s + Math.min(3, r.k || 0), 0) / (recent.length * 3) : 0;
  const R = retrievability == null ? 0.5 : retrievability;
  const difficulty = unit.state?.difficulty ? (unit.state.difficulty - 1) / 9 : 0.5;
  const components = {
    recentFailures: 2.0 * failRate,
    lowRetrievability: 1.5 * (1 - R),
    slowRetrieval: 0.5 * Math.min(2, slow),
    corrections: 0.7 * corrections,
    difficulty: 0.8 * difficulty,
    leech: unit.leech ? 0.5 : 0,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  return { score, components };
}

export function buildDrillQueue(ctx, { deckIds, tags, limit = 20, retrievabilityOf }) {
  const list = activeUnits(ctx, { deckIds, tags }).filter((u) => u.state && u.state.state !== State.New);
  const scored = list.map((u) => ({ u, ...weaknessScore(u, { retrievability: retrievabilityOf ? retrievabilityOf(u) : null }) }));
  scored.sort((a, b) => b.score - a.score || (a.u.id < b.u.id ? -1 : 1));
  const top = scored.slice(0, limit).map((s) => s.u);
  const spaced = applySiblingSpacing(top, ctx, { override: 'spread' });
  return { queue: spaced.queue.map((u) => u.id), deferred: [], scores: new Map(scored.map((s) => [s.u.id, s])) };
}

/** Speed Practice: already-learned cards, shuffled. */
export function buildSpeedQueue(ctx, { deckIds, tags, limit = 20, seed = String(ctx.now) }) {
  const list = activeUnits(ctx, { deckIds, tags }).filter((u) => u.state && u.state.state === State.Review && u.state.reps >= 2);
  const spaced = applySiblingSpacing(shuffle(list, seed).slice(0, limit), ctx, { override: 'spread' });
  return { queue: spaced.queue.map((u) => u.id), deferred: [] };
}

/**
 * Interleaving: round-robin across the selected decks and/or tags so
 * consecutive cards come from different topics, with sibling spacing.
 */
export function buildInterleaveQueue(ctx, { deckIds = [], tags = [], limit = 30, gap = null, seed = String(ctx.now), includeNew = false }) {
  const buckets = new Map();
  const dimension = tags.length ? 'tag' : 'deck';
  for (const u of activeUnits(ctx, { deckIds, tags })) {
    if (!includeNew && (!u.state || u.state.state === State.New)) continue;
    const card = ctx.cardsById.get(u.cardId);
    const key = dimension === 'tag' ? tags.find((t) => card.tags.includes(t)) : u.deckId;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(u);
  }
  const lists = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, l], i) => shuffle(l, `${seed}|${i}|${k}`));
  const out = [];
  let idx = 0;
  while (out.length < limit && lists.some((l) => l.length)) {
    const l = lists[idx % lists.length];
    if (l.length) out.push(l.shift());
    idx++;
  }
  const groups = siblingGroups(ctx.units, ctx.links || []);
  const deck = ctx.decksById.get(out[0]?.deckId);
  const spacing = gap ?? deck?.settings?.siblingGap ?? 4;
  return { queue: spreadSiblings(out, (u) => groups.get(u.id), spacing).map((u) => u.id), deferred: [], buckets: lists.length };
}

/**
 * Postpone / vacation. Returns overlay changes; FSRS state and due
 * dates are never modified.
 *  mode 'shift'        — all affected units become available on `untilDay`
 *  mode 'redistribute' — spread them over `spreadDays` days from `untilDay`
 * Affected = units due before the start of `untilDay` (overdue, due today,
 * or falling due during the break).
 */
export function planPostpone(ctx, { untilDay, untilStart, mode = 'shift', spreadDays = 7, deckIds = null, batchId }) {
  const changes = [];
  const affected = [];
  for (const u of ctx.units) {
    if (!u.active || !u.state || u.state.state === State.New) continue;
    if (deckIds && !deckIds.includes(u.deckId)) continue;
    if (u.state.due < untilStart) affected.push(u);
  }
  affected.sort((a, b) => a.state.due - b.state.due || (a.id < b.id ? -1 : 1));
  affected.forEach((u, i) => {
    let day = untilDay;
    if (mode === 'redistribute' && spreadDays > 1) {
      const offset = Math.floor((i * spreadDays) / affected.length);
      day = addDaysLocal(untilDay, offset);
    }
    changes.push({ unitId: u.id, postponedUntil: day, batchId });
  });
  return { changes, count: affected.length };
}

function addDaysLocal(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Where to reinsert a failed card in the session queue: a few cards
 * later (never immediately), or at the end of a short queue.
 */
export function requeuePosition(queueLength, currentIndex, { minGap = 3, maxGap = 6, seed = '' } = {}) {
  const rand = seededRandom(seed)();
  const gap = minGap + Math.floor(rand * (maxGap - minGap + 1));
  return Math.min(queueLength, currentIndex + 1 + gap);
}
