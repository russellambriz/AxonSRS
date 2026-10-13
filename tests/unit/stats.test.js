// Spec 9, 16.8, 16.9, 17.20: exposure-aware statistics, workload and exam
// plans, research comparison, and per-presentation measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerClass, correctionIndex, dailyActivity, currentStreak, longestStreak, accuracySeries,
  summary, eventualSuccess, retentionCalibration, forecast, exposureBreakdown, unitHistory, heatmapLevels, isLeech,
} from '../../js/core/stats.js';
import { durationModel, estimateSessionMinutes, catchUpPlan, analyzeExamPlan, PROVISIONAL_SECONDS, MIN_SAMPLES_FOR_ESTIMATE } from '../../js/core/planner.js';
import { assignArm, createStudy, comparisonReport, deidentifiedRows, toCsv } from '../../js/core/research.js';
import { TrialRecorder } from '../../js/study/trial.js';
import { schedulerParams, State } from '../../js/core/scheduler.js';
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
