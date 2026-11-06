/**
 * Write Mode state. No DOM.
 *
 * Enter and exit record layout (scroll and the view zoom/pan) and put that
 * view back. Stroke arrays, point objects, and the undo/redo stacks are
 * never copied or rewritten. The tool the learner is holding is left as
 * it is. Pinch-zoom and two-finger pan, when a view carries them, map
 * through the same content point as the hover nib and the wet stroke.
 */

/** Wait after the pencil lifts before the edge tools fade back in. */
export const CHROME_DELAY_MS = 220;

/** How long the question stays up once writing starts. */
export const PROMPT_HOLD_MS = 1200;

/** Settings → Study. Missing or anything other than '0' shows the control. */
export function writeModeControlEnabled(stored) {
  return stored !== '0';
}

/**
 * Canvas CSS pixels → content space. An identity view (zoom 1, no pan)
 * is the canvas offset, which is how stored points are already written.
 */
export function contentPoint(client, rect, view = {}) {
  const zoom = typeof view.zoom === 'number' && view.zoom > 0 ? view.zoom : 1;
  const panX = typeof view.panX === 'number' ? view.panX : 0;
  const panY = typeof view.panY === 'number' ? view.panY : 0;
  return {
    x: ((client.x - rect.left) - panX) / zoom,
    y: ((client.y - rect.top) - panY) / zoom,
  };
}

/**
 * Edge chrome. Only a pen with the tip down hides it. After the lift,
 * show again once the delay has passed. Reduced motion shows on the lift
 * with no wait. A finger or a mouse does not change the chrome.
 */
export function chromeOnPointer({ type, phase, buttons = 0, reducedMotion = false } = {}) {
  if (type !== 'pen') return null;
  if (phase === 'down') return buttons > 0 ? { chrome: 'hidden', delay: 0 } : null;
  if (phase === 'up' || phase === 'cancel') return { chrome: 'shown', delay: reducedMotion ? 0 : CHROME_DELAY_MS };
  return null;
}

/**
 * One Write Mode session over an existing pad state.
 * `state.view` is restored on exit. `state.strokes`, `state.history`
 * and `state.redo` are not read or replaced.
 */
export function createWriteSession(state) {
  let open = false;
  let layout = null;
  return {
    isOpen: () => open,
    enter(extra = {}) {
      if (open) return null;
      layout = {
        scrollX: extra.scrollX || 0,
        scrollY: extra.scrollY || 0,
        scrolls: (extra.scrolls || []).map((s) => ({ top: s.top || 0, left: s.left || 0 })),
        view: {
          zoom: state.view.zoom,
          panX: state.view.panX,
          panY: state.view.panY,
        },
      };
      open = true;
      return layout;
    },
    exit() {
      if (!open || !layout) return null;
      const restore = layout;
      state.view.zoom = restore.view.zoom;
      state.view.panX = restore.view.panX;
      state.view.panY = restore.view.panY;
      open = false;
      layout = null;
      return restore;
    },
  };
}
