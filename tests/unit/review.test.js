// Spec 12.8, 12.10, 12.11, 17.11, 17.12, 17.21: wrong answers and event
// recording, independent forward/reverse scheduling, cram without
// scheduled reviews, alias rescue applied exactly once, undo, formatting
// versus substantive edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, makeCard, makeUnits, review, T0, DAY, MIN } from './helpers.js';
import { classifyEdit, createCard, createDeck } from '../../js/core/model.js';
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
  // The rescued answer counts as a success everywhere the unit records it.
  assert.deepEqual(rescue.unit.lastScheduled, { ...good.unit.lastScheduled, hesitation: rescue.event.hesitation });
  assert.equal(rescue.unit.perf.recent.at(-1).c, true);
  assert.equal(rescue.unit.perf.recent.length, failed.unit.perf.recent.length, 'replaced, not added');
  assert.equal(rescue.unit.lastReviewAt, failed.unit.lastReviewAt);
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
  // The next review's Easy check sees the corrected grade.
  assert.equal(knew.unit.lastScheduled.grade, knew.event.newRating);
  assert.equal(guessed.unit.lastScheduled.grade, guessed.event.newRating);
});

/** Review a card until one failure makes it a leech; returns that failure. */
function failUntilLeech(deck, card) {
  let [unit] = makeUnits(card, deck);
  const events = [];
  let at = T0;
  const step = (text, id) => {
    const p = review({ unit, card, deck, text, at, eventId: id });
    events.push(p.event);
    unit = p.unit;
    return p;
  };
  step('SO4^2-', 'g0');
  at += 10 * MIN;
  step('SO4^2-', 'g1');
  for (let i = 0; i < 12; i++) {
    at = unit.state.due;
    const p = step('nope', `f${i}`);
    if (p.unit.leech) return { failed: p, events, at };
    at += 10 * MIN;
    step('SO4^2-', `r${i}`);
  }
  throw new Error('never became a leech');
}

test('a rescue also replaces the failure’s other effects: performance, Easy eligibility, leech flag and auto-suspension', async () => {
  const { createBaseline, addSample } = await import('../../js/core/fluency.js');
  const deck = makeDeck({ leechThreshold: 3, leechAction: 'suspend' });
  const card = makeCard();
  const { failed, events, at } = failUntilLeech(deck, card);
  assert.equal(failed.unit.suspended, true, 'the failure auto-suspended the leech');
  assert.equal(failed.unit.lastScheduled.correct, false);
  const now = at + 5000;
  const rescue = planOverride({ eventId: 'fix', now, deviceId: 'dev-A', seq: 99, target: failed.event, kind: 'correct', unit: failed.unit, unitEvents: events, studyDay: '2026-01-05', deck });
  assert.ok(rescue.unit.state.lapses < failed.unit.state.lapses, 'no lapse from the rescued answer');
  assert.equal(rescue.unit.leech, false, 'the leech flag the failure raised is withdrawn');
  assert.equal(rescue.unit.leechSince, null);
  assert.equal(rescue.unit.suspended, false, 'and so is its automatic suspension');
  assert.equal(rescue.unit.suspendedAt, now, 'as the newest suspension decision, so it syncs');
  assert.equal(rescue.unit.perf.recent.at(-1).c, true);
  assert.equal(rescue.unit.perf.recent.filter((r) => !r.c).length, failed.unit.perf.recent.filter((r) => !r.c).length - 1);
  assert.deepEqual(rescue.unit.lastScheduled, { correct: true, assisted: false, grade: rescue.event.newRating, typoTolerated: false, hesitation: rescue.event.hesitation });
  // The next fluent answer can be graded Easy again (a remaining failure
  // summary would block it as inconsistent).
  let baseline = createBaseline('physical|recall');
  for (let i = 0; i < 40; i++) baseline = addSample(baseline, { eventId: `b${i}`, ts: i, lnLatency: Math.log(6000) + (((i % 7) - 3) / 3) * 0.25, lnMsPerEffort: Math.log(500) + (((i % 7) - 3) / 3) * 0.25 });
  const nextAt = rescue.unit.state.due;
  const after = review({ unit: rescue.unit, card, deck, text: 'SO4^2-', at: nextAt, baseline });
  assert.equal(after.event.rating, 4, after.event.grading.reasons.join(','));
  const stale = review({ unit: { ...rescue.unit, lastScheduled: failed.unit.lastScheduled }, card, deck, text: 'SO4^2-', at: nextAt, baseline });
  assert.ok(stale.event.grading.reasons.includes('EASY_NEEDS_CONSISTENCY'));
});

test('a rescue never lifts a manual suspension or a leech flag that predates the failure', () => {
  const deck = makeDeck({ leechThreshold: 3, leechAction: 'flag' });
  const card = makeCard();
  const { failed, events, at } = failUntilLeech(deck, card);
  assert.equal(failed.unit.suspended, false);
  // Suspended by hand after the failure, then rescued.
  const manual = { ...failed.unit, suspended: true, suspendedAt: at + 2000 };
  const rescue = planOverride({ eventId: 'fix', now: at + 5000, deviceId: 'dev-A', seq: 99, target: failed.event, kind: 'correct', unit: manual, unitEvents: events, studyDay: '2026-01-05', deck });
  assert.equal(rescue.unit.leech, false);
  assert.equal(rescue.unit.suspended, true, 'manual suspension kept');
  assert.equal(rescue.unit.suspendedAt, at + 2000);
  // Already a leech before this failure: the rescue leaves the flag alone.
  const older = { ...failed.unit, leechSince: failed.event.ts - DAY };
  const kept = planOverride({ eventId: 'fix2', now: at + 5000, deviceId: 'dev-A', seq: 100, target: { ...failed.event, prevUnitMeta: { ...failed.event.prevUnitMeta, leech: true } }, kind: 'correct', unit: older, unitEvents: events, studyDay: '2026-01-05', deck });
  assert.equal(kept.unit.leech, true);
});

test('a correction that lowers the grade can make the card a leech, like the review would have', () => {
  const deck = makeDeck({ leechThreshold: 3, leechAction: 'suspend' });
  const card = makeCard();
  const { failed, events, at } = failUntilLeech(deck, card);
  // Same history, but the leech-making failure was rescued first …
  const rescue = planOverride({ eventId: 'fix', now: at + 5000, deviceId: 'dev-A', seq: 99, target: failed.event, kind: 'correct', unit: failed.unit, unitEvents: events, studyDay: '2026-01-05', deck });
  // … and then graded Again by hand after all.
  const again = planOverride({ eventId: 'fix2', now: at + 9000, deviceId: 'dev-A', seq: 100, target: failed.event, kind: 'manual', manualRating: 1, unit: rescue.unit, unitEvents: [...events, rescue.event], studyDay: '2026-01-05', deck });
  assert.equal(again.unit.leech, true);
  assert.equal(again.unit.suspended, true);
  assert.equal(again.unit.suspendedAt, at + 9000);
  // Undo of that review lifts the suspension the correction raised.
  const undo = planUndo({ eventId: 'u', now: at + 12000, deviceId: 'dev-A', seq: 101, target: failed.event, unit: again.unit, unitEvents: [...events, rescue.event, again.event], studyDay: '2026-01-05' });
  assert.equal(undo.unit.suspended, false);
  assert.equal(undo.unit.leech, false);
});

test('a rescued practice answer counts as a success in recent performance', () => {
  const deck = makeDeck();
  const card = makeCard();
  const [u0] = makeUnits(card, deck);
  const p = review({ unit: u0, card, deck, text: 'nope', at: T0, live: false, mode: 'cram', eventId: 'pr1' });
  assert.equal(p.unit.perf.recent.at(-1).c, false);
  const rescue = planOverride({ eventId: 'o', now: T0 + 3000, deviceId: 'dev-A', seq: 2, target: p.event, kind: 'correct', unit: p.unit, unitEvents: [p.event], studyDay: '2026-01-05' });
  assert.equal(rescue.unit.perf.recent.at(-1).c, true);
  assert.equal(rescue.unit.state, p.unit.state, 'practice never touches the schedule');
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
  assert.throws(() => review({ unit, card, deck, text: 'SO4^2-', at: T0, gradeMode: 'manual' }), /requires a rating/);
  // A wrong answer is Again in manual mode too, whatever was chosen.
  const wrong = review({ unit, card, deck, text: 'SO3^2-', at: T0, gradeMode: 'manual', manualRating: 4 });
  assert.equal(wrong.event.rating, 1);
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

test('alias rescue re-grades from the original measurements (hint ceiling still applies)', async () => {
  const { DEFAULT_GRADING_CONFIG } = await import('../../js/core/fluency.js');
  const deck = makeDeck({ answerMode: 'text' });
  const card = makeCard({ answerMode: 'text', front: 'Largest planet', back: 'Jupiter' });
  const [unit] = makeUnits(card, deck);
  const failed = review({ unit, card, deck, text: 'Iuppiter', at: T0, eventId: 'h1' });
  assert.ok(failed.event.promptStats, 'prompt size is recorded for re-grading');
  failed.event.assistance.hintShown = true;
  const rescue = planOverride({ eventId: 'o9', now: T0 + 4000, deviceId: 'dev-A', seq: 3, target: failed.event, kind: 'alias', unit: failed.unit, unitEvents: [failed.event], alias: 'Iuppiter', studyDay: '2026-01-05', gradingConfig: { ...DEFAULT_GRADING_CONFIG, hintCeiling: 'hard' } });
  assert.equal(rescue.event.newRating, 2, 'a hinted rescue respects the Hard ceiling');
  assert.ok(rescue.event.reasons.includes('ALIAS_RESCUE') && rescue.event.reasons.includes('HINT_CEILING'));
});

test('“I knew that” never lifts an answer past its hint ceiling or a typo past Good', async () => {
  const { mergeGradingConfig } = await import('../../js/core/fluency.js');
  const { knewThatGrade } = await import('../../js/core/review.js');
  const hard = mergeGradingConfig({ hintCeiling: 'hard' });
  const deck = makeDeck({ answerMode: 'text' });
  const card = makeCard({ answerMode: 'text', front: 'Largest planet', back: 'Jupiter' });
  const [unit] = makeUnits(card, deck);
  const knew = (target, cfg) => planOverride({ eventId: `o-${target.id}`, now: T0 + 1000, deviceId: 'dev-A', seq: 2, target, kind: 'knew', unit, unitEvents: [target], studyDay: '2026-01-05', gradingConfig: cfg });
  const hinted = review({ unit, card, deck, text: 'Jupiter', at: T0, eventId: 'k-hint' }).event;
  Object.assign(hinted, { rating: 2, grading: { ...hinted.grading, grade: 2 }, assistance: { ...hinted.assistance, hintShown: true } });
  const k1 = knew(hinted, hard);
  assert.equal(k1.event.newRating, 2, 'a hinted answer stays at the Hard ceiling');
  assert.ok(k1.event.reasons.includes('HINT_CEILING'));
  assert.equal(knewThatGrade(hinted, hard), 2, 'the study screen can tell the button would change nothing');
  const typo = review({ unit, card, deck, text: 'Jupiter', at: T0, eventId: 'k-typo' }).event;
  Object.assign(typo, { rating: 3, grading: { ...typo.grading, grade: 3 }, response: { ...typo.response, typoTolerated: true } });
  const k2 = knew(typo);
  assert.equal(k2.event.newRating, 3, 'a typo-tolerated answer never becomes Easy');
  assert.ok(k2.event.reasons.includes('TYPO_NO_EASY'));
  const clean = review({ unit, card, deck, text: 'Jupiter', at: T0, eventId: 'k-clean' }).event;
  Object.assign(clean, { rating: 3, grading: { ...clean.grading, grade: 3 } });
  assert.equal(knew(clean).event.newRating, 4, 'an unassisted exact answer can still be raised to Easy');
  // "I guessed" on a hinted or typo answer only ever lowers.
  const g = planOverride({ eventId: 'o-g', now: T0 + 1000, deviceId: 'dev-A', seq: 3, target: hinted, kind: 'guessed', unit, unitEvents: [hinted], studyDay: '2026-01-05', gradingConfig: hard });
  assert.ok(g.event.newRating <= 2);
  // Overrides that would count a revealed answer as recalled are refused.
  const revealed = review({ unit, card, deck, text: '', at: T0, eventId: 'k-rev' }).event;
  revealed.assistance = { ...revealed.assistance, revealed: true };
  for (const kind of ['correct', 'alias', 'knew']) {
    assert.throws(() => planOverride({ eventId: `o-r-${kind}`, now: T0 + 1000, deviceId: 'dev-A', seq: 4, target: revealed, kind, alias: kind === 'alias' ? 'x' : null, unit, unitEvents: [revealed], studyDay: '2026-01-05' }), /revealed/);
  }
});

test('edit classification: letter case and matching rules count when they change what is tested', () => {
  const textDeck = createDeck({ id: 'd-text', name: 'Text' });
  const chemDeck = createDeck({ id: 'd-chem', name: 'Chem', settings: { answerMode: 'chem' } });
  const co = createCard({ id: 'c-co', deckId: chemDeck.id, front: 'Carbon monoxide', back: 'CO' });
  assert.equal(classifyEdit(co, { ...co, back: ['Co'] }, chemDeck).fwd, 'substantive', 'CO (carbon monoxide) is not Co (cobalt)');
  assert.equal(classifyEdit(co, { ...co, back: ['**CO**'] }, chemDeck).fwd, 'formatting');
  const paris = createCard({ id: 'c-p', deckId: textDeck.id, front: 'Capital of France', back: 'Paris' });
  assert.equal(classifyEdit(paris, { ...paris, back: ['paris'] }, textDeck).fwd, 'formatting', 'case is ignored by the matcher here');
  assert.equal(classifyEdit(paris, { ...paris, back: ['Paris', 'Lutetia'] }, textDeck).fwd, 'aliases');
  assert.equal(classifyEdit(paris, { ...paris, front: ['capital of france'] }, textDeck).fwd, 'formatting');
  const strictParis = { ...paris, match: { caseSensitive: true } };
  assert.equal(classifyEdit(strictParis, { ...strictParis, back: ['paris'] }, textDeck).fwd, 'substantive', 'case-sensitive card');
  // Matching rules that change which answers are accepted
  assert.equal(classifyEdit(paris, strictParis, textDeck).fwd, 'substantive');
  assert.equal(classifyEdit(paris, { ...paris, match: { strictSpelling: true } }, textDeck).fwd, 'substantive');
  assert.equal(classifyEdit(paris, { ...paris, match: { caseSensitive: false } }, textDeck).fwd, 'none', 'same as the deck default');
  assert.equal(classifyEdit(paris, { ...paris, answerMode: 'text' }, textDeck).fwd, 'none', 'explicitly the deck’s own mode');
  assert.equal(classifyEdit(paris, { ...paris, match: { mathEquivalence: 'algebraic' } }, textDeck).fwd, 'none', 'maths rules do not apply to text answers');
  assert.equal(classifyEdit(paris, { ...paris, answerMode: 'chem' }, textDeck).fwd, 'substantive');
  const cube = createCard({ id: 'c-m', deckId: textDeck.id, front: 'd/dx x^3', back: '3x^2', answerMode: 'math' });
  assert.equal(classifyEdit(cube, { ...cube, match: { numericTolerance: '1%' } }, textDeck).fwd, 'substantive');
  assert.equal(classifyEdit(cube, { ...cube, back: ['3X^2'] }, textDeck).fwd, 'substantive', 'case matters in maths');
  // Deleting one occlusion mask and adding another leaves the untouched
  // mask unchanged; the deleted one is 'removed', not a substantive edit.
  const masks = [{ id: 'm1', x: 0, y: 0, w: 0.1, h: 0.1, label: ['Atrium'] }, { id: 'm2', x: 0.5, y: 0.5, w: 0.1, h: 0.1, label: ['Ventricle'] }];
  const occ = createCard({ id: 'c-o', deckId: textDeck.id, kind: 'occlusion', front: [''], back: [], occlusion: { imageId: 'img', alt: 'Heart', masks, order: 'random' } });
  const edited = { ...occ, occlusion: { ...occ.occlusion, masks: [masks[0], { id: 'm3', x: 0.6, y: 0.6, w: 0.1, h: 0.1, label: ['Aorta'] }] } };
  assert.deepEqual(classifyEdit(occ, edited, textDeck), { 'o-m1': 'none', 'o-m2': 'removed', 'o-m3': 'added' });
});
