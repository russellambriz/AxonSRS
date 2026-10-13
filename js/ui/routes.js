/** Route table. Views are loaded on demand to keep startup fast. */

import { h } from './dom.js';

const lazy = (name, exportName = 'view') => async (outlet, params, query) => {
  const mod = await import(`./views/${name}.js`);
  return mod[exportName](outlet, params, query);
};

export const routes = [
  { path: '/', section: 'home', title: 'Home', view: lazy('home') },
  { path: '/decks', section: 'decks', title: 'Decks', view: lazy('decks') },
  { path: '/deck/:id', section: 'decks', title: 'Deck', view: lazy('deck') },
  { path: '/cards', section: 'decks', title: 'Cards', view: lazy('cards') },
  { path: '/card/new', section: 'decks', title: 'New card', view: lazy('editor', 'newCardView') },
  { path: '/card/:id', section: 'decks', title: 'Card', view: lazy('editor') },
  { path: '/import', section: 'decks', title: 'Import', view: lazy('import') },
  { path: '/study', section: 'study', title: 'Study', view: lazy('launcher') },
  { path: '/study/session/:id', section: 'session', title: 'Studying', view: lazy('study') },
  { path: '/plans', section: 'study', title: 'Exam plans', view: lazy('plans') },
  { path: '/stats', section: 'stats', title: 'Statistics', view: lazy('stats') },
  { path: '/settings', section: 'settings', title: 'Settings', view: lazy('settings') },
  { path: '/settings/:section', section: 'settings', title: 'Settings', view: lazy('settings') },
  { path: '/recovery', section: 'settings', title: 'Recovery', view: lazy('recovery') },
  { path: '/conflicts', section: 'settings', title: 'Sync conflicts', view: lazy('conflicts') },
];

export function notFound(outlet) {
  outlet.append(h('div', { class: 'view narrow' }, h('div', { class: 'empty' }, h('h2', {}, 'Page not found'), h('p', {}, 'This screen does not exist.'), h('a', { class: 'btn primary', href: '#/' }, 'Go home'))));
  return null;
}
