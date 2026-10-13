/** Global card search across all decks. */

import { app } from '../../app.js';
import { page, button } from './common.js';
import { cardBrowser } from './browser.js';

export async function view(outlet, params, query) {
  await app.cache.ensure();
  const { root, body } = page({ title: 'All cards', actions: [button('New card', { kind: 'primary', iconName: 'plus', href: '#/card/new' })] });
  outlet.append(root);
  const browser = cardBrowser({ initialQuery: query.q || '' });
  body.append(browser.el);
  setTimeout(() => browser.focus(), 50);
  return { destroy: () => browser.destroy() };
}
