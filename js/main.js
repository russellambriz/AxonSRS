/**
 * Axon bootstrap: open storage (never replacing a damaged database),
 * build the shell, start routing, register the service worker.
 */

import { app } from './app.js';
import { store, AxonStore } from './data/store.js';
import { buildShell } from './ui/shell.js';
import { Router } from './ui/router.js';
import { startViewport } from './ui/viewport.js';
import { registerServiceWorker } from './ui/pwa.js';
import { applyAppearance } from './ui/appearance.js';
import { routes, notFound } from './ui/routes.js';
import { renderFatal } from './ui/views/recovery.js';
import { toast, errorToast, sheet } from './ui/components.js';
import { h } from './ui/dom.js';
import { setAllowRemoteImages } from './ui/render.js';

/**
 * The bundled scheduler differs from the one that produced the stored
 * schedules. Nothing was recomputed; the user decides (Spec: never
 * silently change scheduling behaviour when migrating algorithms).
 */
function schedulerNotice(change) {
  toast('Axon’s scheduling engine was updated. Your existing schedules were not changed.', { timeout: 0, action: { label: 'Options', run: () => schedulerOptions(change) } });
}

async function schedulerOptions(change) {
  const choice = await sheet({
    title: 'Scheduling engine updated',
    content: h('div', { class: 'stack' },
      h('p', {}, `New reviews are scheduled with ${change.to}. Your existing schedules come from ${change.from} and have not been changed: past reviews keep the intervals they were given.`),
      h('p', { class: 'muted' }, 'You can instead rebuild every schedule by replaying your whole review history through the new engine, which may move due dates. A snapshot is taken first, so you can undo it (also later, from Settings → Data & backup → Local snapshots).')),
    footer: (close) => [
      h('button', { class: 'btn', onclick: () => close(null) }, 'Decide later'),
      h('button', { class: 'btn', onclick: () => close('keep') }, 'Keep current schedules'),
      h('button', { class: 'btn primary', onclick: () => close('rebuild') }, 'Rebuild schedules'),
    ],
  }).done;
  try {
    if (choice === 'keep') {
      await store.keepSchedules();
      toast('Your current schedules are kept');
    } else if (choice === 'rebuild') {
      const { count, snapshotId } = await store.rebuildForScheduler();
      await app.cache.load();
      toast(`Rebuilt ${count} schedule${count === 1 ? '' : 's'} with the new engine`, { timeout: 15000, action: { label: 'Undo', run: async () => {
        await store.restoreSnapshot(snapshotId);
        await store.checkScheduler();
        await app.cache.load();
        toast('Schedules restored as they were');
      } } });
    }
  } catch (err) {
    errorToast(err);
  }
}

async function boot() {
  const root = document.getElementById('app');
  registerServiceWorker();
  try {
    await store.init({
      onVersionChange: () => toast('Axon was updated in another tab. Reload this tab to continue.', { timeout: 0, action: { label: 'Reload', run: () => location.reload() } }),
    });
  } catch (err) {
    console.error(err);
    renderFatal(root, err);
    return;
  }
  applyAppearance(store.device);
  setAllowRemoteImages(!!store.device.allowRemoteImages);
  app.init();
  // Ask the browser to protect our storage from eviction (iOS/iPadOS
  // Safari in particular). Never blocks study; status shown in Settings.
  AxonStore.requestPersistence().then((r) => store.setDevice({ persistAsked: true, persistResult: r.result })).catch(() => {});
  await app.cache.load();
  const shell = buildShell(root);
  app.shell = shell;
  app.router = new Router({
    routes,
    outlet: shell.outlet,
    notFound,
    onChange: (route) => {
      shell.setActive(route.section);
      document.title = route.title ? `${route.title} · Axon` : 'Axon';
      document.body.classList.toggle('studying', route.section === 'session');
    },
  });
  app.router.setGuard(async () => {
    if (app.leaveGuard) return app.leaveGuard();
    return true;
  });
  const sc = app.shortcuts;
  sc.on('nav.home', () => app.navigate('/'));
  sc.on('nav.decks', () => app.navigate('/decks'));
  sc.on('nav.study', () => app.navigate('/study'));
  sc.on('nav.stats', () => app.navigate('/stats'));
  sc.on('nav.settings', () => app.navigate('/settings'));
  sc.on('app.import', () => app.navigate('/import'));
  sc.on('app.newCard', () => app.navigate('/card/new'));
  sc.on('app.search', () => {
    if (shell.search.offsetParent) shell.search.focus();
    else app.navigate('/cards');
  });
  sc.on('app.help', async () => {
    const { showShortcutSheet } = await import('./ui/views/shortcuts.js');
    showShortcutSheet();
  });
  app.router.start();
  shell.refreshCounts();
  startViewport();
  if (store.schedulerChange) schedulerNotice(store.schedulerChange);

  // Media refused on a sync pull are reported, not silently skipped.
  app.sync.on((st) => {
    if (st.state === 'ok' && st.result?.pulled?.newlyRejected?.length) toast(st.message, { timeout: 15000 });
  });
  await app.sync.loadCredentials();
  const autoSync = () => {
    if (app.sync.isConfigured() && store.device.sync?.autoSync && !app.sync.needsToken() && !app.sync.needsPassphrase()) app.sync.sync({ reason: 'auto' }).catch(() => {});
  };
  window.addEventListener('online', autoSync);
  setTimeout(autoSync, 1500);
}

boot();
