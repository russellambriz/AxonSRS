/**
 * Pure geometry for the handwriting pad: pressure/tilt width, a light
 * streamline on the points used to draw, midpoint quadratic curves, and
 * separating real pointer samples from the predicted tail, and
 * stroke-level eraser hit-testing. No DOM. Stored points are never
 * rewritten; smoothing is a render step.
 */

/** Eraser disc radius in CSS pixels. A hit removes the whole stroke. */
export const ERASER_RADIUS = 14;

/** CSS pixels at zero pressure. Raised from 1.15 so a light stroke is not a hairline. */
const MIN_WIDTH = 1.8;
/** Added across pressure 0→1. A shaped half-pressure stroke lands near 4.3px. */
const PRESSURE_SPAN = 4.2;
/**
 * Pencil pressure is not a straight line. Below 1 lifts a light touch so
 * everyday writing is present, and a firmer press still reaches the full
 * width. Monotonic, so Fine stays thinner than Medium.
 */
const PRESSURE_GAMMA = 0.72;

function shapedPressure(p) {
  return Math.pow(clamp(p, 0, 1), PRESSURE_GAMMA);
}

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
  const p = shapedPressure(clamp(finite(pressure, 0.5), 0, 1));
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
 * How hard the rendered ink chases the raw samples.
 * `follow` and `pressure` are the share of each new sample kept by the
 * running average (1 = no change). The last sample is always kept, so a
 * predicted tail still ends on the predicted tip.
 */
export const SMOOTHING_LEVELS = Object.freeze([
  { id: 'off', label: 'Off', follow: 1, pressure: 1 },
  { id: 'low', label: 'Low', follow: 0.62, pressure: 0.55 },
  { id: 'medium', label: 'Medium', follow: 0.34, pressure: 0.28 },
  { id: 'high', label: 'High', follow: 0.2, pressure: 0.16 },
]);

export function smoothingLevel(id) {
  return SMOOTHING_LEVELS.find((level) => level.id === id) || SMOOTHING_LEVELS[2];
}

/**
 * Streamline a stroke for drawing. Interior points move toward an
 * exponential average (a light lazy brush). The first point and the last
 * point stay put, and the last few points ease back onto the raw samples
 * so the tip does not lag a Pencil prediction. Pressure is averaged the
 * same way. The input array and its points are not modified.
 */
export function stabilizeStroke(points, level = 'medium') {
  const pts = points || [];
  const spec = smoothingLevel(typeof level === 'string' ? level : level?.id);
  if (pts.length < 3 || spec.follow >= 1) return pts;
  const out = pts.map((p) => ({ ...p }));
  let x = out[0].x;
  let y = out[0].y;
  let pressure = finite(out[0].p, 0.5);
  for (let i = 1; i < out.length - 1; i++) {
    const rawP = finite(out[i].p, 0.5);
    x += spec.follow * (out[i].x - x);
    y += spec.follow * (out[i].y - y);
    pressure += spec.pressure * (rawP - pressure);
    out[i] = { ...out[i], x, y, p: pressure };
  }
  const tail = Math.min(4, out.length - 2);
  for (let k = 1; k <= tail; k++) {
    const i = out.length - 1 - k;
    const raw = pts[i];
    const towardRaw = (tail - k + 1) / (tail + 1);
    out[i] = {
      ...out[i],
      x: out[i].x + (raw.x - out[i].x) * towardRaw,
      y: out[i].y + (raw.y - out[i].y) * towardRaw,
      p: out[i].p + (finite(raw.p, 0.5) - finite(out[i].p, 0.5)) * towardRaw,
    };
  }
  return out;
}

function halfWidth(w) {
  return Math.max(0.8, w / 2);
}

function unitTangent(dx, dy, fallback) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return fallback || { dx: 1, dy: 0 };
  return { dx: dx / len, dy: dy / len };
}

/** Tangents that do not flip, then a short average so the edge does not sawtooth. */
function smoothTangents(samples) {
  const raw = [];
  let prev = { dx: 1, dy: 0 };
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    let t = unitTangent(b.x - a.x, b.y - a.y, prev);
    if (prev.dx * t.dx + prev.dy * t.dy < 0) t = { dx: -t.dx, dy: -t.dy };
    raw.push(t);
    prev = t;
  }
  return raw.map((t, i) => {
    if (i === 0 || i === raw.length - 1) return t;
    const p = raw[i - 1];
    const n = raw[i + 1];
    return unitTangent(p.dx * 0.25 + t.dx * 0.5 + n.dx * 0.25, p.dy * 0.25 + t.dy * 0.5 + n.dy * 0.25, t);
  });
}

function relaxEdge(points) {
  if (points.length < 4) return points;
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p;
    return {
      x: p.x * 0.5 + (points[i - 1].x + points[i + 1].x) * 0.25,
      y: p.y * 0.5 + (points[i - 1].y + points[i + 1].y) * 0.25,
    };
  });
}

/**
 * Left and right edges of the ink. Normals stay continuous so a curve
 * does not kink into a stair-step. Endpoints are kept for the round caps.
 */
export function ribbonEdges(samples) {
  if (!samples || samples.length < 2) return null;
  const tangents = smoothTangents(samples);
  const left = [];
  const right = [];
  let prevN = null;
  for (let i = 0; i < samples.length; i++) {
    const t = tangents[i];
    let nx = -t.dy;
    let ny = t.dx;
    if (prevN && prevN.x * nx + prevN.y * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    prevN = { x: nx, y: ny };
    const hw = halfWidth(samples[i].w);
    left.push({ x: samples[i].x + nx * hw, y: samples[i].y + ny * hw });
    right.push({ x: samples[i].x - nx * hw, y: samples[i].y - ny * hw });
  }
  return {
    left: relaxEdge(left),
    right: relaxEdge(right),
    tangents,
    start: samples[0],
    end: samples[samples.length - 1],
  };
}

/** Semicircle from the left edge, through `dir`, to the right edge. */
function outwardCap(cx, cy, dirX, dirY, hw) {
  const len = Math.hypot(dirX, dirY) || 1;
  const dx = dirX / len;
  const dy = dirY / len;
  const nx = -dy;
  const ny = dx;
  const steps = Math.max(8, Math.min(14, Math.ceil(hw * 2)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push({ x: cx + (nx * c + dx * s) * hw, y: cy + (ny * c + dy * s) * hw });
  }
  return pts;
}

/**
 * Filled outline of a variable-width centerline, with round caps on both
 * ends so the live stroke and the committed stroke meet the same way.
 * Null when there is nothing to fill.
 */
export function ribbonPolygon(samples) {
  const edges = ribbonEdges(samples);
  if (!edges || edges.left.length < 2) return null;
  const { left, right, tangents, start, end } = edges;
  const endT = tangents[tangents.length - 1];
  const startT = tangents[0];
  return left.concat(
    outwardCap(end.x, end.y, endT.dx, endT.dy, halfWidth(end.w)),
    right.slice().reverse(),
    outwardCap(start.x, start.y, -startT.dx, -startT.dy, halfWidth(start.w)),
  );
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
    const dist = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0);
    const steps = Math.max(1, Math.min(64, Math.ceil(dist / 0.8)));
    const out = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      out.push({
        x: seg.x0 + (seg.x1 - seg.x0) * t,
        y: seg.y0 + (seg.y1 - seg.y0) * t,
        w: seg.w0 + (seg.w1 - seg.w0) * t,
      });
    }
    return out;
  }
  const dist = Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0) + Math.hypot(seg.cx - seg.x0, seg.cy - seg.y0);
  const steps = Math.max(4, Math.min(64, Math.ceil(dist / 0.8)));
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

/**
 * Samples for a whole stroke, in order. Empty input → [].
 * `smoothing` steadies the points used to draw. Stored points are unchanged.
 * The default is Medium.
 */
/**
 * True when neighbouring samples' discs overlap, so a round-stamp stroke
 * cannot leave a hole between them. A single ribbon outline is not used:
 * it self-intersects on a loop and the fill goes hollow.
 */
export function centerlineCovered(samples) {
  const list = samples || [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const cover = Math.max(0.8, a.w / 2) + Math.max(0.8, b.w / 2);
    if (dist > cover + 0.05) return false;
  }
  return true;
}

export function paintSamples(points, smoothing = 'medium') {
  const stable = stabilizeStroke(points, smoothing);
  const out = [];
  for (const seg of smoothStroke(stable)) {
    for (const p of segmentSamples(seg)) {
      const prev = out[out.length - 1];
      if (prev && Math.hypot(prev.x - p.x, prev.y - p.y) < 0.05) continue;
      out.push(p);
    }
  }
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
