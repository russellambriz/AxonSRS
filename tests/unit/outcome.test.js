// Chunk 1 outcome policy (docs/chunk-1-plan.md): one rule for every
// grading path, evidence kept separate from the FSRS grade. Test ids refer
// to the acceptance matrix in the Chunk 1 prompt (§14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, makeCard, makeUnits, review, rawTrial, T0, DAY } from './helpers.js';
import { assessOutcome, explainOutcome, POLICIES, phaseOf } from '../../js/core/outcome.js';
import { planOverride, planReview, exposureEvent } from '../../js/core/review.js';
import { matchAnswer } from '../../js/core/match/index.js';
import { createBaseline, addSample } from '../../js/core/fluency.js';
import { replayUnit } from '../../js/core/history.js';
import { schedulerParams } from '../../js/core/scheduler.js';

const deck = makeDeck({ answerMode: 'text' });
const card = makeCard({ answerMode: 'text', front: 'Capital of Peru', back: 'Lima' });

/** A review with full control over the trial (assistance, timing, modality). */
function answer({ text = 'Lima', unit = makeUnits(card, deck)[0], at = T0, trial = {}, match = null, eventId = `e-${Math.random()}`, ...rest } = {}) {
  const base = rawTrial({ text });
  return planReview({
    eventId, now: at, deviceId: 'dev-A', seq: 1, sessionId: 's1', mode: 'daily', live: true, unit, card, deck,
    trial: { ...base, ...trial, raw: { ...base.raw, ...(trial.raw || {}) }, assistance: { ...base.assistance, ...(trial.assistance || {}) } },
    match: match || matchAnswer(text, ['Lima'], { mode: 'text' }), params: schedulerParams(), studyDay: '2026-01-05', timeZone: 'UTC', ...rest,
  });
}

function fastBaseline() {
  let b = createBaseline('physical|recall');
  for (let i = 0; i < 40; i++) b = addSample(b, { eventId: `b${i}`, ts: i, lnLatency: Math.log(900) + (((i % 7) - 3) / 3) * 0.25, lnMsPerEffort: Math.log(200) + (((i % 7) - 3) / 3) * 0.25 });
  return b;
}

test('T01 a correct independent answer is one success, Good, one scheduling update', () => {
  const p = answer();
  assert.equal(p.event.outcome.class, 'success');
  assert.equal(p.event.outcome.independent, true);
  assert.equal(p.event.outcome.evaluation, 'correct');
  assert.equal(p.event.outcome.provenance, 'evaluator');
  assert.equal(p.event.rating, 3);
  assert.equal(p.event.grading.policy, POLICIES.standard);
  assert.equal(p.requeue, false);
  assert.ok(p.event.nextState && p.unit.headEventId === p.event.id, 'exactly one state transition, from this event');
});

test('T02 a wrong answer is a failed first attempt, Again, and comes back in the session', () => {
  const p = answer({ text: 'Quito' });
  assert.equal(p.event.outcome.class, 'failed');
  assert.equal(p.event.rating, 1);
  assert.equal(p.event.firstAttempt, true);
  assert.equal(p.requeue, true);
});

test('T03 correct but unsure is still a success; confidence is recorded as pre-feedback', () => {
  const p = answer({ confidence: 'unsure' });
  assert.equal(p.event.rating, 3);
  assert.equal(p.event.outcome.independent, true);
  assert.equal(p.event.outcome.retrieval, 'recalled-unsure');
  assert.equal(p.event.outcome.confidence, 'unsure');
  assert.equal(p.event.outcome.confidenceTiming, 'pre-feedback');
});

test('T04 a genuine guess is not recall even when the literal answer matches', () => {
  const p = answer({ confidence: 'guessing' });
  assert.equal(p.event.response.correct, true, 'the literal answer matched');
  assert.equal(p.event.outcome.class, 'guessed');
  assert.equal(p.event.outcome.independent, false);
  assert.equal(p.event.rating, 1);
  assert.equal(p.calibration, null, 'a guess never calibrates timing');
  assert.equal(p.unit.perf.recent.at(-1).c, false);
});

test('T05 an unreadable answer is unresolved, not wrong; self-assessment keeps its provenance', () => {
  const m = matchAnswer('2x+', ['2x+2'], { mode: 'math' });
  assert.equal(m.unresolved, true);
  assert.equal(matchAnswer('x^2+1', ['x^2-1'], { mode: 'math' }).unresolved, undefined, 'a readable wrong answer is wrong');
  assert.equal(matchAnswer('NH4)+', ['NH4^+'], { mode: 'chem' }).unresolved, true);
  // After comparing, the learner's own judgement is the evaluation.
  const self = answer({ text: '2x+', match: { correct: true, method: 'self', unresolved: true, diagnostics: [], warnings: [] }, gradeMode: 'manual', manualRating: 3 });
  assert.equal(self.event.outcome.provenance, 'self');
  assert.equal(self.event.outcome.reason, 'SELF_CORRECT');
  assert.equal(self.event.response.unresolved, true);
});

test('T13/T15/T16/T19 hint, solution, reveal and "I don\'t know" before answering are Again once, never a success', () => {
  const hint = answer({ trial: { assistance: { hintShown: true } } });
  assert.equal(hint.event.outcome.class, 'assisted');
  assert.equal(hint.event.rating, 1);
  assert.match(hint.event.grading.explanation, /practice with help/);
  const solution = answer({ trial: { assistance: { solutionViewed: true } } });
  assert.equal(solution.event.outcome.reason, 'ASSISTED_SOLUTION');
  assert.equal(solution.event.rating, 1);
  const revealed = answer({ text: '', trial: { assistance: { revealed: true } }, match: { correct: false, method: 'revealed', diagnostics: ['revealed'], warnings: [] } });
  assert.equal(revealed.event.outcome.class, 'revealed');
  assert.equal(revealed.event.rating, 1);
  const dk = answer({ text: '', dontKnow: true, trial: { assistance: { revealed: true } }, match: { correct: false, method: 'revealed', diagnostics: ['revealed'], warnings: [] } });
  assert.equal(dk.event.outcome.class, 'dont-know');
  assert.equal(dk.event.outcome.retrieval, 'none');
  // Assistance is a fact of the presentation, not a count: one review, one Again.
  assert.equal(hint.event.type, 'review');
  // Skip is an exposure event with no grade at all.
  const skip = exposureEvent({ id: 's', type: 'skip', now: T0, deviceId: 'dev-A', seq: null, unit: makeUnits(card, deck)[0], card, sessionId: 's1', studyDay: '2026-01-05' });
  assert.equal(skip.rating, undefined);
  assert.equal(skip.outcome, undefined);
});

test('T14 an explanation viewed after committing does not change the committed outcome', () => {
  const p = answer();
  // Viewing feedback is not part of the trial's assistance (only pre-commit help is).
  assert.equal(p.event.assistance.solutionViewed, false);
  assert.equal(p.event.outcome.class, 'success');
});

test('T20 new-card answers are labelled as first learning, delayed reviews as reviews', () => {
  const first = answer();
  assert.equal(first.event.outcome.phase, 'new');
  assert.match(first.event.grading.explanation, /^First time with this card/);
  const later = answer({ unit: { ...first.unit, state: { ...first.unit.state, state: 2 } }, at: T0 + 3 * DAY });
  assert.equal(later.event.outcome.phase, 'review');
  assert.equal(phaseOf(null), 'new');
});

test('T28/T29/T30 slow, interrupted or uncertain input never fails an independent answer', () => {
  const baseline = fastBaseline();
  const slow = answer({ baseline, trial: { raw: { latencyMs: 60000, typingMs: 30000, totalMs: 90000, activeMs: 90000 } } });
  assert.equal(slow.event.rating, 3, 'standard policy: Good however long it took');
  const hidden = answer({ baseline, policy: POLICIES.timing, trial: { raw: { latencyMs: 20000, hiddenMs: 15000, interruptedByHidden: true } } });
  assert.equal(hidden.event.rating, 3, 'interrupted timing is never used for a grade');
  const dictated = answer({ baseline, policy: POLICIES.timing, trial: { modality: { kind: 'unknown', confidence: 0.1 }, raw: { origins: { dictation: 1 } } } });
  assert.equal(dictated.event.rating, 3);
  assert.ok(!dictated.calibration, 'uncertain input does not calibrate');
});

test('the experimental timing policy can move an independent success to Hard or Easy, and says so', () => {
  const baseline = fastBaseline();
  const fast = answer({ baseline, policy: POLICIES.timing, trial: { raw: { latencyMs: 700, typingMs: 500 } } });
  const std = answer({ baseline, trial: { raw: { latencyMs: 700, typingMs: 500 } } });
  assert.equal(std.event.rating, 3);
  assert.ok([2, 3, 4].includes(fast.event.rating));
  assert.equal(fast.event.grading.policy, POLICIES.timing);
  assert.equal(typeof fast.event.grading.timingGrade, 'number');
  // Assistance still wins over timing.
  assert.equal(answer({ baseline, policy: POLICIES.timing, trial: { assistance: { hintShown: true } } }).event.rating, 1);
});

test('manual mode: an explicit Hard/Good/Easy for an independent success; Again means not recalled', () => {
  assert.equal(answer({ gradeMode: 'manual', manualRating: 2 }).event.rating, 2);
  assert.equal(answer({ gradeMode: 'manual', manualRating: 4 }).event.rating, 4);
  const again = answer({ gradeMode: 'manual', manualRating: 1 });
  assert.equal(again.event.rating, 1);
  assert.equal(again.event.outcome.provenance, 'self');
  assert.throws(() => answer({ gradeMode: 'manual' }), /requires a rating/);
  // A hinted answer needs no rating: it is Again whatever the mode.
  assert.equal(answer({ gradeMode: 'manual', trial: { assistance: { hintShown: true } } }).event.rating, 1);
});

test('T31/T32 "My answer is correct" replaces the evaluation once and keeps real assistance', () => {
  const failed = answer({ text: 'Lima City', eventId: 'f1' });
  assert.equal(failed.event.rating, 1);
  const fix = planOverride({ eventId: 'c1', now: T0 + 5000, deviceId: 'dev-A', seq: 2, target: failed.event, kind: 'correct', unit: failed.unit, unitEvents: [failed.event], studyDay: '2026-01-05', deck });
  assert.equal(fix.event.type, 'correction', 'a correction, not a second review');
  assert.equal(fix.event.newRating, 3);
  assert.equal(fix.event.outcome.reason, 'CORRECTED');
  assert.equal(fix.event.outcome.provenance, 'user-correction');
  assert.equal(replayUnit([failed.event, fix.event]).state.reps, failed.unit.state.reps, 'still one scheduling step');
  const hinted = answer({ text: 'Lima City', eventId: 'f2', trial: { assistance: { hintShown: true } } });
  const fix2 = planOverride({ eventId: 'c2', now: T0 + 5000, deviceId: 'dev-A', seq: 2, target: hinted.event, kind: 'correct', unit: hinted.unit, unitEvents: [hinted.event], studyDay: '2026-01-05', deck });
  assert.equal(fix2.event.newRating, 1, 'help really happened, so it is still practice with help');
  assert.equal(fix2.event.outcome.class, 'assisted');
});

test('"I guessed without remembering" is Again; effort ratings only for an independent success', () => {
  const ok = answer({ eventId: 'g1' });
  const guessed = planOverride({ eventId: 'g2', now: T0 + 3000, deviceId: 'dev-A', seq: 2, target: ok.event, kind: 'guessed', unit: ok.unit, unitEvents: [ok.event], studyDay: '2026-01-05' });
  assert.equal(guessed.event.newRating, 1);
  assert.equal(guessed.event.outcome.class, 'guessed');
  const hard = planOverride({ eventId: 'g3', now: T0 + 3000, deviceId: 'dev-A', seq: 2, target: ok.event, kind: 'manual', manualRating: 2, unit: ok.unit, unitEvents: [ok.event], studyDay: '2026-01-05' });
  assert.equal(hard.event.newRating, 2);
  const hinted = answer({ eventId: 'g4', trial: { assistance: { hintShown: true } } });
  assert.throws(() => planOverride({ eventId: 'g5', now: T0 + 3000, deviceId: 'dev-A', seq: 2, target: hinted.event, kind: 'manual', manualRating: 4, unit: hinted.unit, unitEvents: [hinted.event], studyDay: '2026-01-05' }), /on your own/);
});

test('T44 research arms keep their semantics and record the policy used', () => {
  const study = { studyId: 'st1', arm: 'standard' };
  const manualArm = answer({ gradeMode: 'research', research: study, manualRating: 2, policy: POLICIES.timing });
  assert.equal(manualArm.event.grading.mode, 'manual');
  assert.equal(manualArm.event.rating, 2);
  assert.equal(manualArm.event.grading.shadowGrade, manualArm.event.grading.grade, 'shadow = what the policy would have recorded');
  const auto = answer({ gradeMode: 'research', research: { studyId: 'st1', arm: 'axon' }, policy: POLICIES.timing });
  assert.equal(auto.event.grading.mode, 'auto');
  assert.equal(auto.event.grading.policy, POLICIES.timing);
});

test('legacy reviews (no policy recorded) keep their timing semantics when corrected', () => {
  const failed = answer({ text: 'Lima City', eventId: 'l1' });
  const legacy = { ...failed.event, outcome: undefined, grading: { ...failed.event.grading, policy: undefined } };
  const fix = planOverride({ eventId: 'l2', now: T0 + 5000, deviceId: 'dev-A', seq: 2, target: legacy, kind: 'correct', unit: failed.unit, unitEvents: [legacy], studyDay: '2026-01-05' });
  assert.ok([2, 3, 4].includes(fix.event.newRating));
  assert.equal(fix.event.outcome.independent, true);
});

test('assessOutcome: one rule, explained in plain language', () => {
  const o = assessOutcome({ correct: true, confidence: 'confident' });
  assert.deepEqual([o.class, o.rating, o.retrieval], ['success', 3, 'recalled']);
  assert.equal(assessOutcome({ correct: true, typoTolerated: true, manualRating: 4 }).rating, 3, 'a typo never gets Easy');
  assert.equal(assessOutcome({ correct: null, selfHelp: true }).class, 'assisted');
  assert.equal(assessOutcome({ correct: true, confidence: 'nonsense' }).confidence, null, 'unknown values are not invented');
  assert.match(explainOutcome(assessOutcome({ correct: true, confidence: 'guessing' })), /guess/);
});
