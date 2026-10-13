// Spec 12.5–12.7, 17.5–17.7: offline cold start after the service worker
// installs, and an app update arriving during an active review.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, newContext, openApp, seedDeck, idbAll, startReview, answer, waitPhase, waitReady, assertNoErrors } from './harness.mjs';
import { precacheFromSw } from '../../tools/update-precache.mjs';

const CARDS = [['Capital of France?', 'Paris'], ['Capital of Italy?', 'Rome'], ['Capital of Spain?', 'Madrid'], ['Integrate 2x', 'x^2 + C', { answerMode: 'math' }]];
const MAP = { France: 'Paris', Italy: 'Rome', Spain: 'Madrid', Integrate: 'x^2 + C' };

async function waitControlled(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
}

const cacheNames = (page) => page.evaluate(() => caches.keys());

export const tests = [
  {
    name: 'after one online visit the whole app cold-starts and studies offline',
    async run({ browser, url, srv }) {
      const ctx = await newContext(browser, { sw: true });
      const page = await openApp(ctx, url);
      await waitControlled(page);
      // The first install must not reload the page.
      assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1);
      const expected = precacheFromSw(readFileSync(join(ROOT, 'sw.js'), 'utf8'));
      const cached = await page.evaluate(async () => (await (await caches.open((await caches.keys())[0])).keys()).length);
      assert.equal(cached, expected.length, 'every shipped file is in the cache');
      await seedDeck(page, { name: 'Offline deck', cards: CARDS });
      await page.close();
      // Go fully offline: browser offline AND the server stopped.
      await ctx.setOffline(true);
      await srv.close();
      const p2 = await openApp(ctx, url);
      await p2.getByText('Offline deck').first().waitFor();
      for (const hash of ['#/stats', '#/settings/data', '#/decks', '#/cards', '#/import', '#/plans']) {
        await p2.evaluate((h) => { location.hash = h; }, hash);
        await p2.waitForFunction((h) => location.hash === h && document.querySelector('#main .view'), hash);
      }
      // Study offline, including a maths card (KaTeX, lazy-loaded) and its fonts.
      assert.equal(await startReview(p2), 'question');
      for (let i = 0; i < 4; i++) {
        const prompt = (await p2.textContent('#study-prompt')) || '';
        const key = Object.keys(MAP).find((k) => prompt.includes(k));
        assert.equal(await answer(p2, MAP[key]), 'feedback', `offline answer for ${key}`);
        await p2.keyboard.press('Enter');
        await waitPhase(p2, ['question', 'done']);
      }
      assert.equal((await idbAll(p2, 'events')).filter((e) => e.type === 'review').length, 4);
      const fontsOk = await p2.evaluate(() => [...document.fonts].filter((f) => f.family.includes('KaTeX') && f.status === 'error').length === 0);
      assert.ok(fontsOk, 'no KaTeX font failed to load offline');
      // A cold navigation to a deep link works too.
      const p3 = await ctx.newPage();
      await p3.goto(`${url}#/stats`);
      await waitReady(p3);
      assert.ok(await p3.locator('#main .view').count());
      assertNoErrors(p2, [/Failed to load resource/]);
      await ctx.close();
    },
  },
  {
    name: 'an update found mid-review waits for a safe point, keeps the answer, then switches cleanly',
    async run({ browser, url, srv }) {
      const ctx = await newContext(browser, { sw: true });
      const page = await openApp(ctx, url);
      await waitControlled(page);
      await seedDeck(page, { name: 'Capitals', cards: CARDS.slice(0, 3) });
      assert.equal(await startReview(page), 'question');
      await page.locator('.answer-input').pressSequentially('Pa', { delay: 20 });
      // Release a new version (new cache name) and let the app find it.
      const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
      srv.overrides.set('sw.js', sw.replace(/const CACHE_NAME = 'axon-v\d+';/, "const CACHE_NAME = 'axon-v9999';"));
      await page.evaluate(() => { window.__sameDocument = true; });
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      await page.locator('.update-banner').waitFor({ timeout: 20000 });
      assert.deepEqual((await cacheNames(page)).sort(), ['axon-v1', 'axon-v9999'].sort(), 'new version fully cached; old one still serving');
      await page.locator('.update-banner').getByRole('button', { name: 'Update' }).click();
      await page.getByText('Will update after you finish: the current card.').waitFor();
      assert.equal(await page.inputValue('.answer-input'), 'Pa', 'typed text kept');
      assert.equal(await page.evaluate(() => window.__sameDocument), true, 'no reload while a card is open');
      const prompt = (await page.textContent('#study-prompt')) || '';
      const key = Object.keys(MAP).find((k) => prompt.includes(k));
      await page.locator('.answer-input').fill(MAP[key]);
      await page.keyboard.press('Enter');
      assert.equal(await waitPhase(page, ['feedback']), 'feedback');
      assert.equal(await page.evaluate(() => window.__sameDocument), true, 'no reload while feedback is shown');
      const nav = page.waitForEvent('load', { timeout: 20000 });
      await page.keyboard.press('Enter'); // safe point: saved, next card not shown
      await nav;
      await waitReady(page);
      assert.equal(await page.evaluate(() => window.__sameDocument), undefined, 'reloaded into the new version');
      assert.deepEqual(await cacheNames(page), ['axon-v9999'], 'old cache removed after the switch');
      const reviews = (await idbAll(page, 'events')).filter((e) => e.type === 'review');
      assert.equal(reviews.length, 1, 'the answered card was saved exactly once');
      const [session] = await idbAll(page, 'sessions');
      assert.equal(session.index, 1);
      // The reload lands back in the same session, on the next card.
      assert.match(await page.evaluate(() => location.hash), /#\/study\/session\//);
      assert.equal(await waitPhase(page, ['question']), 'question');
      const nextPrompt = (await page.textContent('#study-prompt')) || '';
      assert.equal(nextPrompt.includes(key), false, 'continues with a different card');
      assert.ok((await idbAll(page, 'cards')).length === 3, 'IndexedDB untouched by the update');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
