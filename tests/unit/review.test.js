// Spec 12.8, 12.10, 12.11, 17.11, 17.12, 17.21: wrong answers and event
// recording, independent forward/reverse scheduling, cram without
// scheduled reviews, alias rescue applied exactly once, undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, makeCard, makeUnits, review, T0, DAY, MIN } from './helpers.js';
import { planOverride, planUndo, evaluateAnswer, exposureEvent } from '../../js/core/review.js';
import { replayUnit, statesEqual } from '../../js/core/history.js';
import { addAlias } from '../../js/core/aliases.js';
import { State } from '../../js/core/scheduler.js';

test('a wrong answer records Again with the full response, diagnostics and measurements, and requeues', () => {
  const deck = makeDeck();
  const card = makeCard();
  const [unit] = makeUnits(card, deck);
  const p = review({ unit, card, deck, text: 'SO4^2+', at: T0 });
  assert.equal(p.event.type, 'review');
  assert.equal(p.event.rating, 1);
  assert.equal(p.event.response.correct, false);
  assert.ok(p.event.response.diagnostics.includes('charge-sign'));
  assert.equal(p.event.response.text, 'SO4^2+');
  assert.ok(p.event.grading.measurements.raw.latencyMs > 0);
  assert.ok(p.event.prevState === null && p.event.params && p.event.transition);
  assert.equal(p.requeue, true);
  assert.equal(p.calibration, null, 'incorrect answers never calibrate');
  assert.equal(p.unit.state.state, State.Learning);
});

test('correct answers update FSRS state through the scheduler only and are replayable', () => {
  const deck = makeDeck();
  const card = makeCard();
  let [unit] = makeUnits(card, deck);
  const events = [];
  for (const [i, at] of [T0, T0 + 10 * MIN, T0 + 2 * DAY].entries()) {
    const p = review({ unit, card, deck, text: 'SO₄²⁻', at, eventId: `e${i}` });
    assert.equal(p.event.response.correct, true);
    assert.equal(p.event.parentId, unit.headEventId || null);
    events.push(p.event);
    unit = p.unit;
  }
  const replay = replayUnit(events);
  assert.ok(statesEqual(replay.state, unit.state), 'stored state equals replayed state');
  assert.equal(replay.headEventId, 'e2');
});

test('forward and reverse directions keep independent schedules', () => {
  const deck = makeDeck({ direction: 'both' });
  const card = makeCard({ answerMode: 'text', front: 'Sulfate', back: 'SO4^2-' });
  const units = makeUnits(card, deck);
  assert.deepEqual(units.map((u) => u.key), ['fwd', 'rev']);
  const [fwd, rev] = units;
  const f = review({ unit: fwd, card, deck, text: 'SO4^2-', at: T0 });
  assert.equal(f.unit.state.state, State.Learning);
  // Reverse is untouched by the forward review
  assert.equal(rev.state, null);
  const r = review({ unit: rev, card, deck, text: 'Sulfate', at: T0 + MIN });
  assert.equal(r.event.response.correct, true);
  assert.notEqual(f.event.unitId, r.event.unitId);
  // Reverse expects the front as answer
  assert.equal(evaluateAnswer(card, deck, 'rev', 'SO4^2-').correct, false);
});

test('cram (practice) records exposure but never changes the schedule', () => {
  const deck = makeDeck();
  const card = makeCard();
  let [unit] = makeUnits(card, deck);
  const a = review({ unit, card, deck, text: 'SO4^2-', at: T0 });
  unit = a.unit;
  const before = structuredClone(unit.state);
  const p = review({ unit, card, deck, text: 'SO4^2-', at: T0 + DAY, live: false, mode: 'cram' });
  assert.equal(p.event.type, 'practice');
  assert.deepEqual(p.unit.state, before);
  assert.equal(p.unit.headEventId, unit.headEventId);
  assert.equal(p.unit.practiceSinceLast, true);
  assert.equal(p.event.params, undefined, 'practice carries no scheduling transition');
  // Replay ignores practice
  assert.ok(statesEqual(replayUnit([a.event, p.event]).state, before));
  // The next scheduled review is flagged as affected by practice
  const next = review({ unit: p.unit, card, deck, text: 'SO4^2-', at: T0 + 3 * DAY });
  assert.equal(next.event.flags.practiceSinceLast, true);
});

test('alias rescue replaces the failed review effect exactly once and keeps the override visible', () => {
  const deck = makeDeck({ answerMode: 'text' });
  const card = makeCard({ answerMode: 'text', front: 'Largest planet', back: 'Jupiter' });
  const [unit0] = makeUnits(card, deck);
  const warm = review({ unit: unit0, card, deck, text: 'Jupiter', at: T0, eventId: 'w1' });
  const warm2 = review({ unit: warm.unit, card, deck, text: 'Jupiter', at: T0 + 10 * MIN, eventId: 'w2' });
  const failed = review({ unit: warm2.unit, card, deck, text: 'Iuppiter', at: T0 + 3 * DAY, eventId: 'f1' });
  assert.equal(failed.event.rating, 1);
  const events = [warm.event, warm2.event, failed.event];
  const rescue = planOverride({ eventId: 'o1', now: T0 + 3 * DAY + 5000, deviceId: 'dev-A', seq: 9, target: failed.event, kind: 'alias', unit: failed.unit, unitEvents: events, alias: 'Iuppiter', studyDay: '2026-01-08' });
  assert.equal(rescue.event.type, 'correction');
  assert.equal(rescue.event.newRating, 3);
  assert.equal(rescue.event.reason, 'alias');
  assert.equal(rescue.event.measurementsFrom, 'f1', 'uses the original measurements, not the rescue time');
  // The resulting state equals reviewing Good at the original time — not Again then Good.
  const good = review({ unit: warm2.unit, card, deck, text: 'Jupiter', at: T0 + 3 * DAY, eventId: 'f1' });
  assert.ok(statesEqual(rescue.unit.state, good.unit.state));
  assert.equal(rescue.unit.state.lapses, 0, 'no lapse remains');
  // Applying the same correction again (retry) is idempotent in replay
  const twice = replayUnit([...events, rescue.event, rescue.event]);
  assert.ok(statesEqual(twice.state, rescue.unit.state));
  // The alias is now accepted
  const updated = { ...card, back: addAlias(card.back, 'Iuppiter') };
  assert.ok(evaluateAnswer(updated, deck, 'fwd', 'Iuppiter').correct);
});

test('“I knew that” and “I guessed” are explicit overrides', () => {
  const deck = makeDeck();
  const card = makeCard();
  const [unit] = makeUnits(card, deck);
  const p = review({ unit, card, deck, text: 'SO4^2-', at: T0, eventId: 'k1' });
  const knew = planOverride({ eventId: 'o2', now: T0 + 1000, deviceId: 'dev-A', seq: 2, target: p.event, kind: 'knew', unit: p.unit, unitEvents: [p.event], studyDay: '2026-01-05' });
  assert.ok(knew.event.newRating >= 3);
  assert.deepEqual(knew.event.reasons, ['OVERRIDE_KNEW']);
  const guessed = planOverride({ eventId: 'o3', now: T0 + 1000, deviceId: 'dev-A', seq: 3, target: p.event, kind: 'guessed', unit: p.unit, unitEvents: [p.event], studyDay: '2026-01-05' });
  assert.ok(guessed.event.newRating <= 2);
});

test('undo reverses scheduling exactly, including after later reviews on another device', () => {
  const deck = makeDeck();
  const card = makeCard();
  const [u0] = makeUnits(card, deck);
  const a = review({ unit: u0, card, deck, text: 'SO4^2-', at: T0, eventId: 'a' });
  const b = review({ unit: a.unit, card, deck, text: 'SO4^2-', at: T0 + 10 * MIN, eventId: 'b' });
  const c = review({ unit: b.unit, card, deck, text: 'wrong', at: T0 + 2 * DAY, eventId: 'c' });
  // Undo the last review → state equals state after b
  const undo = planUndo({ eventId: 'u1', now: T0 + 2 * DAY + 1000, deviceId: 'dev-A', seq: 5, target: c.event, unit: c.unit, unitEvents: [a.event, b.event, c.event], studyDay: '2026-01-07' });
  assert.ok(statesEqual(undo.unit.state, b.unit.state));
  assert.equal(undo.unit.headEventId, 'b');
  // Undo of an earlier review when a newer (synced) review depends on it:
  // replay through the scheduler, not by restoring an old snapshot.
  const d = review({ unit: c.unit, card, deck, text: 'SO4^2-', at: T0 + 5 * DAY, eventId: 'd', deviceId: 'dev-B' });
  const undoB = planUndo({ eventId: 'u2', now: T0 + 6 * DAY, deviceId: 'dev-A', seq: 6, target: b.event, unit: d.unit, unitEvents: [a.event, b.event, c.event, d.event], studyDay: '2026-01-11' });
  const expected = replayUnit([a.event, c.event, d.event]);
  assert.ok(statesEqual(undoB.unit.state, expected.state));
  assert.equal(undoB.unit.headEventId, 'd');
});

test('manual grading uses the chosen rating and keeps Axon’s grade as a shadow', () => {
  const deck = makeDeck();
  const card = makeCard();
  const [unit] = makeUnits(card, deck);
  const p = review({ unit, card, deck, text: 'SO4^2-', at: T0, gradeMode: 'manual', manualRating: 4 });
  assert.equal(p.event.rating, 4);
  assert.equal(p.event.grading.mode, 'manual');
  assert.equal(p.event.grading.shadowGrade, 3);
  assert.throws(() => review({ unit, card, deck, text: 'x', at: T0, gradeMode: 'manual' }));
});

test('exposure events are typed separately and never carry schedule effects', () => {
  const card = makeCard();
  const [unit] = makeUnits(card, makeDeck());
  for (const type of ['hint', 'reveal', 'copy', 'sibling-exposure', 'edit', 'skip', 'abandon']) {
    const e = exposureEvent({ id: type, type, now: T0, deviceId: 'dev-A', seq: 1, unit, card, sessionId: 's', studyDay: '2026-01-05' });
    assert.equal(e.type, type);
    assert.equal(e.rating, undefined);
  }
  assert.ok(statesEqual(replayUnit([exposureEvent({ id: 'x', type: 'copy', now: T0, deviceId: 'd', seq: 1, unit, card, sessionId: 's', studyDay: 'x' })]).state, null));
});

test('leech detection flags (and optionally suspends) repeatedly failing hard cards', () => {
  const deck = makeDeck({ leechThreshold: 3, leechAction: 'suspend' });
  const card = makeCard();
  let [unit] = makeUnits(card, deck);
  let at = T0;
  const step = (text, id) => {
    const p = review({ unit, card, deck, text, at, eventId: id });
    unit = p.unit;
  };
  step('SO4^2-', 'g0');
  at += 10 * MIN;
  step('SO4^2-', 'g1'); // graduates to review
  let cycles = 0;
  while (!unit.leech && cycles < 12) {
    at = unit.state.due;
    step('nope', `f${cycles}`); // lapse
    at += 10 * MIN;
    step('SO4^2-', `r${cycles}`); // relearned
    cycles++;
  }
  assert.ok(unit.leech, 'became a leech');
  assert.equal(unit.suspended, true);
  assert.ok(unit.state.lapses >= 3 && unit.state.difficulty >= 7);
  assert.ok(cycles <= 4, `flagged soon after the threshold (${cycles} lapses)`);
});

test('a backwards device clock never makes a review unsaveable', () => {
  const deck = makeDeck();
  const card = makeCard();
  const [u0] = makeUnits(card, deck);
  const a = review({ unit: u0, card, deck, text: 'SO4^2-', at: T0 });
  const b = review({ unit: a.unit, card, deck, text: 'SO4^2-', at: T0 - DAY });
  assert.equal(b.event.transition.clockClamped, true);
  assert.ok(b.unit.state.last_review >= a.unit.state.last_review);
});
