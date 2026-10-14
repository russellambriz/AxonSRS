// Spec 12.20, 17.29: performance with a large collection — 10,000 cards
// and a long review history — measured in headless Chromium on the test
// machine (not a phone). Budgets are generous regression guards; the
// measured numbers are reported in test-results/browser-results.json.
import assert from 'node:assert/strict';
import { newContext, openApp, inApp, waitReady, waitPhase, answer, timed } from './harness.mjs';

const CARDS = 10000;
const REVIEWED = 6000; // cards with history
const REVIEWS_PER_CARD = 7; // ≈ 37,000 reviews (schedules past today stop early)
const DAY = 86400000;

/** Build and store the dataset inside the page using the app's own modules. */
function generate(page) {
  return inApp(page, async ({ store, model }, a) => {
    const base = location.href;
    const load = (p) => import(new URL(p, base).href);
    const { planReview, evaluateAnswer } = await load('./js/core/review.js');
    const { schedulerParams } = await load('./js/core/scheduler.js');
    const { stamp } = await load('./js/core/sync/versioning.js');
    const { studyDay } = await load('./js/core/time.js');
    const t0 = performance.now();
    const now = Date.now();
    const start = now - 200 * a.DAY;
    const params = schedulerParams();
    const decks = [];
    const cards = [];
    const units = [];
    const events = [];
    const revisions = [];
    const deviceId = store.deviceId;
    let seq = 0;
    let rnd = 42;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let d = 0; d < 10; d++) {
      const { record, revision } = stamp('decks', model.createDeck({ id: `deck-${d}`, name: `Deck ${d + 1}`, settings: { answerMode: d === 7 ? 'math' : d === 8 ? 'chem' : 'text' } }, deviceId), { deviceId, ts: start });
      decks.push(record);
      revisions.push(revision);
    }
    for (let i = 0; i < a.CARDS; i++) {
      const deck = decks[i % decks.length];
      const answerText = deck.settings.answerMode === 'math' ? `${i % 50}x^2 + ${i % 7}` : deck.settings.answerMode === 'chem' ? `C${(i % 9) + 1}H${(i % 13) + 2}` : `answer ${i} word${i % 11}`;
      const raw = model.createCard({ id: `card-${i}`, deckId: deck.id, front: `Prompt number ${i}: recall the term for item ${i % 997}`, back: `${answerText} | alt ${i}`, tags: [`t${i % 40}`, i % 3 ? 'core' : 'extra'], hint: i % 5 ? '' : 'think it through' }, deviceId);
      const { record, revision } = stamp('cards', raw, { deviceId, ts: start });
      cards.push(record);
      revisions.push(revision);
      let unit = { id: `${record.id}:fwd`, cardId: record.id, deckId: deck.id, key: 'fwd', state: null, headEventId: null, active: true, suspended: false, overlays: {}, perf: { recent: [] }, createdAt: start, updatedAt: start };
      if (i < a.REVIEWED) {
        let at = start + (i % 500) * 3600000;
        for (let r = 0; r < a.REVIEWS_PER_CARD && at < now; r++) {
          const ok = rand() > 0.15;
          const text = ok ? answerText : 'wrong guess';
          const match = evaluateAnswer(record, deck, 'fwd', text);
          const latency = 900 + Math.round(rand() * 2500);
          const trial = {
            raw: { latencyMs: latency, typingMs: 1200, totalMs: latency + 1200, activeMs: latency + 1200, effort: 8, answerLength: text.length, corrections: 0, pauses: 0, longestGapMs: 300, hiddenMs: 0, origins: { typed: 8 } },
            responseText: text, modality: { kind: 'physical', confidence: 0.9 }, prompt: { words: 9, mathTokens: 0, images: 0, chars: 48 }, assistance: { hintShown: false, revealed: false, solutionViewed: false }, isWarmup: false,
          };
          const plan = planReview({ eventId: `ev-${i}-${r}`, now: at, deviceId, seq: ++seq, sessionId: `s-${Math.floor(at / a.DAY)}`, mode: 'daily', live: true, unit, card: record, deck, trial, match, baseline: null, params, studyDay: studyDay(at, { timeZone: 'UTC', rolloverHour: 4 }), timeZone: 'UTC', gradeMode: 'auto', manualRating: null, research: null, firstAttempt: true });
          events.push(plan.event);
          unit = { ...unit, ...plan.unit };
          at = Math.max(at + 60000, plan.unit.state.due);
        }
      }
      units.push(unit);
    }
    const generatedMs = performance.now() - t0;
    const bytes = JSON.stringify(events.slice(0, 1000)).length / 1000;
    const t1 = performance.now();
    await store.replaceAll({ decks, cards, units, events, revisions, tombstones: [], links: [], plans: [], media: [], settings: { values: {}, updatedAt: {} } }, { reason: 'perf dataset' });
    const storedMs = performance.now() - t1;
    return { cards: cards.length, units: units.length, events: events.length, generatedMs: Math.round(generatedMs), storedMs: Math.round(storedMs), avgEventBytes: Math.round(bytes) };
  }, { CARDS, REVIEWED, REVIEWS_PER_CARD, DAY });
}

async function nav(page, hash, ready) {
  return timed(async () => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForFunction(ready.fn, ready.arg ?? null, { timeout: 60000, polling: 50 });
  });
}

export const tests = [
  {
    name: '10,000 cards with ~37,000 reviews: boot, browse, search, study, stats and backup stay responsive',
    async run({ browser, url, report }) {
      const ctx = await newContext(browser, { acceptDownloads: true });
      const page = await openApp(ctx, url);
      const gen = await generate(page);
      report('dataset', gen);
      assert.equal(gen.cards, CARDS);
      assert.ok(gen.events > 35000, `history size ${gen.events}`);

      // Cold boot with the full collection.
      const boot = await timed(async () => {
        await page.reload();
        await waitReady(page);
        await page.getByRole('button', { name: /Start review|Nothing due/ }).waitFor({ timeout: 60000 });
      });
      report('cold boot to home with counts (ms)', boot.ms);
      const boot2 = await timed(async () => {
        await page.reload();
        await waitReady(page);
        await page.getByRole('button', { name: /Start review|Nothing due/ }).waitFor({ timeout: 60000 });
      });
      report('second boot, activity summary cached (ms)', boot2.ms);

      const usage = await page.evaluate(async () => (navigator.storage?.estimate ? (await navigator.storage.estimate()).usage : null));
      report('IndexedDB usage (MB)', usage ? Math.round(usage / 1048576) : 'unknown');

      const browserOpen = await nav(page, '#/cards', { fn: () => document.querySelectorAll('.card-row').length > 5 });
      report('card browser open (ms)', browserOpen.ms);
      const rendered = await page.locator('.card-row').count();
      assert.ok(rendered < 120, `virtualised: only ${rendered} rows in the DOM`);

      const search = await timed(async () => {
        await page.getByPlaceholder('Search front, back, hints, tags…').fill('item 996');
        await page.waitForFunction(() => {
          const m = /^([\d,]+) cards?/.exec(document.querySelector('.faint.small.num')?.textContent || '');
          return m && Number(m[1].replace(/,/g, '')) < 10000;
        }, null, { timeout: 30000, polling: 25 });
      });
      report('search 10k cards (ms, incl. debounce)', search.ms);
      report('search matches', await page.textContent('.faint.small.num'));

      await page.getByPlaceholder('Search front, back, hints, tags…').fill('');
      const scroll = await page.evaluate(async () => {
        const el = document.querySelector('.virtual-list');
        const t = performance.now();
        let frames = 0;
        for (let y = 0; y < el.scrollHeight; y += el.scrollHeight / 40) {
          el.scrollTop = y;
          await new Promise((r) => requestAnimationFrame(r));
          frames++;
        }
        return { frames, msPerFrame: Math.round(((performance.now() - t) / frames) * 10) / 10 };
      });
      report('scroll through 10k rows (ms per frame)', scroll.msPerFrame);

      const deckView = await nav(page, '#/deck/deck-3', { fn: () => document.querySelector('#main .view h1')?.textContent.includes('Deck 4') });
      report('deck page (ms)', deckView.ms);

      const stats = await nav(page, '#/stats', { fn: () => document.querySelectorAll('#main .chart').length >= 2 });
      report('statistics page (ms)', stats.ms);

      const session = await timed(async () => {
        await page.evaluate(() => { location.hash = '#/'; });
        await page.getByRole('button', { name: 'Start review' }).click({ timeout: 60000 });
        await waitPhase(page, ['question'], 60000);
      });
      report('start daily session (ms)', session.ms);

      const commit = await timed(() => answer(page, 'something'));
      report('answer → feedback incl. save (ms)', commit.ms);

      const verify = await timed(() => inApp(page, async ({ store }) => (await store.verifySchedules()).mismatches.length));
      report('replay and verify every schedule (ms)', verify.ms);
      assert.equal(verify.value, 0, 'stored schedules equal replayed history');

      const merge = await timed(() => inApp(page, async ({ store }) => {
        const data = await store.exportDataset({ includeMedia: true });
        const { report: r } = await store.mergeIn(data, { reason: 'perf no-op sync' });
        return r.newEvents;
      }));
      report('sync merge with nothing new (ms)', merge.ms);
      assert.equal(merge.value, 0);

      const backup = await timed(() => inApp(page, async ({ store }) => {
        const { buildBackup } = await import(new URL('./js/core/backup.js', location.href).href);
        const { seal } = await import(new URL('./js/core/sync/envelope.js', location.href).href);
        const data = await store.exportDataset({});
        const plain = JSON.stringify(buildBackup(data, { deviceId: store.deviceId }));
        const sealed = JSON.stringify(await seal(JSON.parse(plain), { format: 'axon-backup', compress: true }));
        return { plainMB: Math.round(plain.length / 104857.6) / 10, compressedMB: Math.round(sealed.length / 104857.6) / 10 };
      }));
      report('export backup (ms)', backup.ms);
      report('backup size', backup.value);

      // Generous budgets (desktop CI machine); real phones are slower.
      const budgets = { boot: [boot.ms, 8000], boot2: [boot2.ms, 5000], merge: [merge.ms, 20000], browser: [browserOpen.ms, 4000], search: [search.ms, 3000], stats: [stats.ms, 8000], session: [session.ms, 6000], commit: [commit.ms, 1500], scroll: [scroll.msPerFrame, 50] };
      for (const [k, [v, max]] of Object.entries(budgets)) assert.ok(v <= max, `${k}: ${v} > ${max}`);
      await ctx.close();
    },
  },
];
