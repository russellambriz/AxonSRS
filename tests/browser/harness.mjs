/**
 * Browser-test helpers (Playwright, Chromium).
 *
 * The app is served by tests/serve.mjs exactly as GitHub Pages serves it:
 * only under /AxonSRS/. Tests drive the real UI and, for setup and
 * inspection, import the app's own ES modules inside the page (the same
 * module URLs, so the same singletons the running app uses).
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
export const OUT = join(ROOT, 'test-results');
export const SHOTS = join(OUT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

export async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const c of candidates) {
    try {
      return await import(c.startsWith('/') ? pathToFileURL(c).href : c);
    } catch {
      /* try next */
    }
  }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return await import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
  } catch {
    throw new Error('Playwright was not found. Run `npm i -D playwright` (or set PLAYWRIGHT_MODULE to its index.mjs).');
  }
}

/** New isolated profile (own IndexedDB, caches, service workers). */
export async function newContext(browser, { sw = false, ...opts } = {}) {
  return browser.newContext({
    viewport: { width: 1280, height: 860 },
    serviceWorkers: sw ? 'allow' : 'block',
    bypassCSP: true,
    ...opts,
  });
}

/** Open the app and wait for the shell (or the fatal screen). */
export async function openApp(context, url, { hash = '', page = null } = {}) {
  const p = page || (await context.newPage());
  if (!p.__errors) {
    p.__errors = [];
    p.on('pageerror', (e) => p.__errors.push(`pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error') p.__errors.push(`console: ${m.text()}`);
    });
  }
  await p.goto(url + hash);
  await waitReady(p);
  return p;
}

export async function waitReady(page) {
  await page.waitForFunction(() => document.querySelector('#main .view, #main > *, #app .empty'), null, { timeout: 15000 });
}

/** Run `fn({ store, app, model, db })` inside the page with the app's own modules. */
export function inApp(page, fn, arg = null) {
  return page.evaluate(async ({ src, arg: a }) => {
    const base = location.href;
    const load = (p) => import(new URL(p, base).href);
    const mods = {
      store: (await load('./js/data/store.js')).store,
      AxonStore: (await load('./js/data/store.js')).AxonStore,
      app: (await load('./js/app.js')).app,
      model: await load('./js/core/model.js'),
      db: await load('./js/data/db.js'),
    };
    // eslint-disable-next-line no-new-func
    const f = new Function(`return (${src})`)();
    return f(mods, a);
  }, { src: fn.toString(), arg });
}

/** Create a deck with [front, back, extra?] cards through the store. */
export function seedDeck(page, { name = 'Test deck', cards, settings = {} }) {
  return inApp(page, async ({ store, app, model }, a) => {
    const deck = await store.createDeck({ name: a.name, settings: a.settings });
    const list = a.cards.map(([front, back, extra]) => model.createCard({ deckId: deck.id, front, back, ...(extra || {}) }, store.deviceId));
    await store.saveCards(list);
    await app.cache.load();
    return deck.id;
  }, { name, cards, settings });
}

/** All records of one object store, read with raw IndexedDB. */
export function idbAll(page, storeName, dbName = 'axon') {
  return page.evaluate(async ({ s, n }) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(n);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      if (!db.objectStoreNames.contains(s)) return [];
      return await new Promise((resolve, reject) => {
        const q = db.transaction(s).objectStore(s).getAll();
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
    } finally {
      db.close();
    }
  }, { s: storeName, n: dbName });
}

export const phase = (page) => page.getAttribute('.study', 'data-phase');

export async function waitPhase(page, phases, timeout = 10000) {
  await page.waitForFunction((list) => list.includes(document.querySelector('.study')?.dataset.phase), phases, { timeout });
  return phase(page);
}

export async function startReview(page) {
  await page.evaluate(() => { location.hash = '#/'; });
  const btn = page.getByRole('button', { name: 'Start review' });
  await btn.waitFor({ timeout: 10000 });
  await btn.click();
  return waitPhase(page, ['question', 'locked', 'done']);
}

export async function promptText(page) {
  return ((await page.textContent('#study-prompt')) || '').trim();
}

/** Type an answer like a person and press Enter. Returns the next phase. */
export async function answer(page, text, { delay = 25 } = {}) {
  const input = page.locator('.answer-input');
  await input.click();
  await input.fill('');
  await input.pressSequentially(text, { delay });
  await page.keyboard.press('Enter');
  return waitPhase(page, ['feedback', 'retype', 'error', 'done']);
}

/** Answer whatever card is showing using a prompt → answer map. */
export async function answerFromMap(page, map, fallback = 'zzz') {
  const prompt = await promptText(page);
  const key = Object.keys(map).find((k) => prompt.includes(k));
  return { prompt, phase: await answer(page, key ? map[key] : fallback) };
}

/** From feedback/retype, move to the next card. */
export async function advance(page) {
  if ((await phase(page)) === 'retype') {
    await page.keyboard.press('Alt+KeyB');
    await waitPhase(page, ['feedback']);
  }
  await page.keyboard.press('Enter');
  return waitPhase(page, ['question', 'done']);
}

export function assertNoErrors(page, allow = []) {
  const errs = (page.__errors || []).filter((e) => !allow.some((re) => re.test(e)));
  if (errs.length) throw new Error(`Page errors:\n${errs.join('\n')}`);
}

/** Fake GitHub Gist API (in memory), shared by any number of contexts. */
export function fakeGist({ token = 'test-token-not-real', truncateOver = 40000 } = {}) {
  const gists = new Map();
  const log = [];
  let counter = 0;
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const view = (id, files, history) => ({
    id,
    public: false,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => {
      const truncated = content.length > truncateOver;
      return [name, { filename: name, size: content.length, truncated, content: truncated ? content.slice(0, truncateOver) : content, raw_url: `https://gist.githubusercontent.com/tester/${id}/raw/${hex(40)}/${name}` }];
    })),
    history: history.map((h) => ({ version: h.version })),
  });
  const raw = new Map();
  const fulfillJson = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  async function api(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH' } });
    const auth = req.headers().authorization;
    log.push({ method, path: url.pathname, auth: !!auth });
    if (auth !== `Bearer ${token}`) return fulfillJson(route, 401, { message: 'Bad credentials' });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'user') return fulfillJson(route, 200, { login: 'tester' });
    if (parts[0] !== 'gists') return fulfillJson(route, 404, { message: 'Not Found' });
    if (method === 'POST' && parts.length === 1) {
      const body = JSON.parse(req.postData());
      const id = hex(32);
      const files = Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, f.content]));
      const g = { files, history: [{ version: hex(40), files: { ...files } }] };
      gists.set(id, g);
      return fulfillJson(route, 201, view(id, g.files, g.history));
    }
    const g = gists.get(parts[1]);
    if (!g) return fulfillJson(route, 404, { message: 'Not Found' });
    if (method === 'GET' && parts.length === 2) {
      const v = view(parts[1], g.files, g.history);
      for (const f of Object.values(v.files)) raw.set(f.raw_url, g.files[f.filename]);
      return fulfillJson(route, 200, v);
    }
    if (method === 'GET' && parts.length === 3) {
      const rev = g.history.find((h) => h.version === parts[2]);
      if (!rev) return fulfillJson(route, 404, { message: 'Not Found' });
      const v = view(parts[1], rev.files, g.history.slice(g.history.indexOf(rev)));
      for (const f of Object.values(v.files)) raw.set(f.raw_url, rev.files[f.filename]);
      return fulfillJson(route, 200, v);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(req.postData());
      for (const [n, f] of Object.entries(body.files)) {
        if (f === null) delete g.files[n];
        else g.files[n] = f.content;
      }
      counter++;
      g.history.unshift({ version: hex(40), files: { ...g.files } });
      return fulfillJson(route, 200, view(parts[1], g.files, g.history));
    }
    return fulfillJson(route, 405, { message: 'Method not allowed' });
  }
  async function rawHost(route) {
    const req = route.request();
    log.push({ method: req.method(), path: new URL(req.url()).pathname, auth: !!req.headers().authorization, raw: true });
    const body = raw.get(req.url());
    if (body == null) return route.fulfill({ status: 404, body: 'Not found', headers: { 'access-control-allow-origin': '*' } });
    return route.fulfill({ status: 200, contentType: 'text/plain', body, headers: { 'access-control-allow-origin': '*' } });
  }
  return {
    token,
    gists,
    log,
    get writes() {
      return counter;
    },
    async attach(context) {
      await context.route('https://api.github.com/**', api);
      await context.route('https://gist.githubusercontent.com/**', rawHost);
    },
    allContent() {
      return [...gists.values()].map((g) => Object.values(g.files).join('\n')).join('\n');
    },
  };
}

/** Simple timer for performance measurements. */
export async function timed(fn) {
  const t = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - t), value };
}
