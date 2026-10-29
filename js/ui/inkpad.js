/**
 * Handwriting pad: freehand ink from Apple Pencil, another stylus, a
 * finger or a mouse. Nothing is recognised; the ink is shown back next to
 * the correct answer so the learner can grade it. Once a pen has touched
 * the pad, finger and palm touches are ignored (palm rejection).
 */

import { h } from './dom.js';
import { icon } from './icons.js';

export function inkPad({ onStroke = () => {} } = {}) {
  const canvas = h('canvas', { class: 'ink-canvas', role: 'img', 'aria-label': 'Handwriting pad. Write your answer with Apple Pencil, a stylus or a finger.', dataset: { strokes: '0' } });
  const ctx = canvas.getContext('2d');
  const strokes = [];
  let current = null;
  let penSeen = false;
  let dpr = 1;

  const undoBtn = h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => { strokes.pop(); redraw(); update(); } }, icon('undo'), 'Undo stroke');
  const clearBtn = h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => { strokes.length = 0; redraw(); update(); } }, icon('trash'), 'Clear');
  const el = h('div', { class: 'ink-pad' }, canvas, h('div', { class: 'ink-tools' }, h('span', { class: 'faint small' }, 'Write your answer, then check it'), h('div', { class: 'row tight' }, undoBtn, clearBtn)));

  const width = (p) => 1.4 + 3.4 * p;
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5 };
  };

  function style() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function segment(a, b) {
    ctx.lineWidth = width((a.p + b.p) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function dot(a) {
    ctx.beginPath();
    ctx.arc(a.x, a.y, width(a.p) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawStroke(pts) {
    if (pts.length === 1) dot(pts[0]);
    for (let i = 1; i < pts.length; i++) segment(pts[i - 1], pts[i]);
  }

  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    style();
    for (const s of strokes) drawStroke(s);
  }

  function update() {
    canvas.dataset.strokes = String(strokes.length);
    undoBtn.disabled = clearBtn.disabled = !strokes.length;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    redraw();
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
    current = { id: e.pointerId, pts: [point(e)] };
    strokes.push(current.pts);
    style();
    dot(current.pts[0]);
    update();
    onStroke(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current || e.pointerId !== current.id) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() || [e]) {
      const p = point(ev);
      segment(current.pts[current.pts.length - 1], p);
      current.pts.push(p);
    }
  });
  const end = (e) => {
    if (current && e.pointerId === current.id) current = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // iOS: no magnifier, selection or scrolling while writing.
  canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);

  return {
    el,
    canvas,
    resize,
    isEmpty: () => !strokes.length,
    strokeCount: () => strokes.length,
    clear() {
      strokes.length = 0;
      current = null;
      redraw();
      update();
    },
    /** The ink cropped to what was written: PNG data URL and size in CSS px (or null). */
    snapshot() {
      if (!strokes.length) return null;
      const all = strokes.flat();
      const pad = 8;
      const x0 = Math.max(0, Math.min(...all.map((p) => p.x)) - pad);
      const y0 = Math.max(0, Math.min(...all.map((p) => p.y)) - pad);
      const x1 = Math.max(...all.map((p) => p.x)) + pad;
      const y1 = Math.max(...all.map((p) => p.y)) + pad;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round((x1 - x0) * dpr));
      out.height = Math.max(1, Math.round((y1 - y0) * dpr));
      out.getContext('2d').drawImage(canvas, x0 * dpr, y0 * dpr, out.width, out.height, 0, 0, out.width, out.height);
      return { src: out.toDataURL('image/png'), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    },
  };
}
