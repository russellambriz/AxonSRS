/**
 * Workload estimates, catch-up planning and exam plans.
 *
 * Estimates come from the learner's own recent review durations when
 * enough exist; otherwise provisional defaults are used and labelled as
 * such. Nothing here alters the long-term schedule.
 */

import { median } from './util.js';
import { retrievability, State } from './scheduler.js';
import { addDays, daysBetween } from './time.js';
import { isLeech } from './stats.js';

export const PROVISIONAL_SECONDS = Object.freeze({ review: 10, new: 25 });
export const MIN_SAMPLES_FOR_ESTIMATE = 20;

/** Median active seconds per review kind from recent history. */
export function durationModel(events, { window = 300 } = {}) {
  const recent = events.filter((e) => (e.type === 'review' || e.type === 'practice') && Number.isFinite(e.activeMs)).slice(-window);
  const newOnes = recent.filter((e) => e.wasNew).map((e) => e.activeMs / 1000);
  const reviews = recent.filter((e) => !e.wasNew).map((e) => e.activeMs / 1000);
  const pick = (list, fallback) => (list.length >= MIN_SAMPLES_FOR_ESTIMATE ? { seconds: median(list), provisional: false, n: list.length } : { seconds: fallback, provisional: true, n: list.length });
  return { review: pick(reviews, PROVISIONAL_SECONDS.review), new: pick(newOnes, PROVISIONAL_SECONDS.new) };
}

export function estimateSessionMinutes({ reviews, news, learning = 0 }, model) {
  const seconds = (reviews + learning) * model.review.seconds + news * model.new.seconds;
  return { minutes: seconds / 60, provisional: model.review.provisional || (news > 0 && model.new.provisional) };
}

/**
 * Catch-up recommendation after missed days: how many reviews per day
 * clear the backlog within `targetDays` without exceeding `dailyMax`.
 */
export function catchUpPlan({ backlog, dailyDue, targetDays = 7, dailyMax = 200 }) {
  if (backlog <= 0) return { needed: false, perDay: 0, days: 0 };
  const perDay = Math.min(dailyMax, Math.ceil(backlog / targetDays + dailyDue));
  const extra = Math.max(1, perDay - dailyDue);
  return { needed: true, perDay, days: Math.ceil(backlog / extra), sessionSize: Math.min(perDay, backlog + dailyDue) };
}

/**
 * Exam plan analysis.
 * @param plan { examDate (YYYY-MM-DD), deckIds, tags, dailyMinutes, targetCoverage (0..1) }
 */
export function analyzeExamPlan(plan, { units, cardsById, events, today, now, params, model = durationModel(events) }) {
  const inScope = units.filter((u) => {
    if (!u.active) return false;
    const card = cardsById.get(u.cardId);
    if (!card || card.suspended || u.suspended) return false;
    if (plan.deckIds?.length && !plan.deckIds.includes(u.deckId)) return false;
    if (plan.tags?.length && !plan.tags.some((t) => card.tags.includes(t))) return false;
    return true;
  });
  const daysLeft = Math.max(0, daysBetween(today, plan.examDate));
  const examInstant = now + daysLeft * 86400000;
  const introduced = inScope.filter((u) => u.state && u.state.state !== State.New);
  const unintroduced = inScope.length - introduced.length;
  let weak = 0;
  let rSum = 0;
  let rExam = 0;
  for (const u of introduced) {
    const r = retrievability(u.state, now, u.params || params) ?? 0;
    const re = retrievability(u.state, examInstant, u.params || params) ?? 0;
    rSum += r;
    rExam += re;
    if (r < 0.7 || isLeech(u) || (u.perf?.recent || []).slice(-3).some((x) => !x.c)) weak++;
  }
  // Workload: introduce enough new units to reach target coverage, plus
  // the reviews already scheduled before the exam (each counted once — a
  // deliberate under-estimate that is labelled as such).
  const target = Math.ceil((plan.targetCoverage ?? 1) * inScope.length);
  const toIntroduce = Math.max(0, target - introduced.length);
  const dueBeforeExam = introduced.filter((u) => u.state.due <= examInstant).length;
  const learningReviewsPerNew = 2; // learning steps on introduction day
  const seconds = toIntroduce * model.new.seconds + toIntroduce * learningReviewsPerNew * model.review.seconds + dueBeforeExam * model.review.seconds + weak * model.review.seconds;
  const budgetSeconds = daysLeft * (plan.dailyMinutes || 0) * 60;
  const observed = observedRecall(events, new Set(inScope.map((u) => u.id)));
  return {
    totalUnits: inScope.length,
    daysLeft,
    coverage: inScope.length ? introduced.length / inScope.length : 0,
    targetCoverage: plan.targetCoverage ?? 1,
    unintroduced,
    weak,
    toIntroduce,
    dueBeforeExam,
    newPerDayNeeded: daysLeft ? Math.ceil(toIntroduce / daysLeft) : toIntroduce,
    estimatedMinutes: seconds / 60,
    budgetMinutes: budgetSeconds / 60,
    minutesPerDayNeeded: daysLeft ? seconds / 60 / daysLeft : seconds / 60,
    likelyInsufficient: seconds > budgetSeconds,
    provisional: model.new.provisional || model.review.provisional,
    observedRecall: observed,
    predictedRecallNow: introduced.length ? rSum / introduced.length : null,
    predictedRecallAtExamWithoutStudy: introduced.length ? rExam / introduced.length : null,
  };
}

function observedRecall(events, unitIds) {
  let n = 0;
  let c = 0;
  for (const e of events) {
    if (e.type !== 'review' || !e.firstAttempt || !unitIds.has(e.unitId)) continue;
    n++;
    if (e.response?.correct && !e.assistance?.hintShown && !e.assistance?.revealed) c++;
  }
  return { n, accuracy: n ? c / n : null };
}

export function nextDays(today, n) {
  return Array.from({ length: n }, (_, i) => addDays(today, i));
}
