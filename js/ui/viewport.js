/**
 * Mobile keyboard and viewport handling.
 *
 * Publishes the visual viewport as CSS variables so the study screen can
 * keep the question, answer field and controls above an on-screen
 * keyboard:
 *   --vvh       visible height (px)
 *   --vv-top    offset of the visual viewport (iOS scrolls it when the
 *               keyboard opens; we translate the fixed study layer by it)
 *   --kb-offset estimated on-screen keyboard height
 * and toggles body.keyboard-open. Browsers without visualViewport fall
 * back to window.innerHeight. Nothing here forces the keyboard open or
 * closed — browsers do not reliably allow that.
 */

let started = false;
let lastShrunk = false;
const listeners = new Set();

export function viewportState() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  const layout = window.innerHeight;
  const kb = Math.max(0, layout - height - top);
  // A shrink of more than ~25% while an input is focused means an
  // on-screen keyboard is very likely visible.
  const focusedInput = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  const shrunk = !!vv && focusedInput && (kb > 120 || height < layout * 0.75);
  return { height, top, kb, shrunk };
}

function apply() {
  const s = viewportState();
  const root = document.documentElement;
  root.style.setProperty('--vvh', `${Math.round(s.height)}px`);
  root.style.setProperty('--vv-top', `${Math.round(s.top)}px`);
  root.style.setProperty('--kb-offset', `${Math.round(s.kb)}px`);
  document.body.classList.toggle('keyboard-open', s.shrunk);
  if (s.shrunk !== lastShrunk) {
    lastShrunk = s.shrunk;
    for (const fn of listeners) fn(s);
  }
}

export function startViewport() {
  if (started) return;
  started = true;
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
  document.addEventListener('focusin', () => setTimeout(apply, 50));
  document.addEventListener('focusout', () => setTimeout(apply, 50));
  apply();
}

export function onKeyboardChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True if the last viewport measurement suggests an on-screen keyboard. */
export function keyboardLikelyOpen() {
  return lastShrunk;
}
