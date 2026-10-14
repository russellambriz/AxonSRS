/**
 * Service-worker registration and safe updates.
 *
 * A new version installs in the background (the worker pre-caches the
 * complete new app shell before it can activate). Axon then shows an
 * unobtrusive notice; the switch happens only when the user agrees and
 * nothing is in progress (unanswered card, feedback, correction, import,
 * pending write). The old cache keeps serving until then, so old code
 * and new assets never mix. IndexedDB is never touched by updates.
 */

import { app } from '../app.js';
import { showUpdateBanner } from './shell.js';

let reloading = false;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return null;
  // The first install takes control of an uncontrolled page (clients.claim):
  // nothing changed for it, so only an update to a new version reloads.
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  const promise = navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    if (!reg) return null;
    const offer = (worker) => {
      if (!worker || !navigator.serviceWorker.controller) return;
      const apply = () => worker.postMessage({ type: 'SKIP_WAITING' });
      app.pendingUpdate = {
        worker,
        apply,
        autoWhenIdle: false,
      };
      showUpdateBanner(({ whenIdle }) => {
        if (whenIdle) app.pendingUpdate.autoWhenIdle = true;
        else apply();
      });
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed') offer(w);
      });
    });
    const check = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
    };
    setInterval(check, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', check);
    return reg;
  }).catch((err) => {
    console.warn('Service worker registration failed', err);
    return null;
  });
  return promise;
}
