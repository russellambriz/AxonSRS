/**
 * Per-presentation measurement recorder.
 *
 * Uses performance.now() for every duration (never compared across page
 * loads or devices) and Date.now() only for durable event timestamps.
 * Time while the document is hidden or the in-session editor is open is
 * excluded from all durations and flagged.
 */

import { typingEffort, graphemeLength } from '../core/text.js';
import { median } from '../core/util.js';
import { detectClockJump } from '../core/time.js';

const PAUSE_FLOOR_MS = 1500;

export class TrialRecorder {
  constructor({ now = () => performance.now(), wall = () => Date.now() } = {}) {
    this.now = now;
    this.wall = wall;
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.wallStart = null;
    this.firstInputAt = null;
    this.lastInputAt = null;
    this.gaps = [];
    this.longestGap = 0;
    this.pauses = 0;
    this.backspaces = 0;
    this.deletions = 0;
    this.corrections = 0;
    this.inDeleteBurst = false;
    this.inputEvents = 0;
    this.origins = { typed: 0, paste: 0, toolbar: 0, dictation: 0, voice: 0, autofill: 0, composition: 0, drop: 0, other: 0 };
    this.firstOrigin = null;
    this.pausedAt = null;
    this.pauseReason = null;
    this.hiddenMs = 0;
    this.editorMs = 0;
    this.maxHiddenSpan = 0;
    this.lastKeydown = null;
    this.signals = { textInputs: 0, keydownWithCode: 0, keydownUnidentified: 0, inputsWithoutKeydown: 0, viewportShrunk: false, lastPointerType: null, coarsePointer: false, finePointer: false, voiceInputs: 0, dictationInputs: 0 };
    this.composing = false;
    this.voiceStartAt = null;
    this.assistance = { hintShown: false, revealed: false, solutionViewed: false };
    this.editorOpened = false;
  }

  /** Call when the prompt (text, math, images) is rendered and readable. */
  start({ coarsePointer = false, finePointer = false, lastPointerType = null } = {}) {
    this.reset();
    this.startedAt = this.now();
    this.wallStart = this.wall();
    this.signals.coarsePointer = coarsePointer;
    this.signals.finePointer = finePointer;
    this.signals.lastPointerType = lastPointerType;
  }

  get running() {
    return this.startedAt != null && this.pausedAt == null;
  }

  /** Time excluded so far plus any open pause. */
  excludedMs(at = this.now()) {
    return this.hiddenMs + this.editorMs + (this.pausedAt != null ? at - this.pausedAt : 0);
  }

  elapsed(at = this.now()) {
    if (this.startedAt == null) return 0;
    return at - this.startedAt - this.excludedMs(at);
  }

  pause(reason) {
    if (this.startedAt == null || this.pausedAt != null) return;
    this.pausedAt = this.now();
    this.pauseReason = reason;
    if (reason === 'editor') this.editorOpened = true;
  }

  resume() {
    if (this.pausedAt == null) return;
    const span = this.now() - this.pausedAt;
    if (this.pauseReason === 'editor') this.editorMs += span;
    else {
      this.hiddenMs += span;
      this.maxHiddenSpan = Math.max(this.maxHiddenSpan, span);
    }
    // Input timestamps use the active clock (activeNow), which already
    // excludes paused spans, so nothing needs shifting here.
    this.pausedAt = null;
    this.pauseReason = null;
  }

  /** Active-time clock: monotonic now minus excluded spans. */
  activeNow() {
    return this.now() - this.excludedMs();
  }

  onPointer(e) {
    this.signals.lastPointerType = e.pointerType || this.signals.lastPointerType;
  }

  onKeydown(e) {
    if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process') {
      this.signals.keydownUnidentified++;
      this.lastKeydown = { at: this.now(), coded: false };
      return;
    }
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
      this.lastKeydown = { at: this.now(), coded: !!e.code };
      if (e.code) this.signals.keydownWithCode++;
      else this.signals.keydownUnidentified++;
    }
  }

  onComposition(type) {
    this.composing = type === 'start' || type === 'update';
    if (type === 'start') this.origins.composition++;
  }

  /**
   * Record an input event. `origin` overrides detection (toolbar, voice).
   */
  onInput(e, { origin = null, value = '' } = {}) {
    if (this.startedAt == null || this.pausedAt != null) return;
    const t = this.activeNow();
    const type = e?.inputType || 'insertText';
    let o = origin;
    if (!o) {
      if (type === 'insertFromPaste' || type === 'insertFromPasteAsQuotation') o = 'paste';
      else if (type === 'insertFromDrop') o = 'drop';
      else if (type === 'insertFromDictation') o = 'dictation';
      else if (type === 'insertReplacementText') o = 'autofill';
      else if (type === 'insertCompositionText' || (e && e.isComposing)) o = 'composition';
      else if (type.startsWith('insert')) o = 'typed';
      else if (type.startsWith('delete')) o = 'delete';
      else o = 'other';
    }
    if (o === 'delete') {
      this.deletions++;
      if (type === 'deleteContentBackward') this.backspaces++;
      if (!this.inDeleteBurst && this.firstInputAt != null) this.corrections++;
      this.inDeleteBurst = true;
      this.noteGap(t);
      return;
    }
    this.inDeleteBurst = false;
    if (!value && o !== 'toolbar') return;
    this.inputEvents++;
    this.signals.textInputs++;
    if (o in this.origins) this.origins[o]++;
    else this.origins.other++;
    if (o === 'voice') this.signals.voiceInputs++;
    if (o === 'dictation') this.signals.dictationInputs++;
    const kd = this.lastKeydown;
    if (o === 'typed' && (!kd || this.now() - kd.at > 80)) this.signals.inputsWithoutKeydown++;
    if (this.firstInputAt == null) {
      this.firstInputAt = o === 'voice' && this.voiceStartAt != null ? this.voiceStartAt : t;
      this.firstOrigin = o;
      this.lastInputAt = t;
      return;
    }
    this.noteGap(t);
  }

  noteGap(t) {
    if (this.lastInputAt != null) {
      const gap = t - this.lastInputAt;
      this.longestGap = Math.max(this.longestGap, gap);
      const threshold = Math.max(PAUSE_FLOOR_MS, 3 * (median(this.gaps) || 0));
      if (this.gaps.length >= 2 && gap > threshold) this.pauses++;
      this.gaps.push(gap);
    }
    this.lastInputAt = t;
  }

  onVoiceStart() {
    if (this.voiceStartAt == null) this.voiceStartAt = this.activeNow();
  }

  setViewportShrunk(v) {
    if (v) this.signals.viewportShrunk = true;
  }

  /** Raw measurements for this presentation. */
  finish(answerText) {
    const end = this.activeNow();
    const start = this.startedAt;
    const latency = this.firstInputAt != null ? this.firstInputAt - start : NaN;
    const typing = this.firstInputAt != null ? end - this.firstInputAt : NaN;
    const total = end - start;
    const wallEnd = this.wall();
    // Wall clock vs. monotonic clock over the whole presentation.
    const jump = detectClockJump({ wallStart: this.wallStart, monoStart: start, wallNow: wallEnd, monoNow: this.now() });
    return {
      latencyMs: round(latency),
      typingMs: round(typing),
      totalMs: round(total),
      activeMs: round(total),
      hiddenMs: round(this.hiddenMs),
      editorMs: round(this.editorMs),
      interruptedByHidden: this.maxHiddenSpan > 2000 || this.hiddenMs > 4000,
      longestGapMs: round(Math.max(this.longestGap, Number.isFinite(latency) ? latency : 0)),
      answerLength: graphemeLength(answerText || ''),
      effort: typingEffort(answerText || ''),
      backspaces: this.backspaces,
      deletions: this.deletions,
      corrections: this.corrections,
      pauses: this.pauses,
      inputEvents: this.inputEvents,
      origins: { ...this.origins },
      firstOrigin: this.firstOrigin,
      wallStart: this.wallStart,
      wallEnd,
      clockAnomaly: jump ? jump.kind : null,
    };
  }
}

function round(x) {
  return Number.isFinite(x) ? Math.round(x) : null;
}
