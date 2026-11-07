// Typing / Pencil switching decisions and the handwriting measurements kept with a review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModalityController, InkTelemetry, HOVER_COOLDOWN_MS, AFK_CAP_MS, HESITATION_GAP_MS } from '../../js/study/modality.js';
import { inkRecord } from '../../js/core/review.js';

const clock = (start = 10000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};
// Enough of an element for closest(): a control or not.
const plain = { closest: () => null };
const control = { closest: () => ({}) };
const typing = { enabled: true, usingInk: false, canSwitch: true, typedEmpty: true };
const hover = (target = plain) => ({ pointerType: 'pen', buttons: 0, target });
const nib = (target = plain) => ({ pointerType: 'pen', buttons: 1, button: 0, target });

test('pencil hover opens the pad only after 3 s without a key press', () => {
  const c = clock();
  const m = new ModalityController({ now: c.now });
  assert.equal(m.shouldOpenOnHover(hover(), typing), true, 'no key yet');
  m.noteKey({ key: 'a' });
  assert.equal(m.shouldOpenOnHover(hover(), typing), false, 'just typed');
  c.advance(HOVER_COOLDOWN_MS - 1);
  assert.equal(m.shouldOpenOnHover(hover(), typing), false);
  c.advance(2);
  assert.equal(m.shouldOpenOnHover(hover(), typing), true);
  m.noteKey({ key: 'Shift' });
  assert.equal(m.shouldOpenOnHover(hover(), typing), true, 'a modifier alone does not restart the cooldown');
});

test('hover never switches with text in the box, over a control, or for a finger, a mouse or a pressed nib', () => {
  const m = new ModalityController({ now: clock().now });
  assert.equal(m.shouldOpenOnHover(hover(), { ...typing, typedEmpty: false }), false);
  assert.equal(m.shouldOpenOnHover(hover(control), typing), false, 'the answer box keeps Scribble');
  assert.equal(m.shouldOpenOnHover({ ...hover(), pointerType: 'touch' }, typing), false);
  assert.equal(m.shouldOpenOnHover({ ...hover(), pointerType: 'mouse' }, typing), false);
  assert.equal(m.shouldOpenOnHover(nib(), typing), false);
  assert.equal(m.shouldOpenOnHover(hover(), { ...typing, enabled: false }), false, 'setting off');
  assert.equal(m.shouldOpenOnHover(hover(), { ...typing, canSwitch: false }), false, 'feedback, retype or a handwriting card');
  assert.equal(m.shouldOpenOnHover(hover(), { ...typing, usingInk: true }), false);
});

test('the nib touching down always opens the pad, even right after typing and with text in the box', () => {
  const m = new ModalityController({ now: clock().now });
  m.noteKey({ key: 'x' });
  assert.equal(m.shouldOpenOnPenDown(nib(), { ...typing, typedEmpty: false }), true);
  assert.equal(m.shouldOpenOnPenDown(nib(control), typing), false, 'a tap on a button or the answer box is left to it');
  assert.equal(m.shouldOpenOnPenDown({ ...nib(), pointerType: 'touch' }, typing), false);
  assert.equal(m.shouldOpenOnPenDown({ ...nib(), button: 5 }, typing), false, 'the barrel eraser or a side button');
  assert.equal(m.shouldOpenOnPenDown(nib(), { ...typing, usingInk: true }), false);
});

test('a printable key on an empty pad goes back to typing', () => {
  const m = new ModalityController({ now: clock().now });
  const ink = { ...typing, usingInk: true, inkEmpty: true };
  const key = (k, extra = {}) => ({ key: k, target: plain, ...extra });
  assert.equal(m.shouldTypeOnKey(key('q'), ink), true);
  assert.equal(m.shouldTypeOnKey(key('é'), ink), true);
  assert.equal(m.shouldTypeOnKey(key('q'), { ...ink, inkEmpty: false }), false, 'ink on the page stays');
  assert.equal(m.shouldTypeOnKey(key('Enter'), ink), false);
  assert.equal(m.shouldTypeOnKey(key(' '), ink), false);
  assert.equal(m.shouldTypeOnKey(key('q', { metaKey: true }), ink), false);
  assert.equal(m.shouldTypeOnKey(key('q', { isComposing: true }), ink), false);
  assert.equal(m.shouldTypeOnKey({ key: 'q', target: control }, ink), false, 'typing in another field');
  assert.equal(m.shouldTypeOnKey(key('q'), { ...ink, usingInk: false }), false);
  assert.equal(m.shouldTypeOnKey(key('q'), { ...ink, enabled: false }), false);
});

test('ink telemetry: capped time to first stroke, hesitations, undo/erase/clear counts, numbers only', () => {
  const c = clock();
  const t = new InkTelemetry({ now: c.now });
  t.strokeStarted();
  c.advance(300);
  t.edited('stroke');
  c.advance(HESITATION_GAP_MS + 1);
  t.strokeStarted();
  c.advance(100);
  t.edited('stroke');
  c.advance(500);
  t.strokeStarted();
  t.edited('stroke');
  t.edited('undo');
  t.edited('erase');
  t.edited('clear');
  t.edited('redo');
  const s = t.summary(1234.4);
  assert.deepEqual(s, { ttfsMs: 1234, ttfsCapped: false, strokes: 3, hesitationGaps: 1, undoCount: 1, eraseCount: 1, clearCount: 1 });
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.values(s).every((v) => typeof v === 'number' || typeof v === 'boolean'));
  assert.deepEqual({ ...t.summary(5 * 60000) }, { ...s, ttfsMs: AFK_CAP_MS, ttfsCapped: true }, 'away from the screen reads as 30 s');
  assert.equal(t.summary(NaN).ttfsMs, null, 'no stroke, no time');
  t.reset();
  assert.equal(t.summary(10).strokes, 0);
});

test('the review event keeps only the known scalar fields, never strokes', () => {
  assert.equal(inkRecord(null), null);
  const rec = inkRecord({ ttfsMs: 900.6, ttfsCapped: false, strokes: 2, hesitationGaps: 0, undoCount: 1, eraseCount: 0, clearCount: 0, pts: [{ x: 1, y: 2 }], strokesData: [[1]] });
  assert.deepEqual(rec, { ttfsMs: 901, ttfsCapped: false, strokes: 2, hesitationGaps: 0, undoCount: 1, eraseCount: 0, clearCount: 0 });
  assert.equal(JSON.stringify(rec).includes('pts'), false);
});
