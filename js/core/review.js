/**
 * Pure review engine: turns one answered card into an exact plan of
 * record changes. The data layer commits a plan in a single IndexedDB
 * transaction (event + unit state + calibration + session queue), so a
 * review is either fully saved or not at all.
 *
 * Review submission, grade overrides, "Mark correct & save as alias" and
 * undo are explicit state transitions: each stores the pre-review state,
 * the parameters used and enough context to reproduce the result.
 */

import { APP_VERSION } from '../config.js';
import { applyRating, retrievability, State } from './scheduler.js';
import { gradeReview, overrideGrade, calibrationSample, DEFAULT_GRADING_CONFIG } from './fluency.js';
import { matchAnswer, matchOrderedAnswers } from './match/index.js';
import { unitContent, effectiveCardSettings } from './model.js';
import { replayUnit } from './history.js';
import { isLeech } from './stats.js';

export const PERF_WINDOW = 8;

/** Match a typed answer for one unit with the card's effective settings. */
export function evaluateAnswer(card, deck, unitKey, input, { vocabulary = null } = {}) {
  const content = unitContent(card, unitKey);
  const s = effectiveCardSettings(card, deck);
  const opts = {
    mode: s.answerMode,
    caseSensitive: s.caseSensitive,
    typoTolerance: s.typoTolerance,
    accentPolicy: s.accentPolicy,
    mathEquivalence: s.mathEquivalence,
    numericTolerance: s.numericTolerance,
    vocabulary,
  };
  const result = content.answerGroups.length > 1 ? matchOrderedAnswers(input, content.answerGroups, opts) : matchAnswer(input, content.answerGroups[0] || [], opts);
  return { ...result, options: { ...opts, vocabulary: undefined }, content };
}

function elapsedDaysOf(unit, now) {
  const last = unit.state?.last_review;
  return last ? (now - last) / 86400000 : null;
}

function pushPerf(perf, entry) {
  const recent = [...(perf?.recent || []), entry];
  while (recent.length > PERF_WINDOW) recent.shift();
  return { ...(perf || {}), recent };
}

/**
 * Plan a review or practice retrieval.
 * @returns {{ event, unit, calibration, requeue }}
 */
export function planReview(ctx) {
  const {
    eventId, now, deviceId, seq, sessionId, mode, live, unit, card, deck, trial, match,
    gradeMode = 'auto', manualRating = null, gradingConfig = DEFAULT_GRADING_CONFIG, baseline,
    params, studyDay, timeZone, research = null, firstAttempt = true, appVersion = APP_VERSION,
  } = ctx;
  const enrichedTrial = {
    ...trial,
    correct: match.correct,
    typoTolerated: !!match.typoTolerated,
    taskType: trial.taskType || card.taskType || 'recall',
    history: { previousScheduled: unit.lastScheduled || null },
  };
  const grading = gradeReview(enrichedTrial, baseline, gradingConfig);
  const usesManual = gradeMode === 'manual' || (gradeMode === 'research' && research?.arm === 'standard');
  if (usesManual && ![1, 2, 3, 4].includes(manualRating)) throw new Error('Manual grading requires a rating');
  const rating = usesManual ? manualRating : grading.grade;
  const predictedR = retrievability(unit.state, now, params);
  const elapsedDays = elapsedDaysOf(unit, now);
  const wasNew = !unit.state || unit.state.state === State.New;
  const flags = {
    practiceSinceLast: !!unit.practiceSinceLast,
    siblingExposure: !!(unit.siblingExposedAt && (!unit.lastReviewAt || unit.siblingExposedAt > unit.lastReviewAt)),
    warmup: !!trial.isWarmup,
    clockAnomaly: !!trial.clockAnomaly,
    editedDuringReview: !!trial.editorOpened,
  };
  const event = {
    id: eventId,
    type: live ? 'review' : 'practice',
    ts: now,
    deviceId,
    seq,
    sessionId,
    unitId: unit.id,
    cardId: card.id,
    deckId: card.deckId,
    unitKey: unit.key,
    studyDay,
    timeZone,
    appVersion,
    mode,
    taskType: enrichedTrial.taskType,
    firstAttempt,
    wasNew,
    cardRevision: card.version?.hash || null,
    response: {
      text: trial.responseText,
      correct: !!match.correct,
      method: match.method,
      typoTolerated: !!match.typoTolerated,
      warnings: match.warnings || [],
      diagnostics: match.diagnostics || [],
      matchedIndex: match.matchedIndex,
      matcherVersion: match.version,
      probabilistic: !!match.probabilistic,
    },
    assistance: { hintShown: !!trial.assistance?.hintShown, revealed: !!trial.assistance?.revealed, solutionViewed: !!trial.assistance?.solutionViewed },
    modality: trial.modality || { kind: 'unknown', confidence: 0 },
    grading: { ...grading, mode: usesManual ? 'manual' : 'auto', shadowGrade: usesManual ? grading.grade : null },
    rating,
    predictedR,
    elapsedDays,
    activeMs: Math.round(trial.raw?.activeMs ?? trial.raw?.totalMs ?? 0),
    flags,
    research,
    // Enough unit context to reverse this transition exactly (undo).
    prevUnitMeta: {
      lastScheduled: unit.lastScheduled || null,
      practiceSinceLast: !!unit.practiceSinceLast,
      leech: !!unit.leech,
      suspended: !!unit.suspended,
      introducedDay: unit.introducedDay || null,
      lastReviewAt: unit.lastReviewAt || null,
    },
  };
  let nextUnit = { ...unit, perf: pushPerf(unit.perf, { c: !!match.correct, h: grading.scores?.hesitation ?? null, k: trial.raw?.corrections || 0, t: now }) };
  if (live) {
    const { state, transition } = applyRating(unit.state, rating, now, params, eventId);
    event.parentId = unit.headEventId || null;
    event.prevState = unit.state || null;
    event.params = params;
    event.transition = transition;
    event.nextState = state;
    nextUnit = {
      ...nextUnit,
      state,
      headEventId: eventId,
      lastReviewAt: now,
      practiceSinceLast: false,
      lastScheduled: { correct: !!match.correct, assisted: !!(trial.assistance?.hintShown || trial.assistance?.revealed || trial.assistance?.solutionViewed), grade: rating, typoTolerated: !!match.typoTolerated, hesitation: grading.scores?.hesitation ?? null },
      introducedDay: unit.introducedDay || (wasNew ? studyDay : unit.introducedDay || null),
    };
    const threshold = deck?.settings?.leechThreshold ?? 4;
    const leech = isLeech(nextUnit, { threshold });
    if (leech && !unit.leech) {
      nextUnit.leech = true;
      nextUnit.leechSince = now;
      if (deck?.settings?.leechAction === 'suspend') {
        nextUnit.suspended = true;
        nextUnit.suspendedAt = now;
      }
    }
  } else {
    nextUnit.practiceSinceLast = true;
    nextUnit.lastPracticeAt = now;
  }
  const cal = calibrationSample(enrichedTrial, grading, { eventId, ts: now, mode });
  return { event, unit: nextUnit, calibration: cal.eligible ? cal : null, calibrationExclusion: cal.eligible ? null : cal.reasons, requeue: !match.correct };
}

/**
 * Plan a correction (override) of an earlier review.
 * kind: 'knew' | 'guessed' | 'alias' | 'correct' | 'manual'
 * Recomputes the unit by replaying its full effective history, so the
 * failed review's scheduling effect is replaced exactly once even if
 * later reviews exist.
 */
export function planOverride({ eventId, now, deviceId, seq, target, kind, manualRating = null, unit, unitEvents, alias = null, studyDay, gradingConfig = DEFAULT_GRADING_CONFIG }) {
  const original = target.grading?.grade ?? target.rating;
  const og = kind === 'manual' ? { grade: manualRating, reasons: ['MANUAL_GRADE'] } : overrideGrade(kind, original, gradingConfig);
  const correction = {
    id: eventId,
    type: 'correction',
    kind: 'override',
    ts: now,
    deviceId,
    seq,
    studyDay,
    unitId: target.unitId,
    cardId: target.cardId,
    deckId: target.deckId,
    sessionId: target.sessionId,
    targetId: target.id,
    reason: kind,
    newRating: og.grade,
    previousRating: target.rating,
    reasons: og.reasons,
    alias,
    // The rescue uses the original pre-feedback measurements; the time
    // spent on the feedback screen is never treated as retrieval.
    measurementsFrom: target.id,
  };
  if (target.type !== 'review') return { event: correction, unit };
  const replay = replayUnit([...unitEvents, correction]);
  return { event: correction, unit: { ...unit, state: replay.state, headEventId: replay.headEventId }, replay };
}

/** Plan an undo (void) of a review; practice events have no schedule effect. */
export function planUndo({ eventId, now, deviceId, seq, target, unit, unitEvents, studyDay, reason = 'undo' }) {
  const correction = {
    id: eventId,
    type: 'correction',
    kind: 'void',
    reason,
    ts: now,
    deviceId,
    seq,
    studyDay,
    unitId: target.unitId,
    cardId: target.cardId,
    deckId: target.deckId,
    sessionId: target.sessionId,
    targetId: target.id,
  };
  if (target.type !== 'review') return { event: correction, unit };
  const replay = replayUnit([...unitEvents, correction]);
  const meta = target.prevUnitMeta || {};
  const restored = {
    ...unit,
    state: replay.state,
    headEventId: replay.headEventId,
    perf: { ...(unit.perf || {}), recent: (unit.perf?.recent || []).filter((r) => r.t !== target.ts) },
  };
  // Only restore unit metadata when undoing the most recent review.
  if (unit.headEventId === target.id) {
    Object.assign(restored, {
      lastScheduled: meta.lastScheduled ?? null,
      practiceSinceLast: !!meta.practiceSinceLast,
      leech: !!meta.leech,
      introducedDay: meta.introducedDay ?? null,
      lastReviewAt: meta.lastReviewAt ?? null,
    });
    if (unit.suspended && !meta.suspended && unit.suspendedAt === target.ts) {
      restored.suspended = false;
      restored.suspendedAt = now;
    }
  }
  return { event: correction, unit: restored, replay };
}

/** Non-retrieval exposure events (hint, reveal, copy, sibling, skip, edit, abandon, self-rating). */
export function exposureEvent({ id, type, now, deviceId, seq, unit, card, sessionId, studyDay, data = {} }) {
  return {
    id,
    type,
    ts: now,
    deviceId,
    seq,
    sessionId,
    unitId: unit?.id || null,
    cardId: card?.id || unit?.cardId || null,
    deckId: card?.deckId || unit?.deckId || null,
    studyDay,
    ...data,
  };
}
