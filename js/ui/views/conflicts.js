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

/** Implausible-timestamp entries (history.js clockConflicts). */
const CLOCK_ISSUES = {
  'future-timestamp': ['Dated in the future', 'They carry times later than this device’s clock, so the recording device’s clock was probably ahead. A review dated in the future can push its card’s next due date too far out.'],
  'before-parent': ['Dated before the review they followed', 'Each was based on a review that carries a later time, so one device’s clock was behind. They are replayed after that review.'],
  'device-clock-went-backwards': ['Device clock went backwards', 'They are dated earlier than events the same device recorded before them.'],
  'in-session-clock-jump': ['Clock changed during an answer', 'The device clock jumped while these answers were being typed; their timing was already left out of grading.'],
};

function valueText(v) {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.join(' | ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export async function view(outlet) {
  const { root, body } = page({ title: 'Sync conflicts', sub: 'Changes that could not be merged automatically, and received events with implausible timestamps. Nothing is overwritten or dropped until you choose.', crumbs: [{ label: 'Settings', href: '#/settings/sync' }] });
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
      if (c.kind === 'clock') {
        const [title, text] = CLOCK_ISSUES[c.issue] || ['Implausible timestamps', ''];
        const reviews = c.events.filter((e) => e.type === 'review');
        const n = c.events.length;
        return h('section', { class: 'panel stack' }, h('h3', {}, title),
          h('p', { class: 'muted small' }, `${n} event${n === 1 ? '' : 's'} from ${c.deviceId === store.deviceId ? 'this device' : 'another device'}. ${text}`),
          callout('info', 'They are kept in your history and counted in time order; a review is never replayed before the review it was based on. Keep them as they are, or stop counting the suspicious reviews in scheduling (their records stay in the history).'),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, c.events.slice(0, 10).map((e) => {
            const card = app.cache.cards.get(e.cardId);
            return h('tr', {}, h('td', {}, formatDate(e.ts, { dateStyle: 'medium', timeStyle: 'short' })), h('td', { class: 'small' }, card ? valueText(card.front[0]) : '—'), h('td', {}, e.type), h('td', {}, RATING_LABELS[e.rating] || ''));
          })))),
          n > 10 ? h('p', { class: 'faint small' }, `and ${n - 10} more`) : null,
          h('div', { class: 'row' }, button('Keep them', { kind: 'primary', onclick: () => resolveClock(c, false) }),
            reviews.length ? button(`Don’t count ${reviews.length === 1 ? 'this review' : `these ${reviews.length} reviews`}`, { onclick: () => resolveClock(c, true) }) : null));
      }
      return null;
    }));
  }
  async function resolveClock(c, discount) {
    try {
      if (discount) {
        for (const d of c.events.filter((e) => e.type === 'review')) {
          const events = await store.eventsForUnit(d.unitId);
          const target = events.find((e) => e.id === d.id);
          const unit = await store.get('units', d.unitId);
          if (!target || !unit) continue;
          const plan = planUndo({ eventId: uuid(), now: Date.now(), deviceId: store.deviceId, seq: null, target, unit, unitEvents: events, studyDay: store.today(), reason: 'clock-issue' });
          await store.commitCorrection(plan, {});
        }
      }
      await store.tx(['conflicts'], 'readwrite', (t) => t.delete('conflicts', c.id));
      toast(discount ? 'Those reviews no longer count in scheduling' : 'Kept');
      render();
    } catch (err) {
      errorToast(err);
    }
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
