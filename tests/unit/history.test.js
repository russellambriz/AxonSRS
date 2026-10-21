// Spec 17.15–17.17: concurrent same-card reviews from offline devices,
// deterministic reconstruction from merged history, clock-skew ordering,
// suspicious clocks kept for reconciliation, scheduler-version changes,
// cross-device practice exposure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, makeCard, makeUnits, review, T0, DAY, MIN } from './helpers.js';
import { replayUnit, orderEvents, detectConcurrent, effectiveHistory, statesEqual, timestampIssues, resolveCorrections, setReplayPolicy, clockConflicts, exposureSince, siblingExposureTimes, CLOCK_EVENTS_LISTED } from '../../js/core/history.js';
import { schedulerParams, applyRating } from '../../js/core/scheduler.js';

function chain() {
  const deck = makeDeck();
  const card = makeCard();
  const [u0] = makeUnits(card, deck);
  const a = review({ unit: u0, card, deck, text: 'SO4^2-', at: T0, eventId: 'a' });
  const b = review({ unit: a.unit, card, deck, text: 'SO4^2-', at: T0 + 10 * MIN, eventId: 'b' });
  return { deck, card, a, b };
}

test('replay is deterministic regardless of input order', () => {
  const { deck, card, a, b } = chain();
  const c = review({ unit: b.unit, card, deck, text: 'SO4^2-', at: T0 + 3 * DAY, eventId: 'c' });
  const events = [a.event, b.event, c.event];
  const one = replayUnit(events);
  const two = replayUnit([c.event, a.event, b.event]);
  assert.ok(statesEqual(one.state, two.state));
  assert.ok(statesEqual(one.state, c.unit.state));
});

test('historical transitions use each event’s own recorded parameters', () => {
  const { deck, card, a, b } = chain();
  const c = review({ unit: b.unit, card, deck, text: 'SO4^2-', at: T0 + 3 * DAY, eventId: 'c', params: schedulerParams({ desiredRetention: 0.8 }) });
  const replay = replayUnit([a.event, b.event, c.event]);
  assert.ok(statesEqual(replay.state, c.unit.state), 'a later retention change does not rewrite history');
  assert.equal(c.event.params.request_retention, 0.8);
});

test('concurrent offline reviews from two devices are both kept, ordered and flagged', () => {
  const { deck, card, b } = chain();
  // Both devices review from the same parent state (b) without syncing.
  const onA = review({ unit: b.unit, card, deck, text: 'SO4^2-', at: T0 + 3 * DAY, eventId: 'x-A', deviceId: 'dev-A' });
  const onB = review({ unit: b.unit, card, deck, text: 'wrong', at: T0 + 3 * DAY + 2 * 3600000, eventId: 'x-B', deviceId: 'dev-B' });
  assert.equal(onA.event.parentId, onB.event.parentId);
  const { a } = chain();
  const merged = [a.event, b.event, onB.event, onA.event];
  const replay = replayUnit(merged);
  assert.equal(replay.concurrent.length, 1);
  assert.deepEqual(replay.concurrent[0].map((e) => e.id), ['x-A', 'x-B'], 'stable chronological order');
  // Policy: chronological replay with true elapsed times — the later review
  // is a short-interval re-review, not an independent delayed recall from b.
  const sequential = review({ unit: onA.unit, card, deck, text: 'wrong', at: T0 + 3 * DAY + 2 * 3600000, eventId: 'x-B', deviceId: 'dev-B' });
  assert.ok(statesEqual(replay.state, sequential.unit.state));
  // Not "largest interval wins" and not "latest timestamp wins"
  assert.ok(!statesEqual(replay.state, onA.unit.state));
  assert.ok(!statesEqual(replay.state, onB.unit.state));
});

test('resolution keeps a chosen review by voiding the other, reversibly', () => {
  const { deck, card, a, b } = chain();
  const onA = review({ unit: b.unit, card, deck, text: 'SO4^2-', at: T0 + 3 * DAY, eventId: 'x-A', deviceId: 'dev-A' });
  const onB = review({ unit: b.unit, card, deck, text: 'wrong', at: T0 + 3 * DAY + 3600000, eventId: 'x-B', deviceId: 'dev-B' });
  const voidB = { id: 'v1', type: 'correction', kind: 'void', reason: 'conflict-resolution', targetId: 'x-B', ts: T0 + 4 * DAY, deviceId: 'dev-A', seq: 10, unitId: onB.event.unitId };
  const r = replayUnit([a.event, b.event, onA.event, onB.event, voidB]);
  assert.ok(statesEqual(r.state, onA.unit.state));
  assert.equal(r.concurrent.length, 0, 'voided events no longer count as concurrent');
  const restore = { ...voidB, id: 'v2', kind: 'restore', ts: T0 + 5 * DAY, seq: 11 };
  const r2 = replayUnit([a.event, b.event, onA.event, onB.event, voidB, restore]);
  assert.equal(r2.concurrent.length, 1);
});

test('clock skew: a child event never replays before its parent', () => {
  const { deck, card, a, b } = chain();
  // Device B's clock is 2 days behind: its review of b's result carries an earlier timestamp.
  const skewed = review({ unit: b.unit, card, deck, text: 'SO4^2-', at: T0 - 2 * DAY, eventId: 'skew', deviceId: 'dev-B' });
  const ordered = orderEvents([skewed.event, b.event, a.event]);
  assert.deepEqual(ordered.map((e) => e.id), ['a', 'b', 'skew']);
  assert.ok(ordered[2].clockRepaired);
  assert.ok(timestampIssues(skewed.event, { parent: b.event }).includes('before-parent'));
  assert.ok(timestampIssues({ ts: Date.now() + 3600000 }, {}).includes('future-timestamp'));
});

test('incoming events with implausible timestamps are flagged for reconciliation, grouped per device and issue', () => {
  const now = T0 + 10 * DAY;
  const known = [
    { id: 'p', type: 'review', ts: T0 + 5 * DAY, deviceId: 'dev-A', seq: 1, unitId: 'u1' },
    { id: 'b1', type: 'review', ts: T0 + 6 * DAY, deviceId: 'dev-B', seq: 10, unitId: 'u2' },
  ];
  const incoming = [
    { id: 'f1', type: 'review', ts: now + 3 * DAY, deviceId: 'dev-C', seq: 1, unitId: 'u3', rating: 3 },
    { id: 'f2', type: 'hint', ts: now + 3 * DAY + MIN, deviceId: 'dev-C', seq: 2, unitId: 'u3' },
    { id: 'child', type: 'review', ts: T0 + 4 * DAY, deviceId: 'dev-D', seq: 1, unitId: 'u1', parentId: 'p', rating: 3 },
    // dev-B's clock fell a day behind after b1: every later event is suspicious.
    { id: 'b2', type: 'review', ts: T0 + 5 * DAY, deviceId: 'dev-B', seq: 11, unitId: 'u2', rating: 3 },
    { id: 'b3', type: 'practice', ts: T0 + 5 * DAY + MIN, deviceId: 'dev-B', seq: 12, unitId: 'u2' },
    { id: 'b4', type: 'review', ts: T0 + 7 * DAY, deviceId: 'dev-B', seq: 13, unitId: 'u2', rating: 3 },
    { id: 'jump', type: 'review', ts: T0 + 8 * DAY, deviceId: 'dev-E', seq: 1, unitId: 'u4', rating: 3, flags: { clockAnomaly: true } },
    { id: 'fine', type: 'review', ts: T0 + 8 * DAY, deviceId: 'dev-F', seq: 1, unitId: 'u5', rating: 3 },
  ];
  const found = clockConflicts(incoming, { known, now });
  const by = Object.fromEntries(found.map((c) => [`${c.issue}|${c.deviceId}`, c.events.map((e) => e.id)]));
  assert.deepEqual(by, {
    'future-timestamp|dev-C': ['f1', 'f2'],
    'before-parent|dev-D': ['child'],
    'device-clock-went-backwards|dev-B': ['b2', 'b3'],
    'in-session-clock-jump|dev-E': ['jump'],
  });
  const future = found.find((c) => c.issue === 'future-timestamp');
  assert.equal(future.kind, 'clock');
  assert.equal(future.id, 'clock:future-timestamp:dev-C:f1', 'stable id, so a repeated merge does not duplicate it');
  assert.deepEqual(clockConflicts([], { known, now }), []);
  assert.deepEqual(clockConflicts(known, { now }), [], 'plausible history raises nothing');
  // A long-wrong clock is one bounded entry, with the full count.
  const many = Array.from({ length: CLOCK_EVENTS_LISTED + 100 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}`, type: 'review', ts: now + DAY + i, deviceId: 'dev-G', seq: i + 1, unitId: 'u6', rating: 3 }));
  const [big] = clockConflicts(many, { now });
  assert.equal(big.total, many.length);
  assert.equal(big.events.length, CLOCK_EVENTS_LISTED);
});

test('exposure since the last review is derived from every device’s events', () => {
  const practice = (id, ts) => ({ id, type: 'practice', ts, unitId: 'u1', deviceId: 'dev-B', seq: 1 });
  const events = [practice('p1', T0 + DAY), practice('p2', T0 + 3 * DAY)];
  assert.deepEqual(exposureSince(events, { lastReviewAt: T0 + 2 * DAY }), { practiceSinceLast: true, lastPracticeAt: T0 + 3 * DAY, siblingExposedAt: null });
  assert.equal(exposureSince(events, { lastReviewAt: T0 + 4 * DAY }).practiceSinceLast, false, 'a later review used it up');
  const voided = [...events, { id: 'v', type: 'correction', kind: 'void', targetId: 'p2', ts: T0 + 3 * DAY + MIN, deviceId: 'dev-B', seq: 2, unitId: 'u1' }];
  assert.equal(exposureSince(voided, { lastReviewAt: T0 + 2 * DAY }).practiceSinceLast, false, 'undone practice does not count');
  const siblings = siblingExposureTimes([
    { id: 's1', type: 'sibling-exposure', ts: T0, siblingUnitIds: ['u1', 'u2'] },
    { id: 's2', type: 'sibling-exposure', ts: T0 + DAY, siblingUnitIds: ['u2'] },
    { id: 'x', type: 'hint', ts: T0 + 2 * DAY, siblingUnitIds: ['u1'] },
  ]);
  assert.deepEqual([...siblings.entries()].sort(), [['u1', T0], ['u2', T0 + DAY]]);
});

test('ties are broken by device id, sequence and event id', () => {
  const e = (id, deviceId, seq) => ({ id, deviceId, seq, ts: 1000, type: 'review' });
  assert.deepEqual(orderEvents([e('z', 'B', 1), e('y', 'A', 2), e('x', 'A', 1)]).map((x) => x.id), ['x', 'y', 'z']);
});

test('corrections: last override wins, void/restore toggles', () => {
  const c = resolveCorrections([
    { id: '1', type: 'correction', kind: 'override', targetId: 't', newRating: 3, ts: 1, deviceId: 'a', seq: 1 },
    { id: '2', type: 'correction', kind: 'override', targetId: 't', newRating: 2, ts: 2, deviceId: 'a', seq: 2 },
    { id: '3', type: 'correction', kind: 'void', targetId: 'u', ts: 3, deviceId: 'a', seq: 3 },
  ]);
  assert.equal(c.get('t').rating, 2);
  assert.equal(c.get('u').voided, true);
  const h = effectiveHistory([{ id: 't', type: 'review', rating: 1, ts: 0, deviceId: 'a', seq: 0, params: schedulerParams() }, { id: '1', type: 'correction', kind: 'override', targetId: 't', newRating: 4, ts: 1, deviceId: 'a', seq: 1 }]);
  assert.equal(h.applied[0].rating, 4);
  assert.ok(h.applied[0].overridden);
});

test('reviews from another scheduler version keep their recorded results unless a rebuild was chosen', () => {
  const { deck, card, a, b } = chain();
  const c = review({ unit: b.unit, card, deck, text: 'SO4^2-', at: T0 + 3 * DAY, eventId: 'c' });
  // Pretend a and b were scheduled by an older engine that gave b a 40-day interval.
  const old = (e, nextState) => ({ ...e, params: { ...e.params, version: 'ts-fsrs@4 (FSRS-5) + axon-fuzz@0' }, nextState });
  const bNext = { ...b.event.nextState, due: b.event.ts + 40 * DAY, scheduled_days: 40 };
  const oldA = old(a.event, a.event.nextState);
  const oldB = old(b.event, bNext);
  const kept = replayUnit([oldA, oldB]);
  assert.deepEqual(kept.state, bNext, 'not silently recomputed with the bundled engine');
  assert.deepEqual(kept.recomputed, []);
  assert.ok(kept.steps.every((s) => s.recorded));
  // A newer review from the bundled engine replays on top of the recorded state.
  const newer = { ...c.event, prevState: bNext };
  assert.ok(statesEqual(replayUnit([oldA, oldB, newer]).state, applyRating(bNext, c.event.rating, c.event.ts, c.event.params, 'c').state));
  // A correction changes b's input, so b must be recomputed (and is reported).
  const fix = { id: 'fx', type: 'correction', kind: 'override', targetId: 'b', newRating: 2, ts: T0 + DAY, deviceId: 'dev-A', seq: 9, unitId: b.event.unitId };
  const corrected = replayUnit([oldA, oldB, fix]);
  assert.deepEqual(corrected.recomputed, ['b']);
  // After an explicit rebuild everything is recomputed with the bundled engine.
  setReplayPolicy({ recompute: true });
  try {
    const rebuilt = replayUnit([oldA, oldB]);
    assert.ok(statesEqual(rebuilt.state, b.unit.state));
  } finally {
    setReplayPolicy({ recompute: false });
  }
});

test('reset events restart a unit as new without deleting history', () => {
  const { deck, card, a, b } = chain();
  const reset = { id: 'r', type: 'reset', ts: T0 + DAY, deviceId: 'dev-A', seq: 3, unitId: a.event.unitId, parentId: 'b' };
  const r = replayUnit([a.event, b.event, reset]);
  assert.equal(r.state, null);
  assert.equal(r.headEventId, 'r');
  const after = review({ unit: { ...b.unit, state: null, headEventId: 'r' }, card, deck, text: 'SO4^2-', at: T0 + 2 * DAY, eventId: 'n' });
  assert.ok(statesEqual(replayUnit([a.event, b.event, reset, after.event]).state, after.unit.state));
  assert.equal(detectConcurrent([a.event]).length, 0);
});
