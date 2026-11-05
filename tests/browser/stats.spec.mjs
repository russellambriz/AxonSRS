// Spec 8, 16.4, 16.x (rescue and undo): statistics, home counts and exam
// plans treat undone and rescued reviews consistently; per-deck weekly
// trends, latency over time, confidence self-ratings and weak topics.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SHOTS, newContext, openApp, seedDeck, inApp, assertNoErrors } from './harness.mjs';

const CARDS = [
  ['Powerhouse of the cell', 'Mitochondria', { tags: ['bio', 'cell'] }],
  ['Site of protein synthesis', 'Ribosome', { tags: ['bio', 'cell'] }],
  ['Control centre of the cell', 'Nucleus', { tags: ['bio', 'cell'] }],
  ['Unit of heredity', 'Gene', { tags: ['bio', 'genetics'] }],
  ['Molecule carrying the genetic code', 'DNA', { tags: ['bio', 'genetics'] }],
  ['Base that pairs with adenine in DNA', 'Thymine', { tags: ['bio', 'genetics'] }],
];

/** Run `fn(ctx, arg)` in the page with review planning helpers and the seeded deck. */
function withHistory(page, fn, arg = null) {
  return inApp(page, async ({ store, app }, a) => {
    const load = (p) => import(new URL(p, location.href).href);
    const review = await load('./js/core/review.js');
    const deck = [...app.cache.decks.values()][0];
    const params = store.paramsFor(deck);
    const trial = (text, latencyMs) => ({
      raw: { latencyMs, typingMs: 1200, totalMs: latencyMs + 1200, activeMs: latencyMs + 1200, effort: text.length, answerLength: text.length, corrections: 0, pauses: 0, longestGapMs: 300, hiddenMs: 0, origins: { typed: text.length } },
      responseText: text, modality: { kind: 'physical', confidence: 0.9 }, prompt: { words: 5, mathTokens: 0, images: 0, chars: 30 }, assistance: { hintShown: false, revealed: false, solutionViewed: false }, isWarmup: false,
    });
    const ctx = {
      store, app, deck, review, DAY: 86400000,
      units: () => [...app.cache.units.values()].filter((u) => u.deckId === deck.id).sort((x, y) => (x.id < y.id ? -1 : 1)),
      card: (u) => app.cache.cards.get(u.cardId),
      async answer(unit, text, at, sessionId, latencyMs = 1500) {
        const card = app.cache.cards.get(unit.cardId);
        const match = review.evaluateAnswer(card, deck, unit.key, text);
        const plan = review.planReview({ eventId: crypto.randomUUID(), now: at, deviceId: store.deviceId, seq: null, sessionId, mode: 'daily', live: true, unit, card, deck, trial: trial(text, latencyMs), match, baseline: null, params, studyDay: store.today(at), timeZone: store.timeOptions().timeZone, gradeMode: 'auto', manualRating: null, research: null, firstAttempt: true });
        await store.commitReview(plan);
        app.cache.units.set(unit.id, { ...unit, ...plan.unit });
        return plan.event;
      },
      async correct(planner, target, extra = {}) {
        const unit = app.cache.units.get(target.unitId);
        const unitEvents = await store.eventsForUnit(unit.id);
        const plan = planner({ eventId: crypto.randomUUID(), now: Date.now(), deviceId: store.deviceId, seq: null, target, unit, unitEvents, studyDay: store.today(), ...extra });
        await store.commitCorrection(plan, { expectedHead: unit.headEventId });
        await app.cache.load();
        return plan.event;
      },
    };
    // eslint-disable-next-line no-new-func
    const f = new Function(`return (${a.src})`)();
    return f(ctx, a.arg);
  }, { src: fn.toString(), arg });
}

const kpiValue = (page, label) => page.locator('.stat', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).locator('.value').first().textContent();

async function goto(page, hash, heading) {
  await page.evaluate((x) => { location.hash = x; }, hash);
  await page.getByRole('heading', { name: heading }).first().waitFor();
}

export const tests = [
  {
    name: 'undone reviews leave home and statistics; rescued answers count as correct; trends, latency, self-ratings and weak topics are shown',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { name: 'Biology', cards: CARDS });
      const today = await withHistory(page, async ({ units, card, answer, DAY, store, app }, answers) => {
        const now = Date.now();
        const start = app.timeCtx().dayStart; // past reviews at 06:00-ish of their study day
        for (const [k, days] of [[0, 15], [1, 8], [2, 1]]) {
          for (const [i, u] of units().entries()) {
            const c = card(u);
            const wrong = k === 2 && c.tags.includes('genetics');
            await answer(app.cache.units.get(u.id), wrong ? 'no idea' : answers[c.front[0]], start - days * DAY + 6 * 3600000 + i * 60000, `past-${k}`, 1000 + 400 * i + 300 * k);
          }
        }
        const powerhouse = units().find((u) => card(u).front[0].startsWith('Powerhouse'));
        const ev = await answer(powerhouse, 'Mitochondria', now, 'today');
        await app.cache.load();
        return { reviewId: ev.id, day: store.today() };
      }, Object.fromEntries(CARDS.map(([front, back]) => [front, back])));

      // Home counts today's review, and the streak includes today.
      await goto(page, '#/decks', 'Decks');
      await goto(page, '#/', /Good (morning|afternoon|evening|night)/);
      assert.equal(await kpiValue(page, 'Reviewed today'), '1');
      assert.equal(await kpiValue(page, 'Streak'), '2 days');

      // Undo it: the cached activity summary must drop it too.
      await withHistory(page, async ({ review, correct, store }, id) => {
        const target = (await store.allEvents()).find((e) => e.id === id);
        await correct(review.planUndo, target);
      }, today.reviewId);
      await goto(page, '#/decks', 'Decks');
      await goto(page, '#/', /Good (morning|afternoon|evening|night)/);
      assert.equal(await kpiValue(page, 'Reviewed today'), '0', 'an undone review is not a review today');
      assert.equal(await kpiValue(page, 'Streak'), '1 day', 'a day whose only review was undone does not extend the streak');

      // A failed genetics answer rescued with an alias, rated 4 of 5.
      await withHistory(page, async ({ units, card, answer, review, correct, store, app }) => {
        const gene = units().find((u) => card(u).front[0].startsWith('Unit of heredity'));
        const failed = await answer(gene, 'Cistron', Date.now(), 'today-2');
        await correct(review.planOverride, failed, { kind: 'alias', alias: 'Cistron' });
        const unit = app.cache.units.get(gene.id);
        await store.addEvents([review.exposureEvent({ id: crypto.randomUUID(), type: 'self-rating', now: Date.now(), deviceId: store.deviceId, seq: null, unit, card: card(unit), sessionId: 'today-2', studyDay: store.today(), data: { targetId: failed.id, value: 4 } })]);
        await store.savePlan({ name: 'Biology final', examDate: (await import(new URL('./js/core/time.js', location.href).href)).addDays(store.today(), 20), deckIds: [unit.deckId], tags: ['bio'], dailyMinutes: 30, targetCoverage: 1 });
        await app.cache.load();
      });
      await goto(page, '#/decks', 'Decks');
      await goto(page, '#/', /Good (morning|afternoon|evening|night)/);
      assert.equal(await kpiValue(page, 'Reviewed today'), '1');
      assert.equal(await kpiValue(page, 'Streak'), '2 days');

      await goto(page, '#/stats', 'Statistics');
      assert.equal(await kpiValue(page, 'Reviewed today'), '1');
      const accuracy = page.locator('.chart-block', { has: page.getByRole('heading', { name: 'Accuracy over time' }) });
      await accuracy.getByRole('button', { name: 'Table' }).click();
      const headers = await accuracy.locator('thead th').allTextContents();
      const rows = await accuracy.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
      const current = rows[rows.length - 1];
      // Yesterday's six reviews (three missed) share this week unless today is a Monday.
      const monday = new Date(`${today.day}T12:00:00Z`).getUTCDay() === 1;
      assert.equal(current[headers.indexOf('Rescued')], '1', 'the rescue is reported');
      assert.equal(current[headers.indexOf('Reviews')], monday ? '1' : '7', 'the undone review is not counted');
      assert.equal(current[headers.indexOf('Independent correct')], monday ? '100%' : '57%', 'the rescued answer counts as correct');
      const trends = page.locator('section', { has: page.getByRole('heading', { name: 'Per-deck trends (8 weeks)' }) });
      assert.equal(await trends.locator('thead th').count(), 10, 'deck, 8-week total and eight week columns');
      assert.match(await trends.locator('tbody tr').first().textContent(), /Biology/);
      assert.ok(await trends.locator('tbody td', { hasText: /%/ }).count() >= 4, 'weeks with reviews show their accuracy');
      await page.getByRole('heading', { name: 'Retrieval latency over time' }).waitFor();
      await page.getByText('Average (mean) first-keystroke latency').waitFor();
      const ratings = page.locator('section', { has: page.getByRole('heading', { name: 'Confidence after feedback (older versions)' }) });
      assert.match(await ratings.textContent(), /1 answer rated\. Mean rating 4\.0 when the answer was correct\./);
      assert.match(await ratings.locator('tbody tr').first().textContent(), /^4 of 51100%.*3\.0 \(Good\)/, 'the rescue is compared with its re-grade');
      await page.screenshot({ path: join(SHOTS, 'stats-history.png'), fullPage: true });

      await goto(page, '#/plans', 'Exam plans');
      assert.equal(await kpiValue(page, 'Weak topics'), '1');
      const weak = page.locator('div.stack', { has: page.getByRole('heading', { name: 'Weak topics' }) });
      assert.match(await weak.locator('tbody').textContent(), /^genetics/, 'the weak topic is named; the plan’s own tag is not a topic');
      assert.match(await page.locator('main').textContent(), /reviews? the schedule asks for before the exam/);
      await page.screenshot({ path: join(SHOTS, 'plans-weak-topics.png'), fullPage: true });

      // Phone width: the new tables scroll inside their wrapper, never the page.
      await page.setViewportSize({ width: 390, height: 844 });
      for (const [hash, heading] of [['#/plans', 'Exam plans'], ['#/stats', 'Statistics']]) {
        await goto(page, hash, heading);
        await page.getByRole('heading', { name: hash === '#/stats' ? 'Per-deck trends (8 weeks)' : 'Weak topics' }).first().waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${hash}: no horizontal page scroll`);
        await page.screenshot({ path: join(SHOTS, `${hash.slice(2)}-history-phone.png`), fullPage: true });
      }
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
