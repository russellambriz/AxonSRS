// Spec 12.17–12.18, 17.16–17.19, 17.26–17.27: full backup round trip in
// the browser (plain and encrypted) and two-device sync through a mocked
// GitHub Gist API, with encryption and no token leaving the device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newContext, openApp, seedDeck, idbAll, inApp, startReview, answer, advance, waitReady, assertNoErrors, fakeGist, promptText } from './harness.mjs';

const CARDS = [
  ['Capital of France?', 'Paris | Paname', { tags: ['geo'], hint: 'P…', explanation: 'Since 508.' }],
  ['Pipe symbol name', 'vertical bar | pipe \\| bar', {}],
  ['Sulfate ion', 'SO4^2-', { answerMode: 'chem' }],
];
const MAP = { France: 'Paris', Pipe: 'pipe | bar', Sulfate: 'SO₄²⁻' };

async function studyTwo(page) {
  await startReview(page);
  for (let i = 0; i < 2; i++) {
    const p = await promptText(page);
    await answer(page, MAP[Object.keys(MAP).find((k) => p.includes(k))]);
    await advance(page);
  }
}

async function addMedia(page) {
  return inApp(page, async ({ store }) => {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    c.getContext('2d').fillRect(0, 0, 4, 4);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return (await store.putMedia(blob, { name: 'dot.png' })).id;
  });
}

/** Comparable view of a profile's data. */
async function dataView(page) {
  const [decks, cards, units, events, media, revisions] = await Promise.all(['decks', 'cards', 'units', 'events', 'media', 'revisions'].map((s) => idbAll(page, s)));
  return {
    decks: decks.map((d) => [d.id, d.name, d.settings.answerMode]).sort(),
    cards: cards.map((c) => [c.id, JSON.stringify(c.front), JSON.stringify(c.back), c.tags.join(' '), c.hint, c.explanation, c.answerMode]).sort(),
    units: units.map((u) => [u.id, u.headEventId, u.state ? [u.state.due, u.state.stability, u.state.difficulty, u.state.reps] : null]).sort(),
    events: events.map((e) => [e.id, e.type, e.rating ?? null]).sort(),
    media: media.map((m) => [m.id, m.type, m.size]).sort(),
    revisions: revisions.length,
  };
}

export const tests = [
  {
    name: 'full backup round trip through the UI (plain JSON and encrypted) restores identical data',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { acceptDownloads: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { name: 'Mixed', cards: CARDS });
      await addMedia(page);
      await studyTwo(page);
      await inApp(page, ({ store }) => store.setGlobal({ desiredRetention: 0.88 }));
      const original = await dataView(page);
      assert.ok(original.events.length >= 2 && original.media.length === 1);
      await page.goto(`${url}#/settings/data`);
      await page.reload();
      await waitReady(page);
      const plainDl = page.waitForEvent('download');
      await page.getByRole('button', { name: 'JSON' }).click();
      const plainPath = await (await plainDl).path();
      const plainText = readFileSync(plainPath, 'utf8');
      assert.equal(/test-token|gistToken|syncKeyring/.test(plainText), false, 'no secrets in the backup');
      await page.getByPlaceholder('Optional passphrase').fill('correct horse battery');
      const encDl = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const encPath = await (await encDl).path();
      const encText = readFileSync(encPath, 'utf8');
      assert.equal(encText.includes('Capital of France'), false, 'encrypted backup hides content');
      assert.match(encText, /AES-GCM|aes-256-gcm/i);

      for (const [kind, file] of [['plain', plainPath], ['encrypted', encPath]]) {
        const ctx2 = await newContext(browser);
        const p2 = await openApp(ctx2, url, { hash: '#/settings/data' });
        await p2.locator('label:has-text("Choose file") input[type=file]').setInputFiles(file);
        if (kind === 'encrypted') {
          const dlg = p2.locator('dialog[open]');
          await dlg.locator('input').fill('wrong passphrase');
          await dlg.getByRole('button', { name: 'Decrypt' }).click();
          await p2.getByText(/passphrase|decrypt/i).first().waitFor();
          await p2.locator('label:has-text("Choose file") input[type=file]').setInputFiles(file);
          const dlg2 = p2.locator('dialog[open]');
          await dlg2.locator('input').fill('correct horse battery');
          await dlg2.getByRole('button', { name: 'Decrypt' }).click();
        }
        await p2.getByText('All records passed validation.').waitFor();
        await p2.locator('dialog[open]').last().getByRole('button', { name: 'Replace' }).click();
        await p2.locator('dialog[open]').last().getByRole('button', { name: 'Replace' }).click();
        await p2.getByText('Backup restored').waitFor();
        const restored = await dataView(p2);
        assert.deepEqual(restored, original, `${kind} backup restores the same data`);
        assert.equal(await inApp(p2, ({ store }) => store.global.desiredRetention), 0.88);
        // The restored schedules replay exactly from the restored history.
        const verify = await inApp(p2, async ({ store }) => (await store.verifySchedules()).mismatches.length);
        assert.equal(verify, 0);
        assertNoErrors(p2, [/decrypt|passphrase|OperationError/i]);
        await ctx2.close();
      }
      await ctx.close();
    },
  },
  {
    name: 'two devices sync through a mocked Gist: encrypted, merged both ways, token never leaves the device',
    async run({ browser, url }) {
      const gist = fakeGist({ truncateOver: 3000 });
      const connect = async (page, { gistId = '' } = {}) => {
        await page.evaluate(() => { location.hash = '#/settings/sync'; });
        await page.getByPlaceholder('github_pat_… or ghp_…').fill(gist.token);
        if (gistId) await page.getByPlaceholder('Leave empty to create a new secret Gist').fill(gistId);
        await page.getByRole('switch', { name: 'Encrypt synced data' }).check({ force: true });
        await page.getByPlaceholder('At least 10 characters').fill('a long sync passphrase');
        await page.getByPlaceholder('Repeat passphrase').fill('a long sync passphrase');
        await page.getByRole('button', { name: 'Connect' }).click();
        await page.getByRole('button', { name: 'Sync now' }).waitFor({ timeout: 30000 });
        await page.waitForFunction(async () => {
          const { app } = await import(new URL('./js/app.js', location.href).href);
          return !app.sync.running && app.sync.status?.state !== 'syncing';
        });
      };
      const syncNow = (page) => inApp(page, ({ app }) => app.sync.sync({ reason: 'manual' }).then((r) => r.pulled));

      // Device A: content + reviews, then connect (creates the Gist).
      const ctxA = await newContext(browser);
      await gist.attach(ctxA);
      const a = await openApp(ctxA, url);
      await seedDeck(a, { name: 'Mixed', cards: CARDS });
      await addMedia(a);
      await studyTwo(a);
      await connect(a);
      const gistId = await inApp(a, ({ store }) => store.device.sync.gistId);
      assert.ok(gistId && gist.gists.has(gistId));
      const remote = gist.allContent();
      for (const secret of ['Capital of France', 'Paname', 'SO4^2-', gist.token, 'a long sync passphrase']) assert.equal(remote.includes(secret), false, `Gist does not contain ${secret}`);

      // Device B: empty, connects to the same Gist and receives everything.
      const ctxB = await newContext(browser);
      await gist.attach(ctxB);
      const b = await openApp(ctxB, url);
      await connect(b, { gistId });
      await b.waitForFunction(async () => (await (await import(new URL('./js/data/store.js', location.href).href)).store.listCards()).length === 3);
      const viewA = await dataView(a);
      let viewB = await dataView(b);
      assert.deepEqual(viewB.cards, viewA.cards);
      assert.deepEqual(viewB.units, viewA.units, 'schedules identical after sync');
      assert.deepEqual(viewB.events, viewA.events);
      assert.deepEqual(viewB.media, viewA.media);

      // B reviews offline-style, A edits a card; both sync; both converge.
      await startReview(b);
      const p = await promptText(b);
      await answer(b, MAP[Object.keys(MAP).find((k) => p.includes(k))]);
      await inApp(a, async ({ store, app }) => {
        const card = (await store.listCards()).find((c) => c.front[0].startsWith('Capital'));
        await store.saveCard({ ...card, explanation: 'Capital since 508 CE.' });
        await app.cache.load();
      });
      await syncNow(b);
      const pulled = await syncNow(a);
      assert.ok(pulled.newEvents >= 1, 'A received B’s review');
      await syncNow(b);
      const finalA = await dataView(a);
      viewB = await dataView(b);
      assert.deepEqual(viewB.events, finalA.events);
      assert.deepEqual(viewB.units, finalA.units);
      assert.deepEqual(viewB.cards, finalA.cards);
      assert.ok(finalA.cards.some((c) => c[5] === 'Capital since 508 CE.'));

      // The token only ever went to api.github.com; raw file downloads carried none.
      assert.ok(gist.log.some((r) => r.raw), 'large files were fetched through raw_url');
      assert.equal(gist.log.filter((r) => r.raw && r.auth).length, 0, 'no Authorization header to the raw host');
      for (const pg of [a, b]) {
        const ls = await pg.evaluate(() => JSON.stringify({ ...localStorage }));
        assert.equal(ls.includes(gist.token), false, 'token not in localStorage');
        const secrets = await idbAll(pg, 'secrets');
        assert.equal(secrets.some((s) => s.key === 'gistToken'), false, 'token not remembered unless asked');
        const backup = await inApp(pg, async ({ store }) => JSON.stringify(await store.exportDataset({})));
        assert.equal(backup.includes(gist.token), false, 'token never exported');
        assertNoErrors(pg);
      }
      await ctxA.close();
      await ctxB.close();
    },
  },
];
