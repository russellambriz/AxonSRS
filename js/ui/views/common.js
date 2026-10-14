/** Shared view building blocks. */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { unitStatus } from '../../core/queue.js';
import { formatInterval } from '../../core/util.js';
import { cardSummary } from '../../core/model.js';

export function page({ title, sub = null, crumbs = null, actions = [], className = '' }) {
  const header = h('header', { class: 'view-header' },
    h('div', { class: 'grow' },
      crumbs ? h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, crumbs.flatMap((c, i) => [i ? h('span', { 'aria-hidden': 'true' }, '/') : null, c.href ? h('a', { href: c.href }, c.label) : h('span', {}, c.label)])) : null,
      h('h1', {}, title),
      sub ? h('p', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null);
  const body = h('div', { class: 'stack loose' });
  const root = h('div', { class: ['view', className] }, header, body);
  return { root, header, body };
}

export function iconButton(name, label, onclick, extra = {}) {
  return h('button', { class: ['btn ghost icon', extra.class], 'aria-label': label, title: label, onclick, type: 'button' }, icon(name));
}

export function button(label, { onclick, kind = '', iconName = null, href = null, small = false, disabled = false, title = null } = {}) {
  const cls = ['btn', kind, small && 'small'];
  if (href) return h('a', { class: cls, href, title: title || undefined }, iconName ? icon(iconName) : null, label);
  return h('button', { class: cls, type: 'button', onclick, disabled, title: title || undefined }, iconName ? icon(iconName) : null, label);
}

const STATUS_LABEL = {
  new: ['New', 'accent'],
  'learning-due': ['Learning', 'warning'],
  'learning-later': ['Learning', 'warning'],
  due: ['Due', 'accent'],
  overdue: ['Overdue', 'danger'],
  suspended: ['Suspended', ''],
  postponed: ['Postponed', ''],
  buried: ['Buried', ''],
  deferred: ['Deferred', ''],
  inactive: ['Inactive', ''],
};

export function unitChip(unit, card) {
  const ctx = app.timeCtx();
  const st = unitStatus(unit, card, ctx);
  if (st === 'scheduled') {
    const days = (unit.state.due - ctx.now) / 86400000;
    return h('span', { class: 'chip', title: new Date(unit.state.due).toLocaleString() }, `in ${formatInterval(days)}`);
  }
  const [label, kind] = STATUS_LABEL[st] || [st, ''];
  return h('span', { class: ['chip', kind] }, label);
}

export function cardStatusChips(card) {
  const units = app.cache.unitsOfCard(card.id).filter((u) => u.active);
  const chips = [];
  if (card.suspended) chips.push(h('span', { class: 'chip' }, 'Suspended'));
  else if (units.length) chips.push(unitChip(units.slice().sort((a, b) => (a.state?.due ?? 0) - (b.state?.due ?? 0))[0], card));
  if (units.some((u) => u.leech)) chips.push(h('span', { class: 'chip danger' }, 'Leech'));
  return chips;
}

export function plainFront(card) {
  return cardSummary(card).front || '(empty)';
}

export function plainBack(card) {
  return cardSummary(card).back;
}

export function deckOptions({ includeAll = false } = {}) {
  const decks = [...app.cache.decks.values()].sort((a, b) => a.name.localeCompare(b.name));
  const opts = decks.map((d) => ({ value: d.id, label: d.group ? `${d.group} / ${d.name}` : d.name }));
  return includeAll ? [{ value: '', label: 'All decks' }, ...opts] : opts;
}

/** Multi-select checklist (decks or tags). */
export function checklist({ items, selected = [], onchange, emptyText = 'Nothing to choose from yet.' }) {
  const set = new Set(selected);
  if (!items.length) return h('p', { class: 'faint small' }, emptyText);
  return h('div', { class: 'row tight', style: { gap: '6px' } }, items.map((it) => {
    const btn = h('button', { type: 'button', class: 'chip button', 'aria-pressed': String(set.has(it.value)), onclick: () => {
      if (set.has(it.value)) set.delete(it.value);
      else set.add(it.value);
      btn.setAttribute('aria-pressed', String(set.has(it.value)));
      btn.classList.toggle('accent', set.has(it.value));
      onchange([...set]);
    } }, it.color ? h('span', { class: 'deck-dot', style: { background: it.color } }) : null, it.label);
    if (set.has(it.value)) btn.classList.add('accent');
    return btn;
  }));
}

export function kpi(label, value, note = '') {
  return h('div', { class: 'panel stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), note ? h('div', { class: 'note' }, note) : null);
}

/** Subscribe to cache changes for the lifetime of a view. */
export function liveView(render) {
  const off = app.onChange(render);
  return { destroy: () => off() };
}

/** One-click fixes offered wherever a leech is shown (stats, card browser). */
export function leechActions(card, { toast } = {}) {
  return [
    { label: 'Edit the prompt', icon: 'edit', run: () => app.navigate(`/card/${card.id}`) },
    { label: 'Add a hint', icon: 'hint', run: () => app.navigate(`/card/${card.id}?focus=hint`) },
    { label: 'Suspend', icon: 'pause', run: async () => { await store.saveCard({ ...card, suspended: true }); toast?.('Suspended'); } },
    { label: 'Create related practice card', icon: 'link', run: () => app.navigate(`/card/new?deck=${card.deckId}&relatedTo=${card.id}`) },
  ];
}
