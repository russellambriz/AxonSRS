/**
 * Pure geometry for the handwriting pad: pressure/tilt width, midpoint
 * quadratic smoothing, and separating real pointer samples from the
 * predicted tail, and stroke-level eraser hit-testing. No DOM.
 */

/** Eraser disc radius in CSS pixels. A hit removes the whole stroke. */
export const ERASER_RADIUS = 14;

const MIN_WIDTH = 1.15;
const PRESSURE_SPAN = 3.7;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function finite(n, fallback) {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/**
 * How flat the pencil is, 0 (upright) to 1 (on the glass), or null when
 * the event carries no tilt information. altitudeAngle (radians) is
 * preferred when it disagrees with a real tiltX/tiltY; a default upright
 * reading (tilt 0 and altitude π/2, or altitude omitted) is ignored so a
 * mouse or a synthetic event does not fatten every stroke.
 */
export function pencilFlatness(tilt = {}) {
  if (!tilt || typeof tilt !== 'object') return null;
  const tx = tilt.tiltX;
  const ty = tilt.tiltY;
  const alt = tilt.altitude;
  const tiltKnown = (typeof tx === 'number' && Number.isFinite(tx) && tx !== 0) || (typeof ty === 'number' && Number.isFinite(ty) && ty !== 0);
  if (typeof alt === 'number' && Number.isFinite(alt) && (tiltKnown || (alt > 0 && alt < Math.PI / 2))) {
    return clamp(1 - alt / (Math.PI / 2), 0, 1);
  }
  if (tiltKnown) return Math.min(90, Math.hypot(finite(tx, 0), finite(ty, 0))) / 90;
  return null;
}

/**
 * Stroke width in CSS pixels. Pressure (0–1) decides it. Tilt, altitude
 * and twist are optional extras: a flatter pencil is wider, and twist
 * only nudges that when the pencil is already tilted. Missing or default
 * upright tilt leaves the pressure width unchanged.
 */
export function strokeWidth(pressure, tilt = {}) {
  const p = clamp(finite(pressure, 0.5), 0, 1);
  let width = MIN_WIDTH + PRESSURE_SPAN * p;
  const flat = pencilFlatness(tilt);
  if (flat != null) width *= 1 + 0.5 * flat;
  if (flat != null && flat > 0 && typeof tilt.twist === 'number' && Number.isFinite(tilt.twist) && tilt.twist !== 0) {
    width *= 1 + 0.08 * Math.sin((tilt.twist * Math.PI) / 180) * flat;
  }
  return width;
}

/** Width of one sample, including an optional per-point `scale` (pen size). */
export function pointWidth(pt) {
  const scale = finite(pt?.scale, 1);
  return strokeWidth(pt?.p, pt || {}) * (scale > 0 ? scale : 1);
}

function widthOf(pt) {
  return pointWidth(pt);
}

/** Point list, whether the stroke is a bare array or `{ pts }`. */
export function strokePoints(stroke) {
  if (Array.isArray(stroke)) return stroke;
  return stroke?.pts || [];
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Midpoint quadratic smoothing.
 * Returns segments that start at the first sample and end at the last,
 * so no point of the stroke is dropped:
 *   - 0 points → []
 *   - 1 point  → a dot
 *   - 2 points → a straight line
 *   - 3+       → quadratics through successive midpoints, with a final
 *                curve that lands on the last sample
 * Each segment carries the width at its ends (pressure, tilt optional).
 */
export function smoothStroke(points) {
  const pts = points || [];
  if (!pts.length) return [];
  if (pts.length === 1) {
    const a = pts[0];
    return [{ type: 'dot', x: a.x, y: a.y, w: widthOf(a) }];
  }
  if (pts.length === 2) {
    const a = pts[0];
    const b = pts[1];
    return [{ type: 'line', x0: a.x, y0: a.y, x1: b.x, y1: b.y, w0: widthOf(a), w1: widthOf(b) }];
  }
  const segs = [];
  const endWidth = (i, j) => (widthOf(pts[i]) + widthOf(pts[j])) / 2;
  // The first curve starts ON the first sample (not at the first midpoint)
  // so the ink appears where the pencil landed.
  let i = 1;
  for (; i < pts.length - 2; i++) {
    const from = i === 1 ? pts[0] : mid(pts[i - 1], pts[i]);
    const to = mid(pts[i], pts[i + 1]);
    segs.push({
      type: 'quad',
      x0: from.x,
      y0: from.y,
      cx: pts[i].x,
      cy: pts[i].y,
      x1: to.x,
      y1: to.y,
      w0: i === 1 ? widthOf(pts[0]) : endWidth(i - 1, i),
      w1: endWidth(i, i + 1),
    });
  }
  const from = pts.length === 3 ? pts[0] : mid(pts[i - 1], pts[i]);
  const last = pts[pts.length - 1];
  segs.push({
    type: 'quad',
    x0: from.x,
    y0: from.y,
    cx: pts[i].x,
    cy: pts[i].y,
    x1: last.x,
    y1: last.y,
    w0: pts.length === 3 ? widthOf(pts[0]) : endWidth(i - 1, i),
    w1: widthOf(last),
  });
  return segs;
}

/** Polyline samples of one smoothed segment, including both endpoints. */
export function segmentSamples(seg) {
  if (!seg) return [];
  if (seg.type === 'dot') return [{ x: seg.x, y: seg.y, w: seg.w }];
  if (seg.type === 'line') {
    return [
      { x: seg.x0, y: seg.y0, w: seg.w0 },
      { x: seg.x1, y: seg.y1, w: seg.w1 },
    ];
  }
  const dist = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0) + Math.hypot(seg.cx - seg.x0, seg.cy - seg.y0);
  const steps = Math.max(2, Math.min(32, Math.ceil(dist / 3)));
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    out.push({
      x: u * u * seg.x0 + 2 * u * t * seg.cx + t * t * seg.x1,
      y: u * u * seg.y0 + 2 * u * t * seg.cy + t * t * seg.y1,
      w: seg.w0 + (seg.w1 - seg.w0) * t,
    });
  }
  return out;
}

/** Samples for a whole stroke, in order. Empty input → []. */
export function paintSamples(points) {
  const out = [];
  for (const seg of smoothStroke(points)) out.push(...segmentSamples(seg));
  return out;
}

function sameSpot(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) < 0.15 && Math.abs(finite(a.p, 0.5) - finite(b.p, 0.5)) < 0.02;
}

/**
 * Split a pointermove into samples that belong on the stroke and a
 * predicted tail that must not be stored. Coalesced samples that actually
 * moved are all kept (nothing is dropped). An exact repeat of the previous
 * position is skipped so a resting pen does not add an empty segment.
 * Predicted points are never returned in `real`.
 */
export function splitPointerSamples(previous, coalesced, predicted) {
  const real = [];
  let prev = previous || null;
  for (const p of coalesced || []) {
    if (!p) continue;
    if (prev && sameSpot(prev, p)) continue;
    real.push(p);
    prev = p;
  }
  const tail = [];
  for (const p of predicted || []) {
    if (!p) continue;
    if (prev && sameSpot(prev, p)) continue;
    tail.push(p);
    prev = p;
  }
  return { real, tail };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * True when the eraser disc touches this stroke: a single dot, or any raw
 * segment between samples (not only the vertices). Stroke thickness counts.
 * The caller removes the whole stroke, so Undo can put it back.
 */
export function strokeHits(stroke, x, y, radius = ERASER_RADIUS) {
  const points = strokePoints(stroke);
  if (!points.length || !(radius >= 0) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const reach = (pt) => radius + widthOf(pt) / 2;
  if (points.length === 1) return Math.hypot(points[0].x - x, points[0].y - y) <= reach(points[0]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= Math.max(reach(a), reach(b))) return true;
  }
  return false;
}

/**
 * One eraser dab. Returns the strokes that were touched (with the index
 * they had) and the ones that remain, in order. Does not mutate `strokes`.
 */
export function eraseStrokes(strokes, x, y, radius = ERASER_RADIUS) {
  const kept = [];
  const removed = [];
  (strokes || []).forEach((stroke, index) => {
    if (strokeHits(stroke, x, y, radius)) removed.push({ index, stroke });
    else kept.push(stroke);
  });
  return { kept, removed };
}

/**
 * Undo one history action. `add` drops that stroke object; `erase` puts
 * the removed strokes back at the indexes they had. Does not mutate.
 */
export function undoInkAction(strokes, action) {
  const next = (strokes || []).slice();
  if (!action) return next;
  if (action.kind === 'add') {
    const i = next.lastIndexOf(action.stroke);
    if (i >= 0) next.splice(i, 1);
    return next;
  }
  if (action.kind === 'erase') {
    for (let i = action.items.length - 1; i >= 0; i--) {
      const item = action.items[i];
      next.splice(Math.min(item.index, next.length), 0, item.stroke);
    }
  }
  return next;
}

/**
 * Redo one history action. `add` appends the stroke; `erase` removes those
 * stroke objects again. Does not mutate.
 */
export function redoInkAction(strokes, action) {
  const next = (strokes || []).slice();
  if (!action) return next;
  if (action.kind === 'add') {
    if (!next.includes(action.stroke)) next.push(action.stroke);
    return next;
  }
  if (action.kind === 'erase') {
    const drop = new Set(action.items.map((item) => item.stroke));
    return next.filter((stroke) => !drop.has(stroke));
  }
  return next;
}
