/**
 * Image occlusion: a mask editor (draw, move, resize, label) and the
 * study-time renderer. Mask geometry is stored as fractions of the image
 * (0..1), so masks stay aligned at any display size.
 */

import { h, replace } from './dom.js';
import { icon } from './icons.js';
import { uuid, clamp } from '../core/util.js';
import { decodeAnswers, encodeAnswers } from '../core/aliases.js';

/**
 * @param {{ imageUrl: string, masks: object[], onChange: (masks) => void }} opts
 */
export function occlusionEditor({ imageUrl, masks: initial = [], onChange }) {
  let masks = initial.map((m) => ({ ...m }));
  let selected = masks[0]?.id || null;
  const stage = h('div', { class: 'occlusion editing', style: { touchAction: 'none' } });
  const img = h('img', { src: imageUrl, alt: '', draggable: 'false' });
  stage.append(img);
  const listEl = h('div', { class: 'stack' });

  const emit = () => onChange(masks.map((m) => ({ ...m })));

  function renderMasks() {
    stage.querySelectorAll('.mask').forEach((m) => m.remove());
    masks.forEach((m, i) => {
      const el = h('div', { class: ['mask', m.id === selected && 'selected'], style: { left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }, dataset: { id: m.id }, tabindex: '0', 'aria-label': `Mask ${i + 1}: ${m.label[0] || 'unlabelled'}` }, h('span', {}, String(i + 1)), h('span', { class: 'handle', dataset: { handle: '1' } }));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          remove(m.id);
        }
      });
      stage.append(el);
    });
    renderList();
  }

  function renderList() {
    replace(listEl, masks.length ? masks.map((m, i) => {
      const input = h('input', { class: 'input', placeholder: 'Hidden label (alternatives separated by |)', 'aria-label': `Label for mask ${i + 1}` });
      input.value = encodeAnswers(m.label);
      input.addEventListener('focus', () => { selected = m.id; renderMasksOnly(); });
      input.addEventListener('change', () => {
        m.label = decodeAnswers(input.value);
        emit();
      });
      return h('div', { class: 'row tight' }, h('span', { class: 'chip accent' }, String(i + 1)), h('div', { class: 'grow' }, input), h('button', { class: 'btn ghost icon small', type: 'button', 'aria-label': `Delete mask ${i + 1}`, onclick: () => remove(m.id) }, icon('trash')));
    }) : h('p', { class: 'faint small' }, 'Drag on the image to draw a mask over each label you want to hide.'));
  }

  function renderMasksOnly() {
    stage.querySelectorAll('.mask').forEach((el) => el.classList.toggle('selected', el.dataset.id === selected));
  }

  function remove(id) {
    masks = masks.filter((m) => m.id !== id);
    if (selected === id) selected = masks[0]?.id || null;
    renderMasks();
    emit();
  }

  let drag = null;
  const rel = (e) => {
    const r = img.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = rel(e);
    const maskEl = e.target.closest('.mask');
    stage.setPointerCapture(e.pointerId);
    if (maskEl) {
      const m = masks.find((x) => x.id === maskEl.dataset.id);
      selected = m.id;
      drag = { kind: e.target.dataset.handle ? 'resize' : 'move', m, start: p, orig: { ...m } };
      renderMasksOnly();
    } else {
      const m = { id: uuid().slice(0, 8), x: p.x, y: p.y, w: 0, h: 0, label: [] };
      masks.push(m);
      selected = m.id;
      drag = { kind: 'draw', m, start: p };
      renderMasks();
    }
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = rel(e);
    const { m, start } = drag;
    if (drag.kind === 'draw') {
      m.x = Math.min(start.x, p.x);
      m.y = Math.min(start.y, p.y);
      m.w = Math.abs(p.x - start.x);
      m.h = Math.abs(p.y - start.y);
    } else if (drag.kind === 'move') {
      m.x = clamp(drag.orig.x + (p.x - start.x), 0, 1 - m.w);
      m.y = clamp(drag.orig.y + (p.y - start.y), 0, 1 - m.h);
    } else {
      m.w = clamp(drag.orig.w + (p.x - start.x), 0.02, 1 - m.x);
      m.h = clamp(drag.orig.h + (p.y - start.y), 0.02, 1 - m.y);
    }
    const el = stage.querySelector(`.mask[data-id="${m.id}"]`);
    if (el) Object.assign(el.style, { left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` });
  });
  const end = () => {
    if (!drag) return;
    if (drag.kind === 'draw' && (drag.m.w < 0.015 || drag.m.h < 0.015)) masks = masks.filter((x) => x.id !== drag.m.id);
    drag = null;
    renderMasks();
    emit();
    const input = listEl.querySelectorAll('input')[masks.findIndex((m) => m.id === selected)];
    if (input && !input.value) input.focus();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  img.addEventListener('load', renderMasks);
  renderMasks();
  return h('div', { class: 'stack' }, h('div', { style: { textAlign: 'center' } }, stage), listEl);
}

/**
 * Study-time renderer.
 * mode: 'hideAll' (all masks covered, target highlighted) |
 *       'hideOne' (only the target covered) |
 *       'progressive' (masks answered earlier this session revealed)
 */
export function occlusionView({ imageUrl, alt, masks, activeMaskId, mode = 'hideAll', revealedIds = new Set(), showAnswer = false }) {
  const stage = h('div', { class: 'occlusion', role: 'img', 'aria-label': alt || 'Image with hidden labels' });
  const img = h('img', { src: imageUrl, alt: alt || '', draggable: 'false' });
  stage.append(img);
  for (const m of masks) {
    const active = m.id === activeMaskId;
    const box = { left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` };
    if (active) {
      stage.append(h('div', { class: showAnswer ? 'mask revealed' : 'mask', style: box, 'aria-hidden': 'true' }, h('span', {}, showAnswer ? m.label[0] || '' : '?')));
      continue;
    }
    // Other masks: visible underlying image in hide-one mode or once
    // revealed progressively; otherwise covered.
    const uncovered = mode === 'hideOne' || (mode === 'progressive' && revealedIds.has(m.id));
    if (!uncovered) stage.append(h('div', { class: 'mask other', style: box, 'aria-hidden': 'true' }));
  }
  return stage;
}
