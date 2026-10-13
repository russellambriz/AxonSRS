/** Sync conflict resolution — nothing is overwritten without a decision. */

import { h, replace, formatDate } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button } from './common.js';
import { toast, callout, errorToast } from '../components.js';
import { uuid } from '../../core/util.js';
import { planUndo } from '../../core/review.js';
import { RATING_LABELS } from '../../core/scheduler.js';

function valueText(v) {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.join(' | ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export async function view(outlet) {
  const { root, body } = page({ title: 'Sync conflicts', sub: 'These changes could not be merged automatically. Both versions are preserved until you choose.', crumbs: [{ label: 'Settings', href: '#/settings/sync' }] });
  outlet.append(root);
  async function render() {
    await app.cache.load();
    const conflicts = await store.listConflicts();
    if (!conflicts.length) {
      replace(body, h('div', { class: 'empty' }, h('div', { class: 'art' }, icon('check')), h('h2', {}, 'No conflicts'), h('p', {}, 'Everything merged cleanly.')));
      return;
    }
    replace(body, conflicts.map((c) => {
      if (c.kind === 'edit') {
        const fields = c.fields || [];
        return h('section', { class: 'panel stack' },
          h('h3', {}, `${c.recordType === 'cards' ? 'Card' : c.recordType.replace(/s$/, '')} edited on two devices`),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'This device'), h('th', {}, 'Other device'))), h('tbody', {}, fields.map((f) => h('tr', {}, h('td', {}, f), h('td', { class: 'small' }, valueText(c.local?.[f])), h('td', { class: 'small' }, valueText(c.remote?.[f]))))))),
          h('div', { class: 'row' }, button('Keep this device’s version', { onclick: () => resolve(c, 'local') }), button('Use the other device’s version', { kind: 'primary', onclick: () => resolve(c, 'remote') })));
      }
      if (c.kind === 'delete-edit') {
        return h('section', { class: 'panel stack' }, h('h3', {}, 'Deleted on one device, edited on another'), h('p', { class: 'muted small' }, valueText(c.local?.front)),
          h('div', { class: 'row' }, button('Keep it', { kind: 'primary', onclick: () => resolve(c, 'keep') }), button('Delete it', { kind: 'danger', onclick: () => resolve(c, 'delete') })));
      }
      if (c.kind === 'concurrent-review') {
        const card = app.cache.cards.get(c.cardId);
        return h('section', { class: 'panel stack' }, h('h3', {}, 'Reviewed on two devices before syncing'), h('p', { class: 'muted small' }, card ? card.front[0] : c.recordId),
          callout('info', 'Both reviews are kept and applied in time order with their real elapsed times (the later one counts as a quick re-review, not an independent delayed test). You can keep both or keep only one; this is reversible.'),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, c.events.map((e) => h('tr', {}, h('td', {}, formatDate(e.ts, { dateStyle: 'medium', timeStyle: 'short' })), h('td', {}, e.deviceId === store.deviceId ? 'this device' : 'other device'), h('td', {}, e.correct ? 'correct' : 'incorrect'), h('td', {}, RATING_LABELS[e.rating] || '')))))),
          h('div', { class: 'row' }, button('Keep both', { kind: 'primary', onclick: () => resolveConcurrent(c, 'both') }), button('Keep earliest only', { onclick: () => resolveConcurrent(c, 'earliest') }), button('Keep latest only', { onclick: () => resolveConcurrent(c, 'latest') })));
      }
      return null;
    }));
  }
  async function resolve(c, choice) {
    try {
      await store.resolveConflict(c.id, choice);
      toast('Resolved');
      render();
    } catch (err) {
      errorToast(err);
    }
  }
  async function resolveConcurrent(c, choice) {
    try {
      if (choice !== 'both') {
        const drop = choice === 'earliest' ? c.events.slice(1) : c.events.slice(0, -1);
        for (const d of drop) {
          const events = await store.eventsForUnit(c.recordId);
          const target = events.find((e) => e.id === d.id);
          const unit = await store.get('units', c.recordId);
          if (!target || !unit) continue;
          const plan = planUndo({ eventId: uuid(), now: Date.now(), deviceId: store.deviceId, seq: null, target, unit, unitEvents: events, studyDay: store.today(), reason: 'conflict-resolution' });
          await store.commitCorrection(plan, {});
        }
      }
      await store.tx(['conflicts'], 'readwrite', (t) => t.delete('conflicts', c.id));
      toast('Resolved');
      render();
    } catch (err) {
      errorToast(err);
    }
  }
  await render();
  return null;
}
