// Study-session behaviour around a single answer: finishing the retype step,
// announcing grade explanations, abandoned attempts, next-day sibling
// deferral and focus-timer time.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, inApp, startReview, answerFromMap, waitPhase, assertNoErrors } from './harness.mjs';

const liveText = (page, id) => page.evaluate((i) => document.getElementById(i)?.textContent || '', id);

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
