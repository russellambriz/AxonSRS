/**
 * Handwriting pad: freehand ink from Apple Pencil, another stylus, a
 * finger or a mouse. Nothing is recognised; the ink is shown back next to
 * the correct answer so the learner can grade it. Once a pen has touched
 * the pad, finger and palm touches are ignored (palm rejection).
 *
 * Strokes are smoothed with midpoint quadratics and batched onto one
 * animation frame. getPredictedEvents(), when the browser provides it,
 * draws a tail that the next frame replaces — it is never stored.
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { paintSamples, splitPointerSamples, strokeWidth } from '../core/ink.js';

const HINT = 'Write your answer, then check it';

export function inkPad({ onStroke = () => {} } = {}) {
  const canvas = h('canvas', { class: 'ink-canvas', role: 'img', 'aria-label': 'Handwriting pad. Write your answer with Apple Pencil, a stylus or a finger.', dataset: { strokes: '0', points: '0' } });
  const ctx = canvas.getContext('2d');
  const strokes = [];
  let current = null;
  let penSeen = false;
  let dpr = 1;
  let queued = [];
  let predicted = [];
  let rafId = 0;

  const undoBtn = h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => undo() }, icon('undo'), 'Undo stroke');
  const clearBtn = h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => clear() }, icon('trash'), 'Clear');
  const hintEl = h('span', { class: 'faint small ink-hint' }, HINT);
  const el = h('div', { class: 'ink-pad', dataset: { predicted: '0' } }, canvas, h('div', { class: 'ink-tools' }, hintEl, h('div', { class: 'row tight' }, undoBtn, clearBtn)));

  function pointerFrom(e) {
    const r = canvas.getBoundingClientRect();
    const pt = {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      p: e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5,
    };
    // tilt / altitude / azimuth / twist are optional. A mouse reports the
    // upright defaults; strokeWidth ignores those.
    if (typeof e.tiltX === 'number') pt.tiltX = e.tiltX;
    if (typeof e.tiltY === 'number') pt.tiltY = e.tiltY;
    if (typeof e.altitudeAngle === 'number') pt.altitude = e.altitudeAngle;
    if (typeof e.azimuthAngle === 'number') pt.azimuth = e.azimuthAngle;
    if (typeof e.twist === 'number') pt.twist = e.twist;
    return pt;
  }

  function style() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function drawPoints(pts) {
    const samples = paintSamples(pts);
    if (samples.length === 1) {
      const a = samples[0];
      ctx.beginPath();
      ctx.arc(a.x, a.y, Math.max(0.6, a.w / 2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.01) continue;
      ctx.lineWidth = Math.max(0.6, (a.w + b.w) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!canvas.width || !canvas.height) return;
    style();
    for (const s of strokes) {
      const pts = current && s === current.pts && predicted.length ? s.concat(predicted) : s;
      drawPoints(pts);
    }
  }

  function applyQueued() {
    if (current && queued.length) {
      for (const p of queued) current.pts.push(p);
    }
    queued = [];
  }

  function frame() {
    rafId = 0;
    applyQueued();
    redraw();
    update();
  }

  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(frame);
  }

  function cancelFrame() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function setPredicted(tail) {
    predicted = tail;
    el.dataset.predicted = tail.length ? '1' : '0';
  }

  function update() {
    canvas.dataset.strokes = String(strokes.length);
    canvas.dataset.points = String(strokes.reduce((n, s) => n + s.length, 0) + queued.length);
    const busy = !!current;
    undoBtn.disabled = busy || !strokes.length;
    clearBtn.disabled = !strokes.length && !busy;
  }

  function undo() {
    if (current) return;
    strokes.pop();
    redraw();
    update();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    applyQueued();
    redraw();
  }

  function eventList(e, name) {
    try {
      const fn = e[name];
      const list = typeof fn === 'function' ? fn.call(e) : null;
      if (list && list.length) return list;
    } catch {
      /* a synthetic event, or a browser that throws instead of returning [] */
    }
    return name === 'getCoalescedEvents' ? [e] : [];
  }

  function ingest(e) {
    const previous = queued.length ? queued[queued.length - 1] : current?.pts[current.pts.length - 1];
    return splitPointerSamples(previous, eventList(e, 'getCoalescedEvents').map(pointerFrom), eventList(e, 'getPredictedEvents').map(pointerFrom));
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') penSeen = true;
    else if (penSeen && e.pointerType === 'touch') return;
    if (e.button > 0 || current) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const pts = [pointerFrom(e)];
    strokes.push(pts);
    current = { id: e.pointerId, type: e.pointerType, pts };
    queued = [];
    setPredicted([]);
    update();
    redraw();
    onStroke(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!current || e.pointerId !== current.id) return;
    e.preventDefault();
    const { real, tail } = ingest(e);
    if (real.length) queued.push(...real);
    setPredicted(tail);
    schedule();
  });

  const end = (e) => {
    if (!current || e.pointerId !== current.id) return;
    const { real } = ingest(e);
    if (real.length) queued.push(...real);
    applyQueued();
    setPredicted([]);
    cancelFrame();
    current = null;
    redraw();
    update();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // iOS: no magnifier, selection or scrolling while writing.
  canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);

  function clear() {
    cancelFrame();
    strokes.length = 0;
    queued = [];
    setPredicted([]);
    current = null;
    redraw();
    update();
  }

  return {
    el,
    canvas,
    resize,
    isEmpty: () => !strokes.length && !queued.length,
    strokeCount: () => strokes.length,
    clear,
    /** The ink cropped to what was written: PNG data URL and size in CSS px (or null). The predicted tail is not included. */
    snapshot() {
      applyQueued();
      const saved = predicted;
      setPredicted([]);
      cancelFrame();
      redraw();
      if (!strokes.length) {
        if (saved.length) setPredicted(saved);
        return null;
      }
      const all = strokes.flat();
      const pad = 8 + Math.max(...all.map((p) => strokeWidth(p.p, p)));
      const x0 = Math.max(0, Math.min(...all.map((p) => p.x)) - pad);
      const y0 = Math.max(0, Math.min(...all.map((p) => p.y)) - pad);
      const x1 = Math.max(...all.map((p) => p.x)) + pad;
      const y1 = Math.max(...all.map((p) => p.y)) + pad;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round((x1 - x0) * dpr));
      out.height = Math.max(1, Math.round((y1 - y0) * dpr));
      out.getContext('2d').drawImage(canvas, x0 * dpr, y0 * dpr, out.width, out.height, 0, 0, out.width, out.height);
      if (current && saved.length) {
        setPredicted(saved);
        redraw();
      }
      return { src: out.toDataURL('image/png'), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    },
  };
}
