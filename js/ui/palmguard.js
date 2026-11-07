/**
 * Palm guard for the quick-add buttons. A finger or palm landing on Save
 * while a pencil is on the page is not a tap. Mouse clicks, pen taps on the
 * button, and keyboard activation (Enter, Space, Cmd/Ctrl+Enter) are never
 * treated as a palm.
 *
 * Every guarded button ignores touch while a pen is down on any ink pad,
 * and for a short moment after that pen lifts. Header buttons also ignore
 * touch while a pen is hovering, and for about a second after the pen was
 * last active.
 */

export const LIFT_GUARD_MS = 300;
export const HEADER_ACTIVE_MS = 1000;
/** A hover sample is "still hovering" for this long without a new one. */
export const HOVER_GUARD_MS = 300;

/**
 * Whether a touch (finger or palm) on a guarded button should be ignored.
 * Times are milliseconds since that event, or Infinity when it has not happened.
 */
export function rejectsTouch({ header = false, penDown = false, sinceLift = Infinity, sinceActive = Infinity, sinceHover = Infinity } = {}) {
  if (penDown || sinceLift < LIFT_GUARD_MS) return true;
  if (header && (sinceHover < HOVER_GUARD_MS || sinceActive < HEADER_ACTIVE_MS)) return true;
  return false;
}

const downOnPad = new Set();
let lastLiftAt = -Infinity;
let lastActiveAt = -Infinity;
let lastHoverAt = -Infinity;
let watching = false;

function onPen(e) {
  if (e.pointerType !== 'pen') return;
  const now = performance.now();
  const onPad = e.target instanceof Element && !!e.target.closest('.ink-pad');
  if (e.type === 'pointerdown') {
    lastActiveAt = now;
    if (onPad) downOnPad.add(e.pointerId);
    return;
  }
  if (e.type === 'pointerup' || e.type === 'pointercancel') {
    if (downOnPad.delete(e.pointerId)) lastLiftAt = now;
    lastActiveAt = now;
    return;
  }
  if ((e.type === 'pointermove' || e.type === 'pointerover') && e.buttons === 0) {
    lastHoverAt = now;
    return;
  }
  if (e.type === 'pointermove' && e.buttons !== 0) lastActiveAt = now;
}

function watchPens() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  for (const type of ['pointerdown', 'pointermove', 'pointerover', 'pointerup', 'pointercancel']) {
    document.addEventListener(type, onPen, true);
  }
}

function touchRejected(header) {
  const now = performance.now();
  return rejectsTouch({
    header,
    penDown: downOnPad.size > 0,
    sinceLift: now - lastLiftAt,
    sinceActive: now - lastActiveAt,
    sinceHover: now - lastHoverAt,
  });
}

/** Ignore palm and finger taps on this save button. `header` adds the hover and one-second window. */
export function guardQuickSave(button, { header = false } = {}) {
  watchPens();
  let pointerKind = '';
  let swallow = false;
  button.addEventListener('pointerdown', (e) => {
    pointerKind = e.pointerType || '';
    swallow = pointerKind === 'touch' && touchRejected(header);
    if (!swallow) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  button.addEventListener('click', (e) => {
    const kind = pointerKind;
    const skip = swallow || (kind === 'touch' && touchRejected(header));
    pointerKind = '';
    swallow = false;
    if (!skip) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}
