/**
 * Offline analytics computed from the event log and unit states.
 *
 * Scientific-caution rules applied throughout:
 *  - Observed recall accuracy (what happened) is reported separately from
 *    predicted retrievability (what the model estimates).
 *  - First-attempt accuracy is separate from eventual success after retries.
 *  - Hinted, revealed, overridden and independent answers are separated.
 *  - Undone (voided) answers count nowhere. An answer rescued by an
 *    accepted alias or "Mark correct" counts as correct everywhere, and is
 *    still reported as overridden (see `outcome`).
 *  - Optional practice and sibling-answer exposure are flagged, and
 *    delayed tests affected by them are marked.
 *  - Correction copying is never counted as recall.
 */

import { median, mean, wilson, quantile } from './util.js';
import { retrievability, State } from './scheduler.js';
import { addDays, studyDay as studyDayOf } from './time.js';
import { resolveCorrections } from './history.js';

export function isScheduled(e) {
  return e.type === 'review';
}

export function isRetrieval(e) {
  return e.type === 'review' || e.type === 'practice';
}

/** Map eventId → effective correction info for overrides and voids. */
export function correctionIndex(events) {
  return resolveCorrections(events.filter((e) => e.type === 'correction'));
}

/** Classify one retrieval for reporting. */
export function answerClass(e, corr) {
  const c = corr?.get(e.id);
  if (c?.voided) return 'voided';
  const a = e.assistance || {};
  if (a.revealed || a.solutionViewed) return 'revealed';
  if (c && c.overrides.length) return 'overridden';
  if (a.hintShown) return 'hinted';
  return e.response?.correct ? 'independent-correct' : 'incorrect';
}

/** Override reasons that turn a failed answer into an accepted one. */
export const RESCUE_REASONS = new Set(['alias', 'correct']);

/**
 * Correction-aware outcome of one retrieval, shared by every accuracy
 * figure so they agree with the schedule and the session summary.
 * `correct`: the answer counts as right once the learner's corrections are
 * applied — an answer rescued by an accepted alias or "Mark correct" is
 * correct, a revealed answer never is. `independent`: correct without a
 * hint and not marked "I guessed" (first-attempt accuracy, observed
 * recall). `cls` keeps the separate reporting class, so a rescue is still
 * shown as overridden. Voided (undone) retrievals return null.
 */
export function outcome(e, corr) {
  const c = corr?.get(e.id);
  if (c?.voided) return null;
  const a = e.assistance || {};
  const last = c?.overrides?.length ? c.overrides[c.overrides.length - 1] : null;
  const reason = last?.reason || null;
  const rescued = RESCUE_REASONS.has(reason);
  const correct = !(a.revealed || a.solutionViewed) && (rescued || !!e.response?.correct);
  // Reviews and corrections recorded under axon-outcomes@2 carry their own
  // verdict; older ones keep the rule they were recorded under.
  let independent;
  if (last?.outcome) independent = !!last.outcome.independent;
  else if (e.outcome && !last) independent = !!e.outcome.independent;
  else independent = correct && !a.hintShown && reason !== 'guessed';
  const cls = last?.outcome?.class || e.outcome?.class || null;
  return {
    cls: answerClass(e, corr),
    outcomeClass: cls,
    correct,
    independent,
    rescued,
    selfChecked: e.outcome?.provenance === 'self' || e.response?.method === 'self',
    phase: e.outcome?.phase || (e.wasNew ? 'new' : e.prevState ? null : 'new'),
    legacy: !e.outcome,
  };
}

/**
 * Every completed first assessment of a scheduled review, with an explicit
 * denominator: answers given with help, after a reveal or "I don't know",
 * and genuine guesses stay in it as not recalled on your own, so hard
 * items do not disappear from the figure. Skips and abandoned attempts
 * are counted separately and never as a success or a failure. New cards
 * (their first test) are reported apart from delayed reviews.
 */
export function assessmentBreakdown(events, corr = correctionIndex(events)) {
  const first = effectiveRetrievals(events, corr).filter((e) => isScheduled(e) && e.firstAttempt);
  const out = { opportunities: 0, independent: 0, assisted: 0, revealed: 0, guessed: 0, failed: 0, selfChecked: 0, legacy: 0, skipped: 0, abandoned: 0, delayed: { n: 0, independent: 0 }, newCards: { n: 0, independent: 0 } };
  for (const e of first) {
    const o = outcome(e, corr);
    out.opportunities++;
    if (o.legacy) out.legacy++;
    if (o.selfChecked) out.selfChecked++;
    const a = e.assistance || {};
    if (o.independent) out.independent++;
    else if (o.outcomeClass === 'revealed' || o.outcomeClass === 'dont-know' || (!o.outcomeClass && (a.revealed || a.solutionViewed))) out.revealed++;
    else if (o.outcomeClass === 'assisted' || (!o.outcomeClass && a.hintShown)) out.assisted++;
    else if (o.outcomeClass === 'guessed') out.guessed++;
    else out.failed++;
    const bucket = o.phase === 'new' ? out.newCards : out.delayed;
    bucket.n++;
    if (o.independent) bucket.independent++;
  }
  for (const e of events) {
    if (e.type === 'skip') out.skipped++;
    else if (e.type === 'abandon') out.abandoned++;
  }
  const unaided = out.opportunities - out.assisted - out.revealed - out.guessed;
  out.recall = wilson(out.independent, out.opportunities);
  out.delayedRecall = wilson(out.delayed.independent, out.delayed.n);
  out.newCardRecall = wilson(out.newCards.independent, out.newCards.n);
  // Conditional: accuracy among attempts made without help. Not retention.
  out.unaidedAccuracy = wilson(out.independent, unaided);
  out.helpRate = out.opportunities ? out.assisted / out.opportunities : null;
  out.revealRate = out.opportunities ? out.revealed / out.opportunities : null;
  return out;
}

/** Pre-feedback confidence (Guessing / Unsure / Confident) against what happened. */
export function confidenceAnalysis(events, corr = correctionIndex(events)) {
  const levels = Object.fromEntries(['guessing', 'unsure', 'confident'].map((k) => [k, { n: 0, literal: 0, independent: 0 }]));
  let unset = 0;
  for (const e of effectiveRetrievals(events, corr)) {
    if (!e.outcome) continue;
    const o = outcome(e, corr);
    const k = e.outcome.confidence;
    if (!levels[k]) {
      unset++;
      continue;
    }
    levels[k].n++;
    if (o.correct) levels[k].literal++;
    if (o.independent) levels[k].independent++;
  }
  for (const l of Object.values(levels)) {
    l.literalRate = wilson(l.literal, l.n);
    l.independentRate = wilson(l.independent, l.n);
  }
  return { levels, unset, n: Object.values(levels).reduce((s, l) => s + l.n, 0) };
}

/** Reviews and practice answers that still count (undone ones removed). */
export function effectiveRetrievals(events, corr = correctionIndex(events)) {
  return events.filter((e) => isRetrieval(e) && !corr.get(e.id)?.voided);
}

// `correct` is the matcher's raw verdict (corrections are not applied), so
// cached rows stay valid when an override arrives later.
function addActivity(days, e, sign) {
  const d = e.studyDay;
  if (!days.has(d)) days.set(d, { day: d, reviews: 0, practice: 0, correct: 0, retrievals: 0, studyMs: 0 });
  const row = days.get(d);
  if (e.type === 'review') row.reviews += sign;
  if (e.type === 'practice') row.practice += sign;
  if (isRetrieval(e)) {
    row.retrievals += sign;
    if (e.response?.correct) row.correct += sign;
  }
  row.studyMs += sign * (e.activeMs || 0);
}

/**
 * Per-study-day activity (heatmap, streaks, study time). Undone (voided)
 * reviews and practice answers are left out, as is their time.
 */
export function dailyActivity(events, days = new Map(), corr = correctionIndex(events)) {
  for (const e of events) {
    if (!isRetrieval(e) && e.type !== 'copy') continue;
    if (corr.get(e.id)?.voided) continue;
    addActivity(days, e, 1);
  }
  return days;
}

/**
 * Take out events an earlier `dailyActivity` counted that have since been
 * undone (the incremental activity cache).
 */
export function retractActivity(days, events) {
  for (const e of events) if (isRetrieval(e) || e.type === 'copy') addActivity(days, e, -1);
  return days;
}

const studied = (activity, day) => (activity.get(day)?.retrievals || 0) > 0;

export function currentStreak(activity, today) {
  let streak = 0;
  let day = today;
  if (!studied(activity, day)) day = addDays(day, -1); // today not studied yet does not break the streak
  while (studied(activity, day)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

export function longestStreak(activity) {
  const days = [...activity.keys()].filter((d) => studied(activity, d)).sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/**
 * Accuracy series: first-attempt accuracy of scheduled, independent
 * retrievals per day (or per week), with Wilson intervals. `correct` is the
 * matcher's raw verdict; `independentCorrect` applies corrections (see
 * `outcome`), and `rescued` counts the answers it includes only because the
 * learner accepted an alias or marked them correct.
 */
export function accuracySeries(events, { bucket = 'day', corr = correctionIndex(events) } = {}) {
  const buckets = new Map();
  for (const e of events) {
    if (!isScheduled(e) || !e.firstAttempt) continue;
    const o = outcome(e, corr);
    if (!o) continue;
    const key = bucket === 'week' ? weekKey(e.studyDay) : e.studyDay;
    if (!buckets.has(key)) buckets.set(key, { key, n: 0, correct: 0, hinted: 0, revealed: 0, overridden: 0, rescued: 0, independentCorrect: 0 });
    const b = buckets.get(key);
    b.n++;
    if (e.response?.correct) b.correct++;
    if (o.cls === 'hinted') b.hinted++;
    if (o.cls === 'revealed') b.revealed++;
    if (o.cls === 'overridden') b.overridden++;
    if (o.independent) b.independentCorrect++;
    if (o.independent && o.rescued) b.rescued++;
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((b) => ({ ...b, ci: wilson(b.independentCorrect, b.n) }));
}

/** Monday of the week containing `day` (YYYY-MM-DD). */
export function weekKey(day) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
}

/**
 * Summary used by the dashboard header. Undone (voided) reviews and
 * practice answers count nowhere, not even in study time.
 * `practicedUnits`: how many of the averaged units had optional practice
 * since their last scheduled review, which the memory model has not
 * incorporated, so the predicted recall is incomplete for them.
 */
export function summary(events, units, { today, now, params, corr = correctionIndex(events) }) {
  const retrievals = effectiveRetrievals(events, corr);
  const todays = retrievals.filter((e) => e.studyDay === today);
  const latencies = retrievals.map((e) => e.grading?.measurements?.raw?.latencyMs).filter(Number.isFinite);
  const adjusted = retrievals.map((e) => e.grading?.measurements?.adjusted?.latencyMs).filter(Number.isFinite);
  const hesitation = retrievals.map((e) => e.grading?.scores?.hesitation).filter(Number.isFinite);
  const first = retrievals.filter((e) => isScheduled(e) && e.firstAttempt);
  const independent = first.filter((e) => outcome(e, corr).independent).length;
  const eventual = eventualSuccess(events, corr);
  const activeMs = (list) => list.reduce((s, e) => s + (e.activeMs || 0), 0);
  let rSum = 0;
  let rN = 0;
  let practiced = 0;
  for (const u of units) {
    if (!u.active || !u.state || u.state.state === State.New) continue;
    const r = retrievability(u.state, now, u.params || params);
    if (r != null) {
      rSum += r;
      rN++;
      if (u.practiceSinceLast) practiced++;
    }
  }
  return {
    reviewedToday: todays.filter(isScheduled).length,
    practicedToday: todays.filter((e) => e.type === 'practice').length,
    studyMsToday: activeMs(todays),
    studyMsTotal: activeMs(retrievals),
    medianLatencyMs: median(latencies),
    meanLatencyMs: mean(latencies),
    medianAdjustedLatencyMs: median(adjusted),
    meanAdjustedLatencyMs: mean(adjusted),
    medianHesitation: median(hesitation),
    firstAttemptAccuracy: wilson(independent, first.length),
    assessment: assessmentBreakdown(events, corr),
    eventualSuccess: eventual,
    predictedRecall: rN ? rSum / rN : null,
    predictedRecallUnits: rN,
    practicedUnits: practiced,
    practiceSinceModel: practiced > 0,
  };
}

/**
 * First-attempt vs eventual success within sessions (reviews and
 * practice). Correction-aware: undone answers are skipped, a rescued
 * answer is a success and a revealed one is not (see `outcome`).
 */
export function eventualSuccess(events, corr = correctionIndex(events)) {
  const bySessionUnit = new Map();
  for (const e of effectiveRetrievals(events, corr)) {
    const key = `${e.sessionId}|${e.unitId}`;
    if (!bySessionUnit.has(key)) bySessionUnit.set(key, []);
    bySessionUnit.get(key).push(e);
  }
  let firstCorrect = 0;
  let eventuallyCorrect = 0;
  let n = 0;
  for (const list of bySessionUnit.values()) {
    list.sort((a, b) => a.ts - b.ts);
    n++;
    if (outcome(list[0], corr).correct) firstCorrect++;
    if (list.some((e) => outcome(e, corr).correct)) eventuallyCorrect++;
  }
  return { n, firstAttempt: n ? firstCorrect / n : null, eventual: n ? eventuallyCorrect / n : null };
}

/**
 * Retrieval latency over time: mean and median first-keystroke latency
 * (raw and after the reading-time estimate) of the retrievals in each day
 * or week, undone answers excluded.
 */
export function latencySeries(events, { bucket = 'week', corr = correctionIndex(events) } = {}) {
  const buckets = new Map();
  for (const e of effectiveRetrievals(events, corr)) {
    const raw = e.grading?.measurements?.raw?.latencyMs;
    if (!Number.isFinite(raw)) continue;
    const key = bucket === 'week' ? weekKey(e.studyDay) : e.studyDay;
    if (!buckets.has(key)) buckets.set(key, { key, raw: [], adjusted: [] });
    const b = buckets.get(key);
    b.raw.push(raw);
    const adj = e.grading?.measurements?.adjusted?.latencyMs;
    if (Number.isFinite(adj)) b.adjusted.push(adj);
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((b) => ({
    key: b.key,
    n: b.raw.length,
    meanMs: mean(b.raw),
    medianMs: median(b.raw),
    meanAdjustedMs: mean(b.adjusted),
    medianAdjustedMs: median(b.adjusted),
  }));
}

/**
 * Optional 1-5 confidence self-ratings compared with what the answers
 * showed: for each rating, how often the answer was correct (Wilson
 * interval), the mean automatic (inferred) grade — the re-grade for a
 * rescued answer — and the mean heuristic grading confidence; for each
 * automatic grade, the mean self-rating. The last rating given to an
 * answer counts; undone answers are left out. Descriptive only:
 * self-ratings never feed grading or scheduling.
 */
export function selfRatingAnalysis(events, { corr = correctionIndex(events) } = {}) {
  const targets = new Map();
  const latest = new Map();
  for (const e of events) {
    if (isRetrieval(e)) targets.set(e.id, e);
    else if (e.type === 'self-rating' && Number.isInteger(e.value) && e.value >= 1 && e.value <= 5) {
      const prev = latest.get(e.targetId);
      if (!prev || e.ts > prev.ts || (e.ts === prev.ts && (e.seq ?? 0) > (prev.seq ?? 0))) latest.set(e.targetId, e);
    }
  }
  const levels = [1, 2, 3, 4, 5].map((value) => ({ value, n: 0, correct: 0, grades: [], confidences: [] }));
  const grades = [1, 2, 3, 4].map((grade) => ({ grade, ratings: [] }));
  const byResult = { correct: [], incorrect: [] };
  let n = 0;
  for (const [targetId, rating] of latest) {
    const e = targets.get(targetId);
    const o = e && outcome(e, corr);
    if (!o) continue;
    n++;
    const row = levels[rating.value - 1];
    row.n++;
    if (o.correct) row.correct++;
    byResult[o.correct ? 'correct' : 'incorrect'].push(rating.value);
    // A rescued answer was re-graded automatically as a correct one.
    const grade = o.rescued ? corr.get(e.id)?.rating ?? e.grading?.grade : e.grading?.grade;
    if ([1, 2, 3, 4].includes(grade)) {
      row.grades.push(grade);
      grades[grade - 1].ratings.push(rating.value);
    }
    if (Number.isFinite(e.grading?.confidence)) row.confidences.push(e.grading.confidence);
  }
  const avg = (list) => (list.length ? mean(list) : null);
  return {
    n,
    levels: levels.map((r) => ({ value: r.value, n: r.n, correct: r.correct, accuracy: wilson(r.correct, r.n), meanGrade: avg(r.grades), meanConfidence: avg(r.confidences) })),
    byGrade: grades.map((g) => ({ grade: g.grade, n: g.ratings.length, meanRating: avg(g.ratings) })),
    meanRatingCorrect: avg(byResult.correct),
    meanRatingIncorrect: avg(byResult.incorrect),
  };
}

/**
 * Retention calibration: predicted retrievability at review time vs.
 * observed first-attempt recall for scheduled delayed tests (≥ 1 day
 * since the previous review). Tests affected by intervening practice or
 * sibling exposure are excluded and counted separately.
 */
export function retentionCalibration(events, { bins = 5, corr = correctionIndex(events) } = {}) {
  const rows = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, recalled: 0, predictedSum: 0 }));
  let affected = 0;
  for (const e of events) {
    if (!isScheduled(e) || !e.firstAttempt || e.predictedR == null || (e.elapsedDays ?? 0) < 1) continue;
    const o = outcome(e, corr);
    if (!o) continue;
    if (e.flags?.practiceSinceLast || e.flags?.siblingExposure) {
      affected++;
      continue;
    }
    const idx = Math.min(bins - 1, Math.floor(e.predictedR * bins));
    rows[idx].n++;
    rows[idx].predictedSum += e.predictedR;
    if (o.independent) rows[idx].recalled++;
  }
  return {
    bins: rows.map((r) => ({ ...r, predicted: r.n ? r.predictedSum / r.n : null, observed: r.n ? r.recalled / r.n : null, ci: wilson(r.recalled, r.n) })),
    affectedExcluded: affected,
  };
}

/** Upcoming workload: due units per study day for the next `days` days. */
export function forecast(units, cardsById, { today, days = 30, timeZone, rolloverHour }) {
  const counts = Array.from({ length: days }, (_, i) => ({ day: addDays(today, i), due: 0, overdueCarried: 0 }));
  const index = new Map(counts.map((c, i) => [c.day, i]));
  for (const u of units) {
    if (!u.active || !u.state || u.state.state === State.New) continue;
    const card = cardsById.get(u.cardId);
    if (!card || card.suspended || u.suspended) continue;
    let day = studyDayOf(u.state.due, { timeZone, rolloverHour });
    const avail = u.overlays?.postponedUntil;
    if (avail && avail > day) day = avail;
    if (day < today) {
      counts[0].due++;
      counts[0].overdueCarried++;
    } else if (index.has(day)) counts[index.get(day)].due++;
  }
  return counts;
}

/** Strongest and weakest learned units by stability / lapses. */
export function strongestWeakest(units, { now, params, limit = 5 }) {
  const learned = units.filter((u) => u.active && u.state && u.state.state === State.Review);
  const scored = learned.map((u) => ({ unit: u, stability: u.state.stability, lapses: u.state.lapses, r: retrievability(u.state, now, u.params || params) }));
  const strongest = scored.slice().sort((a, b) => b.stability - a.stability).slice(0, limit);
  const weakest = scored.slice().sort((a, b) => (b.lapses - a.lapses) || (a.r - b.r)).slice(0, limit);
  return { strongest, weakest };
}

/** The `weeks` week keys (Mondays) ending with the week of `today`, oldest first. */
export function recentWeeks(today, weeks = 8) {
  const last = weekKey(today);
  return Array.from({ length: weeks }, (_, i) => addDays(last, -7 * (weeks - 1 - i)));
}

/**
 * Per-deck weekly trends of reviews and first-attempt accuracy over the
 * last `weeks` calendar weeks (only weeks with reviews are listed).
 */
export function deckTrends(events, { weeks = 8, today, corr = correctionIndex(events) }) {
  const start = recentWeeks(today, weeks)[0];
  const byDeck = new Map();
  for (const e of events) {
    if (!isScheduled(e) || e.studyDay < start || !e.firstAttempt) continue;
    const o = outcome(e, corr);
    if (!o) continue;
    if (!byDeck.has(e.deckId)) byDeck.set(e.deckId, new Map());
    const wk = weekKey(e.studyDay);
    const m = byDeck.get(e.deckId);
    if (!m.has(wk)) m.set(wk, { week: wk, n: 0, correct: 0 });
    const row = m.get(wk);
    row.n++;
    if (o.independent) row.correct++;
  }
  const out = new Map();
  for (const [deckId, m] of byDeck) out.set(deckId, [...m.values()].sort((a, b) => (a.week < b.week ? -1 : 1)));
  return out;
}

/** Breakdown of exposure types (16.8). */
export function exposureBreakdown(events) {
  const types = ['review', 'practice', 'hint', 'reveal', 'copy', 'sibling-exposure', 'correction', 'edit', 'skip', 'abandon', 'self-rating'];
  const out = Object.fromEntries(types.map((t) => [t, 0]));
  for (const e of events) if (e.type in out) out[e.type]++;
  return out;
}

/** History rows for one unit (card history view). */
export function unitHistory(events, unitId) {
  const corr = correctionIndex(events);
  return events
    .filter((e) => e.unitId === unitId && (isRetrieval(e) || ['hint', 'reveal', 'copy', 'skip', 'abandon', 'sibling-exposure', 'edit'].includes(e.type)))
    .sort((a, b) => a.ts - b.ts)
    .map((e) => {
      const c = corr.get(e.id);
      return {
        id: e.id,
        ts: e.ts,
        type: e.type,
        mode: e.mode,
        response: e.response?.text ?? null,
        correct: e.response?.correct ?? null,
        inferredGrade: e.grading?.grade ?? null,
        effectiveRating: c?.rating ?? e.rating ?? null,
        voided: !!c?.voided,
        overrides: c?.overrides?.map((o) => o.reason) || [],
        latencyMs: e.grading?.measurements?.raw?.latencyMs ?? null,
        totalMs: e.grading?.measurements?.raw?.totalMs ?? null,
        intervalDays: e.transition?.chosenIntervalDays ?? null,
        reasons: e.grading?.reasons || [],
        explanation: e.grading?.explanation || '',
        diagnostics: e.response?.diagnostics || [],
      };
    });
}

/** Leech: repeated lapses with high difficulty (thresholds configurable). */
export function isLeech(unit, { threshold = 4, minDifficulty = 7 } = {}) {
  const s = unit.state;
  return !!s && s.lapses >= threshold && s.difficulty >= minDifficulty;
}

export function heatmapLevels(activity, { today, days = 365 }) {
  const out = [];
  const counts = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const c = activity.get(d)?.retrievals || 0;
    out.push({ day: d, count: c });
    if (c) counts.push(c);
  }
  const q = [quantile(counts, 0.25), quantile(counts, 0.5), quantile(counts, 0.75)];
  for (const cell of out) {
    cell.level = cell.count === 0 ? 0 : cell.count <= q[0] ? 1 : cell.count <= q[1] ? 2 : cell.count <= q[2] ? 3 : 4;
  }
  return out;
}

export { mean };
