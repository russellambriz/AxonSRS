// Drawing in the card editor: a sketch becomes a PNG through the image path.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, assertNoErrors } from './harness.mjs';

const stroke = (page) => page.evaluate(() => {
  const c = document.querySelector('dialog .ink-canvas');
  const r = c.getBoundingClientRect();
  const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 5, clientX: r.left + x, clientY: r.top + y, pressure: name === 'pointerup' ? 0 : 0.7, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  fire('pointerdown', 24, 30);
  fire('pointermove', 80, 50);
  fire('pointermove', 140, 36);
  fire('pointerup', 140, 36);
});

export const tests = [
  {
    name: 'Draw inserts a PNG on the front or the back through the image checks',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 1100, height: 900 } });
      const page = await openApp(ctx, url);
      const outside = [];
      page.on('request', (req) => {
        const u = req.url();
        // blob: and data: are local (the preview and the PNG). They are not network.
        if (u.startsWith('blob:') || u.startsWith('data:') || u.includes('/AxonSRS/')) return;
        outside.push(u);
      });
      const deckId = await seedDeck(page, { name: 'Sketches', cards: [] });
      await page.evaluate((id) => { location.hash = `#/card/new?deck=${id}`; }, deckId);
      await page.getByRole('button', { name: 'Draw' }).waitFor();
      await page.getByRole('button', { name: 'Draw' }).click();
      await page.getByRole('dialog', { name: 'Draw' }).waitFor();
      const insert = page.getByRole('button', { name: 'Insert' });
      assert.equal(await insert.isDisabled(), true, 'nothing to insert yet');
      await stroke(page);
      await page.waitForFunction(() => !document.querySelector('dialog button.primary')?.disabled);
      assert.equal(await insert.isDisabled(), false);
      await insert.click();
      await page.getByText('Image added').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('textarea')[0].value.includes('axon-media:'));
      const front = await page.locator('textarea').nth(0).inputValue();
      assert.match(front, /!\[drawing\]\(axon-media:sha256-/);
      await page.locator('textarea').nth(1).click();
      await page.getByRole('button', { name: 'Draw' }).click();
      await page.locator('dialog .ink-canvas').waitFor();
      await page.evaluate(() => {
        const c = document.querySelector('dialog .ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 6, clientX: r.left + x, clientY: r.top + y, pressure: 0.4, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        fire('pointerdown', 40, 80);
        fire('pointermove', 100, 90);
        fire('pointerup', 100, 90);
      });
      await page.getByRole('button', { name: 'Insert' }).click();
      await page.waitForFunction(() => document.querySelectorAll('textarea')[1].value.includes('axon-media:'));
      await page.getByRole('button', { name: 'Add card' }).click();
      await page.getByText('Card added').waitFor();
      const [card] = await idbAll(page, 'cards');
      assert.match(card.front.join('\n'), /axon-media:sha256-/);
      assert.match(card.back.join('\n'), /axon-media:sha256-/);
      const media = await idbAll(page, 'media');
      assert.ok(media.length >= 1);
      assert.ok(media.every((m) => m.type === 'image/png'));
      assert.ok(media.every((m) => m.size > 0 && m.size <= 5 * 1024 * 1024));
      assert.deepEqual(outside, []);
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
