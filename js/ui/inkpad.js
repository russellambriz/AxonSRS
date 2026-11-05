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
 * animation frame. Finished strokes are painted once into a cached ink
 * layer, so a frame only composites that layer and redraws the stroke
 * under the pencil: drawing stays as fast on a full page as on an empty
 * one. getPredictedEvents(), when the browser provides it, draws a tail
 * that the next frame replaces; where it does not (Safari on iPad), a
 * short, capped extrapolation of the last samples does the same. Neither
 * is ever stored. A pen hovering above the pad (buttons === 0) shows the
 * nib it will draw with; a finger or a mouse never does.
 *
 * Palm guard: while a pencil is writing, and for a moment after it lifts,
 * a touch landing anywhere on the page is a resting hand, not a tap on
 * Check, Clear or Undo, so it is ignored (only on a device where a pencil
 * has been used, or with Pencil only on).
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { local } from './local.js';
import { reducedMotion } from './appearance.js';
import { eraseStrokes, ERASER_RADIUS, extrapolateTail, paintSamples, pointWidth, redoInkAction, SMOOTHING_LEVELS, smoothingLevel, splitPointerSamples, undoInkAction } from '../core/ink.js';

const HINT = 'Write your answer, then check it';
/** Set after a pen has touched a pad on this device. */
export const PEN_SEEN_KEY = 'axon-pen-seen';
/** Settings → Study. When '1', the pad ignores all touch input. */
export const PENCIL_ONLY_KEY = 'axon-pencil-only';
/** Per device. Off, low, medium (default) or high. Render only. */
export const SMOOTHING_KEY = 'axon-ink-smoothing';
const SMOOTHING_EVENT = 'axon-ink-smoothing';
/** After the pencil lifts, a touch elsewhere is still treated as the palm for this long. */
export const PALM_WINDOW_MS = 450;
/** Write-on ghost: how strongly it shows before the first stroke, and while tracing. */
export const GHOST_ALPHA = 0.32;
export const GHOST_TRACING_ALPHA = 0.2;

export function inkSmoothing() {
  return smoothingLevel(local.get(SMOOTHING_KEY)).id;
}

export function setInkSmoothing(id) {
  const next = smoothingLevel(id).id;
  local.set(SMOOTHING_KEY, next);
  window.dispatchEvent(new CustomEvent(SMOOTHING_EVENT));
  return next;
}

/** The Off / Low / Medium / High control used next to the pen colours. */
export function smoothingButtons({ prefix = '' } = {}) {
  const host = h('div', { class: 'pencil-choices pencil-smooth-group', role: 'group', 'aria-label': `${prefix}Smoothing`.trim() });
  const paint = () => {
    const current = inkSmoothing();
    host.replaceChildren(...SMOOTHING_LEVELS.map((level) => h('button', {
      type: 'button',
      class: 'pencil-smooth',
      'aria-label': `${prefix}Smoothing ${level.label}`.replace(/\s+/g, ' ').trim(),
      'aria-pressed': String(level.id === current),
      onclick: () => setInkSmoothing(level.id),
    }, level.label)));
  };
  const onSmoothing = () => {
    if (!host.isConnected) {
      window.removeEventListener(SMOOTHING_EVENT, onSmoothing);
      return;
    }
    paint();
  };
  paint();
  window.addEventListener(SMOOTHING_EVENT, onSmoothing);
  return host;
}

function pencilOnly() {
  return local.get(PENCIL_ONLY_KEY) === '1';
}

export function inkPad({ onStroke = () => {}, onChange = null, tools = true } = {}) {
  const canvas = h('canvas', { class: 'ink-canvas', role: 'img', 'aria-label': 'Handwriting pad. Write your answer with Apple Pencil, a stylus or a finger.', dataset: { strokes: '0', points: '0' } });
  const overlay = h('canvas', { class: 'ink-overlay', 'aria-hidden': 'true' });
  const ctx = canvas.getContext('2d');
  const octx = overlay.getContext('2d');
  // Finished strokes are painted here once. A frame composites this layer
  // instead of re-smoothing every stroke on the page.
  const inkLayer = document.createElement('canvas');
  const lctx = inkLayer.getContext('2d');
  let layerColor = null;
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
  let smoothingId = inkSmoothing();
  let lastPenUp = -Infinity;
  let swallowClickUntil = 0;
  let plate = null;
  let plateMediaId = null;
  let plateUrl = null;
  // Write-on ghost: an alpha mask of the model handwriting, tinted with the
  // theme accent when drawn.
  let ghost = null;
  let ghostTint = null;
  let ghostTintColor = null;
  let ghostAlpha = 0;
  let ghostTarget = 0;
  let ghostRaf = 0;

  const undoBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => undo() }, icon('undo'), 'Undo stroke') : null;
  const eraserBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', 'aria-pressed': 'false', onclick: () => setEraser(!erasing) }, icon('eraser'), 'Eraser') : null;
  const clearBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => clear() }, icon('trash'), 'Clear') : null;
  const hintEl = tools ? h('span', { class: 'faint small ink-hint' }, HINT) : null;
  const el = h('div', { class: 'ink-pad', dataset: { predicted: '0', hover: '0', penSeen: penSeen ? '1' : '0', ghost: '0', palm: '0' } }, stage, tools ? h('div', { class: 'ink-tools' }, hintEl, h('div', { class: 'row tight' }, undoBtn, eraserBtn, clearBtn)) : null);

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
  const onSmoothing = () => {
    if (!canvas.isConnected) {
      window.removeEventListener(SMOOTHING_EVENT, onSmoothing);
      return;
    }
    smoothingId = inkSmoothing();
    redraw();
    drawOverlay();
  };
  window.addEventListener(SMOOTHING_EVENT, onSmoothing);

  /* ------------------------------------------------------------ palm guard */

  let guardSeenConnected = false;
  const onDocPointerDown = (e) => {
    if (!canvas.isConnected) {
      if (guardSeenConnected) detachGuard();
      return;
    }
    guardSeenConnected = true;
    if (e.pointerType === 'pen') {
      swallowClickUntil = 0;
      return;
    }
    if (e.pointerType !== 'touch' || e.target === canvas || !(penSeen || pencilOnly())) return;
    const writing = current?.type === 'pen' || performance.now() - lastPenUp < PALM_WINDOW_MS;
    if (!writing) return;
    // A hand resting on the screen while writing: never a tap on a button.
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowClickUntil = performance.now() + 800;
    el.dataset.palm = String(Number(el.dataset.palm) + 1);
  };
  const onDocClick = (e) => {
    if (performance.now() >= swallowClickUntil) return;
    swallowClickUntil = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('click', onDocClick, true);
  function detachGuard() {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('click', onDocClick, true);
  }

  /* ----------------------------------------------------- theme changes */

  // Ink without its own colour, and the ghost tint, follow the theme. A
  // switch with nothing being drawn still repaints, on the next frame.
  let themeSeenConnected = false;
  let themeRaf = 0;
  const onTheme = () => {
    if (!canvas.isConnected) {
      if (themeSeenConnected) {
        themeObserver?.disconnect();
        darkQuery?.removeEventListener?.('change', onTheme);
      }
      return;
    }
    themeSeenConnected = true;
    if (themeRaf) return;
    themeRaf = requestAnimationFrame(() => {
      themeRaf = 0;
      if (canvas.width) composite();
      drawOverlay();
    });
  };
  const themeObserver = typeof MutationObserver === 'function' ? new MutationObserver(onTheme) : null;
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
  darkQuery?.addEventListener?.('change', onTheme);

  /* -------------------------------------------------------------- drawing */

  function pointerFrom(e) {
    const r = canvas.getBoundingClientRect();
    const pt = {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      // A real 0 from the pencil is a light touch, not “missing”. Coercing it
      // to 0.5 made every stroke start and end blunt.
      p: e.pointerType === 'pen' ? (typeof e.pressure === 'number' ? e.pressure : 0.5) : 0.5,
      scale: pen.scale,
    };
    // Sample time, for the tail extrapolated where the browser predicts none.
    if (typeof e.timeStamp === 'number' && Number.isFinite(e.timeStamp)) pt.t = e.timeStamp;
    // tilt / altitude / azimuth / twist are optional. A mouse reports the
    // upright defaults; strokeWidth ignores those.
    if (typeof e.tiltX === 'number') pt.tiltX = e.tiltX;
    if (typeof e.tiltY === 'number') pt.tiltY = e.tiltY;
    if (typeof e.altitudeAngle === 'number') pt.altitude = e.altitudeAngle;
    if (typeof e.azimuthAngle === 'number') pt.azimuth = e.azimuthAngle;
    if (typeof e.twist === 'number') pt.twist = e.twist;
    return pt;
  }

  /** A colour token from CSS (--ink, --ink-ghost), resolved at once on a theme switch. */
  function token(name) {
    return getComputedStyle(canvas).getPropertyValue(name).trim();
  }

  /** Default ink: the theme text colour, unless a pen colour is chosen. */
  function inkColor() {
    return token('--ink') || getComputedStyle(canvas).color;
  }

  /** CSS size of the drawing surface, without a layout read. */
  function cssSize() {
    return { width: canvas.width / dpr, height: canvas.height / dpr };
  }

  /**
   * One stroke as a single fill. One outline around the whole stroke
   * self-intersects on a loop (o, e, s) and the fill then punches holes.
   * Each disc and each link is its own subpath, all wound the same way, so
   * the union stays solid and is anti-aliased once, at its edge. Live ink,
   * the ink layer and the PNG copy all use this.
   */
  function fillStroke(g, pts, color) {
    const samples = paintSamples(pts, smoothingId);
    if (!samples.length) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = color;
    g.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const r = Math.max(0.8, s.w / 2);
      g.moveTo(s.x + r, s.y);
      g.arc(s.x, s.y, r, 0, Math.PI * 2);
      if (i === 0) continue;
      const p = samples[i - 1];
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const r0 = Math.max(0.8, p.w / 2);
      g.moveTo(p.x + nx * r0, p.y + ny * r0);
      g.lineTo(s.x + nx * r, s.y + ny * r);
      g.lineTo(s.x - nx * r, s.y - ny * r);
      g.lineTo(p.x - nx * r0, p.y - ny * r0);
      g.closePath();
    }
    g.fill();
  }

  /** Repaint every finished stroke into the ink layer (after undo, erase, resize, or a theme or smoothing change). */
  function repaintInk() {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, inkLayer.width, inkLayer.height);
    layerColor = inkColor();
    if (!inkLayer.width || !inkLayer.height) return;
    for (const s of strokes) {
      if (current && s === current.stroke) continue;
      fillStroke(lctx, s.pts, s.color || layerColor);
    }
  }

  /** Paint one stroke that just finished onto the ink layer. */
  function commitInk(stroke) {
    if (!inkLayer.width || !inkLayer.height) return;
    if (layerColor === null) layerColor = inkColor();
    fillStroke(lctx, stroke.pts, stroke.color || layerColor);
  }

  function drawPlate(g) {
    if (!plate) return;
    const r = cssSize();
    const iw = plate.naturalWidth || plate.width;
    const ih = plate.naturalHeight || plate.height;
    if (!r.width || !r.height || !iw || !ih) return;
    const scale = Math.min(r.width / iw, r.height / ih);
    const w = iw * scale;
    const hh = ih * scale;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(plate, (r.width - w) / 2, (r.height - hh) / 2, w, hh);
  }

  /** The ghost tint: the theme accent, so the model reads in light and dark and never looks like your own ink. */
  function ghostColor() {
    return token('--ink-ghost') || inkColor();
  }

  function tintedGhost() {
    const color = ghostColor();
    if (ghostTint && ghostTintColor === color) return ghostTint;
    const m = ghost.mask;
    const c = document.createElement('canvas');
    c.width = m.naturalWidth || m.width;
    c.height = m.naturalHeight || m.height;
    if (!c.width || !c.height) return null;
    const g = c.getContext('2d');
    g.drawImage(m, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    ghostTint = c;
    ghostTintColor = color;
    return c;
  }

  /**
   * The model handwriting, centred, at the size it was written (its PNG is
   * in device pixels), only ever shrunk to fit — never blown up and blurred.
   */
  function drawGhost(g) {
    if (!ghost || ghostAlpha <= 0.002) return;
    const tint = tintedGhost();
    const r = cssSize();
    if (!tint || !r.width || !r.height) return;
    const iw = tint.width / ghost.ratio;
    const ih = tint.height / ghost.ratio;
    const fit = Math.min(1, (r.width * 0.92) / iw, (r.height * 0.88) / ih);
    const w = iw * fit;
    const hh = ih * fit;
    const strength = Number.parseFloat(token('--ink-ghost-strength')) || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.save();
    g.globalAlpha = Math.min(1, ghostAlpha * strength);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(tint, (r.width - w) / 2, (r.height - hh) / 2, w, hh);
    g.restore();
  }

  /** One frame: the saved drawing, the ghost, the ink layer, then the live stroke and its tail. */
  function composite() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!canvas.width || !canvas.height) return;
    // A theme switch changes the default ink colour: repaint the layer once.
    if (layerColor !== null && inkColor() !== layerColor) repaintInk();
    drawPlate(ctx);
    drawGhost(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(inkLayer, 0, 0);
    if (current?.stroke) {
      const s = current.stroke;
      fillStroke(ctx, predicted.length ? s.pts.concat(predicted) : s.pts, s.color || inkColor());
    }
  }

  function redraw() {
    repaintInk();
    composite();
  }

  /* ------------------------------------------------------------- the ghost */

  function setGhostState() {
    el.dataset.ghost = !ghost ? '0' : ghostTarget < GHOST_ALPHA ? 'tracing' : 'shown';
  }

  /** Ease the ghost to `to` (ease-out), or jump there when motion is reduced. */
  function fadeGhost(to, ms) {
    ghostTarget = to;
    setGhostState();
    cancelAnimationFrame(ghostRaf);
    ghostRaf = 0;
    if (reducedMotion() || !ms || !canvas.isConnected) {
      ghostAlpha = to;
      composite();
      return;
    }
    const from = ghostAlpha;
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, Math.max(0, (now - start) / ms));
      ghostAlpha = from + (to - from) * (1 - Math.pow(1 - k, 3));
      // A pen frame already composites; do not draw twice.
      if (!rafId) composite();
      ghostRaf = k < 1 ? requestAnimationFrame(step) : 0;
    };
    ghostRaf = requestAnimationFrame(step);
  }

  /* -------------------------------------------------------- frame pipeline */

  function applyQueued() {
    if (current?.stroke && queued.length) {
      for (const p of queued) current.stroke.pts.push(p);
    }
    queued = [];
  }

  function frame() {
    rafId = 0;
    applyQueued();
    composite();
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
    octx.fillStyle = (erasing ? null : pen.color) || inkColor();
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
      // The nib it will draw with at an everyday pressure, in the pen colour,
      // with a soft halo so it reads over ink.
      const r = Math.max(1.2, pointWidth({ x: 0, y: 0, p: 0.35, scale: pen.scale }) / 2);
      octx.globalAlpha = 0.16;
      octx.beginPath();
      octx.arc(hover.x, hover.y, r + 3.5, 0, Math.PI * 2);
      octx.fill();
      octx.globalAlpha = 0.85;
      octx.beginPath();
      octx.arc(hover.x, hover.y, r, 0, Math.PI * 2);
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
    inkLayer.width = w;
    inkLayer.height = hPx;
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
    // Tracing begins: the model steps back so the new ink leads.
    if (ghost && ghostTarget >= GHOST_ALPHA) fadeGhost(GHOST_TRACING_ALPHA, 220);
    update();
    composite();
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
    // The browser's prediction wins; without one, run a short way ahead of the tip.
    setPredicted(tail.length ? tail : extrapolateTail(current.stroke.pts.slice(-3).concat(queued).slice(-3)));
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
    if (current.type === 'pen') lastPenUp = performance.now();
    current = null;
    remember({ kind: 'add', stroke: finished });
    // Painted now, not on the next frame, so the lift is never a blank instant.
    commitInk(finished);
    composite();
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
    composite();
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
    // A fresh page: the model comes back to full strength for another go.
    if (ghost && ghostTarget < GHOST_ALPHA) fadeGhost(GHOST_ALPHA, 200);
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
    /**
     * Faint model to trace: an image whose alpha is the ink. It is tinted
     * with the theme accent, shown at the size it was written
     * (`pixelRatio` = device pixels per CSS pixel of the image, this
     * device's by default), fades in, and steps back once tracing starts.
     * Not a stroke, so Clear and Done still see an empty pad, and never
     * part of a snapshot.
     */
    setGhost(image, { pixelRatio = null } = {}) {
      cancelAnimationFrame(ghostRaf);
      ghostRaf = 0;
      ghostTint = null;
      ghostTintColor = null;
      if (!image) {
        ghost = null;
        ghostAlpha = 0;
        ghostTarget = 0;
        setGhostState();
        composite();
        return;
      }
      ghost = { mask: image, ratio: pixelRatio > 0 ? pixelRatio : (window.devicePixelRatio || 1) };
      ghostAlpha = 0;
      fadeGhost(strokes.length ? GHOST_TRACING_ALPHA : GHOST_ALPHA, 280);
    },
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
    /** The ink cropped to what was written: PNG data URL and size in CSS px (or null). Never the ghost or a predicted tail. `background` fills the crop (a paper sheet) so the PNG stays legible in either theme. */
    snapshot({ background = null } = {}) {
      applyQueued();
      cancelFrame();
      const saved = predicted;
      setPredicted([]);
      composite();
      const clean = document.createElement('canvas');
      clean.width = canvas.width;
      clean.height = canvas.height;
      const cg = clean.getContext('2d');
      drawPlate(cg);
      cg.setTransform(1, 0, 0, 1, 0, 0);
      cg.drawImage(inkLayer, 0, 0);
      if (current?.stroke) fillStroke(cg, current.stroke.pts, current.stroke.color || inkColor());
      if (current && saved.length) {
        setPredicted(saved);
        composite();
      }
      const finish = (out) => {
        const o = out.getContext('2d');
        o.imageSmoothingEnabled = true;
        o.imageSmoothingQuality = 'high';
        if (background) {
          o.fillStyle = background;
          o.fillRect(0, 0, out.width, out.height);
        }
        return o;
      };
      if (plate && strokes.length) {
        const out = document.createElement('canvas');
        out.width = clean.width;
        out.height = clean.height;
        finish(out).drawImage(clean, 0, 0);
        const r = cssSize();
        return { src: out.toDataURL('image/png'), width: Math.round(r.width), height: Math.round(r.height) };
      }
      if (!strokes.length) return null;
      const all = strokes.flatMap((s) => s.pts);
      const pad = 8 + Math.max(...all.map((p) => pointWidth(p)));
      const x0 = Math.max(0, Math.min(...all.map((p) => p.x)) - pad);
      const y0 = Math.max(0, Math.min(...all.map((p) => p.y)) - pad);
      const x1 = Math.max(...all.map((p) => p.x)) + pad;
      const y1 = Math.max(...all.map((p) => p.y)) + pad;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round((x1 - x0) * dpr));
      out.height = Math.max(1, Math.round((y1 - y0) * dpr));
      finish(out).drawImage(clean, x0 * dpr, y0 * dpr, out.width, out.height, 0, 0, out.width, out.height);
      return { src: out.toDataURL('image/png'), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    },
  };
}
