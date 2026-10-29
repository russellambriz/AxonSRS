// Study-session behaviour around a single answer: finishing the retype step,
// announcing grade explanations, abandoned attempts, next-day sibling
// deferral and focus-timer time.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, inApp, startReview, answerFromMap, waitPhase, phase, waitReady, assertNoErrors } from './harness.mjs';

const liveText = (page, id) => page.evaluate((i) => document.getElementById(i)?.textContent || '', id);

/** One stroke on the handwriting pad (synthetic Apple Pencil, finger or palm). */
const stroke = (page, { type = 'pen', id = 7 } = {}) => page.evaluate(({ type: t, id: pid }) => {
  const c = document.querySelector('.ink-canvas');
  const r = c.getBoundingClientRect();
  const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, { pointerType: t, pointerId: pid, isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: name === 'pointerup' ? 0 : 0.6, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  fire('pointerdown', 30, 30);
  fire('pointermove', 70, 50);
  fire('pointermove', 120, 40);
  fire('pointerup', 120, 40);
}, { type, id });

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
      await page.getByText('Check your answer', { exact: true }).waitFor();
      await page.getByRole('img', { name: 'Your handwritten answer' }).waitFor();
      assert.ok((await page.textContent('.feedback .answer')).trim().length > 0, 'the correct answer is shown to compare');
      await page.getByRole('button', { name: /^Again/ }).click();
      assert.equal(await waitPhase(page, ['feedback']), 'feedback', 'no retype step with the pad');
      await page.getByText('You marked it wrong').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Mark correct' }).count(), 0, 'no overrides on a self-graded answer');
      let reviews = (await idbAll(page, 'events')).filter((e) => e.type === 'review');
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].rating, 1);
      assert.equal(reviews[0].response.correct, false);
      assert.equal(reviews[0].response.method, 'self');
      assert.equal(reviews[0].modality.kind, 'handwriting');
      assert.equal(reviews[0].grading.mode, 'manual');
      assert.ok(reviews[0].grading.measurements.raw.latencyMs > 0, 'latency runs to the first stroke');
      await page.getByRole('button', { name: /^Continue/ }).click();
      await waitPhase(page, ['question']);
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0', 'a fresh pad for the next card');
      await stroke(page);
      await page.keyboard.press('Enter');
      await waitPhase(page, ['grading']);
      await page.getByRole('button', { name: /^Good/ }).click();
      await waitPhase(page, ['feedback']);
      await page.getByText('You marked it right').waitFor();
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
];
