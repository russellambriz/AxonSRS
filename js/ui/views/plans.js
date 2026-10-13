/** Exam plans: coverage, workload estimate and exam practice. */

import { h, replace, percent } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button, checklist, kpi } from './common.js';
import { sheet, toast, confirmDialog, callout, settingRow, errorToast } from '../components.js';
import { analyzeExamPlan } from '../../core/planner.js';
import { addDays } from '../../core/time.js';
import { createSession } from '../../study/session.js';

export async function view(outlet) {
  await app.cache.ensure();
  const { root, body } = page({ title: 'Exam plans', sub: 'Plan coverage for a test date. Plans never change your long-term schedule; exam practice is recorded as exposure.', crumbs: [{ label: 'Study', href: '#/study' }], actions: [button('New plan', { kind: 'primary', iconName: 'plus', onclick: () => editPlan(null, render) })] });
  outlet.append(root);
  async function render() {
    const [plans, events] = await Promise.all([store.listPlans(), store.allEvents()]);
    if (!plans.length) {
      replace(body, h('div', { class: 'empty' }, h('div', { class: 'art' }, icon('book')), h('h2', {}, 'No exam plans'), h('p', {}, 'Choose an exam date, the decks or tags it covers and a daily time budget. Axon estimates whether the budget covers the work.'), button('Create a plan', { kind: 'primary', onclick: () => editPlan(null, render) })));
      return;
    }
    const tctx = app.timeCtx();
    replace(body, plans.sort((a, b) => a.examDate.localeCompare(b.examDate)).map((plan) => {
      const a = analyzeExamPlan(plan, { units: [...app.cache.units.values()], cardsById: app.cache.cards, events, today: tctx.today, now: tctx.now, params: store.paramsFor(null) });
      return h('section', { class: 'panel stack' },
        h('div', { class: 'row between' }, h('div', {}, h('h2', {}, plan.name || 'Exam'), h('div', { class: 'faint small' }, `${plan.examDate} · ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} left · ${a.totalUnits} study units`)),
          h('div', { class: 'row tight' }, button('Practise', { kind: 'primary', iconName: 'play', onclick: async () => { try { const s = await createSession({ mode: 'exam', plan, deckIds: plan.deckIds, limit: 30 }); if (!s.queue.length) return toast('Nothing to practise in this plan yet'); app.navigate(`/study/session/${s.id}`); } catch (err) { errorToast(err); } } }), button('Edit', { onclick: () => editPlan(plan, render) }), button('Delete', { kind: 'ghost', onclick: async () => { if (await confirmDialog({ title: 'Delete plan?', message: 'Only the plan is removed; cards and history are unaffected.', confirmLabel: 'Delete', danger: true })) { await store.deletePlan(plan.id); render(); } } }))),
        h('div', { class: 'kpis' },
          kpi('Coverage', percent(a.coverage), `target ${percent(a.targetCoverage)} · ${a.unintroduced} not yet introduced`),
          kpi('Observed recall', a.observedRecall.accuracy != null ? percent(a.observedRecall.accuracy) : '—', `${a.observedRecall.n} first attempts in scope`),
          kpi('Predicted recall now', a.predictedRecallNow != null ? percent(a.predictedRecallNow) : '—', 'model estimate'),
          kpi('Weak topics', String(a.weak), 'low retrievability, leeches or recent misses')),
        h('div', { class: 'timing' },
          h('span', {}, 'Estimated remaining work ', h('b', {}, `${Math.round(a.estimatedMinutes)} min`)),
          h('span', {}, 'Budget until exam ', h('b', {}, `${Math.round(a.budgetMinutes)} min`)),
          h('span', {}, 'Needed per day ', h('b', {}, `${Math.round(a.minutesPerDayNeeded)} min`)),
          h('span', {}, 'New per day ', h('b', {}, String(a.newPerDayNeeded)))),
        a.likelyInsufficient ? callout('warning', `At ${plan.dailyMinutes} min/day the budget is unlikely to cover the planned work. Consider more time per day, a lower target coverage, or prioritising weak topics.`) : callout('success', 'The daily budget looks sufficient for the planned work.'),
        a.provisional ? h('p', { class: 'faint tiny' }, 'Time estimates are provisional until Axon has enough of your own review timings.') : null,
        a.predictedRecallAtExamWithoutStudy != null ? h('p', { class: 'faint tiny' }, `If you stopped studying today, the model predicts about ${percent(a.predictedRecallAtExamWithoutStudy)} average recall on exam day. This is an estimate, not a guarantee of readiness or a score.`) : null);
    }));
  }
  await render();
  const off = app.onChange(render);
  return { destroy: off };
}

function editPlan(plan, onSaved) {
  const today = store.today();
  const st = plan ? structuredClone(plan) : { name: '', examDate: addDays(today, 30), deckIds: [], tags: [], dailyMinutes: 30, targetCoverage: 1 };
  const name = h('input', { class: 'input', value: st.name, placeholder: 'e.g. Biochemistry final' });
  name.addEventListener('input', () => { st.name = name.value; });
  const date = h('input', { class: 'input', type: 'date', value: st.examDate, min: addDays(today, 1) });
  date.addEventListener('change', () => { st.examDate = date.value; });
  const minutes = h('input', { class: 'input', type: 'number', min: '5', max: '600', value: String(st.dailyMinutes), style: { width: '100px' } });
  minutes.addEventListener('input', () => { st.dailyMinutes = Number(minutes.value) || 30; });
  const coverage = h('input', { class: 'input', type: 'number', min: '10', max: '100', value: String(Math.round(st.targetCoverage * 100)), style: { width: '100px' } });
  coverage.addEventListener('input', () => { st.targetCoverage = Math.min(1, Math.max(0.1, (Number(coverage.value) || 100) / 100)); });
  sheet({
    title: plan ? 'Edit exam plan' : 'New exam plan',
    content: h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', {}, 'Name'), name),
      settingRow({ title: 'Exam date', control: date }),
      settingRow({ title: 'Daily study time (minutes)', control: minutes }),
      settingRow({ title: 'Target coverage (%)', desc: 'Share of cards in scope you want introduced before the exam.', control: coverage }),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Decks'), checklist({ items: [...app.cache.decks.values()].map((d) => ({ value: d.id, label: d.name, color: d.color })), selected: st.deckIds, onchange: (v) => { st.deckIds = v; } })),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Tags (optional)'), checklist({ items: app.cache.allTags().slice(0, 60).map(([t]) => ({ value: t, label: t })), selected: st.tags, onchange: (v) => { st.tags = v; }, emptyText: 'No tags.' }))),
    footer: (close) => [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
      if (!st.examDate) return toast('Choose an exam date');
      await store.savePlan(st);
      close();
      onSaved();
    } }, 'Save plan')],
  });
}
