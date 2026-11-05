// Chunk 1 grading behaviour on the real study screen (docs/chunk-1-plan.md).
// Test ids refer to the acceptance matrix in the Chunk 1 prompt (§14).
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, startReview, answer, waitPhase, phase, promptText, waitReady, assertNoErrors } from './harness.mjs';

const CAPITALS = [['Capital of Peru', 'Lima', { hint: 'Starts with L' }], ['Capital of Chile', 'Santiago', { hint: 'Starts with S' }], ['Capital of Spain', 'Madrid', { hint: 'Starts with M' }]];
const ANSWERS = { Peru: 'Lima', Chile: 'Santiago', Spain: 'Madrid' };
async function expected(page) {
  const p = await promptText(page);
  return ANSWERS[Object.keys(ANSWERS).find((k) => p.includes(k))];
}
const reviews = async (page) => (await idbAll(page, 'events')).filter((e) => e.type === 'review' || e.type === 'practice').sort((a, b) => a.ts - b.ts);

export const tests = [
  {
    name: 'T25/T26/T03/T04 confidence is optional, captured before feedback, and a guess is not recall',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: CAPITALS });
      await startReview(page);
      // Unsure + correct: still a success.
      await page.getByRole('button', { name: 'Unsure' }).click();
      assert.equal(await page.getAttribute('.confidence-pick button[aria-pressed="true"]', 'title'), 'I recalled an answer but I doubt it.');
      assert.equal(await answer(page, await expected(page)), 'feedback');
      assert.equal(await page.locator('.confidence-pick').isVisible(), false, 'confidence is not asked again after feedback');
      let [ev] = await reviews(page);
      assert.deepEqual([ev.outcome.confidence, ev.outcome.confidenceTiming, ev.outcome.class, ev.rating], ['unsure', 'pre-feedback', 'success', 3]);
      await page.keyboard.press('Enter');
      await waitPhase(page, ['question']);
      // Nothing chosen: confidence stays unknown, never "confident".
      assert.equal(await page.locator('.confidence-pick button[aria-pressed="true"]').count(), 0, 'reset for each card');
      assert.equal(await answer(page, await expected(page)), 'feedback');
      ev = (await reviews(page)).at(-1);
      assert.equal(ev.outcome.confidence, null);
      assert.equal(ev.outcome.retrieval, 'unknown');
      await page.keyboard.press('Enter');
      await waitPhase(page, ['question']);
      // Guessing + literally correct: not recall.
      await page.getByRole('button', { name: 'Guessing' }).click();
      assert.equal(await answer(page, await expected(page)), 'feedback');
      await page.getByText('Guessed, not counted as recalled', { exact: true }).waitFor();
      ev = (await reviews(page)).at(-1);
      assert.equal(ev.response.correct, true);
      assert.equal(ev.outcome.class, 'guessed');
      assert.equal(ev.rating, 1);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'T13/T16/T19 hints, "I don\'t know" and skip: help is recorded once, never as independent recall',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: CAPITALS });
      await startReview(page);
      await page.getByRole('button', { name: 'Hint' }).click();
      await page.locator('.hint-box').waitFor();
      await page.keyboard.press('Alt+KeyH');
      assert.equal(await answer(page, await expected(page)), 'feedback');
      await page.getByText('Answered with help', { exact: true }).waitFor();
      let all = await reviews(page);
      assert.equal(all.length, 1, 'two hint taps, one review');
      assert.equal(all[0].outcome.class, 'assisted');
      assert.equal(all[0].rating, 1);
      assert.equal((await idbAll(page, 'events')).filter((e) => e.type === 'hint').length, 1, 'the second tap shows nothing new');
      await page.keyboard.press('Enter');
      await waitPhase(page, ['question']);
      // Skip: no outcome invented.
      await page.getByRole('button', { name: 'Skip' }).click();
      await waitPhase(page, ['question']);
      all = await reviews(page);
      assert.equal(all.length, 1, 'skip is not a review');
      // New card: "Show answer" is first learning, not a lapse.
      await page.getByRole('button', { name: 'Show answer' }).click();
      assert.equal(await waitPhase(page, ['feedback', 'retype']).then(() => phase(page)) !== 'question', true);
      await page.getByText('New card — study the answer', { exact: true }).waitFor();
      const dk = (await reviews(page)).at(-1);
      assert.equal(dk.outcome.class, 'dont-know');
      assert.equal(dk.outcome.phase, 'new');
      assert.equal(dk.rating, 1);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'T05/T06 an unreadable maths answer is not graded: edit the notation, or compare and check it yourself',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { settings: { answerMode: 'math' }, cards: [['d/dx of x^2 + 2x', '2x+2'], ['d/dx of x^3', '3x^2']] });
      await startReview(page);
      const p = await promptText(page);
      const good = p.includes('x^3') ? '3x^2' : '2x+2';
      assert.equal(await answer(page, '2x+'), 'unresolved');
      await page.getByText('Needs your check', { exact: true }).waitFor();
      assert.equal(await page.locator('.feedback .answer').count(), 0, 'the answer is not shown');
      assert.equal((await reviews(page)).length, 0, 'nothing is graded');
      // Edit the notation: still the first, independent attempt.
      await page.getByRole('button', { name: 'Edit answer' }).click();
      assert.equal(await phase(page), 'question');
      assert.equal(await page.inputValue('.answer-input'), '2x+', 'the draft is kept');
      assert.equal(await answer(page, good), 'feedback');
      let ev = (await reviews(page)).at(-1);
      assert.equal(ev.outcome.class, 'success');
      assert.equal(ev.outcome.independent, true);
      assert.equal(ev.firstAttempt, true);
      assert.ok(ev.grading.measurements.excluded.some((x) => x.reason === 'NOTATION_REPAIRED') || ev.grading.reasons.includes('TIMING_UNRELIABLE'), 'timing after a repair is not used');
      await page.keyboard.press('Enter');
      await waitPhase(page, ['question']);
      // Compare instead: the learner's own check, with that provenance.
      assert.equal(await answer(page, '3x^'), 'unresolved');
      await page.getByRole('button', { name: 'Compare with the answer' }).click();
      assert.equal(await waitPhase(page, ['grading']), 'grading');
      await page.locator('.feedback .answer').waitFor();
      await page.getByRole('button', { name: /^Correct on my own/ }).click();
      await waitPhase(page, ['feedback']);
      ev = (await reviews(page)).at(-1);
      assert.equal(ev.outcome.provenance, 'self');
      assert.equal(ev.response.unresolved, true);
      assert.equal(ev.response.text, '3x^');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'after an independent success: "Took effort", "It was easy" and "I guessed without remembering" are single, explicit corrections',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: CAPITALS });
      await startReview(page);
      assert.equal(await answer(page, await expected(page)), 'feedback');
      await page.getByRole('button', { name: 'Took effort' }).click();
      await page.getByText(/with effort \(Hard\)/).waitFor();
      let corr = (await idbAll(page, 'events')).filter((e) => e.type === 'correction');
      assert.equal(corr.length, 1);
      assert.equal(corr[0].newRating, 2);
      assert.equal(await page.getByRole('button', { name: 'It was easy' }).count(), 0, 'one correction per review');
      await page.keyboard.press('Enter');
      await waitPhase(page, ['question']);
      assert.equal(await answer(page, await expected(page)), 'feedback');
      await page.getByRole('button', { name: 'I guessed without remembering' }).click();
      await page.getByText('Guessed, not counted as recalled', { exact: true }).waitFor();
      corr = (await idbAll(page, 'events')).filter((e) => e.type === 'correction').sort((a, b) => a.ts - b.ts);
      assert.equal(corr.at(-1).newRating, 1);
      assert.equal(corr.at(-1).outcome.class, 'guessed');
      assert.equal(await page.getByRole('button', { name: 'I knew that' }).count(), 0, 'the ambiguous override is gone');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'T37/T38 a double tap on a self-check records one review; a reload while the answer is showing restores it as practice',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 820, height: 1180 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: CAPITALS });
      await startReview(page);
      await page.getByRole('button', { name: 'Write' }).click();
      const stroke = () => page.evaluate(() => {
        const c = document.querySelector('.ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, { pointerType: 'pen', pointerId: 3, isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: name === 'pointerup' ? 0 : 0.5, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
        fire('pointerdown', 30, 30); fire('pointermove', 90, 50); fire('pointerup', 90, 50);
      });
      await stroke();
      await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
      await waitPhase(page, ['grading']);
      await page.getByRole('button', { name: /^Correct on my own/ }).dblclick();
      await waitPhase(page, ['feedback']);
      assert.equal((await reviews(page)).length, 1, 'one review from a double tap');
      await page.getByRole('button', { name: /^Continue/ }).click();
      await waitPhase(page, ['question']);
      await stroke();
      await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
      await waitPhase(page, ['grading']);
      const session = (await idbAll(page, 'sessions'))[0];
      const shown = session.queue[session.index];
      assert.ok(session.exposed?.[shown], 'the shown answer is remembered before any grade');
      await page.reload();
      await waitReady(page);
      await page.waitForTimeout(300);
      if (!(await page.locator('.study').count())) await page.getByRole('button', { name: /Start review|Resume/ }).first().click();
      await waitPhase(page, ['question']);
      await page.getByText('Practice · answer seen').waitFor();
      assert.equal((await reviews(page)).length, 1, 'nothing was recorded for the interrupted check');
      await stroke();
      await page.getByRole('button', { name: 'Check your handwritten answer' }).click();
      await waitPhase(page, ['grading']);
      assert.equal(await page.getByRole('button', { name: /^Correct on my own/ }).count(), 0, 'no independent success after the answer was seen');
      await page.getByRole('button', { name: /^Correct with help/ }).click();
      await waitPhase(page, ['feedback', 'retype']);
      const ev = (await reviews(page)).at(-1);
      assert.equal(ev.type, 'practice');
      assert.equal(ev.assistance.priorExposure, true);
      assert.equal(ev.outcome.class, 'assisted');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];

