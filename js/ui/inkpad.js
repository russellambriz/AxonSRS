/**
 * Handwriting pad: freehand ink from Apple Pencil, another stylus, a
 * finger or a mouse. Nothing is recognised; the ink is shown back next to
 * the correct answer so the learner can grade it. Once a pen has touched
 * the pad on this device, finger and palm touches are ignored from then
 * on, including the first stroke of a later session. A palm-sized touch
 * or a second finger is ignored even before that, so a resting hand does
 * not start a stroke; one finger still writes. Settings → Study →
 * Pencil only ignores every touch even before a pen is seen. While a pen
 * stroke is down, every other pointer is ignored. Eraser removes each
 * whole stroke it touches, so Undo stroke can put that stroke back.
 *
 * Strokes are smoothed with midpoint quadratics and batched onto one
 * animation frame. getPredictedEvents(), when the browser provides it,
 * draws a tail that the next frame replaces — it is never stored.
 * A pen hovering above the pad (buttons === 0) shows a preview dot; a
 * finger or a mouse never does.
 *
 * Write Mode lifts the same pad over the viewport, inside the safe area.
 * Leaving it puts the pad back where it was. Strokes, the undo and redo
 * stacks, and the tool in hand are not rebuilt. Apple Pencil Pro squeeze,
 * barrel roll, double-tap and haptics are not used.
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { local } from './local.js';
import { announce, reducedMotion } from './appearance.js';
import { eraseStrokes, ERASER_RADIUS, ghostPlacement, isPalmTouch, paintSamples, pointWidth, redoInkAction, SMOOTHING_LEVELS, smoothingLevel, splitPointerSamples, undoInkAction } from '../core/ink.js';
import { chromeOnPointer, contentPoint, createWriteSession, PROMPT_HOLD_MS, writeModeControlEnabled } from './writemode.js';

const HINT = 'Write your answer, then check it';
/** Set after a pen has touched a pad on this device. */
export const PEN_SEEN_KEY = 'axon-pen-seen';
/** Settings → Study. When '1', the pad ignores all touch input. */
export const PENCIL_ONLY_KEY = 'axon-pencil-only';
/** Per device. Off, low, medium (default) or high. Render only. */
export const SMOOTHING_KEY = 'axon-ink-smoothing';
const SMOOTHING_EVENT = 'axon-ink-smoothing';
/** Settings → Study. '0' hides the Write Mode button. Anything else shows it. */
export const WRITE_MODE_KEY = 'axon-write-mode-control';
const WRITE_MODE_EVENT = 'axon-write-mode-control';
const WRITE_MODE_CHANGE = 'axon-write-mode';

/** Only one pad is fullscreen at a time. */
let closeCurrentWrite = null;

export function writeModeControlOn() {
  return writeModeControlEnabled(local.get(WRITE_MODE_KEY));
}

export function setWriteModeControl(on) {
  local.set(WRITE_MODE_KEY, on ? '1' : '0');
  window.dispatchEvent(new CustomEvent(WRITE_MODE_EVENT));
  return writeModeControlOn();
}

/** The Write Mode button. `getPad` is read on click, so the pad can be built later. */
export function createWriteModeButton(getPad) {
  const btn = h('button', {
    type: 'button',
    class: 'btn ghost icon write-mode-btn',
    'aria-label': 'Write Mode',
    title: 'Write Mode',
    'aria-pressed': 'false',
    onclick: () => getPad()?.toggleWrite(),
  }, icon('expand'));
  const sync = () => {
    const pad = getPad();
    btn.hidden = !writeModeControlOn();
    btn.setAttribute('aria-pressed', pad?.isWriting() ? 'true' : 'false');
  };
  const onPref = () => {
    if (!btn.isConnected) {
      window.removeEventListener(WRITE_MODE_EVENT, onPref);
      window.removeEventListener(WRITE_MODE_CHANGE, sync);
      return;
    }
    if (!writeModeControlOn()) getPad()?.exitWrite();
    sync();
  };
  window.addEventListener(WRITE_MODE_EVENT, onPref);
  window.addEventListener(WRITE_MODE_CHANGE, sync);
  sync();
  return btn;
}

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

export function inkPad({ onStroke = () => {}, onChange = null, tools = true, promptEl = null } = {}) {
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
  let smoothingId = inkSmoothing();
  /** Content space. Identity until a view zoom or pan is set; Write Mode restores the previous one. */
  const view = { zoom: 1, panX: 0, panY: 0 };
  const session = createWriteSession({ view, strokes, history, redo: redoStack });
  let api = null;

  const undoBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => undo() }, icon('undo'), 'Undo stroke') : null;
  const eraserBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', 'aria-pressed': 'false', onclick: () => setEraser(!erasing) }, icon('eraser'), 'Eraser') : null;
  const clearBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => clear() }, icon('trash'), 'Clear') : null;
  const hintEl = tools ? h('span', { class: 'faint small ink-hint' }, HINT) : null;
  const writeBtn = tools ? createWriteModeButton(() => api) : null;
  const toolsRow = tools ? h('div', { class: 'ink-tools' }, hintEl, h('div', { class: 'row tight' }, undoBtn, eraserBtn, clearBtn, writeBtn)) : null;
  const el = h('div', { class: 'ink-pad', dataset: { predicted: '0', hover: '0', penSeen: penSeen ? '1' : '0', ghost: '0', write: '0' } }, stage, toolsRow);
  let chromeTarget = toolsRow;

  /** Touch is ignored after a pen has been used here, whenever Pencil only is on, or when the contact is a palm or an extra finger. Any second pointer is ignored while a stroke — a pen stroke in particular — is active. */
  function ignored(e) {
    if (current && e.pointerId !== current.id) return true;
    if (e.pointerType === 'touch' && (penSeen || pencilOnly() || isPalmTouch(e))) return true;
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

  function pointerFrom(e) {
    const r = canvas.getBoundingClientRect();
    const mapped = contentPoint({ x: e.clientX, y: e.clientY }, r, view);
    const pt = {
      x: mapped.x,
      y: mapped.y,
      // A real 0 from the pencil is a light touch, not “missing”. Coercing it
      // to 0.5 made every stroke start and end blunt.
      p: e.pointerType === 'pen' ? (typeof e.pressure === 'number' ? e.pressure : 0.5) : 0.5,
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

  function viewTransform(context) {
    const z = view.zoom > 0 ? view.zoom : 1;
    context.setTransform(dpr * z, 0, 0, dpr * z, dpr * (view.panX || 0), dpr * (view.panY || 0));
  }

  function applyInk(color) {
    viewTransform(ctx);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.strokeStyle = ctx.fillStyle = color || getComputedStyle(canvas).color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function drawPoints(pts, context = ctx) {
    const samples = paintSamples(pts, smoothingId);
    if (!samples.length) return;
    // One outline around the whole stroke self-intersects on a loop (o, e, s)
    // and the fill then punches holes. Each disc and each link is its own
    // subpath, all wound the same way, so the union stays solid. Live ink,
    // the stroke after lift, and the PNG copy this same canvas.
    context.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const r = Math.max(0.8, s.w / 2);
      context.moveTo(s.x + r, s.y);
      context.arc(s.x, s.y, r, 0, Math.PI * 2);
      if (i === 0) continue;
      const p = samples[i - 1];
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const r0 = Math.max(0.8, p.w / 2);
      context.moveTo(p.x + nx * r0, p.y + ny * r0);
      context.lineTo(s.x + nx * r, s.y + ny * r);
      context.lineTo(s.x - nx * r, s.y - ny * r);
      context.lineTo(p.x - nx * r0, p.y - ny * r0);
      context.closePath();
    }
    context.fill();
  }

  let plate = null;
  let plateMediaId = null;
  let plateUrl = null;
  let ghost = null;
  /** Full model on an empty page; a whisper once ink is down. Not stored. */
  let ghostShown = 0;
  let omitGhost = false;

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

  function writingNow() {
    return strokes.length > 0 || queued.length > 0 || !!current?.stroke;
  }

  function syncGhost() {
    const writing = writingNow();
    ghostShown = !ghost ? 0 : writing ? 0.16 : 0.62;
    el.dataset.ghost = !ghost ? '0' : writing ? 'lift' : '1';
  }

  function drawGhost() {
    if (!ghost || omitGhost || ghostShown < 0.01) return;
    const r = canvas.getBoundingClientRect();
    const iw = ghost.naturalWidth || ghost.width;
    const ih = ghost.naturalHeight || ghost.height;
    const place = ghostPlacement({ imageWidth: iw, imageHeight: ih, padWidth: r.width, padHeight: r.height, dpr });
    if (!place) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.globalAlpha = ghostShown;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ghost, place.x, place.y, place.w, place.h);
    ctx.restore();
  }

  function redraw() {
    syncGhost();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!canvas.width || !canvas.height) return;
    drawPlate();
    drawGhost();
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
    viewTransform(octx);
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
      noteWriting();
      hideChromeFor(e);
      eraseWith(e);
      update();
      return;
    }
    // Coalesced history on the down event, in order, so a fast stroke does
    // not start as one dot and then a jump. The predicted tail is not stored.
    const { real, tail } = ingest(e);
    const stroke = { pts: real.length ? real : [pointerFrom(e)], color: pen.color };
    strokes.push(stroke);
    current = { id: e.pointerId, type: e.pointerType, stroke };
    queued = [];
    setPredicted(tail);
    update();
    redraw();
    noteWriting();
    hideChromeFor(e);
    onStroke(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (ignored(e)) {
      if (e.pointerType === 'touch') e.preventDefault();
      return;
    }
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
    const lift = chromeOnPointer({ type: e.pointerType, phase: e.type === 'pointercancel' ? 'cancel' : 'up', buttons: 0, reducedMotion: reducedMotion() });
    if (current.erasing) {
      eraseWith(e);
      if (eraseLog?.length) remember({ kind: 'erase', items: eraseLog });
      eraseLog = null;
      eraserAt = null;
      current = null;
      drawOverlay();
      redraw();
      update();
      scheduleChrome(lift);
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
    scheduleChrome(lift);
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
    if (open) showPrompt();
  }

  /* -------------------------------------------------------- write mode */

  let open = false;
  let writeLayer = null;
  let anchor = null;
  let promptNode = null;
  let promptHome = null;
  let promptNext = null;
  let chromeHome = null;
  let chromeNext = null;
  let scrollSnap = null;
  let chromeTimer = 0;
  let promptTimer = 0;
  let onKey = null;
  let removeObserver = null;
  const edgeBtn = h('button', { type: 'button', class: 'write-edge', 'aria-label': 'Show the question', hidden: true, onclick: () => showPrompt() });
  const doneBtn = h('button', { type: 'button', class: 'btn primary write-done', 'aria-label': 'Done', onclick: () => exitWrite() }, 'Done');
  const handleBtn = h('button', { type: 'button', class: 'write-handle', 'aria-label': 'Show writing tools', onclick: () => showChrome() }, h('span', { class: 'write-grab', 'aria-hidden': 'true' }));

  function currentPrompt() {
    const value = typeof promptEl === 'function' ? promptEl() : promptEl;
    return value && value.nodeType === 1 ? value : null;
  }

  function emitWrite() {
    window.dispatchEvent(new CustomEvent(WRITE_MODE_CHANGE));
  }

  function captureScrolls() {
    const scrolls = [];
    const seen = new Set();
    const take = (node) => {
      if (!node || node.nodeType !== 1 || seen.has(node)) return;
      seen.add(node);
      scrolls.push({ node, top: node.scrollTop || 0, left: node.scrollLeft || 0 });
    };
    take(document.scrollingElement);
    document.querySelectorAll('.study-stage, .pencil-body, .pencil-stage, .sheet-body').forEach((node) => take(node));
    let n = el.parentElement;
    while (n) {
      take(n);
      n = n.parentElement;
    }
    return { scrollX: window.scrollX || 0, scrollY: window.scrollY || 0, scrolls };
  }

  function restoreScroll() {
    if (!scrollSnap) return;
    for (const s of scrollSnap.scrolls) {
      if (s.node?.isConnected) {
        s.node.scrollTop = s.top;
        s.node.scrollLeft = s.left;
      }
    }
    window.scrollTo(scrollSnap.scrollX, scrollSnap.scrollY);
  }

  function showPrompt() {
    if (!open || !writeLayer || !promptNode) return;
    clearTimeout(promptTimer);
    promptTimer = 0;
    writeLayer.dataset.prompt = 'shown';
    edgeBtn.hidden = true;
  }

  function collapsePrompt() {
    if (!open || !writeLayer || !promptNode) return;
    writeLayer.dataset.prompt = 'collapsed';
    edgeBtn.hidden = false;
  }

  function noteWriting() {
    if (!open || !writeLayer || writeLayer.dataset.prompt !== 'shown' || promptTimer) return;
    promptTimer = setTimeout(() => {
      promptTimer = 0;
      collapsePrompt();
    }, PROMPT_HOLD_MS);
  }

  function showChrome() {
    if (!open || !writeLayer) return;
    clearTimeout(chromeTimer);
    chromeTimer = 0;
    writeLayer.dataset.chrome = 'shown';
  }

  function hideChromeFor(e) {
    if (!open || !writeLayer) return;
    const plan = chromeOnPointer({ type: e.pointerType, phase: 'down', buttons: e.buttons, reducedMotion: reducedMotion() });
    if (plan?.chrome !== 'hidden') return;
    clearTimeout(chromeTimer);
    chromeTimer = 0;
    writeLayer.dataset.chrome = 'hidden';
  }

  function scheduleChrome(plan) {
    if (!open || !writeLayer || !plan) return;
    clearTimeout(chromeTimer);
    if (plan.delay <= 0) {
      writeLayer.dataset.chrome = 'shown';
      return;
    }
    chromeTimer = setTimeout(() => {
      chromeTimer = 0;
      if (open && writeLayer) writeLayer.dataset.chrome = 'shown';
    }, plan.delay);
  }

  function putBack(node, home, next) {
    if (!node || !home?.isConnected) return;
    home.insertBefore(node, next && next.parentNode === home ? next : null);
  }

  function enterWrite() {
    if (open || !writeModeControlOn()) return false;
    if (closeCurrentWrite && closeCurrentWrite !== exitWrite) closeCurrentWrite();
    if (open) return false;
    scrollSnap = captureScrolls();
    session.enter({
      scrollX: scrollSnap.scrollX,
      scrollY: scrollSnap.scrollY,
      scrolls: scrollSnap.scrolls.map((s) => ({ top: s.top, left: s.left })),
    });
    const abs = getComputedStyle(el).position === 'absolute';
    anchor = abs
      ? document.createComment('write')
      : h('div', { class: 'write-placeholder', 'aria-hidden': 'true', style: { height: `${Math.round(el.getBoundingClientRect().height)}px` } });
    el.parentNode?.insertBefore(anchor, el);
    promptNode = currentPrompt();
    if (promptNode) {
      promptHome = promptNode.parentNode;
      promptNext = promptNode.nextSibling;
    }
    if (chromeTarget) {
      chromeHome = chromeTarget.parentNode;
      chromeNext = chromeTarget.nextSibling;
    }
    const promptStrip = h('div', { class: 'write-prompt' });
    if (promptNode) promptStrip.append(promptNode);
    const panel = h('div', { class: 'write-tools' }, chromeTarget, doneBtn);
    const dock = h('div', { class: 'write-dock' }, panel, handleBtn);
    writeLayer = h('dialog', {
      class: ['write-overlay', el.closest('.pencil-paper') ? 'write-paper' : ''],
      'aria-label': 'Write Mode',
      dataset: { chrome: 'shown', prompt: promptNode ? 'shown' : 'off' },
    }, promptStrip, el, edgeBtn, dock);
    edgeBtn.hidden = true;
    writeLayer.addEventListener('cancel', (e) => {
      e.preventDefault();
      exitWrite();
    });
    writeLayer.addEventListener('close', () => {
      if (open) exitWrite();
    });
    open = true;
    closeCurrentWrite = exitWrite;
    el.dataset.write = '1';
    try {
      document.body.append(writeLayer);
      writeLayer.showModal();
    } catch {
      exitWrite();
      return false;
    }
    removeObserver?.disconnect();
    removeObserver = new MutationObserver(() => {
      if (open && anchor && !anchor.isConnected) exitWrite();
    });
    removeObserver.observe(document.body, { childList: true, subtree: true });
    onKey = (e) => {
      if (!open || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      exitWrite();
    };
    document.addEventListener('keydown', onKey, true);
    emitWrite();
    requestAnimationFrame(() => { if (open) resize(); });
    announce('Write mode. The page fills the screen. Done or Escape leaves it.');
    return true;
  }

  function exitWrite() {
    if (!open) return false;
    open = false;
    if (closeCurrentWrite === exitWrite) closeCurrentWrite = null;
    clearTimeout(chromeTimer);
    clearTimeout(promptTimer);
    chromeTimer = 0;
    promptTimer = 0;
    session.exit();
    removeObserver?.disconnect();
    removeObserver = null;
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
    putBack(promptNode, promptHome, promptNext);
    putBack(chromeTarget, chromeHome, chromeNext);
    if (anchor?.parentNode) {
      anchor.parentNode.insertBefore(el, anchor);
      anchor.remove();
    }
    anchor = null;
    promptNode = null;
    promptHome = null;
    promptNext = null;
    chromeHome = null;
    chromeNext = null;
    const layer = writeLayer;
    writeLayer = null;
    try {
      if (layer?.open) layer.close();
    } catch {
      /* closing from the dialog's own cancel event */
    }
    layer?.remove();
    el.dataset.write = '0';
    edgeBtn.hidden = true;
    restoreScroll();
    requestAnimationFrame(restoreScroll);
    resize();
    emitWrite();
    announce('Left write mode.');
    return true;
  }

  function toggleWrite() {
    return open ? exitWrite() : enterWrite();
  }

  const onWritePref = () => {
    if (!el.isConnected && !open) {
      window.removeEventListener(WRITE_MODE_EVENT, onWritePref);
      return;
    }
    if (!writeModeControlOn()) exitWrite();
  };
  window.addEventListener(WRITE_MODE_EVENT, onWritePref);

  api = {
    el,
    canvas,
    resize,
    isEmpty: () => !strokes.length && !queued.length,
    hasPlate: () => !!plate,
    plateId: () => plateMediaId,
    /** Show a saved drawing under new strokes. `url` is revoked when replaced. */
    setPlate,
    /**
     * Faint model to trace. Not a stroke, so Clear and Done still see an
     * empty pad. The model is full while the page is empty and lifts as
     * soon as ink lands, so the new stroke is the mark. Undo or Clear
     * back to an empty page brings it back.
     */
    setGhost(image) {
      ghost = image || null;
      redraw();
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
    /** Move an external tool row into the Write Mode edge. The study pad uses its own row. */
    setChromeTarget(node) {
      chromeTarget = node || null;
    },
    enterWrite,
    exitWrite,
    toggleWrite,
    isWriting: () => open,
    /** The ink cropped to what was written: PNG data URL and size in CSS px (or null). The predicted tail is not included. `background` fills the crop (a paper sheet) so the PNG stays legible in either theme. */
    snapshot({ background = null } = {}) {
      applyQueued();
      const saved = predicted;
      setPredicted([]);
      cancelFrame();
      omitGhost = true;
      redraw();
      omitGhost = false;
      const restoreOverlay = () => {
        if (current && saved.length) setPredicted(saved);
        if (ghost || (current && saved.length)) redraw();
      };
      if (plate && strokes.length) {
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
      const o = out.getContext('2d');
      o.imageSmoothingEnabled = true;
      o.imageSmoothingQuality = 'high';
      if (background) {
        o.fillStyle = background;
        o.fillRect(0, 0, out.width, out.height);
      }
      o.drawImage(canvas, 0, 0);
        restoreOverlay();
        const r = canvas.getBoundingClientRect();
        return { src: out.toDataURL('image/png'), width: Math.round(r.width), height: Math.round(r.height) };
      }
      if (!strokes.length) {
        restoreOverlay();
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
      o.imageSmoothingEnabled = true;
      o.imageSmoothingQuality = 'high';
      if (background) {
        o.fillStyle = background;
        o.fillRect(0, 0, out.width, out.height);
      }
      const r = canvas.getBoundingClientRect();
      const outside = all.some((p) => p.x < -1 || p.y < -1 || p.x > r.width + 1 || p.y > r.height + 1);
      if (outside) {
        // The page was larger while writing. Paint the stored points into
        // the crop so leaving Write Mode does not drop ink from the PNG.
        const z = view.zoom > 0 ? view.zoom : 1;
        o.setTransform(dpr * z, 0, 0, dpr * z, dpr * ((view.panX || 0) - x0), dpr * ((view.panY || 0) - y0));
        o.lineCap = 'round';
        o.lineJoin = 'round';
        for (const s of strokes) {
          o.strokeStyle = o.fillStyle = s.color || getComputedStyle(canvas).color;
          drawPoints(s.pts, o);
        }
      } else {
        o.drawImage(canvas, x0 * dpr, y0 * dpr, out.width, out.height, 0, 0, out.width, out.height);
      }
      restoreOverlay();
      return { src: out.toDataURL('image/png'), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    },
  };
  Object.defineProperty(el, 'inkState', {
    configurable: true,
    value: () => ({ strokes, history, redo: redoStack, view, eraser: erasing, writing: open }),
  });
  return api;
}
