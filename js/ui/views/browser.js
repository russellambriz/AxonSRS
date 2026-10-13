/**
 * Card browser: debounced search, filters, sorting, a virtualised list
 * and bulk actions (move, tag, task type, answer mode, suspend, reset,
 * link, export, delete with undo).
 */

import { h, replace } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { VirtualList, select, toast, confirmDialog, promptDialog, sheet, errorToast } from '../components.js';
import { cardStatusChips, plainFront, plainBack, deckOptions } from './common.js';
import { markdownToHtml, answerHtml, ensureMath } from '../render.js';
import { effectiveCardSettings } from '../../core/model.js';
import { clozeFilled } from '../../core/cloze.js';
import { cardSearchText, TASK_TYPE_LABELS, ANSWER_MODE_LABELS } from '../../core/model.js';
import { unitStatus } from '../../core/queue.js';
import { debounce } from '../../core/util.js';
import { exportAnkiFile } from '../exporters.js';
import { State } from '../../core/scheduler.js';

const STATUS_FILTERS = [
  { value: '', label: 'Any status' },
  { value: 'due', label: 'Due today' },
  { value: 'new', label: 'New' },
  { value: 'learning', label: 'Learning' },
  { value: 'review', label: 'In review' },
  { value: 'leech', label: 'Leeches' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'postponed', label: 'Postponed' },
  { value: 'buried', label: 'Buried / deferred' },
];

const SORTS = [
  { value: 'created', label: 'Newest first' },
  { value: 'updated', label: 'Recently edited' },
  { value: 'due', label: 'Due soonest' },
  { value: 'difficulty', label: 'Most difficult' },
  { value: 'lapses', label: 'Most lapses' },
  { value: 'alpha', label: 'A → Z' },
];

const haystack = new Map();
let haystackVersion = -1;

function textOf(card) {
  if (haystackVersion !== app.cache.version) {
    haystack.clear();
    haystackVersion = app.cache.version;
  }
  let t = haystack.get(card.id);
  if (t == null) {
    t = cardSearchText(card);
    haystack.set(card.id, t);
  }
  return t;
}

export function cardBrowser({ deckId = null, initialQuery = '' } = {}) {
  const state = { q: initialQuery, status: '', tag: '', taskType: '', mode: '', sort: 'created', selected: new Set(), anchor: null, list: [] };
  const root = h('div', { class: 'stack' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search front, back, hints, tags…', 'aria-label': 'Search cards', value: initialQuery, enterkeyhint: 'search' });
  const countEl = h('span', { class: 'faint small num' });
  const bulk = h('div', { class: 'bulk-bar', hidden: true });
  const filters = h('div', { class: 'row tight' });
  const vlist = new VirtualList({
    rowHeight: matchMedia('(max-width: 699px)').matches ? 64 : 60,
    renderRow: (card) => row(card),
  });

  function row(card) {
    const checked = state.selected.has(card.id);
    const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${plainFront(card).slice(0, 40)}` });
    cb.checked = checked;
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle(card.id, e.shiftKey);
    });
    const front = h('div', { class: 'front truncate' });
    const sub = h('span', { class: 'sub truncate' });
    const back = h('div', { class: 'back truncate' });
    // Rich inline rendering (math, chemistry) — only visible rows are built.
    const frontText = card.kind === 'cloze' ? clozeFilled(card.front[0] || '') : card.front[0] || card.occlusion?.title || 'Image occlusion';
    front.innerHTML = markdownToHtml(frontText.split('\n')[0].slice(0, 300), { inline: true });
    const mode = effectiveCardSettings(card, app.cache.decks.get(card.deckId)).answerMode;
    const backHtml = card.kind === 'occlusion' ? `${(card.occlusion?.masks || []).length} masks` : card.back.slice(0, 3).map((a) => answerHtml(a.split('\n')[0].slice(0, 200), mode)).join(' <span class="faint">|</span> ');
    back.innerHTML = backHtml;
    sub.innerHTML = backHtml;
    const r = h('div', { class: ['card-row', checked && 'selected'], role: 'row', tabindex: '0', 'aria-label': plainFront(card), onclick: () => app.navigate(`/card/${card.id}`), onkeydown: (e) => { if (e.key === 'Enter') app.navigate(`/card/${card.id}`); if (e.key === ' ') { e.preventDefault(); toggle(card.id, e.shiftKey); } } },
      h('div', {}, cb),
      h('div', { class: 'front-wrap' }, front, sub),
      back,
      h('div', { class: 'badges' }, card.kind !== 'basic' ? h('span', { class: 'chip' }, card.kind === 'cloze' ? 'Cloze' : 'Image') : null, cardStatusChips(card)));
    return r;
  }

  function toggle(id, range) {
    if (range && state.anchor) {
      const ids = state.list.map((c) => c.id);
      const a = ids.indexOf(state.anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selected.add(ids[i]);
    } else if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    state.anchor = id;
    vlist.refresh();
    renderBulk();
  }

  function matches(card) {
    if (deckId && card.deckId !== deckId) return false;
    if (state.tag && !card.tags.includes(state.tag)) return false;
    if (state.taskType && card.taskType !== state.taskType) return false;
    if (state.mode && (card.answerMode || app.cache.decks.get(card.deckId)?.settings?.answerMode || 'text') !== state.mode) return false;
    if (state.status) {
      const ctx = app.timeCtx();
      const units = app.cache.unitsOfCard(card.id).filter((u) => u.active);
      const statuses = units.map((u) => unitStatus(u, card, ctx));
      const s = state.status;
      if (s === 'suspended' && !card.suspended && !units.some((u) => u.suspended)) return false;
      if (s === 'leech' && !units.some((u) => u.leech)) return false;
      if (s === 'due' && !statuses.some((x) => x === 'due' || x === 'overdue' || x === 'learning-due')) return false;
      if (s === 'new' && !statuses.includes('new')) return false;
      if (s === 'learning' && !statuses.some((x) => x.startsWith('learning'))) return false;
      if (s === 'review' && !units.some((u) => u.state?.state === State.Review)) return false;
      if (s === 'postponed' && !statuses.includes('postponed')) return false;
      if (s === 'buried' && !statuses.some((x) => x === 'buried' || x === 'deferred')) return false;
    }
    if (state.q) {
      const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
      const t = textOf(card);
      for (const term of terms) {
        if (term.startsWith('tag:')) {
          if (!card.tags.some((x) => x.toLowerCase() === term.slice(4))) return false;
        } else if (!t.includes(term)) return false;
      }
    }
    return true;
  }

  function sortList(list) {
    const dueOf = (c) => Math.min(...app.cache.unitsOfCard(c.id).filter((u) => u.active).map((u) => u.state?.due ?? Infinity), Infinity);
    const unitAgg = (c, f) => Math.max(0, ...app.cache.unitsOfCard(c.id).map((u) => (u.state ? f(u.state) : 0)));
    const by = {
      created: (a, b) => b.createdAt - a.createdAt,
      updated: (a, b) => b.updatedAt - a.updatedAt,
      due: (a, b) => dueOf(a) - dueOf(b),
      difficulty: (a, b) => unitAgg(b, (s) => s.difficulty) - unitAgg(a, (s) => s.difficulty),
      lapses: (a, b) => unitAgg(b, (s) => s.lapses) - unitAgg(a, (s) => s.lapses),
      alpha: (a, b) => plainFront(a).localeCompare(plainFront(b)),
    }[state.sort];
    return list.sort(by);
  }

  function refresh() {
    const list = [];
    for (const c of app.cache.cards.values()) if (matches(c)) list.push(c);
    state.list = sortList(list);
    for (const id of [...state.selected]) if (!app.cache.cards.has(id)) state.selected.delete(id);
    countEl.textContent = `${state.list.length.toLocaleString()} card${state.list.length === 1 ? '' : 's'}`;
    vlist.setItems(state.list);
    renderBulk();
    renderFilters();
  }

  function renderFilters() {
    const tags = app.cache.allTags().filter(([t]) => !deckId || [...app.cache.cards.values()].some((c) => c.deckId === deckId && c.tags.includes(t)));
    replace(filters,
      select({ label: 'Status', options: STATUS_FILTERS, value: state.status, onchange: (v) => { state.status = v; refresh(); } }),
      select({ label: 'Tag', options: [{ value: '', label: 'Any tag' }, ...tags.slice(0, 300).map(([t, n]) => ({ value: t, label: `${t} (${n})` }))], value: state.tag, onchange: (v) => { state.tag = v; refresh(); } }),
      select({ label: 'Task type', options: [{ value: '', label: 'Any task type' }, ...Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({ value, label }))], value: state.taskType, onchange: (v) => { state.taskType = v; refresh(); } }),
      select({ label: 'Answer mode', options: [{ value: '', label: 'Any answer mode' }, ...Object.entries(ANSWER_MODE_LABELS).map(([value, label]) => ({ value, label }))], value: state.mode, onchange: (v) => { state.mode = v; refresh(); } }),
      select({ label: 'Sort', options: SORTS, value: state.sort, onchange: (v) => { state.sort = v; refresh(); } }),
      countEl);
    for (const s of filters.querySelectorAll('select')) s.style.width = 'auto';
  }

  function selectedCards() {
    return [...state.selected].map((id) => app.cache.cards.get(id)).filter(Boolean);
  }

  async function bulkUpdate(fn, message) {
    const cards = selectedCards();
    try {
      await store.saveCards(cards.map((c) => fn({ ...c })));
      toast(message(cards.length));
    } catch (err) {
      errorToast(err);
    }
  }

  function renderBulk() {
    const n = state.selected.size;
    bulk.hidden = n === 0;
    if (!n) return;
    replace(bulk,
      h('b', {}, `${n} selected`),
      h('button', { class: 'btn small', onclick: () => { for (const c of state.list) state.selected.add(c.id); vlist.refresh(); renderBulk(); } }, `Select all ${state.list.length}`),
      h('button', { class: 'btn small', onclick: async () => {
        const opts = deckOptions();
        const s = sheet({ title: 'Move to deck', content: (close) => h('div', { class: 'stack' }, opts.map((o) => h('button', { class: 'btn block', onclick: () => close(o.value) }, o.label))) });
        const target = await s.done;
        if (target) bulkUpdate((c) => ({ ...c, deckId: target }), (k) => `Moved ${k} card${k === 1 ? '' : 's'} (history kept)`);
      } }, icon('decks'), 'Move'),
      h('button', { class: 'btn small', onclick: async () => {
        const t = await promptDialog({ title: 'Add tags', label: 'Tags (space or comma separated)' });
        if (!t) return;
        const add = t.split(/[\s,]+/).filter(Boolean);
        bulkUpdate((c) => ({ ...c, tags: [...new Set([...c.tags, ...add])] }), (k) => `Tagged ${k} cards`);
      } }, icon('tag'), 'Tag'),
      h('button', { class: 'btn small', onclick: async () => {
        const t = await promptDialog({ title: 'Remove tags', label: 'Tags to remove' });
        if (!t) return;
        const rm = new Set(t.split(/[\s,]+/).filter(Boolean));
        bulkUpdate((c) => ({ ...c, tags: c.tags.filter((x) => !rm.has(x)) }), (k) => `Updated ${k} cards`);
      } }, 'Untag'),
      select({ label: 'Set task type', options: [{ value: '', label: 'Task type…' }, ...Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({ value, label }))], value: '', onchange: (v) => v && bulkUpdate((c) => ({ ...c, taskType: v }), (k) => `Set ${k} cards to ${TASK_TYPE_LABELS[v]}`) }),
      select({ label: 'Set answer mode', options: [{ value: '', label: 'Answer mode…' }, { value: 'deck', label: 'Deck default' }, ...Object.entries(ANSWER_MODE_LABELS).map(([value, label]) => ({ value, label }))], value: '', onchange: (v) => v && bulkUpdate((c) => ({ ...c, answerMode: v === 'deck' ? null : v }), (k) => `Updated ${k} cards`) }),
      h('button', { class: 'btn small', onclick: () => bulkUpdate((c) => ({ ...c, suspended: true }), (k) => `Suspended ${k} cards`) }, icon('pause'), 'Suspend'),
      h('button', { class: 'btn small', onclick: () => bulkUpdate((c) => ({ ...c, suspended: false }), (k) => `Unsuspended ${k} cards`) }, 'Unsuspend'),
      n === 2 ? h('button', { class: 'btn small', onclick: async () => { const [a, b] = [...state.selected]; await store.addLink(a, b); toast('Linked as related cards'); } }, icon('link'), 'Link') : null,
      h('button', { class: 'btn small', onclick: async () => {
        const cards = selectedCards();
        const ok = await confirmDialog({ title: 'Reset schedules?', message: `${cards.length} card(s) will start again as new. Their review history stays in the log (a reset event is recorded) and can still be analysed.`, confirmLabel: 'Reset', danger: true });
        if (!ok) return;
        const resets = new Map(cards.map((c) => [c.id, app.cache.unitsOfCard(c.id).map((u) => u.key)]));
        await store.saveCards(cards, { resets });
        toast(`Reset ${cards.length} card(s)`);
      } }, icon('refresh'), 'Reset'),
      h('button', { class: 'btn small', onclick: () => {
        const decks = [...new Set(selectedCards().map((c) => c.deckId))];
        exportAnkiFile(decks).catch(errorToast);
      } }, icon('download'), 'Export'),
      h('button', { class: 'btn small danger', onclick: async () => {
        const ids = [...state.selected];
        const ok = await confirmDialog({ title: `Delete ${ids.length} card${ids.length === 1 ? '' : 's'}?`, message: 'Review history is kept. You can undo right after.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        const trashId = await store.deleteCards(ids);
        state.selected.clear();
        toast(`Deleted ${ids.length} card${ids.length === 1 ? '' : 's'}`, { action: { label: 'Undo', run: () => store.restoreTrash(trashId) }, timeout: 10000 });
      } }, icon('trash'), 'Delete'),
      h('button', { class: 'btn small ghost', onclick: () => { state.selected.clear(); vlist.refresh(); renderBulk(); } }, 'Clear'));
    for (const s of bulk.querySelectorAll('select')) { s.style.width = 'auto'; s.style.minHeight = '30px'; s.style.fontSize = '0.82rem'; }
  }

  const onSearch = debounce(() => {
    state.q = search.value.trim();
    refresh();
  }, 150);
  search.addEventListener('input', onSearch);

  root.append(
    h('div', { class: 'browser-toolbar' }, h('div', { class: 'search' }, icon('search'), search)),
    filters,
    bulk,
    h('div', { class: 'panel flush' }, vlist.el),
  );
  refresh();
  ensureMath().then(() => vlist.refresh());
  const off = app.onChange(refresh);
  return {
    el: root,
    focus: () => search.focus(),
    destroy: () => {
      off();
      vlist.destroy();
      onSearch.cancel();
    },
  };
}
