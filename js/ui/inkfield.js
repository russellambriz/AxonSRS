/**
 * One Basic-card side in the editor: a large handwriting pad, or the
 * normal text box. The choice is remembered on this device.
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { local } from './local.js';
import { inkPad } from './inkpad.js';
import { PEN_COLORS, PEN_WIDTHS, chooseSideMode, isInkAnswer, isInkSide, penColor, penWidth } from '../core/pencil.js';

export const EDITOR_SIDES_KEY = 'axon-editor-sides';

/** A touch screen is the closest signal that a pencil may be used. Pointer Events do not advertise Apple Pencil until it touches the page. */
export function penDeviceLikely() {
  try {
    if (navigator.maxTouchPoints > 0) return true;
    if (window.matchMedia?.('(any-pointer: coarse)').matches) return true;
  } catch {
    /* matchMedia can throw in locked-down browsers */
  }
  return false;
}

function storedMode(which) {
  const saved = local.getJSON(EDITOR_SIDES_KEY);
  const value = saved?.[which];
  return value === 'ink' || value === 'text' ? value : null;
}

function remember(which, mode) {
  const saved = local.getJSON(EDITOR_SIDES_KEY) || {};
  saved[which] = mode;
  local.setJSON(EDITOR_SIDES_KEY, saved);
}

/**
 * @param {object} opts
 * @param {'front'|'back'} opts.which
 * @param {string} opts.label  "Front" or "Back", for control names
 * @param {HTMLTextAreaElement} opts.textarea
 * @param {string[]} opts.initial  current field value
 * @param {() => void} opts.onChange
 */
export function inkField({ which, label, textarea, initial = [], onChange }) {
  const inkContent = isInkSide(initial);
  const hasText = initial.some((part) => String(part || '').trim()) && !inkContent;
  let mode = chooseSideMode({ stored: storedMode(which), touch: penDeviceLikely(), inkContent, hasText });
  let touched = false;
  let colorId = 'graphite';
  let widthId = 'medium';

  const pad = inkPad({
    tools: false,
    onChange: () => {
      touched = true;
      paintTools();
      onChange();
    },
  });
  pad.el.classList.add('editor-ink');
  pad.canvas.setAttribute('aria-label', `${label} handwriting. Write with Apple Pencil. Switch to Type for the keyboard or Scribble.`);
  applyPen();

  const inkBtn = h('button', { type: 'button', 'aria-label': `${label}: Ink`, onclick: () => setMode('ink') }, 'Ink');
  const typeBtn = h('button', { type: 'button', 'aria-label': `${label}: Type`, onclick: () => setMode('text') }, 'Type');
  const toggle = h('div', { class: 'editor-side-toggle', role: 'group', 'aria-label': `${label} input` }, inkBtn, typeBtn);

  const eraserBtn = h('button', { type: 'button', class: 'btn small ghost', 'aria-pressed': 'false', onclick: () => { pad.setEraser(!pad.eraserOn()); paintTools(); } }, icon('eraser'), 'Eraser');
  const undoBtn = h('button', { type: 'button', class: 'btn small ghost', disabled: true, onclick: () => { pad.undo(); paintTools(); onChange(); } }, icon('undo'), 'Undo stroke');
  const redoBtn = h('button', { type: 'button', class: 'btn small ghost', disabled: true, onclick: () => { pad.redo(); paintTools(); onChange(); } }, icon('redo'), 'Redo stroke');
  const clearBtn = h('button', { type: 'button', class: 'btn small', 'aria-label': `Clear ${label}`, onclick: () => { touched = true; pad.clear(); paintTools(); onChange(); } }, icon('trash'), 'Clear');
  const colors = h('div', { class: 'pencil-choices', role: 'group', 'aria-label': `${label} pen colour` });
  const widths = h('div', { class: 'pencil-choices', role: 'group', 'aria-label': `${label} pen width` });
  const tools = h('div', { class: 'editor-ink-tools' }, colors, widths, eraserBtn, undoBtn, redoBtn, clearBtn);
  const host = h('div', { class: 'editor-ink-host' }, pad.el, tools);

  function applyPen() {
    pad.setPen({ color: penColor(colorId).hex, scale: penWidth(widthId).scale });
  }

  function paintTools() {
    inkBtn.setAttribute('aria-pressed', mode === 'ink' ? 'true' : 'false');
    typeBtn.setAttribute('aria-pressed', mode === 'text' ? 'true' : 'false');
    eraserBtn.setAttribute('aria-pressed', pad.eraserOn() ? 'true' : 'false');
    undoBtn.disabled = !pad.canUndo();
    redoBtn.disabled = !pad.canRedo();
    clearBtn.disabled = pad.isEmpty();
    colors.replaceChildren(...PEN_COLORS.map((c) => h('button', {
      type: 'button',
      class: 'pencil-swatch',
      'aria-label': `${label} ${c.label}`,
      'aria-pressed': String(c.id === colorId),
      onclick: () => { colorId = c.id; applyPen(); paintTools(); },
    }, h('span', { class: 'pencil-chip', 'aria-hidden': 'true' }, h('span', { class: 'pencil-dot', style: { background: c.hex } })))));
    widths.replaceChildren(...PEN_WIDTHS.map((w) => h('button', {
      type: 'button',
      class: 'pencil-width',
      'aria-label': `${label} ${w.label}`,
      'aria-pressed': String(w.id === widthId),
      onclick: () => { widthId = w.id; applyPen(); paintTools(); },
    }, h('span', { class: 'pencil-nib', 'aria-hidden': 'true', style: { height: `${Math.max(2, Math.round(w.scale * 3))}px` } }))));
  }

  function setMode(next, { silent = false, persist = true } = {}) {
    mode = next === 'ink' ? 'ink' : 'text';
    if (persist) remember(which, mode);
    host.hidden = mode !== 'ink';
    textarea.hidden = mode === 'ink';
    if (mode === 'text' && isInkAnswer(textarea.value.trim())) textarea.value = '';
    paintTools();
    if (mode === 'ink') requestAnimationFrame(() => pad.resize());
    if (!silent) onChange();
  }

  paintTools();
  setMode(mode, { silent: true, persist: false });

  return {
    host,
    toggle,
    pad,
    isInk: () => mode === 'ink',
    /** The user drew or cleared, so the pad (not the previously saved image) is what to store. */
    touched: () => touched,
    setVisible(show) {
      toggle.hidden = !show;
      host.hidden = !show || mode !== 'ink';
      if (!show) textarea.hidden = false;
      else textarea.hidden = mode === 'ink';
      if (show && mode === 'ink') requestAnimationFrame(() => pad.resize());
    },
  };
}
