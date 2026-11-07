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
import { eraseStrokes, ERASER_RADIUS, extrapolateTail, ghostPlacement, isPalmTouch, paintSamples, pointWidth, redoInkAction, simplifySamples, SMOOTHING_LEVELS, smoothingLevel, splitPointerSamples, undoInkAction } from '../core/ink.js';

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
/** Write-on ghost: full on an empty page, a whisper once ink is down (before the trace's own soft wash). */
export const GHOST_ALPHA = 0.62;
export const GHOST_LIFT_ALPHA = 0.16;

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

/**
 * `onEdit(kind)` runs after each finished edit the learner makes — a stroke
 * lifted, an erase finished, Undo, Redo or the Clear button — never during
 * a stroke and never for clear()/loadStrokes() called by code. It is where a
 * caller saves the ink (see strokesData/loadStrokes).
 */
export function inkPad({ onStroke = () => {}, onChange = null, onEdit = null, tools = true } = {}) {
  const canvas = h('canvas', { class: 'ink-canvas', role: 'img', 'aria-label': 'Handwriting pad. Write your answer with Apple Pencil, a stylus or a finger.', dataset: { strokes: '0', points: '0' } });
  const overlay = h('canvas', { class: 'ink-overlay', 'aria-hidden': 'true' });
  const ctx = canvas.getContext('2d');
  const octx = overlay.getContext('2d');
  // Finished strokes are painted here once. A frame composites this layer
  // instead of re-smoothing every stroke on the page.
  const inkLayer = document.createElement('canvas');
  const lctx = inkLayer.getContext('2d');
  let layerColor = null;
  // The stroke under the pencil. Only the tiles around the part that
  // changed since the last frame are repainted, so a frame costs the moving
  // tip, not the length of the stroke.
  const liveLayer = document.createElement('canvas');
  const vctx = liveLayer.getContext('2d');
  let liveSamples = null;
  let liveColor = null;
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
  // Write-on ghost: an alpha mask of the model handwriting, tinted for the
  // theme when drawn.
  let ghost = null;
  let ghostTint = null;
  let ghostTintColor = null;
  let ghostAlpha = 0;
  let ghostTarget = 0;
  let ghostRaf = 0;

  const undoBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => undo() }, icon('undo'), 'Undo stroke') : null;
  const eraserBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', 'aria-pressed': 'false', onclick: () => setEraser(!erasing) }, icon('eraser'), 'Eraser') : null;
  const clearBtn = tools ? h('button', { class: 'btn small ghost', type: 'button', disabled: true, onclick: () => { clear(); onEdit?.('clear'); } }, icon('trash'), 'Clear') : null;
  const hintEl = tools ? h('span', { class: 'faint small ink-hint' }, HINT) : null;
  const el = h('div', { class: 'ink-pad', dataset: { predicted: '0', hover: '0', penSeen: penSeen ? '1' : '0', ghost: '0', palm: '0' } }, stage, tools ? h('div', { class: 'ink-tools' }, hintEl, h('div', { class: 'row tight' }, undoBtn, eraserBtn, clearBtn)) : null);

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
    // A mouse or trackpad click is deliberate: the writing hand has moved on.
    if (e.pointerType === 'mouse') {
      lastPenUp = -Infinity;
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
   * Ink is painted on a fixed grid of device-pixel tiles. Within a tile,
   * every disc and link that reaches it (see simplifySamples: a disc at
   * each end of a run, a link along it) is one subpath of a single fill,
   * all wound the same way, clipped to the tile: the union stays solid (one
   * outline round a whole stroke self-intersects on a loop and punches
   * holes) and each pixel is anti-aliased once, at the edge. A second fill
   * of the same pieces, one device pixel in, keeps the inside solid where a
   * browser anti-aliases the overlaps approximately. The
   * rasterizer chooses how it anti-aliases from the size of the path it is
   * given, so filling a whole stroke at once would shade the same edge
   * differently at 100 samples and at 1500. Per tile, a pixel only ever
   * depends on the stroke near it: a tile repainted under the pencil, at
   * the lift, after an undo or for the PNG comes out the same, and a long
   * stroke costs linear time instead of quadratic.
   */
  const TILE = 64;

  function sampleRadius(s) {
    return Math.max(0.8, s.w / 2);
  }

  /** Device-pixel box of disc i (link === false) or of the link from i-1 to i, padded so its anti-aliased edge is inside. */
  function pieceBox(samples, i, link) {
    const s = samples[i];
    const r = sampleRadius(s);
    let x0 = s.x - r;
    let y0 = s.y - r;
    let x1 = s.x + r;
    let y1 = s.y + r;
    if (link) {
      // The link lies inside its two end discs, so their boxes bound it.
      const p = samples[i - 1];
      const r0 = sampleRadius(p);
      x0 = Math.min(x0, p.x - r0);
      y0 = Math.min(y0, p.y - r0);
      x1 = Math.max(x1, p.x + r0);
      y1 = Math.max(y1, p.y + r0);
    }
    return [x0 * dpr - 1, y0 * dpr - 1, x1 * dpr + 1, y1 * dpr + 1];
  }

  function hasLink(samples, i) {
    if (i === 0) return false;
    const s = samples[i];
    const p = samples[i - 1];
    return Math.hypot(s.x - p.x, s.y - p.y) >= 0.01;
  }

  /** Add disc i, or the link into i, to the path; `inset` (CSS px) shrinks it for the core pass. */
  function tracePiece(g, samples, i, link, inset = 0) {
    const s = samples[i];
    const r = sampleRadius(s) - inset;
    if (r <= 0) return;
    if (!link) {
      g.moveTo(s.x + r, s.y);
      g.arc(s.x, s.y, r, 0, Math.PI * 2);
      return;
    }
    const p = samples[i - 1];
    const dx = s.x - p.x;
    const dy = s.y - p.y;
    const len = Math.hypot(dx, dy);
    const r0 = sampleRadius(p) - inset;
    if (r0 <= 0) return;
    const nx = -dy / len;
    const ny = dx / len;
    // Turning the same way as the discs (arc 0 → 2π). Wound the other way,
    // a rasterizer that sums signed area cancels a link against a disc and
    // leaves a hole where exactly one of each overlaps.
    g.moveTo(p.x - nx * r0, p.y - ny * r0);
    g.lineTo(s.x - nx * r, s.y - ny * r);
    g.lineTo(s.x + nx * r, s.y + ny * r);
    g.lineTo(p.x + nx * r0, p.y + ny * r0);
    g.closePath();
  }

  /**
   * Paint samples tile by tile. `only` (a device-pixel box) limits the
   * work to the tiles it touches, and with `wipe` those tiles are cleared
   * first, so a tile the stroke has left (a withdrawn tail) ends up empty.
   */
  function paintTiles(g, samples, color, only = null, wipe = false) {
    const W = g.canvas.width;
    const H = g.canvas.height;
    if (!W || !H) return;
    const cols = Math.ceil(W / TILE);
    const rows = Math.ceil(H / TILE);
    let tx0 = 0;
    let ty0 = 0;
    let tx1 = cols - 1;
    let ty1 = rows - 1;
    if (only) {
      tx0 = Math.max(tx0, Math.floor(only[0] / TILE));
      ty0 = Math.max(ty0, Math.floor(only[1] / TILE));
      tx1 = Math.min(tx1, Math.floor(only[2] / TILE));
      ty1 = Math.min(ty1, Math.floor(only[3] / TILE));
    }
    if (tx1 < tx0 || ty1 < ty0) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (wipe) g.clearRect(tx0 * TILE, ty0 * TILE, (tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE);
    // Each tile's pieces, in stroke order: disc i is 2i, the link into i is 2i+1.
    const tiles = new Map();
    const put = (box, code) => {
      const a = Math.max(tx0, Math.floor(box[0] / TILE));
      const b = Math.min(tx1, Math.floor(box[2] / TILE));
      const c = Math.max(ty0, Math.floor(box[1] / TILE));
      const d = Math.min(ty1, Math.floor(box[3] / TILE));
      for (let ty = c; ty <= d; ty++) {
        for (let tx = a; tx <= b; tx++) {
          const key = ty * cols + tx;
          const list = tiles.get(key);
          if (list) list.push(code);
          else tiles.set(key, [code]);
        }
      }
    };
    for (let i = 0; i < samples.length; i++) {
      put(pieceBox(samples, i, false), i * 2);
      if (hasLink(samples, i)) put(pieceBox(samples, i, true), i * 2 + 1);
    }
    g.fillStyle = color;
    for (const [key, codes] of tiles) {
      const tx = key % cols;
      const ty = (key - tx) / cols;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.beginPath();
      g.rect(tx * TILE, ty * TILE, TILE, TILE);
      g.clip();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.beginPath();
      for (const code of codes) tracePiece(g, samples, code >> 1, (code & 1) === 1);
      g.fill();
      // The core: the same pieces one device pixel in. Browsers anti-alias
      // a union of overlapping subpaths approximately and can leave a
      // lighter row inside the ink; the core is solid there. It stays a
      // pixel clear of the outline, so the edge is still anti-aliased once.
      g.beginPath();
      for (const code of codes) tracePiece(g, samples, code >> 1, (code & 1) === 1, 1 / dpr);
      g.fill();
      g.restore();
    }
  }

  /** What the fill paints for these points: the smoothed samples, thinned to the runs that matter. */
  function strokeSamples(pts) {
    return simplifySamples(paintSamples(pts, smoothingId));
  }

  function fillStroke(g, pts, color) {
    paintTiles(g, strokeSamples(pts), color);
  }

  const sameSample = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w;

  /**
   * Bring the live layer up to date with the stroke under the pencil (and
   * its predicted tail). Samples that did not move since the last frame are
   * left alone; the tiles around the ones that did (new and old positions,
   * so a withdrawn tail is wiped) are repainted. A tile left alone holds
   * the same pieces it was painted with, so the layer always matches
   * painting the whole stroke from scratch.
   */
  function updateLive(samples, color) {
    // A new colour (a theme switch mid-stroke) repaints every tile, not just the tip.
    if (color !== liveColor) resetLive();
    liveColor = color;
    const prev = liveSamples || [];
    let i = 0;
    const n = Math.min(prev.length, samples.length);
    while (i < n && sameSample(prev[i], samples[i])) i++;
    liveSamples = samples;
    if (i === samples.length && i === prev.length) return;
    // A changed sample also moves the link from the one before it.
    const from = Math.max(0, i - 1);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const grow = (list) => {
      for (let k = from; k < list.length; k++) {
        const s = list[k];
        const r = sampleRadius(s) * dpr + 2;
        box[0] = Math.min(box[0], s.x * dpr - r);
        box[1] = Math.min(box[1], s.y * dpr - r);
        box[2] = Math.max(box[2], s.x * dpr + r);
        box[3] = Math.max(box[3], s.y * dpr + r);
      }
    };
    grow(samples);
    grow(prev);
    if (!(box[2] > box[0])) return;
    paintTiles(vctx, samples, color, box, true);
  }

  function resetLive() {
    liveSamples = null;
    liveColor = null;
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, liveLayer.width, liveLayer.height);
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

  /**
   * The stroke that just finished joins the ink layer. The live layer is
   * brought up to date without the predicted tail (only the tiles at the
   * tip change) and copied across: its tiles hold the same pieces a repaint
   * would paint, so an undo or a theme switch later moves nothing, and
   * lifting the pencil costs the same after a long stroke as after a dot.
   */
  function commitInk(stroke) {
    if (!inkLayer.width || !inkLayer.height) {
      resetLive();
      return;
    }
    if (layerColor === null) layerColor = inkColor();
    updateLive(strokeSamples(stroke.pts), stroke.color || layerColor);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.drawImage(liveLayer, 0, 0);
    resetLive();
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

  /** The ghost tint (--ink-ghost): graphite on a light pad, a pale wash on a dark one, so the model reads in both. */
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
   * The model handwriting at the size it was written (its PNG is in device
   * pixels), only ever shrunk to leave a margin — never blown up and
   * blurred — centred, a little above the middle where the pencil starts.
   */
  function drawGhost(g) {
    if (!ghost || ghostAlpha <= 0.002) return;
    const tint = tintedGhost();
    const r = cssSize();
    if (!tint) return;
    const place = ghostPlacement({ imageWidth: tint.width, imageHeight: tint.height, padWidth: r.width, padHeight: r.height, dpr: ghost.ratio });
    if (!place) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.save();
    g.globalAlpha = ghostAlpha;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(tint, place.x, place.y, place.w, place.h);
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
      updateLive(strokeSamples(predicted.length ? s.pts.concat(predicted) : s.pts), s.color || inkColor());
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(liveLayer, 0, 0);
    }
  }

  function redraw() {
    repaintInk();
    resetLive();
    composite();
  }

  /* ------------------------------------------------------------- the ghost */

  function setGhostState() {
    el.dataset.ghost = !ghost ? '0' : ghostTarget < GHOST_ALPHA ? 'lift' : '1';
  }

  function writingNow() {
    return strokes.length > 0 || queued.length > 0 || !!current?.stroke;
  }

  /** Full while the page is empty, lifted once ink lands, back when the page is empty again. */
  function syncGhost(ms = 200) {
    const to = !ghost ? 0 : writingNow() ? GHOST_LIFT_ALPHA : GHOST_ALPHA;
    if (to !== ghostTarget) fadeGhost(to, ms);
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
    syncGhost();
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
    onEdit?.('undo');
    return true;
  }

  function redo() {
    if (current || !redoStack.length) return false;
    const action = redoStack.pop();
    replaceStrokes(redoInkAction(strokes, action));
    history.push(action);
    redraw();
    update();
    onEdit?.('redo');
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
    liveLayer.width = w;
    liveLayer.height = hPx;
    liveSamples = null;
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
    // Coalesced history on the down event, in order, so a fast stroke does
    // not start as one dot and then a jump. The predicted tail is not stored.
    const { real, tail } = ingest(e);
    const stroke = { pts: real.length ? real : [pointerFrom(e)], color: pen.color };
    strokes.push(stroke);
    current = { id: e.pointerId, type: e.pointerType, stroke };
    resetLive();
    queued = [];
    setPredicted(tail);
    update();
    composite();
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
    // The browser's prediction wins; without one, run a short way ahead of the tip.
    setPredicted(tail.length ? tail : extrapolateTail(current.stroke.pts.slice(-3).concat(queued).slice(-3)));
    schedule();
  });

  const end = (e) => {
    if (!current || e.pointerId !== current.id) return;
    if (current.erasing) {
      eraseWith(e);
      const erased = !!eraseLog?.length;
      if (erased) remember({ kind: 'erase', items: eraseLog });
      eraseLog = null;
      eraserAt = null;
      current = null;
      drawOverlay();
      redraw();
      update();
      if (erased) onEdit?.('erase');
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
    onEdit?.('stroke');
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
    // A fresh page: update() brings the model back to full strength for another go.
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
     * Faint model to trace: an image whose alpha is the ink, tinted for the
     * theme and shown at the size it was written (`pixelRatio` = device
     * pixels per CSS pixel of the image, this device's by default). It is
     * full while the page is empty and lifts as soon as ink lands, so the
     * new stroke is the mark; Undo or Clear back to an empty page brings it
     * back. Not a stroke, so Clear and Done still see an empty pad, and
     * never part of a snapshot.
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
      ghostTarget = 0;
      syncGhost(280);
    },
    strokeCount: () => strokes.length,
    clear,
    /**
     * The finished strokes as plain data: points in CSS pixels of the pad
     * (x, y, pressure and the optional pen fields), plus each stroke's
     * colour. Never the stroke under the pencil, the ghost or a predicted
     * tail. `width`/`height` are the pad's CSS size when copied.
     */
    strokesData() {
      const r = canvas.getBoundingClientRect();
      return {
        strokes: strokes.map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) })),
        width: Math.round(r.width) || null,
        height: Math.round(r.height) || null,
      };
    },
    /**
     * Replace the page with saved strokes (from strokesData), keeping them
     * editable: each one can be undone, erased or cleared like a stroke
     * just written. Points keep their CSS-pixel positions, the same as a
     * live resize. Does not call onEdit.
     */
    loadStrokes(list) {
      clear();
      for (const s of list || []) {
        if (!s || !Array.isArray(s.pts) || !s.pts.length) continue;
        const stroke = { ...s, pts: s.pts.map((p) => ({ ...p })) };
        strokes.push(stroke);
        history.push({ kind: 'add', stroke });
      }
      redraw();
      update();
    },
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
      // composite() just brought the live layer up to date without the tail.
      if (current?.stroke) cg.drawImage(liveLayer, 0, 0);
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
