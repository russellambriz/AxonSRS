// Create with Pencil: a full-screen studio, a typed answer, and a save-and-next loop.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, assertNoErrors, startReview, waitPhase } from './harness.mjs';

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
      assert.equal(await page.locator('.pencil-quick').isHidden(), true, 'the under-page actions wait until the back');
      assert.equal(await page.getAttribute('button[aria-label="Smoothing Medium"]', 'aria-pressed'), 'true');
      await page.getByRole('button', { name: 'Smoothing High' }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('axon-ink-smoothing')), 'high');
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
      const pencilQuick = await page.evaluate(() => {
        const quick = document.querySelector('.pencil-quick');
        const paper = document.querySelector('.pencil-paper');
        const header = document.querySelector('.pencil-top-actions');
        const q = quick.getBoundingClientRect();
        const p = paper.getBoundingClientRect();
        const heights = [...document.querySelectorAll('.pencil-actions .btn')].map((b) => b.getBoundingClientRect().height).filter((h) => h > 0);
        return {
          shown: !quick.hidden && q.height > 0,
          below: q.top >= p.bottom - 2,
          header: [...header.querySelectorAll('button')].map((b) => b.textContent),
          minH: Math.min(...heights),
        };
      });
      assert.equal(pencilQuick.shown, true, 'Save & flip sits under the back page');
      assert.equal(pencilQuick.below, true);
      assert.deepEqual(pencilQuick.header, ['Done', 'Save & flip']);
      assert.ok(pencilQuick.minH >= 44, `pencil touch height ${pencilQuick.minH}`);
      assert.equal(await visibleStrokes(page), '0', 'the back page starts blank');
      await stroke(page, { y: 80, id: 8 });
      assert.equal(await visibleStrokes(page), '1');
      await stroke(page, { x: 80, y: 140, id: 9 });
      await page.getByRole('button', { name: 'Front' }).click();
      await page.waitForFunction(() => document.querySelector('.pencil-studio')?.dataset.side === 'front');
      assert.equal(await visibleStrokes(page), '1', 'the front sketch is still there');

      await page.getByRole('button', { name: 'Typed answer' }).click();
      await page.getByRole('button', { name: 'Save & flip' }).first().click();
      await page.getByText('Type the answer Axon should check').waitFor();
      await page.getByRole('textbox', { name: 'Graded answer' }).fill('Lima');
      await page.getByRole('button', { name: 'Save & flip' }).first().click();
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
      await page.getByRole('button', { name: 'Save & flip' }).first().click();
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
  {
    name: 'handwriting alone is the card: the back is the ink, and review is self-graded',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 1100, height: 800 }, hasTouch: true });
      const page = await openApp(ctx, url);
      const deckId = await seedDeck(page, { name: 'Ink cards', cards: [] });
      await page.evaluate((id) => { location.hash = `#/pencil?deck=${id}`; }, deckId);
      await page.getByRole('heading', { name: 'Create with Pencil' }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.pencil-paper .ink-canvas')].some((c) => c.width > 0));
      assert.equal(await page.getAttribute('.pencil-studio', 'data-answer'), 'ink');
      await stroke(page, { y: 40, id: 3 });
      await page.getByRole('button', { name: 'Back' }).click();
      await page.waitForFunction(() => document.querySelector('.pencil-studio')?.dataset.side === 'back');
      await page.locator('.pencil-ghost').getByText('Write the answer', { exact: true }).waitFor();
      await stroke(page, { y: 70, id: 9 });
      await page.getByRole('button', { name: 'Save & flip' }).first().click();
      await page.getByText('1 saved').waitFor();
      const [card] = await idbAll(page, 'cards');
      assert.match(card.front.join('\n'), /!\[[^\]]*\]\(axon-media:sha256-/);
      assert.match(card.back.join('\n'), /^!\[Handwritten answer\]\(axon-media:sha256-/);
      assert.equal(card.back.join('\n').includes('Lima'), false);
      await page.evaluate(() => { location.hash = '#/cards'; });
      await page.locator('.card-row img').first().waitFor();
      await page.waitForFunction(() => document.querySelector('.card-row img')?.naturalWidth > 0);
      assert.equal(await startReview(page), 'question');
      await page.locator('#study-prompt img').waitFor();
      await page.waitForFunction(() => document.querySelector('#study-prompt img')?.naturalWidth > 0);
      assert.equal(await page.locator('.answer-input').isVisible(), false, 'an ink card does not ask for typed text');
      await page.getByText('Handwritten', { exact: true }).waitFor();
      await page.evaluate(() => {
        const c = document.querySelector('.study .ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 12, clientX: r.left + x, clientY: r.top + y, pressure: 0.6, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        fire('pointerdown', 30, 40);
        fire('pointermove', 90, 50);
        fire('pointerup', 90, 50);
      });
      await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
      assert.equal(await waitPhase(page, ['grading']), 'grading');
      await page.getByRole('img', { name: 'Handwritten answer', exact: true }).waitFor();
      await page.getByRole('button', { name: /^Correct on my own/ }).click();
      assert.equal(await waitPhase(page, ['feedback']), 'feedback');
      const review = (await idbAll(page, 'events')).find((e) => e.type === 'review');
      assert.equal(review.response.method, 'self');
      assert.equal(review.response.correct, true);
      assert.equal(review.modality.kind, 'handwriting');
      assert.equal(review.selfJudged, true);
      assert.equal(review.research, null);
      assert.equal(review.rating, 3);
      const baselines = await idbAll(page, 'baselines');
      assert.ok(baselines.every((b) => !(b.samples || []).length), 'an ink card never calibrates timing');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'saved cards open from the studio: thumbnails, flip, swipe, edit and delete',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 1366, height: 1024 }, hasTouch: true });
      const page = await openApp(ctx, url);
      const deckId = await seedDeck(page, { name: 'Pencil deck', cards: [] });
      await page.evaluate((id) => { location.hash = `#/pencil?deck=${id}`; }, deckId);
      await page.getByRole('heading', { name: 'Create with Pencil' }).waitFor();
      await page.getByRole('button', { name: 'Typed answer' }).click();
      await page.getByRole('textbox', { name: 'Prompt text' }).fill('Alpha');
      await page.getByRole('textbox', { name: 'Graded answer' }).fill('One');
      await page.getByRole('button', { name: 'Save & flip' }).first().click();
      await page.getByText('1 saved').waitFor();

      await page.getByRole('button', { name: 'Handwritten answer' }).click();
      await page.getByRole('textbox', { name: 'Prompt text' }).fill('Beta');
      await page.waitForFunction(() => [...document.querySelectorAll('.pencil-paper .ink-canvas')].some((c) => c.width > 0));
      await page.getByRole('button', { name: 'Back' }).click();
      await page.waitForFunction(() => document.querySelector('.pencil-studio')?.dataset.side === 'back');
      await stroke(page, { y: 90, id: 15 });
      await page.getByRole('button', { name: 'Save & flip' }).first().click();
      await page.getByRole('button', { name: 'Show 2 saved' }).click();
      const beta = page.getByRole('button', { name: 'Beta', exact: true });
      await beta.waitFor();
      await page.waitForFunction(() => document.querySelector('.pencil-thumb img')?.naturalWidth > 0);
      await beta.click();
      await page.locator('.pencil-card').getByText('Beta').waitFor();
      await page.locator('.pencil-card').click();
      await page.locator('.pencil-card').getByText('Back').waitFor();
      await page.locator('.pencil-card img').waitFor();
      await page.locator('.pencil-card').evaluate((el) => {
        const r = el.getBoundingClientRect();
        const fire = (name, x) => el.dispatchEvent(new PointerEvent(name, {
          pointerType: 'touch', pointerId: 3, clientX: x, clientY: r.top + r.height / 2,
          buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
        }));
        fire('pointerdown', r.right - 24);
        fire('pointerup', r.left + 16);
      });
      await page.locator('.pencil-card').getByText('Alpha').waitFor();
      await page.getByRole('button', { name: 'Previous card' }).click();
      await page.locator('.pencil-card').getByText('Beta').waitFor();
      await page.getByRole('button', { name: 'Edit' }).click();
      await page.locator('.pencil-viewer').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.pencil-prompt').inputValue(), 'Beta');
      await page.getByRole('button', { name: 'Back' }).click();
      await page.waitForFunction(() => {
        const c = [...document.querySelectorAll('.pencil-paper .ink-canvas')].find((el) => el.getBoundingClientRect().width > 0);
        if (!c?.width) return false;
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 32) if (data[i] > 12) return true;
        return false;
      });

      await page.getByRole('button', { name: 'Show 2 saved' }).click();
      await page.getByRole('button', { name: 'Beta', exact: true }).click();
      await page.getByRole('button', { name: 'Delete' }).click();
      await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
      await page.getByText('Card deleted').waitFor();
      assert.equal((await idbAll(page, 'cards')).length, 1);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.getByRole('button', { name: 'Show 2 saved' }).waitFor();
      assert.equal((await idbAll(page, 'cards')).length, 2);

      await page.setViewportSize({ width: 320, height: 640 });
      await page.waitForTimeout(50);
      const fit = await page.evaluate(() => {
        const wide = [...document.querySelectorAll('body *')].filter((el) => {
          const box = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return box.width > 0 && box.height > 0 && s.display !== 'none' && box.right > window.innerWidth + 1 && !el.closest('.pencil-strip');
        }).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
        return { doc: document.documentElement.scrollWidth <= window.innerWidth + 1, wide };
      });
      assert.equal(fit.doc, true, fit.wide.join(', '));
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'a closed pencil loop stays solid ink and does not fill its middle',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 900, height: 700 }, hasTouch: true });
      const page = await openApp(ctx, url);
      const deckId = await seedDeck(page, { name: 'Ink', cards: [] });
      await page.evaluate((id) => { location.hash = `#/pencil?deck=${id}`; }, deckId);
      await page.getByRole('heading', { name: 'Create with Pencil' }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.pencil-paper .ink-canvas')].some((c) => c.width > 0));
      const coverage = await page.evaluate(() => {
        const c = [...document.querySelectorAll('.pencil-paper .ink-canvas')].find((el) => el.getBoundingClientRect().width > 0);
        const r = c.getBoundingClientRect();
        const cx = 120;
        const cy = 100;
        const rad = 34;
        const n = 36;
        const fire = (name, i) => {
          const a = (i / n) * Math.PI * 2;
          c.dispatchEvent(new PointerEvent(name, {
            pointerType: 'pen', pointerId: 11, clientX: r.left + cx + Math.cos(a) * rad, clientY: r.top + cy + Math.sin(a) * rad,
            pressure: 0.55, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
          }));
        };
        fire('pointerdown', 0);
        for (let i = 1; i <= n; i++) fire('pointermove', i);
        fire('pointerup', 0);
        const ctx2 = c.getContext('2d');
        const dpr = c.width / r.width;
        const alpha = (x, y) => {
          const px = Math.round(x * dpr);
          const py = Math.round(y * dpr);
          if (px < 0 || py < 0 || px >= c.width || py >= c.height) return 0;
          return ctx2.getImageData(px, py, 1, 1).data[3];
        };
        const near = (x, y) => {
          let m = 0;
          for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) m = Math.max(m, alpha(x + dx, y + dy));
          return m;
        };
        const onRing = [];
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          onRing.push(near(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad));
        }
        return { onRing, middle: alpha(cx, cy) };
      });
      assert.ok(coverage.onRing.every((a) => a > 80), `ink dropped out on the loop: ${coverage.onRing.join(',')}`);
      assert.ok(coverage.middle < 40, 'the middle of the loop was filled in');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
