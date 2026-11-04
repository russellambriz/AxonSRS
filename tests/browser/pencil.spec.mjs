// Create with Pencil: a full-screen studio, a typed answer, and a save-and-next loop.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, assertNoErrors } from './harness.mjs';

const stroke = (page, { x = 36, y = 48, id = 4 } = {}) => page.evaluate(({ x, y, id: pid }) => {
  const c = [...document.querySelectorAll('.pencil-paper .ink-canvas')].find((el) => el.getBoundingClientRect().width > 0);
  const r = c.getBoundingClientRect();
  const fire = (name, dx, dy) => c.dispatchEvent(new PointerEvent(name, {
    pointerType: 'pen', pointerId: pid, clientX: r.left + dx, clientY: r.top + dy,
    pressure: name === 'pointerup' ? 0 : 0.75, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
  }));
  fire('pointerdown', x, y);
  fire('pointermove', x + 50, y + 16);
  fire('pointermove', x + 110, y + 4);
  fire('pointerup', x + 110, y + 4);
}, { x, y, id });

const visibleStrokes = (page) => page.evaluate(() => {
  const c = [...document.querySelectorAll('.pencil-paper .ink-canvas')].find((el) => el.getBoundingClientRect().width > 0);
  return c?.dataset.strokes || '';
});

export const tests = [
  {
    name: 'pencil studio: draw a prompt, type the graded answer, undo and redo, then save and start the next card',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 1366, height: 1024 }, hasTouch: true });
      const page = await openApp(ctx, url);
      const outside = [];
      page.on('request', (req) => {
        const u = req.url();
        if (u.startsWith('blob:') || u.startsWith('data:') || u.includes('/AxonSRS/')) return;
        outside.push(u);
      });
      const deckId = await seedDeck(page, { name: 'Pencil deck', cards: [] });
      await page.evaluate((id) => { location.hash = `#/pencil?deck=${id}`; }, deckId);
      await page.getByRole('heading', { name: 'Create with Pencil' }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.pencil-paper .ink-canvas')].some((c) => c.width > 0));
      assert.equal(await page.locator('textarea.pencil-answer').evaluate((el) => el.tagName), 'TEXTAREA', 'the graded answer is a normal field, so Scribble still works');
      const layout = await page.evaluate(() => {
        const paper = document.querySelector('.pencil-paper').getBoundingClientRect();
        const answer = document.querySelector('.pencil-graded').getBoundingClientRect();
        return { paperRight: paper.right, answerLeft: answer.left, paperH: paper.height };
      });
      assert.ok(layout.answerLeft >= layout.paperRight - 8, 'landscape puts the graded answer to the right of the page');
      assert.ok(layout.paperH > 400, 'the page is large on a 13-inch landscape screen');

      await page.getByRole('button', { name: 'Blue' }).click();
      assert.equal(await page.getAttribute('button[aria-label="Blue"]', 'aria-pressed'), 'true');
      await stroke(page);
      const blue = await page.evaluate(() => {
        const c = document.querySelector('.pencil-paper .ink-canvas');
        const ctx2 = c.getContext('2d');
        const { data, width, height } = ctx2.getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < data.length; i += 16) {
          if (data[i] > 40 && data[i - 1] > data[i - 3] + 40) return true;
        }
        return width > 0 && height > 0 ? false : false;
      });
      assert.equal(blue, true, 'the blue pen is what lands on the page');
      assert.equal(await visibleStrokes(page), '1');
      await page.getByRole('button', { name: 'Undo stroke' }).click();
      assert.equal(await visibleStrokes(page), '0');
      await page.getByRole('button', { name: 'Redo stroke' }).click();
      assert.equal(await visibleStrokes(page), '1');

      await page.getByRole('button', { name: 'Back' }).click();
      await page.waitForFunction(() => document.querySelector('.pencil-studio')?.dataset.side === 'back');
      assert.equal(await visibleStrokes(page), '0', 'the back page starts blank');
      await stroke(page, { y: 80, id: 8 });
      assert.equal(await visibleStrokes(page), '1');
      await page.getByRole('button', { name: 'Front' }).click();
      await page.waitForFunction(() => document.querySelector('.pencil-studio')?.dataset.side === 'front');
      assert.equal(await visibleStrokes(page), '1', 'the front sketch is still there');

      await page.getByRole('button', { name: 'Save & next' }).click();
      await page.getByText('Type the answer Axon should check').waitFor();
      await page.getByRole('textbox', { name: 'Graded answer' }).fill('Lima');
      await page.getByRole('button', { name: 'Save & next' }).click();
      await page.getByText('1 saved').waitFor();
      assert.equal(await page.locator('.pencil-answer').inputValue(), '');
      assert.equal(await visibleStrokes(page), '0', 'the next card starts on a clean page');
      const [card] = await idbAll(page, 'cards');
      assert.match(card.front.join('\n'), /axon-media:sha256-/);
      assert.match(card.back.join('\n'), /^Lima/);
      assert.match(card.back.join('\n'), /Handwritten note/);
      const media = await idbAll(page, 'media');
      assert.equal(media.length, 2);
      assert.ok(media.every((m) => m.type === 'image/png' && m.size > 0 && m.size <= 5 * 1024 * 1024));

      await page.getByRole('textbox', { name: 'Prompt text' }).fill('Capital of Chile');
      await page.getByRole('textbox', { name: 'Graded answer' }).fill('Santiago');
      await page.getByRole('button', { name: 'Save & next' }).click();
      await page.getByText('2 saved').waitFor();
      const cards = await idbAll(page, 'cards');
      assert.equal(cards.length, 2);
      assert.ok(cards.some((c) => c.back.join('\n').startsWith('Santiago') && !c.front.join('\n').includes('axon-media')));

      await page.setViewportSize({ width: 320, height: 640 });
      await page.waitForTimeout(80);
      const narrow = await page.evaluate(() => {
        const study = document.querySelector('.pencil-studio');
        const overflow = [...study.querySelectorAll('*')].filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.right > window.innerWidth + 1;
        }).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
        const paper = document.querySelector('.pencil-paper').getBoundingClientRect();
        const answer = document.querySelector('.pencil-graded').getBoundingClientRect();
        return {
          doc: document.documentElement.scrollWidth <= window.innerWidth + 1,
          studio: study.scrollWidth <= study.clientWidth + 1,
          stacked: answer.top >= paper.bottom - 24,
          overflow,
        };
      });
      assert.equal(narrow.stacked, true);
      assert.equal(narrow.doc, true, narrow.overflow.join(', '));
      assert.equal(narrow.studio, true, narrow.overflow.join(', '));
      assert.deepEqual(narrow.overflow, []);
      assert.deepEqual(outside, []);
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
