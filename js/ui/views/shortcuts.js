/** Always-available keyboard shortcut cheat sheet (press ?). */

import { h } from '../dom.js';
import { sheet } from '../components.js';
import { ACTIONS, displayCombo } from '../keyboard.js';
import { app } from '../../app.js';

export function showShortcutSheet() {
  if (document.querySelector('dialog[open][aria-label="Keyboard shortcuts"]')) return;
  const groups = { global: 'Anywhere', study: 'While studying', 'study-manual': 'Manual grading' };
  const content = h('div', { class: 'stack' },
    h('p', { class: 'faint small' }, 'Keys without ⌥/Alt only work when you are not typing in a field. Enter submits, and Enter again continues. Customise shortcuts in Settings → Input & keyboard.'),
    ...Object.entries(groups).map(([scope, title]) => h('section', {}, h('h3', {}, title), h('table', { class: 'table shortcut-table' }, h('tbody', {}, Object.entries(ACTIONS).filter(([, d]) => d.scope === scope).map(([action, d]) => h('tr', {}, h('td', {}, d.label), h('td', { class: 'nowrap' }, app.shortcuts.keysFor(action).map((k) => h('kbd', { style: { marginRight: '4px' } }, displayCombo(k)))))))))));
  sheet({ title: 'Keyboard shortcuts', content });
}
