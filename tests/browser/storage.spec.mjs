// Spec 12.1–12.4, 17.1–17.4: IndexedDB persistence, schema migration,
// failed transactions, storage persistence denied or unsupported.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, newContext, openApp, seedDeck, idbAll, inApp, startReview, answer, advance, waitPhase, assertNoErrors, waitReady } from './harness.mjs';

const CARDS = [['Capital of France?', 'Paris'], ['Capital of Italy?', 'Rome'], ['Capital of Spain?', 'Madrid']];
const MAP = { France: 'Paris', Italy: 'Rome', Spain: 'Madrid' };

async function answerShown(page) {
  const prompt = (await page.textContent('#study-prompt')) || '';
  const key = Object.keys(MAP).find((k) => prompt.includes(k));
  return answer(page, MAP[key]);
}

export const tests = [
  {
    name: 'reviews, schedules and settings persist across reloads',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { name: 'Capitals', cards: CARDS });
      await page.reload();
      await waitReady(page);
      assert.equal(await startReview(page), 'question');
      assert.equal(await answerShown(page), 'feedback');
      await advance(page);
      assert.equal(await answerShown(page), 'feedback');
      await inApp(page, ({ store }) => store.setGlobal({ desiredRetention: 0.87 }));
      const before = (await idbAll(page, 'units')).filter((u) => u.state).map((u) => [u.id, u.state.due, u.headEventId]).sort();
      await page.reload();
      await waitReady(page);
      const events = (await idbAll(page, 'events')).filter((e) => e.type === 'review');
      assert.equal(events.length, 2, 'two reviews recorded once each');
      const after = (await idbAll(page, 'units')).filter((u) => u.state).map((u) => [u.id, u.state.due, u.headEventId]).sort();
      assert.deepEqual(after, before);
      assert.equal(await inApp(page, ({ store }) => store.global.desiredRetention), 0.87);
      // The interrupted session can be resumed where it stopped.
      const sessions = await idbAll(page, 'sessions');
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].index, 2);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'schema migration: v1 data upgrades to a synthetic v2 after a snapshot; a newer database is never opened by older code',
    async run({ browser, url, srv }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { name: 'Capitals', cards: CARDS });
      await startReview(page);
      await answerShown(page);
      await advance(page);
      const v1Events = await idbAll(page, 'events');
      // Ship a "new release" with DB_VERSION 2 and one extra migration that
      // rewrites every card record and adds an index.
      const config = readFileSync(join(ROOT, 'js/config.js'), 'utf8');
      const db = readFileSync(join(ROOT, 'js/data/db.js'), 'utf8');
      srv.overrides.set('js/config.js', config.replace('export const DB_VERSION = 1;', 'export const DB_VERSION = 2;'));
      const migration = `  {
    version: 2,
    description: 'Synthetic test migration',
    upgrade(db, tx) {
      const cards = tx.objectStore('cards');
      cards.createIndex('testV2', 'migratedV2', { unique: false });
      cards.openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return;
        c.update({ ...c.value, migratedV2: 1 });
        c.continue();
      };
    },
  },
];`;
      srv.overrides.set('js/data/db.js', db.replace(/\n\];\n\nexport class StorageError/, `\n${migration}\n\nexport class StorageError`));
      await page.goto(`${url}#/recovery`);
      await page.reload();
      await waitReady(page);
      await page.getByText('The database was upgraded from version 1 to 2').waitFor();
      const ver = await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('axon'); q.onsuccess = () => { r(q.result.version); q.result.close(); }; }));
      assert.equal(ver, 2);
      const cards = await idbAll(page, 'cards');
      assert.ok(cards.length === 3 && cards.every((c) => c.migratedV2 === 1), 'migration applied to every record');
      assert.deepEqual((await idbAll(page, 'events')).map((e) => e.id).sort(), v1Events.map((e) => e.id).sort(), 'history untouched');
      const snaps = await idbAll(page, 'snapshots', 'axon-snapshots');
      const snap = snaps.find((s) => /before upgrade v1 → v2/.test(s.reason));
      assert.ok(snap, 'snapshot taken before the upgrade');
      assert.equal(snap.dump.cards.length, 3);
      assert.equal(snap.dump.cards[0].migratedV2, undefined, 'snapshot holds the pre-upgrade records');
      // Rolling back to the old release must refuse to open (not wipe) v2 data.
      srv.overrides.clear();
      await page.goto(url);
      await page.getByText('Axon could not open your data').waitFor();
      await page.getByText('saved by a newer version').first().waitFor();
      assert.equal((await idbAll(page, 'cards')).length, 3);
      await ctx.close();
    },
  },
  {
    name: 'a failing migration leaves the database untouched and explains what happened',
    async run({ browser, url, srv }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { name: 'Capitals', cards: CARDS });
      const config = readFileSync(join(ROOT, 'js/config.js'), 'utf8');
      const db = readFileSync(join(ROOT, 'js/data/db.js'), 'utf8');
      srv.overrides.set('js/config.js', config.replace('export const DB_VERSION = 1;', 'export const DB_VERSION = 2;'));
      srv.overrides.set('js/data/db.js', db.replace(/\n\];\n\nexport class StorageError/, "\n  { version: 2, description: 'Broken', upgrade(db, tx) { tx.objectStore('cards').clear(); throw new Error('synthetic failure'); } },\n];\n\nexport class StorageError"));
      page.__errors = [];
      await page.goto(url);
      await page.getByText('Axon could not open your data').waitFor();
      await page.getByText('Updating the database failed').waitFor();
      const ver = await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('axon'); q.onsuccess = () => { r(q.result.version); q.result.close(); }; }));
      assert.equal(ver, 1, 'still version 1');
      assert.equal((await idbAll(page, 'cards')).length, 3, 'the aborted upgrade rolled back the clear()');
      srv.overrides.clear();
      await page.goto(url);
      await waitReady(page);
      assert.equal((await idbAll(page, 'cards')).length, 3);
      await ctx.close();
    },
  },
  {
    name: 'a failed review transaction saves nothing, keeps the answer and retries exactly once',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      await seedDeck(page, { name: 'Capitals', cards: CARDS });
      await startReview(page);
      // Make the next write to `units` fail with a quota error mid-transaction
      // (after the event was added) so the whole transaction must abort.
      await page.evaluate(() => {
        const orig = IDBObjectStore.prototype.put;
        window.__failPuts = 1;
        IDBObjectStore.prototype.put = function put(...args) {
          if (this.name === 'units' && window.__failPuts > 0) {
            window.__failPuts--;
            throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
          }
          return orig.apply(this, args);
        };
      });
      const prompt = (await page.textContent('#study-prompt')) || '';
      const key = Object.keys(MAP).find((k) => prompt.includes(k));
      assert.equal(await answer(page, MAP[key]), 'error');
      await page.getByText('This review could not be saved').waitFor();
      await page.getByText('storage is full', { exact: false }).waitFor();
      assert.equal(await page.inputValue('.answer-input'), MAP[key], 'typed answer is kept');
      assert.equal((await idbAll(page, 'events')).filter((e) => e.type === 'review').length, 0, 'no partial event');
      assert.equal((await idbAll(page, 'units')).filter((u) => u.state).length, 0, 'no partial schedule change');
      const pending = await page.evaluate(() => localStorage.getItem('axon-pending-review'));
      assert.ok(pending && JSON.parse(pending).plan.event.id, 'pending review kept for recovery');
      await page.getByRole('button', { name: 'Retry' }).click();
      assert.equal(await waitPhase(page, ['feedback']), 'feedback');
      // A second retry of the same plan must not duplicate it.
      const ev = JSON.parse(pending).plan;
      const dup = await inApp(page, ({ store }, plan) => store.commitReview(plan).then((r) => r.duplicate), ev);
      assert.equal(dup, true);
      assert.equal((await idbAll(page, 'events')).filter((e) => e.type === 'review').length, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem('axon-pending-review')), null);
      await ctx.close();
    },
  },
  {
    name: 'storage persistence denied or unsupported: study works and Settings explains the risk',
    async run({ browser, url }) {
      for (const mode of ['denied', 'unsupported']) {
        const ctx = await newContext(browser);
        await ctx.addInitScript((m) => {
          if (m === 'denied') {
            navigator.storage.persist = () => Promise.resolve(false);
            navigator.storage.persisted = () => Promise.resolve(false);
          } else {
            Object.defineProperty(Navigator.prototype, 'storage', { get: () => undefined, configurable: true });
          }
        }, mode);
        const page = await openApp(ctx, url);
        await seedDeck(page, { name: 'Capitals', cards: CARDS });
        await page.waitForFunction(() => true);
        const result = await inApp(page, ({ store }) => store.device.persistResult);
        assert.equal(result, mode);
        assert.equal(await startReview(page), 'question');
        assert.equal(await answerShown(page), 'feedback');
        await page.goto(`${url}#/settings/data`);
        await waitReady(page);
        await page.getByText(mode === 'denied' ? 'Not granted' : 'Not supported by this browser', { exact: false }).first().waitFor();
        await page.getByText('Local snapshots are not a backup', { exact: false }).waitFor();
        assertNoErrors(page);
        await ctx.close();
      }
    },
  },
];
