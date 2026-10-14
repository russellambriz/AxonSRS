// End-to-end UI flows: the import wizard with duplicate handling, alias
// rescue and undo on the study screen, cram practice that leaves the
// schedule alone, and in-session editing without losing one's place.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, inApp, startReview, answer, waitPhase, phase, promptText, assertNoErrors } from './harness.mjs';

export const tests = [
  {
    name: 'import wizard: paste, detect, preview duplicates, import, keep existing history and unrecognised lines',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { acceptDownloads: true });
      const page = await openApp(ctx, url);
      const deckId = await seedDeck(page, { name: 'Ions', settings: { answerMode: 'chem' }, cards: [['Sulfate', 'SO4^2-']] });
      await startReview(page);
      assert.equal(await answer(page, 'SO4^2-'), 'feedback'); // history to preserve
      const before = (await idbAll(page, 'units'))[0];
      await page.evaluate(() => { location.hash = '#/import'; });
      await page.getByLabel('Text to import').fill('Sulfate\tSO4^2-\nNitrate\tNO3^-\nNitrate\tNO3^-\nAmmonium\tNH4^+\nPhosphate PO4^3- (no separator)');
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByText(/Detected: /).waitFor();
      await page.getByLabel('Target deck').selectOption(deckId);
      await page.getByText(/card drafts? found/).waitFor();
      const summary = await page.getByText(/card drafts? found/).textContent();
      assert.match(summary, /^4 card drafts found · 0 with problems · 2 duplicates · 1 line not recognised/, summary);
      await page.getByRole('button', { name: 'Preview' }).click();
      await page.getByText('2 duplicates', { exact: true }).waitFor();
      await page.getByText('1 unrecognised line', { exact: true }).waitFor();
      await page.getByText('Already in your collection').waitFor();
      await page.getByText('Duplicate within this import').waitFor();
      await page.getByText('Not recognised (kept, not discarded)').waitFor();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByText('Ready to import').waitFor();
      const importBtn = page.getByRole('button', { name: /^Import \d+ cards?$/ });
      assert.equal(await importBtn.textContent(), 'Import 2 cards');
      const dl = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      assert.ok((await (await dl).path()), 'skipped/unrecognised lines can be downloaded');
      await importBtn.click();
      await page.getByRole('heading', { name: 'Imported 2 cards' }).waitFor();
      const cards = await idbAll(page, 'cards');
      assert.deepEqual(cards.map((c) => c.front[0]).sort(), ['Ammonium', 'Nitrate', 'Sulfate']);
      const after = (await idbAll(page, 'units')).find((u) => u.id === before.id);
      assert.deepEqual(after.state, before.state, 'the existing card kept its schedule');
      assert.equal((await idbAll(page, 'events')).filter((e) => e.type === 'review').length, 1);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'study screen: “Mark correct & save as alias” replaces the failure once; Undo reverses the review but keeps the alias',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Largest planet', 'Jupiter'], ['Smallest planet', 'Mercury']] });
      await startReview(page);
      const isLargest = (await promptText(page)).includes('Largest');
      const typed = isLargest ? 'Iuppiter' : 'Hermes';
      assert.equal(await answer(page, typed), 'retype');
      await page.keyboard.press('Alt+KeyA');
      assert.equal(await waitPhase(page, ['feedback']), 'feedback', 'retyping bypassed');
      let [card] = (await idbAll(page, 'cards')).filter((c) => c.front[0].startsWith(isLargest ? 'Largest' : 'Smallest'));
      assert.ok(card.back.includes(typed), 'alias saved on the card');
      const events = await idbAll(page, 'events');
      const review = events.find((e) => e.type === 'review');
      const correction = events.find((e) => e.type === 'correction');
      assert.equal(review.rating, 1, 'the original failure is kept in the audit history');
      assert.equal(correction.kind, 'override');
      assert.equal(correction.reason, 'alias');
      assert.equal(correction.targetId, review.id);
      let unit = (await idbAll(page, 'units')).find((u) => u.id === review.unitId);
      assert.equal(unit.state.lapses, 0);
      const session = (await idbAll(page, 'sessions'))[0];
      assert.equal(session.queue.filter((id) => id === review.unitId).length, 1, 'obsolete failure requeue removed');
      // Undo the (rescued) review.
      await page.keyboard.press('Alt+KeyZ');
      await waitPhase(page, ['question']);
      unit = (await idbAll(page, 'units')).find((u) => u.id === review.unitId);
      assert.equal(unit.state, null, 'schedule back to before the review');
      assert.ok((await idbAll(page, 'events')).some((e) => e.type === 'correction' && e.kind === 'void' && e.targetId === review.id), 'undo is a linked correction, not a deletion');
      [card] = (await idbAll(page, 'cards')).filter((c) => c.id === card.id);
      assert.ok(card.back.includes(typed), 'alias removal is separate from undo');
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'cram session records practice exposure without touching the long-term schedule',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Capital of France?', 'Paris'], ['Capital of Italy?', 'Rome']] });
      await page.evaluate(() => { location.hash = '#/study?mode=cram'; });
      await page.getByRole('button', { name: 'Start' }).click();
      await waitPhase(page, ['question']);
      const p = await promptText(page);
      assert.equal(await answer(page, p.includes('France') ? 'Paris' : 'Rome'), 'feedback');
      const events = await idbAll(page, 'events');
      assert.equal(events.filter((e) => e.type === 'practice').length, 1);
      assert.equal(events.filter((e) => e.type === 'review').length, 0);
      assert.ok((await idbAll(page, 'units')).every((u) => u.state === null), 'no FSRS state created by practice');
      await ctx.close();
    },
  },
  {
    name: 'editing the current card mid-session keeps the place, pauses timing and flags the review',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Capital of France?', 'Paris'], ['Capital of Italy?', 'Rome']] });
      await startReview(page);
      const prompt = await promptText(page);
      await page.locator('.answer-input').pressSequentially('Pa', { delay: 20 });
      await page.keyboard.press('Alt+KeyE');
      const dlg = page.locator('dialog[open]');
      await dlg.getByText('Edit card').first().waitFor();
      const hint = dlg.getByPlaceholder('Optional hint (using it caps the grade)');
      await hint.fill('Think of the Seine or the Tiber');
      await dlg.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(() => !document.querySelector('dialog[open]'));
      assert.equal(await phase(page), 'question');
      assert.equal(await promptText(page), prompt, 'same card, same place');
      const expected = prompt.includes('France') ? 'Paris' : 'Rome';
      await page.locator('.answer-input').fill(expected);
      await page.keyboard.press('Enter');
      assert.equal(await waitPhase(page, ['feedback']), 'feedback');
      const [ev] = (await idbAll(page, 'events')).filter((e) => e.type === 'review');
      assert.match(JSON.stringify(ev.grading), /EDITOR_OPENED/, 'timing flagged as interrupted by editing');
      assert.ok((await idbAll(page, 'events')).some((e) => e.type === 'edit'), 'the edit is logged as its own event');
      const [card] = (await idbAll(page, 'cards')).filter((c) => c.id === ev.cardId);
      assert.equal(card.hint, 'Think of the Seine or the Tiber');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
