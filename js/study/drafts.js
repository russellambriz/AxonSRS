/**
 * The one authoritative unfinished-attempt state for the card on screen,
 * and its ordered saving.
 *
 * The study screen tells the keeper about every change (typed text, ink,
 * confidence, input mode). The keeper owns the copy that is saved; the
 * input field and the ink pad are views of it, so switching Type ↔ Write or
 * remounting the pad never decides what the draft holds.
 *
 * Saving
 *  - One write in flight at a time. Edits made while a write is in flight
 *    are coalesced into the next write, so writes can never land out of
 *    order and an older copy can never overwrite a newer one.
 *  - Every write is compare-and-swap on the stored revision
 *    (store.saveDraft), so a stale tab cannot overwrite a newer draft.
 *  - Typing is debounced (`debounceMs`, 250 ms by default); a finished
 *    stroke, Undo, Clear, a confidence choice and a mode switch save at once.
 *  - Nothing is saved before `hydrate()`: an empty editor at start-up can
 *    never overwrite a saved draft.
 *  - "saved" is reported only when the latest edit is committed.
 *  - A failed write keeps everything in memory; `retry()` (or the next
 *    edit) tries again.
 */

import { cloneStrokes } from '../core/draft.js';

export const DRAFT_DEBOUNCE_MS = 250;

export class DraftKeeper {
  /**
   * @param {object} o
   * @param {string} o.key attempt key (js/core/draft.js attemptKey)
   * @param {object} o.meta stored with each draft: unitId, cardId, cardUpdatedAt
   * @param {(record: object, baseRev: number) => Promise<{status: string, rev?: number}>} o.save
   * @param {(status: string, keeper: DraftKeeper) => void} [o.onStatus]
   */
  constructor({ key, meta = {}, save, onStatus = () => {}, debounceMs = DRAFT_DEBOUNCE_MS }) {
    this.key = key;
    this.meta = meta;
    this.saveFn = save;
    this.onStatus = onStatus;
    this.debounceMs = debounceMs;
    this.state = { stage: 'answering', mode: null, text: '', ink: { strokes: [], width: null, height: null }, confidence: null, assistance: { hintShown: false, solutionViewed: false } };
    this.hydrated = false;
    this.frozen = false; // the attempt has been checked: no more saves
    this.disabled = false; // this screen no longer owns the attempt
    this.baseRev = 0;
    this.edits = 0; // local edit counter
    this.savedEdits = 0; // edits covered by the last committed write
    this.timer = null;
    this.inflight = null;
    this.status = 'idle'; // idle | pending | saving | saved | error | conflict
    this.error = null;
    this.conflictRev = null;
  }

  /** Start from what is stored (a readDraft() result for this attempt, or null). Enables saving. */
  hydrate(stored) {
    if (stored && stored.key === this.key) {
      this.baseRev = stored.rev || 0;
      if (stored.stage === 'answering') {
        this.state = {
          stage: 'answering',
          mode: stored.mode,
          text: stored.text,
          ink: { strokes: cloneStrokes(stored.ink.strokes), width: stored.ink.width, height: stored.ink.height },
          confidence: stored.confidence,
          assistance: { ...stored.assistance },
        };
      }
    }
    this.hydrated = true;
    if (stored && stored.key === this.key && stored.stage === 'answering' && this.baseRev > 0) this.setStatus('saved');
    return this.restorable(stored);
  }

  /** The stored draft is one to put back on screen. */
  restorable(stored) {
    return !!(stored && stored.key === this.key && stored.stage === 'answering');
  }

  get active() {
    return this.hydrated && !this.frozen && !this.disabled;
  }

  /** Record a change. `immediate` saves now; otherwise after the debounce. Returns false when not saving. */
  update(patch, { immediate = false } = {}) {
    if (!this.active) return false;
    const next = { ...this.state, ...patch };
    if (patch.ink) next.ink = { strokes: cloneStrokes(patch.ink.strokes), width: patch.ink.width ?? null, height: patch.ink.height ?? null };
    if (patch.assistance) next.assistance = { ...this.state.assistance, ...patch.assistance };
    this.state = next;
    this.edits++;
    if (this.status !== 'saving') this.setStatus('pending');
    clearTimeout(this.timer);
    this.timer = null;
    if (immediate || !this.debounceMs) this.kick();
    else this.timer = setTimeout(() => this.kick(), this.debounceMs);
    return true;
  }

  /** Save now; resolves true when every edit so far is committed. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.hydrated || this.disabled) return Promise.resolve(false);
    if (this.savedEdits === this.edits && !this.inflight) return Promise.resolve(this.status !== 'error' && this.status !== 'conflict');
    return this.kick();
  }

  /** The answer was checked (or shown): stop saving this attempt. A pending debounce is dropped. */
  freeze() {
    this.frozen = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Another screen or tab now owns this attempt. Nothing more is written from here. */
  disable() {
    this.disabled = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Try again after an error. After a conflict this tab (the one studying)
   * keeps its own version, the learner's explicit choice: it writes over
   * the revision it now knows about.
   */
  retry() {
    if (!this.hydrated || this.disabled || this.frozen) return Promise.resolve(false);
    if (this.status === 'conflict' && this.conflictRev != null) this.baseRev = this.conflictRev;
    if (this.savedEdits === this.edits) this.edits++; // force one write of the current state
    return this.kick();
  }

  /** The record written for the current state. */
  record() {
    const s = this.state;
    return {
      key: this.key,
      ...this.meta,
      stage: s.stage,
      mode: s.mode,
      text: s.text,
      ink: { strokes: cloneStrokes(s.ink.strokes), width: s.ink.width, height: s.ink.height },
      confidence: s.confidence,
      assistance: { ...s.assistance },
    };
  }

  kick() {
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async run() {
    for (;;) {
      if (this.disabled) return false;
      const upTo = this.edits;
      if (upTo === this.savedEdits) return this.status === 'saved' || this.status === 'idle' || this.status === 'pending';
      const record = this.record();
      this.setStatus('saving');
      let res;
      try {
        res = await this.saveFn(record, this.baseRev);
      } catch (err) {
        this.error = err;
        this.setStatus('error');
        return false;
      }
      if (res?.status === 'saved') {
        this.baseRev = res.rev;
        this.savedEdits = upTo;
        this.error = null;
        if (this.edits === upTo) {
          this.setStatus('saved');
          return true;
        }
        continue; // more edits arrived while writing: write them now
      }
      if (res?.status === 'conflict') {
        this.conflictRev = res.rev ?? null;
        this.setStatus('conflict');
        return false;
      }
      // consumed / missing: the attempt is over; never resurrect it.
      this.freeze();
      this.setStatus('idle');
      return false;
    }
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    try {
      this.onStatus(status, this);
    } catch (err) {
      console.error(err);
    }
  }
}
