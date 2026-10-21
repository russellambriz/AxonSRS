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

test('incoming events with an implausible clock are merged (never dropped) and flagged for reconciliation', () => {
  const { ds } = baseWorld();
  const now = 1_000_000_000;
  const local = { ...ds, events: [ev('e1', 'c:fwd', now - 5000)] };
  const remote = { ...ds, events: [ev('e1', 'c:fwd', now - 5000), ev('ahead', 'c:fwd', now + 7 * 86400000, { deviceId: 'B', parentId: 'e1' })] };
  const r = mergeDatasets(local, remote, { now });
  assert.ok(r.dataset.events.some((e) => e.id === 'ahead'), 'the suspicious event is kept');
  assert.ok(r.report.unitsToReplay.has('c:fwd'));
  const clock = r.report.conflicts.filter((c) => c.kind === 'clock');
  assert.deepEqual(clock.map((c) => [c.issue, c.events.map((e) => e.id)]), [['future-timestamp', ['ahead']]]);
  // Merging the same data again raises nothing new: only new events are checked.
  assert.equal(mergeDatasets(r.dataset, remote, { now }).report.conflicts.length, 0);
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

test('sync pull never keeps media that fail validation, says why, and leaves them in the Gist', async () => {
  const { SyncService } = await import('../../js/data/sync.js');
  const { SYNC_FORMAT } = await import('../../js/config.js');
  const { sha256Hex } = await import('../../js/core/util.js');
  const { MANIFEST_FILE } = await import('../../js/core/sync/chunks.js');
  // A Gist written by another device: one valid image, one SVG, one oversized asset that claims to be tiny.
  const files = new Map();
  const history = ['v1'];
  const put = async (name, value) => {
    files.set(name, JSON.stringify(await seal(value, { format: SYNC_FORMAT, deviceId: 'B' })));
    return sha256Hex(JSON.stringify(value));
  };
  const good = { id: 'sha256-good', type: 'image/png', size: 3, data: 'AAAA' };
  const svg = { id: 'sha256-svg', type: 'image/svg+xml', size: 10, data: 'PHN2Zz4=' };
  const huge = { id: 'sha256-huge', type: 'image/png', size: 12, data: 'A'.repeat(28 * 1024 * 1024) };
  const hashes = { 'axon-records.json': await put('axon-records.json', { kind: 'records', decks: [], cards: [], units: [], links: [], plans: [], tombstones: [], settings: { values: {}, updatedAt: {} } }) };
  for (const m of [good, svg, huge]) hashes[`axon-media-${m.id}.json`] = await put(`axon-media-${m.id}.json`, { kind: 'media', media: m });
  files.set(MANIFEST_FILE, JSON.stringify(await seal(buildManifest({ hashes, counts: {}, deviceId: 'B', encrypted: false }), { format: SYNC_FORMAT, deviceId: 'B' })));
  const batches = [];
  const client = {
    getGist: async () => ({ id: 'g', history: history.map((version) => ({ version })) }),
    fileContent: async (gist, name) => files.get(name) ?? null,
    updateGist: async (id, batch) => {
      batches.push(batch);
      for (const [n, f] of Object.entries(batch)) (f ? files.set(n, f.content) : files.delete(n));
      history.unshift(`v${history.length + 1}`);
    },
  };
  const merged = [];
  const store = {
    deviceId: 'A',
    device: { sync: { gistId: 'g' } },
    async mergeIn(ds) {
      merged.push(ds);
      return { report: { newEvents: 0, conflicts: [], autoMerged: 0 } };
    },
    // This device has one review of its own to upload.
    exportDataset: async () => ({ ...emptyDataset(), events: [ev('mine', 'c:fwd', Date.UTC(2026, 2, 1))], media: merged.at(-1)?.media || [] }),
    async setDevice(patch) {
      this.device = { ...this.device, ...patch };
    },
  };
  const svc = new SyncService(store);
  svc.token = 'not-a-real-token';
  svc.client = () => client;
  const result = await svc.sync({ reason: 'manual' });
  assert.deepEqual(merged[0].media.map((m) => m.id), ['sha256-good'], 'refused media are not merged');
  assert.deepEqual(result.pulled.rejectedMedia.map((r) => r.id).sort(), ['sha256-huge', 'sha256-svg']);
  assert.equal(result.pulled.newlyRejected.length, 2);
  assert.match(svc.status.message, /2 image or audio files in the Gist were not imported \(.*unsupported media type image\/svg\+xml.*too large/);
  // The upload neither deletes nor unlists them.
  assert.ok(batches.length, 'this device uploaded its review');
  assert.ok(batches.every((b) => !Object.keys(b).some((n) => n.includes('sha256-svg') || n.includes('sha256-huge'))));
  const manifest = await open(JSON.parse(files.get(MANIFEST_FILE)));
  assert.ok(manifest.files['axon-media-sha256-svg.json'] && manifest.files['axon-media-sha256-huge.json']);
  // Reported once as new; later syncs still say so in the status.
  const again = await svc.sync({ reason: 'manual' });
  assert.equal(again.pulled.newlyRejected.length, 0);
  assert.match(svc.status.message, /not imported/);
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
