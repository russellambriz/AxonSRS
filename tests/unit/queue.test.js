// Spec 17.7 and 17.9: sibling spacing across reverse cards and cloze groups;
// daily limits and catch-up sessions preserving real due dates; postpone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyQueue, buildCramQueue, buildDrillQueue, buildSpeedQueue, buildInterleaveQueue, spreadSiblings, siblingGroups, applySiblingSpacing, planPostpone, unitStatus, weaknessScore, requeuePosition } from '../../js/core/queue.js';
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
  const p1 = requeuePosition(20, 5, { seed: 'x' });
  assert.equal(p1, requeuePosition(20, 5, { seed: 'x' }));
  assert.ok(p1 >= 9 && p1 <= 12);
  assert.equal(requeuePosition(6, 5, { seed: 'x' }), 6);
});
