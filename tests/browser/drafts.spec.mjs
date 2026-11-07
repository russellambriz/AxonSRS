// Unfinished answers survive a real page reload, Pause and leave, and a
// Write → Type → Write switch (acceptance matrix 1–4, the four failures
// reproduced on the live site on 7 November 2026). Real Chromium, real
// IndexedDB, real reload.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, startReview, waitPhase, waitReady, promptText, idbAll, assertNoErrors } from './harness.mjs';

const SULFATE = [['Formula of the sulfate ion', 'SO4^2-', { answerMode: 'chem' }]];

const pressed = (page) => page.$$eval('.confidence-pick .chip', (bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent));
const strokes = (page) => page.$eval('.ink-canvas', (c) => Number(c.dataset.strokes));
const saved = (page) => page.waitForSelector('.draft-state[data-state="saved"]', { timeout: 5000 });

async function reloadToQuestion(page) {
  await page.reload();
  await waitReady(page);
  await page.waitForTimeout(300);
  if (!(await page.locator('.study').count())) await page.getByRole('button', { name: /Start review|Resume/ }).first().click();
  await waitPhase(page, ['question']);
}

const line = (page, { x = 40, y = 40, dx = 0, dy = 60, id = 7 } = {}) => page.evaluate(({ x: ox, y: oy, dx: ddx, dy: ddy, id: pid }) => {
  const c = document.querySelector('.ink-canvas');
  const r = c.getBoundingClientRect();
  const fire = (name, k) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: pid, clientX: r.left + ox + ddx * k, clientY: r.top + oy + ddy * k, pressure: name === 'pointerup' ? 0 : 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  fire('pointerdown', 0);
  for (let i = 1; i <= 12; i++) fire('pointermove', i / 12);
  fire('pointerup', 1);
}, { x, y, dx, dy, id });

export const tests = [
  {
    name: '1 (A): typed draft and confidence survive a reload, answer still hidden',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: SULFATE });
      await startReview(page);
      await page.locator('.answer-input').pressSequentially('SO4^', { delay: 20 });
      await page.getByRole('button', { name: 'Unsure' }).click();
      await saved(page);
      await reloadToQuestion(page);
      assert.equal(await promptText(page), 'Formula of the sulfate ion');
      assert.equal(await page.inputValue('.answer-input'), 'SO4^');
      assert.deepEqual(await pressed(page), ['Unsure']);
      assert.equal(await page.locator('.feedback').count(), 0);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: '2 (B): Pause and leave, then Resume: draft and confidence return',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: SULFATE });
      await startReview(page);
      await page.locator('.answer-input').pressSequentially('SO4^2', { delay: 20 });
      await page.getByRole('button', { name: 'Confident' }).click();
      await page.getByRole('button', { name: 'Pause and leave' }).click();
      await page.getByRole('button', { name: /Start review|Resume/ }).first().click();
      await waitPhase(page, ['question']);
      assert.equal(await page.inputValue('.answer-input'), 'SO4^2');
      assert.deepEqual(await pressed(page), ['Confident']);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: '3 (C): Write → Type → Write keeps the ink, the typed text and confidence',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: SULFATE });
      await startReview(page);
      await page.locator('.answer-input').pressSequentially('SO4^', { delay: 20 });
      await page.getByRole('button', { name: 'Unsure' }).click();
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor({ state: 'visible' });
      await line(page);
      await line(page, { x: 20, y: 70, dx: 80, dy: 0, id: 8 });
      assert.equal(await strokes(page), 2);
      await page.getByRole('button', { name: 'Type' }).click();
      assert.equal(await page.inputValue('.answer-input'), 'SO4^');
      await page.getByRole('button', { name: 'Write' }).click();
      assert.equal(await strokes(page), 2);
      assert.equal(await page.getByRole('button', { name: 'Undo stroke' }).isDisabled(), false);
      assert.equal(await page.getByRole('button', { name: 'Clear' }).isDisabled(), false);
      assert.deepEqual(await pressed(page), ['Unsure']);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: '4 (D): ink and confidence survive a reload in Write mode and stay editable',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: SULFATE });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Unsure' }).click();
      await line(page, { dx: 30, dy: 50 });
      await saved(page);
      await reloadToQuestion(page);
      await page.locator('.ink-canvas').waitFor({ state: 'visible' });
      assert.equal(await strokes(page), 1);
      assert.deepEqual(await pressed(page), ['Unsure']);
      await page.getByRole('button', { name: 'Undo stroke' }).click();
      assert.equal(await strokes(page), 0);
      const [session] = (await idbAll(page, 'sessions')).filter((s) => s.status === 'active');
      assert.ok(session?.draft, 'the draft is on the session record');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
