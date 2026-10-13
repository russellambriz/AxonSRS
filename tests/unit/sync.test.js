// Spec 12.13, 12.14, 17.26: sync merging, duplicate event prevention,
// deletion propagation, conflicting edits; encryption and wrong
// passphrases; compression fallback, oversized payloads, truncated Gist
// content and token forwarding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDatasets, emptyDataset } from '../../js/core/sync/merge.js';
import { stamp, revisionIndex, isAncestor, commonAncestor, threeWay } from '../../js/core/sync/versioning.js';
import { seal, open, createKeyring, EnvelopeError } from '../../js/core/sync/envelope.js';
import { gzip, gunzip, gzipClaimedSize } from '../../js/core/sync/compress.js';
import { GistClient, isAllowedRawUrl, parseGistId, explainStatus } from '../../js/core/sync/gist.js';
import { datasetToChunks, chunksToDataset, chunkHashes, buildManifest } from '../../js/core/sync/chunks.js';
import { createCard, createDeck } from '../../js/core/model.js';
import { randomBytes } from '../../js/core/sync/crypto.js';

function baseWorld() {
  const deck = stamp('decks', createDeck({ id: 'd', name: 'Deck' }, 'A'), { deviceId: 'A', ts: 1 });
  const card = stamp('cards', createCard({ id: 'c', deckId: 'd', front: 'Q', back: 'A', tags: ['x'] }, 'A'), { deviceId: 'A', ts: 2 });
  return { deck, card, ds: { ...emptyDataset(), decks: [deck.record], cards: [card.record], revisions: [deck.revision, card.revision] } };
}

function edit(record, patch, device, ts) {
  return stamp('cards', { ...record, ...patch }, { deviceId: device, ts });
}

const ev = (id, unitId = 'c:fwd', ts = 10, extra = {}) => ({ id, type: 'review', unitId, cardId: 'c', ts, deviceId: 'A', seq: 1, rating: 3, ...extra });

test('events merge by id: idempotent, retry-safe, no duplicates', () => {
  const { ds } = baseWorld();
  const local = { ...ds, events: [ev('e1'), ev('e2')] };
  const remote = { ...ds, events: [ev('e2'), ev('e3', 'c:rev')] };
  const once = mergeDatasets(local, remote);
  assert.deepEqual(once.dataset.events.map((e) => e.id).sort(), ['e1', 'e2', 'e3']);
  assert.equal(once.report.newEvents, 1);
  assert.ok(once.report.unitsToReplay.has('c:rev'));
  const twice = mergeDatasets(once.dataset, remote);
  assert.equal(twice.dataset.events.length, 3);
  assert.equal(twice.report.newEvents, 0);
  const tampered = mergeDatasets(local, { ...ds, events: [{ ...ev('e1'), rating: 1 }] });
  assert.equal(tampered.report.integrity.length, 1, 'same id with different facts is reported, local kept');
  assert.equal(tampered.dataset.events.find((e) => e.id === 'e1').rating, 3);
});

test('a descendant edit wins over its ancestor on either side', () => {
  const { ds, card } = baseWorld();
  const e1 = edit(card.record, { back: ['A2'] }, 'B', 5);
  const remote = { ...ds, cards: [e1.record], revisions: [...ds.revisions, e1.revision] };
  const r = mergeDatasets(ds, remote);
  assert.deepEqual(r.dataset.cards[0].back, ['A2']);
  const r2 = mergeDatasets(remote, ds);
  assert.deepEqual(r2.dataset.cards[0].back, ['A2'], 'newer local is never overwritten by older remote');
  assert.equal(r2.report.conflicts.length, 0);
});

test('concurrent edits of different fields merge automatically and deterministically', () => {
  const { ds, card } = baseWorld();
  const onA = edit(card.record, { back: ['A-new'] }, 'A', 5);
  const onB = edit(card.record, { tags: ['x', 'y'] }, 'B', 6);
  const local = { ...ds, cards: [onA.record], revisions: [...ds.revisions, onA.revision] };
  const remote = { ...ds, cards: [onB.record], revisions: [...ds.revisions, onB.revision] };
  const ab = mergeDatasets(local, remote);
  const ba = mergeDatasets(remote, local);
  assert.equal(ab.report.conflicts.length, 0);
  assert.deepEqual(ab.dataset.cards[0].back, ['A-new']);
  assert.deepEqual(ab.dataset.cards[0].tags, ['x', 'y']);
  assert.equal(ab.dataset.cards[0].version.hash, ba.dataset.cards[0].version.hash, 'both devices reach the same version');
  // merging again is a no-op
  const again = mergeDatasets(ab.dataset, ba.dataset);
  assert.equal(again.report.autoMerged, 0);
  assert.equal(again.report.conflicts.length, 0);
});

test('conflicting edits of the same field are flagged, local kept, remote preserved', () => {
  const { ds, card } = baseWorld();
  const onA = edit(card.record, { back: ['from A'] }, 'A', 5);
  const onB = edit(card.record, { back: ['from B'] }, 'B', 6);
  const r = mergeDatasets({ ...ds, cards: [onA.record], revisions: [...ds.revisions, onA.revision] }, { ...ds, cards: [onB.record], revisions: [...ds.revisions, onB.revision] });
  assert.equal(r.report.conflicts.length, 1);
  const c = r.report.conflicts[0];
  assert.deepEqual(c.fields, ['back']);
  assert.deepEqual(r.dataset.cards[0].back, ['from A'], 'never silently overwrites');
  assert.ok(r.dataset.revisions.some((x) => x.hash === onB.record.version.hash), 'the other version is kept in history');
});

test('deletions propagate through tombstones; edit-after-delete becomes a conflict', () => {
  const { ds, card } = baseWorld();
  const tomb = { id: 'c', type: 'cards', deletedAt: 9, deviceId: 'B', lastHash: card.record.version.hash };
  const r = mergeDatasets(ds, { ...ds, cards: [], tombstones: [tomb] });
  assert.equal(r.dataset.cards.length, 0);
  assert.equal(r.report.removed.cards, 1);
  // A edited the card while B deleted the old version
  const editedA = edit(card.record, { back: ['kept'] }, 'A', 8);
  const r2 = mergeDatasets({ ...ds, cards: [editedA.record], revisions: [...ds.revisions, editedA.revision] }, { ...ds, cards: [], tombstones: [tomb] });
  assert.equal(r2.dataset.cards.length, 1, 'newer work is not deleted silently');
  assert.equal(r2.report.conflicts[0].kind, 'delete-edit');
  // An explicit restore (resurrection) revokes the tombstone everywhere
  const restored = stamp('cards', card.record, { deviceId: 'A', ts: 20, resurrects: true });
  const r3 = mergeDatasets({ ...ds, cards: [restored.record], revisions: [...ds.revisions, restored.revision], tombstones: [tomb] }, { ...ds, cards: [], tombstones: [tomb] });
  assert.equal(r3.dataset.cards.length, 1);
  assert.equal(r3.report.revokedTombstones, 1);
});

test('unit overlays are last-writer-wins by their own timestamps; settings per key', () => {
  const u = { id: 'c:fwd', cardId: 'c', key: 'fwd', overlays: { buriedUntil: '2026-01-02' }, overlaysAt: 5, suspended: false, suspendedAt: 0 };
  const r = mergeDatasets({ ...emptyDataset(), units: [u] }, { ...emptyDataset(), units: [{ ...u, overlays: { postponedUntil: '2026-02-01' }, overlaysAt: 7, suspended: true, suspendedAt: 3 }] });
  assert.deepEqual(r.dataset.units[0].overlays, { postponedUntil: '2026-02-01' });
  assert.equal(r.dataset.units[0].suspended, true);
  const s = mergeDatasets({ ...emptyDataset(), settings: { values: { a: 1, b: 1 }, updatedAt: { a: 5, b: 5 } } }, { ...emptyDataset(), settings: { values: { a: 2, b: 0 }, updatedAt: { a: 9, b: 1 } } });
  assert.deepEqual(s.dataset.settings.values, { a: 2, b: 1 });
});

test('versioning: ancestry, common ancestors and three-way merges', () => {
  const { card } = baseWorld();
  const a = edit(card.record, { hint: 'h' }, 'A', 5);
  const b = edit(a.record, { hint: 'h2' }, 'A', 6);
  const idx = revisionIndex([card.revision, a.revision, b.revision]);
  assert.ok(isAncestor(card.record.version.hash, b.record.version.hash, idx));
  assert.ok(!isAncestor(b.record.version.hash, card.record.version.hash, idx));
  assert.equal(commonAncestor(a.record.version.hash, b.record.version.hash, idx), a.record.version.hash);
  assert.deepEqual(threeWay({ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 3 }), { merged: { x: 2, y: 3 }, conflicts: [] });
  assert.deepEqual(threeWay({ x: 1 }, { x: 2 }, { x: 3 }).conflicts, ['x']);
});

test('encryption round trip; wrong passphrase and tampering are detected', async () => {
  const payload = { hello: 'world', n: [1, 2, 3], unicode: 'SO₄²⁻' };
  const keyring = await createKeyring('correct horse battery staple', { iterations: 1000 });
  const env = await seal(payload, { format: 'axon-sync', keyring });
  assert.equal(env.encryption.alg, 'AES-256-GCM');
  assert.equal(env.encryption.kdf, 'PBKDF2-SHA-256');
  assert.ok(env.iv && env.encryption.salt);
  assert.equal(JSON.stringify(env).includes('correct horse'), false, 'passphrase never stored');
  assert.equal(JSON.stringify(env).includes('world'), false, 'contents are not readable');
  assert.deepEqual(await open(env, { passphrase: 'correct horse battery staple' }), payload);
  await assert.rejects(open(env, { passphrase: 'wrong' }), (e) => e instanceof EnvelopeError && e.code === 'wrong-passphrase');
  await assert.rejects(open(env, {}), (e) => e.code === 'passphrase-required');
  await assert.rejects(open({ ...env, compression: 'none' }, { passphrase: 'correct horse battery staple' }), (e) => e.code === 'wrong-passphrase', 'header bound as AAD');
  const env2 = await seal(payload, { format: 'axon-sync', keyring });
  assert.notEqual(env.iv, env2.iv, 'fresh IV for every encryption');
});

test('default key derivation uses 600 000 PBKDF2 iterations', async () => {
  const kr = await createKeyring('passphrase-for-test');
  assert.equal(kr.iterations, 600000);
  assert.equal(kr.salt.length, 16);
});

test('unencrypted envelopes carry an integrity hash', async () => {
  const env = await seal({ a: 1 }, { format: 'axon-backup', compress: false });
  assert.deepEqual(await open(env), { a: 1 });
  await assert.rejects(open({ ...env, payload: '{"a":2}' }), (e) => e.code === 'integrity');
  await assert.rejects(open({ ...env, envelope: 99 }), (e) => e.code === 'version-unsupported');
  await assert.rejects(open(env, { expectedFormat: 'axon-sync' }), (e) => e.code === 'format');
});

test('compression: native and fflate fallback are interchangeable', async () => {
  const text = new TextEncoder().encode(JSON.stringify({ big: 'x'.repeat(50000), arr: Array.from({ length: 2000 }, (_, i) => i) }));
  const native = await gzip(text, { implementation: 'native' });
  const fallback = await gzip(text, { implementation: 'fflate' });
  assert.equal(native.implementation, 'native');
  assert.equal(fallback.implementation, 'fflate');
  assert.ok(native.bytes.length < text.length / 10);
  assert.deepEqual(await gunzip(native.bytes, { implementation: 'fflate' }), text);
  assert.deepEqual(await gunzip(fallback.bytes, { implementation: 'native' }), text);
  const env = await seal({ v: 1 }, { format: 'axon-sync', compressionImpl: 'fflate' });
  assert.equal(env.compressionImpl, 'fflate');
  assert.deepEqual(await open(env), { v: 1 });
});

test('decompression is bounded (zip-bomb safety) and rejects corrupt data', async () => {
  const zeros = new Uint8Array(4 * 1024 * 1024);
  const { bytes } = await gzip(zeros, { implementation: 'fflate' });
  assert.equal(gzipClaimedSize(bytes), zeros.length);
  for (const implementation of ['native', 'fflate']) {
    await assert.rejects(gunzip(bytes, { maxBytes: 1024 * 1024, implementation }), (e) => e.code === 'too-large');
  }
  // trailer lies about the size → stream limit still applies
  const lying = bytes.slice();
  lying.set([1, 0, 0, 0], lying.length - 4);
  for (const implementation of ['native', 'fflate']) {
    await assert.rejects(gunzip(lying, { maxBytes: 1024 * 1024, implementation }), (e) => ['too-large', 'corrupt'].includes(e.code));
  }
  await assert.rejects(gunzip(randomBytes(64)), (e) => e.code === 'corrupt');
});

test('Gist client: truncated files come from raw_url without the token; only GitHub API gets the token', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.Authorization || null });
    if (url.startsWith('https://gist.githubusercontent.com/')) return new Response('FULL CONTENT');
    return new Response(JSON.stringify({ id: 'abc', files: { 'big.json': { truncated: true, content: 'PART', raw_url: 'https://gist.githubusercontent.com/u/abc/raw/big.json' }, 'small.json': { truncated: false, content: 'small' } } }), { status: 200 });
  };
  const client = new GistClient({ token: 'TOKEN123', fetchImpl });
  const gist = await client.getGist('abc');
  assert.equal(await client.fileContent(gist, 'big.json'), 'FULL CONTENT');
  assert.equal(await client.fileContent(gist, 'small.json'), 'small');
  assert.equal(calls[0].auth, 'Bearer TOKEN123');
  assert.equal(calls[1].auth, null, 'token not forwarded to the raw host');
  const evil = { files: { x: { truncated: true, raw_url: 'https://evil.example/steal' } } };
  await assert.rejects(client.fileContent(evil, 'x'), (e) => e.code === 'security');
  assert.equal(isAllowedRawUrl('http://gist.githubusercontent.com/x'), false);
});

test('Gist client explains authentication, permission, rate-limit and network errors', async () => {
  const resp = (status, headers = {}) => async () => new Response(JSON.stringify({ message: 'm' }), { status, headers });
  for (const [status, code, headers] of [[401, 'auth'], [403, 'forbidden'], [403, 'rate-limit', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' }], [404, 'not-found'], [422, 'validation'], [500, 'server']]) {
    const c = new GistClient({ token: 't', fetchImpl: resp(status, headers) });
    await assert.rejects(c.getGist('x'), (e) => e.code === code && e.message.length > 20, `${status} → ${code}`);
  }
  const offline = new GistClient({ token: 't', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.getUser(), (e) => e.code === 'network');
  assert.equal(parseGistId('https://gist.github.com/someone/0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef');
  assert.equal(explainStatus(409, new Headers()).code, 'conflict');
  assert.throws(() => new GistClient({}));
});

test('chunking splits by kind and month, round-trips, and only changed chunks differ', async () => {
  const { ds } = baseWorld();
  const data = { ...ds, events: [ev('a', 'c:fwd', Date.UTC(2026, 0, 3)), ev('b', 'c:fwd', Date.UTC(2026, 1, 3))], units: [{ id: 'c:fwd', cardId: 'c', deckId: 'd', key: 'fwd', state: { due: 1 }, active: true }], media: [{ id: 'sha256-x', type: 'image/png', size: 3, data: 'AAA=' }] };
  const chunks = datasetToChunks(data);
  assert.deepEqual([...chunks.keys()].sort(), ['axon-events-2026-01.json', 'axon-events-2026-02.json', 'axon-media-sha256-x.json', 'axon-records.json', 'axon-revisions.json']);
  assert.equal(chunks.get('axon-records.json').units[0].state, undefined, 'FSRS state is rebuilt from events, not synced');
  const back = chunksToDataset([...chunks.values()]);
  assert.equal(back.events.length, 2);
  const h1 = await chunkHashes(chunks);
  const more = datasetToChunks({ ...data, events: [...data.events, ev('c', 'c:fwd', Date.UTC(2026, 1, 9))] });
  const h2 = await chunkHashes(more);
  const changed = Object.keys(h2).filter((k) => h1[k] !== h2[k]);
  assert.deepEqual(changed, ['axon-events-2026-02.json']);
  const m = buildManifest({ hashes: h2, counts: {}, deviceId: 'A', encrypted: true });
  assert.equal(m.files['axon-records.json'].sha256, h2['axon-records.json']);
  assert.ok(m.devices.A.lastSyncAt);
});
