/**
 * The study screen: one card at a time, one persistent answer input.
 *
 * Phases: loading → question → (submitting) → feedback | grading (manual)
 *         → retype (after a miss) → next card … → done
 * Plus paused, error (save failed, answer kept) and locked (another tab).
 *
 * Keyboard and input rules:
 *  - Enter submits; Enter again (after releasing the key) advances, so a
 *    held Enter cannot do both. Enter during IME composition is ignored.
 *  - The input is never recreated or blurred between cards; mobile
 *    "Done"/Enter is intercepted (keydown + beforeinput) so the keyboard
 *    stays up when the browser allows it.
 *  - Single-letter shortcuts are inactive while the input has focus;
 *    Alt/Option shortcuts and visible buttons always work.
 */

import { h, replace, clear } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { button } from './common.js';
import { toast, sheet, confirmDialog, errorToast, menu, callout } from '../components.js';
import { renderInto, answerHtml, livePreviewHtml, ensureMath, markdownToHtml, mediaUrl } from '../render.js';
import { announce } from '../appearance.js';
import { startViewport, keyboardLikelyOpen, viewportState } from '../viewport.js';
import { TrialRecorder } from '../../study/trial.js';
import { MODES } from '../../study/session.js';
import { unitContent, effectiveCardSettings, TASK_TYPE_LABELS } from '../../core/model.js';
import { evaluateAnswer, planReview, planOverride, planUndo, exposureEvent } from '../../core/review.js';
import { classifyModality, promptStats, mergeGradingConfig, baselineKey, REASON_TEXT, MODALITY_LABELS } from '../../core/fluency.js';
import { matchAnswer, answerDiff, DIAGNOSTIC_LABELS, WARNING_LABELS } from '../../core/match/index.js';
import { addAlias } from '../../core/aliases.js';
import { addClozeAlias } from '../../core/cloze.js';
import { requeuePosition, LEARN_AHEAD_MS } from '../../core/queue.js';
import { previewRatings, RATING_LABELS, State } from '../../core/scheduler.js';
import { uuid, formatDuration, formatInterval, pluralize } from '../../core/util.js';
import { plainText } from '../../core/text.js';
import { assignArm } from '../../core/research.js';
import { mediaFetcher } from './editor.js';
import { local } from '../local.js';
import { occlusionView } from '../occlusion.js';

const TOOLBAR_PRESETS = {
  general: ['π', '√', '^', '/', '(', ')', '-', '+', '²', '³', 'θ', 'Δ', '±', '∞'],
  math: ['π', '√', '^', '/', '(', ')', '-', '+', '²', '³', 'θ', 'Δ', '±', '∞', '∫'],
  chem: ['→', '⇌', 'Δ', '⁺', '⁻', '₂', '₃', '₄', '(aq)', '(s)', '(g)', '(l)'],
};

export async function view(outlet, { id }) {
  await app.cache.ensure();
  const session = await store.getSession(id);
  if (!session) {
    outlet.append(h('div', { class: 'view narrow' }, h('div', { class: 'empty' }, h('h2', {}, 'Session not found'), button('Study', { href: '#/study', kind: 'primary' }))));
    return null;
  }
  const s = new StudyScreen(outlet, session);
  await s.init();
  return { destroy: () => s.destroy() };
}

class StudyScreen {
  constructor(outlet, session) {
    this.outlet = outlet;
    this.session = session;
    this.phase = 'loading';
    this.trial = new TrialRecorder();
    this.current = null;
    this.last = null;
    this.undoStack = [];
    this.enterArmed = true;
    this.lastEnterAt = 0;
    this.abort = new AbortController();
    this.unsubs = [];
    this.lastPointerType = null;
    this.autoTimer = null;
    this.timerRaf = 0;
    this.focusStartActive = 0;
    this.revealedInSession = new Set();
    this.gradingConfig = mergeGradingConfig({ ...(store.global.gradingOverrides || {}), hintCeiling: store.global.gradingOverrides?.hintCeiling || 'good' });
    this.destroyed = false;
  }

  /* ============================================================ setup */

  async init() {
    this.buildDom();
    this.outlet.append(this.root);
    startViewport();
    if (!(await this.acquireLock())) return;
    this.bindEvents();
    this.session = { ...this.session, status: 'active', warmupPending: true, resumedAt: Date.now() };
    await store.saveSession(this.session);
    app.leaveGuard = async () => {
      if (this.phase === 'submitting') return false;
      return true;
    };
    this.setupShortcuts();
    await ensureMath();
    await this.next();
  }

  async acquireLock() {
    if (!navigator.locks?.request) return true;
    if (await this.tryLock(false)) return true;
    this.showLocked('Studying in another tab', 'To avoid recording the same review twice, Axon studies in one tab at a time.');
    return false;
  }

  /** Request the study lock; `steal` takes it from another tab. */
  tryLock(steal) {
    return new Promise((resolve) => {
      let held = false;
      navigator.locks.request('axon-study', steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        held = true;
        resolve(true);
        return new Promise((release) => { this.releaseLock = release; });
      }).catch(() => {
        // Rejected after being held: another tab took over studying.
        if (held && !this.destroyed) this.lockLost();
        resolve(false);
      });
    });
  }

  lockLost() {
    this.releaseLock = null;
    this.cancelAutoAdvance();
    this.trial.pause('hidden');
    this.abort.abort();
    this.abort = new AbortController();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    app.shortcuts.enableScope('study', false);
    app.shortcuts.enableScope('study-manual', false);
    app.setBusy('study', null);
    this.showLocked('Studying moved to another tab', 'Your saved progress is kept. Anything not yet submitted here was not recorded.');
  }

  showLocked(title, message) {
    this.phase = 'locked';
    this.root.dataset.phase = 'locked';
    replace(this.stageInner, h('div', { class: 'study-done' }, h('div', { class: 'empty' }, h('div', { class: 'art' }, icon('lock')), h('h2', {}, title), h('p', {}, message), h('div', { class: 'row', style: { justifyContent: 'center' } }, button('Study here instead', { kind: 'primary', onclick: () => this.takeOver() }), button('Go home', { href: '#/' })))));
    this.composer.hidden = true;
  }

  async takeOver() {
    if (!(await this.tryLock(true))) return;
    // Continue from the latest saved state (the other tab may have moved on).
    const latest = await store.getSession(this.session.id);
    if (latest) this.session = latest;
    await app.cache.load();
    this.current = null;
    this.composer.hidden = false;
    replace(this.stageInner, this.metaEl, this.promptEl, this.occlusionEl, this.instructionEl, this.hintEl, this.solutionEl, this.feedbackEl);
    this.bindEvents();
    this.setupShortcuts();
    await ensureMath();
    this.next();
  }

  buildDom() {
    this.progress = h('span', { style: { width: '0%' } });
    this.countEl = h('span', { class: 'count', 'aria-live': 'off' });
    this.timerEl = h('span', { class: 'study-timer', 'aria-hidden': 'true' });
    const exit = h('button', { class: 'btn ghost icon', 'aria-label': 'Pause and leave', title: 'Pause and leave', onclick: () => this.leave() }, icon('x'));
    const more = h('button', { class: 'btn ghost icon', 'aria-label': 'Session menu', onclick: (e) => this.sessionMenu(e.currentTarget) }, icon('more'));
    const top = h('div', { class: 'study-top' }, exit, h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Session progress' }, this.progress), this.countEl, this.timerEl, more);

    this.metaEl = h('div', { class: 'study-meta' });
    this.promptEl = h('div', { class: 'prompt rich', id: 'study-prompt', 'aria-live': 'polite' });
    this.occlusionEl = h('div', { style: { textAlign: 'center' } });
    this.instructionEl = h('div', { class: 'instruction' });
    this.hintEl = h('div', { class: 'hint-box', hidden: true, role: 'note' });
    this.solutionEl = h('div', { class: 'panel rich', hidden: true });
    this.feedbackEl = h('div', { 'aria-live': 'polite' });
    this.stageInner = h('div', { class: 'study-card' }, this.metaEl, this.promptEl, this.occlusionEl, this.instructionEl, this.hintEl, this.solutionEl, this.feedbackEl);
    this.stage = h('div', { class: 'study-stage' }, this.stageInner);

    this.liveEl = h('div', { class: 'live-preview', 'aria-hidden': 'true' });
    this.symbolsEl = h('div', { class: 'symbols', role: 'toolbar', 'aria-label': 'Insert symbol' });
    this.input = h('input', {
      class: 'answer-input',
      type: 'text',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
      'aria-label': 'Your answer',
      'aria-describedby': 'study-prompt',
      placeholder: 'Type your answer',
    });
    this.voiceBtn = h('button', { class: 'btn icon submit-btn', type: 'button', 'aria-label': 'Answer by voice', title: 'Voice input (Alt+M)', hidden: true }, icon('mic'));
    this.submitBtn = h('button', { class: 'btn primary submit-btn', type: 'button', 'aria-label': 'Submit answer' }, icon('check'));
    this.actionsEl = h('div', { class: 'actions' });
    this.composer = h('div', { class: 'composer' }, h('div', { class: 'composer-inner' }, this.liveEl, this.symbolsEl, h('div', { class: 'answer-row' }, this.input, this.voiceBtn, this.submitBtn), this.actionsEl));
    this.root = h('div', { class: 'study', role: 'region', 'aria-label': 'Study session' }, top, this.stage, this.composer);
    // Keep focus in the input when tapping composer controls.
    for (const el of [this.submitBtn, this.voiceBtn]) el.addEventListener('pointerdown', (e) => e.preventDefault());
  }

  bindEvents() {
    const sig = { signal: this.abort.signal };
    this.input.addEventListener('keydown', (e) => this.onKeydown(e), sig);
    this.input.addEventListener('keyup', (e) => { if (e.key === 'Enter') this.enterArmed = true; }, sig);
    this.input.addEventListener('beforeinput', (e) => this.onBeforeInput(e), sig);
    this.input.addEventListener('input', (e) => this.onInput(e), sig);
    this.input.addEventListener('compositionstart', () => this.trial.onComposition('start'), sig);
    this.input.addEventListener('compositionend', () => this.trial.onComposition('end'), sig);
    this.input.addEventListener('blur', () => this.onBlur(), sig);
    this.submitBtn.addEventListener('click', () => this.primaryAction(), sig);
    this.voiceBtn.addEventListener('click', () => this.voice(), sig);
    document.addEventListener('pointerdown', (e) => {
      this.lastPointerType = e.pointerType;
      this.trial.onPointer(e);
      this.cancelAutoAdvance();
      this.userTappedElsewhere = !this.composer.contains(e.target);
    }, { ...sig, capture: true });
    document.addEventListener('keydown', () => this.cancelAutoAdvance(), { ...sig, capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.trial.pause('hidden');
      else this.trial.resume();
    }, sig);
    window.addEventListener('pagehide', () => this.trial.pause('hidden'), sig);
    window.addEventListener('pageshow', () => this.trial.resume(), sig);
    window.visualViewport?.addEventListener('resize', () => { if (viewportState().shrunk) this.trial.setViewportShrunk(true); }, sig);
    this.unsubs.push(app.onChange(() => this.renderProgress()));
  }

  setupShortcuts() {
    const sc = app.shortcuts;
    sc.enableScope('study', true);
    sc.enableScope('study-manual', true);
    const on = (action, fn) => this.unsubs.push(sc.on(action, (e) => { fn(e); return true; }));
    on('study.edit', () => this.edit());
    on('study.hint', () => this.showHint());
    on('study.reveal', () => this.revealAnswer());
    on('study.skip', () => this.skip());
    on('study.undo', () => this.undo());
    on('study.alias', () => this.override('alias'));
    on('study.correct', () => this.override('correct'));
    on('study.knew', () => this.override('knew'));
    on('study.guessed', () => this.override('guessed'));
    on('study.bypass', () => this.bypassRetype());
    on('study.solution', () => this.toggleSolution());
    on('study.speak', () => this.speak());
    on('study.voice', () => this.voice());
    on('study.pause', () => this.pause());
    on('study.why', () => this.feedbackEl.querySelector('details.why')?.toggleAttribute('open'));
    for (const r of [1, 2, 3, 4]) on(`study.grade${r}`, () => this.phase === 'grading' && this.manualGrade(r));
    this.unsubs.push(sc.on('study.focus', () => {
      if (document.activeElement === this.input) {
        this.deliberateBlur = true; // leave the field so single-key shortcuts work
        this.input.blur();
      } else this.focusInput(true);
      return true;
    }));
  }

  destroy() {
    this.destroyed = true;
    this.abort.abort();
    for (const u of this.unsubs) u();
    app.shortcuts.enableScope('study', false);
    app.shortcuts.enableScope('study-manual', false);
    cancelAnimationFrame(this.timerRaf);
    clearTimeout(this.autoTimer);
    this.releaseLock?.();
    app.setBusy('study', null);
    app.leaveGuard = null;
    document.body.classList.remove('studying');
    try {
      speechSynthesis?.cancel();
    } catch {
      /* not supported */
    }
    this.recognition?.abort?.();
    if (this.session.status === 'active' && this.session.index < this.session.queue.length) {
      store.saveSession({ ...this.session, status: 'paused', pausedAt: Date.now() }).catch(() => {});
    }
  }

  /* ========================================================= helpers */

  focusInput(force = false) {
    if (this.destroyed) return;
    if (force || document.activeElement !== this.input) {
      try {
        this.input.focus({ preventScroll: true });
      } catch {
        this.input.focus();
      }
    }
  }

  onBlur() {
    // Some mobile browsers blur on "Done". Restore focus unless the user
    // deliberately tapped elsewhere (never fight the user or assistive tech).
    if (this.destroyed || this.phase === 'done' || this.phase === 'paused' || this.phase === 'locked') return;
    if (this.deliberateBlur) {
      this.deliberateBlur = false;
      return;
    }
    const tappedElsewhere = this.userTappedElsewhere;
    setTimeout(() => {
      if (!tappedElsewhere && !document.querySelector('dialog[open]') && document.activeElement === document.body) this.focusInput();
    }, 0);
  }

  setPhase(p) {
    this.phase = p;
    this.root.dataset.phase = p;
    const busy = { question: 'the current card', submitting: 'saving a review', feedback: 'the current card', grading: 'grading', retype: 'a correction', error: 'an unsaved review' }[p];
    app.setBusy('study', busy || null);
    this.renderActions();
  }

  settingsFor(card) {
    return effectiveCardSettings(card, app.cache.decks.get(card.deckId));
  }

  gradeMode(card) {
    const mode = store.global.gradingMode || 'auto';
    if (mode !== 'research') return { mode, arm: null };
    const study = store.global.research?.study;
    const arm = assignArm(card.id, study);
    return { mode: arm === 'standard' ? 'manual' : 'auto', arm, study };
  }

  renderProgress() {
    const s = this.session;
    const total = s.queue.length;
    const done = Math.min(s.index, total);
    this.progress.style.width = `${total ? (done / total) * 100 : 0}%`;
    this.countEl.textContent = `${Math.min(done + (this.phase === 'done' ? 0 : 1), total)} / ${total}`;
    this.progress.parentElement.setAttribute('aria-valuenow', String(done));
    this.progress.parentElement.setAttribute('aria-valuemax', String(total));
  }

  /* ===================================================== presentation */

  async next() {
    if (this.destroyed) return;
    this.cancelAutoAdvance();
    if (app.pendingUpdate?.autoWhenIdle) {
      // Safe point: previous card fully saved, next not yet shown.
      app.setBusy('study', null);
      return;
    }
    if (this.focusDue()) return;
    const s = this.session;
    while (s.index < s.queue.length) {
      const unitId = s.queue[s.index];
      const unit = app.cache.units.get(unitId);
      const card = unit && app.cache.cards.get(unit.cardId);
      if (unit && card && unit.active && !card.suspended && !unit.suspended) {
        await this.present(unit, card);
        return;
      }
      // Removed, suspended or deleted since the session was built.
      this.session = { ...s, index: s.index + 1, unavailable: [...(s.unavailable || []), unitId] };
      Object.assign(s, this.session);
    }
    await this.finish();
  }

  async present(unit, card) {
    this.setPhase('loading');
    const deck = app.cache.decks.get(card.deckId);
    const content = unitContent(card, unit.key);
    const settings = this.settingsFor(card);
    const now = Date.now();
    const attempts = this.session.attempts?.[unit.id] || 0;
    const sessionLive = this.session.live;
    const isLearning = unit.state && (unit.state.state === State.Learning || unit.state.state === State.Relearning);
    // A requeued attempt is a scheduling review only when the card is due
    // (learning steps within the learn-ahead window); otherwise it is practice.
    const live = sessionLive && (attempts === 0 || (isLearning && unit.state.due <= now + LEARN_AHEAD_MS));
    this.current = {
      unit, card, deck, content, settings, live,
      eventId: uuid(),
      firstAttempt: attempts === 0,
      isWarmup: !!this.session.warmupPending,
      grade: this.gradeMode(card),
      retypeDone: false,
    };
    this.input.value = '';
    this.input.className = 'answer-input';
    this.input.placeholder = content.answerGroups.length > 1 ? `${content.answerGroups.length} answers separated by ;` : 'Type your answer';
    this.input.setAttribute('inputmode', 'text');
    clear(this.feedbackEl);
    this.hintEl.hidden = true;
    this.solutionEl.hidden = true;
    this.liveEl.textContent = '';
    this.stage.scrollTop = 0;

    // Meta chips
    const chips = [];
    chips.push(h('span', { class: 'chip' }, h('span', { class: 'deck-dot', style: { background: deck?.color || '#888' } }), deck?.name || ''));
    if (!this.current.live) chips.push(h('span', { class: 'chip', title: 'Recorded as exposure; your long-term schedule is unchanged' }, this.session.live ? 'Practice retry' : 'Practice'));
    if (!unit.state) chips.push(h('span', { class: 'chip accent' }, 'New'));
    if (card.taskType && card.taskType !== 'recall') chips.push(h('span', { class: 'chip' }, TASK_TYPE_LABELS[card.taskType]));
    if (unit.key === 'rev') chips.push(h('span', { class: 'chip' }, 'Back → Front'));
    if (unit.leech) chips.push(h('button', { class: 'chip danger button', onclick: (e) => this.leechMenu(e.currentTarget) }, icon('flag'), 'Leech'));
    if (this.current.grade.arm) chips.push(h('span', { class: 'chip', title: 'Research comparison arm' }, this.current.grade.arm === 'standard' ? 'Self-graded' : 'Auto-graded'));
    replace(this.metaEl, chips);

    // Prompt
    const long = plainText(content.prompt).length > 140 || /\n/.test(content.prompt);
    this.promptEl.className = `prompt rich${long ? ' long' : ''}`;
    await renderInto(this.promptEl, content.prompt || (content.kind === 'occlusion' ? 'What is hidden here?' : ''), { media: mediaFetcher });
    this.instructionEl.textContent = content.instruction || '';
    clear(this.occlusionEl);
    if (content.occlusion?.imageId) {
      const url = await mediaUrl(content.occlusion.imageId, mediaFetcher);
      if (url) {
        const occ = occlusionView({ imageUrl: url, alt: content.occlusion.alt, masks: content.occlusion.masks, activeMaskId: content.occlusion.activeMaskId, mode: content.occlusion.revealMode, revealedIds: this.revealedInSession });
        this.occlusionEl.append(occ);
        const img = occ.querySelector('img');
        try {
          await img.decode();
        } catch {
          /* ignore */
        }
      } else {
        this.occlusionEl.append(callout('danger', 'This card’s image is missing on this device. Skip it, or sync/restore media.'));
      }
    }
    this.renderSymbols(settings.answerMode);
    this.voiceBtn.hidden = !(store.global.voiceInput && speechRecognitionCtor());
    this.renderProgress();
    // Start timing once the prompt (math, images) is laid out and visible.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (this.destroyed) return;
    this.focusInput();
    const startTrial = () => {
      this.trial.start({ coarsePointer: matchMedia('(pointer: coarse)').matches, finePointer: matchMedia('(any-pointer: fine)').matches, lastPointerType: this.lastPointerType });
      if (keyboardLikelyOpen()) this.trial.setViewportShrunk(true);
      if (document.hidden) this.trial.pause('hidden');
      this.presentedAt = Date.now();
      this.startTimerDisplay();
    };
    this.setPhase('question');
    if (store.global.tts?.enabled && store.global.tts?.autoPrompt) this.speak(content.prompt, startTrial);
    else startTrial();
    this.playAudio('prompt');
    announce(`Card ${Math.min(this.session.index + 1, this.session.queue.length)} of ${this.session.queue.length}. ${plainText(content.prompt).slice(0, 200)}`);
  }

  startTimerDisplay() {
    cancelAnimationFrame(this.timerRaf);
    const showCardTimer = this.session.mode === 'speed' && this.session.config?.timer;
    const focusMin = store.global.focusTimer?.enabled ? store.global.focusTimer.minutes : 0;
    if (!showCardTimer && !focusMin) {
      this.timerEl.textContent = '';
      return;
    }
    const tick = () => {
      if (this.destroyed) return;
      const parts = [];
      if (showCardTimer && (this.phase === 'question')) parts.push(`${(this.trial.elapsed() / 1000).toFixed(1)}s`);
      if (focusMin) {
        const left = Math.max(0, focusMin * 60000 - (this.session.activeMs || 0) - (this.phase === 'question' ? this.trial.elapsed() : 0));
        parts.push(`${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`);
      }
      this.timerEl.textContent = parts.join(' · ');
      this.timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  focusDue() {
    const f = store.global.focusTimer;
    if (!f?.enabled || !f.minutes) return false;
    const done = (this.session.activeMs || 0) >= f.minutes * 60000;
    if (!done || this.session.focusAcknowledgedAt === this.session.index) return false;
    this.showOverlay('Focus session complete', `You studied for ${f.minutes} minutes. Take a ${f.breakMinutes || 5}-minute break — your place is saved.`, [
      { label: 'Keep going', primary: true, run: async () => { this.session = { ...this.session, focusAcknowledgedAt: this.session.index, activeMs: 0 }; await store.saveSession(this.session); this.next(); } },
      { label: 'End session', run: () => this.endSession() },
    ]);
    return true;
  }

  renderSymbols(mode) {
    const pref = store.global.toolbarPreset || 'auto';
    const preset = this.toolbarOverride || (pref === 'auto' ? (mode === 'chem' ? 'chem' : mode === 'math' ? 'math' : 'general') : pref);
    const symbols = preset === 'custom' ? store.global.toolbarCustom || TOOLBAR_PRESETS.general : TOOLBAR_PRESETS[preset] || TOOLBAR_PRESETS.general;
    replace(this.symbolsEl, symbols.map((sym) => {
      const b = h('button', { type: 'button', 'aria-label': `Insert ${sym}` }, sym);
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.insertSymbol(sym));
      return b;
    }), h('button', { type: 'button', 'aria-label': 'Switch symbol set', title: 'Switch symbol set', onclick: () => {
      const order = ['general', 'math', 'chem', 'custom'];
      this.toolbarOverride = order[(order.indexOf(preset) + 1) % order.length];
      this.renderSymbols(mode);
    }, onpointerdown: (e) => e.preventDefault() }, '⋯'));
  }

  insertSymbol(sym) {
    if (!['question', 'retype'].includes(this.phase)) return;
    const el = this.input;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(sym, start, end, 'end');
    this.focusInput();
    this.trial.onInput({ inputType: 'insertText' }, { origin: 'toolbar', value: el.value });
    this.updateLivePreview();
  }

  /* ============================================================ input */

  onKeydown(e) {
    this.trial.onKeydown(e);
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return; // IME is composing: never submit
    e.preventDefault();
    if (e.repeat) return; // held Enter never submits and advances
    this.lastEnterAt = performance.now();
    this.primaryAction({ fromEnter: true });
  }

  onBeforeInput(e) {
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      // Mobile keyboards that send line breaks instead of Enter keydown.
      e.preventDefault();
      if (performance.now() - this.lastEnterAt > 80) {
        this.lastEnterAt = performance.now();
        this.primaryAction({ fromEnter: true, synthetic: true });
      }
      return;
    }
    if (['submitting', 'feedback', 'grading', 'loading'].includes(this.phase) && e.inputType.startsWith('insert')) e.preventDefault();
  }

  onInput(e) {
    if (this.phase === 'question') {
      this.trial.onInput(e, { value: this.input.value });
      this.updateLivePreview();
    } else if (this.phase === 'retype') {
      this.updateLivePreview();
    }
  }

  updateLivePreview() {
    const mode = this.current?.settings.answerMode;
    if (mode !== 'math' && mode !== 'chem') {
      this.liveEl.textContent = '';
      return;
    }
    const { html, error } = livePreviewHtml(this.input.value, mode);
    if (error) replace(this.liveEl, h('span', { class: 'err' }, error));
    else this.liveEl.innerHTML = html;
  }

  primaryAction({ fromEnter = false, synthetic = false } = {}) {
    if (this.phase === 'question') {
      if (!this.input.value.trim()) {
        announce('Type an answer first, or use Reveal.', { assertive: true });
        this.input.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 180 });
        return;
      }
      this.enterArmed = !fromEnter || synthetic;
      this.submit();
    } else if (this.phase === 'feedback') {
      if (fromEnter && !this.enterArmed) return;
      this.advance();
    } else if (this.phase === 'retype') {
      this.checkRetype();
    } else if (this.phase === 'error') {
      this.retrySave();
    }
  }

  /* =========================================================== submit */

  async submit({ revealed = false } = {}) {
    const cur = this.current;
    if (!cur || this.phase !== 'question') return;
    this.setPhase('submitting');
    const text = this.input.value;
    const raw = this.trial.finish(text);
    const modality = classifyModality(this.trial.signals, store.device.modalityOverride);
    const match = revealed ? { ...matchAnswer('', ['x']), correct: false, diagnostics: ['revealed'], method: 'revealed' } : evaluateAnswer(cur.card, cur.deck, cur.unit.key, text, { vocabulary: app.cache.vocabulary(cur.card.deckId) });
    const assistance = { ...this.trial.assistance, revealed: revealed || this.trial.assistance.revealed };
    const trial = {
      raw: { ...raw, activeMs: raw.totalMs },
      responseText: text,
      modality,
      prompt: promptStats(cur.content.prompt + (cur.content.occlusion ? ' ![](x)' : '')),
      assistance,
      isWarmup: cur.isWarmup,
      editorOpened: this.trial.editorOpened,
      clockAnomaly: !!raw.clockAnomaly,
      taskType: cur.card.taskType || cur.settings.taskType,
    };
    cur.trial = trial;
    cur.match = match;
    cur.raw = raw;
    if (cur.grade.mode === 'manual') {
      this.renderFeedback({ pending: true });
      this.setPhase('grading');
      return;
    }
    await this.commit();
  }

  async manualGrade(rating) {
    if (this.phase !== 'grading') return;
    this.setPhase('submitting');
    await this.commit(rating);
  }

  async commit(manualRating = null) {
    const cur = this.current;
    const key = baselineKey(cur.trial.modality.kind, cur.trial.taskType);
    const baseline = await store.getBaseline(key);
    const params = store.paramsFor(cur.deck);
    const research = cur.grade.arm ? { studyId: cur.grade.study?.id, arm: cur.grade.arm } : null;
    let plan;
    try {
      plan = planReview({
        eventId: cur.eventId,
        now: Date.now(),
        deviceId: store.deviceId,
        seq: null,
        sessionId: this.session.id,
        mode: this.session.mode,
        live: cur.live,
        unit: cur.unit,
        card: cur.card,
        deck: cur.deck,
        trial: cur.trial,
        match: cur.match,
        gradeMode: manualRating ? 'manual' : 'auto',
        manualRating,
        gradingConfig: this.gradingConfig,
        baseline,
        params,
        studyDay: store.today(),
        timeZone: store.timeOptions().timeZone,
        research,
        firstAttempt: cur.firstAttempt,
      });
    } catch (err) {
      errorToast(err);
      this.setPhase('question');
      return;
    }
    const before = structuredClone(this.session);
    const nextSession = this.sessionAfter(plan);
    cur.plan = plan;
    cur.sessionBefore = before;
    cur.sessionAfter = nextSession;
    await this.persist();
  }

  /** Session state after this answer (queue position, requeue). */
  sessionAfter(plan) {
    const s = this.session;
    const cur = this.current;
    const queue = s.queue.slice();
    let requeuedAt = null;
    const attempts = { ...(s.attempts || {}), [cur.unit.id]: (s.attempts?.[cur.unit.id] || 0) + 1 };
    if (plan.requeue && (attempts[cur.unit.id] || 0) < 4) {
      requeuedAt = requeuePosition(queue.length, s.index, { seed: cur.eventId });
      queue.splice(requeuedAt, 0, cur.unit.id);
    } else if (plan.event.type === 'review' && plan.unit.state && (plan.unit.state.state === State.Learning || plan.unit.state.state === State.Relearning)) {
      // Learning steps: bring the card back roughly when it falls due.
      const wait = plan.unit.state.due - Date.now();
      if (wait <= LEARN_AHEAD_MS && !queue.slice(s.index + 1).includes(cur.unit.id)) {
        const offset = Math.max(3, Math.round(wait / 12000));
        requeuedAt = Math.min(queue.length, s.index + 1 + offset);
        queue.splice(requeuedAt, 0, cur.unit.id);
      }
    }
    return {
      ...s,
      queue,
      index: s.index + 1,
      attempts,
      warmupPending: false,
      activeMs: (s.activeMs || 0) + (plan.event.activeMs || 0),
      results: [...(s.results || []), { unitId: cur.unit.id, eventId: plan.event.id, type: plan.event.type, correct: plan.event.response.correct, firstAttempt: cur.firstAttempt, rating: plan.event.rating, requeuedAt, activeMs: plan.event.activeMs }],
    };
  }

  async persist() {
    const cur = this.current;
    try {
      const res = await store.commitReview(cur.plan, { session: cur.sessionAfter });
      local.remove('axon-pending-review');
      this.session = cur.sessionAfter;
      this.undoStack.push({ eventId: cur.plan.event.id, sessionBefore: cur.sessionBefore, unitId: cur.unit.id, calibrationKey: cur.plan.calibration?.key || null });
      if (this.undoStack.length > 20) this.undoStack.shift();
      // Update cache immediately so the next card and counts are right.
      const unit = { ...app.cache.units.get(cur.unit.id), ...cur.plan.unit };
      app.cache.units.set(unit.id, unit);
      cur.unit = unit;
      cur.event = res.event || cur.plan.event;
      this.last = cur;
      this.afterSaved();
    } catch (err) {
      console.error(err);
      if (err.code === 'stale') {
        this.setPhase('error');
        replace(this.feedbackEl, callout('warning', `${err.message} Reload the session to continue with the latest data.`), h('div', { class: 'row' }, button('Reload session', { kind: 'primary', onclick: async () => { await app.cache.load(); this.current = null; this.next(); } })));
        return;
      }
      local.setJSON('axon-pending-review', { plan: cur.plan, session: cur.sessionAfter, savedAt: Date.now() });
      this.setPhase('error');
      replace(this.feedbackEl, callout('danger', `This review could not be saved: ${err.message}. Your answer is kept — nothing was recorded twice.`), h('div', { class: 'row' }, button('Retry', { kind: 'primary', onclick: () => this.retrySave() })));
      announce('The review could not be saved. Retry when ready.', { assertive: true });
    }
  }

  /** After answering, show the hidden label on the image itself. */
  revealOcclusion() {
    const occ = this.current?.content?.occlusion;
    const el = this.occlusionEl.querySelector('.mask[data-active]');
    if (!occ || !el) return;
    const mask = occ.masks.find((m) => m.id === occ.activeMaskId);
    el.classList.add('revealed');
    el.firstChild.textContent = mask?.label[0] || '';
  }

  retrySave() {
    if (this.phase !== 'error' || !this.current?.plan) return;
    this.setPhase('submitting');
    this.persist();
  }

  afterSaved() {
    const cur = this.current;
    const correct = cur.match.correct;
    if (cur.content.kind === 'occlusion') this.revealedInSession.add(cur.content.occlusion.activeMaskId);
    this.recordSiblingExposure();
    this.renderFeedback({});
    this.revealOcclusion();
    const needsRetype = !correct && store.global.requireRetype !== false;
    if (needsRetype) {
      this.setPhase('retype');
      this.input.value = '';
      this.input.className = 'answer-input incorrect retype';
      this.input.placeholder = 'Retype the correct answer to continue';
      this.retypeStarted = performance.now();
    } else {
      this.setPhase('feedback');
      this.input.className = `answer-input ${correct ? 'correct' : 'incorrect'}`;
      this.scheduleAutoAdvance();
    }
    this.focusInput();
    this.playAudio('answer');
    if (store.global.tts?.enabled && store.global.tts?.autoAnswer) this.speak(cur.content.answerDisplay);
    app.sync.schedule();
  }

  recordSiblingExposure() {
    const cur = this.current;
    const ids = new Set(app.cache.unitsOfCard(cur.card.id).filter((u) => u.id !== cur.unit.id).map((u) => u.id));
    if (store.global.relatedSpacing !== false) {
      for (const l of app.cache.links) {
        const other = l.a === cur.card.id ? l.b : l.b === cur.card.id ? l.a : null;
        if (other) for (const u of app.cache.unitsOfCard(other)) ids.add(u.id);
      }
    }
    if (!ids.size) return;
    const now = Date.now();
    const ev = exposureEvent({ id: uuid(), type: 'sibling-exposure', now, deviceId: store.deviceId, seq: null, unit: cur.unit, card: cur.card, sessionId: this.session.id, studyDay: store.today(now), data: { siblingUnitIds: [...ids], sourceEventId: cur.plan.event.id } });
    store.addEvents([ev], { unitPatches: [...ids].map((unitId) => ({ unitId, patch: { siblingExposedAt: now } })) }).catch(() => {});
    for (const id of ids) {
      const u = app.cache.units.get(id);
      if (u) app.cache.units.set(id, { ...u, siblingExposedAt: now });
    }
  }

  /* ========================================================= feedback */

  renderFeedback({ pending = false }) {
    const cur = this.current;
    const m = cur.match;
    const ev = cur.event || cur.plan?.event;
    const correct = m.correct;
    const overridden = cur.override;
    const mode = cur.settings.answerMode;
    const parts = [];
    const verdict = overridden ? 'Marked correct' : correct ? (m.typoTolerated ? 'Correct — typo accepted' : 'Correct') : cur.trial?.assistance?.revealed ? 'Answer revealed' : 'Not quite';
    const gradeName = ev ? RATING_LABELS[cur.effectiveRating || ev.rating] : null;
    parts.push(h('div', { class: 'verdict' }, icon(correct || overridden ? 'check' : 'x'), h('span', {}, verdict),
      gradeName && !pending ? h('span', { class: 'chip grade', title: ev.type === 'practice' ? 'Practice — your long-term schedule is unchanged' : 'FSRS rating applied' }, `${gradeName}${ev.type === 'practice' ? ' · practice' : ''}`) : null));

    // Correct answer
    const answerEl = h('div', { class: 'answer rich' });
    if (cur.content.kind === 'cloze') answerEl.innerHTML = markdownToHtml(cur.content.reveal, {});
    else answerEl.innerHTML = answerHtml(cur.content.answerDisplay, mode);
    parts.push(answerEl);
    const alts = cur.content.answerGroups.flat();
    if (alts.length > 1 && cur.content.answerGroups.length === 1) {
      const altEl = h('div', { class: 'faint small' }, 'Also accepted: ');
      alts.slice(1).forEach((a, i) => {
        const span = h('span', {});
        span.innerHTML = answerHtml(a, mode);
        altEl.append(i ? ', ' : '', span);
      });
      parts.push(altEl);
    }
    if (cur.content.kind === 'cloze' && cur.content.extra) {
      const extra = h('div', { class: 'rich small muted' });
      extra.innerHTML = markdownToHtml(cur.content.extra);
      parts.push(extra);
    }
    if (!correct && !overridden && cur.trial?.responseText && !cur.trial.assistance.revealed) {
      const expected = cur.content.answerGroups.length > 1 ? cur.content.answerGroups.map((g) => g[0]).join('; ') : cur.content.answerGroups[0][m.closestIndex ?? 0] || cur.content.answerDisplay;
      const diff = answerDiff(cur.trial.responseText, expected);
      parts.push(h('div', { class: 'stack', style: { gap: '4px' } }, h('div', { class: 'faint tiny' }, 'Your answer'), h('div', { class: 'diff', 'aria-label': `You typed ${cur.trial.responseText}` }, diff.map((seg) => h('span', { class: seg.type === 'same' ? '' : seg.type }, seg.text)))));
    }
    const diags = (m.diagnostics || []).filter((d) => DIAGNOSTIC_LABELS[d] && d !== 'empty');
    if (diags.length) parts.push(h('div', { class: 'row tight' }, diags.map((d) => h('span', { class: 'chip warning' }, icon('alert'), DIAGNOSTIC_LABELS[d]))));
    const warns = (m.warnings || []).filter((w) => WARNING_LABELS[w]);
    if (warns.length) parts.push(h('div', { class: 'row tight' }, warns.map((w) => h('span', { class: 'chip warning' }, WARNING_LABELS[w]))));
    if (m.probabilistic) parts.push(h('div', { class: 'faint tiny' }, 'Accepted as algebraically equivalent after checking at several random points (probabilistic, not a proof).'));

    // Timing
    const raw = cur.raw;
    if (raw) {
      parts.push(h('div', { class: 'timing', 'aria-label': 'Timing' },
        h('span', {}, 'First key ', h('b', {}, raw.latencyMs != null ? formatDuration(raw.latencyMs) : '—')),
        h('span', {}, 'Typing ', h('b', {}, raw.typingMs != null ? formatDuration(raw.typingMs) : '—')),
        h('span', {}, 'Total ', h('b', {}, formatDuration(raw.totalMs))),
        raw.corrections ? h('span', {}, 'Corrections ', h('b', {}, String(raw.corrections))) : null,
        ev?.type === 'review' && cur.unit.state ? h('span', {}, 'Next ', h('b', {}, formatInterval(Math.max(0, (cur.unit.state.due - Date.now()) / 86400000)))) : null));
    }

    // Why this grade?
    if (ev?.grading && store.global.showWhy !== false && !pending) {
      const g = ev.grading;
      const conf = `${g.confidenceLabel} heuristic confidence (${Math.round(g.confidence * 100)}%, not a calibrated probability)`;
      parts.push(h('details', { class: 'why' }, h('summary', {}, 'Why this grade?'), h('div', { class: 'stack', style: { gap: '4px', marginTop: '6px' } },
        h('p', {}, ev.grading.mode === 'manual' ? `You graded this ${RATING_LABELS[ev.rating]}. Axon’s automatic grade would have been ${RATING_LABELS[g.grade]}.` : g.explanation),
        cur.overrideReasons ? h('p', {}, cur.overrideReasons.map((r) => REASON_TEXT[r]).join(' ')) : null,
        h('p', { class: 'faint tiny' }, `${conf} · ${MODALITY_LABELS[ev.modality?.kind || 'unknown']}${ev.modality?.source === 'override' ? ' (your setting)' : ''} · calibration ${g.calibration.level} (${g.calibration.n} samples) · ${g.ruleVersion}`),
        g.measurements.excluded?.length ? h('p', { class: 'faint tiny' }, `Excluded from timing: ${[...new Set(g.measurements.excluded.map((x) => x.reason))].join(', ')}`) : null)));
    }

    // Confidence self-rating (optional, skippable)
    if (store.global.confidencePrompt !== false && ev && !pending) {
      const wrap = h('div', { class: 'confidence', role: 'group', 'aria-label': 'How confident were you? Optional' }, h('span', {}, 'Confidence (optional):'));
      for (let v = 1; v <= 5; v++) {
        const b = h('button', { type: 'button', 'aria-pressed': 'false', 'aria-label': `Confidence ${v} of 5`, onpointerdown: (e) => e.preventDefault(), onclick: () => {
          wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
          b.setAttribute('aria-pressed', 'true');
          store.addEvents([exposureEvent({ id: uuid(), type: 'self-rating', now: Date.now(), deviceId: store.deviceId, seq: null, unit: cur.unit, card: cur.card, sessionId: this.session.id, studyDay: store.today(), data: { targetId: ev.id, value: v } })]).catch(() => {});
        } }, String(v));
        wrap.append(b);
      }
      parts.push(wrap);
    }

    // Manual grading buttons
    if (pending) {
      const preview = previewRatings(cur.unit.state, Date.now(), store.paramsFor(cur.deck));
      parts.push(h('div', { class: 'stack', style: { gap: '6px' } }, h('div', { class: 'faint small' }, 'How well did you know it?'), h('div', { class: 'row tight' }, [1, 2, 3, 4].map((r) => h('button', { class: ['btn', r === 3 && 'primary'], type: 'button', onpointerdown: (e) => e.preventDefault(), onclick: () => this.manualGrade(r) }, `${RATING_LABELS[r]} · ${formatInterval(preview[r].days)}`, h('kbd', {}, `⌥${r}`))))));
    }

    // Worked solution
    if (cur.card.explanation) {
      const sol = h('details', { class: 'disclosure', open: !correct && !overridden }, h('summary', {}, 'Explanation / worked solution'));
      const body = h('div', { class: 'body rich' });
      renderInto(body, cur.card.explanation, { media: mediaFetcher });
      sol.append(body);
      parts.push(sol);
    }
    if (this.phase === 'retype' || (!correct && !overridden && store.global.requireRetype !== false && !pending)) {
      parts.push(h('div', { class: 'faint small' }, 'Type the correct answer once to reinforce it (this is not counted as recall).'));
    }
    replace(this.feedbackEl, h('section', { class: ['feedback', correct || overridden ? 'correct' : 'incorrect'], 'aria-label': 'Feedback' }, parts));
    announce(`${verdict}. ${correct ? '' : `The answer is ${plainText(cur.content.answerDisplay)}.`} ${gradeName && !pending ? `Graded ${gradeName}.` : ''}`, { assertive: !correct });
    requestAnimationFrame(() => this.feedbackEl.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  }

  renderActions() {
    const cur = this.current;
    const p = this.phase;
    const left = [];
    const right = [];
    const act = (label, iconName, fn, kbd, opts = {}) => {
      const b = h('button', { class: ['btn small', opts.kind || 'ghost'], type: 'button', title: kbd ? `${label} (${kbd})` : label, onclick: fn, disabled: !!opts.disabled }, iconName ? icon(iconName) : null, label);
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      return b;
    };
    if (p === 'question' && cur) {
      if (cur.card.hint) left.push(act('Hint', 'hint', () => this.showHint(), '⌥H'));
      left.push(act('Reveal', 'eye', () => this.revealAnswer(), '⌥R'));
      if (cur.card.explanation) left.push(act('Solution', 'book', () => this.toggleSolution(), '⌥W'));
      right.push(act('Skip', 'skip', () => this.skip(), '⌥S'));
      right.push(act('Edit', 'edit', () => this.edit(), '⌥E'));
      if (store.global.tts?.enabled) right.push(act('Read', 'volume', () => this.speak(), '⌥T'));
      if (this.undoStack.length) right.push(act('Undo', 'undo', () => this.undo(), '⌥Z'));
    }
    if ((p === 'feedback' || p === 'retype') && cur) {
      const correct = cur.match?.correct || cur.override;
      if (!correct) {
        if (cur.trial?.responseText && !cur.trial.assistance.revealed) left.push(act('Correct & save alias', 'check', () => this.override('alias'), '⌥A', { kind: '' }));
        left.push(act('Mark correct', null, () => this.override('correct'), '⌥C'));
        if (p === 'retype') left.push(act('Skip retyping', 'skip', () => this.bypassRetype(), '⌥B'));
      } else if (!cur.override && cur.event?.type) {
        const g = cur.effectiveRating || cur.event.rating;
        if (g < 4) left.push(act('I knew that', 'zap', () => this.override('knew'), '⌥K'));
        if (g > 1) left.push(act('I guessed', null, () => this.override('guessed'), '⌥G'));
      }
      right.push(act('Undo', 'undo', () => this.undo(), '⌥Z'));
      right.push(act('Edit', 'edit', () => this.edit(), '⌥E'));
      if (store.global.tts?.enabled) right.push(act('Read', 'volume', () => this.speak(cur.content.answerDisplay), '⌥T'));
      if (p === 'feedback') right.push(h('button', { class: 'btn small primary', type: 'button', onpointerdown: (e) => e.preventDefault(), onclick: () => this.advance() }, 'Continue', h('kbd', {}, '↵')));
    }
    replace(this.actionsEl, h('div', { class: 'left' }, left), h('div', { class: 'right' }, right));
    this.submitBtn.hidden = !['question', 'retype', 'feedback', 'error'].includes(p);
    this.submitBtn.setAttribute('aria-label', p === 'feedback' ? 'Next card' : p === 'retype' ? 'Check retyped answer' : 'Submit answer');
    replace(this.submitBtn, icon(p === 'feedback' ? 'chevronRight' : 'check'));
  }

  scheduleAutoAdvance() {
    const cur = this.current;
    const ms = cur.deck?.settings?.autoAdvance ?? store.global.autoAdvanceMs ?? 0;
    if (!ms || !cur.match.correct || cur.match.typoTolerated) return;
    this.autoTimer = setTimeout(() => {
      if (this.phase === 'feedback') this.advance();
    }, ms);
  }

  cancelAutoAdvance() {
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  async advance() {
    if (this.phase !== 'feedback') return;
    this.cancelAutoAdvance();
    this.setPhase('loading');
    await this.next();
  }

  /* ========================================================== retype */

  checkRetype() {
    const cur = this.current;
    const text = this.input.value;
    if (!text.trim()) return;
    const s = cur.settings;
    const opts = { mode: s.answerMode, caseSensitive: s.caseSensitive, typoTolerance: 'off', accentPolicy: s.accentPolicy, mathEquivalence: s.mathEquivalence, numericTolerance: s.numericTolerance };
    const ok = cur.content.answerGroups.length > 1
      ? text.split(';').length === cur.content.answerGroups.length && text.split(';').every((p, i) => matchAnswer(p.trim(), cur.content.answerGroups[i], opts).correct)
      : matchAnswer(text, cur.content.answerGroups[0], opts).correct;
    if (!ok) {
      this.input.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 180 });
      announce('That does not match the correct answer yet.', { assertive: true });
      return;
    }
    this.recordCopy(false, text);
    this.enterArmed = false;
    this.setPhase('feedback');
    this.advance();
  }

  bypassRetype() {
    if (this.phase !== 'retype') return;
    this.recordCopy(true, '');
    this.setPhase('feedback');
    this.input.className = 'answer-input incorrect';
    this.input.placeholder = 'Press Enter to continue';
    this.input.value = '';
  }

  recordCopy(bypassed, text) {
    const cur = this.current;
    const ev = exposureEvent({ id: uuid(), type: 'copy', now: Date.now(), deviceId: store.deviceId, seq: null, unit: cur.unit, card: cur.card, sessionId: this.session.id, studyDay: store.today(), data: { targetId: cur.event?.id, bypassed, durationMs: Math.round(performance.now() - (this.retypeStarted || performance.now())), text } });
    store.addEvents([ev]).catch(() => {});
  }

  /* ======================================================= overrides */

  async override(kind) {
    const cur = this.current;
    if (!cur?.event || !['feedback', 'retype'].includes(this.phase)) return;
    const correct = cur.match.correct || cur.override;
    if ((kind === 'alias' || kind === 'correct') && correct) return;
    if ((kind === 'knew' || kind === 'guessed') && !correct) return;
    if (kind === 'alias' && (!cur.trial.responseText.trim() || cur.trial.assistance.revealed)) return;
    try {
      const target = cur.event;
      const unitEvents = await store.eventsForUnit(cur.unit.id);
      const unit = app.cache.units.get(cur.unit.id);
      let cardUpdate = null;
      let alias = null;
      if (kind === 'alias') {
        alias = cur.trial.responseText.trim();
        cardUpdate = this.cardWithAlias(app.cache.cards.get(cur.card.id), cur, alias);
      }
      const plan = planOverride({ eventId: uuid(), now: Date.now(), deviceId: store.deviceId, seq: null, target, kind, unit, unitEvents, alias, studyDay: store.today(), gradingConfig: this.gradingConfig });
      // Remove the failure requeue; the rescued answer counts once.
      let session = this.session;
      if (kind === 'alias' || kind === 'correct') {
        const res = session.results[session.results.length - 1];
        if (res?.eventId === target.id && res.requeuedAt != null && session.queue[res.requeuedAt] === cur.unit.id) {
          const queue = session.queue.slice();
          queue.splice(res.requeuedAt, 1);
          session = { ...session, queue, results: [...session.results.slice(0, -1), { ...res, requeuedAt: null, correct: true, overridden: kind }] };
        }
      }
      await store.commitCorrection(plan, { session, expectedHead: unit.headEventId, card: cardUpdate });
      this.session = session;
      app.cache.units.set(unit.id, { ...unit, ...plan.unit });
      if (cardUpdate) await app.cache.load();
      cur.unit = app.cache.units.get(unit.id);
      cur.effectiveRating = plan.event.newRating;
      cur.overrideReasons = plan.event.reasons;
      if (kind === 'alias' || kind === 'correct') cur.override = kind;
      this.renderFeedback({});
      this.setPhase('feedback');
      this.input.className = 'answer-input correct';
      this.input.placeholder = 'Press Enter to continue';
      this.input.value = '';
      this.enterArmed = true;
      toast(kind === 'alias' ? `Saved “${alias}” as an accepted answer` : kind === 'knew' ? 'Recorded as known (your override)' : kind === 'guessed' ? 'Recorded as a guess' : 'Marked correct', { timeout: 2500 });
      this.focusInput();
    } catch (err) {
      errorToast(err);
    }
  }

  cardWithAlias(card, cur, alias) {
    const next = structuredClone(card);
    const side = cur.content.answerSide;
    if (side === 'back') next.back = addAlias(next.back, alias);
    else if (side === 'front') next.front = addAlias(next.front, alias);
    else if (side === 'cloze') {
      const parts = cur.content.answerGroups.length > 1 ? alias.split(';').map((s) => s.trim()) : [alias];
      let text = next.front[0];
      const results = cur.match.parts || [cur.match];
      parts.forEach((p, i) => {
        if (p && !(results[i]?.correct)) text = addClozeAlias(text, cur.unit.key, i, p);
      });
      next.front = [text];
    } else if (side === 'mask' && next.occlusion) {
      const maskId = cur.unit.key.slice(2);
      next.occlusion = { ...next.occlusion, masks: next.occlusion.masks.map((m) => (m.id === maskId ? { ...m, label: addAlias(m.label, alias) } : m)) };
    }
    return next;
  }

  /* ============================================================ undo */

  async undo() {
    if (!['question', 'feedback', 'retype'].includes(this.phase)) return;
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return toast('Nothing to undo in this session');
    try {
      const events = await store.eventsForUnit(entry.unitId);
      const target = events.find((e) => e.id === entry.eventId);
      if (!target) throw new Error('That review is no longer available');
      const unit = app.cache.units.get(entry.unitId) || (await store.get('units', entry.unitId));
      const plan = planUndo({ eventId: uuid(), now: Date.now(), deviceId: store.deviceId, seq: null, target, unit, unitEvents: events, studyDay: store.today() });
      const restored = { ...entry.sessionBefore, status: 'active', warmupPending: false };
      await store.commitCorrection(plan, { session: restored, expectedHead: unit.headEventId, removeCalibration: entry.calibrationKey ? { key: entry.calibrationKey, eventId: entry.eventId } : null });
      this.undoStack.pop();
      app.cache.units.set(unit.id, { ...unit, ...plan.unit });
      this.session = restored;
      toast('Review undone — schedule restored', { timeout: 2500 });
      this.current = null;
      await this.next();
    } catch (err) {
      errorToast(err);
    }
  }

  /* ===================================================== assistance */

  showHint() {
    const cur = this.current;
    if (this.phase !== 'question' || !cur?.card.hint || !this.hintEl.hidden) return;
    this.trial.assistance.hintShown = true;
    this.hintEl.hidden = false;
    renderInto(this.hintEl, cur.card.hint, { media: mediaFetcher });
    store.addEvents([exposureEvent({ id: uuid(), type: 'hint', now: Date.now(), deviceId: store.deviceId, seq: null, unit: cur.unit, card: cur.card, sessionId: this.session.id, studyDay: store.today(), data: { presentationId: cur.eventId } })]).catch(() => {});
    announce('Hint shown. A hint caps the grade for this card.');
    this.focusInput();
  }

  revealAnswer() {
    const cur = this.current;
    if (this.phase !== 'question' || !cur) return;
    this.trial.assistance.revealed = true;
    store.addEvents([exposureEvent({ id: uuid(), type: 'reveal', now: Date.now(), deviceId: store.deviceId, seq: null, unit: cur.unit, card: cur.card, sessionId: this.session.id, studyDay: store.today(), data: { presentationId: cur.eventId } })]).catch(() => {});
    this.submit({ revealed: true });
  }

  toggleSolution() {
    const cur = this.current;
    if (!cur?.card.explanation) return;
    if (this.phase === 'question') {
      if (!this.solutionEl.hidden) return;
      this.trial.assistance.solutionViewed = true;
      this.solutionEl.hidden = false;
      renderInto(this.solutionEl, cur.card.explanation, { media: mediaFetcher });
      store.addEvents([exposureEvent({ id: uuid(), type: 'reveal', now: Date.now(), deviceId: store.deviceId, seq: null, unit: cur.unit, card: cur.card, sessionId: this.session.id, studyDay: store.today(), data: { presentationId: cur.eventId, what: 'worked-solution' } })]).catch(() => {});
      announce('Worked solution shown. This counts as revealing the answer.');
    } else {
      const d = this.feedbackEl.querySelector('details.disclosure');
      if (d) d.open = !d.open;
    }
  }

  async skip() {
    const cur = this.current;
    if (this.phase !== 'question' || !cur) return;
    const s = this.session;
    const queue = s.queue.slice();
    const alreadySkipped = (s.skipped || []).includes(cur.unit.id);
    if (!alreadySkipped) queue.push(cur.unit.id);
    const session = { ...s, queue, index: s.index + 1, skipped: [...(s.skipped || []), cur.unit.id], warmupPending: false };
    const ev = exposureEvent({ id: uuid(), type: 'skip', now: Date.now(), deviceId: store.deviceId, seq: null, unit: cur.unit, card: cur.card, sessionId: s.id, studyDay: store.today(), data: { presentationId: cur.eventId, requeued: !alreadySkipped, elapsedMs: Math.round(this.trial.elapsed()) } });
    try {
      await store.addEvents([ev], { session });
      this.session = session;
      toast(alreadySkipped ? 'Skipped (not counted as reviewed)' : 'Skipped — it will come back at the end. Not counted as reviewed.', { timeout: 2200 });
      await this.next();
    } catch (err) {
      errorToast(err);
    }
  }

  /* ============================================================ edit */

  async edit() {
    const cur = this.current;
    if (!cur || !['question', 'feedback', 'retype'].includes(this.phase)) return;
    this.trial.pause('editor');
    store.addEvents([exposureEvent({ id: uuid(), type: 'edit', now: Date.now(), deviceId: store.deviceId, seq: null, unit: cur.unit, card: cur.card, sessionId: this.session.id, studyDay: store.today(), data: { presentationId: cur.eventId, phase: this.phase } })]).catch(() => {});
    const { editorView } = await import('./editor.js');
    let done;
    const s = sheet({ title: 'Edit card', wide: true, content: () => h('div') });
    const host = s.body;
    host.replaceChildren();
    const finished = new Promise((r) => { done = r; });
    await editorView(host, structuredClone(app.cache.cards.get(cur.card.id)), { isNew: false, embedded: true, onDone: (saved) => { s.close(saved); done(saved); } });
    s.done.then(() => done(null));
    const saved = await finished;
    this.trial.resume();
    if (saved) {
      await app.cache.load();
      const card = app.cache.cards.get(cur.card.id);
      cur.card = card;
      cur.content = unitContent(card, cur.unit.key);
      cur.settings = this.settingsFor(card);
      await renderInto(this.promptEl, cur.content.prompt, { media: mediaFetcher });
      if (this.phase !== 'question') this.renderFeedback({});
      toast('Card updated', { timeout: 2000 });
    }
    this.focusInput();
  }

  leechMenu(anchor) {
    const cur = this.current;
    menu(anchor, [
      { label: 'Edit the prompt', icon: 'edit', run: () => this.edit() },
      { label: 'Add a hint', icon: 'hint', run: () => this.edit() },
      { label: 'Suspend this card', icon: 'pause', run: async () => {
        await store.saveCard({ ...app.cache.cards.get(cur.card.id), suspended: true });
        await app.cache.load();
        toast('Suspended');
        if (this.phase === 'question') this.skip();
      } },
      { label: 'Create a related practice card', icon: 'link', run: () => window.open(`#/card/new?deck=${cur.card.deckId}&relatedTo=${cur.card.id}`, '_blank') },
    ]);
  }

  /* ===================================================== tts & voice */

  speak(text = this.current?.content.prompt, onEnd = null) {
    const synth = globalThis.speechSynthesis;
    if (!synth || !text) {
      onEnd?.();
      return;
    }
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(plainText(text).slice(0, 600));
      const cfg = store.global.tts || {};
      u.rate = cfg.rate || 1;
      const voice = synth.getVoices().find((v) => v.voiceURI === cfg.voice);
      if (voice) u.voice = voice;
      let ended = false;
      const finish = () => {
        if (!ended) {
          ended = true;
          onEnd?.();
        }
      };
      u.onend = finish;
      u.onerror = finish;
      synth.speak(u);
      if (onEnd) setTimeout(finish, 15000);
    } catch {
      onEnd?.();
    }
  }

  async playAudio(slot) {
    const id = this.current?.card.audio?.[slot];
    if (!id) return;
    const url = await mediaUrl(id, mediaFetcher);
    if (url) new Audio(url).play().catch(() => {});
  }

  voice() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor || !['question', 'retype'].includes(this.phase)) return;
    try {
      this.recognition?.abort?.();
      const rec = new Ctor();
      this.recognition = rec;
      rec.lang = document.documentElement.lang || navigator.language || 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onspeechstart = () => this.trial.onVoiceStart();
      rec.onresult = (e) => {
        const text = e.results?.[0]?.[0]?.transcript || '';
        if (!text) return;
        this.input.value = this.input.value ? `${this.input.value} ${text}` : text;
        if (this.phase === 'question') this.trial.onInput({ inputType: 'insertText' }, { origin: 'voice', value: this.input.value });
        this.updateLivePreview();
        this.focusInput();
      };
      rec.onerror = (e) => toast(`Voice input: ${e.error === 'not-allowed' ? 'microphone permission was denied' : e.error === 'network' ? 'speech recognition needs a connection in this browser' : e.error}`, { kind: 'error' });
      rec.onend = () => this.voiceBtn.classList.remove('primary');
      this.voiceBtn.classList.add('primary');
      rec.start();
    } catch (err) {
      errorToast(err);
    }
  }

  /* ===================================================== pause/finish */

  async pause() {
    if (['submitting', 'paused', 'done'].includes(this.phase)) return;
    const prev = this.phase;
    this.trial.pause('hidden');
    this.session = { ...this.session, status: 'paused', pausedAt: Date.now() };
    await store.saveSession(this.session);
    this.phase = 'paused';
    app.setBusy('study', null);
    this.showOverlay('Paused', 'Your completed reviews are saved. Timing for this card is paused.', [
      { label: 'Resume', primary: true, run: async () => {
        this.session = { ...this.session, status: 'active', warmupPending: true };
        await store.saveSession(this.session);
        this.trial.resume();
        this.overlay?.close();
        this.setPhase(prev);
        this.focusInput();
      } },
      { label: 'Save & exit', run: () => app.navigate('/') },
      { label: 'End session', run: () => this.endSession() },
    ]);
  }

  showOverlay(title, text, actions) {
    this.overlay = sheet({ title, content: h('p', { class: 'muted' }, text), footer: (close) => actions.map((a) => h('button', { class: ['btn', a.primary && 'primary'], onclick: () => { close(); a.run(); } }, a.label)) });
  }

  async endSession() {
    this.session = { ...this.session, status: 'abandoned', abandonedAt: Date.now() };
    await store.saveSession(this.session);
    await this.finish(true);
  }

  async leave() {
    if (this.phase === 'submitting') return;
    if (this.session.index < this.session.queue.length) {
      this.session = { ...this.session, status: 'paused', pausedAt: Date.now() };
      await store.saveSession(this.session);
    }
    app.navigate('/');
  }

  sessionMenu(anchor) {
    menu(anchor, [
      { label: 'Pause', icon: 'pause', run: () => this.pause() },
      { label: 'Undo last review', icon: 'undo', disabled: !this.undoStack.length, run: () => this.undo() },
      { label: 'Edit current card', icon: 'edit', disabled: !this.current, run: () => this.edit() },
      { label: 'Keyboard shortcuts', icon: 'keyboard', run: async () => (await import('./shortcuts.js')).showShortcutSheet() },
      'separator',
      { label: 'End session', icon: 'stop', run: () => this.endSession() },
    ]);
  }

  async finish(ended = false) {
    cancelAnimationFrame(this.timerRaf);
    this.timerEl.textContent = '';
    if (!ended) {
      this.session = { ...this.session, status: 'completed', completedAt: Date.now() };
      await store.saveSession(this.session);
    }
    this.phase = 'done';
    this.root.dataset.phase = 'done';
    app.setBusy('study', null);
    this.composer.hidden = true;
    this.renderProgress();
    const res = this.session.results || [];
    const first = res.filter((r) => r.firstAttempt);
    const correctFirst = first.filter((r) => r.correct).length;
    const reviews = res.filter((r) => r.type === 'review').length;
    const practice = res.filter((r) => r.type === 'practice').length;
    const time = res.reduce((s, r) => s + (r.activeMs || 0), 0);
    const mode = MODES[this.session.mode];
    replace(this.stageInner, h('div', { class: 'study-done' },
      h('div', { class: 'art', style: { width: '64px', height: '64px', borderRadius: '18px', display: 'grid', placeItems: 'center', background: 'var(--success-soft)', color: 'var(--success)' } }, icon('check')),
      h('h1', {}, ended ? 'Session ended' : 'Session complete'),
      h('p', { class: 'muted' }, mode?.practice && !this.session.live ? 'This was practice: it is recorded for your statistics, and your long-term schedule is unchanged.' : 'Your schedule has been updated.'),
      h('div', { class: 'summary-grid' },
        h('div', { class: 'stat' }, h('div', { class: 'value' }, String(first.length)), h('div', { class: 'label' }, 'cards')),
        h('div', { class: 'stat' }, h('div', { class: 'value' }, first.length ? `${Math.round((correctFirst / first.length) * 100)}%` : '—'), h('div', { class: 'label' }, 'first-try correct')),
        h('div', { class: 'stat' }, h('div', { class: 'value' }, formatDuration(time).replace(/ \d+ s$/, '')), h('div', { class: 'label' }, 'active time'))),
      h('p', { class: 'faint small' }, [
        reviews ? pluralize(reviews, 'scheduling review') : null,
        practice ? pluralize(practice, 'practice retrieval') : null,
        (this.session.skipped || []).length ? `${this.session.skipped.length} skipped (not counted)` : null,
        (this.session.deferred || []).length ? `${this.session.deferred.length} related card${this.session.deferred.length === 1 ? '' : 's'} deferred to another day by sibling spacing` : null,
        this.session.backlog ? `${this.session.backlog} still due (real due dates kept)` : null,
        (this.session.unavailable || []).length ? `${this.session.unavailable.length} removed or suspended during the session` : null,
      ].filter(Boolean).join(' · ')),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, button('Home', { kind: 'primary', href: '#/' }), button('Study more', { href: '#/study' }), button('Statistics', { href: '#/stats' }))));
    announce(ended ? 'Session ended.' : 'Session complete.');
  }
}

function speechRecognitionCtor() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}
