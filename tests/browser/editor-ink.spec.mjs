// The regular card editor: ink pads on a touch device, text boxes on a mouse,
// and a visible way to delete a saved card.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, assertNoErrors } from './harness.mjs';

const strokeOn = (page, nth) => page.evaluate((index) => {
  const c = [...document.querySelectorAll('.editor-ink-host .ink-canvas')].filter((el) => el.getBoundingClientRect().width > 0)[index];
  const r = c.getBoundingClientRect();
  const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, {
    pointerType: 'pen', pointerId: 20 + index, clientX: r.left + x, clientY: r.top + y,
    pressure: name === 'pointerup' ? 0 : 0.7, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
  }));
  fire('pointerdown', 28, 36);
  fire('pointermove', 90, 48);
  fire('pointermove', 140, 30);
  fire('pointerup', 140, 30);
}, nth);

export const tests = [
  {
    name: 'a mouse gets the typed editor; a touch device gets ink pads that save a self-graded card and can be cleared and deleted',
    async run({ browser, url }) {
      const mouse = await newContext(browser);
      const mousePage = await openApp(mouse, url);
      await seedDeck(mousePage, { name: 'Chemistry Polyatomics', cards: [] });
      await mousePage.evaluate(() => { location.hash = '#/card/new'; });
      await mousePage.getByRole('button', { name: 'Add card' }).waitFor();
      assert.equal(await mousePage.locator('textarea').nth(0).isVisible(), true, 'keyboard users still get the front text box');
      assert.equal(await mousePage.locator('.editor-ink-host').first().isVisible(), false);
      await mouse.close();

      const ctx = await newContext(browser, { viewport: { width: 1024, height: 900 }, hasTouch: true });
      const page = await openApp(ctx, url);
      const deckId = await seedDeck(page, { name: 'Chemistry Polyatomics', cards: [] });
      await page.evaluate((id) => { location.hash = `#/card/new?deck=${id}`; }, deckId);
      await page.getByRole('button', { name: 'Add card' }).waitFor();
      await page.locator('.editor-ink-host .ink-canvas').first().waitFor();
      assert.equal(await page.locator('.editor-ink-host').count(), 2);
      assert.equal(await page.locator('textarea').nth(0).isVisible(), false, 'the front text box is not where Scribble would steal the ink');
      assert.equal(await page.locator('textarea').nth(1).isVisible(), false);
      await page.getByRole('button', { name: 'Clear Front' }).waitFor();
      await page.getByRole('button', { name: 'Clear Back' }).waitFor();
      await page.getByRole('button', { name: 'Undo stroke' }).first().waitFor();
      await page.getByRole('button', { name: 'Redo stroke' }).first().waitFor();
      await strokeOn(page, 0);
      await page.locator('img[alt="Handwritten prompt"]').waitFor();
      await strokeOn(page, 1);
      await page.locator('img[alt="Handwritten answer"]').waitFor();
      await page.getByRole('button', { name: 'Add card' }).click();
      await page.getByText('Card added').waitFor();
      const [card] = await idbAll(page, 'cards');
      assert.match(card.front.join('\n'), /^!\[Handwritten prompt\]\(axon-media:/);
      assert.match(card.back.join('\n'), /^!\[Handwritten answer\]\(axon-media:/);
      await page.getByRole('row', { name: /Handwritten/ }).click();
      await page.getByRole('button', { name: 'Delete card' }).waitFor();
      await page.evaluate((id) => { location.hash = `#/deck/${id}`; }, deckId);
      await page.getByRole('button', { name: /Delete Handwritten/ }).waitFor();
      await page.getByRole('button', { name: /Delete Handwritten/ }).click();
      await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
      await page.getByText('Card deleted').waitFor();
      assert.equal((await idbAll(page, 'cards')).length, 0);

      await page.evaluate((id) => { location.hash = `#/card/new?deck=${id}`; }, deckId);
      await page.locator('.editor-ink-host').first().waitFor();
      await page.getByRole('button', { name: 'Back: Type' }).click();
      await page.locator('textarea').nth(1).waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('axon-editor-sides')).back), 'text');
      await page.reload();
      await page.locator('textarea').nth(1).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Cloze' }).click();
      assert.equal(await page.locator('.editor-ink-host').first().isVisible(), false, 'cloze stays a text card');
      assert.equal(await page.locator('textarea').nth(0).isVisible(), true);
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
