// Spec 12.9, 12.12–12.14, 17.8–17.10, 17.13–17.15: keyboard safety in the
// answer field, IME composition, held Enter, the symbol toolbar and
// calibration exclusion, one study tab at a time, image occlusion offline.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, SHOTS, newContext, openApp, seedDeck, idbAll, inApp, startReview, answer, waitPhase, phase, waitReady, assertNoErrors, promptText } from './harness.mjs';

const CARDS = [['Capital of France?', 'Paris', { hint: 'Starts with P' }], ['Capital of Italy?', 'Rome', { hint: 'Starts with R' }], ['Capital of Spain?', 'Madrid', { hint: 'Starts with M' }]];
const MAP = { France: 'Paris', Italy: 'Rome', Spain: 'Madrid' };
async function expectedAnswer(page) {
  const p = await promptText(page);
  return MAP[Object.keys(MAP).find((k) => p.includes(k))];
}

export const tests = [
  {
    name: 'letters that are shortcuts (E, H, R, S, U, B, P) are plain text inside the answer field',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: CARDS });
      await startReview(page);
      const input = page.locator('.answer-input');
      await input.click();
      await input.pressSequentially('EHRSUBP ehrsubp', { delay: 15 });
      assert.equal(await input.inputValue(), 'EHRSUBP ehrsubp');
      assert.equal(await phase(page), 'question', 'nothing was skipped, revealed or paused');
      assert.equal(await page.locator('.hint-box').isHidden(), true, 'hint not shown');
      assert.equal(await page.locator('dialog[open]').count(), 0, 'editor not opened');
      // Outside the field the same keys are shortcuts.
      await page.keyboard.press('Escape');
      await page.keyboard.press('h');
      await page.locator('.hint-box').waitFor({ state: 'visible' });
      assert.match(await page.textContent('.hint-box'), /Starts with/);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'Enter that confirms an IME composition never submits',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: CARDS });
      await startReview(page);
      const input = page.locator('.answer-input');
      await input.click();
      // Real composition through the Chrome DevTools Protocol.
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: 'ぱり', selectionStart: 2, selectionEnd: 2 });
      // Enter pressed while the IME is composing (keyCode 229, isComposing).
      await page.evaluate(() => {
        const el = document.querySelector('.answer-input');
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      });
      await cdp.send('Input.insertText', { text: 'ぱり' });
      await page.waitForTimeout(150);
      assert.equal(await phase(page), 'question', 'composition Enter did not submit');
      assert.equal(await input.inputValue(), 'ぱり');
      // A later, ordinary Enter submits.
      await input.fill('');
      await input.pressSequentially(await expectedAnswer(page), { delay: 15 });
      await page.keyboard.press('Enter');
      assert.equal(await waitPhase(page, ['feedback']), 'feedback');
      const [ev] = (await idbAll(page, 'events')).filter((e) => e.type === 'review');
      assert.ok(ev.grading.measurements.raw.origins.composition >= 1, 'composition recorded as an input origin');
      await ctx.close();
    },
  },
  {
    name: 'holding Enter submits once and never skips past the feedback',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: CARDS });
      await startReview(page);
      const first = await promptText(page);
      const input = page.locator('.answer-input');
      await input.click();
      await input.pressSequentially(await expectedAnswer(page), { delay: 15 });
      await page.keyboard.down('Enter');
      assert.equal(await waitPhase(page, ['feedback']), 'feedback');
      for (let i = 0; i < 8; i++) await page.keyboard.down('Enter'); // auto-repeat
      await page.waitForTimeout(200);
      assert.equal(await phase(page), 'feedback', 'auto-repeat did not advance');
      await page.keyboard.up('Enter');
      await page.keyboard.press('Enter');
      assert.equal(await waitPhase(page, ['question']), 'question');
      assert.notEqual(await promptText(page), first);
      assert.equal((await idbAll(page, 'events')).filter((e) => e.type === 'review').length, 1);
      await ctx.close();
    },
  },
  {
    name: 'toolbar symbols insert at the caret; toolbar-heavy answers are excluded from typing-speed calibration',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { name: 'Chem', settings: { answerMode: 'chem' }, cards: [['Hydrogen peroxide formula', 'H2O2', { answerMode: 'chem' }]] });
      await startReview(page);
      const input = page.locator('.answer-input');
      await input.click();
      await input.pressSequentially('HO', { delay: 20 });
      await page.keyboard.press('ArrowLeft');
      await page.getByRole('button', { name: 'Insert ₂' }).click();
      assert.equal(await input.inputValue(), 'H₂O', 'inserted at the caret, not the end');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('answer-input')), true, 'focus stays in the field');
      await page.keyboard.press('End');
      await page.getByRole('button', { name: 'Insert ₂' }).click();
      assert.equal(await input.inputValue(), 'H₂O₂');
      await page.keyboard.press('Enter');
      assert.equal(await waitPhase(page, ['feedback', 'retype']), 'feedback');
      const [ev] = (await idbAll(page, 'events')).filter((e) => e.type === 'review');
      assert.equal(ev.response.correct, true);
      assert.ok(ev.grading.measurements.raw.origins.toolbar >= 1);
      assert.match(JSON.stringify(ev.grading), /TOOLBAR_HEAVY/, 'typing metric excluded and the reason recorded');
      const samples = (await idbAll(page, 'calibration')).flatMap((b) => b.samples || []);
      const mine = samples.find((s) => s.eventId === ev.id);
      assert.ok(!mine || mine.lnMsPerEffort === null, 'no typing-speed sample from toolbar input');
      await ctx.close();
    },
  },
  {
    name: 'only one tab studies at a time; taking over stops the other tab; stale writes are refused',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const a = await openApp(ctx, url);
      await seedDeck(a, { cards: CARDS });
      await startReview(a);
      const sessionHash = await a.evaluate(() => location.hash);
      const b = await openApp(ctx, url, { hash: sessionHash });
      await b.getByText('Studying in another tab').waitFor();
      assert.equal(await phase(b), 'locked');
      const c = await openApp(ctx, url); // a third tab watching data changes
      // A answers; B and C learn about it through BroadcastChannel.
      assert.equal(await answer(a, await expectedAnswer(a)), 'feedback');
      const [ev] = (await idbAll(a, 'events')).filter((e) => e.type === 'review');
      await c.waitForFunction(async (uid) => {
        const { app } = await import(new URL('./js/app.js', location.href).href);
        return app.cache.units.get(uid)?.headEventId != null;
      }, ev.unitId);
      // B takes over; A is told and stops.
      await b.getByRole('button', { name: 'Study here instead' }).click();
      assert.equal(await waitPhase(b, ['question']), 'question');
      await a.getByText('Studying moved to another tab').waitFor();
      assert.equal(await phase(a), 'locked');
      assert.equal(await b.locator('.answer-input').isVisible(), true);
      // B continues after A's saved progress (A's answered card is not repeated first).
      assert.equal((await promptText(b)).includes(Object.keys(MAP).find((k) => MAP[k] === ev.response.text)), false);
      // A write based on an outdated schedule head is refused, never applied twice.
      const res = await inApp(b, async ({ store }, e) => {
        try {
          await store.commitReview({ event: { ...e, id: `${e.id}-dup` }, unit: { id: e.unitId } });
          return 'saved';
        } catch (err) {
          return err.code;
        }
      }, ev);
      assert.equal(res, 'stale');
      assert.equal((await idbAll(b, 'events')).filter((e) => e.type === 'review').length, 1);
      assertNoErrors(b);
      await ctx.close();
    },
  },
  {
    name: 'image occlusion: draw and label masks, then study the card offline from local media',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { sw: true, viewport: { width: 1280, height: 1800 } });
      const page = await openApp(ctx, url);
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
      });
      const deckId = await seedDeck(page, { name: 'Anatomy', cards: [] });
      await page.evaluate((id) => { location.hash = `#/card/new?deck=${id}`; }, deckId);
      await page.getByText('Image occlusion', { exact: true }).click();
      await page.locator('label:has-text("Choose image") input[type=file]').setInputFiles(join(ROOT, 'icons', 'icon-512.png'));
      const img = page.locator('.occlusion.editing img');
      await img.waitFor();
      await page.waitForFunction(() => document.querySelector('.occlusion.editing img')?.complete);
      await img.scrollIntoViewIfNeeded();
      const box = await img.boundingBox();
      const drag = async (x1, y1, x2, y2) => {
        await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * ((x1 + x2) / 2), box.y + box.height * ((y1 + y2) / 2), { steps: 4 });
        await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 4 });
        await page.mouse.up();
      };
      await drag(0.1, 0.1, 0.4, 0.3);
      await page.getByLabel('Label for mask 1').fill('Atrium');
      await page.keyboard.press('Tab');
      await drag(0.55, 0.6, 0.9, 0.85);
      await page.getByLabel('Label for mask 2').fill('Ventricle | lower chamber');
      await page.keyboard.press('Tab');
      // Move mask 1 a little (drag its body).
      await drag(0.2, 0.2, 0.25, 0.22);
      await page.getByRole('button', { name: 'Add card' }).click();
      await page.getByText('Card added').waitFor();
      const [card] = await idbAll(page, 'cards');
      assert.equal(card.occlusion.masks.length, 2);
      assert.deepEqual(card.occlusion.masks.map((m) => m.label), [['Atrium'], ['Ventricle', 'lower chamber']]);
      assert.ok(card.occlusion.masks[0].x > 0.12, 'moved mask saved');
      const units = (await idbAll(page, 'units')).filter((u) => u.cardId === card.id);
      assert.equal(units.length, 2, 'one schedule per mask');
      assert.equal((await idbAll(page, 'media')).length, 1);
      // Offline cold start, then study both masks.
      await ctx.setOffline(true);
      await page.reload();
      await waitReady(page);
      assert.equal(await startReview(page), 'question');
      for (let i = 0; i < 2; i++) {
        await page.locator('.study .occlusion img').waitFor();
        await page.waitForFunction(() => document.querySelector('.study .occlusion img')?.naturalWidth > 0);
        const left = await page.$eval('.study .occlusion .mask:not(.other)', (el) => parseFloat(el.style.left));
        assert.equal(await page.locator('.study .occlusion .mask.other').count(), 1, 'the other mask stays covered');
        const target = card.occlusion.masks.reduce((best, m) => (Math.abs(m.x * 100 - left) < Math.abs(best.x * 100 - left) ? m : best));
        assert.equal(await answer(page, target.label[target.label.length - 1]), 'feedback');
        await page.locator('.study .occlusion .mask.revealed').waitFor();
        if (i === 0) await page.screenshot({ path: join(SHOTS, 'occlusion-revealed.png') });
        await page.keyboard.press('Enter');
        await waitPhase(page, ['question', 'done']);
      }
      assert.equal((await idbAll(page, 'events')).filter((e) => e.type === 'review' && e.response.correct).length, 2);
      assertNoErrors(page, [/Failed to load resource/]);
      await ctx.close();
    },
  },
];
