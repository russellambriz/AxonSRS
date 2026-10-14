/*
 * Axon service worker.
 *
 * - CACHE_NAME is versioned; bump it (and APP_VERSION in js/config.js)
 *   on every release so installed apps pick up new files.
 * - install: pre-cache the complete app shell. cache.addAll is
 *   all-or-nothing, so a partial download never activates.
 * - The new worker waits until the page asks it to take over (the user
 *   accepts the update at a safe point). The old cache keeps serving the
 *   old version until then, so code and assets never mix versions.
 * - activate: delete only Axon's own old caches (names starting "axon-").
 *   IndexedDB is never touched.
 * - fetch: same-origin GETs are served cache-first from the current
 *   cache; navigations fall back to the cached index.html (hash routing,
 *   so every screen works offline). Cross-origin requests (GitHub API for
 *   sync) always go to the network and are never cached.
 * All paths are relative so the app works under /AxonSRS/ on GitHub Pages.
 */

const CACHE_NAME = 'axon-v2';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/core/aliases.js',
  './js/core/anki.js',
  './js/core/backup.js',
  './js/core/cloze.js',
  './js/core/fluency.js',
  './js/core/history.js',
  './js/core/import/csv.js',
  './js/core/import/html.js',
  './js/core/import/index.js',
  './js/core/import/notes.js',
  './js/core/import/slug.js',
  './js/core/levenshtein.js',
  './js/core/match/chem.js',
  './js/core/match/diff.js',
  './js/core/match/index.js',
  './js/core/match/math.js',
  './js/core/model.js',
  './js/core/planner.js',
  './js/core/queue.js',
  './js/core/research.js',
  './js/core/review.js',
  './js/core/scheduler.js',
  './js/core/stats.js',
  './js/core/sync/chunks.js',
  './js/core/sync/compress.js',
  './js/core/sync/crypto.js',
  './js/core/sync/envelope.js',
  './js/core/sync/gist.js',
  './js/core/sync/merge.js',
  './js/core/sync/versioning.js',
  './js/core/text.js',
  './js/core/time.js',
  './js/core/util.js',
  './js/data/db.js',
  './js/data/settings.js',
  './js/data/store.js',
  './js/data/sync.js',
  './js/main.js',
  './js/study/session.js',
  './js/study/trial.js',
  './js/ui/appearance.js',
  './js/ui/components.js',
  './js/ui/dom.js',
  './js/ui/exporters.js',
  './js/ui/icons.js',
  './js/ui/keyboard.js',
  './js/ui/local.js',
  './js/ui/occlusion.js',
  './js/ui/pwa.js',
  './js/ui/render.js',
  './js/ui/router.js',
  './js/ui/routes.js',
  './js/ui/shell.js',
  './js/ui/viewport.js',
  './js/ui/views/browser.js',
  './js/ui/views/cards.js',
  './js/ui/views/common.js',
  './js/ui/views/conflicts.js',
  './js/ui/views/deck.js',
  './js/ui/views/decks.js',
  './js/ui/views/editor.js',
  './js/ui/views/home.js',
  './js/ui/views/import.js',
  './js/ui/views/launcher.js',
  './js/ui/views/plans.js',
  './js/ui/views/recovery.js',
  './js/ui/views/sample.js',
  './js/ui/views/settings.js',
  './js/ui/views/shortcuts.js',
  './js/ui/views/stats.js',
  './js/ui/views/study.js',
  './vendor/dompurify/purify.es.mjs',
  './vendor/fflate/fflate.mjs',
  './vendor/katex/contrib/mhchem.mjs',
  './vendor/katex/fonts/KaTeX_AMS-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  './vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2',
  './vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Main-Bold.woff2',
  './vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2',
  './vendor/katex/fonts/KaTeX_Main-Italic.woff2',
  './vendor/katex/fonts/KaTeX_Main-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2',
  './vendor/katex/fonts/KaTeX_Math-Italic.woff2',
  './vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2',
  './vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2',
  './vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Script-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Size1-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Size2-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Size3-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Size4-Regular.woff2',
  './vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2',
  './vendor/katex/katex.min.css',
  './vendor/katex/katex.mjs',
  './vendor/marked/marked.esm.js',
  './vendor/opendyslexic/opendyslexic-latin-400-normal.woff2',
  './vendor/opendyslexic/opendyslexic-latin-700-normal.woff2',
  './vendor/ts-fsrs/index.mjs',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('axon-') && n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION' && event.ports[0]) event.ports[0].postMessage({ cache: CACHE_NAME });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match('./index.html', { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch {
        return new Response('<h1>Axon is offline</h1><p>Open Axon once while online to install it for offline use.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(req);
  })());
});
