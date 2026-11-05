// Handwriting geometry: smoothing, pressure/tilt width, predicted samples, eraser hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strokeWidth, shapedPressure, extrapolateTail, pencilFlatness, smoothStroke, paintSamples, stabilizeStroke, ribbonPolygon, ribbonEdges, centerlineCovered, smoothingLevel, splitPointerSamples, strokeHits, eraseStrokes, ERASER_RADIUS, pointWidth, undoInkAction, redoInkAction } from '../../js/core/ink.js';

const pt = (x, y, p = 0.5, extra = {}) => ({ x, y, p, ...extra });

test('stroke width follows pressure and ignores upright or missing tilt', () => {
  assert.ok(strokeWidth(0) < strokeWidth(0.5) && strokeWidth(0.5) < strokeWidth(1));
  assert.equal(strokeWidth(undefined), strokeWidth(0.5));
  assert.equal(strokeWidth(-2), strokeWidth(0));
  assert.equal(strokeWidth(4), strokeWidth(1));
  assert.equal(strokeWidth(0.5, {}), strokeWidth(0.5));
  assert.equal(strokeWidth(0.5, { tiltX: 0, tiltY: 0 }), strokeWidth(0.5));
  assert.equal(strokeWidth(0.5, { altitude: Math.PI / 2, tiltX: 0, tiltY: 0 }), strokeWidth(0.5));
  assert.equal(strokeWidth(0.5, { twist: 90 }), strokeWidth(0.5), 'twist alone is not a width');
  assert.equal(strokeWidth(0.5, { azimuth: 1.2 }), strokeWidth(0.5));
  assert.equal(pencilFlatness({ tiltX: 0, tiltY: 0 }), null);
});

test('a light Pencil touch draws fuller than a straight pressure line, and harder still grows', () => {
  const straight = (p) => 1.8 + 4.2 * p;
  assert.ok(strokeWidth(0.2) > straight(0.2), 'light writing is present');
  assert.ok(strokeWidth(0.2) < strokeWidth(0.5) && strokeWidth(0.5) < strokeWidth(1));
  assert.ok(strokeWidth(1) <= straight(1) + 0.01, 'a full press does not run past the pen');
});

test('medium pressure is fuller than the old hairline, and Fine stays thinner than Medium', () => {
  const mid = strokeWidth(0.5);
  assert.ok(mid > 3, 'thicker than the previous 3px stroke at pressure 0.5');
  assert.ok(mid < 5.5, 'still a pencil, not a marker');
  assert.ok(strokeWidth(0) >= 1.6 && strokeWidth(0) < mid);
  assert.ok(pointWidth({ x: 0, y: 0, p: 0.5, scale: 0.7 }) < pointWidth({ x: 0, y: 0, p: 0.5, scale: 1 }));
  const flat = paintSamples([pt(0, 0, 0.5), pt(40, 0, 0.5)], 'off');
  const ribbon = ribbonPolygon(flat);
  const end = flat[flat.length - 1];
  assert.ok(ribbon.some((p) => p.x > end.x + end.w * 0.3), 'the end cap rounds past the last sample');
});

test('tilt, altitude and twist widen a stroke only as optional extras', () => {
  const base = strokeWidth(0.5);
  assert.ok(strokeWidth(0.5, { tiltX: 75 }) > base);
  assert.ok(strokeWidth(0.5, { tiltY: -80 }) > base);
  assert.ok(strokeWidth(0.5, { altitude: 0.2 }) > strokeWidth(0.5, { altitude: 1.2 }));
  const flat = { altitude: 0.25 };
  assert.notEqual(strokeWidth(0.5, { ...flat, twist: 90 }), strokeWidth(0.5, flat));
});

test('midpoint smoothing keeps every stroke endpoint and rounds corners', () => {
  assert.deepEqual(smoothStroke([]), []);
  const dot = smoothStroke([pt(3, 4, 1)]);
  assert.equal(dot.length, 1);
  assert.equal(dot[0].type, 'dot');
  assert.equal(dot[0].x, 3);
  assert.equal(dot[0].w, strokeWidth(1));

  const line = smoothStroke([pt(0, 0), pt(8, 0, 1)]);
  assert.equal(line[0].type, 'line');
  assert.equal(line[0].x0, 0);
  assert.equal(line[0].x1, 8);
  assert.ok(line[0].w1 > line[0].w0);

  const corner = [pt(0, 0), pt(0, 20), pt(20, 20)];
  const segs = smoothStroke(corner);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'quad');
  assert.equal(segs[0].x0, 0);
  assert.equal(segs[0].y0, 0);
  assert.equal(segs[0].cx, 0);
  assert.equal(segs[0].cy, 20);
  assert.equal(segs[0].x1, 20);
  assert.equal(segs[0].y1, 20);

  const samples = paintSamples(corner);
  assert.equal(samples[0].x, 0);
  assert.equal(samples[0].y, 0);
  assert.equal(samples.at(-1).x, 20);
  assert.equal(samples.at(-1).y, 20);
  assert.ok(samples.some((s) => s.x > 2 && s.y < 18), 'the corner is pulled into a curve');

  const many = Array.from({ length: 8 }, (_, i) => pt(i * 5, i % 2 ? 4 : 0, 0.3));
  const smooth = smoothStroke(many);
  assert.equal(smooth.length, many.length - 2);
  const painted = paintSamples(many);
  assert.equal(painted[0].x, many[0].x);
  assert.equal(painted.at(-1).x, many.at(-1).x);
  assert.equal(painted.at(-1).y, many.at(-1).y);
});

test('the stabilizer calms a jittery stroke without moving its ends or the saved points', () => {
  const raw = [];
  for (let i = 0; i < 12; i++) raw.push(pt(i * 4, i % 2 ? 8 : 0, i % 2 ? 0.95 : 0.15));
  const snapshot = raw.map((p) => ({ ...p }));
  assert.equal(smoothingLevel('nope').id, 'medium');
  assert.equal(stabilizeStroke(raw, 'off'), raw);
  const medium = stabilizeStroke(raw, 'medium');
  const high = stabilizeStroke(raw, 'high');
  assert.deepEqual(raw, snapshot, 'saved points stay raw');
  assert.equal(medium[0].x, raw[0].x);
  assert.equal(medium.at(-1).x, raw.at(-1).x);
  assert.equal(medium.at(-1).y, raw.at(-1).y);
  assert.ok(Math.abs(medium[5].y) < Math.abs(raw[5].y), 'an interior wobble is pulled in');
  assert.ok(Math.abs(high[5].y) < Math.abs(medium[5].y), 'high steadies more than medium');
  const jump = (pts) => pts.slice(1).reduce((sum, p, i) => sum + Math.abs(p.p - pts[i].p), 0);
  assert.ok(jump(medium) < jump(raw), 'pressure changes taper instead of flickering');
  const painted = paintSamples(raw, 'high');
  assert.equal(painted[0].x, raw[0].x);
  assert.equal(painted.at(-1).x, raw.at(-1).x);
  assert.equal(painted.at(-1).y, raw.at(-1).y);
  const flat = paintSamples([pt(0, 0, 0.2), pt(30, 0, 0.2), pt(60, 0, 1)], 'off');
  const ribbon = ribbonPolygon(flat);
  assert.ok(ribbon.length >= 4);
  const widest = Math.max(...flat.map((s) => s.w));
  assert.ok(ribbon.every((p) => Math.abs(p.y) <= widest / 2 + 0.6));
});

test('a pencil curve is sampled finely and its edge does not kink', () => {
  const raw = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI;
    raw.push(pt(Math.cos(a) * 70, Math.sin(a) * 70, i % 2 ? 0.85 : 0.35));
  }
  const samples = paintSamples(raw, 'medium');
  let maxStep = 0;
  for (let i = 1; i < samples.length; i++) {
    maxStep = Math.max(maxStep, Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
  }
  assert.ok(maxStep <= 1.7, `sample step ${maxStep.toFixed(2)}px is coarse enough to look faceted`);
  const edges = ribbonEdges(samples);
  let maxTurn = 0;
  for (let i = 2; i < edges.left.length; i++) {
    const ax = edges.left[i - 1].x - edges.left[i - 2].x;
    const ay = edges.left[i - 1].y - edges.left[i - 2].y;
    const bx = edges.left[i].x - edges.left[i - 1].x;
    const by = edges.left[i].y - edges.left[i - 1].y;
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    const dot = Math.min(1, Math.max(-1, (ax / la) * (bx / lb) + (ay / la) * (by / lb)));
    maxTurn = Math.max(maxTurn, Math.acos(dot));
  }
  assert.ok(maxTurn < Math.PI / 3, `edge kink of ${maxTurn.toFixed(2)} rad`);
  assert.notEqual(JSON.stringify(raw[3]), JSON.stringify(stabilizeStroke(raw, 'medium')[3] || raw[3]));
});

test('a tight loop stays covered, so the stroke cannot go hollow between samples', () => {
  const raw = [];
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    raw.push(pt(Math.cos(a) * 16, Math.sin(a) * 16, 0.4));
  }
  const samples = paintSamples(raw, 'medium');
  assert.equal(centerlineCovered(samples), true);
  assert.ok(samples.length > raw.length);
});

test('predicted samples are a tail and coalesced movement is kept', () => {
  const previous = pt(0, 0);
  const { real, tail } = splitPointerSamples(
    previous,
    [pt(0, 0), pt(3, 1, 0.6), pt(6, 1, 0.7)],
    [pt(6, 1, 0.7), pt(12, 1, 0.4)],
  );
  assert.deepEqual(real.map((p) => p.x), [3, 6]);
  assert.deepEqual(tail.map((p) => p.x), [12]);
  assert.ok(real.every((p) => p.x !== 12));
  const all = splitPointerSamples(null, [pt(1, 1), pt(2, 2), pt(4, 0, 0.2)], []);
  assert.equal(all.real.length, 3);
  assert.equal(all.tail.length, 0);
});

test('eraser hit-testing selects a whole stroke, including the segment between samples', () => {
  const across = [pt(0, 0), pt(100, 0)];
  assert.equal(strokeHits(across, 50, 2, 4), true, 'a point between vertices hits');
  assert.equal(strokeHits(across, 50, 40, 4), false);
  assert.equal(strokeHits([pt(10, 10)], 12, 10, 3), true);
  assert.equal(strokeHits([pt(10, 10)], 40, 40, 3), false);
  const near = [pt(0, 0, 1), pt(30, 0, 1)];
  assert.equal(strokeHits(near, 15, strokeWidth(1) / 2, 0), true, 'thickness counts when the radius is 0');
  const far = [pt(0, 80), pt(20, 80)];
  const { kept, removed } = eraseStrokes([across, far], 50, 0, ERASER_RADIUS);
  assert.equal(kept.length, 1);
  assert.equal(kept[0], far);
  assert.deepEqual(removed.map((r) => r.index), [0]);
  assert.equal(removed[0].stroke, across);
  const wide = [{ x: 0, y: 0, p: 0.5, scale: 3 }, { x: 80, y: 0, p: 0.5, scale: 3 }];
  assert.ok(pointWidth(wide[0]) > pointWidth({ x: 0, y: 0, p: 0.5 }));
  assert.equal(strokeHits({ pts: wide }, 40, pointWidth(wide[0]) / 2, 0), true, 'a wrapped stroke and a wider pen still hit');
});

test('undo puts a stroke or an erasure back, and redo repeats it', () => {
  const a = [{ x: 0, y: 0 }];
  const b = [{ x: 4, y: 0 }];
  const added = undoInkAction([a, b], { kind: 'add', stroke: b });
  assert.deepEqual(added, [a]);
  assert.deepEqual(redoInkAction(added, { kind: 'add', stroke: b }), [a, b]);
  const afterErase = [b];
  const restored = undoInkAction(afterErase, { kind: 'erase', items: [{ index: 0, stroke: a }] });
  assert.deepEqual(restored, [a, b]);
  assert.deepEqual(redoInkAction(restored, { kind: 'erase', items: [{ index: 0, stroke: a }] }), [b]);
});

test('pressure curve: 0 stays 0 (taper on lift), 1 stays the full pen, light is fuller and a hard press is controlled', () => {
  assert.equal(shapedPressure(0), 0, 'a real 0 is the thinnest line, so a lift tapers');
  assert.equal(shapedPressure(1), 1);
  assert.equal(shapedPressure(-1), 0);
  assert.equal(shapedPressure(3), 1);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = shapedPressure(i / 100);
    assert.ok(v > prev, `monotonic at ${i / 100}`);
    assert.ok(v <= 1 + 1e-9);
    prev = v;
  }
  const gammaOnly = (p) => Math.pow(p, 0.72);
  for (const p of [0.05, 0.1, 0.2, 0.3]) assert.ok(shapedPressure(p) > gammaOnly(p), `a light touch (${p}) lays down more ink`);
  const slope = (p) => (shapedPressure(p + 0.01) - shapedPressure(p - 0.01)) / 0.02;
  assert.ok(slope(0.9) < slope(0.5) * 0.75, 'leaning in grows the line gently near the top');
  assert.ok(slope(0.9) > 0, 'but it still grows');
  assert.equal(strokeWidth(1), strokeWidth(1, {}), 'full pressure is the same full width as before');
  assert.ok(Math.abs(strokeWidth(1) - 6) < 1e-9);
});

test('a quick tap is a readable dot, centred where the pencil landed; a short line is still a line', () => {
  const tap = paintSamples([pt(40, 30, 0.04), pt(40.6, 30.4, 0.08)]);
  assert.equal(tap.length, 1, 'one dot, not a smear');
  assert.deepEqual([tap[0].x, tap[0].y], [40, 30]);
  assert.ok(tap[0].w >= strokeWidth(0.45) - 1e-9, `dot ${tap[0].w.toFixed(2)}px is too faint to read`);
  const firm = paintSamples([pt(10, 10, 1)]);
  assert.equal(firm[0].w, strokeWidth(1), 'a firm tap keeps its own size');
  const fine = paintSamples([{ x: 0, y: 0, p: 0.05, scale: 0.7 }]);
  assert.ok(fine[0].w < tap[0].w, 'a Fine pen still draws a finer dot');
  const line = paintSamples([pt(0, 0, 0.3), pt(4, 0, 0.3), pt(8, 0, 0.3)], 'off');
  assert.ok(line.length > 3, 'a short line is drawn as a line');
});

test('without browser prediction, a steady stroke gets a short capped tail ahead of the tip; turns, stops and stale samples get none', () => {
  const steady = [{ x: 0, y: 0, p: 0.4, t: 0 }, { x: 4, y: 0, p: 0.4, t: 4 }, { x: 8, y: 0, p: 0.5, t: 8 }];
  const frozen = JSON.stringify(steady);
  const tail = extrapolateTail(steady);
  assert.equal(tail.length, 1);
  assert.ok(tail[0].x > 8 && tail[0].x <= 8 + 9 + 1e-9, `ahead of the tip, at most 9px: ${tail[0].x}`);
  assert.ok(Math.abs(tail[0].y) < 1e-9, 'along the stroke');
  assert.equal(tail[0].p, 0.5, 'carries the tip pressure');
  assert.equal(tail[0].predicted, true);
  assert.equal(tail[0].t, undefined, 'a predicted point has no sample time and is never stored');
  assert.equal(JSON.stringify(steady), frozen, 'input untouched');
  const fast = [{ x: 0, y: 0, t: 0 }, { x: 30, y: 0, t: 4 }, { x: 60, y: 0, t: 8 }];
  assert.ok(Math.abs(extrapolateTail(fast)[0].x - 69) < 1e-9, 'capped at 9px however fast');
  const turning = [{ x: 0, y: 0, t: 0 }, { x: 4, y: 0, t: 4 }, { x: 4, y: 4, t: 8 }];
  assert.deepEqual(extrapolateTail(turning), [], 'a corner is not guessed past');
  const slowing = [{ x: 0, y: 0, t: 0 }, { x: 8, y: 0, t: 4 }, { x: 10, y: 0, t: 8 }];
  assert.deepEqual(extrapolateTail(slowing), [], 'a stroke about to stop gets no tail');
  const resting = [{ x: 0, y: 0, t: 0 }, { x: 0.05, y: 0, t: 4 }, { x: 0.1, y: 0, t: 8 }];
  assert.deepEqual(extrapolateTail(resting), []);
  const stale = [{ x: 0, y: 0, t: 0 }, { x: 4, y: 0, t: 4 }, { x: 8, y: 0, t: 80 }];
  assert.deepEqual(extrapolateTail(stale), [], 'a gap in the samples is not a velocity');
  assert.deepEqual(extrapolateTail([pt(0, 0), pt(4, 0), pt(8, 0)]), [], 'no sample times, no guess');
  assert.deepEqual(extrapolateTail([steady[0], steady[1]]), []);
});

test('solid fill invariants: light, heavy and tapering strokes stay covered between samples', () => {
  const sweep = [];
  for (let i = 0; i <= 40; i++) sweep.push(pt(i * 6, Math.sin(i / 3) * 20, i / 40));
  for (const smoothing of ['off', 'low', 'medium', 'high']) {
    const samples = paintSamples(sweep, smoothing);
    assert.equal(centerlineCovered(samples), true, `no gap between discs (${smoothing})`);
    assert.ok(samples.every((s) => s.w >= strokeWidth(0) - 1e-9), 'never thinner than the pen at zero pressure');
  }
  const lift = paintSamples([pt(0, 0, 0.7), pt(6, 0, 0.6), pt(12, 0, 0.3), pt(18, 0, 0)], 'off');
  assert.ok(lift.at(-1).w < lift[0].w, 'the stroke tapers as the pencil lifts');
  assert.equal(centerlineCovered(lift), true);
});
