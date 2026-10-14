/**
 * Offline analytics computed from the event log and unit states.
 *
 * Scientific-caution rules applied throughout:
 *  - Observed recall accuracy (what happened) is reported separately from
 *    predicted retrievability (what the model estimates).
 *  - First-attempt accuracy is separate from eventual success after retries.
 *  - Hinted, revealed, overridden and independent answers are separated.
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

export function dailyActivity(events, days = new Map()) {
  for (const e of events) {
    if (!isRetrieval(e) && e.type !== 'copy') continue;
    const d = e.studyDay;
    if (!days.has(d)) days.set(d, { day: d, reviews: 0, practice: 0, correct: 0, retrievals: 0, studyMs: 0 });
    const row = days.get(d);
    if (e.type === 'review') row.reviews++;
    if (e.type === 'practice') row.practice++;
    if (isRetrieval(e)) {
      row.retrievals++;
      if (e.response?.correct) row.correct++;
    }
    row.studyMs += e.activeMs || 0;
  }
  return days;
}

export function currentStreak(activity, today) {
  let streak = 0;
  let day = today;
  if (!activity.has(day)) day = addDays(day, -1); // today not studied yet does not break the streak
  while (activity.has(day) && (activity.get(day).retrievals > 0)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

export function longestStreak(activity) {
  const days = [...activity.keys()].sort();
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
 * retrievals per day (or per week), with Wilson intervals.
 */
export function accuracySeries(events, { bucket = 'day', corr = correctionIndex(events) } = {}) {
  const buckets = new Map();
  for (const e of events) {
    if (!isScheduled(e) || !e.firstAttempt) continue;
    const cls = answerClass(e, corr);
    if (cls === 'voided') continue;
    const key = bucket === 'week' ? weekKey(e.studyDay) : e.studyDay;
    if (!buckets.has(key)) buckets.set(key, { key, n: 0, correct: 0, hinted: 0, revealed: 0, overridden: 0, independentCorrect: 0 });
    const b = buckets.get(key);
    b.n++;
    if (e.response?.correct) b.correct++;
    if (cls === 'hinted') b.hinted++;
    if (cls === 'revealed') b.revealed++;
    if (cls === 'overridden') b.overridden++;
    if (cls === 'independent-correct') b.independentCorrect++;
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((b) => ({ ...b, ci: wilson(b.independentCorrect, b.n) }));
}

function weekKey(day) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
}

/** Summary used by the dashboard header. */
export function summary(events, units, { today, now, params, corr = correctionIndex(events) }) {
  const todays = events.filter((e) => e.studyDay === today);
  const scheduledToday = todays.filter((e) => isScheduled(e) && answerClass(e, corr) !== 'voided');
  const retrievals = events.filter((e) => isRetrieval(e) && answerClass(e, corr) !== 'voided');
  const latencies = retrievals.map((e) => e.grading?.measurements?.raw?.latencyMs).filter(Number.isFinite);
  const adjusted = retrievals.map((e) => e.grading?.measurements?.adjusted?.latencyMs).filter(Number.isFinite);
  const hesitation = retrievals.map((e) => e.grading?.scores?.hesitation).filter(Number.isFinite);
  const first = retrievals.filter((e) => isScheduled(e) && e.firstAttempt);
  const independent = first.filter((e) => answerClass(e, corr) === 'independent-correct').length;
  const eventual = eventualSuccess(events);
  let rSum = 0;
  let rN = 0;
  for (const u of units) {
    if (!u.active || !u.state || u.state.state === State.New) continue;
    const r = retrievability(u.state, now, u.params || params);
    if (r != null) {
      rSum += r;
      rN++;
    }
  }
  return {
    reviewedToday: scheduledToday.length,
    practicedToday: todays.filter((e) => e.type === 'practice').length,
    studyMsToday: todays.reduce((s, e) => s + (e.activeMs || 0), 0),
    studyMsTotal: events.reduce((s, e) => s + (e.activeMs || 0), 0),
    medianLatencyMs: median(latencies),
    medianAdjustedLatencyMs: median(adjusted),
    medianHesitation: median(hesitation),
    firstAttemptAccuracy: wilson(independent, first.length),
    eventualSuccess: eventual,
    predictedRecall: rN ? rSum / rN : null,
    predictedRecallUnits: rN,
    practiceSinceModel: events.some((e) => e.type === 'practice'),
  };
}

/** First-attempt vs eventual success within sessions. */
export function eventualSuccess(events) {
  const bySessionUnit = new Map();
  for (const e of events) {
    if (!isRetrieval(e)) continue;
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
    if (list[0].response?.correct) firstCorrect++;
    if (list.some((e) => e.response?.correct)) eventuallyCorrect++;
  }
  return { n, firstAttempt: n ? firstCorrect / n : null, eventual: n ? eventuallyCorrect / n : null };
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
    const cls = answerClass(e, corr);
    if (cls === 'voided') continue;
    if (e.flags?.practiceSinceLast || e.flags?.siblingExposure) {
      affected++;
      continue;
    }
    const idx = Math.min(bins - 1, Math.floor(e.predictedR * bins));
    rows[idx].n++;
    rows[idx].predictedSum += e.predictedR;
    if (cls === 'independent-correct') rows[idx].recalled++;
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

/** Per-deck weekly trends of reviews and first-attempt accuracy. */
export function deckTrends(events, { weeks = 8, today, corr = correctionIndex(events) }) {
  const start = addDays(today, -7 * weeks);
  const byDeck = new Map();
  for (const e of events) {
    if (!isScheduled(e) || e.studyDay < start || !e.firstAttempt) continue;
    if (answerClass(e, corr) === 'voided') continue;
    if (!byDeck.has(e.deckId)) byDeck.set(e.deckId, new Map());
    const wk = weekKey(e.studyDay);
    const m = byDeck.get(e.deckId);
    if (!m.has(wk)) m.set(wk, { week: wk, n: 0, correct: 0 });
    const row = m.get(wk);
    row.n++;
    if (answerClass(e, corr) === 'independent-correct') row.correct++;
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
    .filter((e) => e.unitId === unitId && (isRetrieval(e) || ['hint', 'reveal', 'copy', 'skip', 'sibling-exposure', 'edit'].includes(e.type)))
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
