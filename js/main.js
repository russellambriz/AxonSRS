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
import { toast } from './ui/components.js';
import { setAllowRemoteImages } from './ui/render.js';

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

  await app.sync.loadCredentials();
  const autoSync = () => {
    if (app.sync.isConfigured() && store.device.sync?.autoSync && !app.sync.needsToken() && !app.sync.needsPassphrase()) app.sync.sync({ reason: 'auto' }).catch(() => {});
  };
  window.addEventListener('online', autoSync);
  setTimeout(autoSync, 1500);
}

boot();
