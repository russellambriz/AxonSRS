/**
 * Recovery: interrupted imports, reviews that failed to save, snapshots,
 * and the fatal screen shown when the database cannot be opened. The
 * database is never deleted or replaced silently.
 */

import { h, replace, formatDate, formatBytes, downloadBlob } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button } from './common.js';
import { toast, confirmDialog, callout, errorToast } from '../components.js';
import { local } from '../local.js';
import { listSnapshots, readSnapshot } from '../../data/db.js';

export async function view(outlet) {
  const { root, body } = page({ title: 'Recovery', crumbs: [{ label: 'Settings', href: '#/settings/data' }] });
  outlet.append(root);
  async function render() {
    const blocks = [];
    const pending = local.getJSON('axon-pending-review');
    if (pending) {
      blocks.push(h('section', { class: 'panel stack' }, h('h2', {}, 'Unsaved review'), h('p', { class: 'muted' }, `A review from ${formatDate(pending.savedAt, { dateStyle: 'medium', timeStyle: 'short' })} could not be saved. Retrying is safe: if it was saved after all, it will not be recorded twice.`),
        h('div', { class: 'row' }, button('Retry saving', { kind: 'primary', onclick: async () => {
          try {
            const r = await store.commitReview(pending.plan, { session: pending.session });
            local.remove('axon-pending-review');
            await app.cache.load();
            toast(r.duplicate ? 'It had already been saved' : 'Review saved');
            render();
          } catch (err) {
            errorToast(err);
          }
        } }), button('Discard', { onclick: async () => { if (await confirmDialog({ title: 'Discard this answer?', message: 'The review will not be recorded. The card stays due.', confirmLabel: 'Discard', danger: true })) { local.remove('axon-pending-review'); render(); } } }))));
    }
    const imports = await store.listImports();
    const interrupted = imports.filter((i) => i.status === 'in-progress');
    for (const imp of interrupted) {
      blocks.push(h('section', { class: 'panel stack' }, h('h2', {}, 'Interrupted import'), h('p', { class: 'muted' }, `Started ${formatDate(imp.startedAt, { dateStyle: 'medium', timeStyle: 'short' })}${imp.fileName ? ` from ${imp.fileName}` : ''}. Imports are saved in one transaction, so no partial cards were created.`),
        h('div', { class: 'row' },
          imp.source ? button('Download the source text', { iconName: 'download', onclick: () => downloadBlob(new Blob([imp.source], { type: 'text/plain;charset=utf-8' }), imp.fileName || 'axon-import.txt') }) : null,
          imp.source ? button('Import it again', { kind: 'primary', onclick: async () => { app.navigate('/import'); } }) : null,
          button('Dismiss', { onclick: async () => { await store.discardImport(imp.id); render(); } }))));
    }
    if (store.upgradeInfo) {
      blocks.push(callout('info', `The database was upgraded from version ${store.upgradeInfo.from} to ${store.upgradeInfo.to}. A snapshot of the earlier data was saved first.`));
    }
    const snaps = await store.listSnapshots();
    blocks.push(h('section', { class: 'panel stack' }, h('h2', {}, 'Snapshots'), snaps.length ? h('div', { class: 'list' }, snaps.map((s) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', {}, s.reason), h('div', { class: 'faint tiny' }, `${formatDate(s.createdAt, { dateStyle: 'medium', timeStyle: 'short' })} · ${formatBytes(s.size)}`)),
      button('Download', { small: true, onclick: async () => { const full = await readSnapshot(s.id); downloadBlob(new Blob([JSON.stringify(full)], { type: 'application/json' }), `${s.id}.json`); } }),
      button('Restore', { small: true, onclick: async () => { if (await confirmDialog({ title: 'Restore snapshot?', message: 'Current data is snapshotted first, then replaced.', confirmLabel: 'Restore', danger: true })) { await store.restoreSnapshot(s.id); await app.cache.load(); toast('Restored'); render(); } } })))) : h('p', { class: 'faint' }, 'No snapshots.')));
    if (!pending && !interrupted.length) blocks.unshift(callout('success', 'Nothing needs recovering.'));
    replace(body, blocks);
  }
  await render();
  return null;
}

/** Shown when the database cannot be opened at all. */
export function renderFatal(root, err) {
  const code = err?.code || 'unknown';
  const messages = {
    version: 'Your data was saved by a newer version of Axon. Reload to get the latest version — nothing has been changed.',
    migration: 'Updating the database failed. Your data was left exactly as it was, and a snapshot was taken before the attempt.',
    unsupported: 'This browser does not provide the storage Axon needs (IndexedDB). Private browsing modes sometimes disable it.',
    quota: 'The device is out of storage space. Free some space and reload.',
  };
  root.replaceChildren(h('div', { class: 'view narrow' },
    h('div', { class: 'empty' }, h('div', { class: 'art' }, icon('alert')), h('h2', {}, 'Axon could not open your data'), h('p', {}, messages[code] || err?.message || 'An unexpected storage error occurred.'),
      h('p', { class: 'faint small' }, 'Axon never deletes or replaces your database automatically.'),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload'),
        h('button', { class: 'btn', onclick: async () => {
          try {
            const snaps = await listSnapshots();
            if (!snaps.length) return alert('No snapshots are available.');
            const full = await readSnapshot(snaps[0].id);
            downloadBlob(new Blob([JSON.stringify(full)], { type: 'application/json' }), `${snaps[0].id}.json`);
          } catch (e) {
            alert(`Could not read snapshots: ${e.message}`);
          }
        } }, 'Download latest snapshot')),
      h('details', { class: 'disclosure', style: { textAlign: 'left', width: '100%' } }, h('summary', {}, 'Technical details'), h('pre', { class: 'mono small', style: { whiteSpace: 'pre-wrap' } }, `${err?.name || ''} ${code}\n${err?.message || ''}\n${err?.cause?.message || ''}`)))));
}
