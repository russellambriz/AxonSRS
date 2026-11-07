// Acceptance matrix 5–20 for unfinished answers (drafts), run against the
// real study screen in jsdom with fake IndexedDB. Each test starts a fresh
// deck and session. 1–4 are in drafts-reproduced.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPadBox } from './env.mjs';
import {
  freshSession, open, reload, click, button, type, setText, input, pressed, prompt, phase, stroke, strokes,
  toolDisabled, inkMode, saveState, waitSaved, waitFor, sleep, q, storedSession, store, app,
} from './helpers.mjs';
import { DraftKeeper } from '../../js/study/drafts.js';
import { currentAttempt } from '../../js/core/draft.js';

const SUBMIT = 'Submit answer';
const CHECK_INK = 'Check your handwritten answer';

/** Replace a store method for one test; returns a restore function. */
function patch(name, fn) {
  const orig = store[name];
  store[name] = fn(orig.bind(store));
  return () => { store[name] = orig; };
}

const answers = async (unitId) => (await store.eventsForUnit(unitId)).filter((e) => e.type === 'review' || e.type === 'practice');
const firstUnit = async (id) => (await storedSession(id)).queue[0];

test('5: Resume with confidence unset keeps it unset', async () => {
  const id = await freshSession();
  await open(id);
  type('SO4');
  await waitSaved();
  await reload();
  assert.equal(input().value, 'SO4');
  assert.deepEqual(pressed(), [], 'no confidence is invented');
  assert.equal((await storedSession(id)).draft.confidence, null);
});

test('6: editing a saved typed draft: the latest value returns after reload', async () => {
  const id = await freshSession();
  await open(id);
  type('SO3');
  await waitSaved();
  setText('SO4^2');
  await waitSaved();
  await reload();
  assert.equal(input().value, 'SO4^2');
});

test('7: deleting all typed text: the deleted value does not reappear', async () => {
  const id = await freshSession();
  await open(id);
  type('SO4^');
  await waitSaved();
  setText('');
  await waitSaved();
  await reload();
  assert.equal(input().value, '');
});

test('8: an undone stroke stays undone after a mode switch and a reload', async () => {
  const id = await freshSession();
  await open(id);
  click('Write');
  stroke({ dx: 0, dy: 60 });
  stroke({ x: 80, dx: 40, dy: 0 });
  click('Undo stroke');
  assert.equal(strokes(), 1);
  click('Type');
  click('Write');
  assert.equal(strokes(), 1);
  await waitSaved();
  await reload();
  assert.equal(strokes(), 1);
});

test('9: cleared ink stays clear after reload', async () => {
  const id = await freshSession();
  await open(id);
  click('Write');
  stroke();
  stroke({ x: 90 });
  await waitSaved();
  click('Clear');
  assert.equal(strokes(), 0);
  await waitSaved();
  await reload();
  assert.ok(inkMode());
  assert.equal(strokes(), 0);
});

test('10: restored ink plus new strokes: both are saved', async () => {
  const id = await freshSession();
  await open(id);
  click('Write');
  stroke({ x: 30 });
  await waitSaved();
  await reload();
  assert.equal(strokes(), 1);
  stroke({ x: 120 });
  assert.equal(strokes(), 2);
  await waitSaved();
  await reload();
  assert.equal(strokes(), 2);
  const pts = (await storedSession(id)).draft.ink.strokes.map((s) => s.pts[0].x);
  assert.equal(pts.length, 2);
  assert.ok(pts[0] < pts[1], 'old stroke first, new stroke second');
});

test('11: resize and remount keep ink geometry and it stays editable', async () => {
  const id = await freshSession();
  const { handle } = await open(id);
  click('Write');
  stroke({ x: 50, y: 40, dx: 0, dy: 50 });
  await waitSaved();
  const before = (await storedSession(id)).draft.ink.strokes;
  setPadBox({ width: 420, height: 220 });
  try {
    handle.screen.ink.resize();
    assert.equal(strokes(), 1, 'resize keeps the stroke');
    assert.equal(toolDisabled('Undo stroke'), false);
    await reload(); // remount at the new size
    assert.equal(strokes(), 1);
    const after = (await storedSession(id)).draft.ink.strokes;
    assert.deepEqual(after.map((s) => s.pts.map((p) => [p.x, p.y])), before.map((s) => s.pts.map((p) => [p.x, p.y])), 'same CSS-pixel points');
    click('Undo stroke');
    assert.equal(strokes(), 0, 'restored ink is still editable');
  } finally {
    setPadBox({ width: 600, height: 300 });
  }
});

test('12: a forced save failure never shows Saved and keeps the work in memory', async () => {
  const id = await freshSession();
  await open(id);
  const restore = patch('saveDraft', () => async () => { throw new Error('QuotaExceededError'); });
  try {
    type('SO4^');
    await waitFor(() => saveState() === 'error', { what: 'Couldn’t save' });
    assert.match(q('.draft-state').textContent, /Couldn’t save/);
    assert.equal(input().value, 'SO4^', 'the typed answer is still there');
    click('Unsure');
    await waitFor(() => saveState() === 'error');
    assert.notEqual(saveState(), 'saved');
  } finally {
    restore();
  }
  click('Retry', '.draft-state');
  await waitSaved();
  await reload();
  assert.equal(input().value, 'SO4^');
  assert.deepEqual(pressed(), ['Unsure']);
});

test('13: out-of-order delayed writes: the newest revision wins', async () => {
  const id = await freshSession();
  await open(id);
  const order = [];
  let n = 0;
  const restore = patch('saveDraft', (orig) => async (sid, rec, opts) => {
    const mine = ++n;
    if (mine === 1) await sleep(150); // the first write is slow
    const res = await orig(sid, rec, opts);
    order.push([mine, rec.text, res.status]);
    return res;
  });
  try {
    type('S');
    click('Unsure'); // immediate write #1, delayed
    type('O4');
    click('Confident'); // edits made while #1 is in flight
    await waitSaved();
  } finally {
    restore();
  }
  const d = (await storedSession(id)).draft;
  assert.equal(d.text, 'SO4');
  assert.equal(d.confidence, 'confident');
  assert.ok(order.every(([, , st]) => st === 'saved'), JSON.stringify(order));
  assert.deepEqual(order.map(([m]) => m), [...order.map(([m]) => m)].sort((a, b) => a - b), 'writes land in order');
  // At the store, a write with an old revision is refused rather than landing.
  const stale = await store.saveDraft(id, { ...d, text: 'S' }, { baseRev: 1 });
  assert.equal(stale.status, 'conflict');
  assert.equal((await storedSession(id)).draft.text, 'SO4');
  await reload();
  assert.equal(input().value, 'SO4');
});

test('14: a late restore for attempt A cannot populate attempt B', async () => {
  const id = await freshSession();
  const { handle } = await open(id);
  type('SO4^');
  await waitSaved();
  const draftA = await store.getDraft(id);
  await handle.screen.skip(); // the session moves to card B
  await waitFor(() => phase() === 'question' && prompt() !== 'Formula of the sulfate ion', { what: 'card B' });
  assert.equal(await store.getDraft(id), null, 'moving on retired A’s draft');
  // A delayed read that resolves with A's draft while B is on screen.
  const restore = patch('getDraft', () => async () => { await sleep(50); return draftA; });
  try {
    await reload();
  } finally {
    restore();
  }
  assert.notEqual(prompt(), 'Formula of the sulfate ion');
  assert.equal(input().value, '', 'A’s text is not shown on B');
  assert.deepEqual(pressed(), []);
  // A late write for A is refused too.
  const late = await store.saveDraft(id, { ...draftA, text: 'late' }, { baseRev: draftA.rev });
  assert.equal(late.status, 'consumed');
});

test('15: submit then reload: no draft comes back and the review is recorded once', async () => {
  const id = await freshSession();
  await open(id);
  const unitId = await firstUnit(id);
  type('SO4^2-');
  await waitSaved();
  click(SUBMIT);
  await waitFor(() => ['feedback', 'retype'].includes(phase()), { what: 'feedback' });
  assert.equal((await storedSession(id)).draft, undefined, 'the draft is retired with the review');
  await reload();
  assert.notEqual(prompt(), 'Formula of the sulfate ion');
  assert.equal(input().value, '');
  assert.equal((await answers(unitId)).length, 1);
});

test('16: a failed submission leaves the draft recoverable', async () => {
  const id = await freshSession();
  await open(id);
  const unitId = await firstUnit(id);
  type('SO4^2-');
  click('Confident');
  const restore = patch('commitReview', () => async () => { throw new Error('disk full'); });
  try {
    click(SUBMIT);
    await waitFor(() => phase() === 'error', { what: 'the save error' });
  } finally {
    restore();
  }
  assert.equal((await answers(unitId)).length, 0);
  const d = (await storedSession(id)).draft;
  assert.equal(d.text, 'SO4^2-');
  assert.equal(d.stage, 'answering');
  localStorage.removeItem('axon-pending-review');
  await reload();
  assert.equal(prompt(), 'Formula of the sulfate ion');
  assert.equal(input().value, 'SO4^2-');
  assert.deepEqual(pressed(), ['Confident']);
});

test('17: a legacy dataset and repeated start-up keep schedules and history', async () => {
  const id = await freshSession();
  await open(id);
  const unitId = await firstUnit(id);
  type('SO4^2-');
  click(SUBMIT);
  await waitFor(() => ['feedback', 'retype'].includes(phase()));
  const unitBefore = (await store.listUnits()).find((u) => u.id === unitId);
  const eventsBefore = (await store.allEvents()).length;
  // A session saved by an older app: no draft field at all.
  const s = await storedSession(id);
  const { draft: _none, ...legacy } = s;
  await store.tx(['sessions'], 'readwrite', (t) => t.put('sessions', legacy));
  await store.init();
  await store.init(); // repeat-safe
  await app.cache.load();
  const unitAfter = (await store.listUnits()).find((u) => u.id === unitId);
  assert.deepEqual(unitAfter.state, unitBefore.state);
  assert.equal(unitAfter.headEventId, unitBefore.headEventId);
  assert.equal((await store.allEvents()).length, eventsBefore);
  assert.equal(await store.getDraft(id), null);
  // The legacy session still studies and saves drafts.
  await reload();
  type('Par');
  await waitSaved();
  assert.equal((await store.getDraft(id)).text, 'Par');
  // A draft written by a newer app version is left alone, not misread.
  const raw = (await storedSession(id)).draft;
  await store.tx(['sessions'], 'readwrite', async (t) => t.put('sessions', { ...(await t.get('sessions', id)), draft: { ...raw, v: 99 } }));
  assert.equal(await store.getDraft(id), null);
});

test('18: two tabs on one attempt: a stale tab is refused, the learner chooses with Retry', async () => {
  const id = await freshSession();
  await open(id);
  const session = await storedSession(id);
  const key = currentAttempt(session).key;
  const make = () => new DraftKeeper({ key, debounceMs: 0, save: (r, b) => store.saveDraft(id, r, { baseRev: b }) });
  const tab1 = make();
  const tab2 = make();
  tab1.hydrate(null);
  tab2.hydrate(null);
  tab1.update({ text: 'from tab 1' });
  assert.equal(await tab1.flush(), true);
  tab2.update({ text: 'from tab 2' });
  assert.equal(await tab2.flush(), false);
  assert.equal(tab2.status, 'conflict');
  assert.equal((await store.getDraft(id)).text, 'from tab 1', 'the stale tab did not overwrite');
  assert.equal(await tab2.retry(), true);
  assert.equal((await store.getDraft(id)).text, 'from tab 2', 'Retry keeps this tab’s answer');
  // The screen side: once another tab takes the study lock, this one stops writing.
  const { handle } = await reload();
  handle.screen.lockLost();
  const rev = (await store.getDraft(id)).rev;
  handle.screen.drafts.update({ text: 'after losing the lock' });
  await sleep(300);
  assert.equal((await store.getDraft(id)).rev, rev);
});

test('19: restoring a draft changes no review counts, events or schedule', async () => {
  const id = await freshSession([
    ['Formula of the sulfate ion', 'SO4^2-', { answerMode: 'chem', hint: 'Four oxygens' }],
    ['Capital of France', 'Paris'],
  ]);
  const { handle } = await open(id);
  const unitId = await firstUnit(id);
  handle.screen.showHint();
  type('SO4');
  click('Unsure');
  await waitSaved();
  const unitBefore = (await store.listUnits()).find((u) => u.id === unitId);
  const eventsBefore = await store.eventsForUnit(unitId);
  const sessionBefore = await storedSession(id);
  await reload();
  await reload();
  assert.equal(input().value, 'SO4');
  const now = (await import('./helpers.mjs')).current_();
  assert.equal(now.handle.screen.hintEl.hidden, false, 'the hint shown before is shown again');
  assert.match(now.handle.screen.hintEl.textContent, /Four oxygens/);
  const unitAfter = (await store.listUnits()).find((u) => u.id === unitId);
  assert.deepEqual(unitAfter.state, unitBefore.state);
  assert.deepEqual((await store.eventsForUnit(unitId)).map((e) => e.id), eventsBefore.map((e) => e.id), 'no new hint, reveal or abandon events');
  const sessionAfter = await storedSession(id);
  assert.equal(sessionAfter.index, sessionBefore.index);
  assert.deepEqual(sessionAfter.results || [], sessionBefore.results || []);
  // The submitted review still records the help used before the reload.
  setText('SO4^2-');
  click(SUBMIT);
  await waitFor(() => ['feedback', 'retype'].includes(phase()));
  const reviews = await answers(unitId);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].assistance.hintShown, true, 'help used before the reload still counts');
  assert.equal(reviews[0].outcome.confidence, 'unsure');
});

test('20: a wrong handwritten answer still traces, and the trace stays out of the answer', async () => {
  // Plain-text answers get a model to trace (chemistry notation does not).
  const id = await freshSession([['Capital of France', 'Paris'], ['Largest planet', 'Jupiter']]);
  const { handle } = await open(id);
  const unitId = await firstUnit(id);
  click('Write');
  stroke({ x: 40, dx: 0, dy: 60 });
  await waitSaved();
  const answerStrokes = (await storedSession(id)).draft.ink.strokes.length;
  click(CHECK_INK);
  await waitFor(() => phase() === 'grading', { what: 'the self-check' });
  assert.equal((await storedSession(id)).draft.stage, 'exposed', 'the answer showed: the draft is no longer restorable');
  await handle.screen.selfAssess('incorrect');
  await waitFor(() => phase() === 'retype', { what: 'the correction trace' });
  await waitFor(() => handle.screen.ink.el.dataset.ghost === '1', { what: 'the trace model on the pad' });
  assert.equal(strokes(), 0, 'the pad is cleared for the trace');
  assert.equal(handle.screen.current.ink.strokes, answerStrokes, 'the original answer is kept apart');
  assert.ok(q('img.ink-answer'), 'the original answer is still shown as your answer');
  stroke({ x: 200, dx: 30, dy: 10 }); // a correction stroke
  assert.equal(strokes(), 1);
  await sleep(300);
  assert.equal((await storedSession(id)).draft, undefined, 'the correction is not saved as a draft');
  const reviews = await answers(unitId);
  assert.equal(reviews.length, 1, 'one review, the original answer');
  assert.equal(handle.screen.current.ink.strokes, answerStrokes, 'the correction stroke did not join the original answer');
  assert.equal(handle.screen.ink.el.dataset.ghost === '0', false, 'the trace model is still there');
  assert.equal(reviews[0].assistance.priorExposure ?? false, false);
  assert.notEqual(reviews[0].outcome.independent, true, 'a wrong answer is not independent recall');
});

test('12b: Pause and leave with an unsaved answer asks first, and Stay keeps it', async () => {
  const id = await freshSession();
  await open(id);
  const restore = patch('saveDraft', () => async () => { throw new Error('QuotaExceededError'); });
  try {
    type('SO4^');
    app.__navigated = null;
    click('Pause and leave');
    const dialog = await waitFor(() => [...document.querySelectorAll('dialog')].find((d) => /Leave without saving your answer/.test(d.textContent)), { what: 'the unsaved-answer question' });
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Stay').click();
    await sleep(50);
    assert.equal(app.__navigated, null, 'Stay does not leave');
    assert.equal(phase(), 'question');
    assert.equal(input().value, 'SO4^');
  } finally {
    restore();
  }
  // Pause after the store recovers: the overlay says the answer is saved.
  click('Retry', '.draft-state');
  await waitSaved();
  const { handle } = (await import('./helpers.mjs')).current_();
  await handle.screen.pause();
  assert.match([...document.querySelectorAll('dialog')].pop().textContent, /unfinished answer are saved/);
});
