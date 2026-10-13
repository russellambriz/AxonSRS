/**
 * Customisable keyboard shortcuts.
 *
 * Rules (Section 16.7 / 19):
 *  - Single-key shortcuts (no Alt/Ctrl/Meta) never fire while focus is in
 *    an answer input, textarea or other editable field — so typing "e"
 *    types an "e".
 *  - Every action that matters during typing also has a modifier shortcut
 *    (Alt+key, Option+key on macOS) and a visible button.
 *  - Shortcuts are ignored during IME composition and for auto-repeat.
 */

import { isEditable } from './dom.js';

export const ACTIONS = Object.freeze({
  'nav.home': { label: 'Go to Home', keys: ['Alt+Digit1'], scope: 'global' },
  'nav.decks': { label: 'Go to Decks', keys: ['Alt+Digit2'], scope: 'global' },
  'nav.study': { label: 'Go to Study', keys: ['Alt+Digit3'], scope: 'global' },
  'nav.stats': { label: 'Go to Statistics', keys: ['Alt+Digit4'], scope: 'global' },
  'nav.settings': { label: 'Go to Settings', keys: ['Alt+Digit5'], scope: 'global' },
  'app.search': { label: 'Search cards', keys: ['Slash'], scope: 'global' },
  'app.newCard': { label: 'New card', keys: ['KeyN'], scope: 'global' },
  'app.import': { label: 'Import', keys: ['KeyI'], scope: 'global' },
  'app.help': { label: 'Keyboard shortcuts', keys: ['Shift+Slash'], scope: 'global' },
  'study.edit': { label: 'Edit current card', keys: ['Alt+KeyE', 'KeyE'], scope: 'study' },
  'study.hint': { label: 'Show hint', keys: ['Alt+KeyH', 'KeyH'], scope: 'study' },
  'study.reveal': { label: 'Reveal answer (counts as Again)', keys: ['Alt+KeyR', 'KeyR'], scope: 'study' },
  'study.skip': { label: 'Skip card', keys: ['Alt+KeyS', 'KeyS'], scope: 'study' },
  'study.undo': { label: 'Undo last review', keys: ['Alt+KeyZ', 'KeyU'], scope: 'study' },
  'study.alias': { label: 'Mark correct & save as alias', keys: ['Alt+KeyA', 'KeyA'], scope: 'study' },
  'study.correct': { label: 'Mark correct (no alias)', keys: ['Alt+KeyC', 'KeyC'], scope: 'study' },
  'study.knew': { label: 'I knew that', keys: ['Alt+KeyK', 'KeyK'], scope: 'study' },
  'study.guessed': { label: 'I guessed', keys: ['Alt+KeyG', 'KeyG'], scope: 'study' },
  'study.bypass': { label: 'Skip retyping (accessibility)', keys: ['Alt+KeyB', 'KeyB'], scope: 'study' },
  'study.solution': { label: 'Show worked solution', keys: ['Alt+KeyW', 'KeyW'], scope: 'study' },
  'study.speak': { label: 'Read aloud', keys: ['Alt+KeyT', 'KeyT'], scope: 'study' },
  'study.voice': { label: 'Voice input', keys: ['Alt+KeyM', 'KeyM'], scope: 'study' },
  'study.pause': { label: 'Pause session', keys: ['Alt+KeyP', 'KeyP'], scope: 'study' },
  'study.why': { label: 'Why this grade?', keys: ['Alt+KeyY', 'KeyY'], scope: 'study' },
  'study.grade1': { label: 'Grade Again (manual mode)', keys: ['Alt+Digit1', 'Digit1'], scope: 'study-manual' },
  'study.grade2': { label: 'Grade Hard (manual mode)', keys: ['Alt+Digit2', 'Digit2'], scope: 'study-manual' },
  'study.grade3': { label: 'Grade Good (manual mode)', keys: ['Alt+Digit3', 'Digit3'], scope: 'study-manual' },
  'study.grade4': { label: 'Grade Easy (manual mode)', keys: ['Alt+Digit4', 'Digit4'], scope: 'study-manual' },
  'study.focus': { label: 'Focus answer field', keys: ['Escape'], scope: 'study' },
});

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

export function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.code || e.key);
  return parts.join('+');
}

export function hasModifier(combo) {
  return /(^|\+)(Ctrl|Meta|Alt)\+/.test(combo);
}

export function displayCombo(combo) {
  return combo
    .split('+')
    .map((p) => {
      if (p === 'Alt') return isMac ? '⌥' : 'Alt';
      if (p === 'Meta') return isMac ? '⌘' : 'Win';
      if (p === 'Ctrl') return isMac ? '⌃' : 'Ctrl';
      if (p === 'Shift') return isMac ? '⇧' : 'Shift';
      if (p.startsWith('Key')) return p.slice(3);
      if (p.startsWith('Digit')) return p.slice(5);
      return { Slash: '/', Escape: 'Esc', Enter: '↵', Space: 'Space', Comma: ',', Period: '.' }[p] || p;
    })
    .join(isMac ? '' : '+');
}

export class Shortcuts {
  constructor() {
    this.overrides = {};
    this.handlers = new Map();
    this.scopes = new Set(['global']);
    this.onKey = (e) => this.handle(e);
    document.addEventListener('keydown', this.onKey, true);
  }

  setOverrides(map) {
    this.overrides = map || {};
  }

  keysFor(action) {
    return this.overrides[action] || ACTIONS[action]?.keys || [];
  }

  on(action, fn) {
    this.handlers.set(action, fn);
    return () => {
      if (this.handlers.get(action) === fn) this.handlers.delete(action);
    };
  }

  enableScope(scope, on = true) {
    if (on) this.scopes.add(scope);
    else this.scopes.delete(scope);
  }

  handle(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.repeat) return;
    const combo = comboFromEvent(e);
    const editable = isEditable(e.target);
    const dialogOpen = document.querySelector('dialog[open]');
    // Context scopes (study, …) take precedence over global shortcuts.
    const ordered = Object.entries(ACTIONS).sort((a, b) => Number(a[1].scope === 'global') - Number(b[1].scope === 'global'));
    for (const [action, def] of ordered) {
      if (!this.scopes.has(def.scope)) continue;
      if (!this.keysFor(action).includes(combo)) continue;
      if (!hasModifier(combo) && combo !== 'Escape' && editable) continue;
      if (dialogOpen && def.scope !== 'global') continue;
      if (dialogOpen && !hasModifier(combo)) continue;
      const fn = this.handlers.get(action);
      if (!fn) continue;
      const handled = fn(e);
      if (handled !== false) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
  }

  /** Validate a proposed binding: returns an error string or null. */
  validate(action, combo) {
    for (const [other, def] of Object.entries(ACTIONS)) {
      if (other === action) continue;
      const scopesOverlap = def.scope === ACTIONS[action].scope || def.scope === 'global' || ACTIONS[action].scope === 'global';
      if (scopesOverlap && this.keysFor(other).includes(combo)) return `Already used by “${def.label}”`;
    }
    if (['Enter', 'Tab', 'Backspace'].some((k) => combo === k)) return 'This key is reserved for typing and navigation';
    return null;
  }
}
