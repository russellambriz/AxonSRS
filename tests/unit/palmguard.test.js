// Palm guard for the quick-add buttons: touch is ignored while a pen is down,
// briefly after it lifts, and (on header buttons) while it hovers or was just active.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEADER_ACTIVE_MS, HOVER_GUARD_MS, LIFT_GUARD_MS, rejectsTouch } from '../../js/ui/palmguard.js';

const quiet = { penDown: false, sinceLift: Infinity, sinceActive: Infinity, sinceHover: Infinity };

test('a pen on the page, and the moment after it lifts, blocks every quick-add button', () => {
  assert.equal(rejectsTouch({ ...quiet, penDown: true }), true);
  assert.equal(rejectsTouch({ ...quiet, header: true, penDown: true }), true);
  assert.equal(rejectsTouch({ ...quiet, sinceLift: LIFT_GUARD_MS - 1 }), true);
  assert.equal(rejectsTouch({ ...quiet, sinceLift: LIFT_GUARD_MS }), false);
  assert.equal(rejectsTouch(quiet), false);
});

test('header buttons also ignore a finger while the pen hovers or was active within a second', () => {
  assert.equal(rejectsTouch({ ...quiet, header: true, sinceHover: HOVER_GUARD_MS - 1 }), true);
  assert.equal(rejectsTouch({ ...quiet, header: true, sinceHover: HOVER_GUARD_MS }), false);
  assert.equal(rejectsTouch({ ...quiet, header: true, sinceActive: HEADER_ACTIVE_MS - 1 }), true);
  assert.equal(rejectsTouch({ ...quiet, header: true, sinceActive: HEADER_ACTIVE_MS }), false);
  assert.equal(rejectsTouch({ ...quiet, sinceHover: 0 }), false, 'the row under the back still accepts a finger while the pen only hovers');
  assert.equal(rejectsTouch({ ...quiet, sinceActive: 0 }), false, 'the one-second window is only the header');
});
