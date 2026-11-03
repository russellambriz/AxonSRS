// Handwriting geometry: smoothing, pressure/tilt width, predicted samples, eraser hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strokeWidth, pencilFlatness, smoothStroke, paintSamples, splitPointerSamples, strokeHits, eraseStrokes, ERASER_RADIUS } from '../../js/core/ink.js';

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
});
