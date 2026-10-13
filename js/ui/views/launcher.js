/** Study launcher: choose a mode and scope; vacation/postpone tools. */

import { h, replace, formatDate } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button, checklist } from './common.js';
import { switchControl, segmented, settingRow, toast, sheet, callout, errorToast, select } from '../components.js';
import { MODES, createSession } from '../../study/session.js';
import { planPostpone } from '../../core/queue.js';
import { addDays, studyDayStart, daysBetween } from '../../core/time.js';
import { uuid } from '../../core/util.js';

export async function view(outlet, params, query) {
  await app.cache.ensure();
  const { root, body } = page({ title: 'Study', sub: 'Daily Review keeps your long-term schedule. Practice modes are extra and don’t change it unless you choose to record them.', actions: [button('Exam plans', { iconName: 'book', href: '#/plans' }), button('Vacation', { iconName: 'beach', onclick: () => postponeDialog() })] });
  outlet.append(root);
  const plans = await store.listPlans();
  const st = { mode: query.mode && MODES[query.mode] ? query.mode : 'daily', deckIds: query.deck ? [query.deck] : [], tags: [], order: 'shuffled', includeNew: true, keepSiblingsTogether: false, limit: '', recordAsReviews: null, planId: plans[0]?.id || '', catchUpOrder: 'overdue', timer: false };
  const sessionsHost = h('div');
  const modeHost = h('div', { class: 'mode-grid', role: 'group', 'aria-label': 'Study mode' });
  const optionsHost = h('section', { class: 'panel stack' });
  body.append(sessionsHost, modeHost, optionsHost);

  const sessions = (await store.activeSessions()).filter((s) => s.index < s.queue.length);
  if (sessions.length) {
    replace(sessionsHost, h('section', { class: 'panel stack' }, h('h3', {}, 'Continue'), h('div', { class: 'list' }, sessions.slice(0, 5).map((s) => h('div', { class: 'list-row' },
      icon(MODES[s.mode]?.icon || 'play'),
      h('div', { class: 'grow' }, h('div', {}, `${MODES[s.mode]?.label || s.mode}${s.status === 'paused' ? ' (paused)' : ''}`), h('div', { class: 'faint small' }, `${s.index} of ${s.queue.length} · started ${formatDate(s.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}`)),
      button('Resume', { kind: 'primary small', href: `#/study/session/${s.id}` }),
      button('End', { small: true, onclick: async () => { await store.saveSession({ ...s, status: 'abandoned', abandonedAt: Date.now() }); app.router.navigate('/study'); } }))))));
  }

  function renderModes() {
    const available = Object.entries(MODES).filter(([k]) => k !== 'exam' || plans.length);
    replace(modeHost, available.map(([key, m]) => h('button', { type: 'button', class: 'mode-card', 'aria-pressed': String(st.mode === key), onclick: () => { st.mode = key; renderModes(); renderOptions(); } }, icon(m.icon), h('b', {}, m.label), h('span', {}, m.desc))));
  }

  function renderOptions() {
    const m = MODES[st.mode];
    const decks = [...app.cache.decks.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ value: d.id, label: d.name, color: d.color }));
    const tags = app.cache.allTags().slice(0, 60).map(([t, n]) => ({ value: t, label: `${t} · ${n}` }));
    const parts = [h('h3', {}, m.label)];
    if (st.mode !== 'exam') {
      parts.push(h('div', { class: 'field' }, h('div', { class: 'label' }, 'Decks'), h('div', { class: 'hint' }, 'None selected = all decks.'), checklist({ items: decks, selected: st.deckIds, onchange: (v) => { st.deckIds = v; }, emptyText: 'Create a deck first.' })));
    }
    if (['cram', 'drill', 'speed', 'interleave'].includes(st.mode)) {
      parts.push(h('div', { class: 'field' }, h('div', { class: 'label' }, 'Tags'), h('div', { class: 'hint' }, st.mode === 'interleave' ? 'Pick several tags to interleave topics, or leave empty to mix decks.' : 'Optional filter.'), checklist({ items: tags, selected: st.tags, onchange: (v) => { st.tags = v; }, emptyText: 'No tags yet.' })));
    }
    if (st.mode === 'cram') {
      parts.push(settingRow({ title: 'Order', control: segmented({ options: [{ value: 'shuffled', label: 'Shuffled' }, { value: 'ordered', label: 'In order' }], value: st.order, onchange: (v) => { st.order = v; } }) }));
      parts.push(settingRow({ title: 'Include new cards', control: switchControl({ checked: st.includeNew, onchange: (v) => { st.includeNew = v; } }) }));
      parts.push(settingRow({ title: 'Keep related cards together', desc: 'Overrides sibling spacing (e.g. study both directions back to back).', control: switchControl({ checked: st.keepSiblingsTogether, onchange: (v) => { st.keepSiblingsTogether = v; } }) }));
    }
    if (st.mode === 'interleave') parts.push(settingRow({ title: 'Include new cards', control: switchControl({ checked: st.includeNew, onchange: (v) => { st.includeNew = v; } }) }));
    if (st.mode === 'catchup') {
      parts.push(settingRow({ title: 'Priority', desc: 'Which overdue cards to do first. The others keep their real due dates and overdue status.', control: segmented({ options: [{ value: 'overdue', label: 'Most overdue' }, { value: 'retrievability', label: 'Still recallable' }], value: st.catchUpOrder, onchange: (v) => { st.catchUpOrder = v; } }) }));
    }
    if (st.mode === 'exam') {
      parts.push(settingRow({ title: 'Exam plan', control: select({ label: 'Exam plan', options: plans.map((p) => ({ value: p.id, label: `${p.name || 'Exam'} · ${p.examDate}` })), value: st.planId, onchange: (v) => { st.planId = v; } }) }));
    }
    if (st.mode !== 'daily') {
      const limitInput = h('input', { class: 'input', type: 'number', min: '1', max: '2000', placeholder: st.mode === 'catchup' ? '50' : st.mode === 'cram' ? 'All' : st.mode === 'interleave' || st.mode === 'exam' ? '30' : '20', style: { width: '110px' } });
      limitInput.value = st.limit;
      limitInput.addEventListener('input', () => { st.limit = limitInput.value; });
      parts.push(settingRow({ title: 'Cards in this session', control: limitInput }));
    }
    if (m.practice) {
      const def = !!store.global.practiceAffectsSchedule?.[st.mode];
      parts.push(settingRow({ title: 'Record as scheduling reviews', desc: 'Off: practice is recorded as exposure but your long-term FSRS schedule is unchanged (recommended).', control: switchControl({ checked: st.recordAsReviews ?? def, onchange: (v) => { st.recordAsReviews = v; } }) }));
    }
    if (st.mode === 'speed') parts.push(settingRow({ title: 'Show a timer', desc: 'A small per-card timer. Optional and non-distracting.', control: switchControl({ checked: st.timer, onchange: (v) => { st.timer = v; } }) }));
    parts.push(h('div', { class: 'row end' }, button('Start', { kind: 'primary large', iconName: 'play', onclick: start })));
    replace(optionsHost, parts);
  }

  async function start() {
    try {
      const plan = plans.find((p) => p.id === st.planId);
      const s = await createSession({ ...st, limit: st.limit ? Number(st.limit) : null, plan, deckIds: st.mode === 'exam' ? plan?.deckIds : st.deckIds });
      if (!s.queue.length) {
        const why = st.mode === 'daily' ? 'Nothing is due right now. Try Cram or Drill Weakest for extra practice.' : st.mode === 'speed' ? 'Speed Practice uses cards you have already learned (reviewed at least twice).' : 'No cards match this selection.';
        toast(why, { timeout: 6000 });
        await store.saveSession({ ...s, status: 'completed' });
        return;
      }
      app.navigate(`/study/session/${s.id}`);
    } catch (err) {
      errorToast(err);
    }
  }

  renderModes();
  renderOptions();
  return null;
}

/** Vacation / postpone: overlays only; FSRS due dates are untouched. */
export function postponeDialog() {
  const today = store.today();
  const st = { days: 7, until: addDays(today, 7), mode: 'redistribute', spread: 5, deckIds: [] };
  const decks = [...app.cache.decks.values()].map((d) => ({ value: d.id, label: d.name, color: d.color }));
  const untilInput = h('input', { class: 'input', type: 'date', value: st.until, min: addDays(today, 1) });
  untilInput.addEventListener('change', () => { st.until = untilInput.value; });
  const spreadInput = h('input', { class: 'input', type: 'number', min: '1', max: '60', value: String(st.spread), style: { width: '90px' } });
  spreadInput.addEventListener('input', () => { st.spread = Number(spreadInput.value) || 1; });
  const s = sheet({
    title: 'Vacation / postpone',
    content: h('div', { class: 'stack' },
      callout('info', 'Postponed cards are hidden until the date you choose. Their FSRS state, intervals, history and real due dates are not changed — they will show as overdue when they return, and nothing is marked as reviewed. This is different from suspending (indefinite) or burying (until tomorrow).'),
      settingRow({ title: 'Return on', control: untilInput }),
      settingRow({ title: 'When I return', control: segmented({ options: [{ value: 'redistribute', label: 'Spread the backlog' }, { value: 'shift', label: 'All at once' }], value: st.mode, onchange: (v) => { st.mode = v; } }) }),
      settingRow({ title: 'Spread over (days)', control: spreadInput }),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Decks'), h('div', { class: 'hint' }, 'None selected = all decks.'), checklist({ items: decks, selected: [], onchange: (v) => { st.deckIds = v; } }))),
    footer: (close) => [
      h('button', { class: 'btn', onclick: async () => {
        const units = [...app.cache.units.values()].filter((u) => u.overlays?.postponedUntil);
        if (!units.length) return toast('Nothing is postponed');
        await store.patchUnits(units.map((u) => ({ unitId: u.id, overlays: { postponedUntil: null, postponeBatch: null } })));
        await app.cache.load();
        toast(`Returned ${units.length} postponed cards to the queue`);
        close();
      } }, 'Clear all postponements'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!st.until || daysBetween(today, st.until) < 1) return toast('Choose a future date');
        const opts = store.timeOptions();
        const batchId = uuid();
        const plan = planPostpone({ units: [...app.cache.units.values()] }, { untilDay: st.until, untilStart: studyDayStart(st.until, opts), mode: st.mode, spreadDays: st.spread, deckIds: st.deckIds.length ? st.deckIds : null, batchId });
        await store.patchUnits(plan.changes.map((c) => ({ unitId: c.unitId, overlays: { postponedUntil: c.postponedUntil, postponeBatch: batchId } })));
        await app.cache.load();
        close();
        toast(`Postponed ${plan.count} card${plan.count === 1 ? '' : 's'} until ${st.until}${st.mode === 'redistribute' ? ` (spread over ${st.spread} days)` : ''}`, {
          action: { label: 'Undo', run: async () => {
            await store.patchUnits(plan.changes.map((c) => ({ unitId: c.unitId, overlays: { postponedUntil: null, postponeBatch: null } })));
            await app.cache.load();
          } },
          timeout: 10000,
        });
      } }, 'Postpone'),
    ],
  });
  return s;
}
