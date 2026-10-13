/**
 * Research comparison mode: Axon automatic grading vs. standard FSRS
 * self-grading (Again/Hard/Good/Easy), assigned at the sibling-group
 * (card) level so answer leakage between conditions is reduced.
 *
 * Nothing here claims superiority. Reports show sample sizes, elapsed
 * retention intervals and 95% Wilson intervals, and compare later
 * independent recall and total study time — not speed alone.
 */

import { hash53, wilson, median, hashHex } from './util.js';
import { correctionIndex, answerClass } from './stats.js';

export const ARMS = Object.freeze(['axon', 'standard']);

/** Stable assignment for one card within a study period. */
export function assignArm(groupId, study) {
  if (!study || !study.active) return null;
  if (study.design === 'all-axon') return 'axon';
  if (study.design === 'all-standard') return 'standard';
  return hash53(`${study.id}|${groupId}`) % 2 === 0 ? 'axon' : 'standard';
}

export function createStudy({ id, startDay, design = 'randomized', schedulerVersion, gradingVersion, desiredRetention }) {
  return { id, active: true, design, startDay, endDay: null, schedulerVersion, gradingVersion, desiredRetention, createdAt: Date.now() };
}

/**
 * Comparison report over events recorded during the study.
 * Delayed independent recall = first attempt of a scheduled review at
 * least `minElapsedDays` after the previous one, not affected by
 * intervening practice or sibling exposure.
 */
export function comparisonReport(events, study, { minElapsedDays = 1 } = {}) {
  const corr = correctionIndex(events);
  const arms = Object.fromEntries(ARMS.map((a) => [a, { n: 0, recalled: 0, elapsed: [], studyMs: 0, retrievals: 0, cards: new Set(), affected: 0 }]));
  for (const e of events) {
    if (!e.research || e.research.studyId !== study.id) continue;
    const arm = arms[e.research.arm];
    if (!arm) continue;
    if (e.type === 'review' || e.type === 'practice') {
      arm.studyMs += e.activeMs || 0;
      arm.retrievals++;
      arm.cards.add(e.cardId);
    }
    if (e.type !== 'review' || !e.firstAttempt || (e.elapsedDays ?? 0) < minElapsedDays) continue;
    const cls = answerClass(e, corr);
    if (cls === 'voided') continue;
    if (e.flags?.practiceSinceLast || e.flags?.siblingExposure) {
      arm.affected++;
      continue;
    }
    arm.n++;
    arm.elapsed.push(e.elapsedDays);
    if (cls === 'independent-correct') arm.recalled++;
  }
  const out = {};
  for (const [name, a] of Object.entries(arms)) {
    out[name] = {
      delayedTests: a.n,
      recall: wilson(a.recalled, a.n),
      medianElapsedDays: median(a.elapsed),
      studyMinutes: a.studyMs / 60000,
      minutesPerCard: a.cards.size ? a.studyMs / 60000 / a.cards.size : null,
      cards: a.cards.size,
      retrievals: a.retrievals,
      excludedAffectedByExposure: a.affected,
    };
  }
  const enough = ARMS.every((n) => out[n].delayedTests >= 100);
  return {
    study: { id: study.id, design: study.design, startDay: study.startDay, schedulerVersion: study.schedulerVersion, gradingVersion: study.gradingVersion },
    arms: out,
    caution: enough
      ? 'Differences are descriptive for one learner and do not establish that either method is superior.'
      : 'Too few delayed tests for a meaningful comparison (aim for at least 100 per arm). Results are descriptive only.',
  };
}

/**
 * De-identified evaluation export: ids hashed with a per-export salt,
 * no card content, no answers, no tokens, no device names.
 */
export function deidentifiedRows(events, { salt = String(Math.random()) } = {}) {
  const h = (x) => (x ? hashHex(`${salt}|${x}`) : null);
  return events
    .filter((e) => e.type === 'review' || e.type === 'practice' || e.type === 'correction')
    .map((e) => ({
      event: h(e.id),
      type: e.type,
      unit: h(e.unitId),
      group: h(e.cardId),
      deck: h(e.deckId),
      day: e.studyDay,
      mode: e.mode ?? null,
      correct: e.response?.correct ?? null,
      typoTolerated: e.response?.typoTolerated ?? null,
      hint: e.assistance?.hintShown ?? null,
      revealed: e.assistance?.revealed ?? null,
      grade: e.grading?.grade ?? null,
      rating: e.rating ?? e.newRating ?? null,
      confidence: e.grading?.confidence ?? null,
      reasons: (e.grading?.reasons || []).join(' '),
      latencyMs: e.grading?.measurements?.raw?.latencyMs ?? null,
      adjustedLatencyMs: e.grading?.measurements?.adjusted?.latencyMs ?? null,
      totalMs: e.grading?.measurements?.raw?.totalMs ?? null,
      modality: e.modality?.kind ?? null,
      taskType: e.taskType ?? null,
      predictedR: e.predictedR ?? null,
      elapsedDays: e.elapsedDays ?? null,
      intervalDays: e.transition?.chosenIntervalDays ?? null,
      arm: e.research?.arm ?? null,
      practiceSinceLast: e.flags?.practiceSinceLast ?? null,
      siblingExposure: e.flags?.siblingExposure ?? null,
      correctionKind: e.kind ?? null,
      gradingVersion: e.grading?.ruleVersion ?? null,
      schedulerVersion: e.params?.version ?? null,
    }));
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
