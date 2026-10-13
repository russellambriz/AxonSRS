/**
 * App shell: desktop sidebar (decks, search, settings), tablet icon rail,
 * phone bottom navigation, sync status and the update banner.
 */

import { h, replace } from './dom.js';
import { icon } from './icons.js';
import { app } from '../app.js';
import { debounce } from '../core/util.js';

const NAV = [
  { id: 'home', label: 'Home', icon: 'home', href: '#/' },
  { id: 'decks', label: 'Decks', icon: 'decks', href: '#/decks' },
  { id: 'study', label: 'Study', icon: 'study', href: '#/study' },
  { id: 'stats', label: 'Statistics', icon: 'stats', href: '#/stats' },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '#/settings' },
];

export function buildShell(root) {
  const outlet = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const navLinks = new Map();
  const bottomLinks = new Map();
  const deckList = h('nav', { class: 'sidebar-decks', 'aria-label': 'Decks' });
  const syncPill = h('a', { class: 'sync-pill', href: '#/settings/sync' }, h('span', { class: 'dot' }), h('span', { class: 'label' }, 'Local only'));
  const search = h('input', { type: 'search', placeholder: 'Search cards', 'aria-label': 'Search cards', enterkeyhint: 'search' });
  const goSearch = debounce(() => {
    const q = search.value.trim();
    if (q) app.navigate(`/cards?q=${encodeURIComponent(q)}`);
  }, 350);
  search.addEventListener('input', goSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      goSearch.cancel();
      app.navigate(`/cards?q=${encodeURIComponent(search.value.trim())}`);
    }
  });

  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Primary' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('logo')), h('span', {}, 'Axon')),
    h('div', { class: 'sidebar-search' }, icon('search'), search),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map((n) => {
      const count = h('span', { class: 'count' });
      const a = h('a', { class: 'nav-link', href: n.href }, icon(n.icon), h('span', {}, n.label), count);
      navLinks.set(n.id, { a, count });
      return a;
    })),
    h('div', { class: 'sidebar-section' }, 'Decks'),
    deckList,
    h('div', { class: 'sidebar-footer' },
      h('a', { class: 'nav-link', href: '#/import' }, icon('upload'), h('span', {}, 'Import')),
      syncPill),
  );

  const bottom = h('nav', { class: 'bottom-nav', 'aria-label': 'Main' }, NAV.map((n) => {
    const badge = h('span', { class: 'badge-dot', hidden: true });
    const a = h('a', { href: n.href }, icon(n.icon), h('span', {}, n.label), badge);
    bottomLinks.set(n.id, { a, badge });
    return a;
  }));

  const skip = h('a', { class: 'skip-link', href: '#main', onclick: (e) => { e.preventDefault(); outlet.focus(); } }, 'Skip to content');
  root.replaceChildren(skip, h('div', { class: 'app' }, sidebar, outlet), bottom);

  function setActive(section) {
    for (const [id, { a }] of navLinks) a.setAttribute('aria-current', id === section ? 'page' : 'false');
    for (const [id, { a }] of bottomLinks) a.setAttribute('aria-current', id === section ? 'page' : 'false');
  }

  function refreshCounts() {
    if (!app.cache.loaded) return;
    const c = app.counts();
    const due = c.due + c.learning;
    const studyNav = navLinks.get('study');
    studyNav.count.textContent = due ? String(due) : '';
    studyNav.count.classList.toggle('due', due > 0);
    const b = bottomLinks.get('study').badge;
    b.hidden = !due;
    b.textContent = due > 99 ? '99+' : String(due);
    const decks = [...app.cache.decks.values()].filter((d) => !d.archived).sort((a, b2) => a.name.localeCompare(b2.name));
    replace(deckList, decks.slice(0, 30).map((d) => {
      const dc = app.counts({ deckId: d.id });
      const n = dc.due + dc.learning;
      return h('a', { class: 'nav-link', href: `#/deck/${encodeURIComponent(d.id)}` }, h('span', { class: 'deck-dot', style: { background: d.color } }), h('span', { class: 'truncate' }, d.name), h('span', { class: ['count', n ? 'due' : ''] }, n ? String(n) : ''));
    }));
  }

  function setSync(status) {
    syncPill.className = `sync-pill ${status.state || ''}`;
    const configured = app.sync.isConfigured();
    let text = configured ? 'Sync ready' : 'Local only';
    if (status.state === 'syncing') text = 'Syncing…';
    else if (status.state === 'ok') text = 'Synced';
    else if (status.state === 'error') text = 'Sync problem';
    else if (status.state === 'offline') text = 'Offline';
    syncPill.querySelector('.label').textContent = text;
    syncPill.title = status.message || text;
  }

  app.onChange(refreshCounts);
  app.sync.on(setSync);
  setSync(app.sync.status);
  return { outlet, setActive, refreshCounts, search };
}

/** Unobtrusive "update available" notice; applies at a safe point. */
export function showUpdateBanner(onApply) {
  if (document.querySelector('.update-banner')) return;
  const status = h('span', {}, 'A new version of Axon is ready.');
  const btn = h('button', { class: 'btn small primary' }, 'Update');
  const later = h('button', { class: 'btn small ghost' }, 'Later');
  const banner = h('div', { class: 'update-banner', role: 'status' }, icon('sparkles'), status, btn, later);
  btn.addEventListener('click', () => {
    if (app.isBusy()) {
      status.textContent = `Will update after you finish: ${[...app.busy.values()][0]}.`;
      btn.disabled = true;
      onApply({ whenIdle: true });
    } else {
      onApply({ whenIdle: false });
    }
  });
  later.addEventListener('click', () => banner.remove());
  document.body.append(banner);
}
