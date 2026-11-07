// Automatic Typing/Pencil switching, the auto-advancing correction trace and
// the handwriting measurements on a review, on the real study screen in
// jsdom (see env.mjs). Pencil feel and timing still need a real iPad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshSession, open, reload, click, type, input, phase, strokes, inkMode, waitSaved, waitFor, sleep, q, storedSession, store } from './helpers.mjs';
import { local } from '../../js/ui/local.js';
import { AUTO_MODALITY_KEY } from '../../js/study/modality.js';
import { TRACE } from '../../js/core/ink.js';

const CHECK_INK = 'Check your handwritten answer';
const answers = async (unitId) => (await store.eventsForUnit(unitId)).filter((e) => e.type === 'review' || e.type === 'practice');

const pen = (target, name, { x = 300, y = 130, buttons = name === 'pointerup' || name === 'pointermove-hover' ? 0 : 1, id = 9 } = {}) =>
  target.dispatchEvent(new PointerEvent(name === 'pointermove-hover' ? 'pointermove' : name, { pointerId: id, pointerType: 'pen', clientX: x, clientY: y, buttons, button: 0, pressure: 0.5, bubbles: true, cancelable: true }));

/** A pen stroke drawn densely across the pad, from x0 to x1 at height y. */
function penStroke(x0, x1, y = 130, id = 9) {
  const c = q('.ink-canvas');
  pen(c, 'pointerdown', { x: x0, y, id });
  for (let i = 1; i <= 40; i++) pen(c, 'pointermove', { x: x0 + ((x1 - x0) * i) / 40, y, id });
  pen(c, 'pointerup', { x: x1, y, id });
}

test('the nib touching the page in typing mode opens the pad, keeps the stroke it started, and keeps the typed text', async () => {
  local.set('axon-ink-mode', '0');
  const id = await freshSession([['Capital of France', 'Paris'], ['Largest planet', 'Jupiter']]);
  const { handle } = await open(id);
  type('Par');
  await waitSaved();
  assert.equal(inkMode(), false);
  // The pencil lands on the card (not on a button or the answer box).
  const stage = q('.study-stage');
  pen(stage, 'pointerdown', { x: 300, y: 130 });
  assert.equal(inkMode(), true, 'the pad opened under the pencil');
  const c = q('.ink-canvas');
  for (let i = 1; i <= 5; i++) pen(c, 'pointermove', { x: 300 + i * 4, y: 130 });
  pen(c, 'pointerup', { x: 320, y: 130 });
  assert.equal(strokes(), 1, 'the first stroke was not lost');
  await waitSaved();
  const draft = (await storedSession(id)).draft;
  assert.equal(draft.mode, 'write');
  assert.equal(draft.text, 'Par', 'switching is not erasing');
  assert.equal(draft.ink.strokes.length, 1);
  await reload();
  assert.equal(inkMode(), true);
  assert.equal(strokes(), 1);
  assert.equal(input().value, 'Par');
  assert.ok(handle);
});

test('pencil hover opens the pad only with an empty box and no key for 3 s; a letter on an empty pad goes back to typing', async () => {
  local.set('axon-ink-mode', '0');
  const id = await freshSession([['Capital of France', 'Paris'], ['Largest planet', 'Jupiter']]);
  const { handle } = await open(id);
  const stage = q('.study-stage');
  type('P');
  pen(stage, 'pointermove-hover');
  assert.equal(inkMode(), false, 'text in the box');
  input().value = '';
  input().dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  pen(stage, 'pointermove-hover');
  assert.equal(inkMode(), false, 'a key was pressed just now');
  handle.screen.modality.lastKeyAt = performance.now() - 3001;
  pen(stage, 'pointermove-hover');
  assert.equal(inkMode(), true, 'hovering after the cooldown opens the pad');
  // A letter typed on the empty pad goes back to the keyboard.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }));
  assert.equal(inkMode(), false);
  assert.equal(document.activeElement, input(), 'the box is focused for the letter');
  // Ink on the pad stays put.
  click('Write');
  penStroke(100, 140);
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }));
  assert.equal(inkMode(), true, 'ink on the page: a key does not switch');
});

test('with automatic switching off, the pencil leaves the mode alone', async () => {
  local.set('axon-ink-mode', '0');
  local.set(AUTO_MODALITY_KEY, '0');
  try {
    const id = await freshSession([['Capital of France', 'Paris']]);
    await open(id);
    pen(q('.study-stage'), 'pointerdown');
    pen(q('.study-stage'), 'pointerup');
    assert.equal(inkMode(), false);
  } finally {
    local.remove(AUTO_MODALITY_KEY);
  }
});

test('a handwritten review records capped scalar measurements and the grade you chose', async () => {
  local.set('axon-ink-mode', '1');
  const id = await freshSession([['Capital of France', 'Paris'], ['Largest planet', 'Jupiter']]);
  const { handle } = await open(id);
  const unitId = (await storedSession(id)).queue[0];
  penStroke(100, 160);
  click('Undo stroke');
  penStroke(100, 160);
  click(CHECK_INK);
  await waitFor(() => phase() === 'grading', { what: 'the self-check' });
  await handle.screen.selfAssess('correct', 3);
  await waitFor(() => ['feedback', 'retype'].includes(phase()), { what: 'feedback' });
  const [ev] = await answers(unitId);
  assert.equal(ev.rating, 3, 'Correct on my own is Good, whatever the timing');
  assert.equal(ev.ink.strokes, 2);
  assert.equal(ev.ink.undoCount, 1);
  assert.ok(ev.ink.ttfsMs >= 0 && ev.ink.ttfsMs <= 30000);
  assert.deepEqual(Object.keys(ev.ink).sort(), ['clearCount', 'eraseCount', 'hesitationGaps', 'strokes', 'ttfsCapped', 'ttfsMs', 'undoCount']);
  assert.equal(JSON.stringify(ev).includes('"pts"'), false, 'no stroke points in the review event');
  assert.equal(JSON.stringify(localStorage).includes('"pts"'), false, 'none in localStorage either');
});

test('tracing a missed answer moves on by itself once covered, and writing again holds it', async () => {
  local.set('axon-ink-mode', '1');
  const id = await freshSession([['Capital of France', 'Paris'], ['Largest planet', 'Jupiter']]);
  const { handle } = await open(id);
  const unitId = (await storedSession(id)).queue[0];
  penStroke(100, 130);
  click(CHECK_INK);
  await waitFor(() => phase() === 'grading');
  await handle.screen.selfAssess('incorrect');
  await waitFor(() => phase() === 'retype', { what: 'the correction trace' });
  await waitFor(() => handle.screen.ink.el.dataset.ghost === '1', { what: 'the trace model' });
  const box = handle.screen.ink.ghostBox();
  assert.ok(box && box.right > box.left, 'the pad knows where the model sits');
  const midY = (box.top + box.bottom) / 2;
  // Covering only the left part does nothing.
  penStroke(box.left, (box.left + box.right) / 2, midY);
  await sleep(TRACE.shortAdvanceMs + 100);
  assert.equal(phase(), 'retype');
  // Covering the rest arms the advance; a new stroke before it fires holds it.
  penStroke(box.left - 10, box.right + 10, midY);
  await sleep(100);
  const c = q('.ink-canvas');
  pen(c, 'pointerdown', { x: box.left, y: midY });
  await sleep(TRACE.shortAdvanceMs + 100);
  assert.equal(phase(), 'retype', 'still writing: not cut off');
  pen(c, 'pointerup', { x: box.left + 2, y: midY });
  await waitFor(() => phase() !== 'retype', { timeout: 3000, what: 'the trace to finish by itself' });
  const events = await store.eventsForUnit(unitId);
  assert.equal(events.filter((e) => e.type === 'review').length, 1, 'the trace is never a second review');
  assert.ok(events.some((e) => e.type === 'copy' && !e.data?.bypassed), 'the copy is recorded');
});
