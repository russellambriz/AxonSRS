/**
 * Typing or Pencil, chosen by what the learner picks up, and the small
 * numbers the handwriting pad leaves behind for a review.
 *
 * ModalityController only decides; the study screen does the switching,
 * so the typed text and the ink are both kept exactly as a manual switch
 * keeps them (the unfinished-answer draft is never cleared here).
 *
 *  - The pencil touching the page always opens the pad, and the stroke it
 *    started is kept.
 *  - The pencil hovering over the page opens the pad only when the answer
 *    box is empty and no key has been pressed for HOVER_COOLDOWN_MS, so a
 *    pencil resting near the screen while typing does not flip the mode.
 *  - A printable key on an empty pad goes back to typing.
 *  - The answer box itself is left to the system (Scribble on iPad), and
 *    buttons, links and other fields are never a reason to switch.
 *
 * InkTelemetry keeps plain numbers only (never strokes), so nothing it
 * records can grow a review event, a backup or a sync payload. Time to the
 * first stroke is capped at AFK_CAP_MS so an answer left open while away
 * reads as slow, not as a five-minute outlier. It is recorded with the
 * review; it does not choose the grade.
 */

/** Settings → Review flow. '0' turns automatic switching off. */
export const AUTO_MODALITY_KEY = 'axon-auto-modality';
/** No hover switch for this long after a key press. */
export const HOVER_COOLDOWN_MS = 3000;
/** Time to first stroke is recorded up to this. */
export const AFK_CAP_MS = 30000;
/** A pause longer than this between one stroke lifting and the next starting is a hesitation. */
export const HESITATION_GAP_MS = 2000;

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'AltGraph']);
const CONTROLS = 'input, textarea, select, button, a, label, dialog, summary, [contenteditable], [role="button"], [role="menu"], [role="dialog"]';

export class ModalityController {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.lastKeyAt = -Infinity;
  }

  /** Any non-modifier key press starts the hover cooldown. */
  noteKey(e) {
    if (!e || MODIFIERS.has(e.key)) return;
    this.lastKeyAt = this.now();
  }

  /** A control or the answer box under the pencil: leave the event to it. */
  static onControl(target) {
    return !!target?.closest?.(CONTROLS);
  }

  /**
   * `state`: { enabled, usingInk, canSwitch, typedEmpty }.
   * canSwitch: the question is showing and the card is not a handwriting card.
   */
  shouldOpenOnHover(e, state) {
    if (!state.enabled || state.usingInk || !state.canSwitch || !state.typedEmpty) return false;
    if (e.pointerType !== 'pen' || e.buttons !== 0) return false;
    if (ModalityController.onControl(e.target)) return false;
    return this.now() - this.lastKeyAt > HOVER_COOLDOWN_MS;
  }

  shouldOpenOnPenDown(e, state) {
    if (!state.enabled || state.usingInk || !state.canSwitch) return false;
    if (e.pointerType !== 'pen' || (e.button ?? 0) > 0) return false;
    return !ModalityController.onControl(e.target);
  }

  /** `state` also takes inkEmpty. A printable key (no Ctrl/Cmd/Alt) on an empty pad. */
  shouldTypeOnKey(e, state) {
    if (!state.enabled || !state.usingInk || !state.canSwitch || !state.inkEmpty) return false;
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
    if (typeof e.key !== 'string' || [...e.key].length !== 1 || e.key === ' ') return false;
    return !ModalityController.onControl(e.target);
  }
}

/** Scalar handwriting measurements for one presentation of a card. */
export class InkTelemetry {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.lastLiftAt = null;
    this.strokes = 0;
    this.hesitationGaps = 0;
    this.undoCount = 0;
    this.eraseCount = 0;
    this.clearCount = 0;
  }

  strokeStarted() {
    const t = this.now();
    if (this.lastLiftAt != null && t - this.lastLiftAt > HESITATION_GAP_MS) this.hesitationGaps++;
    this.strokes++;
  }

  /** `kind` as the pad reports an edit: 'stroke', 'erase', 'undo', 'redo' or 'clear'. */
  edited(kind) {
    if (kind === 'stroke') this.lastLiftAt = this.now();
    else if (kind === 'undo') this.undoCount++;
    else if (kind === 'erase') this.eraseCount++;
    else if (kind === 'clear') this.clearCount++;
  }

  /** Frozen numbers for the review. `latencyMs` is the trial clock's time to the first stroke. */
  summary(latencyMs) {
    const ttfs = Number.isFinite(latencyMs) ? Math.round(Math.min(Math.max(0, latencyMs), AFK_CAP_MS)) : null;
    return Object.freeze({
      ttfsMs: ttfs,
      ttfsCapped: Number.isFinite(latencyMs) && latencyMs > AFK_CAP_MS,
      strokes: this.strokes,
      hesitationGaps: this.hesitationGaps,
      undoCount: this.undoCount,
      eraseCount: this.eraseCount,
      clearCount: this.clearCount,
    });
  }
}
