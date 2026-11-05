/** Statistics dashboard (fully offline, computed from the local event log). */

import { h, replace, percent, downloadBlob, formatDate } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button, kpi, plainFront, leechActions } from './common.js';
import { lineChart, barChart, calibrationChart, chartWithTable, dataTable, menu, toast, callout, errorToast } from '../components.js';
import { summary, accuracySeries, dailyActivity, currentStreak, longestStreak, heatmapLevels, retentionCalibration, forecast, strongestWeakest, deckTrends, recentWeeks, exposureBreakdown, correctionIndex, answerClass, isLeech, latencySeries, selfRatingAnalysis, confidenceAnalysis } from '../../core/stats.js';
import { comparisonReport, deidentifiedRows, toCsv } from '../../core/research.js';
import { baselineStats, calibrationLevel, MODALITY_LABELS } from '../../core/fluency.js';
import { formatDuration, formatInterval, pluralize } from '../../core/util.js';
import { addDays } from '../../core/time.js';
import { TASK_TYPE_LABELS } from '../../core/model.js';
import { RATING_LABELS } from '../../core/scheduler.js';

/** "5 Jan" for a week key (YYYY-MM-DD). */
const weekLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export async function view(outlet) {
  await app.cache.ensure();
  const { root, body } = page({ title: 'Statistics', sub: 'Observed recall (what you actually answered) is shown separately from predicted recall (what the FSRS model estimates).' });
  outlet.append(root);
  body.append(h('div', { class: 'loading-screen' }, h('div', { class: 'spinner' })));
  const [events, baselines] = await Promise.all([store.allEvents(), store.listBaselines()]);
  const tctx = app.timeCtx();
  const units = [...app.cache.units.values()];
  const corr = correctionIndex(events);
  const params = store.paramsFor(null);
  const sum = summary(events, units, { today: tctx.today, now: tctx.now, params, corr });
  const activity = dailyActivity(events, new Map(), corr);
  const fc = forecast(units, app.cache.cards, { today: tctx.today, days: 30, timeZone: tctx.timeZone, rolloverHour: tctx.rolloverHour });
  const blocks = [];

  if (!events.length) {
    replace(body, h('div', { class: 'empty' }, h('div', { class: 'art' }, icon('stats')), h('h2', {}, 'No study history yet'), h('p', {}, 'Statistics appear after your first reviews. Everything is computed on this device.'), button('Start studying', { kind: 'primary', href: '#/study' })));
    return null;
  }

  blocks.push(h('div', { class: 'kpis' },
    kpi('Reviewed today', String(sum.reviewedToday), sum.practicedToday ? `+ ${sum.practicedToday} practice` : ''),
    kpi('Due tomorrow', String(fc[1]?.due ?? 0)),
    kpi('Current streak', `${currentStreak(activity, tctx.today)} d`, `Longest ${longestStreak(activity)} d`),
    kpi('Study time today', formatDuration(sum.studyMsToday), `Total ${formatDuration(sum.studyMsTotal)}`)));

  // Observed vs predicted
  blocks.push(h('div', { class: 'grid-2' },
    h('section', { class: 'panel stack' }, h('h3', {}, 'Observed recall'),
      ...observedRecall(sum),
      h('div', { class: 'faint small' }, `Within sessions: ${percent(sum.eventualSuccess.firstAttempt)} correct on the first try, ${percent(sum.eventualSuccess.eventual)} eventually (after retries). Getting a card right later in a session is not the same as recalling it on the first try.`),
      h('div', { class: 'faint tiny' }, 'Answers accepted with “My answer is correct” count as correct; help that was used still counts as help. Undone reviews count nowhere.')),
    h('section', { class: 'panel stack' }, h('h3', {}, 'Predicted recall'),
      h('div', { class: 'stat' }, h('div', { class: 'value' }, sum.predictedRecall != null ? percent(sum.predictedRecall) : '—'), h('div', { class: 'label' }, `FSRS estimate of retrievability right now, averaged over ${sum.predictedRecallUnits} learned units`), h('div', { class: 'note' }, 'A model estimate, not an observation.')),
      sum.practicedUnits ? h('div', { class: 'faint small' }, `${sum.practicedUnits} of these units had optional practice since their last scheduled review. Practice is not fed into the memory model by default, so the estimate may be incomplete for them (it may under-count recent exposure).`) : null)));

  // Accuracy over time
  const weekly = accuracySeries(events, { bucket: 'week', corr }).slice(-16);
  if (weekly.length) {
    const pts = weekly.map((w) => ({ x: w.key, y: w.ci.p, lo: w.ci.low, hi: w.ci.high, n: w.n }));
    blocks.push(h('section', { class: 'panel' }, chartWithTable(lineChart(pts, { label: 'Weekly first-attempt accuracy with 95% intervals' }), dataTable(['Week of', 'Reviews', 'Independent correct', 'Hinted', 'Revealed', 'Overridden', 'Rescued', '95% interval'], weekly.map((w) => [w.key, String(w.n), percent(w.ci.p), String(w.hinted), String(w.revealed), String(w.overridden), String(w.rescued), `${percent(w.ci.low)}–${percent(w.ci.high)}`])), { title: 'Accuracy over time' }), h('p', { class: 'faint tiny' }, 'Shaded band: 95% Wilson interval. Hinted and revealed answers, and answers you marked as a guess, are not counted as independent recall. Overridden answers are the ones you corrected; those rescued with an accepted alias or Mark correct count as correct (Rescued column).')));
  }

  // Answer breakdown (last 30 days)
  const since = addDays(tctx.today, -30);
  const recent = events.filter((e) => (e.type === 'review' || e.type === 'practice') && e.studyDay >= since);
  const breakdown = { 'independent-correct': 0, incorrect: 0, hinted: 0, revealed: 0, overridden: 0 };
  for (const e of recent) {
    const c = answerClass(e, corr);
    if (c in breakdown) breakdown[c]++;
  }
  const exposures = exposureBreakdown(events.filter((e) => e.studyDay >= since));
  blocks.push(h('div', { class: 'grid-2' },
    h('section', { class: 'panel' }, h('h3', {}, 'Answers, last 30 days'), dataTable(['Kind', 'Count'], [['Independent & correct', String(breakdown['independent-correct'])], ['Incorrect', String(breakdown.incorrect)], ['Correct with hint', String(breakdown.hinted)], ['Answer revealed', String(breakdown.revealed)], ['Overridden by you', String(breakdown.overridden)], ['Correction copies (not recall)', String(exposures.copy)]])),
    h('section', { class: 'panel' }, h('h3', {}, 'Retrieval speed'), dataTable(['Measure', 'Value'], [
      ['Average (mean) first-keystroke latency', formatDuration(sum.meanLatencyMs)],
      ['Median first-keystroke latency', formatDuration(sum.medianLatencyMs)],
      ['Average after reading-time estimate', formatDuration(sum.meanAdjustedLatencyMs)],
      ['Median after reading-time estimate', formatDuration(sum.medianAdjustedLatencyMs)],
      ['Median normalised hesitation', Number.isFinite(sum.medianHesitation) ? `${sum.medianHesitation.toFixed(2)} (0 = your typical)` : '—'],
    ]), h('p', { class: 'faint tiny' }, 'First-keystroke latency is a proxy for retrieval latency, not a direct measure of memory strength. The average is pulled up by occasional long pauses; the median is the typical answer.'))));

  // Latency over time
  const latWeeks = latencySeries(events, { bucket: 'week', corr }).slice(-16);
  if (latWeeks.length) {
    const secs = (ms) => (Number.isFinite(ms) ? ms / 1000 : NaN);
    const top = Math.max(1, ...latWeeks.map((w) => secs(w.meanMs)).filter(Number.isFinite));
    const yMax = top <= 2 ? 2 : top <= 5 ? 5 : Math.ceil(top / 5) * 5;
    const pts = latWeeks.map((w) => ({ x: w.key, y: secs(w.meanMs), n: w.n }));
    blocks.push(h('section', { class: 'panel' }, chartWithTable(lineChart(pts, { label: 'Weekly average first-keystroke latency in seconds', yMax, format: (v) => `${v.toFixed(1)} s` }), dataTable(['Week of', 'Answers', 'Average latency', 'Median latency', 'Average after reading time', 'Median after reading time'], latWeeks.map((w) => [w.key, String(w.n), formatDuration(w.meanMs), formatDuration(w.medianMs), formatDuration(w.meanAdjustedMs), formatDuration(w.medianAdjustedMs)])), { title: 'Retrieval latency over time' }), h('p', { class: 'faint tiny' }, 'Weekly average time to the first keystroke over all reviews and practice answers (undone ones excluded). Easier or more familiar cards in a week lower it, so read it as a trend, not a measure of memory.')));
  }

  // Calibration baselines
  blocks.push(h('section', { class: 'panel' }, h('h3', {}, 'Timing calibration'), baselines.length ? dataTable(['Input method', 'Task type', 'Samples', 'Status', 'Typical first key', 'Typing pace'], baselines.map((b) => {
    const st = baselineStats(b);
    const [mod, task] = b.key.split('|');
    return [MODALITY_LABELS[mod] || mod, TASK_TYPE_LABELS[task] || task, String(st.n), calibrationLevel(st.n), formatDuration(st.latencyMedianMs), Number.isFinite(st.msPerEffortMedian) ? `${Math.round(st.msPerEffortMedian)} ms/char` : '—'];
  })) : h('p', { class: 'faint' }, 'No calibration samples yet. Correct, independent, uninterrupted answers build your personal baselines.'), h('p', { class: 'faint tiny' }, 'Baselines are kept separately per input method and task type. Fewer than 8 samples: correct answers are graded Good; 8–24: provisional (Hard only for strong hesitation, no Easy); 25+: personal thresholds.')));

  // Retention calibration
  const cal = retentionCalibration(events, { corr });
  if (cal.bins.some((b) => b.n)) {
    blocks.push(h('section', { class: 'panel' }, h('div', { class: 'grid-2' },
      h('div', {}, h('h3', {}, 'Retention calibration'), h('p', { class: 'faint small' }, 'Each dot compares the retrievability FSRS predicted before a delayed review with how often you actually recalled it. Dots on the dashed line mean the model is well calibrated for you.'), cal.affectedExcluded ? h('p', { class: 'faint tiny' }, `${cal.affectedExcluded} delayed tests excluded because practice or a sibling card’s answer was seen in between.`) : null),
      h('div', { style: { display: 'grid', placeItems: 'center' } }, calibrationChart(cal.bins))),
      dataTable(['Predicted', 'Observed', 'n', '95% interval'], cal.bins.filter((b) => b.n).map((b) => [percent(b.predicted), percent(b.observed), String(b.n), `${percent(b.ci.low)}–${percent(b.ci.high)}`]))));
  }

  // Activity
  const cells = heatmapLevels(activity, { today: tctx.today, days: 7 * 53 });
  const last30 = Array.from({ length: 30 }, (_, i) => {
    const d = addDays(tctx.today, i - 29);
    const a = activity.get(d);
    return { label: d, value: a?.reviews || 0, tick: i % 7 === 0 ? d.slice(5) : '' };
  });
  blocks.push(h('section', { class: 'panel stack' }, h('h3', {}, 'Review activity'),
    h('div', { class: 'heatmap', role: 'img', 'aria-label': 'Study activity over the last year' }, cells.map((c) => h('div', { class: `cell l${c.level}`, title: `${c.day}: ${c.count}` }))),
    chartWithTable(barChart(last30, { label: 'Scheduled reviews per day, last 30 days' }), dataTable(['Day', 'Reviews'], last30.map((d) => [d.label, String(d.value)])), { title: 'Scheduled reviews per day' })));

  // Forecast
  const fcData = fc.map((d, i) => ({ label: d.day, value: d.due, tick: i % 5 === 0 ? d.day.slice(5) : '' }));
  blocks.push(h('section', { class: 'panel' }, chartWithTable(barChart(fcData, { label: 'Reviews due per day over the next 30 days' }), dataTable(['Day', 'Due'], fcData.map((d) => [d.label, String(d.value)])), { title: 'Upcoming workload (30 days)' }), fc[0].overdueCarried ? h('p', { class: 'faint tiny' }, `Today includes ${fc[0].overdueCarried} overdue cards (their real due dates are kept). Postponed cards are shown on their return day.`) : null));

  // Strongest / weakest
  const sw = strongestWeakest(units, { now: tctx.now, params, limit: 6 });
  const unitRow = (x, note) => {
    const card = app.cache.cards.get(x.unit.cardId);
    return h('a', { class: 'list-row clickable', href: `#/card/${x.unit.cardId}` }, h('span', { class: 'grow truncate' }, card ? plainFront(card) : '(deleted)'), h('span', { class: 'faint small nowrap' }, note(x)));
  };
  blocks.push(h('div', { class: 'grid-2' },
    h('section', { class: 'panel flush' }, h('div', { style: { padding: '16px 16px 4px' } }, h('h3', {}, 'Strongest')), h('div', { class: 'list' }, sw.strongest.map((x) => unitRow(x, (y) => `stability ${formatInterval(y.stability)}`)))),
    h('section', { class: 'panel flush' }, h('div', { style: { padding: '16px 16px 4px' } }, h('h3', {}, 'Weakest')), h('div', { class: 'list' }, sw.weakest.map((x) => unitRow(x, (y) => `${y.lapses} lapses · R ${percent(y.r)}${y.unit.practiceSinceLast ? '*' : ''}`))),
      sw.weakest.some((x) => x.unit.practiceSinceLast) ? h('p', { class: 'faint tiny', style: { padding: '0 16px 12px' } }, '* Practised since the last scheduled review; the predicted recall (R) does not include that practice.') : null)));

  // Leeches
  const leeches = units.filter((u) => u.active && (u.leech || isLeech(u, { threshold: app.cache.decks.get(u.deckId)?.settings?.leechThreshold ?? 4, minDifficulty: store.global.leechMinDifficulty ?? 7 })));
  blocks.push(h('section', { class: 'panel flush' }, h('div', { style: { padding: '16px 16px 4px' } }, h('h3', {}, `Leeches (${leeches.length})`), h('p', { class: 'faint small' }, 'Cards that keep lapsing despite study. Rewording the prompt or adding a hint usually helps more than more repetitions.')),
    leeches.length ? h('div', { class: 'list' }, leeches.slice(0, 40).map((u) => {
      const card = app.cache.cards.get(u.cardId);
      if (!card) return null;
      const actions = h('button', { class: 'btn small', onclick: (e) => menu(e.currentTarget, leechActions(card, { toast })) }, 'Fix…', icon('chevronDown'));
      return h('div', { class: 'list-row' }, h('span', { class: 'chip danger' }, `${u.state?.lapses ?? 0} lapses`), h('a', { class: 'grow truncate', href: `#/card/${card.id}` }, plainFront(card)), actions);
    })) : h('p', { class: 'faint', style: { padding: '0 16px 16px' } }, 'No leeches. 🎉')));

  // Deck trends: week-by-week first-attempt accuracy per deck
  const trends = deckTrends(events, { today: tctx.today, weeks: 8, corr });
  if (trends.size) {
    const weeks = recentWeeks(tctx.today, 8);
    const cell = (r) => (r ? h('span', { title: `${r.correct} of ${r.n} independent correct` }, percent(r.correct / r.n), h('span', { class: 'faint tiny' }, ` n=${r.n}`)) : h('span', { class: 'faint', 'aria-label': 'no reviews' }, '—'));
    const rows = [...trends.entries()].map(([deckId, list]) => {
      const byWeek = new Map(list.map((r) => [r.week, r]));
      const n = list.reduce((s, r) => s + r.n, 0);
      const c = list.reduce((s, r) => s + r.correct, 0);
      return h('tr', {}, h('th', { scope: 'row', style: { textTransform: 'none', letterSpacing: 'normal', fontSize: 'inherit', color: 'var(--text)' } }, app.cache.decks.get(deckId)?.name || '(deleted deck)'), h('td', { class: 'num' }, percent(c / n), h('span', { class: 'faint tiny' }, ` n=${n}`)), weeks.map((w) => h('td', { class: 'num nowrap' }, cell(byWeek.get(w)))));
    });
    blocks.push(h('section', { class: 'panel' }, h('h3', {}, 'Per-deck trends (8 weeks)'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('caption', { class: 'visually-hidden' }, 'Independent first-attempt accuracy of scheduled reviews per deck and week'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Deck'), h('th', { scope: 'col' }, '8 weeks'), weeks.map((w) => h('th', { scope: 'col', class: 'nowrap', title: `Week of ${w}` }, weekLabel(w))))),
        h('tbody', {}, rows))),
      h('p', { class: 'faint tiny' }, 'Independent first-attempt accuracy of scheduled reviews, by week (columns start on Monday); n = reviews. Weeks with few reviews are noisy.')));
  }

  // Confidence before checking (pre-feedback)
  const ca = confidenceAnalysis(events, corr);
  if (ca.n) {
    blocks.push(h('section', { class: 'panel stack' }, h('h3', {}, 'Confidence before checking'),
      dataTable(['You said', 'Answers', 'Literally correct', 'Recalled on your own'], [['guessing', 'Guessing'], ['unsure', 'Unsure'], ['confident', 'Confident']].filter(([k]) => ca.levels[k].n).map(([k, label]) => [label, String(ca.levels[k].n), percent(ca.levels[k].literalRate.p), percent(ca.levels[k].independentRate.p)]), { caption: 'Outcome by the confidence you gave before seeing the answer' }),
      h('p', { class: 'faint tiny' }, `${pluralize(ca.unset, 'answer')} had no confidence set (unknown, not “confident”). A guess is never counted as recall, even when it matches.`)));
  }

  // Confidence self-ratings (older versions asked after feedback)
  const sr = selfRatingAnalysis(events, { corr });
  if (sr.n) {
    const avg = (v, digits = 1) => (v != null ? v.toFixed(digits) : '—');
    blocks.push(h('section', { class: 'panel stack' }, h('h3', {}, 'Confidence after feedback (older versions)'),
      h('p', { class: 'faint small' }, [`${pluralize(sr.n, 'answer')} rated.`, sr.meanRatingCorrect != null ? `Mean rating ${avg(sr.meanRatingCorrect)} when the answer was correct.` : null, sr.meanRatingIncorrect != null ? `Mean rating ${avg(sr.meanRatingIncorrect)} when it was not.` : null].filter(Boolean).join(' ')),
      h('div', { class: 'stack' },
        dataTable(['Your rating', 'Answers', 'Correct', '95% interval', 'Mean automatic grade', 'Mean heuristic grading confidence'], sr.levels.filter((l) => l.n).map((l) => [`${l.value} of 5`, String(l.n), percent(l.accuracy.p), `${percent(l.accuracy.low)}–${percent(l.accuracy.high)}`, l.meanGrade != null ? `${avg(l.meanGrade)} (${RATING_LABELS[Math.round(l.meanGrade)]})` : '—', l.meanConfidence != null ? percent(l.meanConfidence) : '—']), { caption: 'Correctness and automatic grade by confidence self-rating' }),
        dataTable(['Automatic grade', 'Rated answers', 'Mean self-rating'], sr.byGrade.filter((g) => g.n).map((g) => [RATING_LABELS[g.grade], String(g.n), avg(g.meanRating)]), { caption: 'Mean confidence self-rating by automatic grade' })),
      h('p', { class: 'faint tiny' }, 'Self-ratings are your own judgement, kept separately from the automatic grade; they are not a validated probability and never change grading. Ratings that rise with the automatic grade suggest the grading thresholds match how fluent the answers felt to you.')));
  }

  // Exposure log
  const allExp = exposureBreakdown(events);
  blocks.push(h('section', { class: 'panel' }, h('h3', {}, 'Event log'), dataTable(['Event type', 'Count'], Object.entries(allExp).filter(([, v]) => v).map(([k, v]) => [k, String(v)])), h('p', { class: 'faint tiny' }, 'Scheduled reviews, practice, hints, reveals, correction copies, sibling-answer exposure, corrections, edits, skips and self-ratings are logged separately.')));

  // Research comparison
  const study = store.global.research?.study;
  if (study) {
    const rep = comparisonReport(events, study);
    blocks.push(h('section', { class: 'panel stack' }, h('h3', {}, 'Research comparison'), callout('info', rep.caution),
      rep.mixedPolicies ? callout('warning', `This study includes reviews graded under different policies (${Object.entries(rep.policies).map(([k, v]) => `${k}: ${v}`).join(', ')}). Grading changed during the study; start a new study for a clean comparison.`) : null,
      dataTable(['Arm', 'Delayed tests', 'Recall', '95% interval', 'Predicted', 'Median interval', 'Study time', 'Minutes per card', 'Seconds per review', 'Excluded (exposure)'], Object.entries(rep.arms).map(([arm, a]) => [arm === 'axon' ? 'Axon automatic grading' : 'Standard FSRS self-grading', String(a.delayedTests), percent(a.recall.p), `${percent(a.recall.low)}–${percent(a.recall.high)}`, a.meanPredictedRecall != null ? percent(a.meanPredictedRecall) : '—', Number.isFinite(a.medianElapsedDays) ? formatInterval(a.medianElapsedDays) : '—', `${Math.round(a.studyMinutes)} min`, a.minutesPerCard != null ? a.minutesPerCard.toFixed(1) : '—', a.medianSecondsPerReview != null ? a.medianSecondsPerReview.toFixed(1) : '—', String(a.excludedAffectedByExposure)])),
      rep.arms.standard.selfRatings ? h('p', { class: 'faint small' }, `Self-grades agreed with Axon’s automatic grade ${percent(rep.arms.standard.selfRatingAgreement)} of the time (${rep.arms.standard.selfRatings} self-graded reviews). Study time includes the time spent choosing a self-grade.`) : null,
      h('p', { class: 'faint tiny' }, `Study ${study.id.slice(0, 8)} · started ${study.startDay} · ${study.design} assignment by card · ${study.gradingVersion} · ${study.schedulerVersion}`)));
  }
  blocks.push(h('div', { class: 'row end' }, button('Export de-identified data (CSV)', { iconName: 'download', onclick: () => {
    try {
      const csv = toCsv(deidentifiedRows(events));
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `axon-evaluation-${tctx.today}.csv`);
      toast('Exported without card content, answers or credentials');
    } catch (err) {
      errorToast(err);
    }
  } })));
  replace(body, blocks);
  return null;
}

export { formatDate };

/** Observed recall with its denominator spelled out. */
function observedRecall(sum) {
  const a = sum.assessment;
  const ci = a.recall;
  const pct = (w) => (Number.isFinite(w.p) ? `${percent(w.p)} (n = ${w.n})` : '—');
  return [
    h('div', { class: 'stat' }, h('div', { class: 'value' }, Number.isFinite(ci.p) ? percent(ci.p) : '—'), h('div', { class: 'label' }, 'Recalled on your own, first attempt of each scheduled review'), Number.isFinite(ci.p) ? h('div', { class: 'note' }, `95% interval ${percent(ci.low)}–${percent(ci.high)} · n = ${ci.n}`) : null),
    a.opportunities ? h('div', { class: 'faint small' }, `Of ${pluralize(a.opportunities, 'first attempt')}: ${a.independent} on your own, ${a.assisted} with help, ${a.revealed} answer shown or “I don’t know”, ${a.guessed} guessed, ${a.failed} not correct.${a.selfChecked ? ` ${a.selfChecked} were checked by you (handwriting or uncheckable answers), not by Axon.` : ''} Skipped ${a.skipped} and left unanswered ${a.abandoned} are not counted.`) : null,
    a.opportunities ? h('div', { class: 'faint small' }, `Delayed reviews: ${pct(a.delayedRecall)}. New cards, first test: ${pct(a.newCardRecall)} (learning, not retention). Accuracy among attempts made without help: ${pct(a.unaidedAccuracy)} (conditional, not overall retention).`) : null,
    a.legacy ? h('div', { class: 'faint tiny' }, `${a.legacy} older reviews were recorded before confidence and guesses were captured; for them those facts are unknown.`) : null,
  ];
}
