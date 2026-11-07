// The four failures reproduced on the live site on 7 November 2026 (A–D),
// run against the real study screen in jsdom. Acceptance matrix 1–4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshSession, open, reload, click, type, input, pressed, prompt, phase, stroke, strokes, toolDisabled, inkMode, waitSaved, waitFor, q, app } from './helpers.mjs';

test('1 (A): SO4^ + Unsure, saved, reload: same draft and selection, answer still hidden', async () => {
  const id = await freshSession();
  await open(id);
  assert.equal(prompt(), 'Formula of the sulfate ion');
  type('SO4^');
  click('Unsure');
  assert.equal(input().value, 'SO4^');
  assert.deepEqual(pressed(), ['Unsure']);
  await waitSaved();
  await reload();
  assert.equal(prompt(), 'Formula of the sulfate ion');
  assert.equal(phase(), 'question');
  assert.equal(input().value, 'SO4^');
  assert.deepEqual(pressed(), ['Unsure']);
  assert.equal(q('.feedback'), null, 'no feedback, so the answer is not shown');
  assert.equal(q('.count').textContent, '1 / 3');
});

test('2 (B): SO4^2 + Confident, Pause and leave, Resume: same draft and selection', async () => {
  const id = await freshSession();
  const { handle } = await open(id);
  type('SO4^2');
  click('Confident');
  // No wait for Saved: Pause and leave itself must commit the draft first.
  app.__navigated = null;
  click('Pause and leave');
  await waitFor(() => app.__navigated === '/', { what: 'leaving the screen' });
  handle.destroy();
  await open(id);
  assert.equal(prompt(), 'Formula of the sulfate ion');
  assert.equal(input().value, 'SO4^2');
  assert.deepEqual(pressed(), ['Confident']);
});

test('3 (C): Type SO4^, Write two strokes, Type, Write: both drafts and confidence intact', async () => {
  const id = await freshSession();
  await open(id);
  type('SO4^');
  click('Unsure');
  click('Write');
  assert.ok(inkMode());
  stroke({ dx: 0, dy: 60 });
  stroke({ x: 20, y: 70, dx: 80, dy: 0 });
  assert.equal(strokes(), 2);
  assert.equal(toolDisabled('Undo stroke'), false);
  assert.equal(toolDisabled('Clear'), false);
  click('Type');
  assert.equal(input().value, 'SO4^');
  click('Write');
  assert.equal(strokes(), 2, 'ink survives Write → Type → Write');
  assert.equal(toolDisabled('Undo stroke'), false);
  assert.equal(toolDisabled('Clear'), false);
  assert.deepEqual(pressed(), ['Unsure']);
  click('Type');
  assert.equal(input().value, 'SO4^');
  click('Write');
});

test('4 (D): Write strokes + Unsure, saved, reload: editable ink, confidence and Write mode', async () => {
  const id = await freshSession();
  await open(id);
  click('Write');
  click('Unsure');
  stroke({ dx: 30, dy: 50 });
  assert.equal(strokes(), 1);
  await waitSaved();
  await reload();
  assert.ok(inkMode(), 'Write mode returns');
  assert.equal(strokes(), 1, 'the stroke returns');
  assert.equal(toolDisabled('Undo stroke'), false, 'restored ink is editable (Undo)');
  assert.equal(toolDisabled('Clear'), false);
  assert.deepEqual(pressed(), ['Unsure']);
  // Still editable: undo removes it, a new stroke adds.
  click('Undo stroke');
  assert.equal(strokes(), 0);
  stroke({ dx: 10, dy: 10 });
  await waitFor(() => strokes() === 1);
});
