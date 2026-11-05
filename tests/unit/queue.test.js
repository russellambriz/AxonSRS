// Spec 17.7 and 17.9: sibling spacing across reverse cards and cloze groups;
// daily limits and catch-up sessions preserving real due dates; postpone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyQueue, buildCramQueue, buildDrillQueue, buildSpeedQueue, buildInterleaveQueue, spreadSiblings, siblingGroups, applySiblingSpacing, planPostpone, unitStatus, weaknessScore, requeuePosition, orderOcclusionMasks, siblingSafeIndex, unitsForRecall } from '../../js/core/queue.js';
import { createCard, createDeck, unitKeys, unitId } from '../../js/core/model.js';
import { State } from '../../js/core/scheduler.js';

const NOW = Date.UTC(2026, 3, 10, 15);
const DAY_START = Date.UTC(2026, 3, 10, 4);
const DAY_END = Date.UTC(2026, 3, 11, 4);
const TODAY = '2026-04-10';

function world({ cards = 10, direction = 'both', due = true, newPerDay = 20, reviewsPerDay = 9999, siblingSpacing = 'spread', cloze = false, tags = () => [] } = {}) {
  const deck = createDeck({ id: 'd1', name: 'D', settings: { direction, newPerDay, reviewsPerDay, siblingSpacing, siblingGap: 3 } });
  const decksById = new Map([[deck.id, deck]]);
  const cardsById = new Map();
  const units = [];
  for (let i = 0; i < cards; i++) {
    const c = createCard({ id: `c${i}`, deckId: 'd1', front: cloze ? `{{c1::a${i}}} and {{c2::b${i}}}` : `f${i}`, back: `b${i}`, tags: tags(i), createdAt: i });
    cardsById.set(c.id, c);
    for (const key of unitKeys(c, deck)) {
      const state = due ? { due: NOW - (i + 1) * 3600000, state: State.Review, stability: 5 + i, difficulty: 5, reps: 3, lapses: 0, scheduled_days: 5, elapsed_days: 5, learning_steps: 0, last_review: NOW - 6 * 86400000 } : null;
      units.push({ id: unitId(c.id, key), cardId: c.id, deckId: 'd1', key, state, active: true, overlays: {}, perf: { recent: [] } });
    }
  }
  return { deck, decksById, cardsById, units, now: NOW, today: TODAY, dayStart: DAY_START, dayEnd: DAY_END, links: [] };
}

function adjacentSiblings(queue) {
  let n = 0;
  for (let i = 1; i < queue.length; i++) if (queue[i].split(':')[0] === queue[i - 1].split(':')[0]) n++;
  return n;
}

test('status vocabulary keeps suspended, buried, deferred and postponed distinct', () => {
  const w = world({ cards: 1, direction: 'forward' });
  const [u] = w.units;
  const c = w.cardsById.get(u.cardId);
  const ctx = { now: NOW, today: TODAY, dayStart: DAY_START, dayEnd: DAY_END };
  assert.equal(unitStatus(u, c, ctx), 'due');
  assert.equal(unitStatus({ ...u, suspended: true }, c, ctx), 'suspended');
  assert.equal(unitStatus({ ...u, overlays: { buriedUntil: '2026-04-11' } }, c, ctx), 'buried');
  assert.equal(unitStatus({ ...u, overlays: { deferredUntil: '2026-04-11' } }, c, ctx), 'deferred');
  assert.equal(unitStatus({ ...u, overlays: { postponedUntil: '2026-04-20' } }, c, ctx), 'postponed');
  assert.equal(unitStatus({ ...u, overlays: { postponedUntil: '2026-04-10' } }, c, ctx), 'due', 'postponement ends on its day');
  assert.equal(unitStatus({ ...u, state: { ...u.state, due: DAY_START - 1 } }, c, ctx), 'overdue');
});

test('Reverse Recall studies the reverse unit without turning a forward deck around', () => {
  const w = world({ cards: 3, direction: 'forward' });
  const direction = w.deck.settings.direction;
  const rev = w.units.map((u) => ({ ...u, id: u.id.replace(':fwd', ':rev'), key: 'rev', active: false }));
  w.units.push(...rev);
  const base = { ...w, introducedToday: new Map(), reviewedToday: new Map() };
  const normal = buildDailyQueue(base).queue;
  assert.ok(normal.every((id) => id.endsWith(':fwd')));
  assert.equal(normal.length, 3);
  const reverse = buildDailyQueue({ ...base, recall: 'reverse' }).queue;
  assert.deepEqual(reverse.map((id) => id.split(':')[1]), ['rev', 'rev', 'rev']);
  const mixed = buildDailyQueue({ ...base, recall: 'mixed' }).queue;
  assert.equal(mixed.length, 6);
  assert.equal(w.deck.settings.direction, direction);
  assert.ok(w.units.filter((u) => u.key === 'rev').every((u) => u.active === false));
  assert.equal(unitsForRecall(w.units, 'normal').length, w.units.length);
});

test('sibling spacing: forward/reverse directions are never adjacent when avoidable', () => {
  const w = world({ cards: 8 });
  const q = buildDailyQueue({ ...w, introducedToday: new Map(), reviewedToday: new Map() }).queue;
  assert.equal(q.length, 16);
  assert.equal(adjacentSiblings(q), 0);
});

test('sibling spacing: cloze groups from one note are spread out', () => {
  const w = world({ cards: 6, cloze: true });
  const q = buildDailyQueue({ ...w, introducedToday: new Map(), reviewedToday: new Map() }).queue;
  assert.equal(q.length, 12);
  assert.equal(adjacentSiblings(q), 0);
});

test('sibling spacing "next day" defers siblings without touching due dates', () => {
  const w = world({ cards: 4, siblingSpacing: 'nextDay' });
  const before = JSON.stringify(w.units.map((u) => u.state.due));
  const res = buildDailyQueue({ ...w, introducedToday: new Map(), reviewedToday: new Map(), reviewedGroupsToday: new Set(['c0']) });
  assert.equal(res.queue.length, 3, 'one unit per card, card c0 already seen today');
  assert.equal(res.deferred.length, 5);
  assert.ok(res.deferred.every((d) => d.reason === 'sibling-next-day'));
  assert.equal(JSON.stringify(w.units.map((u) => u.state.due)), before);
});

test('manual related links join sibling groups', () => {
  const w = world({ cards: 3, direction: 'forward' });
  w.links = [{ a: 'c0', b: 'c2' }];
  const g = siblingGroups(w.units, w.links);
  assert.equal(g.get('c0:fwd'), g.get('c2:fwd'));
  assert.notEqual(g.get('c0:fwd'), g.get('c1:fwd'));
  assert.equal(siblingGroups(w.units, w.links, { includeLinks: false }).get('c2:fwd'), 'c2');
  const spaced = applySiblingSpacing(w.units, { ...w, decksById: w.decksById });
  assert.notEqual(spaced.queue[0].cardId === 'c0' && spaced.queue[1].cardId === 'c2', true);
});

test('cram can keep related cards together when explicitly requested', () => {
  const w = world({ cards: 4 });
  const together = buildCramQueue(w, { order: 'ordered', keepSiblingsTogether: true }).queue;
  assert.ok(adjacentSiblings(together) > 0);
  const spaced = buildCramQueue(w, { order: 'ordered' }).queue;
  assert.equal(adjacentSiblings(spaced), 0);
});

test('daily new-card limits count cards already introduced today', () => {
  const w = world({ cards: 30, direction: 'forward', due: false, newPerDay: 10 });
  const fresh = buildDailyQueue({ ...w, introducedToday: new Map(), reviewedToday: new Map() });
  assert.equal(fresh.counts.new, 10);
  const later = buildDailyQueue({ ...w, introducedToday: new Map([['d1', 7]]), reviewedToday: new Map() });
  assert.equal(later.counts.new, 3);
  assert.equal(later.counts.newAvailable, 30);
});

test('review limits and catch-up sessions keep real due dates and report the backlog', () => {
  const w = world({ cards: 120, direction: 'forward', reviewsPerDay: 50 });
  const snapshot = JSON.stringify(w.units.map((u) => [u.id, u.state.due]));
  const limited = buildDailyQueue({ ...w, introducedToday: new Map(), reviewedToday: new Map() });
  assert.equal(limited.queue.length, 50);
  assert.equal(limited.backlog, 70);
  const catchUp = buildDailyQueue({ ...w, introducedToday: new Map(), reviewedToday: new Map(), catchUpLimit: 20 });
  assert.equal(catchUp.queue.length, 20);
  assert.equal(catchUp.counts.new, 0, 'catch-up never adds new cards');
  assert.equal(JSON.stringify(w.units.map((u) => [u.id, u.state.due])), snapshot, 'nothing is marked done or moved');
  // most overdue first
  const first = w.units.find((u) => u.id === catchUp.queue[0]);
  assert.equal(first.state.due, Math.min(...w.units.map((u) => u.state.due)));
});

test('postpone/vacation creates overlays only; redistribution spreads the return', () => {
  const w = world({ cards: 30, direction: 'forward' });
  const plan = planPostpone(w, { untilDay: '2026-04-17', untilStart: Date.UTC(2026, 3, 17, 4), mode: 'redistribute', spreadDays: 5, batchId: 'b1' });
  assert.equal(plan.count, 30);
  const days = new Set(plan.changes.map((c) => c.postponedUntil));
  assert.equal(days.size, 5);
  assert.ok([...days].every((d) => d >= '2026-04-17'));
  assert.ok(plan.changes.every((c) => c.batchId === 'b1'));
  const shift = planPostpone(w, { untilDay: '2026-04-17', untilStart: Date.UTC(2026, 3, 17, 4), mode: 'shift', batchId: 'b2' });
  assert.equal(new Set(shift.changes.map((c) => c.postponedUntil)).size, 1);
});

test('drill weakest prioritises failures, low retrievability, slowness and difficulty', () => {
  const w = world({ cards: 5, direction: 'forward' });
  w.units[3].perf = { recent: [{ c: false, h: 2, k: 2 }, { c: false, h: 1.5, k: 1 }] };
  w.units[3].state = { ...w.units[3].state, difficulty: 9 };
  const q = buildDrillQueue(w, { limit: 3, retrievabilityOf: () => 0.8 });
  assert.equal(q.queue[0], w.units[3].id);
  const s = weaknessScore(w.units[3], { retrievability: 0.8 });
  assert.ok(s.components.recentFailures > 0 && s.components.slowRetrieval > 0 && s.components.difficulty > 0);
});

test('speed practice uses only learned cards; interleaving alternates topics', () => {
  const w = world({ cards: 10, direction: 'forward', tags: (i) => [i % 2 ? 'odd' : 'even'] });
  w.units[0].state = null;
  const speed = buildSpeedQueue(w, { limit: 20 });
  assert.ok(!speed.queue.includes(w.units[0].id));
  const inter = buildInterleaveQueue(w, { tags: ['odd', 'even'], limit: 8 });
  const topics = inter.queue.map((id) => (Number(id.slice(1).split(':')[0]) % 2 ? 'odd' : 'even'));
  let switches = 0;
  for (let i = 1; i < topics.length; i++) if (topics[i] !== topics[i - 1]) switches++;
  assert.ok(switches >= topics.length - 3, `topics alternate (${topics.join(',')})`);
});

test('spreadSiblings and requeue positions are deterministic', () => {
  const list = ['a1', 'a2', 'a3', 'b1', 'c1'].map((id) => ({ id, g: id[0] }));
  const out = spreadSiblings(list, (u) => u.g, 2).map((u) => u.id);
  assert.deepEqual(out, ['a1', 'b1', 'c1', 'a2', 'a3']);
  // Siblings bunched at the end are moved up in time to stay apart, in order.
  const bunched = ['x1', 'y1', 'z1', 'w1', 'v1', 'a1', 'a2', 'a3'].map((id) => ({ id, g: id[0] }));
  const spread = spreadSiblings(bunched, (u) => u.g, 1).map((u) => u.id);
  assert.deepEqual(spread.filter((id) => id[0] === 'a'), ['a1', 'a2', 'a3']);
  for (let i = 1; i < spread.length; i++) assert.notEqual(spread[i][0], spread[i - 1][0], spread.join());
  const p1 = requeuePosition(20, 5, { seed: 'x' });
  assert.equal(p1, requeuePosition(20, 5, { seed: 'x' }));
  assert.ok(p1 >= 9 && p1 <= 12);
  assert.equal(requeuePosition(6, 5, { seed: 'x' }), 6);
});

function occlusionWorld({ order = 'random', masks = 5, due = false } = {}) {
  const w = world({ cards: 0 });
  const card = createCard({ id: 'occ', deckId: 'd1', kind: 'occlusion', front: [''], back: [], occlusion: { imageId: 'img', masks: Array.from({ length: masks }, (_, i) => ({ id: `m${i}`, x: 0, y: 0, w: 0.1, h: 0.1, label: [`L${i}`] })), order }, createdAt: 1 });
  w.cardsById.set(card.id, card);
  const state = due ? { due: NOW - 3600000, state: State.Review, stability: 5, difficulty: 5, reps: 3, lapses: 0, scheduled_days: 5, elapsed_days: 5, learning_steps: 0, last_review: NOW - 5 * 86400000 } : null;
  for (const key of unitKeys(card, w.deck)) w.units.push({ id: unitId(card.id, key), cardId: card.id, deckId: 'd1', key, state, active: true, overlays: {}, perf: { recent: [] } });
  return w;
}

test('occlusion masks: random order is seeded per session; fixed order follows the masks', () => {
  const w = occlusionWorld();
  const run = (seed, ctx = w) => buildCramQueue({ ...ctx, seed }, { order: 'ordered', keepSiblingsTogether: true }).queue;
  assert.deepEqual(run('session-1'), run('session-1'), 'stable within one session');
  const orders = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((s) => run(s).join()));
  assert.ok(orders.size > 1, 'differs between sessions');
  assert.equal(new Set(run('a')).size, 5, 'every mask kept once');
  const fixed = occlusionWorld({ order: 'fixed' });
  fixed.units.reverse(); // storage order does not matter
  const inMaskOrder = ['m0', 'm1', 'm2', 'm3', 'm4'].map((m) => `occ:o-${m}`);
  for (const seed of ['a', 'b', 'c']) assert.deepEqual(run(seed, fixed), inMaskOrder);
  // Daily review applies the same rule to due masks (before sibling spacing).
  const due = occlusionWorld({ order: 'fixed', due: true });
  due.units.reverse();
  assert.deepEqual(buildDailyQueue({ ...due, introducedToday: new Map(), reviewedToday: new Map(), seed: 'x' }).queue, inMaskOrder);
  const random = occlusionWorld({ due: true });
  const daily = (seed) => buildDailyQueue({ ...random, introducedToday: new Map(), reviewedToday: new Map(), seed }).queue.join();
  assert.equal(daily('s1'), daily('s1'));
  assert.ok(new Set(['s1', 's2', 's3', 's4', 's5'].map(daily)).size > 1);
});

test('occlusion mask order keeps the places other cards hold', () => {
  const w = occlusionWorld({ masks: 3 });
  w.cardsById.set('x', createCard({ id: 'x', deckId: 'd1', front: 'f', back: 'b' }));
  w.units.splice(1, 0, { id: 'x:fwd', cardId: 'x', deckId: 'd1', key: 'fwd' });
  const out = orderOcclusionMasks(w.units, w.cardsById, 'seed').map((u) => u.id);
  assert.equal(out.length, 4);
  assert.equal(out[1], 'x:fwd');
  assert.deepEqual(out.filter((id) => id !== 'x:fwd').sort(), ['occ:o-m0', 'occ:o-m1', 'occ:o-m2']);
});

test('reinserted cards (requeue, learning step, skip) avoid landing next to a sibling', () => {
  const groupOf = (id) => id.split(':')[0];
  // The current card a:fwd is at 0; its sibling a:rev is at 4.
  const q = ['a:fwd', 'b:fwd', 'c:fwd', 'd:fwd', 'a:rev', 'e:fwd', 'f:fwd', 'g:fwd', 'h:fwd'];
  const at = siblingSafeIndex(q, 4, 'a:fwd', groupOf, { from: 0 });
  assert.ok(at !== 4 && at !== 5 && at > 1, `not next to a:rev or itself (${at})`);
  const spaced = siblingSafeIndex(q, 4, 'a:fwd', groupOf, { from: 0, gap: 2 });
  assert.ok(spaced >= 7 || (spaced >= 2 && spaced <= 3), `two places from a:rev and itself (${spaced})`);
  // Skipped to the end when the last card is a sibling: placed before the
  // card that precedes that sibling.
  const end = ['x:fwd', 'b:fwd', 'c:fwd', 'x:rev'];
  assert.equal(siblingSafeIndex(end, end.length, 'x:fwd', groupOf, { from: 0, min: 2 }), 2);
  // Nothing better: keep the requested place.
  assert.equal(siblingSafeIndex(['x:fwd', 'x:rev'], 2, 'x:fwd', groupOf, { from: 0 }), 2);
  // Cards already done (before `from`) do not count.
  assert.equal(siblingSafeIndex(['x:rev', 'b:fwd', 'c:fwd', 'd:fwd'], 2, 'x:fwd', groupOf, { from: 1 }), 2);
  // A later slot is limited by `max`, then earlier slots are tried.
  const crowded = ['k:fwd', 'b:fwd', 'c:fwd', 'k:rev', 'd:fwd', 'k:x', 'e:fwd', 'f:fwd'];
  assert.equal(siblingSafeIndex(crowded, 3, 'k:fwd', groupOf, { from: 0, max: 4 }), 2);
});

test('sibling spacing follows each unit\'s own deck setting', () => {
  const w = world({ cards: 3 });
  w.decksById.set('d2', createDeck({ id: 'd2', name: 'Off', settings: { direction: 'both', siblingSpacing: 'off' } }));
  for (let i = 0; i < 3; i++) {
    const c = createCard({ id: `o${i}`, deckId: 'd2', front: `o${i}`, back: 'x', createdAt: 10 + i });
    w.cardsById.set(c.id, c);
    for (const key of ['fwd', 'rev']) w.units.push({ id: unitId(c.id, key), cardId: c.id, deckId: 'd2', key, state: null, active: true, overlays: {} });
  }
  // The queue starts with the "off" deck, yet deck d1's siblings are still spread.
  const order = [...w.units.filter((u) => u.deckId === 'd2'), ...w.units.filter((u) => u.deckId === 'd1')];
  const res = applySiblingSpacing(order, w).queue.map((u) => u.id);
  assert.equal(adjacentSiblings(res.filter((id) => id.startsWith('c'))), 0);
  for (let i = 1; i < res.length; i++) if (res[i].startsWith('c')) assert.notEqual(res[i].split(':')[0], res[i - 1].split(':')[0]);
  assert.deepEqual(res.filter((id) => id.startsWith('o')), ['o0:fwd', 'o0:rev', 'o1:fwd', 'o1:rev', 'o2:fwd', 'o2:rev'], 'the "off" deck keeps its order');
});

test('interleaving honours the related-cards switch, deck spacing and an explicit gap', () => {
  const w = world({ cards: 12, direction: 'forward' });
  w.links = [{ a: 'c0', b: 'c2' }, { a: 'c2', b: 'c4' }];
  const linked = (id) => ['c0', 'c2', 'c4'].includes(id.split(':')[0]);
  const together = (q) => q.filter((id, i) => i > 0 && linked(id) && linked(q[i - 1])).length;
  let unspaced = 0;
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const raw = buildInterleaveQueue({ ...w, seed }, { deckIds: ['d1'], limit: 12, gap: 0 }).queue;
    unspaced += together(raw);
    const q = buildInterleaveQueue({ ...w, seed, relatedSpacing: true }, { deckIds: ['d1'], limit: 12, gap: 1 }).queue;
    assert.equal(together(q), 0, `linked cards kept apart, also at the end (${q.join(',')})`);
    // Related-card spacing switched off: the links do not join groups, so
    // (one direction per card) the order is left as it came.
    assert.deepEqual(buildInterleaveQueue({ ...w, seed, relatedSpacing: false }, { deckIds: ['d1'], limit: 12 }).queue, raw);
  }
  assert.ok(unspaced > 0, 'without spacing some linked cards were adjacent');
  // Deck sibling spacing "off" leaves directions as they come.
  const off = world({ cards: 4, siblingSpacing: 'off' });
  const plain = buildInterleaveQueue({ ...off, seed: 'z' }, { deckIds: ['d1'], limit: 8, gap: 0 }).queue;
  assert.deepEqual(buildInterleaveQueue({ ...off, seed: 'z' }, { deckIds: ['d1'], limit: 8 }).queue, plain);
  // "Next day" in a practice session spreads instead of deferring.
  const next = world({ cards: 4, siblingSpacing: 'nextDay' });
  const res = buildInterleaveQueue({ ...next, seed: 'z', reviewedGroupsToday: new Set(['c0']) }, { deckIds: ['d1'], limit: 8 });
  assert.equal(res.queue.length, 8, 'nothing deferred in practice');
  assert.equal(adjacentSiblings(res.queue), 0);
});
