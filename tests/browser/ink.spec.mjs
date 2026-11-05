// Ink engine and write-on trace on the real study pad: cached finished ink,
// the tail ahead of the tip without browser prediction, the palm guard,
// readable dots, theme repaint, and the faint, accent-tinted ghost that is
// still one copy event and one self-graded review.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, inApp, startReview, waitPhase, assertNoErrors } from './harness.mjs';

async function writeMode(page) {
  await page.getByRole('button', { name: 'Write' }).click();
  await page.locator('.ink-canvas').waitFor();
  await page.waitForFunction(() => document.querySelector('.ink-canvas')?.width > 0);
}

/** A pen stroke along a gentle wave, dispatched synchronously. */
const wave = (page, { x = 20, y = 40, n = 40, id = 50, p = 0.5 } = {}) => page.evaluate(({ x: ox, y: oy, n: count, id: pid, p: pr }) => {
  const c = document.querySelector('.ink-canvas');
  const r = c.getBoundingClientRect();
  const fire = (name, i, pressure) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: pid, clientX: r.left + ox + i * 2.5, clientY: r.top + oy + Math.sin(i / 4) * 6, pressure, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  fire('pointerdown', 0, pr * 0.6);
  for (let i = 1; i <= count; i++) fire('pointermove', i, pr);
  fire('pointerup', count, 0);
}, { x, y, n, id, p });

export const tests = [
  {
    name: 'finished ink is cached: a live frame redraws only the stroke under the pencil, undo is exact, and a theme switch repaints at once',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 1180, height: 820 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Ink cache', 'x']] });
      await startReview(page);
      await writeMode(page);
      for (let k = 0; k < 24; k++) await wave(page, { x: 12 + (k % 6) * 70, y: 24 + Math.floor(k / 6) * 34, n: 24, id: 100 + k });
      const result = await page.evaluate(async () => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const hash = () => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let h = 0;
          for (let i = 3; i < d.length; i += 16) h = (h * 31 + d[i]) | 0;
          return h;
        };
        const before = hash();
        // Count circles painted during one live frame of a new stroke.
        const orig = CanvasRenderingContext2D.prototype.arc;
        let arcs = 0;
        CanvasRenderingContext2D.prototype.arc = function (...a) { arcs += 1; return orig.apply(this, a); };
        const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 900, clientX: r.left + x, clientY: r.top + y, pressure: 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        fire('pointerdown', 40, r.height - 30);
        fire('pointermove', 52, r.height - 30);
        await raf();
        arcs = 0;
        fire('pointermove', 64, r.height - 30);
        await raf();
        const liveArcs = arcs;
        CanvasRenderingContext2D.prototype.arc = orig;
        fire('pointerup', 64, r.height - 30);
        const strokes = Number(c.dataset.strokes);
        const points = Number(c.dataset.points);
        return { before, liveArcs, strokes, points };
      });
      assert.equal(result.strokes, 25);
      assert.ok(result.points > 600, 'a full page of ink');
      assert.ok(result.liveArcs < 120, `a live frame painted ${result.liveArcs} discs: finished strokes must come from the cache`);
      // Undo the last stroke: the page is exactly what it was.
      await page.getByRole('button', { name: 'Undo stroke' }).click();
      const afterUndo = await page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (let i = 3; i < d.length; i += 16) h = (h * 31 + d[i]) | 0;
        return h;
      });
      assert.equal(afterUndo, result.before, 'undo restores the cached page exactly');
      // Theme switch with nothing being drawn: default-colour ink follows at once.
      const colours = await page.evaluate(async () => {
        const c = document.querySelector('.ink-canvas');
        const g = c.getContext('2d');
        const inkPixel = () => {
          const d = g.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) return [d[i], d[i + 1], d[i + 2]].join(',');
          return null;
        };
        document.documentElement.setAttribute('data-theme', 'light');
        await new Promise((res) => setTimeout(res, 30));
        const light = inkPixel();
        document.documentElement.setAttribute('data-theme', 'dark');
        await new Promise((res) => setTimeout(res, 30));
        const dark = inkPixel();
        return { light, dark, expected: getComputedStyle(c).color };
      });
      assert.ok(colours.light && colours.dark && colours.light !== colours.dark, `ink did not follow the theme: ${JSON.stringify(colours)}`);
      assert.ok(colours.expected.replace(/\s/g, '').includes(colours.dark), `dark ink is the dark text colour: ${JSON.stringify(colours)}`);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'without browser prediction a steady stroke gets a short tail ahead of the tip that is never stored',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Tail', 'x']] });
      await startReview(page);
      await writeMode(page);
      const seen = await page.evaluate(async () => {
        const c = document.querySelector('.ink-canvas');
        const pad = c.closest('.ink-pad');
        const r = c.getBoundingClientRect();
        const origP = PointerEvent.prototype.getPredictedEvents;
        PointerEvent.prototype.getPredictedEvents = function () { return []; };
        const fire = (name, x) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 31, clientX: r.left + x, clientY: r.top + 60, pressure: 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        const wait = (ms) => new Promise((res) => setTimeout(res, ms));
        fire('pointerdown', 20);
        const flags = [];
        for (let i = 1; i <= 8; i++) {
          await wait(8);
          fire('pointermove', 20 + i * 6);
          flags.push(pad.dataset.predicted);
        }
        await wait(8);
        fire('pointerup', 20 + 8 * 6);
        PointerEvent.prototype.getPredictedEvents = origP;
        return { flags, after: pad.dataset.predicted, points: Number(c.dataset.points) };
      });
      assert.ok(seen.flags.includes('1'), `a steady stroke shows a tail: ${seen.flags.join('')}`);
      assert.equal(seen.after, '0', 'the tail is gone when the pencil lifts');
      assert.ok(seen.points <= 10, `only real samples are stored (${seen.points})`);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'palm guard: a touch on Clear while the pencil writes or just after it lifts is ignored; a later tap and a pencil tap work',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Palm guard', 'x']] });
      await startReview(page);
      await writeMode(page);
      const out = await page.evaluate(async () => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const clear = [...document.querySelectorAll('.ink-tools button')].find((b) => b.textContent.includes('Clear'));
        const pen = (name, x) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 41, clientX: r.left + x, clientY: r.top + 50, pressure: 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        const tap = (type) => {
          clear.dispatchEvent(new PointerEvent('pointerdown', { pointerType: type, pointerId: type === 'pen' ? 42 : 77, bubbles: true, cancelable: true }));
          clear.dispatchEvent(new PointerEvent('pointerup', { pointerType: type, pointerId: type === 'pen' ? 42 : 77, bubbles: true, cancelable: true }));
          clear.click();
        };
        const strokes = () => Number(c.dataset.strokes);
        const log = [];
        pen('pointerdown', 20);
        pen('pointermove', 60);
        tap('touch');
        pen('pointermove', 90);
        pen('pointerup', 90);
        log.push(strokes());
        tap('touch');
        log.push(strokes());
        await new Promise((res) => setTimeout(res, 520));
        tap('touch');
        log.push(strokes());
        pen('pointerdown', 20);
        pen('pointermove', 60);
        pen('pointerup', 60);
        tap('pen');
        log.push(strokes());
        return { log, palm: Number(c.closest('.ink-pad').dataset.palm) };
      });
      assert.deepEqual(out.log, [1, 1, 0, 0], `palm taps while and just after writing are ignored; a later tap and a pencil tap clear: ${out.log}`);
      assert.equal(out.palm, 2, 'two palm touches were caught');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'a quick light tap draws a readable round dot',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Dot', 'x']] });
      await startReview(page);
      await writeMode(page);
      const dot = await page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, p) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 61, clientX: r.left + 80, clientY: r.top + 80, pressure: p, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        fire('pointerdown', 0.03);
        fire('pointerup', 0);
        const g = c.getContext('2d');
        const dpr = c.width / r.width;
        // Pixel (80 + dx) has its centre at 80 + dx + 0.5 CSS px: dx = 1 is 1.5px from
        // the centre, inside the new dot (radius ≥ 2.2) and outside a 1.07px speck.
        const alphaAt = (dx) => g.getImageData(Math.floor((80 + dx) * dpr), Math.floor(80 * dpr), 1, 1).data[3];
        return { centre: alphaAt(0), edge: alphaAt(1), outside: alphaAt(5) };
      });
      assert.ok(dot.centre > 200 && dot.edge > 120, `the dot is solid and readable: ${JSON.stringify(dot)}`);
      assert.ok(dot.outside < 40, 'and still a dot, not a blot');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'write-on: the model is faint, accent-tinted, at its written size and centred; it steps back while tracing, returns on Clear, and is one copy event',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
      await inApp(page, async ({ store, app, model }) => {
        const c = document.createElement('canvas');
        c.width = 240;
        c.height = 96;
        const g = c.getContext('2d');
        g.fillStyle = '#f6f3ee';
        g.fillRect(0, 0, 240, 96);
        g.strokeStyle = '#1c1917';
        g.lineWidth = 6;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(16, 70);
        g.quadraticCurveTo(120, 8, 224, 70);
        g.stroke();
        const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        const id = await store.putMedia(blob, { name: 'handwritten-answer.png' });
        const deck = await store.createDeck({ name: 'Write-on' });
        await store.saveCard(model.createCard({ deckId: deck.id, front: 'Draw the arch', back: `![Handwritten answer](axon-media:${id})`, media: [id] }, store.deviceId));
        await app.cache.load();
      });
      await startReview(page);
      await page.locator('.ink-canvas').waitFor();
      await page.waitForFunction(() => document.querySelector('.ink-canvas')?.width > 0);
      await page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, x) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 5, clientX: r.left + x, clientY: r.top + 30, pressure: 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        fire('pointerdown', 30); fire('pointermove', 70); fire('pointerup', 70);
      });
      await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
      await waitPhase(page, ['grading']);
      await page.getByRole('button', { name: /^Not correct/ }).click();
      assert.equal(await waitPhase(page, ['retype']), 'retype');
      await page.waitForFunction(() => document.querySelector('.ink-pad')?.dataset.ghost === 'shown');
      const measure = () => page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const dpr = c.width / r.width;
        const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        let maxA = 0;
        let minX = width;
        let maxX = 0;
        let minY = height;
        let maxY = 0;
        let rgb = null;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const a = data[(y * width + x) * 4 + 3];
            if (a > 8) {
              if (a > maxA) {
                maxA = a;
                rgb = [data[(y * width + x) * 4], data[(y * width + x) * 4 + 1], data[(y * width + x) * 4 + 2]];
              }
              minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
          }
        }
        return { maxA, rgb, w: (maxX - minX) / dpr, cx: (minX + maxX) / 2 / dpr, cy: (minY + maxY) / 2 / dpr, padW: r.width, padH: r.height, state: c.closest('.ink-pad').dataset.ghost, strokes: c.dataset.strokes };
      });
      const shown = await measure();
      assert.equal(shown.strokes, '0', 'the ghost is not a stroke');
      assert.ok(shown.maxA >= 60 && shown.maxA <= 95, `faint: max alpha ${shown.maxA} should be about a third`);
      assert.ok(shown.rgb[2] > shown.rgb[0] + 40, `tinted with the accent (blue-violet), not black: ${shown.rgb}`);
      assert.ok(shown.w > 190 && shown.w < 245, `drawn at the size it was written (${shown.w.toFixed(0)}px), not stretched across the pad`);
      assert.ok(Math.abs(shown.cx - shown.padW / 2) < 8, 'centred across');
      // Trace: the model steps back under the new ink.
      await page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, x) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 6, clientX: r.left + x, clientY: r.top + 12, pressure: 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        fire('pointerdown', 20); fire('pointermove', 40); fire('pointerup', 40);
      });
      assert.equal(await page.getAttribute('.ink-pad', 'data-ghost'), 'tracing');
      const ghostAlphaNow = await page.evaluate(({ x, y }) => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const dpr = c.width / r.width;
        const d = c.getContext('2d').getImageData(Math.round(x * dpr) - 30, Math.round(y * dpr) - 30, 60, 60).data;
        let m = 0;
        for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]);
        return m;
      }, { x: shown.cx, y: shown.cy - 14 });
      assert.ok(ghostAlphaNow < shown.maxA - 15, `the model recedes while tracing (${ghostAlphaNow} vs ${shown.maxA})`);
      // Clear: a fresh go, the model back at full strength.
      await page.getByRole('button', { name: 'Clear' }).click();
      assert.equal(await page.getAttribute('.ink-pad', 'data-ghost'), 'shown');
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0');
      // Dark theme: the ghost is re-tinted and still visible.
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.waitForTimeout(40);
      const dark = await measure();
      assert.ok(dark.maxA >= 60, 'still visible on a dark pad');
      assert.notDeepEqual(dark.rgb, shown.rgb, 'tint follows the theme');
      await page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, x) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 7, clientX: r.left + x, clientY: r.top + 40, pressure: 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        fire('pointerdown', 30); fire('pointermove', 90); fire('pointerup', 90);
      });
      await page.getByRole('button', { name: 'Done' }).click();
      await waitPhase(page, ['question', 'done']);
      assert.equal(await page.getAttribute('.ink-pad', 'data-ghost'), '0', 'the model is gone after Done');
      const events = await idbAll(page, 'events');
      const reviews = events.filter((e) => e.type === 'review');
      assert.equal(reviews.length, 1, 'tracing is not a second review');
      assert.equal(reviews[0].response.method, 'self');
      assert.equal(events.filter((e) => e.type === 'copy' && !e.bypassed).length, 1, 'one copy event');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'write-on for a typed answer written on the pad: a short plain-text answer appears faintly to trace; maths does not; still one copy event',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
      await seedDeck(page, { name: 'Words', cards: [['Capital of Peru', 'Lima']] });
      await seedDeck(page, { name: 'Maths', settings: { answerMode: 'math' }, cards: [['d/dx x^2', '2x']] });
      await startReview(page);
      await writeMode(page);
      const missOnce = async () => {
        await page.evaluate(() => {
          const c = document.querySelector('.ink-canvas');
          const r = c.getBoundingClientRect();
          const fire = (name, x) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 71, clientX: r.left + x, clientY: r.top + 30, pressure: 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
          fire('pointerdown', 30); fire('pointermove', 80); fire('pointerup', 80);
        });
        await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
        await waitPhase(page, ['grading']);
        await page.getByRole('button', { name: /^Not correct/ }).click();
        return waitPhase(page, ['retype', 'feedback']);
      };
      const seen = {};
      for (let k = 0; k < 2; k++) {
        const prompt = await page.textContent('#study-prompt');
        assert.equal(await missOnce(), 'retype');
        const isText = prompt.includes('Peru');
        if (isText) {
          await page.waitForFunction(() => document.querySelector('.ink-pad')?.dataset.ghost === 'shown');
          await page.getByText('Trace the correct answer once').first().waitFor();
          const alpha = await page.evaluate(() => {
            const c = document.querySelector('.ink-canvas');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let m = 0;
            for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]);
            return m;
          });
          assert.ok(alpha > 40 && alpha < 100, `the written-out answer is faint (${alpha})`);
          seen.text = true;
        } else {
          await page.waitForTimeout(80);
          assert.equal(await page.getAttribute('.ink-pad', 'data-ghost'), '0', 'maths is typeset, not traced');
          await page.getByText('Write the correct answer once').first().waitFor();
          seen.math = true;
        }
        await page.evaluate(() => {
          const c = document.querySelector('.ink-canvas');
          const r = c.getBoundingClientRect();
          const fire = (name, x) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 72, clientX: r.left + x, clientY: r.top + 60, pressure: 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
          fire('pointerdown', 30); fire('pointermove', 120); fire('pointerup', 120);
        });
        await page.getByRole('button', { name: 'Done' }).click();
        await waitPhase(page, ['question', 'done']);
      }
      assert.deepEqual(seen, { text: true, math: true });
      const events = await idbAll(page, 'events');
      assert.equal(events.filter((e) => e.type === 'review').length, 2, 'one review per card');
      assert.ok(events.filter((e) => e.type === 'review').every((e) => e.response.method === 'self'));
      assert.equal(events.filter((e) => e.type === 'copy' && !e.bypassed).length, 2, 'one copy event per miss');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
