// Handwriting geometry: smoothing, pressure/tilt width, predicted samples, eraser hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strokeWidth, pencilFlatness, smoothStroke, paintSamples, stabilizeStroke, ribbonPolygon, smoothingLevel, splitPointerSamples, strokeHits, eraseStrokes, ERASER_RADIUS, pointWidth, undoInkAction, redoInkAction } from '../../js/core/ink.js';

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
