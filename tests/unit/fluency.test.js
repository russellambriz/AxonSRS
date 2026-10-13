// Spec 12.6–12.7 and 17.1–17.5, 17.20–17.21: time-based grading across
// device baselines, sparse calibration, reading-time adjustments, unknown
// modality, assistance rules, calibration exclusion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeReview, readingFloor, promptStats, classifyModality, createBaseline, addSample, removeSample, baselineStats, baselineKey, calibrationSample, calibrationLevel, overrideGrade, DEFAULT_GRADING_CONFIG, mergeGradingConfig, adjustMeasurements } from '../../js/core/fluency.js';

const LN = (ms) => Math.log(ms + 250);
// Reading floor for the default 3-word prompt: 250 + 3 × 160 ms.
const FLOOR = 730;

/**
 * Baseline with n samples around a typical *raw* latency for the default
 * prompt. Samples hold adjusted latency (raw − reading floor), as real
 * calibration samples do.
 */
function baseline(key, n, rawLatencyMs = 1500, msPerEffort = 200, spread = 0.25) {
  const latencyMs = Math.max(0, rawLatencyMs - FLOOR);
  let b = createBaseline(key);
  for (let i = 0; i < n; i++) {
    const jitter = ((i % 7) - 3) / 3; // deterministic spread in [-1, 1]
    b = addSample(b, { eventId: `e${i}`, ts: i, lnLatency: LN(latencyMs) + jitter * spread, lnMsPerEffort: Math.log(msPerEffort) + jitter * spread });
  }
  return b;
}

function trial({ latencyMs = 1500, typingMs = 1200, effort = 6, modality = 'physical', conf = 0.9, taskType = 'recall', correct = true, typo = false, hint = false, revealed = false, solution = false, corrections = 0, pauses = 0, prompt = 'Capital of Australia?', warmup = false, prev = { correct: true, assisted: false, grade: 3 }, origins = { typed: 6 } } = {}) {
  return {
    correct,
    typoTolerated: typo,
    taskType,
    raw: { latencyMs, typingMs, totalMs: latencyMs + typingMs, effort, answerLength: effort, corrections, pauses, longestGapMs: 400, hiddenMs: 0, origins },
    modality: { kind: modality, confidence: conf },
    prompt: promptStats(prompt),
    assistance: { hintShown: hint, revealed, solutionViewed: solution },
    isWarmup: warmup,
    history: { previousScheduled: prev },
  };
}

const personal = baseline('physical|recall', 40);

test('accuracy dominates: incorrect, revealed and solution-viewed answers are Again', () => {
  assert.equal(gradeReview(trial({ correct: false, latencyMs: 300 }), personal).grade, 1);
  assert.equal(gradeReview(trial({ revealed: true }), personal).grade, 1);
  assert.equal(gradeReview(trial({ solution: true }), personal).grade, 1);
  const fastWrong = gradeReview(trial({ correct: false, latencyMs: 200, typingMs: 100 }), personal);
  assert.deepEqual(fastWrong.reasons, ['INCORRECT'], 'fast guessing is never rewarded');
});

test('typical fluent answer → Good; hesitant → Hard; consistently rapid → Easy', () => {
  assert.equal(gradeReview(trial({ latencyMs: 1500 }), personal).grade, 3);
  const slow = gradeReview(trial({ latencyMs: 6000 }), personal);
  assert.equal(slow.grade, 2);
  assert.ok(slow.reasons.includes('HESITANT'));
  const fast = gradeReview(trial({ latencyMs: 800, typingMs: 600 }), personal);
  assert.equal(fast.grade, 4);
  assert.ok(fast.reasons.includes('RAPID_CONSISTENT'));
});

test('Easy needs history and consistency, never shortness alone', () => {
  const noHistory = gradeReview(trial({ latencyMs: 800, typingMs: 600, prev: null }), personal);
  assert.equal(noHistory.grade, 3);
  assert.ok(noHistory.reasons.includes('EASY_NEEDS_HISTORY'));
  const prevHard = gradeReview(trial({ latencyMs: 800, typingMs: 600, prev: { correct: true, assisted: false, grade: 2 } }), personal);
  assert.equal(prevHard.grade, 3);
  // A one-character answer typed instantly: typing speed is uninformative,
  // and with a typical latency it stays Good.
  const short = gradeReview(trial({ latencyMs: 1500, typingMs: 50, effort: 1 }), personal);
  assert.equal(short.grade, 3);
  const corrected = gradeReview(trial({ latencyMs: 800, typingMs: 600, corrections: 1 }), personal);
  assert.notEqual(corrected.grade, 4);
});

test('typo-tolerated answers never get Easy; hints cap at the configured ceiling', () => {
  const typo = gradeReview(trial({ latencyMs: 800, typingMs: 600, typo: true }), personal);
  assert.equal(typo.grade, 3);
  assert.ok(typo.reasons.includes('TYPO_NO_EASY'));
  const hintGood = gradeReview(trial({ latencyMs: 800, typingMs: 600, hint: true }), personal);
  assert.equal(hintGood.grade, 3);
  const hintHardCfg = mergeGradingConfig({ hintCeiling: 'hard' });
  assert.equal(gradeReview(trial({ latencyMs: 800, hint: true }), personal, hintHardCfg).grade, 2);
});

test('sparse calibration is conservative: none → Good; provisional → no Easy, Hard only when extreme', () => {
  const none = baseline('physical|recall', 3);
  const r0 = gradeReview(trial({ latencyMs: 9000 }), none);
  assert.equal(r0.grade, 3);
  assert.ok(r0.reasons.includes('CALIBRATION_NONE'));
  assert.equal(gradeReview(trial({ latencyMs: 300, typingMs: 400 }), none).grade, 3);
  const prov = baseline('physical|recall', 12);
  assert.equal(calibrationLevel(12), 'provisional');
  assert.equal(gradeReview(trial({ latencyMs: 400, typingMs: 400 }), prov).grade, 3, 'no Easy while provisional');
  assert.equal(gradeReview(trial({ latencyMs: 2600 }), prov).grade, 3, 'mild hesitation is not Hard while provisional');
  assert.equal(gradeReview(trial({ latencyMs: 20000 }), prov).grade, 2);
  assert.equal(gradeReview(trial({ latencyMs: 1500 }), createBaseline('x')).grade, 3, 'first review ever');
});

test('device baselines are separate: phone typing is not compared with desktop typing', () => {
  const touch = baseline('touch|recall', 40, 2600, 420);
  // 2.6 s is typical on this person's phone but slow on their keyboard.
  assert.equal(gradeReview(trial({ latencyMs: 2600, typingMs: 2500, modality: 'touch' }), touch).grade, 3);
  assert.equal(gradeReview(trial({ latencyMs: 4200, typingMs: 2500, modality: 'physical' }), personal).grade, 2);
  assert.notEqual(baselineKey('touch', 'recall'), baselineKey('physical', 'recall'));
});

test('task types: separate baselines and correctness-led grading for problem solving', () => {
  const calcFew = baseline('physical|calculation', 10);
  const slowCalc = gradeReview(trial({ latencyMs: 25000, taskType: 'calculation' }), calcFew);
  assert.equal(slowCalc.grade, 3, 'a slow correct calculation is not Hard');
  assert.ok(slowCalc.reasons.includes('CORRECTNESS_LED_TASK'));
  // Even with plenty of history, a calculation is judged against calculation timings.
  const calcMany = baseline('physical|calculation', 40, 12000, 400);
  assert.equal(gradeReview(trial({ latencyMs: 12000, taskType: 'calculation' }), calcMany).grade, 3);
  assert.equal(gradeReview(trial({ latencyMs: 12000, taskType: 'multistep' }), baseline('physical|multistep', 5)).grade, 3);
});

test('unreliable timing falls back to Good (correct) and stays Again (incorrect)', () => {
  const cases = [
    trial({ modality: 'unknown', conf: 0.2, latencyMs: 9000 }),
    trial({ conf: 0.4, latencyMs: 9000 }),
    { ...trial({ latencyMs: 9000 }), raw: { ...trial().raw, latencyMs: 9000, hiddenMs: 5000, interruptedByHidden: true } },
    { ...trial({ latencyMs: 9000 }), editorOpened: true },
    { ...trial({ latencyMs: 9000 }), clockAnomaly: true },
    trial({ latencyMs: 9000, origins: { paste: 1 } }),
    trial({ latencyMs: 60, typingMs: 100 }),
  ];
  for (const t of cases) {
    const r = gradeReview(t, personal);
    assert.equal(r.grade, 3, JSON.stringify(r.reasons));
    assert.ok(r.reasons.includes('TIMING_UNRELIABLE'));
    assert.ok(r.confidence <= 0.35);
  }
  const wrong = gradeReview({ ...trial({ correct: false, modality: 'unknown', conf: 0 }) }, personal);
  assert.equal(wrong.grade, 1);
});

test('reading-time floor: bounded, never negative latency, never alone produces Easy', () => {
  const long = 'In the context of oxidative phosphorylation, which mobile electron carrier transfers electrons from complex III to complex IV of the chain?';
  const s = promptStats(long);
  const floor = readingFloor(s);
  assert.ok(floor.ms > 0 && floor.ms <= DEFAULT_GRADING_CONFIG.reading.maxMs);
  const t = trial({ prompt: long, latencyMs: 900, typingMs: 900 });
  const adj = adjustMeasurements(t);
  assert.equal(adj.adjusted.latencyMs, 0, 'clamped at zero');
  // Fast only because a long reading estimate was subtracted → not Easy
  const r = gradeReview(trial({ prompt: long, latencyMs: floor.ms + 250, typingMs: 900 }), personal);
  assert.notEqual(r.grade, 4);
  assert.ok(r.reasons.includes('READING_ADJUSTMENT_DOMINANT'));
  // Long prompts no longer cause Hard just for reading time
  const longOk = gradeReview(trial({ prompt: long, latencyMs: 4500 }), personal);
  assert.equal(longOk.grade, 3);
  // Too complex for a reliable estimate → conservative fallback
  const huge = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
  const rHuge = gradeReview(trial({ prompt: huge, latencyMs: 30000 }), personal);
  assert.equal(rHuge.grade, 3);
  assert.ok(rHuge.reasons.includes('READING_UNRELIABLE'));
  // Heuristics can be disabled; raw measurements are kept either way
  const off = mergeGradingConfig({ heuristicsEnabled: false });
  const rOff = gradeReview(trial({ prompt: long, latencyMs: 4500 }), personal, off);
  assert.equal(rOff.measurements.raw.latencyMs, 4500);
  assert.equal(rOff.measurements.adjusted.latencyMs, 4500);
  assert.equal(readingFloor(s, off).ms, 0);
});

test('warm-up leniency on the first card, but it never earns Easy', () => {
  const borderline = gradeReview(trial({ latencyMs: 3200 }), personal);
  const warm = gradeReview(trial({ latencyMs: 3200, warmup: true }), personal);
  assert.ok(warm.grade >= borderline.grade);
  assert.ok(warm.reasons.includes('WARMUP_APPLIED'));
  assert.ok(warm.measurements.warmupMs <= DEFAULT_GRADING_CONFIG.warmupMaxMs);
});

test('every grade stores reasons, explanation, confidence (uncalibrated) and versions', () => {
  const r = gradeReview(trial({ latencyMs: 1500 }), personal);
  assert.ok(r.reasons.length);
  assert.ok(r.explanation.length > 10);
  assert.equal(r.confidenceIsCalibrated, false);
  assert.ok(r.confidence > 0 && r.confidence < 1);
  assert.match(r.ruleVersion, /axon-fluency@/);
  assert.ok(r.measurements.raw && r.measurements.adjusted);
  assert.ok(r.config.thresholds);
});

test('modality detection: physical, touch, voice and unknown with confidence', () => {
  assert.equal(classifyModality({ textInputs: 8, keydownWithCode: 8, finePointer: true }).kind, 'physical');
  assert.equal(classifyModality({ textInputs: 8, keydownUnidentified: 8, viewportShrunk: true, coarsePointer: true, lastPointerType: 'touch' }).kind, 'touch');
  assert.equal(classifyModality({ textInputs: 1, voiceInputs: 1 }).kind, 'voice');
  assert.equal(classifyModality({ textInputs: 0 }).kind, 'unknown');
  assert.equal(classifyModality({ textInputs: 6, keydownWithCode: 6, viewportShrunk: true, lastPointerType: 'touch' }).kind, 'unknown', 'conflicting signals are not forced');
  const o = classifyModality({}, 'touch');
  assert.deepEqual([o.kind, o.source], ['touch', 'override']);
});

test('calibration samples exclude assisted, typo, override, practice, unknown and unreliable answers', () => {
  const ok = calibrationSample(trial(), gradeReview(trial(), personal), { eventId: 'a', mode: 'daily' });
  assert.ok(ok.eligible);
  assert.equal(ok.key, 'physical|recall');
  const bad = [
    [trial({ hint: true }), 'assisted'],
    [trial({ typo: true }), 'typo-tolerated'],
    [trial({ correct: false }), 'incorrect'],
    [trial({ modality: 'unknown', conf: 0 }), 'modality-unknown'],
    [{ ...trial(), override: true }, 'user-override'],
    [{ ...trial(), correctionCopy: true }, 'correction-copy'],
  ];
  for (const [t, reason] of bad) {
    const c = calibrationSample(t, gradeReview(t, personal), { eventId: 'x', mode: 'daily' });
    assert.equal(c.eligible, false);
    assert.ok(c.reasons.includes(reason), `${reason} in ${c.reasons}`);
  }
  assert.ok(calibrationSample(trial(), gradeReview(trial(), personal), { mode: 'speed' }).reasons.includes('speed-practice'));
  // toolbar-heavy and voice inputs: latency may count, typing speed does not
  const tb = adjustMeasurements(trial({ origins: { toolbar: 4, typed: 2 } }));
  assert.ok(Number.isNaN(tb.adjusted.msPerEffort));
  assert.ok(tb.excluded.some((e) => e.reason === 'TOOLBAR_HEAVY'));
});

test('baselines are rolling, robust and support exact removal (undo)', () => {
  let b = baseline('physical|recall', 10);
  const before = baselineStats(b).n;
  b = addSample(b, { eventId: 'e3', lnLatency: 1 });
  assert.equal(baselineStats(b).n, before, 'same event id replaces, never duplicates');
  b = removeSample(b, 'e4');
  assert.equal(baselineStats(b).n, before - 1);
  let big = createBaseline('k');
  for (let i = 0; i < 260; i++) big = addSample(big, { eventId: String(i), lnLatency: 7 });
  assert.equal(big.samples.length, DEFAULT_GRADING_CONFIG.baselineWindow);
  // an outlier barely moves the median
  const robust = addSample(baseline('k', 30), { eventId: 'out', lnLatency: LN(600000) });
  assert.ok(Math.abs(baselineStats(robust).latencyMedianMs - baselineStats(baseline('k', 30)).latencyMedianMs) < 100);
});

test('overrides: knew raises, guessed never Easy, alias rescue is Good', () => {
  assert.equal(overrideGrade('knew', 2).grade, 3);
  assert.equal(overrideGrade('knew', 3).grade, 4);
  assert.equal(overrideGrade('guessed', 4).grade, 2);
  assert.equal(overrideGrade('guessed', 3, mergeGradingConfig({ guessedGrade: 'again' })).grade, 1);
  assert.equal(overrideGrade('alias', 1).grade, 3);
});
