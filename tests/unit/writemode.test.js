// Write Mode: the control defaults on, edge chrome follows the pencil tip,
// and enter/exit restores the view without rewriting strokes or undo history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeOnPointer, contentPoint, createWriteSession, CHROME_DELAY_MS, PROMPT_HOLD_MS, writeModeControlEnabled } from '../../js/ui/writemode.js';

test('Write Mode control is on unless this device turned it off', () => {
  assert.equal(writeModeControlEnabled(null), true);
  assert.equal(writeModeControlEnabled(undefined), true);
  assert.equal(writeModeControlEnabled(''), true);
  assert.equal(writeModeControlEnabled('1'), true);
  assert.equal(writeModeControlEnabled('0'), false);
});

test('pen tip down hides the edge chrome and the lift shows it after a short delay', () => {
  assert.equal(CHROME_DELAY_MS, 220);
  assert.equal(PROMPT_HOLD_MS, 1200);
  assert.deepEqual(chromeOnPointer({ type: 'pen', phase: 'down', buttons: 1 }), { chrome: 'hidden', delay: 0 });
  assert.equal(chromeOnPointer({ type: 'pen', phase: 'down', buttons: 0 }), null);
  assert.deepEqual(chromeOnPointer({ type: 'pen', phase: 'up', buttons: 0 }), { chrome: 'shown', delay: 220 });
  assert.deepEqual(chromeOnPointer({ type: 'pen', phase: 'cancel' }), { chrome: 'shown', delay: 220 });
  assert.deepEqual(
    chromeOnPointer({ type: 'pen', phase: 'up', reducedMotion: true }),
    { chrome: 'shown', delay: 0 },
  );
  assert.equal(chromeOnPointer({ type: 'mouse', phase: 'down', buttons: 1 }), null);
  assert.equal(chromeOnPointer({ type: 'touch', phase: 'down', buttons: 1 }), null);
  assert.equal(chromeOnPointer({ type: 'touch', phase: 'up' }), null);
});

test('content space matches the canvas offset, including a stored zoom and pan', () => {
  const rect = { left: 100, top: 40 };
  assert.deepEqual(contentPoint({ x: 150, y: 80 }, rect, { zoom: 1, panX: 0, panY: 0 }), { x: 50, y: 40 });
  assert.deepEqual(contentPoint({ x: 110, y: 50 }, rect, { zoom: 2, panX: 10, panY: -4 }), { x: 0, y: 7 });
});

test('enter and exit restore zoom, pan and scroll and do not rewrite strokes or undo history', () => {
  const point = { x: 12, y: 18, p: 0.4, scale: 1 };
  const stroke = { color: '#22303c', pts: [point, { x: 40, y: 22, p: 0.8 }] };
  const history = [{ kind: 'add', stroke }];
  const redo = [{ kind: 'erase', items: [] }];
  const state = {
    view: { zoom: 1.25, panX: 6, panY: -3 },
    strokes: [stroke],
    history,
    redo,
  };
  const session = createWriteSession(state);
  const layout = session.enter({ scrollX: 4, scrollY: 90, scrolls: [{ top: 48, left: 2 }] });
  assert.equal(session.isOpen(), true);
  assert.equal(layout.view.zoom, 1.25);
  assert.equal(layout.scrollY, 90);
  assert.equal(layout.scrolls[0].top, 48);
  state.view.zoom = 3;
  state.view.panX = 40;
  state.view.panY = 9;
  point.x = 12;
  const restore = session.exit();
  assert.equal(session.isOpen(), false);
  assert.equal(session.exit(), null);
  assert.equal(state.view.zoom, 1.25);
  assert.equal(state.view.panX, 6);
  assert.equal(state.view.panY, -3);
  assert.equal(restore.scrollX, 4);
  assert.equal(restore.scrollY, 90);
  assert.deepEqual(restore.scrolls, [{ top: 48, left: 2 }]);
  assert.equal(state.strokes[0], stroke);
  assert.equal(state.strokes[0].pts, stroke.pts);
  assert.equal(state.strokes[0].pts[0], point);
  assert.equal(state.strokes[0].pts[0].x, 12);
  assert.equal(state.history, history);
  assert.equal(state.history[0].stroke, stroke);
  assert.equal(state.redo, redo);
  assert.equal(state.redo[0].kind, 'erase');
});
