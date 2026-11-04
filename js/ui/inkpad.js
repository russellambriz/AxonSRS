/**
 * Handwriting pad: freehand ink from Apple Pencil, another stylus, a
 * finger or a mouse. Nothing is recognised; the ink is shown back next to
 * the correct answer so the learner can grade it. Once a pen has touched
 * the pad on this device, finger and palm touches are ignored from then
 * on, including the first stroke of a later session. Settings → Study →
 * Pencil only ignores every touch even before a pen is seen. While a pen
 * stroke is down, every other pointer is ignored. Eraser removes each
 * whole stroke it touches, so Undo stroke can put that stroke back.
 *
 * Strokes are smoothed with midpoint quadratics and batched onto one
 * animation frame. getPredictedEvents(), when the browser provides it,
 * draws a tail that the next frame replaces — it is never stored.
 * A pen hovering above the pad (buttons === 0) shows a preview dot; a
 * finger or a mouse never does.
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { local } from './local.js';
import { eraseStrokes, ERASER_RADIUS, paintSamples, pointWidth, redoInkAction, splitPointerSamples, undoInkAction } from '../core/ink.js';

const HINT = 'Write your answer, then check it';
/** Set after a pen has touched a pad on this device. */
export const PEN_SEEN_KEY = 'axon-pen-seen';
/** Settings → Study. When '1', the pad ignores all touch input. */
export const PENCIL_ONLY_KEY = 'axon-pencil-only';

function pencilOnly() {
  return local.get(PENCIL_ONLY_KEY) === '1';
}

export function inkPad({ onStroke = () => {}, onChange = null, tools = true } = {}) {
  const canvas = h('canvas', { class: 'ink-canvas', role: 'img', 'aria-label': 'Handwriting pad. Write your answer with Apple Pencil, a stylus or a finger.', dataset: { strokes: '0', points: '0' } });
  const overlay = h('canvas', { class: 'ink-overlay', 'aria-hidden': 'true' });
  const ctx = canvas.getContext('2d');
  const octx = overlay.getContext('2d');
  const stage = h('div', { class: 'ink-stage' }, canvas, overlay);
  const strokes = [];
  const history = [];
  const redoStack = [];
  let current = null;
  let erasing = false;
  let pen = { color: null, scale: 1 };
  let eraseLog = null;
  let eraserAt = null;
  let penSeen = local.get(PEN_SEEN_KEY) === '1';
  let dpr = 1;
  let queued = [];
  let predicted = [];
  let hover = null;
  let rafId = 0;

  const undoBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => undo() }, icon('undo'), 'Undo stroke') : null;
  const eraserBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', 'aria-pressed': 'false', onclick: () => setEraser(!erasing) }, icon('eraser'), 'Eraser') : null;
  const clearBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => clear() }, icon('trash'), 'Clear') : null;
  const hintEl = tools ? h('span', { class: 'faint small ink-hint' }, HINT) : null;
  const el = h('div', { class: 'ink-pad', dataset: { predicted: '0', hover: '0', penSeen: penSeen ? '1' : '0' } }, stage, tools ? h('div', { class: 'ink-tools' }, hintEl, h('div', { class: 'row tight' }, undoBtn, eraserBtn, clearBtn)) : null);

  /** Touch is ignored after a pen has been used here, or whenever Pencil only is on. Any second pointer is ignored while a stroke — a pen stroke in particular — is active. */
  function ignored(e) {
    if (current && e.pointerId !== current.id) return true;
    if (e.pointerType === 'touch' && (penSeen || pencilOnly())) return true;
    return false;
  }

  function rememberPen() {
    if (penSeen) return;
    penSeen = true;
    el.dataset.penSeen = '1';
    local.set(PEN_SEEN_KEY, '1');
    syncLabel();
  }

  function syncLabel() {
    canvas.setAttribute('aria-label', pencilOnly() || penSeen
      ? 'Handwriting pad. Write with Apple Pencil or a stylus. Finger touches are ignored.'
      : 'Handwriting pad. Write your answer with Apple Pencil, a stylus or a finger.');
  }
  syncLabel();

  function pointerFrom(e) {
    const r = canvas.getBoundingClientRect();
    const pt = {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      p: e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5,
      scale: pen.scale,
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

  function applyInk(color) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = ctx.fillStyle = color || getComputedStyle(canvas).color;
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

  let plate = null;
  let plateMediaId = null;
  let plateUrl = null;

  function drawPlate() {
    if (!plate) return;
    const r = canvas.getBoundingClientRect();
    const iw = plate.naturalWidth || plate.width;
    const ih = plate.naturalHeight || plate.height;
    if (!r.width || !r.height || !iw || !ih) return;
    const scale = Math.min(r.width / iw, r.height / ih);
    const w = iw * scale;
    const h = ih * scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(plate, (r.width - w) / 2, (r.height - h) / 2, w, h);
  }

  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!canvas.width || !canvas.height) return;
    drawPlate();
    for (const s of strokes) {
      const tail = current && s === current.stroke && predicted.length ? predicted : null;
      applyInk(s.color);
      drawPoints(tail ? s.pts.concat(tail) : s.pts);
    }
  }

  function applyQueued() {
    if (current?.stroke && queued.length) {
      for (const p of queued) current.stroke.pts.push(p);
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
    canvas.dataset.points = String(strokes.reduce((n, s) => n + s.pts.length, 0) + queued.length);
    const busy = !!current;
    if (undoBtn) undoBtn.disabled = busy || !history.length;
    if (clearBtn) clearBtn.disabled = !strokes.length && !busy;
    onChange?.();
  }

  function replaceStrokes(next) {
    strokes.length = 0;
    for (const s of next) strokes.push(s);
  }

  function remember(action) {
    history.push(action);
    redoStack.length = 0;
  }

  function setEraser(on) {
    erasing = !!on;
    eraserBtn?.setAttribute('aria-pressed', erasing ? 'true' : 'false');
    el.classList.toggle('erasing', erasing);
    if (!erasing) eraserAt = null;
    drawOverlay();
  }

  function undo() {
    if (current || !history.length) return false;
    const action = history.pop();
    replaceStrokes(undoInkAction(strokes, action));
    redoStack.push(action);
    redraw();
    update();
    return true;
  }

  function redo() {
    if (current || !redoStack.length) return false;
    const action = redoStack.pop();
    replaceStrokes(redoInkAction(strokes, action));
    history.push(action);
    redraw();
    update();
    return true;
  }

  function eraseWith(e) {
    const events = eventList(e, 'getCoalescedEvents');
    let changed = false;
    for (const ev of events) {
      const p = pointerFrom(ev);
      eraserAt = p;
      const { kept, removed } = eraseStrokes(strokes, p.x, p.y);
      if (!removed.length) continue;
      strokes.length = 0;
      for (const s of kept) strokes.push(s);
      eraseLog.push(...removed);
      changed = true;
    }
    if (changed) redraw();
    drawOverlay();
    update();
  }

  function drawOverlay() {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!overlay.width) return;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.fillStyle = (erasing ? null : pen.color) || getComputedStyle(canvas).color;
    if (erasing && eraserAt) {
      octx.globalAlpha = 0.18;
      octx.beginPath();
      octx.arc(eraserAt.x, eraserAt.y, ERASER_RADIUS, 0, Math.PI * 2);
      octx.fill();
      octx.globalAlpha = 0.7;
      octx.lineWidth = 1.25;
      octx.strokeStyle = octx.fillStyle;
      octx.stroke();
    } else if (hover) {
      octx.globalAlpha = 0.55;
      octx.beginPath();
      octx.arc(hover.x, hover.y, Math.max(3, 3.4 * pen.scale), 0, Math.PI * 2);
      octx.fill();
    }
    octx.globalAlpha = 1;
  }

  function showHover(pt) {
    hover = pt;
    el.dataset.hover = '1';
    drawOverlay();
  }

  function hideHover() {
    if (!hover && el.dataset.hover !== '1') return;
    hover = null;
    el.dataset.hover = '0';
    drawOverlay();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr);
    const hPx = Math.round(r.height * dpr);
    canvas.width = w;
    canvas.height = hPx;
    overlay.width = w;
    overlay.height = hPx;
    applyQueued();
    redraw();
    drawOverlay();
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
    const previous = queued.length ? queued[queued.length - 1] : current?.stroke?.pts[current.stroke.pts.length - 1];
    return splitPointerSamples(previous, eventList(e, 'getCoalescedEvents').map(pointerFrom), eventList(e, 'getPredictedEvents').map(pointerFrom));
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') rememberPen();
    if (ignored(e)) {
      // Keep a resting palm from scrolling the page, but do not start a stroke.
      if (e.pointerType === 'touch') e.preventDefault();
      return;
    }
    if (e.button > 0) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    hideHover();
    if (erasing) {
      eraseLog = [];
      current = { id: e.pointerId, type: e.pointerType, erasing: true };
      eraseWith(e);
      update();
      return;
    }
    const stroke = { pts: [pointerFrom(e)], color: pen.color };
    strokes.push(stroke);
    current = { id: e.pointerId, type: e.pointerType, stroke };
    queued = [];
    setPredicted([]);
    update();
    redraw();
    onStroke(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (ignored(e)) return;
    if (current?.erasing) {
      if (e.pointerId !== current.id) return;
      e.preventDefault();
      eraseWith(e);
      return;
    }
    // Apple Pencil hover: pointermove with no buttons, pen only.
    if (!current && e.pointerType === 'pen' && e.buttons === 0) {
      if (erasing) {
        eraserAt = pointerFrom(e);
        el.dataset.hover = '1';
        drawOverlay();
        return;
      }
      showHover(pointerFrom(e));
      return;
    }
    if (!current || e.pointerId !== current.id) return;
    if (hover) hideHover();
    e.preventDefault();
    const { real, tail } = ingest(e);
    if (real.length) queued.push(...real);
    setPredicted(tail);
    schedule();
  });

  const end = (e) => {
    if (!current || e.pointerId !== current.id) return;
    if (current.erasing) {
      eraseWith(e);
      if (eraseLog?.length) remember({ kind: 'erase', items: eraseLog });
      eraseLog = null;
      eraserAt = null;
      current = null;
      drawOverlay();
      redraw();
      update();
      return;
    }
    const finished = current.stroke;
    const { real } = ingest(e);
    if (real.length) queued.push(...real);
    applyQueued();
    setPredicted([]);
    cancelFrame();
    current = null;
    remember({ kind: 'add', stroke: finished });
    redraw();
    update();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => {
    hideHover();
    if (!current) {
      eraserAt = null;
      drawOverlay();
    }
  });
  // iOS: no magnifier, selection or scrolling while writing.
  canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(stage);

  function setPlate(image, id = null, url = null) {
    if (plateUrl && plateUrl !== url) URL.revokeObjectURL(plateUrl);
    plate = image || null;
    plateMediaId = id || null;
    plateUrl = url || null;
    redraw();
  }

  function clear() {
    cancelFrame();
    strokes.length = 0;
    history.length = 0;
    redoStack.length = 0;
    queued = [];
    setPredicted([]);
    eraseLog = null;
    eraserAt = null;
    current = null;
    setPlate(null);
    redraw();
    drawOverlay();
    update();
  }

  return {
    el,
    canvas,
    resize,
    isEmpty: () => !strokes.length && !queued.length,
    hasPlate: () => !!plate,
    plateId: () => plateMediaId,
    /** Show a saved drawing under new strokes. `url` is revoked when replaced. */
    setPlate,
    strokeCount: () => strokes.length,
    clear,
    /** Prompt under the pad, for example the retype instruction. */
    setHint(text) {
      if (hintEl) hintEl.textContent = text || HINT;
    },
    setPen({ color, scale } = {}) {
      if (color !== undefined) pen.color = color;
      if (typeof scale === 'number' && scale > 0) pen.scale = scale;
      if (erasing) setEraser(false);
    },
    setEraser,
    eraserOn: () => erasing,
    undo,
    redo,
    canUndo: () => !current && history.length > 0,
    canRedo: () => !current && redoStack.length > 0,
    /** The ink cropped to what was written: PNG data URL and size in CSS px (or null). The predicted tail is not included. `background` fills the crop (a paper sheet) so the PNG stays legible in either theme. */
    snapshot({ background = null } = {}) {
      applyQueued();
      const saved = predicted;
      setPredicted([]);
      cancelFrame();
      redraw();
      if (plate && strokes.length) {
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
        const o = out.getContext('2d');
        if (background) {
          o.fillStyle = background;
          o.fillRect(0, 0, out.width, out.height);
        }
        o.drawImage(canvas, 0, 0);
        if (current && saved.length) {
          setPredicted(saved);
          redraw();
        }
        const r = canvas.getBoundingClientRect();
        return { src: out.toDataURL('image/png'), width: Math.round(r.width), height: Math.round(r.height) };
      }
      if (!strokes.length) {
        if (saved.length) setPredicted(saved);
        return null;
      }
      const all = strokes.flatMap((s) => s.pts);
      const pad = 8 + Math.max(...all.map((p) => pointWidth(p)));
      const x0 = Math.max(0, Math.min(...all.map((p) => p.x)) - pad);
      const y0 = Math.max(0, Math.min(...all.map((p) => p.y)) - pad);
      const x1 = Math.max(...all.map((p) => p.x)) + pad;
      const y1 = Math.max(...all.map((p) => p.y)) + pad;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round((x1 - x0) * dpr));
      out.height = Math.max(1, Math.round((y1 - y0) * dpr));
      const o = out.getContext('2d');
      if (background) {
        o.fillStyle = background;
        o.fillRect(0, 0, out.width, out.height);
      }
      o.drawImage(canvas, x0 * dpr, y0 * dpr, out.width, out.height, 0, 0, out.width, out.height);
      if (current && saved.length) {
        setPredicted(saved);
        redraw();
      }
      return { src: out.toDataURL('image/png'), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    },
  };
}
