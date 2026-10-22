/**
 * Workload estimates, catch-up planning and exam plans.
 *
 * Estimates come from the learner's own recent sessions when enough
 * relevant ones exist; otherwise provisional defaults are used and
 * labelled as such. Nothing here alters the long-term schedule.
 */

import { mean } from './util.js';
import { retrievability, applyRating, State } from './scheduler.js';
import { addDays, daysBetween, studyDayStart } from './time.js';
import { isLeech, outcome, correctionIndex } from './stats.js';

/** Seconds per card (answer, feedback and same-session re-asks) without history. */
export const PROVISIONAL_SECONDS = Object.freeze({ review: 10, new: 45 });
export const MIN_SAMPLES_FOR_ESTIMATE = 20;
/** Session modes that follow the long-term schedule (not optional practice). */
export const SCHEDULING_MODES = new Set(['daily', 'catchup']);
/** A longer gap after an answer is a break, not feedback reading. */
export const MAX_FEEDBACK_MS = 2 * 60000;
const MAX_ANSWER_MS = 5 * 60000;
/** Learning steps closer together than this happen in one session. */
const SAME_SESSION_MS = 60 * 60000;

/**
 * Time each card took in one session, oldest first. A card's cost is the
 * active answering time of every presentation of it in that session
 * (re-asks after a miss and learning steps included) plus what follows
 * each answer — feedback reading, correction retyping, self-grading —
 * measured as the gap until the next prompt of the session and capped so
 * breaks do not count. The last answer of a session borrows the session's
 * median gap.
 */
export function cardCosts(events) {
  const bySession = new Map();
  for (const e of events) {
    if ((e.type !== 'review' && e.type !== 'practice') || !Number.isFinite(e.activeMs)) continue;
    const key = e.sessionId || '';
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(e);
  }
  const cards = [];
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => a.ts - b.ts);
    const gaps = list.map((e, i) => {
      const next = list[i + 1];
      if (!sessionId || !next) return null;
      const nextPrompt = next.ts - Math.min(MAX_ANSWER_MS, next.activeMs) - (next.gradingMs || 0);
      return Math.min(MAX_FEEDBACK_MS, Math.max(0, nextPrompt - e.ts));
    });
    const known = gaps.filter((g) => g != null).sort((a, b) => a - b);
    const typicalGap = known.length ? known[known.length >> 1] : 0;
    const open = new Map();
    list.forEach((e, i) => {
      let card = open.get(e.unitId);
      if (!card || e.firstAttempt !== false) {
        card = { ts: e.ts, ms: 0, presentations: 0, wasNew: !!e.wasNew, mode: e.mode, event: e };
        open.set(e.unitId, card);
        cards.push(card);
      }
      card.ms += Math.min(MAX_ANSWER_MS, e.activeMs) + (e.gradingMs || 0) + (gaps[i] ?? typicalGap);
      card.presentations++;
    });
  }
  return cards.sort((a, b) => a.ts - b.ts);
}

/**
 * Average seconds per card for reviews and for new cards (see `cardCosts`)
 * from the most relevant history with at least MIN_SAMPLES_FOR_ESTIMATE
 * cards: scheduling sessions (daily review and catch-up — never Speed,
 * Cram or other practice) on events matching `scope`, then all scheduling
 * sessions, then any session. Without enough, provisional defaults are
 * used. `basis` says which history was used.
 */
export function durationModel(events, { window = 300, scope = null } = {}) {
  const cards = cardCosts(events);
  const tiers = [
    scope ? ['scope', (c) => SCHEDULING_MODES.has(c.mode) && scope(c.event)] : null,
    ['scheduled', (c) => SCHEDULING_MODES.has(c.mode)],
    ['all', () => true],
  ].filter(Boolean);
  const pick = (wasNew, fallback) => {
    let n = 0;
    for (const [basis, keep] of tiers) {
      const list = cards.filter((c) => c.wasNew === wasNew && keep(c)).slice(-window).map((c) => c.ms / 1000);
      n = list.length;
      if (n >= MIN_SAMPLES_FOR_ESTIMATE) return { seconds: mean(list), provisional: false, n, basis };
    }
    return { seconds: fallback, provisional: true, n, basis: 'default' };
  };
  return { review: pick(false, PROVISIONAL_SECONDS.review), new: pick(true, PROVISIONAL_SECONDS.new) };
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
 * Review sessions one unit is expected to need in [from, until), following
 * its FSRS schedule (without fuzz) with successful answers. A null state
 * is a card introduced at `from`; that introduction counts as the first
 * session. Learning steps within the same session are part of that
 * session's per-card cost and are not counted again.
 */
export function reviewSessionsBetween(state, from, until, params, { maxSteps = 100 } = {}) {
  const p = params.axonFuzz ? { ...params, axonFuzz: null } : params;
  let s = state;
  let at = s ? Math.max(from, s.due) : from;
  let last = -Infinity;
  let count = 0;
  for (let i = 0; i < maxSteps && at < until; i++) {
    if (at - last >= SAME_SESSION_MS) count++;
    last = at;
    s = applyRating(s, 3, at, p, 'exam-plan').state;
    if (s.due <= at) break;
    at = s.due;
  }
  return count;
}

/** Share of a topic's studied cards that must be weak for the topic to be weak. */
export const WEAK_TOPIC_SHARE = 0.2;

/**
 * Exam plan analysis.
 * @param plan { examDate (YYYY-MM-DD), deckIds, tags, dailyMinutes, targetCoverage (0..1) }
 * The exam starts at the beginning of its study day (time zone and
 * rollover as everywhere else). The workload counts the new cards needed
 * for the target coverage, every review the FSRS schedule is expected to
 * ask for before the exam — repeat reviews of cards already studied,
 * follow-ups of newly introduced ones and about one extra review per
 * expected lapse — and one practice of each weak card.
 */
export function analyzeExamPlan(plan, { units, cardsById, events, today, now, params, paramsFor = null, timeZone = 'UTC', rolloverHour = 4, model = null }) {
  const inPlan = (deckId, card) => (!plan.deckIds?.length || plan.deckIds.includes(deckId)) && (!plan.tags?.length || plan.tags.some((t) => (card?.tags || []).includes(t)));
  const inScope = units.filter((u) => {
    if (!u.active) return false;
    const card = cardsById.get(u.cardId);
    if (!card || card.suspended || u.suspended) return false;
    return inPlan(u.deckId, card);
  });
  const timing = model || durationModel(events, { scope: (e) => inPlan(e.deckId, cardsById.get(e.cardId)) });
  const paramsOf = (u) => u.params || paramsFor?.(u.deckId) || params;
  const daysLeft = Math.max(0, daysBetween(today, plan.examDate));
  const examInstant = Math.max(now, studyDayStart(plan.examDate, { timeZone, rolloverHour }));
  const introduced = inScope.filter((u) => u.state && u.state.state !== State.New);
  const unintroduced = inScope.length - introduced.length;
  const weakIds = new Set();
  let rSum = 0;
  let rExam = 0;
  let practiced = 0;
  let reviews = 0;
  let dueBeforeExam = 0;
  for (const u of introduced) {
    const p = paramsOf(u);
    const r = retrievability(u.state, now, p) ?? 0;
    const re = retrievability(u.state, examInstant, p) ?? 0;
    rSum += r;
    rExam += re;
    if (u.practiceSinceLast) practiced++;
    if (r < 0.7 || u.leech || isLeech(u) || (u.perf?.recent || []).slice(-3).some((x) => !x.c)) weakIds.add(u.id);
    const postponed = u.overlays?.postponedUntil ? studyDayStart(u.overlays.postponedUntil, { timeZone, rolloverHour }) : 0;
    const from = Math.max(now, postponed);
    if (Math.max(from, u.state.due) < examInstant) dueBeforeExam++;
    reviews += reviewSessionsBetween(u.state, from, examInstant, p) * (2 - (p.request_retention ?? 0.9));
  }
  // New cards for the target coverage, spread evenly over the days left;
  // each is followed by the reviews its schedule asks for before the exam.
  const target = Math.ceil((plan.targetCoverage ?? 1) * inScope.length);
  const toIntroduce = Math.max(0, target - introduced.length);
  const newPerDay = daysLeft ? Math.ceil(toIntroduce / daysLeft) : toIntroduce;
  const followUpsByDay = new Map();
  let newFollowUps = 0;
  for (let i = 0; i < toIntroduce; i++) {
    const k = newPerDay ? Math.floor(i / newPerDay) : 0;
    if (!followUpsByDay.has(k)) {
      const at = k === 0 ? now : studyDayStart(addDays(today, k), { timeZone, rolloverHour });
      followUpsByDay.set(k, Math.max(0, reviewSessionsBetween(null, at, examInstant, params) - 1) * (2 - (params.request_retention ?? 0.9)));
    }
    newFollowUps += followUpsByDay.get(k);
  }
  const weak = weakIds.size;
  const expectedReviews = reviews + newFollowUps;
  const seconds = toIntroduce * timing.new.seconds + expectedReviews * timing.review.seconds + weak * timing.review.seconds;
  const budgetSeconds = daysLeft * (plan.dailyMinutes || 0) * 60;
  const observed = observedRecall(events, new Set(inScope.map((u) => u.id)));
  return {
    totalUnits: inScope.length,
    daysLeft,
    examInstant,
    coverage: inScope.length ? introduced.length / inScope.length : 0,
    targetCoverage: plan.targetCoverage ?? 1,
    unintroduced,
    weak,
    weakTopics: topicBreakdown(inScope, cardsById, weakIds).filter((t) => t.weak && t.weak >= WEAK_TOPIC_SHARE * t.studied),
    toIntroduce,
    dueBeforeExam,
    expectedReviews,
    newPerDayNeeded: newPerDay,
    estimatedMinutes: seconds / 60,
    budgetMinutes: budgetSeconds / 60,
    minutesPerDayNeeded: daysLeft ? seconds / 60 / daysLeft : seconds / 60,
    likelyInsufficient: seconds > budgetSeconds,
    provisional: timing.new.provisional || timing.review.provisional,
    timing,
    observedRecall: observed,
    predictedRecallNow: introduced.length ? rSum / introduced.length : null,
    predictedRecallAtExamWithoutStudy: introduced.length ? rExam / introduced.length : null,
    practicedUnits: practiced,
  };
}

/**
 * In-scope units grouped by topic: each card tag, or the deck for a card
 * without a distinguishing tag. A tag every card in scope carries (such as
 * the one that selects the plan) does not tell topics apart and is
 * ignored. Weakest share first.
 */
export function topicBreakdown(units, cardsById, weakIds) {
  const cards = [...new Set(units.map((u) => u.cardId))].map((id) => cardsById.get(id)).filter(Boolean);
  const universal = new Set(cards.length > 1 ? (cards[0].tags || []).filter((t) => cards.every((c) => (c.tags || []).includes(t))) : []);
  const topics = new Map();
  for (const u of units) {
    const card = cardsById.get(u.cardId);
    const tags = (card?.tags || []).filter((t) => !universal.has(t));
    const keys = tags.length ? tags.map((t) => ['tag', t]) : [['deck', u.deckId]];
    for (const [kind, id] of keys) {
      const key = `${kind}|${id}`;
      if (!topics.has(key)) topics.set(key, { kind, id, units: 0, studied: 0, weak: 0 });
      const t = topics.get(key);
      t.units++;
      if (u.state && u.state.state !== State.New) t.studied++;
      if (weakIds.has(u.id)) t.weak++;
    }
  }
  return [...topics.values()].sort((a, b) => (b.weak / (b.studied || 1)) - (a.weak / (a.studied || 1)) || b.weak - a.weak || (a.id < b.id ? -1 : 1));
}

/**
 * First-attempt recall of scheduled reviews in scope: correct without a
 * hint or reveal, counting rescued answers as correct and leaving out
 * undone ones (the same rule as the Statistics page).
 */
function observedRecall(events, unitIds) {
  const corr = correctionIndex(events);
  let n = 0;
  let c = 0;
  for (const e of events) {
    if (e.type !== 'review' || !e.firstAttempt || !unitIds.has(e.unitId)) continue;
    const o = outcome(e, corr);
    if (!o) continue;
    n++;
    if (o.independent) c++;
  }
  return { n, accuracy: n ? c / n : null };
}

export function nextDays(today, n) {
  return Array.from({ length: n }, (_, i) => addDays(today, i));
}
