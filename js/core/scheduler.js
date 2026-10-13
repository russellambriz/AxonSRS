/**
 * Layer A — FSRS memory scheduling.
 *
 * Wraps the pinned ts-fsrs 5.4.2 implementation (FSRS-6). All FSRS state
 * changes go through `applyRating`; nothing else in Axon edits stability,
 * difficulty or due dates directly.
 *
 * Interval fuzz: ts-fsrs ships its own fuzz (enable_fuzz). Axon disables
 * it and applies its own deterministic, retention-bounded fuzz exactly
 * once, so the variation is reproducible from the review-event id during
 * history replay (see `fuzzInterval`).
 */

import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  State,
  default_w,
  forgetting_curve,
  get_fuzz_range,
} from '../../vendor/ts-fsrs/index.mjs';
import { FSRS_LIBRARY, FUZZ_VERSION, SCHEDULER_VERSION } from '../config.js';
import { seededRandom, stableStringify, hashHex } from './util.js';

export const RATING = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });
export const RATING_NAMES = Object.freeze({ 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' });
export const RATING_LABELS = Object.freeze({ 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' });
export const STATE_NAMES = Object.freeze({ 0: 'new', 1: 'learning', 2: 'review', 3: 'relearning' });

const DAY = 86400000;

/** Fuzz bounds: only intervals strictly longer than this are fuzzed. */
export const FUZZ_MIN_INTERVAL = 7;
/**
 * Retention safety: the fuzzed interval may not lower predicted
 * retrievability at the due date by more than this many percentage
 * points below the desired retention.
 */
export const FUZZ_MAX_RETENTION_DROP = 0.02;

/**
 * Build the parameter snapshot recorded with every review so the
 * transition can be reproduced later even if settings change.
 */
export function schedulerParams({
  desiredRetention = 0.9,
  learningSteps = ['1m', '10m'],
  relearningSteps = ['10m'],
  maximumInterval = 36500,
  w = default_w,
  fuzz = true,
} = {}) {
  return {
    library: FSRS_LIBRARY,
    version: SCHEDULER_VERSION,
    w: [...w],
    request_retention: desiredRetention,
    maximum_interval: maximumInterval,
    enable_short_term: true,
    learning_steps: [...learningSteps],
    relearning_steps: [...relearningSteps],
    enable_fuzz: false,
    axonFuzz: fuzz ? { version: FUZZ_VERSION, minInterval: FUZZ_MIN_INTERVAL, maxRetentionDrop: FUZZ_MAX_RETENTION_DROP } : null,
  };
}

const schedulerCache = new Map();
function schedulerFor(params) {
  const key = hashHex(stableStringify(params));
  let f = schedulerCache.get(key);
  if (!f) {
    f = fsrs(generatorParameters({
      w: params.w,
      request_retention: params.request_retention,
      maximum_interval: params.maximum_interval,
      enable_fuzz: false,
      enable_short_term: params.enable_short_term,
      learning_steps: params.learning_steps,
      relearning_steps: params.relearning_steps,
    }));
    if (schedulerCache.size > 50) schedulerCache.clear();
    schedulerCache.set(key, f);
  }
  return f;
}

/** Serialised FSRS state (dates as epoch ms) as stored on a unit. */
export function emptyState(at = Date.now()) {
  return serialize(createEmptyCard(new Date(at)));
}

export function serialize(card) {
  return {
    due: +card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? +card.last_review : null,
  };
}

export function deserialize(state) {
  return {
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsed_days,
    scheduled_days: state.scheduled_days,
    learning_steps: state.learning_steps ?? 0,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    last_review: state.last_review ? new Date(state.last_review) : undefined,
  };
}

/** Predicted retrievability at time `at` (0..1). New cards return null. */
export function retrievability(state, at, params) {
  if (!state || state.state === State.New) return null;
  return schedulerFor(params).get_retrievability(deserialize(state), new Date(at), false);
}

/**
 * Deterministic, retention-bounded fuzz.
 * Base range: ts-fsrs/Anki fuzz ranges (±(1 + 15% of 2.5–7d + 10% of 7–20d + 5% beyond)).
 * Upper bound additionally capped so R(due) ≥ desiredRetention − maxRetentionDrop.
 */
export function fuzzInterval({ interval, elapsedDays, stability, params, seed }) {
  const cfg = params.axonFuzz;
  if (!cfg || interval <= cfg.minInterval) return { applied: false, original: interval, chosen: interval };
  const range = get_fuzz_range(interval, elapsedDays, params.maximum_interval);
  let lo = Math.max(range.min_ivl, cfg.minInterval + 1);
  let hi = range.max_ivl;
  const floorR = params.request_retention - cfg.maxRetentionDrop;
  while (hi > interval && forgetting_curve(params.w, hi, stability) < floorR) hi--;
  lo = Math.min(lo, interval);
  hi = Math.max(hi, interval);
  const rand = seededRandom(`${FUZZ_VERSION}|${seed}`)();
  const chosen = Math.floor(rand * (hi - lo + 1)) + lo;
  return { applied: true, original: interval, chosen, min: lo, max: hi, seed: String(seed), version: cfg.version, random: rand };
}

/**
 * Apply one FSRS rating. Returns the new state and a transition record.
 * @param {object|null} state serialised previous state (null → new)
 * @param {1|2|3|4} rating
 * @param {number} at review time (epoch ms)
 * @param {object} params from schedulerParams()
 * @param {string} seed stable seed for fuzz (the review event id)
 */
export function applyRating(state, rating, at, params, seed) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error(`Invalid FSRS rating ${rating}`);
  const f = schedulerFor(params);
  const prev = state ? deserialize(state) : createEmptyCard(new Date(at));
  const { card } = f.next(prev, new Date(at), rating);
  let next = serialize(card);
  let interval = { applied: false, original: next.scheduled_days, chosen: next.scheduled_days };
  if (next.state === State.Review && next.scheduled_days > 0) {
    interval = fuzzInterval({
      interval: next.scheduled_days,
      elapsedDays: next.elapsed_days,
      stability: next.stability,
      params,
      seed,
    });
    if (interval.applied && interval.chosen !== interval.original) {
      next = { ...next, scheduled_days: interval.chosen, due: next.due + (interval.chosen - interval.original) * DAY };
    }
  }
  return {
    state: next,
    transition: {
      schedulerVersion: params.version,
      rating,
      fromState: prev.state,
      toState: next.state,
      originalIntervalDays: interval.original,
      chosenIntervalDays: interval.chosen,
      fuzz: interval.applied ? { min: interval.min, max: interval.max, seed: interval.seed, version: interval.version } : null,
      due: next.due,
    },
  };
}

/** Intervals each rating would produce (manual grading buttons). Fuzz excluded. */
export function previewRatings(state, at, params) {
  const f = schedulerFor(params);
  const prev = state ? deserialize(state) : createEmptyCard(new Date(at));
  const out = {};
  for (const r of [1, 2, 3, 4]) {
    const { card } = f.next(prev, new Date(at), r);
    out[r] = { due: +card.due, days: (+card.due - at) / DAY, state: card.state };
  }
  return out;
}

export function isNew(state) {
  return !state || state.state === State.New;
}

export function isLearning(state) {
  return !!state && (state.state === State.Learning || state.state === State.Relearning);
}

export function isReview(state) {
  return !!state && state.state === State.Review;
}

export { State };
