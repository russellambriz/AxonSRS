// Spec 12.9 and 17.6: FSRS state transitions and intervals against
// reference cases for the pinned version; deterministic fuzz applied once
// and within documented bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyRating, schedulerParams, fuzzInterval, retrievability, previewRatings, emptyState, FUZZ_MIN_INTERVAL, FUZZ_MAX_RETENTION_DROP } from '../../js/core/scheduler.js';
import { forgetting_curve, get_fuzz_range, default_w } from '../../vendor/ts-fsrs/index.mjs';

const ref = JSON.parse(readFileSync(new URL('../fixtures/fsrs-reference.json', import.meta.url), 'utf8'));
const DAY = 86400000;

test('matches py-fsrs 6.3.2 reference cases (stability, difficulty, state, due)', () => {
  const params = schedulerParams({ fuzz: false });
  for (const c of ref.cases) {
    let st = null;
    c.steps.forEach((s, i) => {
      const { state } = applyRating(st, s.rating, s.at, params, 'seed');
      st = state;
      const label = `${c.name} step ${i + 1}`;
      assert.equal(st.state, s.state, `${label} state`);
      assert.ok(Math.abs(st.stability - s.stability) < 1e-4, `${label} stability ${st.stability} vs ${s.stability}`);
      assert.ok(Math.abs(st.difficulty - s.difficulty) < 1e-4, `${label} difficulty`);
      // Learning-step timing for "Hard" differs by minutes between implementations;
      // review-state due dates must agree exactly.
      const tol = st.state === 2 ? 1000 : 10 * 60000;
      assert.ok(Math.abs(st.due - s.due) <= tol, `${label} due off by ${(st.due - s.due) / 60000} min`);
    });
  }
});

test('the pinned library fuzz is disabled; Axon fuzz is applied exactly once', () => {
  const params = schedulerParams();
  assert.equal(params.enable_fuzz, false);
  // Apply the same rating twice with the same seed → identical results
  const t0 = Date.UTC(2026, 0, 1, 12);
  let st = null;
  for (const [r, d] of [[3, 0], [3, 10 / 1440], [3, 1], [3, 5], [3, 20]]) st = applyRating(st, r, t0 + d * DAY, params, 'x').state;
  const at = t0 + 70 * DAY;
  const a = applyRating(st, 3, at, params, 'event-123');
  const b = applyRating(st, 3, at, params, 'event-123');
  assert.deepEqual(a, b, 'deterministic for a given event id');
  const t = a.transition;
  assert.ok(t.originalIntervalDays > FUZZ_MIN_INTERVAL);
  assert.ok(t.fuzz, 'fuzz recorded for long intervals');
  assert.equal(a.state.scheduled_days, t.chosenIntervalDays);
  // due reflects the chosen interval exactly once
  const unfuzzed = applyRating(st, 3, at, schedulerParams({ fuzz: false }), 'event-123');
  assert.equal(unfuzzed.state.scheduled_days, t.originalIntervalDays);
  assert.equal(a.state.due - unfuzzed.state.due, (t.chosenIntervalDays - t.originalIntervalDays) * DAY);
});

test('fuzz bounds: only intervals > 7 days, within the documented range and retention-safe', () => {
  const params = schedulerParams({ desiredRetention: 0.9 });
  assert.equal(fuzzInterval({ interval: 7, elapsedDays: 3, stability: 7, params, seed: 's' }).applied, false);
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const interval = 8 + (i % 120);
    const stability = interval * 1.02;
    const f = fuzzInterval({ interval, elapsedDays: Math.floor(interval / 2), stability, params, seed: `s${i}` });
    assert.ok(f.applied);
    const range = get_fuzz_range(interval, Math.floor(interval / 2), params.maximum_interval);
    assert.ok(f.chosen >= Math.min(range.min_ivl, interval) && f.chosen <= range.max_ivl, `within base range for ${interval}`);
    assert.ok(f.chosen >= f.min && f.chosen <= f.max);
    assert.ok(f.chosen > FUZZ_MIN_INTERVAL);
    if (f.chosen > interval) {
      assert.ok(forgetting_curve(default_w, f.chosen, stability) >= params.request_retention - FUZZ_MAX_RETENTION_DROP - 1e-9, 'retention-safe upper bound');
    }
    seen.add(f.chosen - interval);
  }
  assert.ok(seen.size > 3, 'fuzz actually spreads intervals');
});

test('fuzz spreads a batch of identical new cards across several days', () => {
  const params = schedulerParams();
  const t0 = Date.UTC(2026, 2, 1, 9);
  const dues = new Set();
  for (let i = 0; i < 50; i++) {
    let st = applyRating(null, 4, t0, params, `a${i}`).state; // Easy
    st = applyRating(st, 4, t0 + st.scheduled_days * DAY, params, `b${i}`).state;
    dues.add(Math.round(st.due / DAY));
  }
  assert.ok(dues.size >= 3, `expected spread, got ${dues.size} distinct days`);
});

test('state transitions: Again on a review card relearns and counts a lapse', () => {
  const params = schedulerParams({ fuzz: false });
  const t0 = Date.UTC(2026, 0, 1);
  let st = applyRating(null, 3, t0, params, 'a').state;
  st = applyRating(st, 3, t0 + 10 * 60000, params, 'b').state;
  assert.equal(st.state, 2);
  const lapse = applyRating(st, 1, st.due, params, 'c');
  assert.equal(lapse.state.state, 3);
  assert.equal(lapse.state.lapses, 1);
  assert.equal(lapse.transition.fromState, 2);
  assert.ok(lapse.state.due - st.due <= 15 * 60000, 'relearning step of ~10 minutes');
});

test('retrievability and previews', () => {
  const params = schedulerParams({ fuzz: false });
  assert.equal(retrievability(emptyState(0), 0, params), null);
  const t0 = Date.UTC(2026, 0, 1);
  let st = applyRating(null, 3, t0, params, 'a').state;
  st = applyRating(st, 3, t0 + 600000, params, 'b').state;
  const r = retrievability(st, st.due, params);
  assert.ok(r > 0.85 && r < 0.95, `≈ desired retention at due (${r})`);
  const p = previewRatings(st, st.due, params);
  assert.ok(p[1].days < p[2].days && p[2].days < p[3].days && p[3].days < p[4].days);
  assert.throws(() => applyRating(st, 5, t0, params, 'x'));
});

test('desired retention changes intervals for future reviews only', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const p90 = schedulerParams({ desiredRetention: 0.9, fuzz: false });
  const p80 = schedulerParams({ desiredRetention: 0.8, fuzz: false });
  let st = applyRating(null, 3, t0, p90, 'a').state;
  st = applyRating(st, 3, t0 + 600000, p90, 'b').state;
  const later = st.due;
  assert.ok(applyRating(st, 3, later, p80, 'c').state.scheduled_days > applyRating(st, 3, later, p90, 'c').state.scheduled_days);
});
