/**
 * Layer B — Axon Retrieval Fluency: automatic grade inference.
 *
 * Converts observed answer behaviour into an FSRS rating without asking
 * the learner to press Again/Hard/Good/Easy. Principles:
 *
 *  1. Accuracy dominates. Incorrect → Again, full reveal → Again.
 *  2. Timing can only move a *correct, independent* answer between
 *     Hard, Good and Easy — and only when timing is trustworthy and the
 *     learner has enough calibration data for the input modality and
 *     task type. Otherwise the answer is graded Good.
 *  3. Easy requires evidence of consistent fluency (fast now, fluent last
 *     time, no corrections or pauses) — never shortness alone, never a
 *     typo-tolerated answer, never a hinted answer, never a reading-time
 *     adjustment doing most of the work.
 *  4. Every decision stores raw and adjusted measurements, reason codes,
 *     a human explanation, a heuristic confidence and the rule version.
 *
 * The first-keystroke latency is a *proxy* for retrieval latency, not a
 * measurement of memory strength.
 */

import { GRADING_VERSION, READING_HEURISTIC_VERSION } from '../config.js';
import { median, mad, clamp } from './util.js';

export const GRADE = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });
const GRADE_NAME = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

export const MODALITIES = Object.freeze(['physical', 'touch', 'voice', 'unknown']);
export const MODALITY_LABELS = Object.freeze({ physical: 'Physical keyboard', touch: 'Touchscreen keyboard', voice: 'Voice', unknown: 'Unknown / other' });

export const DEFAULT_GRADING_CONFIG = Object.freeze({
  version: GRADING_VERSION,
  heuristicsEnabled: true,
  reading: Object.freeze({
    version: READING_HEURISTIC_VERSION,
    baseMs: 250,
    msPerWord: 160,
    msPerMathToken: 120,
    msPerImage: 700,
    maxMs: 4000,
    maxReliableWords: 60,
    maxReliableImages: 1,
  }),
  warmupMs: 1500,
  warmupMaxMs: 3000,
  idleCapMs: 30000,
  anticipatoryMs: 120,
  minModalityConfidence: 0.6,
  minSamples: Object.freeze({ provisional: 8, personal: 25, problemSolving: 30 }),
  thresholds: Object.freeze({ hard: 1.0, easy: -0.8, provisionalHard: 2.0 }),
  weights: Object.freeze({ typing: 0.35, correction: 0.25, pause: 0.35 }),
  hintCeiling: 'good', // 'hard' | 'good'
  guessedGrade: 'hard', // 'again' | 'hard'
  maxReadingShareForEasy: 0.5,
  minEffortForTyping: 4,
  baselineWindow: 200,
  // Conservative population priors, used only to blend while personal data accumulates.
  priors: Object.freeze({
    physical: Object.freeze({ latencyMs: 1800, latencyScale: 0.55, msPerEffort: 220, typingScale: 0.45 }),
    touch: Object.freeze({ latencyMs: 2300, latencyScale: 0.6, msPerEffort: 360, typingScale: 0.5 }),
    voice: Object.freeze({ latencyMs: 2000, latencyScale: 0.6, msPerEffort: 150, typingScale: 0.6 }),
  }),
});

export function mergeGradingConfig(overrides = {}) {
  const base = DEFAULT_GRADING_CONFIG;
  return {
    ...base,
    ...overrides,
    reading: { ...base.reading, ...(overrides.reading || {}) },
    minSamples: { ...base.minSamples, ...(overrides.minSamples || {}) },
    thresholds: { ...base.thresholds, ...(overrides.thresholds || {}) },
    weights: { ...base.weights, ...(overrides.weights || {}) },
    priors: { ...base.priors, ...(overrides.priors || {}) },
    version: GRADING_VERSION,
  };
}

/* ------------------------------------------------------------------ */
/* Prompt complexity and reading-time floor (heuristic)                */
/* ------------------------------------------------------------------ */

/** Count words, math tokens and images in a prompt's Markdown source. */
export function promptStats(markdown) {
  const text = String(markdown || '');
  const images = (text.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length;
  const mathSegments = text.match(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g) || [];
  let mathTokens = 0;
  for (const seg of mathSegments) mathTokens += (seg.match(/\\[A-Za-z]+|[A-Za-z0-9]+|[^\sA-Za-z0-9\\${}]/g) || []).length;
  const prose = text
    .replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>[\]()|-]/g, ' ');
  const words = prose.split(/\s+/).filter(Boolean).length;
  return { chars: text.length, words, mathTokens, images };
}

/**
 * Estimated time to read the prompt before retrieval can begin.
 * Heuristic, versioned and bounded; never a measurement.
 */
export function readingFloor(stats, config = DEFAULT_GRADING_CONFIG) {
  const r = config.reading;
  if (!config.heuristicsEnabled) return { ms: 0, applied: false, reliable: true, version: r.version };
  const estimate = r.baseMs + stats.words * r.msPerWord + stats.mathTokens * r.msPerMathToken + stats.images * r.msPerImage;
  const reliable = stats.words <= r.maxReliableWords && stats.images <= r.maxReliableImages && estimate <= r.maxMs * 1.5;
  return { ms: Math.round(Math.min(estimate, r.maxMs)), estimateMs: Math.round(estimate), applied: true, reliable, version: r.version };
}

/* ------------------------------------------------------------------ */
/* Input modality                                                       */
/* ------------------------------------------------------------------ */

/**
 * Classify the input modality for one review from collected signals.
 * Returns { kind, confidence, evidence } where kind may be 'unknown'.
 */
export function classifyModality(signals = {}, override = null) {
  if (override && override !== 'auto') {
    return { kind: override, confidence: 1, source: 'override', evidence: ['user override'] };
  }
  const s = {
    textInputs: 0,
    keydownWithCode: 0,
    keydownUnidentified: 0,
    inputsWithoutKeydown: 0,
    viewportShrunk: false,
    lastPointerType: null,
    coarsePointer: false,
    finePointer: false,
    voiceInputs: 0,
    dictationInputs: 0,
    ...signals,
  };
  const evidence = [];
  if (s.voiceInputs > 0 || s.dictationInputs > 0) {
    const typed = s.textInputs - s.voiceInputs - s.dictationInputs;
    if (typed <= 1) return { kind: 'voice', confidence: s.voiceInputs > 0 ? 0.95 : 0.75, source: 'detected', evidence: ['speech input'] };
    return { kind: 'unknown', confidence: 0.3, source: 'detected', evidence: ['mixed speech and typing'] };
  }
  const n = Math.max(1, s.textInputs);
  let physical = 0;
  let touch = 0;
  const codedRatio = s.keydownWithCode / n;
  const uncodedRatio = (s.keydownUnidentified + s.inputsWithoutKeydown) / n;
  if (codedRatio >= 0.7) { physical += 0.6; evidence.push('keydown events carry physical key codes'); }
  else if (codedRatio >= 0.4) { physical += 0.3; evidence.push('some keydown events carry key codes'); }
  if (uncodedRatio >= 0.6) { touch += 0.5; evidence.push('input events without physical key codes'); }
  else if (uncodedRatio >= 0.3) { touch += 0.25; }
  if (s.viewportShrunk) { touch += 0.4; evidence.push('visual viewport shrank (on-screen keyboard)'); }
  else if (s.textInputs > 0 && s.coarsePointer && codedRatio >= 0.7) { physical += 0.2; evidence.push('coarse pointer device but no on-screen keyboard'); }
  if (s.lastPointerType === 'touch' || s.lastPointerType === 'pen') { touch += 0.15; evidence.push(`last pointer was ${s.lastPointerType}`); }
  if (s.lastPointerType === 'mouse') physical += 0.1;
  if (!s.coarsePointer && s.finePointer) physical += 0.1;
  if (s.textInputs === 0) return { kind: 'unknown', confidence: 0, source: 'detected', evidence: ['no typed input'] };
  const total = physical + touch;
  if (total < 0.4) return { kind: 'unknown', confidence: 0.2, source: 'detected', evidence };
  const margin = Math.abs(physical - touch);
  const kind = physical > touch ? 'physical' : 'touch';
  const confidence = clamp(0.35 + margin * 0.7, 0, 0.95);
  if (margin < 0.25) return { kind: 'unknown', confidence: 0.3, source: 'detected', evidence: [...evidence, 'conflicting signals'] };
  return { kind, confidence: Math.round(confidence * 100) / 100, source: 'detected', evidence };
}

/* ------------------------------------------------------------------ */
/* Calibration baselines                                                */
/* ------------------------------------------------------------------ */

export function baselineKey(modality, taskType) {
  return `${modality}|${taskType || 'recall'}`;
}

export function createBaseline(key) {
  return { key, samples: [], updatedAt: 0 };
}

const LATENCY_SMOOTHING_MS = 250;

export function addSample(baseline, sample, window = DEFAULT_GRADING_CONFIG.baselineWindow) {
  const samples = baseline.samples.filter((s) => s.eventId !== sample.eventId);
  samples.push(sample);
  while (samples.length > window) samples.shift();
  return { ...baseline, samples, updatedAt: sample.ts || Date.now() };
}

export function removeSample(baseline, eventId) {
  return { ...baseline, samples: baseline.samples.filter((s) => s.eventId !== eventId) };
}

/** Robust statistics (median, scaled MAD) in log space. */
export function baselineStats(baseline) {
  const lat = baseline.samples.map((s) => s.lnLatency).filter(Number.isFinite);
  const typ = baseline.samples.map((s) => s.lnMsPerEffort).filter(Number.isFinite);
  const latMed = median(lat);
  const typMed = median(typ);
  return {
    n: lat.length,
    nTyping: typ.length,
    latencyMedian: latMed,
    latencyScale: lat.length >= 3 ? 1.4826 * mad(lat, latMed) : NaN,
    typingMedian: typMed,
    typingScale: typ.length >= 3 ? 1.4826 * mad(typ, typMed) : NaN,
    latencyMedianMs: Number.isFinite(latMed) ? Math.exp(latMed) - LATENCY_SMOOTHING_MS : NaN,
    msPerEffortMedian: Number.isFinite(typMed) ? Math.exp(typMed) : NaN,
  };
}

/**
 * Blend personal statistics with priors. Weight on personal data grows
 * with sample count and is complete at `personal` samples.
 */
function effectiveStats(stats, modality, config) {
  const prior = config.priors[modality] || config.priors.physical;
  const priorLat = Math.log(prior.latencyMs + LATENCY_SMOOTHING_MS);
  const priorTyp = Math.log(prior.msPerEffort);
  const w = clamp(stats.n / config.minSamples.personal, 0, 1);
  const wt = clamp(stats.nTyping / config.minSamples.personal, 0, 1);
  const pick = (personal, priorValue, weight) => (Number.isFinite(personal) ? weight * personal + (1 - weight) * priorValue : priorValue);
  return {
    latencyMedian: pick(stats.latencyMedian, priorLat, w),
    latencyScale: Math.max(0.15, pick(stats.latencyScale, prior.latencyScale, w)),
    typingMedian: pick(stats.typingMedian, priorTyp, wt),
    typingScale: Math.max(0.15, pick(stats.typingScale, prior.typingScale, wt)),
    personalWeight: w,
  };
}

export function calibrationLevel(n, config = DEFAULT_GRADING_CONFIG) {
  if (n >= config.minSamples.personal) return 'personal';
  if (n >= config.minSamples.provisional) return 'provisional';
  return 'none';
}

/* ------------------------------------------------------------------ */
/* Measurement adjustment                                               */
/* ------------------------------------------------------------------ */

/**
 * Derive adjusted measurements and timing reliability from raw ones.
 * Raw values are never modified; adjustments are recorded separately.
 */
export function adjustMeasurements(trial, config = DEFAULT_GRADING_CONFIG) {
  const raw = trial.raw || {};
  const excluded = [];
  const reasons = [];
  const reading = readingFloor(trial.prompt || { words: 0, mathTokens: 0, images: 0 }, config);
  const warmup = config.heuristicsEnabled && trial.isWarmup ? clamp(config.warmupMs, 0, config.warmupMaxMs) : 0;
  const latency = Number.isFinite(raw.latencyMs) ? raw.latencyMs : NaN;
  const adjustedLatency = Number.isFinite(latency) ? Math.max(0, latency - reading.ms - warmup) : NaN;
  const latencyForEasy = Number.isFinite(latency) ? Math.max(0, latency - reading.ms) : NaN;
  const effort = raw.effort ?? raw.answerLength ?? 0;
  const typingInformative = effort >= config.minEffortForTyping && Number.isFinite(raw.typingMs) && raw.typingMs > 0;
  const msPerEffort = typingInformative ? raw.typingMs / effort : NaN;

  let reliable = true;
  const flag = (code, metric = 'timing') => {
    reliable = false;
    reasons.push(code);
    excluded.push({ metric, reason: code });
  };
  if (!Number.isFinite(latency)) flag('NO_LATENCY');
  if ((raw.hiddenMs || 0) > 0 && raw.interruptedByHidden) flag('HIDDEN_INTERRUPTION');
  if ((raw.longestGapMs || 0) > config.idleCapMs || (Number.isFinite(latency) && latency > config.idleCapMs * 2)) flag('IDLE_INTERRUPTION');
  if (trial.editorOpened) flag('EDITOR_OPENED');
  if (trial.clockAnomaly) flag('CLOCK_ANOMALY');
  const modality = trial.modality || { kind: 'unknown', confidence: 0 };
  if (modality.kind === 'unknown') flag('MODALITY_UNKNOWN', 'modality');
  else if (modality.confidence < config.minModalityConfidence) flag('LOW_MODALITY_CONFIDENCE', 'modality');
  const origins = raw.origins || {};
  if ((origins.paste || 0) > 0 || (origins.autofill || 0) > 0) flag('PASTE_OR_AUTOFILL', 'input');
  if (Number.isFinite(latency) && latency < config.anticipatoryMs) flag('ANTICIPATORY');
  if (reading.applied && !reading.reliable) flag('READING_UNRELIABLE');
  const toolbarShare = (origins.toolbar || 0) / Math.max(1, raw.answerLength || 1);
  const typingExcluded = !typingInformative || toolbarShare > 0.3 || (origins.composition || 0) > 0 || modality.kind === 'voice';
  if (typingExcluded && typingInformative) excluded.push({ metric: 'typing', reason: toolbarShare > 0.3 ? 'TOOLBAR_HEAVY' : modality.kind === 'voice' ? 'VOICE' : 'IME_COMPOSITION' });
  if (!typingInformative) excluded.push({ metric: 'typing', reason: 'ANSWER_TOO_SHORT_FOR_TYPING_SPEED' });
  return {
    reliable,
    reasons,
    excluded,
    reading,
    warmupMs: warmup,
    adjusted: {
      latencyMs: adjustedLatency,
      latencyForEasyMs: latencyForEasy,
      msPerEffort: typingExcluded ? NaN : msPerEffort,
      readingShare: Number.isFinite(latency) && latency > 0 ? reading.ms / latency : 0,
      heuristicsEnabled: !!config.heuristicsEnabled,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Grading                                                              */
/* ------------------------------------------------------------------ */

function ceilingName(name) {
  return { again: 1, hard: 2, good: 3, easy: 4 }[name] || 3;
}

/**
 * Infer a grade for one answered review.
 *
 * @param {object} trial
 *   { correct, typoTolerated, taskType, raw, modality, prompt,
 *     assistance: { hintShown, revealed, solutionViewed },
 *     isWarmup, editorOpened, clockAnomaly,
 *     history: { previousScheduled: { correct, assisted, grade, hesitation } | null } }
 * @param {object} baseline calibration baseline for modality|taskType
 * @param {object} config grading configuration
 */
export function gradeReview(trial, baseline, config = DEFAULT_GRADING_CONFIG) {
  const reasons = [];
  const assistance = trial.assistance || {};
  const adj = adjustMeasurements(trial, config);
  const stats = baselineStats(baseline || createBaseline('none'));
  const level = calibrationLevel(stats.n, config);
  const modality = trial.modality?.kind || 'unknown';
  const base = {
    ruleVersion: GRADING_VERSION,
    config: snapshotConfig(config),
    calibration: { key: baselineKey(modality, trial.taskType), n: stats.n, level },
    measurements: { raw: trial.raw || {}, adjusted: adj.adjusted, reading: adj.reading, warmupMs: adj.warmupMs, excluded: adj.excluded },
    timingReliable: adj.reliable,
  };

  if (assistance.revealed) return finish(base, 1, ['REVEALED'], 0.95, trial, adj);
  if (assistance.solutionViewed) return finish(base, 1, ['SOLUTION_VIEWED_BEFORE_ANSWER'], 0.9, trial, adj);
  if (!trial.correct) return finish(base, 1, ['INCORRECT'], 0.95, trial, adj);

  let ceiling = 4;
  if (assistance.hintShown) {
    ceiling = Math.min(ceiling, ceilingName(config.hintCeiling));
    reasons.push('HINT_CEILING');
  }
  if (trial.typoTolerated) {
    ceiling = Math.min(ceiling, 3);
    reasons.push('TYPO_NO_EASY');
  }

  if (!adj.reliable) {
    reasons.push('TIMING_UNRELIABLE', ...adj.reasons);
    return finish(base, Math.min(3, ceiling), reasons, 0.3, trial, adj);
  }

  const taskType = trial.taskType || 'recall';
  if (taskType !== 'recall' && stats.n < config.minSamples.problemSolving) {
    reasons.push('CORRECTNESS_LED_TASK');
    return finish(base, Math.min(3, ceiling), reasons, 0.45, trial, adj);
  }
  if (level === 'none') {
    reasons.push('CALIBRATION_NONE');
    return finish(base, Math.min(3, ceiling), reasons, 0.4, trial, adj);
  }

  const eff = effectiveStats(stats, modality, config);
  const lnLat = Math.log(adj.adjusted.latencyMs + LATENCY_SMOOTHING_MS);
  const zLatency = (lnLat - eff.latencyMedian) / eff.latencyScale;
  const lnLatEasy = Math.log(adj.adjusted.latencyForEasyMs + LATENCY_SMOOTHING_MS);
  const zLatencyEasy = (lnLatEasy - eff.latencyMedian) / eff.latencyScale;
  const msPerEffort = adj.adjusted.msPerEffort;
  const zTyping = Number.isFinite(msPerEffort) ? (Math.log(msPerEffort) - eff.typingMedian) / eff.typingScale : 0;
  const raw = trial.raw || {};
  const corrections = Math.min(3, raw.corrections || 0);
  const pauses = Math.min(3, raw.pauses || 0);
  const w = config.weights;
  const hesitation = zLatency + w.typing * Math.max(0, zTyping) + w.correction * corrections + w.pause * pauses;
  const scores = {
    zLatency: round3(zLatency),
    zLatencyEasy: round3(zLatencyEasy),
    zTyping: round3(zTyping),
    corrections,
    pauses,
    hesitation: round3(hesitation),
    personalWeight: round3(eff.personalWeight),
  };
  if (adj.warmupMs) reasons.push('WARMUP_APPLIED');
  if (adj.reading.applied && adj.reading.ms > 0) reasons.push('READING_ADJUSTMENT_APPLIED');

  let grade = 3;
  let confidence;
  if (level === 'provisional') {
    reasons.push('CALIBRATION_PROVISIONAL');
    if (hesitation >= config.thresholds.provisionalHard) {
      grade = 2;
      reasons.push('HESITANT');
      confidence = 0.5 + Math.min(0.2, (hesitation - config.thresholds.provisionalHard) * 0.1);
    } else {
      reasons.push('FLUENT', 'EASY_NEEDS_CALIBRATION');
      confidence = 0.5;
    }
  } else if (hesitation >= config.thresholds.hard) {
    grade = 2;
    reasons.push('HESITANT');
    confidence = 0.6 + Math.min(0.25, (hesitation - config.thresholds.hard) * 0.15);
  } else {
    reasons.push('FLUENT');
    confidence = 0.6 + Math.min(0.2, Math.abs(hesitation - config.thresholds.hard) * 0.1);
    const easyCandidate = hesitation <= config.thresholds.easy && zLatencyEasy <= config.thresholds.easy;
    if (easyCandidate) {
      const blockers = [];
      if (ceiling < 4) blockers.push('EASY_BLOCKED_BY_CEILING');
      if (corrections > 0 || pauses > 0) blockers.push('EASY_BLOCKED_BY_CORRECTIONS');
      if (zTyping > 0.5) blockers.push('EASY_BLOCKED_BY_SLOW_TYPING');
      if (adj.adjusted.readingShare > config.maxReadingShareForEasy) blockers.push('READING_ADJUSTMENT_DOMINANT');
      const prev = trial.history?.previousScheduled;
      if (!prev) blockers.push('EASY_NEEDS_HISTORY');
      else if (!prev.correct || prev.assisted || prev.grade < 3 || prev.typoTolerated) blockers.push('EASY_NEEDS_CONSISTENCY');
      if (!blockers.length) {
        grade = 4;
        reasons.push('RAPID_CONSISTENT');
        confidence = 0.6 + Math.min(0.2, (config.thresholds.easy - hesitation) * 0.1);
      } else {
        reasons.push(...blockers);
      }
    }
  }
  const modalityConfidence = trial.modality?.confidence ?? 0;
  confidence *= 0.7 + 0.3 * modalityConfidence;
  return finish({ ...base, scores }, Math.min(grade, ceiling), reasons, confidence, trial, adj);
}

function round3(x) {
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
}

function snapshotConfig(config) {
  return {
    heuristicsEnabled: config.heuristicsEnabled,
    thresholds: { ...config.thresholds },
    weights: { ...config.weights },
    minSamples: { ...config.minSamples },
    hintCeiling: config.hintCeiling,
    warmupMs: config.warmupMs,
    readingVersion: config.reading.version,
  };
}

function finish(base, grade, reasons, confidence, trial, adj) {
  const c = clamp(confidence, 0.05, 0.95);
  const result = {
    ...base,
    grade,
    gradeName: GRADE_NAME[grade],
    reasons: [...new Set(reasons)],
    confidence: Math.round(c * 100) / 100,
    confidenceLabel: c >= 0.7 ? 'high' : c >= 0.45 ? 'medium' : 'low',
    confidenceIsCalibrated: false,
  };
  result.explanation = explainGrade(result, trial, adj);
  return result;
}

/* ------------------------------------------------------------------ */
/* Explanation                                                          */
/* ------------------------------------------------------------------ */

export const REASON_TEXT = Object.freeze({
  REVEALED: 'The answer was revealed before submitting, so this counts as Again.',
  SOLUTION_VIEWED_BEFORE_ANSWER: 'The worked solution was viewed before answering, which counts as a reveal.',
  INCORRECT: 'The answer did not match, so this counts as Again.',
  HINT_CEILING: 'A hint was used, which caps the grade.',
  TYPO_NO_EASY: 'A typo was tolerated, so Easy is not possible.',
  TIMING_UNRELIABLE: 'Timing was not reliable for this answer, so a correct answer defaults to Good.',
  NO_LATENCY: 'No first keystroke was recorded.',
  HIDDEN_INTERRUPTION: 'The app was in the background during this card.',
  IDLE_INTERRUPTION: 'There was a long idle gap, likely an interruption.',
  EDITOR_OPENED: 'The card editor was opened during this review.',
  CLOCK_ANOMALY: 'The device clock changed unexpectedly.',
  MODALITY_UNKNOWN: 'The input method could not be identified.',
  LOW_MODALITY_CONFIDENCE: 'The input method was uncertain.',
  PASTE_OR_AUTOFILL: 'Text was pasted or auto-filled.',
  ANTICIPATORY: 'Typing began implausibly quickly after the card appeared.',
  READING_UNRELIABLE: 'The prompt is too long or complex for a reliable reading-time estimate.',
  CORRECTNESS_LED_TASK: 'Problem-solving cards are graded on correctness until enough comparable history exists.',
  CALIBRATION_NONE: 'Not enough personal timing data yet for this input method, so correct answers count as Good.',
  CALIBRATION_PROVISIONAL: 'Timing thresholds are still provisional for this input method.',
  EASY_NEEDS_CALIBRATION: 'Easy is only possible once calibration is personal.',
  HESITANT: 'Correct, but noticeably slower or more hesitant than usual for you.',
  FLUENT: 'Correct at a typical speed for you.',
  RAPID_CONSISTENT: 'Correct, fast and fluent again — consistently easy.',
  EASY_BLOCKED_BY_CEILING: 'Fast, but a hint or typo prevents Easy.',
  EASY_BLOCKED_BY_CORRECTIONS: 'Fast, but corrections or pauses prevent Easy.',
  EASY_BLOCKED_BY_SLOW_TYPING: 'Quick to start, but typing was slower than usual.',
  READING_ADJUSTMENT_DOMINANT: 'Fast mainly because of the reading-time adjustment, so not Easy.',
  EASY_NEEDS_HISTORY: 'Easy requires a previous fluent review of this card.',
  EASY_NEEDS_CONSISTENCY: 'Easy requires the previous review to have been fluent too.',
  WARMUP_APPLIED: 'First card of the session: a warm-up allowance was applied.',
  READING_ADJUSTMENT_APPLIED: 'An estimated reading time was subtracted (heuristic).',
  MANUAL_GRADE: 'You graded this card yourself.',
  OVERRIDE_KNEW: 'You marked this as known (user override).',
  OVERRIDE_GUESSED: 'You marked this as a guess (user override).',
  ALIAS_RESCUE: 'Marked correct and the answer was saved as an alias (user override).',
  OVERRIDE_CORRECT: 'Marked correct by you (user override).',
});

export function explainGrade(result, trial = {}, adj = null) {
  const parts = [];
  const primary = result.reasons.find((r) => ['REVEALED', 'SOLUTION_VIEWED_BEFORE_ANSWER', 'INCORRECT', 'RAPID_CONSISTENT', 'HESITANT', 'FLUENT', 'TIMING_UNRELIABLE', 'CORRECTNESS_LED_TASK', 'CALIBRATION_NONE'].includes(r));
  if (primary) parts.push(REASON_TEXT[primary]);
  for (const r of result.reasons) if (r !== primary && REASON_TEXT[r] && !['READING_ADJUSTMENT_APPLIED', 'WARMUP_APPLIED'].includes(r)) parts.push(REASON_TEXT[r]);
  const raw = trial.raw || {};
  if (Number.isFinite(raw.latencyMs) && adj) {
    const adjMs = adj.adjusted.latencyMs;
    parts.push(`First keystroke after ${(raw.latencyMs / 1000).toFixed(1)} s${adj.reading.applied ? ` (≈${(adjMs / 1000).toFixed(1)} s after estimated reading time)` : ''}.`);
  }
  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Calibration eligibility                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether a graded review may update a timing baseline, and the sample.
 * Excludes assisted, typo-tolerated, interrupted, ambiguous-modality,
 * pasted, overridden and practice-under-time-pressure samples.
 */
export function calibrationSample(trial, gradeResult, { eventId, ts, mode } = {}) {
  const reasons = [];
  if (!trial.correct) reasons.push('incorrect');
  const a = trial.assistance || {};
  if (a.hintShown || a.revealed || a.solutionViewed) reasons.push('assisted');
  if (trial.typoTolerated) reasons.push('typo-tolerated');
  if (!gradeResult.timingReliable) reasons.push('timing-unreliable');
  if (trial.override) reasons.push('user-override');
  if (trial.correctionCopy) reasons.push('correction-copy');
  if (mode === 'speed') reasons.push('speed-practice');
  const modality = trial.modality?.kind || 'unknown';
  if (modality === 'unknown') reasons.push('modality-unknown');
  if (reasons.length) return { eligible: false, reasons };
  const adjusted = gradeResult.measurements.adjusted;
  return {
    eligible: true,
    key: baselineKey(modality, trial.taskType),
    sample: {
      eventId,
      ts,
      lnLatency: Math.log(adjusted.latencyMs + LATENCY_SMOOTHING_MS),
      lnMsPerEffort: Number.isFinite(adjusted.msPerEffort) ? Math.log(adjusted.msPerEffort) : null,
      latencyMs: adjusted.latencyMs,
    },
    reasons: [],
  };
}

/** Grade after an explicit user override (stored as a correction event). */
export function overrideGrade(kind, originalGrade, config = DEFAULT_GRADING_CONFIG) {
  if (kind === 'knew') return { grade: Math.min(4, Math.max(3, originalGrade + 1)), reasons: ['OVERRIDE_KNEW'] };
  if (kind === 'guessed') return { grade: ceilingName(config.guessedGrade), reasons: ['OVERRIDE_GUESSED'] };
  if (kind === 'alias') return { grade: 3, reasons: ['ALIAS_RESCUE'] };
  if (kind === 'correct') return { grade: 3, reasons: ['OVERRIDE_CORRECT'] };
  throw new Error(`Unknown override ${kind}`);
}
