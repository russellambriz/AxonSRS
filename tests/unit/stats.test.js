// Spec 9, 16.8, 16.9, 17.20: exposure-aware statistics, workload and exam
// plans, research comparison, and per-presentation measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerClass, correctionIndex, dailyActivity, currentStreak, longestStreak, accuracySeries,
  summary, eventualSuccess, retentionCalibration, forecast, exposureBreakdown, unitHistory, heatmapLevels, isLeech,
  outcome, effectiveRetrievals, retractActivity, latencySeries, selfRatingAnalysis, recentWeeks, deckTrends,
} from '../../js/core/stats.js';
import {
  durationModel, estimateSessionMinutes, catchUpPlan, analyzeExamPlan, PROVISIONAL_SECONDS, MIN_SAMPLES_FOR_ESTIMATE,
  cardCosts, reviewSessionsBetween, topicBreakdown, SCHEDULING_MODES, MAX_FEEDBACK_MS,
} from '../../js/core/planner.js';
import { assignArm, createStudy, comparisonReport, deidentifiedRows, toCsv } from '../../js/core/research.js';
import { TrialRecorder } from '../../js/study/trial.js';
import { schedulerParams, State } from '../../js/core/scheduler.js';
import { studyDayStart } from '../../js/core/time.js';
import { T0, DAY } from './helpers.js';

const params = schedulerParams();
let n = 0;
function ev(fields) {
  n++;
  return { id: `e${n}`, type: 'review', ts: T0 + n * 1000, deviceId: 'dev', seq: n, sessionId: 's1', unitId: 'u1', cardId: 'c1', deckId: 'd1', studyDay: '2026-01-05', firstAttempt: true, response: { correct: true }, assistance: {}, activeMs: 4000, ...fields };
}

test('answers are classified as independent, hinted, revealed, overridden, voided or incorrect', () => {
  const ok = ev({});
  const hinted = ev({ assistance: { hintShown: true } });
  const revealed = ev({ assistance: { revealed: true } });
  const wrong = ev({ response: { correct: false } });
  const over = ev({ response: { correct: false } });
  const voided = ev({});
  const corrections = [
    { id: 'k1', type: 'correction', kind: 'override', targetId: over.id, newRating: 3, ts: T0 + 99000, deviceId: 'dev', seq: 99 },
    { id: 'k2', type: 'correction', kind: 'void', targetId: voided.id, ts: T0 + 99500, deviceId: 'dev', seq: 100 },
  ];
  const corr = correctionIndex([ok, hinted, revealed, wrong, over, voided, ...corrections]);
  assert.deepEqual([ok, hinted, revealed, wrong, over, voided].map((e) => answerClass(e, corr)), ['independent-correct', 'hinted', 'revealed', 'incorrect', 'overridden', 'voided']);
});

test('first-attempt accuracy counts only independent correct answers; voided reviews are excluded', () => {
  const events = [ev({}), ev({ assistance: { hintShown: true } }), ev({ response: { correct: false } }), ev({ firstAttempt: false }), ev({})];
  events.push({ id: 'v', type: 'correction', kind: 'void', targetId: events[4].id, ts: T0 + DAY, deviceId: 'dev', seq: 200 });
  const [day] = accuracySeries(events);
  assert.equal(day.n, 3, 'retry attempts and voided reviews are not first attempts');
  assert.equal(day.independentCorrect, 1);
  assert.equal(day.hinted, 1);
  assert.equal(day.correct, 2, 'raw correctness reported separately');
  assert.ok(day.ci.low < day.ci.p && day.ci.p < day.ci.high, 'Wilson interval around the observed accuracy');
});

test('eventual success after retries is reported separately from first-attempt success', () => {
  const events = [
    ev({ unitId: 'a', response: { correct: false } }), ev({ unitId: 'a', firstAttempt: false, response: { correct: true } }),
    ev({ unitId: 'b', response: { correct: true } }),
  ];
  const r = eventualSuccess(events);
  assert.equal(r.n, 2);
  assert.equal(r.firstAttempt, 0.5);
  assert.equal(r.eventual, 1);
});

test('optional practice is exposure, not scheduled recall; summary separates them', () => {
  const events = [ev({}), ev({ type: 'practice', mode: 'cram' }), ev({ type: 'copy' }), ev({ type: 'hint' })];
  const s = summary(events, [], { today: '2026-01-05', now: T0, params });
  assert.equal(s.reviewedToday, 1);
  assert.equal(s.practicedToday, 1);
  assert.equal(s.firstAttemptAccuracy.n, 1);
  assert.equal(s.predictedRecall, null, 'no prediction without learned units');
  const b = exposureBreakdown(events);
  assert.deepEqual([b.review, b.practice, b.copy, b.hint], [1, 1, 1, 1]);
  const act = dailyActivity(events).get('2026-01-05');
  assert.equal(act.retrievals, 2, 'copying the correction is not a retrieval');
});

test('retention calibration compares predicted and observed recall and excludes exposure-affected tests', () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push(ev({ predictedR: 0.9, elapsedDays: 5, response: { correct: i < 8 } }));
  events.push(ev({ predictedR: 0.9, elapsedDays: 5, flags: { practiceSinceLast: true } }));
  events.push(ev({ predictedR: 0.9, elapsedDays: 5, flags: { siblingExposure: true } }));
  events.push(ev({ predictedR: 0.5, elapsedDays: 0.2 })); // same-day relearning is not a delayed test
  const cal = retentionCalibration(events);
  const bin = cal.bins[4];
  assert.equal(bin.n, 10);
  assert.equal(bin.observed, 0.8);
  assert.ok(Math.abs(bin.predicted - 0.9) < 1e-9);
  assert.equal(cal.affectedExcluded, 2);
  assert.equal(cal.bins[2].n, 0);
});

test('streaks: unstudied today does not break the streak; gaps do', () => {
  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05', '2026-01-06'];
  const act = dailyActivity(days.map((d) => ev({ studyDay: d })));
  assert.equal(currentStreak(act, '2026-01-07'), 2);
  assert.equal(currentStreak(act, '2026-01-06'), 2);
  assert.equal(currentStreak(act, '2026-01-09'), 0);
  assert.equal(longestStreak(act), 3);
  const cells = heatmapLevels(act, { today: '2026-01-06', days: 7 });
  assert.equal(cells.length, 7);
  assert.equal(cells.find((c) => c.day === '2026-01-04').level, 0);
  assert.ok(cells.find((c) => c.day === '2026-01-05').level > 0);
});

test('forecast carries overdue units into today and respects postponement overlays', () => {
  const card = { id: 'c', suspended: false, tags: [] };
  const cardsById = new Map([['c', card]]);
  const mk = (due, extra = {}) => ({ id: `u${due}`, cardId: 'c', active: true, state: { state: State.Review, due }, overlays: {}, ...extra });
  const units = [mk(T0 - 3 * DAY), mk(T0 + DAY), mk(T0 + 2 * DAY, { overlays: { postponedUntil: '2026-01-09' } }), mk(T0 + DAY, { suspended: true }), { id: 'n', cardId: 'c', active: true, state: null }];
  const f = forecast(units, cardsById, { today: '2026-01-05', days: 7, timeZone: 'UTC', rolloverHour: 4 });
  assert.equal(f[0].due, 1);
  assert.equal(f[0].overdueCarried, 1);
  assert.equal(f[1].due, 1);
  assert.equal(f[2].due, 0);
  assert.equal(f[4].due, 1, 'postponed to 2026-01-09');
});

test('card history shows inferred grade, effective rating, overrides and voids', () => {
  const a = ev({ unitId: 'h', rating: 1, grading: { grade: 1, reasons: ['INCORRECT'] } });
  const b = ev({ unitId: 'h', rating: 3, grading: { grade: 3, reasons: ['ACCURATE_FLUENT'] } });
  const events = [a, b,
    { id: 'o', type: 'correction', kind: 'override', reason: 'alias', targetId: a.id, newRating: 3, ts: T0 + DAY, deviceId: 'dev', seq: 300 },
    { id: 'x', type: 'correction', kind: 'void', targetId: b.id, ts: T0 + DAY + 1, deviceId: 'dev', seq: 301 }];
  const rows = unitHistory(events, 'h');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].inferredGrade, 1);
  assert.equal(rows[0].effectiveRating, 3);
  assert.deepEqual(rows[0].overrides, ['alias']);
  assert.equal(rows[1].voided, true);
});

test('leeches require repeated lapses and high difficulty', () => {
  assert.equal(isLeech({ state: { lapses: 5, difficulty: 8 } }), true);
  assert.equal(isLeech({ state: { lapses: 5, difficulty: 4 } }), false);
  assert.equal(isLeech({ state: { lapses: 2, difficulty: 9 } }, { threshold: 2 }), true);
});

test('workload estimates are provisional until enough of the learner’s own reviews exist', () => {
  const few = durationModel([ev({ activeMs: 6000 })]);
  assert.equal(few.review.provisional, true);
  assert.equal(few.review.seconds, PROVISIONAL_SECONDS.review);
  const many = durationModel(Array.from({ length: MIN_SAMPLES_FOR_ESTIMATE }, () => ev({ activeMs: 6000 })));
  assert.equal(many.review.provisional, false);
  assert.equal(many.review.seconds, 6);
  const est = estimateSessionMinutes({ reviews: 30, news: 0 }, many);
  assert.equal(est.minutes, 3);
  assert.equal(est.provisional, false);
  assert.equal(estimateSessionMinutes({ reviews: 0, news: 5 }, many).provisional, true, 'new-card time still provisional');
});

test('catch-up plan spreads a backlog over several days within a daily cap', () => {
  assert.deepEqual(catchUpPlan({ backlog: 0, dailyDue: 20 }), { needed: false, perDay: 0, days: 0 });
  const p = catchUpPlan({ backlog: 140, dailyDue: 30, targetDays: 7 });
  assert.equal(p.perDay, 50);
  assert.equal(p.days, 7);
  const capped = catchUpPlan({ backlog: 2000, dailyDue: 50, targetDays: 7, dailyMax: 200 });
  assert.equal(capped.perDay, 200);
  assert.equal(capped.days, 14);
});

test('exam plans report coverage, weak items, workload and a feasibility warning without changing schedules', () => {
  const cardsById = new Map();
  const units = [];
  for (let i = 0; i < 40; i++) {
    cardsById.set(`c${i}`, { id: `c${i}`, tags: i < 30 ? ['exam'] : [], suspended: false });
    const learned = i < 10;
    units.push({ id: `u${i}`, cardId: `c${i}`, deckId: 'd1', active: true, state: learned ? { state: State.Review, due: T0 + (i + 1) * DAY, stability: i < 3 ? 0.1 : 20, difficulty: 5, lapses: 0, reps: 3, last_review: T0 - (i < 3 ? 10 : 1) * DAY, elapsed_days: 1, scheduled_days: 20, learning_steps: 0 } : null });
  }
  const before = structuredClone(units);
  const plan = { examDate: '2026-01-15', deckIds: ['d1'], tags: ['exam'], dailyMinutes: 1, targetCoverage: 1 };
  const r = analyzeExamPlan(plan, { units, cardsById, events: [], today: '2026-01-05', now: T0, params });
  assert.equal(r.totalUnits, 30);
  assert.equal(r.daysLeft, 10);
  assert.equal(r.unintroduced, 20);
  assert.equal(r.toIntroduce, 20);
  assert.equal(r.newPerDayNeeded, 2);
  assert.ok(r.weak >= 3, 'low-retrievability items count as weak');
  assert.equal(r.likelyInsufficient, true, '1 minute/day is not enough');
  assert.equal(r.provisional, true);
  assert.ok(r.predictedRecallAtExamWithoutStudy < r.predictedRecallNow);
  assert.deepEqual(units, before, 'analysis never mutates unit schedules');
  const roomy = analyzeExamPlan({ ...plan, dailyMinutes: 60 }, { units, cardsById, events: [], today: '2026-01-05', now: T0, params });
  assert.equal(roomy.likelyInsufficient, false);
});

test('research mode assigns arms stably per card group and reports with sample sizes and cautions', () => {
  const study = createStudy({ id: 'st1', startDay: '2026-01-01', schedulerVersion: 'x', gradingVersion: 'y', desiredRetention: 0.9 });
  const arms = new Map();
  for (let i = 0; i < 200; i++) arms.set(`g${i}`, assignArm(`g${i}`, study));
  for (let i = 0; i < 200; i++) assert.equal(assignArm(`g${i}`, study), arms.get(`g${i}`), 'stable');
  const axon = [...arms.values()].filter((a) => a === 'axon').length;
  assert.ok(axon > 70 && axon < 130, `roughly balanced (${axon}/200)`);
  assert.equal(assignArm('g1', { ...study, active: false }), null);
  assert.equal(assignArm('g1', { ...study, design: 'all-standard' }), 'standard');

  const events = [];
  for (let i = 0; i < 20; i++) {
    const arm = i % 2 ? 'axon' : 'standard';
    events.push(ev({ cardId: `g${i}`, research: { studyId: 'st1', arm }, elapsedDays: 3, response: { correct: i % 3 !== 0 } }));
  }
  events.push(ev({ research: { studyId: 'st1', arm: 'axon' }, elapsedDays: 3, flags: { practiceSinceLast: true } }));
  events.push(ev({ research: { studyId: 'other', arm: 'axon' }, elapsedDays: 3 }));
  const rep = comparisonReport(events, study);
  assert.equal(rep.arms.axon.delayedTests + rep.arms.standard.delayedTests, 20);
  assert.equal(rep.arms.axon.excludedAffectedByExposure, 1);
  assert.ok(Number.isFinite(rep.arms.axon.recall.low));
  assert.match(rep.caution, /Too few delayed tests/);
  assert.equal(/superior/i.test(rep.caution) && !/do not|not establish|descriptive/i.test(rep.caution), false);
});

test('de-identified export contains no content, answers or raw ids', () => {
  const e = ev({ id: 'secret-event', cardId: 'secret-card', response: { correct: true, text: 'my private answer' }, grading: { grade: 3, reasons: ['ACCURATE_FLUENT'], measurements: { raw: { latencyMs: 1200 } } } });
  const rows = deidentifiedRows([e, ev({ type: 'hint' })], { salt: 'fixed' });
  assert.equal(rows.length, 1);
  const csv = toCsv(rows);
  for (const leak of ['secret-event', 'secret-card', 'my private answer', 'dev']) assert.equal(csv.includes(leak), false, `no ${leak}`);
  assert.match(csv, /latencyMs/);
  assert.equal(deidentifiedRows([e], { salt: 'fixed' })[0].event, rows[0].event, 'stable within one export salt');
  assert.notEqual(deidentifiedRows([e], { salt: 'other' })[0].event, rows[0].event);
});

const corrOf = (id, targetId, kind, reason, at) => ({ id, type: 'correction', kind, reason, targetId, newRating: kind === 'override' ? 3 : undefined, ts: at, deviceId: 'dev', seq: 1000 + n++ });

test('a rescued answer counts as correct in every accuracy figure; a guess, a hint or a reveal is not independent recall', () => {
  const rescued = ev({ unitId: 'ra', response: { correct: false } });
  const guessed = ev({ unitId: 'rb' });
  const revealed = ev({ unitId: 'rc', response: { correct: false }, assistance: { revealed: true } });
  const hinted = ev({ unitId: 'rd', response: { correct: false }, assistance: { hintShown: true } });
  const plain = ev({ unitId: 're' });
  const events = [rescued, guessed, revealed, hinted, plain,
    corrOf('c1', rescued.id, 'override', 'alias', T0 + DAY), corrOf('c2', guessed.id, 'override', 'guessed', T0 + DAY),
    corrOf('c3', revealed.id, 'override', 'correct', T0 + DAY), corrOf('c4', hinted.id, 'override', 'alias', T0 + DAY)];
  const corr = correctionIndex(events);
  assert.deepEqual(outcome(rescued, corr), { cls: 'overridden', correct: true, independent: true, rescued: true });
  assert.equal(outcome(guessed, corr).independent, false, '“I guessed” is not recall');
  assert.equal(outcome(revealed, corr).correct, false, 'a revealed answer marked correct is still not recalled');
  assert.deepEqual([outcome(hinted, corr).correct, outcome(hinted, corr).independent], [true, false]);
  const [day] = accuracySeries(events);
  assert.deepEqual([day.n, day.independentCorrect, day.rescued, day.overridden, day.revealed], [5, 2, 1, 3, 1]);
  assert.equal(summary(events, [], { today: '2026-01-05', now: T0, params }).firstAttemptAccuracy.p, 2 / 5);
  assert.equal(eventualSuccess(events).firstAttempt, 4 / 5, 'within sessions the rescue is a first-try success');
  const cardsById = new Map(events.filter((e) => e.type === 'review').map((e) => [e.cardId, { id: e.cardId, tags: [], suspended: false }]));
  const units = ['ra', 'rb', 'rc', 'rd', 're'].map((id) => ({ id, cardId: 'c1', deckId: 'd1', active: true, state: null }));
  const plan = analyzeExamPlan({ examDate: '2026-01-20', deckIds: [], tags: [], dailyMinutes: 30, targetCoverage: 1 }, { units, cardsById, events, today: '2026-01-05', now: T0, params });
  assert.deepEqual(plan.observedRecall, { n: 5, accuracy: 2 / 5 }, 'exam observed recall uses the same rule');
});

test('undone reviews and practice count nowhere: today, study time, activity, streaks, eventual success and observed recall', () => {
  const before = ev({ unitId: 'va', studyDay: '2026-01-04', activeMs: 3000 });
  const undone = ev({ unitId: 'vb', activeMs: 5000 });
  const undonePractice = ev({ unitId: 'vc', type: 'practice', mode: 'cram', activeMs: 7000 });
  const kept = ev({ unitId: 'vd', activeMs: 2000 });
  const voids = [corrOf('x1', undone.id, 'void', 'undo', T0 + 60000), corrOf('x2', undonePractice.id, 'void', 'undo', T0 + 60000)];
  const events = [before, undone, undonePractice, kept, ...voids];
  const s = summary(events, [], { today: '2026-01-05', now: T0, params });
  assert.deepEqual([s.reviewedToday, s.practicedToday, s.studyMsToday, s.studyMsTotal], [1, 0, 2000, 5000]);
  assert.equal(effectiveRetrievals(events).length, 2);
  const act = dailyActivity(events).get('2026-01-05');
  assert.deepEqual([act.reviews, act.practice, act.retrievals, act.studyMs], [1, 0, 1, 2000]);
  assert.equal(eventualSuccess(events).n, 2, 'undone answers are not session attempts');
  const cardsById = new Map([['c1', { id: 'c1', tags: [], suspended: false }]]);
  const units = ['va', 'vb', 'vc', 'vd'].map((id) => ({ id, cardId: 'c1', deckId: 'd1', active: true, state: null }));
  assert.equal(analyzeExamPlan({ examDate: '2026-01-20', dailyMinutes: 30 }, { units, cardsById, events, today: '2026-01-05', now: T0, params }).observedRecall.n, 2);

  // Incremental cache: the review was counted before its undo arrived.
  const onlyToday = ev({ unitId: 've', activeMs: 4000 });
  const days = dailyActivity([before, onlyToday]);
  assert.equal(currentStreak(days, '2026-01-05'), 2);
  dailyActivity([corrOf('x3', onlyToday.id, 'void', 'undo', T0 + 90000)], days);
  retractActivity(days, [onlyToday]);
  assert.deepEqual([days.get('2026-01-05').retrievals, days.get('2026-01-05').studyMs], [0, 0]);
  assert.equal(currentStreak(days, '2026-01-05'), 1, 'a day whose only review was undone was not studied');
  assert.equal(longestStreak(days), 1);
  assert.equal(currentStreak(dailyActivity([before, ev({ type: 'copy', studyDay: '2026-01-05' })]), '2026-01-06'), 0, 'copying a correction is not studying');
});

test('retrieval latency: average and median, and per week over time', () => {
  const lat = (ms, studyDay, adjusted = ms / 2) => ev({ studyDay, grading: { measurements: { raw: { latencyMs: ms }, adjusted: { latencyMs: adjusted } } } });
  const events = [lat(1000, '2026-01-05'), lat(2000, '2026-01-06'), lat(6000, '2026-01-07'), lat(4000, '2026-01-12'), lat(9000, '2026-01-12')];
  events.push(corrOf('v9', events[4].id, 'void', 'undo', T0 + DAY));
  const s = summary(events, [], { today: '2026-01-12', now: T0, params });
  assert.equal(s.meanLatencyMs, 3250);
  assert.equal(s.medianLatencyMs, 3000);
  assert.equal(s.meanAdjustedLatencyMs, 1625);
  const weeks = latencySeries(events);
  assert.deepEqual(weeks.map((w) => [w.key, w.n, w.meanMs, w.medianMs]), [['2026-01-05', 3, 3000, 2000], ['2026-01-12', 1, 4000, 4000]]);
});

test('confidence self-ratings are compared with correctness and the automatic grade; the last rating counts', () => {
  const rated = (correct, grade, confidence) => ev({ unitId: `sr${n}`, response: { correct }, grading: { grade, confidence } });
  const a = rated(true, 4, 0.9);
  const b = rated(true, 3, 0.7);
  const c = rated(false, 1, 0.8);
  const d = rated(false, 1, 0.8);
  const rating = (targetId, value, ts) => ({ id: `r${n++}`, type: 'self-rating', targetId, value, ts, deviceId: 'dev', seq: n });
  const events = [a, b, c, d, rating(a.id, 3, T0 + 10), rating(a.id, 5, T0 + 20), rating(b.id, 4, T0 + 10), rating(c.id, 2, T0 + 10), rating(d.id, 5, T0 + 10), rating('missing', 4, T0), rating(b.id, 9, T0 + 30),
    corrOf('cd', c.id, 'override', 'correct', T0 + 40), corrOf('vd', d.id, 'void', 'undo', T0 + 40)];
  const r = selfRatingAnalysis(events);
  assert.equal(r.n, 3, 'unknown targets, invalid values and undone answers are left out');
  const five = r.levels.find((l) => l.value === 5);
  assert.deepEqual([five.n, five.correct, five.meanGrade, five.meanConfidence], [1, 1, 4, 0.9], 'a later rating replaces an earlier one');
  const two = r.levels.find((l) => l.value === 2);
  assert.deepEqual([two.n, two.correct, two.meanGrade], [1, 1, 3], 'a rescued answer counts as correct, with its re-grade');
  assert.ok(two.accuracy.low < 1);
  assert.deepEqual(r.byGrade.map((g) => [g.grade, g.n, g.meanRating]), [[1, 0, null], [2, 0, null], [3, 2, 3], [4, 1, 5]]);
  assert.equal(r.meanRatingCorrect, 11 / 3);
  assert.equal(r.meanRatingIncorrect, null);
});

test('de-identified export includes self-ratings and corrections linked to their answer by hashed id', () => {
  const answer = ev({ type: 'practice', mode: 'cram', id: 'secret-answer' });
  const rows = deidentifiedRows([answer, { id: 'sr-secret', type: 'self-rating', targetId: answer.id, value: 4, unitId: 'u1', cardId: 'c1', deckId: 'd1', studyDay: '2026-01-05', ts: T0 }, corrOf('k-secret', answer.id, 'override', 'alias', T0)], { salt: 'fixed' });
  assert.equal(rows.length, 3);
  const [a, sr, k] = rows;
  assert.deepEqual([sr.type, sr.selfRating, sr.targetType, sr.target], ['self-rating', 4, 'practice', a.event]);
  assert.deepEqual([k.correctionReason, k.targetType, k.target, k.selfRating], ['alias', 'practice', a.event, null]);
  assert.equal(a.target, null);
  assert.equal(toCsv(rows).includes('secret'), false);
});

/** One session of `cards` cards; each answer takes `answerMs`, then `feedbackMs` until the next prompt. */
function session(id, { cards, answerMs, feedbackMs, mode = 'daily', deckId = 'd1', wasNew = false, start = T0, reask = () => false }) {
  const out = [];
  let t = start;
  const present = (unit, firstAttempt) => {
    t += answerMs;
    out.push({ id: `${id}-${out.length}`, type: mode === 'daily' ? 'review' : 'practice', mode, sessionId: id, unitId: unit, cardId: unit, deckId, ts: t, activeMs: answerMs, firstAttempt, wasNew, response: { correct: firstAttempt }, assistance: {} });
    t += feedbackMs;
  };
  for (let i = 0; i < cards; i++) {
    present(`${id}-u${i}`, true);
    if (reask(i)) present(`${id}-u${i}`, false);
  }
  return out;
}

test('session-time estimates use relevant scheduling history, include feedback and re-asks, and fall back when sparse', () => {
  const daily = session('day1', { cards: 30, answerMs: 4000, feedbackMs: 3000, reask: (i) => i % 10 === 0 });
  const costs = cardCosts(daily);
  assert.equal(costs.length, 30, 'a re-ask belongs to the same card');
  assert.equal(costs[0].presentations, 2);
  assert.equal(costs[1].ms, 7000, 'answer plus feedback until the next prompt');
  const m = durationModel(daily);
  assert.equal(m.review.basis, 'scheduled');
  assert.ok(Math.abs(m.review.seconds - (7 + 7 * 3 / 30)) < 1e-9, `re-asks add to the average (${m.review.seconds})`);
  assert.equal(m.review.provisional, false);
  assert.equal(m.new.provisional, true);
  assert.equal(m.new.seconds, PROVISIONAL_SECONDS.new);

  const speed = session('speed1', { cards: 60, answerMs: 1000, feedbackMs: 500, mode: 'speed', start: T0 + DAY });
  assert.equal(durationModel([...daily, ...speed]).review.seconds, m.review.seconds, 'Speed practice does not shrink the review estimate');
  assert.equal(durationModel(speed).review.basis, 'all', 'practice is the last fallback');
  assert.equal(durationModel(speed).review.seconds, 1.5);

  const other = session('day2', { cards: 25, answerMs: 9000, feedbackMs: 1000, deckId: 'd2', start: T0 + 2 * DAY });
  const both = [...daily, ...other];
  assert.equal(durationModel(both, { scope: (e) => e.deckId === 'd2' }).review.basis, 'scope');
  assert.equal(durationModel(both, { scope: (e) => e.deckId === 'd2' }).review.seconds, 10);
  const sparse = durationModel(both, { scope: (e) => e.deckId === 'd3' });
  assert.equal(sparse.review.basis, 'scheduled', 'too few cards in scope: all scheduling history');

  const breaks = session('day3', { cards: 21, answerMs: 4000, feedbackMs: 30 * 60000 });
  assert.equal(durationModel(breaks).review.seconds, (4000 + MAX_FEEDBACK_MS) / 1000, 'a long gap is a break, capped');
  assert.ok(SCHEDULING_MODES.has('catchup') && !SCHEDULING_MODES.has('cram'));
});

test('exam plans count from the start of the exam study day, whatever the time of day or DST', () => {
  const NY = { timeZone: 'America/New_York', rolloverHour: 4 };
  const cardsById = new Map([['c', { id: 'c', tags: [], suspended: false }]]);
  const examStart = studyDayStart('2026-03-10', NY);
  const unit = (id, due) => ({ id, cardId: 'c', deckId: 'd1', active: true, state: { state: State.Review, due, stability: 30, difficulty: 5, lapses: 0, reps: 3, last_review: due - 30 * DAY, elapsed_days: 0, scheduled_days: 30, learning_steps: 0 } });
  const units = [unit('before', examStart - 60000), unit('after', examStart + 60000)];
  const plan = { examDate: '2026-03-10', deckIds: [], tags: [], dailyMinutes: 20, targetCoverage: 1 };
  const morning = Date.UTC(2026, 2, 2, 14);
  const results = [morning, morning + 8 * 3600000].map((now) => analyzeExamPlan(plan, { units, cardsById, events: [], today: '2026-03-02', now, params, ...NY }));
  for (const r of results) {
    assert.equal(r.examInstant, examStart);
    assert.equal(r.dueBeforeExam, 1, 'due one minute before the exam day starts');
    assert.equal(r.daysLeft, 8);
  }
  assert.equal(examStart, Date.UTC(2026, 2, 10, 8), '04:00 EDT, after the DST change, not now + 8 × 24 h');
  assert.equal(results[0].predictedRecallAtExamWithoutStudy, results[1].predictedRecallAtExamWithoutStudy);
  const today = analyzeExamPlan({ ...plan, examDate: '2026-03-02' }, { units, cardsById, events: [], today: '2026-03-02', now: morning, params, ...NY });
  assert.equal(today.examInstant, morning, 'an exam today starts now');
});

test('exam workload includes the follow-up reviews the schedule asks for before the exam', () => {
  assert.equal(reviewSessionsBetween(null, T0, T0 + 30 * 60000, params), 1, 'learning steps on the introduction day are one session');
  const followed = reviewSessionsBetween(null, T0, T0 + 60 * DAY, params);
  assert.ok(followed >= 4, `a new card is reviewed again several times in 60 days (${followed})`);
  const young = { state: State.Review, due: T0 + DAY, stability: 2, difficulty: 5, lapses: 0, reps: 2, last_review: T0 - DAY, elapsed_days: 1, scheduled_days: 2, learning_steps: 0 };
  assert.ok(reviewSessionsBetween(young, T0, T0 + 60 * DAY, params) >= 3, 'a young card comes back more than once');
  assert.equal(reviewSessionsBetween(young, T0, T0 + DAY, params), 0, 'not due before the exam');

  const cardsById = new Map([['c1', { id: 'c1', tags: [], suspended: false }], ['c2', { id: 'c2', tags: [], suspended: false }]]);
  const units = [{ id: 'u1', cardId: 'c1', deckId: 'd1', active: true, state: young }, { id: 'u2', cardId: 'c2', deckId: 'd1', active: true, state: null }];
  const r = analyzeExamPlan({ examDate: '2026-03-06', deckIds: [], tags: [], dailyMinutes: 1, targetCoverage: 1 }, { units, cardsById, events: [], today: '2026-01-05', now: T0, params });
  assert.equal(r.dueBeforeExam, 1);
  assert.equal(r.toIntroduce, 1);
  assert.ok(r.expectedReviews > r.dueBeforeExam + 3, `repeat reviews and follow-ups of the new card count (${r.expectedReviews})`);
  const once = r.toIntroduce * PROVISIONAL_SECONDS.new + r.dueBeforeExam * PROVISIONAL_SECONDS.review + r.weak * PROVISIONAL_SECONDS.review;
  assert.ok(r.estimatedMinutes * 60 > once + 3 * PROVISIONAL_SECONDS.review, 'more than counting each due card once');
  assert.equal(r.timing.review.basis, 'default');
});

test('weak topics aggregate weak cards by tag, or by deck for untagged cards, ignoring a tag every card shares', () => {
  const cardsById = new Map();
  const units = [];
  const learned = { state: State.Review, due: T0 + 5 * DAY, stability: 20, difficulty: 5, lapses: 0, reps: 3, last_review: T0 - DAY, elapsed_days: 1, scheduled_days: 6, learning_steps: 0 };
  const add = (id, deckId, tags, missed, state = learned) => {
    cardsById.set(id, { id, tags, suspended: false });
    units.push({ id: `${id}:fwd`, cardId: id, deckId, active: true, state, perf: { recent: [{ c: !missed }] } });
  };
  for (let i = 0; i < 4; i++) add(`cell${i}`, 'd1', ['bio', 'cell'], false);
  for (let i = 0; i < 4; i++) add(`gen${i}`, 'd1', ['bio', 'genetics'], i < 3);
  add('gen-new', 'd1', ['bio', 'genetics'], false, null);
  for (let i = 0; i < 5; i++) add(`plain${i}`, 'd2', [], i === 0);
  const ctx = { units, cardsById, events: [], today: '2026-01-05', now: T0, params };
  const bio = analyzeExamPlan({ examDate: '2026-02-01', tags: ['bio'], dailyMinutes: 30 }, ctx);
  assert.equal(bio.weak, 3);
  assert.deepEqual(bio.weakTopics, [{ kind: 'tag', id: 'genetics', units: 5, studied: 4, weak: 3 }], 'the plan’s own tag is not a topic');
  const all = analyzeExamPlan({ examDate: '2026-02-01', dailyMinutes: 30 }, ctx);
  assert.deepEqual(all.weakTopics.map((t) => [t.kind, t.id, t.weak]), [['tag', 'genetics', 3], ['tag', 'bio', 3], ['deck', 'd2', 1]], 'weakest share first; untagged cards are grouped by deck; 1 of 5 is a fifth');
  const topics = topicBreakdown(units, cardsById, new Set());
  assert.ok(topics.some((t) => t.id === 'cell' && t.weak === 0));
});

test('deck trends cover exactly the last calendar weeks', () => {
  assert.deepEqual(recentWeeks('2026-01-07', 3), ['2025-12-22', '2025-12-29', '2026-01-05']);
  const events = [ev({ studyDay: '2025-12-21' }), ev({ studyDay: '2025-12-22' }), ev({ studyDay: '2026-01-07', response: { correct: false } })];
  const rows = deckTrends(events, { today: '2026-01-07', weeks: 3 }).get('d1');
  assert.deepEqual(rows.map((r) => [r.week, r.n, r.correct]), [['2025-12-22', 1, 1], ['2026-01-05', 1, 0]]);
});

test('predicted recall is flagged as incomplete for units practised since their last scheduled review', () => {
  const state = { state: State.Review, due: T0 + 5 * DAY, stability: 20, difficulty: 5, lapses: 0, reps: 3, last_review: T0 - DAY, elapsed_days: 1, scheduled_days: 6, learning_steps: 0 };
  const units = [{ id: 'p1', active: true, state, practiceSinceLast: true }, { id: 'p2', active: true, state }, { id: 'p3', active: true, state: null, practiceSinceLast: true }];
  const s = summary([ev({ type: 'practice', mode: 'cram' })], units, { today: '2026-01-05', now: T0, params });
  assert.deepEqual([s.predictedRecallUnits, s.practicedUnits, s.practiceSinceModel], [2, 1, true]);
  assert.equal(summary([ev({ type: 'practice', mode: 'cram' })], [units[1]], { today: '2026-01-05', now: T0, params }).practiceSinceModel, false, 'old practice already followed by a scheduled review does not count');
});

function fakeClock() {
  let t = 1000;
  let w = T0;
  return { now: () => t, wall: () => w, advance(ms) { t += ms; w += ms; }, jumpWall(ms) { w += ms; } };
}

test('trial recorder measures latency, typing time, corrections and pauses on the active clock', () => {
  const c = fakeClock();
  const r = new TrialRecorder({ now: c.now, wall: c.wall });
  r.start();
  c.advance(1200);
  const typeChar = (v) => {
    r.onKeydown({ key: 'a', code: 'KeyA' });
    r.onInput({ inputType: 'insertText' }, { value: v });
  };
  typeChar('a');
  for (const ch of 'bcd') {
    c.advance(150);
    typeChar(ch);
  }
  c.advance(150);
  r.onInput({ inputType: 'deleteContentBackward' }, { value: 'abc' });
  c.advance(100);
  r.onInput({ inputType: 'deleteContentBackward' }, { value: 'ab' });
  c.advance(3000); // long pause mid-answer
  typeChar('abx');
  c.advance(200);
  const m = r.finish('abx');
  assert.equal(m.latencyMs, 1200);
  assert.equal(m.totalMs, 1200 + 450 + 250 + 3000 + 200);
  assert.equal(m.typingMs, m.totalMs - 1200);
  assert.equal(m.backspaces, 2);
  assert.equal(m.corrections, 1, 'one deletion burst = one correction');
  assert.equal(m.pauses, 1);
  assert.equal(m.firstOrigin, 'typed');
  assert.equal(m.clockAnomaly, null);
});

test('hidden time and in-session editing are excluded from durations', () => {
  const c = fakeClock();
  const r = new TrialRecorder({ now: c.now, wall: c.wall });
  r.start();
  c.advance(500);
  r.pause('hidden');
  c.advance(60000);
  r.resume();
  c.advance(500);
  r.pause('editor');
  c.advance(20000);
  r.resume();
  c.advance(300);
  r.onInput({ inputType: 'insertText' }, { value: 'x' });
  c.advance(700);
  const m = r.finish('x');
  assert.equal(m.latencyMs, 1300);
  assert.equal(m.totalMs, 2000);
  assert.equal(m.hiddenMs, 60000);
  assert.equal(m.editorMs, 20000);
  assert.equal(m.interruptedByHidden, true);
  assert.equal(r.editorOpened, true);
});

test('paste, dictation, toolbar and composition origins are recorded; inputs while paused are ignored', () => {
  const c = fakeClock();
  const r = new TrialRecorder({ now: c.now, wall: c.wall });
  r.start();
  c.advance(800);
  r.onInput({ inputType: 'insertFromPaste' }, { value: 'pasted' });
  r.onInput({ inputType: 'insertFromDictation' }, { value: 'pasted words' });
  r.onInput(null, { origin: 'toolbar', value: 'pasted words²' });
  r.onComposition('start');
  r.onInput({ inputType: 'insertCompositionText', isComposing: true }, { value: 'x' });
  r.pause('hidden');
  r.onInput({ inputType: 'insertText' }, { value: 'ignored' });
  r.resume();
  const m = r.finish('pasted words²');
  assert.equal(m.firstOrigin, 'paste');
  assert.deepEqual([m.origins.paste, m.origins.dictation, m.origins.toolbar, m.origins.composition], [1, 1, 1, 2]);
  assert.equal(m.inputEvents, 4);
});

test('text arriving without key presses after a pen touched the field counts as handwriting', () => {
  const c = fakeClock();
  const r = new TrialRecorder({ now: c.now, wall: c.wall });
  r.start({ lastPointerType: 'mouse' });
  c.advance(900);
  r.onPointer({ pointerType: 'pen' }, { inField: true }); // pen starts writing
  c.advance(1500); // recognised after the word is written
  r.onInput({ inputType: 'insertText' }, { value: 'Paris' });
  c.advance(300);
  const m = r.finish('Paris');
  assert.equal(m.firstOrigin, 'handwriting');
  assert.equal(m.origins.handwriting, 1);
  assert.equal(m.latencyMs, 900, 'latency runs to the first pen stroke, not to recognition');
  assert.equal(r.signals.handwritingInputs, 1);
  assert.equal(r.signals.inputsWithoutKeydown, 0, 'not counted as on-screen keyboard evidence');
  // With a key press the same input is typing, even after a pen tap.
  const k = new TrialRecorder({ now: c.now, wall: c.wall });
  k.start({ lastPointerType: 'pen' });
  c.advance(800);
  k.onKeydown({ key: 'P', code: 'KeyP' });
  k.onInput({ inputType: 'insertText' }, { value: 'P' });
  assert.equal(k.finish('P').firstOrigin, 'typed');
  // Explicit origins (toolbar, voice) are never re-labelled.
  const t = new TrialRecorder({ now: c.now, wall: c.wall });
  t.start({ lastPointerType: 'pen' });
  t.onInput(null, { origin: 'toolbar', value: '²' });
  assert.equal(t.finish('²').firstOrigin, 'toolbar');
});

test('handwriting-pad strokes start the answer clock and count as their own input origin', () => {
  const c = fakeClock();
  const r = new TrialRecorder({ now: c.now, wall: c.wall });
  r.start({ lastPointerType: 'pen' });
  c.advance(1200);
  r.onInkStroke();
  c.advance(800);
  r.onInkStroke();
  c.advance(500);
  const m = r.finish('');
  assert.equal(m.latencyMs, 1200, 'latency runs to the first stroke');
  assert.equal(m.firstOrigin, 'ink');
  assert.equal(m.origins.ink, 2);
  assert.equal(m.origins.typed, 0);
  assert.equal(r.signals.inkStrokes, 2);
  assert.equal(m.answerLength, 0);
  // Strokes while paused (page hidden) are not counted.
  const p = new TrialRecorder({ now: c.now, wall: c.wall });
  p.start({});
  p.pause('hidden');
  p.onInkStroke();
  p.resume();
  assert.equal(p.finish('').origins.ink, 0);
});

test('the focus-timer screen clock counts only unheld time, whatever overlaps', async () => {
  const { ScreenClock } = await import('../../js/study/trial.js');
  const c = fakeClock();
  const s = new ScreenClock({ now: c.now });
  assert.equal(s.elapsed(), 0, 'not started');
  s.start();
  c.advance(1000);
  s.hold('paused');
  c.advance(5000);
  s.hold('hidden'); // overlapping holds
  c.advance(5000);
  s.release('paused');
  c.advance(5000); // still hidden
  assert.equal(s.elapsed(), 1000);
  s.release('hidden');
  c.advance(2000);
  assert.equal(s.elapsed(), 3000);
  s.release('hidden'); // releasing twice changes nothing
  assert.equal(s.elapsed(), 3000);
  s.hold('hidden');
  s.start(); // a new lap while hidden starts held
  c.advance(4000);
  assert.equal(s.elapsed(), 0);
  s.release('hidden');
  c.advance(500);
  assert.equal(s.elapsed(), 500);
});

test('a wall-clock jump during a presentation is flagged without affecting durations', () => {
  const c = fakeClock();
  const r = new TrialRecorder({ now: c.now, wall: c.wall });
  r.start();
  c.advance(1000);
  r.onInput({ inputType: 'insertText' }, { value: 'a' });
  c.jumpWall(-3600000);
  c.advance(500);
  const m = r.finish('a');
  assert.equal(m.totalMs, 1500);
  assert.equal(m.clockAnomaly, 'backward');
});
