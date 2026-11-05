// Reverse Recall: one session shows the back and asks for the front.
// The deck's direction setting stays whatever it was.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, answer, waitPhase, promptText, advance, assertNoErrors } from './harness.mjs';

export const tests = [
  {
    name: 'Reverse Recall shows the back and grades the front, including an ink card, without changing the deck',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 1100, height: 800 }, hasTouch: true });
      const page = await openApp(ctx, url);
      const deckId = await seedDeck(page, {
        name: 'Directions',
        settings: { direction: 'forward' },
        cards: [
          ['Sulfate', 'SO4'],
          ['![Handwritten prompt](axon-media:front)', '![Handwritten answer](axon-media:back)'],
        ],
      });
      await page.evaluate((id) => { location.hash = `#/study?deck=${id}`; }, deckId);
      await page.getByRole('button', { name: 'Reverse Recall' }).click();
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await waitPhase(page, ['question']);
      const seen = [];
      for (let i = 0; i < 2; i++) {
        const ink = await page.locator('.answer-input').isHidden();
        if (ink) {
          await page.getByText('The back is showing').waitFor();
          await page.waitForFunction(() => document.querySelector('.study .ink-canvas')?.width > 0);
          await page.evaluate(() => {
            const c = document.querySelector('.study .ink-canvas');
            const r = c.getBoundingClientRect();
            const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 7, clientX: r.left + x, clientY: r.top + y, pressure: 0.6, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
            fire('pointerdown', 30, 40);
            fire('pointermove', 90, 55);
            fire('pointerup', 90, 55);
          });
          await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
          assert.equal(await waitPhase(page, ['grading']), 'grading');
          await page.getByRole('button', { name: /^Correct on my own/ }).click();
          assert.equal(await waitPhase(page, ['feedback']), 'feedback');
          seen.push('ink');
        } else {
          assert.match(await promptText(page), /SO4/);
          await page.getByText('See the answer, recall the prompt.').waitFor();
          assert.equal(await answer(page, 'Sulfate'), 'feedback');
          seen.push('typed');
        }
        if (i === 0) {
          await advance(page);
          await waitPhase(page, ['question']);
        }
      }
      assert.deepEqual(seen.sort(), ['ink', 'typed']);
      const reviews = (await idbAll(page, 'events')).filter((e) => e.type === 'review');
      assert.equal(reviews.length, 2);
      const typed = reviews.find((e) => !e.selfJudged);
      const ink = reviews.find((e) => e.selfJudged);
      assert.equal(typed.response.correct, true);
      assert.match(typed.unitId, /:rev$/);
      assert.equal(ink.response.method, 'self');
      assert.equal(ink.response.correct, true);
      assert.equal(ink.research, null);
      const units = await idbAll(page, 'units');
      assert.ok(units.filter((u) => u.key === 'fwd').every((u) => !u.state));
      assert.ok(units.filter((u) => u.key === 'rev').every((u) => u.state && u.active === false));
      const [deck] = await idbAll(page, 'decks');
      assert.equal(deck.settings.direction, 'forward');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
