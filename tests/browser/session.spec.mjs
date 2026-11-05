// Study-session behaviour around a single answer: finishing the retype step,
// announcing grade explanations, abandoned attempts, next-day sibling
// deferral and focus-timer time.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, inApp, startReview, answerFromMap, waitPhase, phase, waitReady, assertNoErrors } from './harness.mjs';

const liveText = (page, id) => page.evaluate((i) => document.getElementById(i)?.textContent || '', id);

/** One stroke on the handwriting pad (synthetic Apple Pencil, finger or palm). */
const stroke = (page, { type = 'pen', id = 7, dx = 0, dy = 0 } = {}) => page.evaluate(({ type: t, id: pid, dx: ox, dy: oy }) => {
  const c = document.querySelector('.ink-canvas');
  const r = c.getBoundingClientRect();
  const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, { pointerType: t, pointerId: pid, isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: name === 'pointerup' ? 0 : 0.6, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  fire('pointerdown', 30 + ox, 30 + oy);
  fire('pointermove', 70 + ox, 50 + oy);
  fire('pointermove', 120 + ox, 40 + oy);
  fire('pointerup', 120 + ox, 40 + oy);
}, { type, id, dx, dy });

export const tests = [
  {
    name: 'retyping the correct answer after a miss records one linked copy, no second review, and moves on',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Capital of France', 'Paris'], ['Capital of Italy', 'Rome']] });
      await startReview(page);
      const map = { France: 'Paris', Italy: 'Rome' };
      const { prompt } = await answerFromMap(page, { France: 'Lyon', Italy: 'Milan' });
      assert.equal(await waitPhase(page, ['retype']), 'retype');
      const right = map[Object.keys(map).find((k) => prompt.includes(k))];
      const afterReview = (await idbAll(page, 'units')).find((u) => u.state?.reps);
      // A wrong retype keeps the learner on the retype step.
      await page.locator('.answer-input').pressSequentially('Nope', { delay: 10 });
      await page.keyboard.press('Enter');
      assert.equal(await waitPhase(page, ['retype']), 'retype');
      await page.locator('.answer-input').fill('');
      await page.locator('.answer-input').pressSequentially(right, { delay: 10 });
      await page.keyboard.press('Enter');
      assert.equal(await waitPhase(page, ['question', 'done']), 'question', 'a correct retype moves to the next card');
      const events = await idbAll(page, 'events');
      const reviews = events.filter((e) => e.type === 'review');
      const copies = events.filter((e) => e.type === 'copy');
      assert.equal(reviews.length, 1, 'retyping is not a second review');
      assert.equal(copies.length, 1);
      assert.equal(copies[0].targetId, reviews[0].id, 'the copy is linked to the failed review');
      assert.equal(copies[0].bypassed, false);
      assert.equal(copies[0].text, right);
      const unit = (await idbAll(page, 'units')).find((u) => u.id === afterReview.id);
      assert.deepEqual(unit.state, afterReview.state, 'retyping leaves the schedule alone');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'the grade explanation is announced with the verdict and again when “Why this grade?” opens',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Capital of Spain', 'Madrid'], ['Capital of Peru', 'Lima']] });
      await startReview(page);
      assert.equal((await answerFromMap(page, { Spain: 'Madrid', Peru: 'Lima' })).phase, 'feedback');
      const review = (await idbAll(page, 'events')).find((e) => e.type === 'review');
      assert.ok(review.grading.explanation, 'the review has an explanation');
      await page.waitForFunction((t) => document.getElementById('sr-live')?.textContent.includes(t), review.grading.explanation);
      assert.match(await liveText(page, 'sr-live'), /^Correct\. .*Graded \w+\./);
      await page.keyboard.press('Alt+KeyY');
      await page.waitForFunction(() => document.querySelector('details.why')?.open);
      await page.waitForFunction(() => document.getElementById('sr-live')?.textContent.includes('heuristic confidence'));
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'leaving or ending a session with an unanswered card records an abandoned attempt, not a review',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Red planet', 'Mars'], ['Ringed planet', 'Saturn'], ['Blue planet', 'Neptune']] });
      await startReview(page);
      await page.locator('.answer-input').pressSequentially('Ma', { delay: 10 });
      await page.getByRole('button', { name: 'Pause and leave' }).click();
      await page.getByRole('button', { name: /Start review|Resume/ }).first().waitFor();
      let events = await idbAll(page, 'events');
      const left = events.filter((e) => e.type === 'abandon');
      assert.equal(left.length, 1);
      assert.equal(left[0].reason, 'left');
      assert.equal(left[0].typed, true);
      assert.ok(left[0].presentationId && left[0].unitId);
      assert.equal(events.filter((e) => e.type === 'review').length, 0);
      // Resume, then end the session from the menu without answering.
      await page.getByRole('button', { name: /Start review|Resume/ }).first().click();
      await waitPhase(page, ['question']);
      await page.getByRole('button', { name: 'Session menu' }).click();
      await page.getByRole('menuitem', { name: 'End session' }).click();
      await waitPhase(page, ['done']);
      events = await idbAll(page, 'events');
      const reasons = events.filter((e) => e.type === 'abandon').map((e) => e.reason).sort();
      assert.deepEqual(reasons, ['ended', 'left']);
      assert.equal(events.filter((e) => e.type === 'review').length, 0);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'next-day sibling spacing marks the held-back sibling Deferred until tomorrow',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { settings: { direction: 'both', siblingSpacing: 'nextDay' }, cards: [['Hund', 'dog'], ['Katze', 'cat']] });
      await startReview(page);
      const session = (await idbAll(page, 'sessions'))[0];
      assert.equal(session.deferred.length, 2, 'one direction of each card is held back');
      const units = await idbAll(page, 'units');
      const tomorrow = await inApp(page, async ({ store }) => {
        const { addDays } = await import(new URL('./js/core/time.js', location.href).href);
        return addDays(store.today(), 1);
      });
      for (const d of session.deferred) {
        assert.equal(units.find((u) => u.id === d.unitId).overlays?.deferredUntil, tomorrow);
      }
      const statuses = await inApp(page, async ({ app }, ids) => {
        const { unitStatus } = await import(new URL('./js/core/queue.js', location.href).href);
        const ctx = app.timeCtx();
        return ids.map((id) => { const u = app.cache.units.get(id); return unitStatus(u, app.cache.cards.get(u.cardId), ctx); });
      }, session.deferred.map((d) => d.unitId));
      assert.deepEqual(statuses, ['deferred', 'deferred']);
      assert.equal(session.queue.length, 2);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'handwriting pad: write with a pen, compare with the answer and grade yourself; Again counts as wrong; the choice is remembered',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Capital of Peru', 'Lima'], ['Capital of Chile', 'Santiago']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor();
      assert.equal(await page.locator('.answer-input').isVisible(), false, 'no text field, so no on-screen keyboard');
      const check = page.getByRole('button', { name: 'Check your handwritten answer' });
      await check.click();
      assert.equal(await phase(page), 'question', 'nothing written yet');
      await stroke(page);
      await stroke(page, { type: 'touch', id: 9 });
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '1', 'a palm touch after the pen is ignored');
      await check.click();
      assert.equal(await waitPhase(page, ['grading']), 'grading');
      await page.getByText('Needs your check', { exact: true }).waitFor();
      await page.getByRole('img', { name: 'Your handwritten answer' }).waitFor();
      assert.ok((await page.textContent('.feedback .answer')).trim().length > 0, 'the correct answer is shown to compare');
      await page.getByRole('button', { name: /^Not correct/ }).click();
      assert.equal(await waitPhase(page, ['retype']), 'retype', 'a wrong handwritten answer is written once');
      await page.getByText('Write the correct answer once').first().waitFor();
      await page.getByText('Not correct (you checked it)').waitFor();
      assert.equal(await page.getByRole('button', { name: 'My answer is correct' }).count(), 0, 'no overrides on a self-graded answer');
      let reviews = (await idbAll(page, 'events')).filter((e) => e.type === 'review');
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].rating, 1);
      assert.equal(reviews[0].response.correct, false);
      assert.equal(reviews[0].response.method, 'self');
      assert.equal(reviews[0].modality.kind, 'handwriting');
      assert.equal(reviews[0].grading.mode, 'manual');
      assert.ok(reviews[0].grading.measurements.raw.latencyMs > 0, 'latency runs to the first stroke');
      await stroke(page);
      await page.getByRole('button', { name: 'Done' }).click();
      assert.equal(await waitPhase(page, ['question']), 'question');
      const copies = (await idbAll(page, 'events')).filter((e) => e.type === 'copy');
      assert.equal(copies.length, 1, 'writing it down is a copy, not a review');
      assert.equal(copies[0].bypassed, false);
      assert.equal(copies[0].targetId, reviews[0].id);
      assert.equal((await idbAll(page, 'events')).filter((e) => e.type === 'review').length, 1);
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0', 'a fresh pad for the next card');
      await stroke(page);
      await page.keyboard.press('Enter');
      await waitPhase(page, ['grading']);
      await page.getByRole('button', { name: /^Correct on my own/ }).click();
      await waitPhase(page, ['feedback']);
      await page.getByText('Correct (you checked it)').waitFor();
      reviews = (await idbAll(page, 'events')).filter((e) => e.type === 'review').sort((x, y) => x.ts - y.ts);
      assert.equal(reviews[1].rating, 3);
      assert.equal(reviews[1].response.correct, true);
      const baselines = await idbAll(page, 'baselines');
      assert.ok(baselines.every((b) => !(b.samples || []).length), 'self-judged answers never calibrate');
      // The choice is remembered on this device.
      await page.reload();
      await waitReady(page);
      await page.waitForTimeout(300);
      if (!(await page.locator('.study').count())) await page.getByRole('button', { name: /Start review|Resume/ }).first().click();
      await waitPhase(page, ['question']);
      await page.locator('.ink-canvas').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Type' }).click();
      await page.locator('.answer-input').waitFor({ state: 'visible' });
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'the focus timer counts time spent reading feedback, not only time to answer',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['One', '1'], ['Two', '2'], ['Three', '3']] });
      await inApp(page, ({ store }) => store.setGlobal({ focusTimer: { enabled: true, minutes: 0.05, breakMinutes: 5 } }));
      await startReview(page);
      assert.equal((await answerFromMap(page, { One: '1', Two: '2', Three: '3' })).phase, 'feedback');
      const review = (await idbAll(page, 'events')).find((e) => e.type === 'review');
      assert.ok(review.activeMs < 3000, 'answering took under the 3 s focus length');
      await page.waitForTimeout(3300);
      await page.keyboard.press('Enter');
      await page.getByText('Focus session complete').waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: 'Keep going' }).click();
      await waitPhase(page, ['question']);
      const s = (await idbAll(page, 'sessions'))[0];
      assert.equal(s.focusMs, 0, 'Keep going starts a new focus block');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'ink keeps coalesced samples and replaces the predicted tail',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Ink', 'kept']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor();
      await page.waitForFunction(() => document.querySelector('.ink-canvas')?.width > 0);
      const measured = await page.evaluate(async () => {
        const c = document.querySelector('.ink-canvas');
        const pad = c.closest('.ink-pad');
        const r = c.getBoundingClientRect();
        const origC = PointerEvent.prototype.getCoalescedEvents;
        const origP = PointerEvent.prototype.getPredictedEvents;
        PointerEvent.prototype.getCoalescedEvents = function () {
          if (this.type !== 'pointermove') return [this];
          return [8, 16].map((dx) => new PointerEvent('pointermove', { pointerType: 'pen', clientX: this.clientX + dx, clientY: this.clientY, pressure: 0.65, buttons: 1 }));
        };
        PointerEvent.prototype.getPredictedEvents = function () {
          if (this.type !== 'pointermove') return [];
          return [new PointerEvent('pointermove', { pointerType: 'pen', clientX: r.left + 300, clientY: r.top + 24, pressure: 0.4, buttons: 1 })];
        };
        const span = () => {
          const ctx2 = c.getContext('2d');
          const { data, width, height } = ctx2.getImageData(0, 0, c.width, c.height);
          let minX = width;
          let maxX = 0;
          let n = 0;
          for (let y = 0; y < height; y += 2) {
            for (let x = 0; x < width; x += 2) {
              if (data[(y * width + x) * 4 + 3] > 20) {
                n += 1;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
              }
            }
          }
          return { n, span: n ? maxX - minX : 0 };
        };
        const fire = (name, x, y, buttons) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 4, clientX: r.left + x, clientY: r.top + y, pressure: 0.65, buttons, bubbles: true, cancelable: true }));
        fire('pointerdown', 20, 36, 1);
        fire('pointermove', 36, 36, 1);
        const predicted = pad.dataset.predicted;
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const during = span();
        fire('pointerup', 36, 36, 0);
        const after = { ...span(), points: Number(c.dataset.points), strokes: Number(c.dataset.strokes), predicted: pad.dataset.predicted };
        PointerEvent.prototype.getCoalescedEvents = origC;
        PointerEvent.prototype.getPredictedEvents = origP;
        return { predicted, during, after };
      });
      assert.equal(measured.predicted, '1', 'the tail is shown before the real sample replaces it');
      assert.ok(measured.during.n > 0, 'ink is on the canvas');
      assert.ok(measured.during.span > measured.after.span + 30, 'the predicted tail is longer than the committed stroke');
      assert.equal(measured.after.predicted, '0');
      assert.equal(measured.after.strokes, 1);
      assert.ok(measured.after.points >= 3, 'coalesced samples were not dropped');
      assert.ok(measured.after.n > 0, 'the committed stroke is still drawn');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'a hovering pen shows a dot and a finger or mouse does not',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Hover', 'dot']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor();
      await page.waitForFunction(() => document.querySelector('.ink-overlay')?.width > 0);
      const hover = (type, buttons = 0) => page.evaluate(({ type: t, buttons: b }) => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        c.dispatchEvent(new PointerEvent('pointermove', { pointerType: t, pointerId: 11, buttons: b, clientX: r.left + 48, clientY: r.top + 48, pressure: 0, bubbles: true }));
        return c.closest('.ink-pad').dataset.hover;
      }, { type, buttons });
      assert.equal(await hover('mouse'), '0');
      assert.equal(await hover('touch'), '0');
      assert.equal(await hover('pen'), '1');
      const dot = await page.evaluate(() => {
        const o = document.querySelector('.ink-overlay');
        const ctx2 = o.getContext('2d');
        const { data } = ctx2.getImageData(0, 0, o.width, o.height);
        return data.some((v, i) => i % 4 === 3 && v > 0);
      });
      assert.equal(dot, true, 'the preview dot is painted');
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0', 'hover is not a stroke');
      await page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        c.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'pen', pointerId: 11, bubbles: true }));
      });
      assert.equal(await page.getAttribute('.ink-pad', 'data-hover'), '0');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'pencil only and a remembered pen ignore palms, and a pen stroke ignores other pointers',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await page.evaluate(() => { location.hash = '#/settings/study'; });
      const pencilOnly = page.getByRole('switch', { name: 'Pencil only' });
      await pencilOnly.waitFor();
      // The switch track sits over the input; a DOM click still toggles it.
      await pencilOnly.evaluate((el) => el.click());
      assert.equal(await page.evaluate(() => localStorage.getItem('axon-pencil-only')), '1');
      await seedDeck(page, { cards: [['Palm', 'off']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor();
      await stroke(page, { type: 'touch', id: 2 });
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0', 'Pencil only ignores touch before any pen');
      await stroke(page, { type: 'mouse', id: 3 });
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '1', 'a mouse still draws');
      await page.getByRole('button', { name: 'Clear' }).click();
      const joined = await page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, id, type, x, buttons) => c.dispatchEvent(new PointerEvent(name, { pointerType: type, pointerId: id, clientX: r.left + x, clientY: r.top + 40, pressure: 0.7, buttons, bubbles: true, cancelable: true }));
        fire('pointerdown', 1, 'pen', 20, 1);
        fire('pointerdown', 2, 'touch', 80, 1);
        fire('pointermove', 2, 'touch', 90, 1);
        fire('pointermove', 1, 'pen', 50, 1);
        fire('pointerup', 1, 'pen', 50, 0);
        return { strokes: c.dataset.strokes, penSeen: c.closest('.ink-pad').dataset.penSeen };
      });
      assert.equal(joined.strokes, '1', 'a touch during a pen stroke is not a second stroke');
      assert.equal(joined.penSeen, '1');
      assert.equal(await page.evaluate(() => localStorage.getItem('axon-pen-seen')), '1');
      await page.evaluate(() => localStorage.setItem('axon-pencil-only', '0'));
      await page.reload();
      await waitReady(page);
      await page.waitForTimeout(300);
      if (!(await page.locator('.study').count())) await page.getByRole('button', { name: /Start review|Resume/ }).first().click();
      await waitPhase(page, ['question']);
      await page.locator('.ink-canvas').waitFor({ state: 'visible' });
      await stroke(page, { type: 'touch', id: 8 });
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0', 'a palm is ignored from the first stroke of the next session');
      assert.equal(await page.getAttribute('.ink-pad', 'data-pen-seen'), '1');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'the eraser removes a whole stroke and undo puts it back',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Erase', 'undo']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor();
      await stroke(page, { dy: 0 });
      await stroke(page, { id: 8, dy: 90 });
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '2');
      await page.getByRole('button', { name: 'Eraser' }).click();
      assert.equal(await page.getAttribute('.ink-pad button:has-text("Eraser")', 'aria-pressed'), 'true');
      await stroke(page, { id: 9, dy: 0 });
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '1', 'only the stroke under the eraser goes');
      await page.getByRole('button', { name: 'Undo stroke' }).click();
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '2', 'undo restores the erased stroke');
      await page.getByRole('button', { name: 'Clear' }).click();
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0');
      assert.equal(await page.locator('button:has-text("Undo stroke")').isDisabled(), true);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'a wide ink screen puts the pad beside the prompt and a phone width does not scroll',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 1100, height: 700 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Landscape prompt', 'side']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor();
      const wide = await page.evaluate(() => {
        const prompt = document.querySelector('#study-prompt').getBoundingClientRect();
        const pad = document.querySelector('.ink-canvas').getBoundingClientRect();
        const study = document.querySelector('.study');
        const overflow = [...study.querySelectorAll('*')].filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.right > window.innerWidth + 1;
        }).slice(0, 3).map((el) => `${el.tagName}.${[...el.classList].join('.')}`);
        return { promptRight: prompt.right, padLeft: pad.left, padH: pad.height, doc: document.documentElement.scrollWidth <= window.innerWidth + 1, study: study.scrollWidth <= study.clientWidth + 1, overflow };
      });
      assert.ok(wide.padLeft >= wide.promptRight - 8, `pad ${wide.padLeft} should sit to the right of the prompt ${wide.promptRight}`);
      assert.ok(wide.padH >= 280, `pad height ${wide.padH}`);
      assert.equal(wide.doc, true);
      assert.equal(wide.study, true);
      assert.deepEqual(wide.overflow, []);
      await page.setViewportSize({ width: 320, height: 640 });
      await page.waitForTimeout(100);
      const narrow = await page.evaluate(() => {
        const prompt = document.querySelector('#study-prompt').getBoundingClientRect();
        const pad = document.querySelector('.ink-canvas').getBoundingClientRect();
        const study = document.querySelector('.study');
        const overflow = [...study.querySelectorAll('*')].filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.right > window.innerWidth + 1;
        }).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(box.right)}`);
        return { stacked: pad.top >= prompt.top, doc: document.documentElement.scrollWidth <= window.innerWidth + 1, study: study.scrollWidth <= study.clientWidth + 1, overflow };
      });
      assert.equal(narrow.stacked, true, 'a phone keeps the stacked layout');
      assert.equal(narrow.doc, true, narrow.overflow.join(', '));
      assert.equal(narrow.study, true, narrow.overflow.join(', '));
      assert.deepEqual(narrow.overflow, [], narrow.overflow.join(', '));
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'skip retyping a handwritten miss records a bypassed copy and no second review',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Copy', 'once'], ['Next', 'card']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await stroke(page);
      await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
      await waitPhase(page, ['grading']);
      await page.getByRole('button', { name: /^Not correct/ }).click();
      assert.equal(await waitPhase(page, ['retype']), 'retype');
      await page.getByRole('button', { name: 'Skip retyping' }).click();
      assert.equal(await waitPhase(page, ['feedback']), 'feedback');
      const events = await idbAll(page, 'events');
      const reviews = events.filter((e) => e.type === 'review');
      const copies = events.filter((e) => e.type === 'copy');
      assert.equal(reviews.length, 1);
      assert.equal(copies.length, 1);
      assert.equal(copies[0].bypassed, true);
      assert.equal(copies[0].targetId, reviews[0].id);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'turning off retype skips the handwriting copy step',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['No retype', 'off']] });
      await inApp(page, ({ store }) => store.setGlobal({ requireRetype: false }));
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await stroke(page);
      await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
      await waitPhase(page, ['grading']);
      await page.getByRole('button', { name: /^Not correct/ }).click();
      assert.equal(await waitPhase(page, ['feedback']), 'feedback');
      assert.equal(await page.locator('.ink-canvas').isVisible(), false);
      const events = await idbAll(page, 'events');
      assert.equal(events.filter((e) => e.type === 'review').length, 1);
      assert.equal(events.filter((e) => e.type === 'copy').length, 0);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'a missed ink card traces the correct handwriting on the pad, and that trace is not a second review',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await inApp(page, async ({ store, app, model }) => {
        const c = document.createElement('canvas');
        c.width = 120;
        c.height = 48;
        const g = c.getContext('2d');
        g.fillStyle = '#f6f3ee';
        g.fillRect(0, 0, 120, 48);
        g.strokeStyle = '#1c1917';
        g.lineWidth = 6;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(12, 34);
        g.quadraticCurveTo(60, 4, 108, 34);
        g.stroke();
        const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        const id = await store.putMedia(blob, { name: 'handwritten-answer.png' });
        const deck = await store.createDeck({ name: 'Ink recall' });
        await store.saveCard(model.createCard({
          deckId: deck.id,
          front: 'Name this curve',
          back: `![Handwritten answer](axon-media:${id})`,
          media: [id],
        }, store.deviceId));
        await app.cache.load();
      });
      await startReview(page);
      await page.locator('.ink-canvas').waitFor();
      await stroke(page);
      await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
      await waitPhase(page, ['grading']);
      await page.getByRole('button', { name: /^Not correct/ }).click();
      assert.equal(await waitPhase(page, ['retype']), 'retype');
      await page.getByText('Trace the correct answer once').first().waitFor();
      await page.waitForFunction(() => {
        const c = document.querySelector('.ink-canvas');
        if (!c?.width) return false;
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let m = 0;
        for (let i = 3; i < data.length; i += 8) if (data[i] > m) m = data[i];
        return m > 24 && c.dataset.strokes === '0';
      });
      const fitted = await page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const dpr = c.width / r.width;
        const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        let minX = width;
        let maxX = 0;
        let minY = height;
        let maxY = 0;
        for (let y = 0; y < height; y += 2) {
          for (let x = 0; x < width; x += 2) {
            if (data[(y * width + x) * 4 + 3] > 24) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        return {
          w: (maxX - minX) / dpr,
          cx: ((minX + maxX) / 2) / dpr,
          padW: r.width,
          ghost: c.closest('.ink-pad').dataset.ghost,
        };
      });
      assert.equal(fitted.ghost, '1', 'the model is on the empty page');
      assert.ok(fitted.w < fitted.padW * 0.5, `the model stays near the size it was written (${fitted.w.toFixed(0)}px on a ${fitted.padW.toFixed(0)}px pad)`);
      assert.ok(Math.abs(fitted.cx - fitted.padW / 2) < fitted.padW * 0.12, 'the model sits in the writing area');
      await stroke(page, { id: 8, dy: 20 });
      assert.equal(await page.getAttribute('.ink-pad', 'data-ghost'), 'lift', 'ink lifts the model so the new stroke is the mark');
      await page.getByRole('button', { name: 'Undo stroke' }).click();
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0');
      assert.equal(await page.getAttribute('.ink-pad', 'data-ghost'), '1', 'undoing back to an empty page brings the model back');
      await stroke(page, { id: 8, dy: 20 });
      await page.getByRole('button', { name: 'Done' }).click();
      assert.equal(await waitPhase(page, ['question', 'done']), 'question', 'a miss comes back later; the trace was not a second review');
      const events = await idbAll(page, 'events');
      assert.equal(events.filter((e) => e.type === 'review').length, 1);
      assert.equal(events.filter((e) => e.type === 'copy' && !e.bypassed).length, 1);
      assert.equal(events.find((e) => e.type === 'review').response.method, 'self');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'a palm-sized touch or a second finger does not start a stroke, and one finger still does',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Palm', 'size']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      await page.locator('.ink-canvas').waitFor();
      const touch = (extra) => page.evaluate((opts) => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, x) => c.dispatchEvent(new PointerEvent(name, {
          pointerType: 'touch',
          pointerId: opts.id,
          isPrimary: opts.primary,
          width: opts.w,
          height: opts.h,
          clientX: r.left + x,
          clientY: r.top + 40,
          pressure: name === 'pointerup' ? 0 : 0.5,
          buttons: name === 'pointerup' ? 0 : 1,
          bubbles: true,
          cancelable: true,
        }));
        fire('pointerdown', 24);
        fire('pointermove', 70);
        fire('pointerup', 70);
        return c.dataset.strokes;
      }, extra);
      assert.equal(await touch({ id: 2, primary: true, w: 140, h: 90 }), '0', 'a palm-sized contact is ignored before any pen');
      assert.equal(await touch({ id: 3, primary: false, w: 18, h: 18 }), '0', 'a second finger is ignored');
      assert.equal(await touch({ id: 4, primary: true, w: 16, h: 16 }), '1', 'one finger still writes');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
