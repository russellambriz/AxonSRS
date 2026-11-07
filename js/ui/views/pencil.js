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
import { inkPad, smoothingButtons } from '../inkpad.js';
import { createCard } from '../../core/model.js';
import { PAPER, PEN_COLORS, PEN_WIDTHS, composePencilCard, imageRejectReason, penColor, penWidth, splitPencilSide } from '../../core/pencil.js';
import { pencilLibrary } from '../pencilreel.js';

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
  let handwritten = true;
  let colorId = 'graphite';
  let widthId = 'medium';
  let editingId = null;
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

  const library = pencilLibrary({
    getDeckId: () => deckId,
    onEdit: (card) => loadCard(card),
    onDeleted: (id) => { if (editingId === id) resetForm(); },
  });
  const noteEl = h('p', { class: 'pencil-note' }, '');
  const statusEl = h('p', { class: 'pencil-status', role: 'status' }, '');
  const ghostEl = h('p', { class: 'pencil-ghost', 'aria-hidden': 'true' }, 'Sketch the prompt');
  const frontBtn = h('button', { type: 'button', 'aria-pressed': 'true', onclick: () => showSide('front') }, 'Front');
  const backBtn = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => showSide('back') }, 'Back');
  const eraserBtn = h('button', { type: 'button', class: 'btn ghost', 'aria-pressed': 'false', onclick: () => toggleEraser() }, icon('eraser'), 'Eraser');
  const undoBtn = h('button', { type: 'button', class: 'btn ghost', disabled: true, onclick: () => { active().undo(); refresh(); } }, icon('undo'), 'Undo stroke');
  const redoBtn = h('button', { type: 'button', class: 'btn ghost', disabled: true, onclick: () => { active().redo(); refresh(); } }, icon('redo'), 'Redo stroke');
  const clearBtn = h('button', { type: 'button', class: 'btn ghost', disabled: true, onclick: () => { active().clear(); refresh(); } }, icon('trash'), 'Clear');
  const saveButtons = [];
  function savePair(extraClass = '', { flipFirst = true } = {}) {
    const next = h('button', { type: 'button', class: 'btn primary pencil-next', onclick: () => saveCard(true) }, 'Save & flip');
    const done = h('button', { type: 'button', class: 'btn', onclick: () => saveCard(false) }, 'Done');
    saveButtons.push(next, done);
    return h('div', { class: ['pencil-actions', extraClass], role: 'group', 'aria-label': 'Save this card' }, ...(flipFirst ? [next, done] : [done, next]));
  }
  const headerActions = savePair('pencil-top-actions', { flipFirst: false });
  const backActions = savePair('pencil-quick');
  backActions.hidden = true;
  const panelActions = savePair();

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
      ? 'This ink is the front of the card.'
      : (handwritten ? 'This ink is the answer. It is printed on the card, not turned into text.' : 'Optional note. The typed answer is what Axon checks.');
    ghostEl.textContent = side === 'front' ? 'Sketch the prompt' : (handwritten ? 'Write the answer' : 'Optional note');
    backActions.hidden = side !== 'back';
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
    return !!(promptInput.value.trim() || answerInput.value.trim() || !frontPad.isEmpty() || !backPad.isEmpty() || frontPad.hasPlate() || backPad.hasPlate());
  }

  function refresh() {
    const pad = active();
    undoBtn.disabled = !pad.canUndo();
    redoBtn.disabled = !pad.canRedo();
    clearBtn.disabled = pad.isEmpty();
    eraserBtn.setAttribute('aria-pressed', pad.eraserOn() ? 'true' : 'false');
    ghostEl.hidden = !pad.isEmpty() || pad.hasPlate();
    const preview = composePencilCard(draftPreview());
    if (!isDirty()) statusEl.textContent = '';
    else if (!preview.ok) statusEl.textContent = preview.error;
    else statusEl.textContent = handwritten ? 'Ready to save. The answer is the handwriting on the back.' : 'Ready to save. Only the graded answer is checked.';
  }

  function draftPreview() {
    return {
      prompt: promptInput.value,
      answer: handwritten ? '' : answerInput.value,
      frontImage: frontPad.isEmpty() && !frontPad.plateId() ? null : { id: frontPad.plateId() || 'pending', alt: 'Handwritten prompt' },
      backImage: backPad.isEmpty() && !backPad.plateId() ? null : { id: backPad.plateId() || 'pending', alt: handwritten ? 'Handwritten answer' : 'Handwritten note' },
      handwritten,
    };
  }

  function setAnswerKind(ink) {
    handwritten = !!ink;
    handBtn.setAttribute('aria-pressed', handwritten ? 'true' : 'false');
    typeBtn.setAttribute('aria-pressed', handwritten ? 'false' : 'true');
    typedBlock.hidden = handwritten;
    inkBlock.hidden = !handwritten;
    if (root) root.dataset.answer = handwritten ? 'ink' : 'typed';
    showSide(side);
  }

  function resetForm() {
    editingId = null;
    promptInput.value = '';
    answerInput.value = '';
    frontPad.clear();
    backPad.clear();
    showSide('front');
    statusEl.textContent = '';
    if (handwritten) {
      const el = document.activeElement;
      if (el === promptInput || el === answerInput) el.blur();
    } else promptInput.focus({ preventScroll: true });
  }

  async function loadPlate(pad, id) {
    if (!id) {
      pad.setPlate(null);
      return;
    }
    const rec = await store.getMedia(id);
    if (!rec?.blob) {
      pad.setPlate(null);
      return;
    }
    const url = URL.createObjectURL(rec.blob);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      /* a broken image still should not block the rest of the card */
    }
    pad.setPlate(img, id, url);
  }

  async function loadCard(card) {
    if (editingId !== card.id && isDirty()) {
      const ok = await confirmDialog({ title: 'Discard this page?', message: 'The card you are writing has not been saved.', confirmLabel: 'Discard', danger: true });
      if (!ok) return false;
    }
    const front = splitPencilSide((card.front || []).join('\n\n'));
    const back = splitPencilSide((card.back || []).join('\n\n'));
    const ink = !back.text && back.images.length > 0;
    editingId = card.id;
    promptInput.value = front.text;
    answerInput.value = ink ? '' : back.text;
    frontPad.clear();
    backPad.clear();
    setAnswerKind(ink);
    await Promise.all([loadPlate(frontPad, front.images[0]?.id || null), loadPlate(backPad, back.images[0]?.id || null)]);
    showSide('front');
    announce('Card loaded. Change it, then save.');
    return true;
  }

  async function storeDrawing(pad, filename, alt) {
    if (pad.isEmpty()) return pad.plateId() ? { id: pad.plateId(), alt } : null;
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
    const preview = composePencilCard(draftPreview());
    if (!preview.ok) {
      statusEl.textContent = preview.error;
      announce(preview.error, { assertive: true });
      const hasPrompt = !!(promptInput.value.trim() || !frontPad.isEmpty());
      if (!handwritten && hasPrompt && !answerInput.value.trim()) answerInput.focus();
      else if (handwritten && hasPrompt && backPad.isEmpty()) showSide('back');
      else showSide('front');
      return;
    }
    saving = true;
    for (const btn of saveButtons) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    }
    try {
      const frontImage = await storeDrawing(frontPad, 'handwritten-prompt.png', 'Handwritten prompt');
      const backAlt = handwritten ? 'Handwritten answer' : 'Handwritten note';
      const backImage = await storeDrawing(backPad, handwritten ? 'handwritten-answer.png' : 'handwritten-note.png', backAlt);
      const ready = composePencilCard({
        prompt: promptInput.value,
        answer: handwritten ? '' : answerInput.value,
        frontImage,
        backImage,
        handwritten,
      });
      if (!ready.ok) throw new Error(ready.error);
      const previous = editingId ? app.cache.cards.get(editingId) : null;
      const updating = !!previous;
      const card = createCard({
        ...(previous || {}),
        id: previous?.id,
        createdAt: previous?.createdAt,
        version: previous?.version || null,
        deckId,
        front: ready.front,
        back: ready.back,
        media: [...new Set([...(previous?.media || []), ...ready.mediaIds])],
      }, store.deviceId);
      await store.saveCard(card);
      await app.cache.load();
      library.refresh();
      const n = [...app.cache.cards.values()].filter((c) => c.deckId === deckId).length;
      if (andNext) {
        resetForm();
        announce(updating ? 'Card updated. The page is clear for the next one.' : `Card saved. ${n === 1 ? 'One card' : `${n} cards`} in this deck. The page is clear for the next one.`);
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
      for (const btn of saveButtons) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
      refresh();
    }
  }

  const handBtn = h('button', { type: 'button', 'aria-label': 'Handwritten answer', 'aria-pressed': 'true', onclick: () => setAnswerKind(true) }, 'Handwritten');
  const typeBtn = h('button', { type: 'button', 'aria-label': 'Typed answer', 'aria-pressed': 'false', onclick: () => setAnswerKind(false) }, 'Typed');
  const typedBlock = h('div', { class: 'pencil-typed', hidden: true },
    h('div', { class: 'pencil-kicker' }, 'Graded answer'),
    h('p', {}, 'Axon checks this text when you study. A drawing on the back is only a note.'),
    answerInput,
    h('p', { class: 'faint small' }, 'Separate accepted alternatives with |'));
  const inkBlock = h('div', { class: 'pencil-ink-copy' },
    h('div', { class: 'pencil-kicker' }, 'Handwritten answer'),
    h('p', {}, 'Flip to Back and write the answer. That ink is the back of the card. When you review, you compare your writing with it and choose the grade. Nothing is typed or matched.'));
  const deckSelect = select({
    label: 'Deck',
    options: decks.map((d) => ({ value: d.id, label: d.name })),
    value: deckId,
    onchange: (v) => { deckId = v; library.refresh(); },
  });

  const root = h('div', { class: 'pencil-studio', role: 'region', 'aria-label': 'Create with Pencil' },
    h('header', { class: 'pencil-top' },
      h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => app.navigate(`/deck/${deckId}`) }, icon('x')),
      h('div', { class: 'pencil-heading' },
        h('h1', {}, 'Create with Pencil'),
        library.button),
      headerActions,
      h('div', { class: 'pencil-sides', role: 'group', 'aria-label': 'Card side' }, frontBtn, backBtn),
      h('div', { class: 'pencil-deck' }, deckSelect)),
    h('div', { class: 'pencil-body' },
      h('div', { class: 'pencil-stage' },
        h('div', { class: 'pencil-paper' }, frontPad.el, backPad.el, ghostEl),
        noteEl,
        backActions,
        h('div', { class: 'pencil-tools' }, colorHost, widthHost, smoothingButtons(), h('span', { class: 'pencil-tool-gap' }), eraserBtn, undoBtn, redoBtn, clearBtn)),
      h('aside', { class: 'pencil-panel', 'aria-label': 'Text' },
        h('div', { class: 'pencil-kinds', role: 'group', 'aria-label': 'How the answer is stored' }, handBtn, typeBtn),
        h('label', { class: 'pencil-field' }, h('span', {}, 'Prompt text ', h('span', { class: 'faint' }, 'optional')), promptInput),
        h('div', { class: 'pencil-graded' }, typedBlock, inkBlock),
        statusEl,
        panelActions)),
    library.tray,
    library.viewer);

  outlet.append(root);
  applyPen();
  paintChoices();
  setAnswerKind(true);
  app.leaveGuard = async () => (!isDirty() || confirmDialog({ title: 'Leave without saving?', message: 'This card has not been saved.', confirmLabel: 'Leave', danger: true }));

  return {
    destroy() {
      document.body.classList.remove('penciling');
      app.leaveGuard = null;
      library.destroy();
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
