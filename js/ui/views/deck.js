/** Deck detail: card browser, deck-specific study settings, overview. */

import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button, kpi } from './common.js';
import { menu, segmented, select, settingRow, toast, confirmDialog, switchControl, errorToast } from '../components.js';
import { cardBrowser } from './browser.js';
import { deckMenuItems } from './decks.js';
import { startDaily, createSession } from '../../study/session.js';
import { DEFAULT_DECK_SETTINGS, ANSWER_MODE_LABELS, TASK_TYPE_LABELS } from '../../core/model.js';
import { deckTrends, isLeech } from '../../core/stats.js';
import { percent } from '../dom.js';

export async function view(outlet, { id }, query) {
  await app.cache.ensure();
  const deck = app.cache.decks.get(id);
  if (!deck) {
    outlet.append(h('div', { class: 'view narrow' }, h('div', { class: 'empty' }, h('h2', {}, 'Deck not found'), h('p', {}, 'It may have been deleted on this or another device.'), button('All decks', { href: '#/decks', kind: 'primary' }))));
    return null;
  }
  let tab = query.tab || 'cards';
  const more = h('button', { class: 'btn icon', 'aria-label': 'Deck actions', onclick: (e) => menu(e.currentTarget, deckMenuItems(app.cache.decks.get(id) || deck)) }, icon('more'));
  const { root, body, header } = page({
    title: deck.name,
    sub: deck.description || null,
    crumbs: [{ label: 'Decks', href: '#/decks' }, ...(deck.group ? [{ label: deck.group }] : [])],
    actions: [
      button('Add card', { iconName: 'plus', href: `#/card/new?deck=${encodeURIComponent(id)}` }),
      button('Study', { kind: 'primary', iconName: 'play', onclick: () => startDaily([id]).catch(errorToast) }),
      more,
    ],
  });
  outlet.append(root);
  const tabsEl = h('div', { role: 'tablist', class: 'segmented', 'aria-label': 'Deck sections' });
  const panel = h('div', { role: 'tabpanel' });
  let browser = null;
  const tabs = [['cards', 'Cards'], ['overview', 'Overview'], ['settings', 'Settings']];

  function renderTabs() {
    replace(tabsEl, tabs.map(([key, label]) => h('button', { role: 'tab', 'aria-selected': String(tab === key), onclick: () => { tab = key; history.replaceState(null, '', `#/deck/${encodeURIComponent(id)}${key === 'cards' ? '' : `?tab=${key}`}`); renderTabs(); renderPanel(); } }, label)));
  }

  function renderPanel() {
    browser?.destroy();
    browser = null;
    const current = app.cache.decks.get(id);
    if (!current) return;
    header.querySelector('h1').textContent = current.name;
    if (tab === 'cards') {
      browser = cardBrowser({ deckId: id });
      replace(panel, browser.el);
    } else if (tab === 'settings') replace(panel, settingsPanel(current));
    else overviewPanel(current).then((el) => replace(panel, el));
  }

  renderTabs();
  body.append(tabsEl, panel);
  renderPanel();
  const off = app.onChange(() => {
    if (!app.cache.decks.has(id)) return;
    if (tab === 'overview') renderPanel();
    else header.querySelector('h1').textContent = app.cache.decks.get(id).name;
  });
  return { destroy: () => { off(); browser?.destroy(); } };
}

async function overviewPanel(deck) {
  const c = app.counts({ deckId: deck.id });
  const events = (await store.eventsSince(Date.now() - 120 * 86400000)).filter((e) => e.deckId === deck.id);
  const trends = deckTrends(events, { today: store.today(), weeks: 8 }).get(deck.id) || [];
  const units = [...app.cache.units.values()].filter((u) => u.deckId === deck.id && u.active);
  const leeches = units.filter((u) => u.leech || isLeech(u, { threshold: deck.settings.leechThreshold }));
  let rSum = 0;
  let rN = 0;
  for (const u of units) {
    const r = app.retrievability(u);
    if (r != null) { rSum += r; rN++; }
  }
  const first = events.filter((e) => e.type === 'review' && e.firstAttempt);
  const independent = first.filter((e) => e.response?.correct && !e.assistance?.hintShown && !e.assistance?.revealed).length;
  return h('div', { class: 'stack loose' },
    h('div', { class: 'kpis' },
      kpi('Due now', String(c.due + c.learning)),
      kpi('New available', String(c.newAvailable)),
      kpi('Observed recall (120 d)', first.length ? percent(independent / first.length) : '—', `${first.length} first attempts, independent only`),
      kpi('Predicted recall now', rN ? percent(rSum / rN) : '—', 'FSRS estimate, not an observation')),
    h('section', { class: 'panel' }, h('h3', {}, 'Weekly first-attempt accuracy'),
      trends.length ? h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Week of'), h('th', {}, 'Reviews'), h('th', {}, 'Independent correct'))), h('tbody', {}, trends.map((t) => h('tr', {}, h('td', {}, t.week), h('td', { class: 'num' }, String(t.n)), h('td', { class: 'num' }, percent(t.correct / t.n)))))) : h('p', { class: 'faint' }, 'No reviews in the last 8 weeks.')),
    h('section', { class: 'panel' }, h('h3', {}, `Leeches (${leeches.length})`),
      leeches.length ? h('div', { class: 'list' }, leeches.slice(0, 50).map((u) => {
        const card = app.cache.cards.get(u.cardId);
        return h('a', { class: 'list-row clickable', href: `#/card/${u.cardId}` }, h('span', { class: 'chip danger' }, `${u.state?.lapses ?? 0} lapses`), h('span', { class: 'grow truncate' }, card ? card.front[0] : u.cardId), icon('chevronRight'));
      })) : h('p', { class: 'faint' }, `No cards have lapsed ${deck.settings.leechThreshold}+ times with high difficulty.`)));
}

function settingsPanel(deck) {
  const s = { ...DEFAULT_DECK_SETTINGS, ...deck.settings };
  const draft = { name: deck.name, description: deck.description, group: deck.group, color: deck.color, settings: { ...s } };
  const set = (k, v) => { draft.settings[k] = v; };
  const num = (k, { min = 0, max = 9999, step = 1 } = {}) => {
    const el = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), step: String(step), style: { width: '110px' } });
    el.value = draft.settings[k] ?? '';
    el.addEventListener('change', () => set(k, el.value === '' ? null : Number(el.value)));
    return el;
  };
  const text = (k, placeholder = '') => {
    const el = h('input', { class: 'input', placeholder });
    el.value = Array.isArray(draft.settings[k]) ? draft.settings[k].join(' ') : draft.settings[k] ?? '';
    el.addEventListener('change', () => set(k, el.value.split(/[\s,]+/).filter(Boolean)));
    return el;
  };
  const nameInput = h('input', { class: 'input', value: deck.name });
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
  const descInput = h('textarea', { class: 'textarea', rows: '2' });
  descInput.value = deck.description || '';
  descInput.addEventListener('input', () => { draft.description = descInput.value; });
  const groupInput = h('input', { class: 'input', value: deck.group || '', placeholder: 'None' });
  groupInput.addEventListener('input', () => { draft.group = groupInput.value; });
  const colorInput = h('input', { type: 'color', value: deck.color, 'aria-label': 'Deck colour', style: { width: '48px', height: '36px', border: 0, background: 'transparent' } });
  colorInput.addEventListener('input', () => { draft.color = colorInput.value; });
  const retention = h('input', { class: 'input', type: 'number', min: '70', max: '99', step: '1', placeholder: `Global (${Math.round((store.global.desiredRetention || 0.9) * 100)}%)`, style: { width: '160px' } });
  retention.value = s.desiredRetention ? Math.round(s.desiredRetention * 100) : '';
  retention.addEventListener('change', () => set('desiredRetention', retention.value ? Math.min(0.99, Math.max(0.7, Number(retention.value) / 100)) : null));
  const autoAdvance = h('input', { class: 'input', type: 'number', min: '0', max: '10000', step: '100', placeholder: 'Global', style: { width: '120px' } });
  autoAdvance.value = s.autoAdvance ?? '';
  autoAdvance.addEventListener('change', () => set('autoAdvance', autoAdvance.value === '' ? null : Number(autoAdvance.value)));

  const save = async () => {
    try {
      const before = app.cache.decks.get(deck.id);
      if (before.settings.direction !== draft.settings.direction) {
        const ok = await confirmDialog({ title: 'Change study direction?', message: draft.settings.direction === 'forward' ? 'Reverse cards will stop appearing. Their history is kept and returns if you switch back.' : 'Reverse cards will be added as new study units with their own independent schedules. Existing forward history is unchanged.', confirmLabel: 'Change direction' });
        if (!ok) return;
      }
      await store.saveDeck({ ...before, name: draft.name.trim() || before.name, description: draft.description, group: draft.group.trim(), color: draft.color, settings: draft.settings });
      toast('Deck settings saved');
    } catch (err) {
      errorToast(err);
    }
  };

  return h('div', { class: 'stack loose' },
    h('section', { class: 'panel' }, h('h3', {}, 'Deck'),
      settingRow({ title: 'Name', control: nameInput }),
      settingRow({ title: 'Description', control: descInput }),
      settingRow({ title: 'Group', desc: 'Organise decks into groups on the Decks screen.', control: groupInput }),
      settingRow({ title: 'Colour', control: colorInput })),
    h('section', { class: 'panel' }, h('h3', {}, 'Study'),
      settingRow({ title: 'Study direction', desc: 'Both directions keep independent schedules for Front → Back and Back → Front.', control: segmented({ options: [{ value: 'forward', label: 'Front → Back' }, { value: 'reverse', label: 'Back → Front' }, { value: 'both', label: 'Both' }], value: s.direction, onchange: (v) => set('direction', v) }) }),
      settingRow({ title: 'New cards per day', control: num('newPerDay', { max: 9999 }) }),
      settingRow({ title: 'Maximum reviews per day', desc: 'Cards beyond the limit stay due (with their real due dates) for the next session.', control: num('reviewsPerDay', { max: 99999 }) }),
      settingRow({ title: 'New card order', control: segmented({ options: [{ value: 'mixed', label: 'Mixed' }, { value: 'after', label: 'After reviews' }, { value: 'before', label: 'Before reviews' }], value: s.newOrder, onchange: (v) => set('newOrder', v) }) }),
      settingRow({ title: 'Desired retention', desc: 'Leave empty to use the global setting.', control: [retention, h('span', { class: 'faint' }, '%')] }),
      settingRow({ title: 'Learning steps', desc: 'Short steps for new cards, e.g. “1m 10m”.', control: text('learningSteps', '1m 10m') }),
      settingRow({ title: 'Relearning steps', desc: 'After a lapse, e.g. “10m”.', control: text('relearningSteps', '10m') }),
      settingRow({ title: 'Related-card spacing', desc: 'Keep reverse directions, cloze siblings and linked cards apart.', control: segmented({ options: [{ value: 'spread', label: 'Spread out' }, { value: 'nextDay', label: 'Next day' }, { value: 'off', label: 'Off' }], value: s.siblingSpacing, onchange: (v) => set('siblingSpacing', v) }) }),
      settingRow({ title: 'Minimum gap between siblings', control: num('siblingGap', { max: 50 }) }),
      settingRow({ title: 'Auto-advance after a correct answer (ms)', desc: 'Leave empty to use the global setting; 0 = off.', control: autoAdvance })),
    h('section', { class: 'panel' }, h('h3', {}, 'Answers'),
      settingRow({ title: 'Default answer mode', control: select({ options: Object.entries(ANSWER_MODE_LABELS).map(([value, label]) => ({ value, label })), value: s.answerMode, onchange: (v) => set('answerMode', v) }) }),
      settingRow({ title: 'Default task type', desc: 'Calculation and multi-step cards are graded on correctness until enough comparable timing history exists.', control: select({ options: Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({ value, label })), value: s.taskType, onchange: (v) => set('taskType', v) }) }),
      settingRow({ title: 'Case-sensitive answers', control: switchControl({ checked: s.caseSensitive, onchange: (v) => set('caseSensitive', v) }) }),
      settingRow({ title: 'Typo tolerance', desc: 'Cautious: small slips in long ordinary words are accepted with a visible warning. Numbers, signs, formulas and known terms never are.', control: segmented({ options: [{ value: 'cautious', label: 'Cautious' }, { value: 'off', label: 'Off' }], value: s.typoTolerance, onchange: (v) => set('typoTolerance', v) }) }),
      settingRow({ title: 'Accents', control: segmented({ options: [{ value: 'typo', label: 'Warn' }, { value: 'strict', label: 'Strict' }, { value: 'ignore', label: 'Ignore' }], value: s.accentPolicy, onchange: (v) => set('accentPolicy', v) }) }),
      settingRow({ title: 'Mathematical equivalence', desc: 'Notation: √3 = sqrt(3), ½ = 1/2. Numeric: also 0.5 = 1/2. Algebraic: also checks expressions with variables at random points (probabilistic, labelled).', control: segmented({ options: [{ value: 'notation', label: 'Notation' }, { value: 'numeric', label: 'Numeric' }, { value: 'algebraic', label: 'Algebraic' }], value: s.mathEquivalence, onchange: (v) => set('mathEquivalence', v) }) })),
    h('section', { class: 'panel' }, h('h3', {}, 'Leeches'),
      settingRow({ title: 'Leech threshold (lapses)', desc: 'A card is a leech after this many lapses with high difficulty.', control: num('leechThreshold', { min: 2, max: 50 }) }),
      settingRow({ title: 'When a card becomes a leech', control: segmented({ options: [{ value: 'flag', label: 'Flag it' }, { value: 'suspend', label: 'Suspend it' }], value: s.leechAction, onchange: (v) => set('leechAction', v) }) })),
    h('div', { class: 'row end' }, button('Save settings', { kind: 'primary', onclick: save })));
}

export { createSession };
