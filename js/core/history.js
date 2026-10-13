/**
 * Authoritative review history and deterministic schedule reconstruction.
 *
 * Review events are immutable facts. Corrections (overrides, undo voids,
 * conflict resolutions) are separate events that point at a review. A
 * unit's FSRS state is *derived*: replaying its effective history through
 * the scheduler must reproduce it, and can rebuild it after a merge.
 *
 * Replay ordering (stable across devices):
 *   1. effective timestamp — the event's wall-clock ts, raised to just
 *      after its parent's when a skewed clock would otherwise place it
 *      before the review it was based on (causal repair);
 *   2. deviceId, 3. per-device sequence number, 4. event id.
 *
 * Concurrent reviews (two devices reviewing the same unit from the same
 * parent state while offline) are all preserved. Policy: replay them in
 * the order above with their true elapsed times — the later one is
 * therefore a short-interval re-review of the earlier, not an independent
 * delayed recall from the shared parent — and flag the group so the user
 * can keep both, keep only the earliest, or keep only the latest. Never
 * "latest timestamp wins" and never "largest interval wins".
 */

import { applyRating } from './scheduler.js';

/** Events that change FSRS state when replayed. 'reset' returns a unit to New. */
export const SCHEDULING_TYPES = new Set(['review', 'reset']);
export const CLOCK_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export function compareOrder(a, b) {
  const ta = a._orderTs ?? a.ts;
  const tb = b._orderTs ?? b.ts;
  if (ta !== tb) return ta - tb;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if ((a.seq ?? 0) !== (b.seq ?? 0)) return (a.seq ?? 0) - (b.seq ?? 0);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sort events deterministically with causal repair. Returns copies with
 * `_orderTs` and `clockRepaired` set where a parent forced reordering.
 */
export function orderEvents(events) {
  const byId = new Map(events.map((e) => [e.id, { ...e, _orderTs: e.ts }]));
  // Iteratively raise children above their parents (bounded passes).
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const e of byId.values()) {
      const parent = e.parentId ? byId.get(e.parentId) : null;
      if (parent && e._orderTs <= parent._orderTs) {
        e._orderTs = parent._orderTs + 1;
        e.clockRepaired = true;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return [...byId.values()].sort(compareOrder);
}

/**
 * Resolve corrections for a set of target events.
 * Returns Map targetId → { voided, rating, overrides: [...], lastCorrection }.
 */
export function resolveCorrections(corrections) {
  const ordered = orderEvents(corrections);
  const out = new Map();
  for (const c of ordered) {
    const entry = out.get(c.targetId) || { voided: false, rating: null, overrides: [], voidReason: null };
    if (c.kind === 'void') {
      entry.voided = true;
      entry.voidReason = c.reason || 'undo';
    } else if (c.kind === 'restore') {
      entry.voided = false;
      entry.voidReason = null;
    } else if (c.kind === 'override') {
      entry.rating = c.newRating;
      entry.overrides.push(c);
    }
    entry.lastCorrection = c;
    out.set(c.targetId, entry);
  }
  return out;
}

/**
 * Effective scheduling history for one unit.
 * @param {object[]} events all events of the unit (any type)
 * @returns {{ applied: object[], voided: object[], concurrent: object[][] }}
 */
export function effectiveHistory(events) {
  const reviews = events.filter((e) => SCHEDULING_TYPES.has(e.type));
  const corrections = events.filter((e) => e.type === 'correction');
  const resolved = resolveCorrections(corrections);
  const applied = [];
  const voided = [];
  for (const e of orderEvents(reviews)) {
    const r = resolved.get(e.id);
    if (r && r.voided) {
      voided.push({ event: e, reason: r.voidReason });
      continue;
    }
    applied.push({ event: e, rating: r && r.rating ? r.rating : e.rating, overridden: !!(r && r.rating), corrections: r ? r.overrides : [] });
  }
  return { applied, voided, concurrent: detectConcurrent(applied.map((a) => a.event).filter((e) => e.type === 'review')) };
}

/** Groups of non-voided reviews from different devices sharing one parent. */
export function detectConcurrent(reviews) {
  const groups = new Map();
  for (const e of reviews) {
    const key = e.parentId || '(initial)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length > 1 && new Set(list.map((e) => e.deviceId)).size > 1) out.push(list.slice().sort(compareOrder));
  }
  return out;
}

/**
 * Rebuild a unit's FSRS state from its events.
 * Each event's own recorded parameters are used, so historical
 * transitions are reproduced even after settings or defaults change.
 */
export function replayUnit(events) {
  const { applied, voided, concurrent } = effectiveHistory(events);
  let state = null;
  const steps = [];
  for (const item of applied) {
    const e = item.event;
    if (e.type === 'reset') {
      steps.push({ eventId: e.id, rating: null, prev: state, next: null, transition: { reset: true } });
      state = null;
      continue;
    }
    const { state: next, transition } = applyRating(state, item.rating, e.ts, e.params, e.id);
    steps.push({ eventId: e.id, rating: item.rating, prev: state, next, transition });
    state = next;
  }
  return {
    state,
    headEventId: applied.length ? applied[applied.length - 1].event.id : null,
    steps,
    applied,
    voided,
    concurrent,
  };
}

/** Compare a stored unit state with the replayed state. */
export function statesEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const keys = ['due', 'state', 'reps', 'lapses', 'scheduled_days', 'learning_steps', 'last_review'];
  for (const k of keys) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return Math.abs(a.stability - b.stability) < 1e-6 && Math.abs(a.difficulty - b.difficulty) < 1e-6;
}

/**
 * Flag implausible timestamps for reconciliation. `now` is the
 * receiving device's clock.
 */
export function timestampIssues(event, { now = Date.now(), parent = null, previousFromDevice = null } = {}) {
  const issues = [];
  if (event.ts > now + CLOCK_FUTURE_TOLERANCE_MS) issues.push('future-timestamp');
  if (parent && event.ts < parent.ts) issues.push('before-parent');
  if (previousFromDevice && event.seq > previousFromDevice.seq && event.ts < previousFromDevice.ts - CLOCK_FUTURE_TOLERANCE_MS) issues.push('device-clock-went-backwards');
  if (event.flags?.clockAnomaly) issues.push('in-session-clock-jump');
  return issues;
}
