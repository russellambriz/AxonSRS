// Spec 17.25, 17.28: invalid backup recovery, migrations, round trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, readBackup, validateDataset, migrateData } from '../../js/core/backup.js';
import { seal, open } from '../../js/core/sync/envelope.js';
import { createCard, createDeck } from '../../js/core/model.js';
import { schedulerParams } from '../../js/core/scheduler.js';
import { exportAnki } from '../../js/core/anki.js';

function dataset() {
  const deck = createDeck({ id: 'd1', name: 'Chem' });
  const card = createCard({ id: 'c1', deckId: 'd1', front: 'Pipe \\| inside | alt', back: 'SO4^2- | SO₄²⁻', tags: ['ions'], hint: 'h', explanation: 'e', taskType: 'calculation', answerMode: 'chem' });
  return {
    decks: [deck],
    cards: [card],
    units: [{ id: 'c1:fwd', cardId: 'c1', deckId: 'd1', key: 'fwd', state: { due: 5, stability: 2, difficulty: 5, reps: 1, lapses: 0, state: 2, scheduled_days: 2, elapsed_days: 0, learning_steps: 0, last_review: 1 }, active: true }],
    events: [{ id: 'e1', type: 'review', ts: 1, deviceId: 'dev', seq: 1, unitId: 'c1:fwd', cardId: 'c1', rating: 3, params: schedulerParams() }],
    revisions: [{ id: 'c1@h', recordId: 'c1', hash: 'h', snapshot: {} }],
    tombstones: [],
    links: [{ id: 'l1', a: 'c1', b: 'c2' }],
    plans: [{ id: 'p1', examDate: '2026-06-01', deckIds: ['d1'] }],
    media: [{ id: 'sha256-abc', type: 'image/png', size: 4, data: 'AAAA' }],
    calibration: [{ key: 'physical|recall', samples: [] }],
    settings: { values: { desiredRetention: 0.85 }, updatedAt: { desiredRetention: 3 } },
  };
}

test('complete backup round trip preserves decks, cards, aliases, media, history, revisions and scheduling', async () => {
  const data = dataset();
  const backup = buildBackup(data, { deviceId: 'dev' });
  assert.equal(backup.format, 'axon-backup');
  for (const sealedWith of [null, { compress: true }, { compress: true, passphrase: 'pass phrase 123' }]) {
    let obj = JSON.parse(JSON.stringify(backup));
    if (sealedWith) {
      const { createKeyring } = await import('../../js/core/sync/envelope.js');
      const keyring = sealedWith.passphrase ? await createKeyring(sealedWith.passphrase, { iterations: 1000 }) : null;
      const env = await seal(obj, { format: 'axon-backup', compress: true, keyring });
      obj = await open(JSON.parse(JSON.stringify(env)), { passphrase: sealedWith.passphrase });
    }
    const res = readBackup(obj);
    assert.ok(res.ok);
    assert.deepEqual(res.errors.filter((e) => e.collection !== 'links'), []);
    assert.deepEqual(res.dataset.cards[0].front, data.cards[0].front, 'aliases with literal pipes intact');
    assert.deepEqual(res.dataset.cards[0].back, ['SO4^2-', 'SO₄²⁻']);
    assert.equal(res.dataset.units[0].state.stability, 2);
    assert.equal(res.dataset.events[0].params.w.length, 21);
    assert.equal(res.dataset.media[0].data, 'AAAA');
    assert.equal(res.dataset.revisions.length, 1);
    assert.equal(res.dataset.settings.values.desiredRetention, 0.85);
    assert.equal(res.dataset.cards[0].taskType, 'calculation');
  }
  assert.equal(JSON.stringify(backup).includes('gistToken'), false);
});

test('partially invalid data: bad records are reported and skipped, good ones kept, orphans re-homed', () => {
  const data = dataset();
  data.cards.push({ id: 'bad', deckId: 'd1', front: 'not an array', back: [] });
  data.cards.push(createCard({ id: 'orphan', deckId: 'missing-deck', front: 'x', back: 'y' }));
  data.events.push({ id: 'e2', type: 'review', ts: 2, deviceId: 'dev', unitId: 'c1:fwd', rating: 9, params: schedulerParams() });
  data.events.push({ id: 'e3', type: 'mystery', ts: 2, deviceId: 'dev' });
  data.events.push(data.events[0]);
  data.media.push({ id: 'sha256-svg', type: 'image/svg+xml', data: 'PHN2Zz4=' });
  data.units.push({ id: 'zzz:fwd', cardId: 'zzz', key: 'fwd', state: null });
  const { dataset: ds, errors } = validateDataset(data);
  assert.equal(ds.cards.length, 2);
  assert.ok(ds.cards.find((c) => c.id === 'orphan').deckId === 'recovered-cards');
  assert.ok(ds.decks.some((d) => d.name === 'Recovered cards'));
  assert.equal(ds.events.length, 1);
  assert.equal(ds.media.length, 1, 'SVG media is refused for safety');
  assert.equal(ds.units.length, 1);
  const messages = errors.map((e) => `${e.collection}:${e.message}`).join('\n');
  for (const needle of ['front/back', 'valid rating', 'unknown event type', 'duplicate id', 'unsupported media', 'missing deck', 'without a card']) assert.match(messages, new RegExp(needle));
});

test('older or foreign data is migrated (task type defaults to Recall)', () => {
  const { data, applied } = migrateData({ cards: [{ id: 'x', deckId: 'd', front: ['a'], back: ['b'] }], units: [{ id: 'x:fwd' }] }, 0);
  assert.deepEqual(applied, ['0→1']);
  assert.equal(data.cards[0].taskType, 'recall');
  assert.deepEqual(data.units[0].overlays, {});
  const res = readBackup({ format: 'axon-backup', version: 1, recordVersion: 0, data: { decks: [{ id: 'd', name: 'D' }], cards: [{ id: 'x', deckId: 'd', front: ['a'], back: ['b'] }] } });
  assert.deepEqual(res.migrations, ['0→1']);
  assert.equal(res.dataset.cards[0].taskType, 'recall');
});

test('newer or foreign files are refused with a clear message', () => {
  assert.equal(readBackup({ format: 'something-else' }).ok, false);
  assert.match(readBackup({ format: 'axon-backup', version: 99 }).errors[0].message, /newer version/);
});

test('Anki export preserves front, back (with aliases), tags, deck and scheduling notes', () => {
  const data = dataset();
  const decks = new Map(data.decks.map((d) => [d.id, d]));
  const cloze = createCard({ id: 'c2', deckId: 'd1', front: '{{c1::Paris}} is in France', back: 'extra' });
  const occ = createCard({ id: 'c3', deckId: 'd1', occlusion: { imageId: 'm', masks: [] } });
  const { text, skipped, count } = exportAnki([...data.cards, cloze, occ], decks, new Map([['c1', data.units]]));
  const lines = text.split('\n');
  assert.equal(lines[0], '#separator:tab');
  assert.ok(lines.some((l) => l.startsWith('#tags column:5')));
  const row = lines.find((l) => l.startsWith('Basic'));
  assert.match(row, /SO4\^2- \| SO₄²⁻/);
  assert.match(row, /Pipe \\\| inside \| alt/);
  assert.match(row, /Axon — fwd: review, due/);
  assert.ok(lines.some((l) => l.startsWith('Cloze\tChem\t{{c1::Paris}}')));
  assert.equal(count, 2);
  assert.equal(skipped.length, 1);
});
