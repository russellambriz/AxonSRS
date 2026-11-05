/**
 * The saved cards of the deck open in Create with Pencil: a horizontal
 * tray of thumbnails, and a full-size viewer you can swipe, flip, edit
 * and delete. Only the thumbnails on screen are built.
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { app } from '../app.js';
import { store } from '../data/store.js';
import { confirmDialog, toast } from './components.js';
import { announce } from './appearance.js';
import { resolveMedia } from './render.js';
import { splitPencilSide } from '../core/pencil.js';

const THUMB_W = 140;
const mediaOf = async (id) => (await store.getMedia(id))?.blob || null;

function deckCards(deckId) {
  return [...app.cache.cards.values()]
    .filter((c) => c.deckId === deckId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

function sideOf(card, which) {
  const parts = which === 'back' ? card.back : card.front;
  return splitPencilSide((parts || []).join('\n\n'));
}

function labelOf(card) {
  const front = sideOf(card, 'front');
  return (front.text || front.images[0]?.alt || 'Card').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Card';
}

function fillSide(host, side) {
  host.replaceChildren();
  if (side.text) host.append(h('span', { class: 'pencil-side-text' }, side.text));
  for (const image of side.images) host.append(h('img', { alt: image.alt || '', 'data-media': image.id }));
  if (!side.text && !side.images.length) host.append(h('span', { class: 'pencil-side-text faint' }, 'Empty'));
}

/**
 * @param {object} opts
 * @param {() => string} opts.getDeckId
 * @param {(card: object) => Promise<boolean>} opts.onEdit  resolve false to keep the viewer open
 * @param {(id: string) => void} [opts.onDeleted]
 */
export function pencilLibrary({ getDeckId, onEdit, onDeleted }) {
  let cards = [];
  let index = 0;
  let face = 'front';
  let rangeKey = '';
  let generation = 0;
  let turnTimer = 0;

  const button = h('button', {
    type: 'button',
    class: 'pencil-saved',
    'aria-expanded': 'false',
    'aria-controls': 'pencil-saved-tray',
    onclick: () => (tray.hidden ? openTray() : closeTray()),
  }, '0 saved');

  const strip = h('div', { class: 'pencil-strip' });
  const inner = h('div', { class: 'pencil-strip-inner' });
  strip.append(inner);
  const tray = h('section', { id: 'pencil-saved-tray', class: 'pencil-tray', hidden: true, 'aria-label': 'Saved cards' },
    h('div', { class: 'pencil-tray-head' }, h('span', {}, 'Newest first'), h('button', { type: 'button', class: 'btn small ghost', onclick: () => closeTray() }, 'Close')),
    strip);

  const faceEl = h('div', { class: 'pencil-card', tabindex: '0', role: 'button', 'aria-label': 'Flip card' });
  const countEl = h('span', { class: 'pencil-viewer-count', 'aria-live': 'polite' });
  const prevBtn = h('button', { type: 'button', class: 'btn icon pencil-nav', 'aria-label': 'Previous card', onclick: () => step(-1) }, icon('chevronLeft'));
  const nextBtn = h('button', { type: 'button', class: 'btn icon pencil-nav', 'aria-label': 'Next card', onclick: () => step(1) }, icon('chevronRight'));
  const viewer = h('div', { class: 'pencil-viewer', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Saved card' },
    h('div', { class: 'pencil-viewer-bar' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => closeViewer() }, 'Close'),
      countEl,
      h('span', { class: 'pencil-tool-gap' }),
      h('button', { type: 'button', class: 'btn', onclick: () => editCurrent() }, icon('edit'), 'Edit'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => deleteCurrent() }, icon('trash'), 'Delete')),
    h('div', { class: 'pencil-viewer-stage' }, prevBtn, faceEl, nextBtn));

  strip.addEventListener('scroll', () => layout(), { passive: true });

  let swipe = null;
  faceEl.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  faceEl.addEventListener('pointerup', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (Math.hypot(dx, dy) < 18) flip();
  });
  faceEl.addEventListener('pointercancel', () => { swipe = null; });
  faceEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  });

  function onKey(e) {
    if (viewer.hidden || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  }
  document.addEventListener('keydown', onKey);

  function paintCount() {
    const n = cards.length;
    button.textContent = n === 1 ? '1 saved' : `${n} saved`;
    button.setAttribute('aria-label', n ? `Show ${button.textContent}` : 'No saved cards in this deck');
    button.disabled = n === 0;
    if (!n) closeTray();
  }

  function refresh() {
    cards = deckCards(getDeckId());
    generation += 1;
    if (index >= cards.length) index = Math.max(0, cards.length - 1);
    paintCount();
    if (!tray.hidden) layout(true);
    if (!viewer.hidden) paintViewer();
  }

  function layout(force = false) {
    const width = strip.clientWidth || 320;
    const start = Math.max(0, Math.floor(strip.scrollLeft / THUMB_W) - 2);
    const end = Math.min(cards.length, Math.ceil((strip.scrollLeft + width) / THUMB_W) + 3);
    const key = `${generation}:${start}:${end}`;
    inner.style.width = `${Math.max(cards.length, 1) * THUMB_W}px`;
    if (!force && key === rangeKey) return;
    rangeKey = key;
    if (!cards.length) {
      inner.replaceChildren(h('p', { class: 'pencil-tray-empty' }, 'No cards in this deck yet.'));
      inner.style.width = 'auto';
      return;
    }
    const nodes = [];
    for (let i = start; i < end; i++) nodes.push(thumb(cards[i], i));
    inner.replaceChildren(...nodes);
  }

  function thumb(card, i) {
    const front = sideOf(card, 'front');
    const back = sideOf(card, 'back');
    const btn = h('button', {
      type: 'button',
      class: 'pencil-thumb',
      style: { left: `${i * THUMB_W}px` },
      'aria-label': labelOf(card),
      onclick: () => openViewer(i),
    });
    const main = h('span', { class: 'pencil-thumb-front' });
    const peek = h('span', { class: 'pencil-thumb-peek', 'aria-hidden': 'true' });
    fillSide(main, front);
    fillSide(peek, back);
    btn.append(main, peek);
    resolveMedia(btn, mediaOf).catch(() => {});
    return btn;
  }

  function openTray() {
    if (!cards.length) return;
    tray.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    rangeKey = '';
    requestAnimationFrame(() => layout(true));
    announce(`${cards.length === 1 ? '1 saved card' : `${cards.length} saved cards`}. Newest first.`);
  }

  function closeTray() {
    tray.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function openViewer(i) {
    index = i;
    face = 'front';
    viewer.hidden = false;
    paintViewer();
    faceEl.focus();
  }

  function closeViewer() {
    viewer.hidden = true;
    clearTimeout(turnTimer);
    button.focus();
  }

  function step(delta) {
    const next = index + delta;
    if (next < 0 || next >= cards.length) return;
    index = next;
    face = 'front';
    paintViewer();
  }

  function flip() {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const apply = () => {
      face = face === 'front' ? 'back' : 'front';
      paintViewer();
      announce(face === 'back' ? 'Back of the card' : 'Front of the card');
    };
    if (reduce) {
      apply();
      return;
    }
    faceEl.classList.add('is-turning');
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      apply();
      faceEl.classList.remove('is-turning');
    }, 140);
  }

  function paintViewer() {
    const card = cards[index];
    if (!card) {
      closeViewer();
      return;
    }
    countEl.textContent = `${index + 1} of ${cards.length}`;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === cards.length - 1;
    const side = sideOf(card, face);
    faceEl.dataset.face = face;
    faceEl.setAttribute('aria-label', `${face === 'back' ? 'Back' : 'Front'} of ${labelOf(card)}. Activate to flip.`);
    const body = h('div', { class: 'pencil-face' });
    fillSide(body, side);
    faceEl.replaceChildren(h('div', { class: 'pencil-face-kicker' }, face === 'back' ? 'Back' : 'Front'), body);
    resolveMedia(faceEl, mediaOf).catch(() => {});
  }

  async function editCurrent() {
    const card = cards[index];
    if (!card) return;
    if (await onEdit(card)) {
      closeViewer();
      closeTray();
    }
  }

  async function deleteCurrent() {
    const card = cards[index];
    if (!card) return;
    const ok = await confirmDialog({ title: 'Delete this card?', message: 'Its review history is kept. You can undo right after.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    const trashId = await store.deleteCards([card.id]);
    await app.cache.load();
    onDeleted?.(card.id);
    refresh();
    if (!cards.length) closeViewer();
    else paintViewer();
    toast('Card deleted', {
      action: { label: 'Undo', run: async () => { await store.restoreTrash(trashId); await app.cache.load(); refresh(); } },
      timeout: 10000,
    });
    announce('Card deleted');
  }

  refresh();

  return {
    button,
    tray,
    viewer,
    refresh,
    destroy() {
      document.removeEventListener('keydown', onKey);
      clearTimeout(turnTimer);
    },
  };
}
