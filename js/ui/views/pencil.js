/**
 * Full-screen card studio for Apple Pencil. The page is a sheet of paper;
 * the graded answer is a normal text field so Scribble and typing stay
 * first-class. Drawings are stored as images and are never matched.
 */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { button } from './common.js';
import { select, confirmDialog, errorToast } from '../components.js';
import { announce } from '../appearance.js';
import { inkPad } from '../inkpad.js';
import { createCard } from '../../core/model.js';
import { PAPER, PEN_COLORS, PEN_WIDTHS, composePencilCard, imageRejectReason, penColor, penWidth } from '../../core/pencil.js';

export async function view(outlet, _params, query) {
  await app.cache.ensure();
  const decks = [...app.cache.decks.values()].filter((d) => !d.archived);
  if (!decks.length) {
    outlet.append(h('div', { class: 'view narrow' }, h('div', { class: 'empty' },
      h('h2', {}, 'Create a deck first'),
      h('p', {}, 'Pencil cards are saved into a deck.'),
      button('Go to decks', { kind: 'primary', href: '#/decks' }))));
    return null;
  }

  let deckId = decks.some((d) => d.id === query.deck) ? query.deck : decks[0].id;
  let side = 'front';
  let colorId = 'graphite';
  let widthId = 'medium';
  let savedCount = 0;
  let saving = false;

  document.body.classList.add('penciling');

  const frontPad = inkPad({ tools: false, onChange: () => refresh() });
  const backPad = inkPad({ tools: false, onChange: () => refresh() });
  frontPad.el.classList.add('pad-front');
  backPad.el.classList.add('pad-back');

  const promptInput = h('textarea', {
    class: 'pencil-prompt',
    rows: '2',
    placeholder: 'Type a prompt, or leave this blank and sketch it',
    'aria-label': 'Prompt text',
  });
  const answerInput = h('textarea', {
    class: 'pencil-answer',
    rows: '3',
    placeholder: 'Type or Scribble the answer',
    'aria-label': 'Graded answer',
    enterkeyhint: 'done',
  });
  promptInput.addEventListener('input', () => refresh());
  answerInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      saveCard(true);
    }
  });

  const savedEl = h('span', { class: 'pencil-saved', 'aria-live': 'polite' }, '');
  const noteEl = h('p', { class: 'pencil-note' }, '');
  const statusEl = h('p', { class: 'pencil-status', role: 'status' }, '');
  const ghostEl = h('p', { class: 'pencil-ghost', 'aria-hidden': 'true' }, 'Sketch the prompt');
  const frontBtn = h('button', { type: 'button', 'aria-pressed': 'true', onclick: () => showSide('front') }, 'Front');
  const backBtn = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => showSide('back') }, 'Back');
  const eraserBtn = h('button', { type: 'button', class: 'btn ghost', 'aria-pressed': 'false', onclick: () => toggleEraser() }, icon('eraser'), 'Eraser');
  const undoBtn = h('button', { type: 'button', class: 'btn ghost', disabled: true, onclick: () => { active().undo(); refresh(); } }, icon('undo'), 'Undo stroke');
  const redoBtn = h('button', { type: 'button', class: 'btn ghost', disabled: true, onclick: () => { active().redo(); refresh(); } }, icon('redo'), 'Redo stroke');
  const clearBtn = h('button', { type: 'button', class: 'btn ghost', disabled: true, onclick: () => { active().clear(); refresh(); } }, icon('trash'), 'Clear');
  const nextBtn = h('button', { type: 'button', class: 'btn primary pencil-next', onclick: () => saveCard(true) }, 'Save & next');
  const doneBtn = h('button', { type: 'button', class: 'btn', onclick: () => saveCard(false) }, 'Done');

  const colorHost = h('div', { class: 'pencil-choices', role: 'group', 'aria-label': 'Pen colour' });
  const widthHost = h('div', { class: 'pencil-choices', role: 'group', 'aria-label': 'Pen width' });

  function paintChoices() {
    colorHost.replaceChildren(...PEN_COLORS.map((c) => h('button', {
      type: 'button',
      class: 'pencil-swatch',
      'aria-label': c.label,
      'aria-pressed': String(c.id === colorId),
      onclick: () => { colorId = c.id; applyPen(); paintChoices(); },
    }, h('span', { class: 'pencil-chip', 'aria-hidden': 'true' }, h('span', { class: 'pencil-dot', style: { background: c.hex } })))));
    widthHost.replaceChildren(...PEN_WIDTHS.map((w) => h('button', {
      type: 'button',
      class: 'pencil-width',
      'aria-label': w.label,
      'aria-pressed': String(w.id === widthId),
      onclick: () => { widthId = w.id; applyPen(); paintChoices(); },
    }, h('span', { class: 'pencil-nib', 'aria-hidden': 'true', style: { height: `${Math.max(2, Math.round(w.scale * 3))}px` } }))));
  }

  function applyPen() {
    const color = penColor(colorId).hex;
    const scale = penWidth(widthId).scale;
    frontPad.setPen({ color, scale });
    backPad.setPen({ color, scale });
    eraserBtn.setAttribute('aria-pressed', 'false');
  }

  function active() {
    return side === 'front' ? frontPad : backPad;
  }

  function showSide(next) {
    side = next;
    if (root) root.dataset.side = side;
    frontPad.el.hidden = side !== 'front';
    backPad.el.hidden = side !== 'back';
    frontBtn.setAttribute('aria-pressed', side === 'front' ? 'true' : 'false');
    backBtn.setAttribute('aria-pressed', side === 'back' ? 'true' : 'false');
    noteEl.textContent = side === 'front'
      ? 'The sketch is the prompt. Axon does not read it.'
      : 'This drawing is a note beside the answer. It is not graded.';
    ghostEl.textContent = side === 'front' ? 'Sketch the prompt' : 'Optional note';
    requestAnimationFrame(() => active().resize());
    refresh();
  }

  function toggleEraser() {
    const on = !active().eraserOn();
    frontPad.setEraser(on);
    backPad.setEraser(on);
    eraserBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function isDirty() {
    return !!(promptInput.value.trim() || answerInput.value.trim() || !frontPad.isEmpty() || !backPad.isEmpty());
  }

  function refresh() {
    const pad = active();
    undoBtn.disabled = !pad.canUndo();
    redoBtn.disabled = !pad.canRedo();
    clearBtn.disabled = pad.isEmpty();
    eraserBtn.setAttribute('aria-pressed', pad.eraserOn() ? 'true' : 'false');
    ghostEl.hidden = !pad.isEmpty();
    const preview = composePencilCard({
      prompt: promptInput.value,
      answer: answerInput.value,
      frontImage: frontPad.isEmpty() ? null : { id: 'pending', alt: 'Handwritten prompt' },
      backImage: backPad.isEmpty() ? null : { id: 'pending', alt: 'Handwritten note' },
    });
    if (!isDirty()) statusEl.textContent = '';
    else if (!preview.ok) statusEl.textContent = preview.error;
    else statusEl.textContent = 'Ready to save. Only the graded answer is checked.';
  }

  function resetForm() {
    promptInput.value = '';
    answerInput.value = '';
    frontPad.clear();
    backPad.clear();
    showSide('front');
    statusEl.textContent = '';
  }

  async function storeDrawing(pad, filename, alt) {
    if (pad.isEmpty()) return null;
    const snap = pad.snapshot({ background: PAPER });
    if (!snap) return null;
    const blob = dataUrlToBlob(snap.src);
    const file = new File([blob], filename, { type: 'image/png' });
    const reason = imageRejectReason({ type: file.type, size: file.size });
    if (reason) throw new Error(reason);
    const id = await store.putMedia(file, { name: filename });
    return { id, alt };
  }

  async function saveCard(andNext) {
    if (saving) return;
    if (!andNext && !isDirty()) {
      app.leaveGuard = null;
      app.navigate(`/deck/${deckId}`);
      return;
    }
    const preview = composePencilCard({
      prompt: promptInput.value,
      answer: answerInput.value,
      frontImage: frontPad.isEmpty() ? null : { id: 'pending', alt: 'Handwritten prompt' },
      backImage: backPad.isEmpty() ? null : { id: 'pending', alt: 'Handwritten note' },
    });
    if (!preview.ok) {
      statusEl.textContent = preview.error;
      announce(preview.error, { assertive: true });
      if (!answerInput.value.trim()) answerInput.focus();
      return;
    }
    saving = true;
    nextBtn.disabled = true;
    doneBtn.disabled = true;
    try {
      const frontImage = await storeDrawing(frontPad, 'handwritten-prompt.png', 'Handwritten prompt');
      const backImage = await storeDrawing(backPad, 'handwritten-note.png', 'Handwritten note');
      const ready = composePencilCard({ prompt: promptInput.value, answer: answerInput.value, frontImage, backImage });
      if (!ready.ok) throw new Error(ready.error);
      const card = createCard({ deckId, front: ready.front, back: ready.back, media: ready.mediaIds }, store.deviceId);
      await store.saveCard(card);
      await app.cache.load();
      savedCount += 1;
      savedEl.textContent = savedCount === 1 ? '1 saved' : `${savedCount} saved`;
      if (andNext) {
        resetForm();
        announce(`Card saved. ${savedCount === 1 ? 'One card' : `${savedCount} cards`} this session. The page is clear for the next one.`);
      } else {
        announce('Card saved.');
        app.leaveGuard = null;
        app.navigate(`/deck/${deckId}`);
      }
    } catch (err) {
      errorToast(err);
      announce(err?.message || 'The card could not be saved.', { assertive: true });
    } finally {
      saving = false;
      nextBtn.disabled = false;
      doneBtn.disabled = false;
      refresh();
    }
  }

  const deckSelect = select({
    label: 'Deck',
    options: decks.map((d) => ({ value: d.id, label: d.name })),
    value: deckId,
    onchange: (v) => { deckId = v; },
  });

  const root = h('div', { class: 'pencil-studio', role: 'region', 'aria-label': 'Create with Pencil' },
    h('header', { class: 'pencil-top' },
      h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => app.navigate(`/deck/${deckId}`) }, icon('x')),
      h('div', { class: 'pencil-heading' },
        h('h1', {}, 'Create with Pencil'),
        savedEl),
      h('div', { class: 'pencil-sides', role: 'group', 'aria-label': 'Card side' }, frontBtn, backBtn),
      h('div', { class: 'pencil-deck' }, deckSelect)),
    h('div', { class: 'pencil-body' },
      h('div', { class: 'pencil-stage' },
        h('div', { class: 'pencil-paper' }, frontPad.el, backPad.el, ghostEl),
        noteEl,
        h('div', { class: 'pencil-tools' }, colorHost, widthHost, h('span', { class: 'pencil-tool-gap' }), eraserBtn, undoBtn, redoBtn, clearBtn)),
      h('aside', { class: 'pencil-panel', 'aria-label': 'Text' },
        h('label', { class: 'pencil-field' }, h('span', {}, 'Prompt text ', h('span', { class: 'faint' }, 'optional')), promptInput),
        h('div', { class: 'pencil-graded' },
          h('div', { class: 'pencil-kicker' }, 'Graded answer'),
          h('p', {}, 'Axon checks this text when you study. The drawing is not read and is not graded.'),
          answerInput,
          h('p', { class: 'faint small' }, 'Separate accepted alternatives with |')),
        statusEl,
        h('div', { class: 'pencil-actions' }, nextBtn, doneBtn))));

  outlet.append(root);
  applyPen();
  paintChoices();
  showSide('front');
  app.leaveGuard = async () => (!isDirty() || confirmDialog({ title: 'Leave without saving?', message: 'This card has not been saved.', confirmLabel: 'Leave', danger: true }));

  return {
    destroy() {
      document.body.classList.remove('penciling');
      app.leaveGuard = null;
    },
  };
}

/** PNG bytes from a data URL. Local only: the drawing never leaves the device to be encoded. */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = /data:([^;,]+)/.exec(dataUrl.slice(0, comma))?.[1] || 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
