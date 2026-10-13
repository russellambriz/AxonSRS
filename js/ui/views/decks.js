/** Decks overview: grouped grid of deck cards with quick actions. */

import { h, replace, formatDate } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button } from './common.js';
import { menu, toast, promptDialog, confirmDialog, emptyState, errorToast } from '../components.js';
import { startDaily } from '../../study/session.js';
import { exportBackup, exportAnkiFile } from '../exporters.js';
import { State } from '../../core/scheduler.js';

export async function newDeckFlow() {
  const name = await promptDialog({ title: 'New deck', label: 'Deck name', placeholder: 'e.g. Organic chemistry', confirmLabel: 'Create deck' });
  if (!name || !name.trim()) return null;
  const deck = await store.createDeck({ name: name.trim() });
  await app.cache.load();
  return deck;
}

export function deckMenuItems(deck) {
  return [
    { label: 'Study now', icon: 'play', run: () => startDaily([deck.id]).catch(errorToast) },
    { label: 'Browse cards', icon: 'search', run: () => app.navigate(`/deck/${deck.id}`) },
    { label: 'Add card', icon: 'plus', run: () => app.navigate(`/card/new?deck=${deck.id}`) },
    { label: 'Import into deck', icon: 'upload', run: () => app.navigate(`/import?deck=${deck.id}`) },
    'separator',
    { label: 'Rename', icon: 'edit', run: async () => {
      const name = await promptDialog({ title: 'Rename deck', label: 'Deck name', value: deck.name });
      if (name && name.trim()) await store.saveDeck({ ...deck, name: name.trim() });
    } },
    { label: 'Move to group', icon: 'layers', run: async () => {
      const group = await promptDialog({ title: 'Deck group', label: 'Group (leave empty for none)', value: deck.group || '', placeholder: 'e.g. Medicine' });
      if (group != null) await store.saveDeck({ ...deck, group: group.trim() });
    } },
    { label: 'Duplicate', icon: 'copy', run: async () => {
      const copy = await store.duplicateDeck(deck.id);
      toast(`Created “${copy.name}” (cards copied without review history)`);
    } },
    { label: 'Deck settings', icon: 'settings', run: () => app.navigate(`/deck/${deck.id}?tab=settings`) },
    'separator',
    { label: 'Export as Axon backup', icon: 'download', run: () => exportBackup({ deckIds: [deck.id] }).then((r) => toast(`Exported ${r.counts.cards} cards`)).catch(errorToast) },
    { label: 'Export for Anki', icon: 'download', run: () => exportAnkiFile([deck.id]).then((r) => toast(`Exported ${r.count} notes${r.skipped.length ? `; ${r.skipped.length} image-occlusion cards skipped` : ''}`)).catch(errorToast) },
    'separator',
    { label: 'Delete deck', icon: 'trash', danger: true, run: async () => {
      const n = [...app.cache.cards.values()].filter((c) => c.deckId === deck.id).length;
      const ok = await confirmDialog({ title: `Delete “${deck.name}”?`, message: `${n} card${n === 1 ? '' : 's'} will be removed. Review history is kept, and you can undo right after.`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      const trashId = await store.deleteDeck(deck.id);
      if (location.hash.startsWith(`#/deck/${deck.id}`)) app.navigate('/decks');
      toast(`Deleted “${deck.name}”`, { action: { label: 'Undo', run: () => store.restoreTrash(trashId) }, timeout: 10000 });
    } },
  ];
}

export function deckCard(deck, { lastStudied = null } = {}) {
  const c = app.counts({ deckId: deck.id });
  const due = c.due + c.learning;
  let introduced = 0;
  for (const u of app.cache.units.values()) if (u.deckId === deck.id && u.active && u.state && u.state.state !== State.New) introduced++;
  const pct = c.total ? Math.round((introduced / c.total) * 100) : 0;
  const more = h('button', { class: 'btn ghost icon small deck-actions', 'aria-label': `Actions for ${deck.name}`, onclick: (e) => {
    e.preventDefault();
    e.stopPropagation();
    menu(e.currentTarget, deckMenuItems(deck));
  } }, icon('more'));
  return h('a', { class: 'deck-card', href: `#/deck/${encodeURIComponent(deck.id)}` },
    more,
    h('div', { class: 'deck-top' }, h('div', { class: 'deck-icon', style: { background: deck.color } }, deck.name.trim().charAt(0).toUpperCase() || 'A'), h('div', { class: 'grow', style: { minWidth: 0, paddingRight: '28px' } }, h('h3', { class: 'truncate' }, deck.name), h('div', { class: 'faint tiny truncate' }, deck.description || (lastStudied ? `Studied ${formatDate(lastStudied)}` : `${c.cards} cards`)))),
    h('div', { class: 'deck-meta' },
      h('span', { class: 'due' }, h('b', {}, String(due)), ' due'),
      h('span', {}, h('b', {}, String(c.newAvailable)), ' new'),
      h('span', {}, h('b', {}, String(c.cards)), ' cards'),
      c.leeches ? h('span', { class: 'chip danger' }, `${c.leeches} leech${c.leeches > 1 ? 'es' : ''}`) : null),
    h('div', { class: 'progress', title: `${pct}% of study units introduced`, role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Introduced' }, h('span', { style: { width: `${pct}%` } })));
}

export async function view(outlet) {
  const { root, body, header } = page({
    title: 'Decks',
    actions: [
      button('Import', { iconName: 'upload', href: '#/import' }),
      button('New deck', { kind: 'primary', iconName: 'plus', onclick: async () => {
        const d = await newDeckFlow();
        if (d) app.navigate(`/deck/${d.id}`);
      } }),
    ],
  });
  outlet.append(root);
  const render = () => {
    const decks = [...app.cache.decks.values()].filter((d) => !d.archived).sort((a, b) => a.name.localeCompare(b.name));
    header.querySelector('h1').textContent = `Decks${decks.length ? ` · ${decks.length}` : ''}`;
    if (!decks.length) {
      replace(body, emptyState({ iconName: 'decks', title: 'No decks yet', text: 'Create a deck, or import cards from notes, CSV, TSV, Anki exports or JSON.', actions: [button('Import cards', { iconName: 'upload', href: '#/import' }), button('New deck', { kind: 'primary', iconName: 'plus', onclick: async () => { const d = await newDeckFlow(); if (d) app.navigate(`/deck/${d.id}`); } })] }));
      return;
    }
    const groups = new Map();
    for (const d of decks) {
      const g = d.group || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(d);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    replace(body, keys.map((g) => h('section', { class: 'stack' }, g ? h('h2', {}, g) : null, h('div', { class: 'deck-grid' }, groups.get(g).map((d) => deckCard(d))))));
  };
  await app.cache.ensure();
  render();
  const off = app.onChange(render);
  return { destroy: off };
}
