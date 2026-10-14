/** Home: due today, progress, activity, recent decks, onboarding. */

import { h, replace, formatDate } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button, kpi } from './common.js';
import { toast, promptDialog, callout, barChart, chartWithTable, dataTable, errorToast } from '../components.js';
import { startDaily, todayContext, createSession } from '../../study/session.js';
import { currentStreak, heatmapLevels, forecast } from '../../core/stats.js';
import { durationModel, estimateSessionMinutes, catchUpPlan } from '../../core/planner.js';
import { addDays } from '../../core/time.js';
import { createSampleDeck } from './sample.js';
import { deckCard } from './decks.js';
import { local } from '../local.js';

export async function view(outlet) {
  const { root, body, header } = page({ title: greeting(), sub: formatDate(Date.now(), { weekday: 'long', month: 'long', day: 'numeric' }) });
  outlet.append(root);
  let destroyed = false;
  const render = async () => {
    if (destroyed) return;
    await app.cache.ensure();
    if (!app.cache.decks.size) {
      header.hidden = true;
      replace(body, onboarding());
      return;
    }
    header.hidden = false;
    const [tctx, recent, activity, sessions, conflicts, imports] = await Promise.all([
      todayContext(),
      store.recentRetrievals(300),
      store.activitySummary(),
      store.activeSessions(),
      store.listConflicts(),
      store.listImports(),
    ]);
    if (destroyed) return;
    const counts = app.counts();
    let newToday = 0;
    for (const deck of app.cache.decks.values()) {
      const dc = app.counts({ deckId: deck.id });
      newToday += Math.min(dc.newAvailable, app.newToday(deck, tctx.introducedToday));
    }
    const reviews = counts.due;
    const total = reviews + counts.learning + newToday;
    const model = durationModel(recent);
    const est = estimateSessionMinutes({ reviews, news: newToday, learning: counts.learning }, model);
    const streak = currentStreak(activity, tctx.today);
    const reviewedToday = tctx.events.filter((e) => e.type === 'review').length;
    const fc = forecast([...app.cache.units.values()], app.cache.cards, { today: tctx.today, days: 8, timeZone: tctx.timeZone, rolloverHour: tctx.rolloverHour });

    const blocks = [];
    // Resume
    const resumable = sessions.filter((s) => s.index < s.queue.length);
    if (resumable.length) {
      const s = resumable[0];
      blocks.push(h('div', { class: 'callout' }, icon('play'), h('div', { class: 'grow' }, `You have an unfinished ${s.mode} session (${s.index} of ${s.queue.length} done).`), h('div', { class: 'row tight' }, button('Resume', { kind: 'primary small', href: `#/study/session/${s.id}` }), button('Abandon', { small: true, onclick: async () => {
        await store.saveSession({ ...s, status: 'abandoned', abandonedAt: Date.now() });
        render();
      } }))));
    }
    if (conflicts.length) blocks.push(h('div', { class: 'callout warning' }, icon('conflict'), h('div', { class: 'grow' }, `${conflicts.length} sync conflict${conflicts.length > 1 ? 's need' : ' needs'} your decision. Nothing has been overwritten.`), button('Review', { small: true, href: '#/conflicts' })));
    const interrupted = imports.filter((i) => i.status === 'in-progress');
    if (interrupted.length) blocks.push(h('div', { class: 'callout warning' }, icon('alert'), h('div', { class: 'grow' }, 'An import was interrupted. No partial cards were saved.'), button('Recover', { small: true, href: '#/recovery' })));
    if (local.get('axon-pending-review')) blocks.push(h('div', { class: 'callout warning' }, icon('alert'), h('div', { class: 'grow' }, 'A review could not be saved earlier. Your answer was kept.'), button('Retry', { small: true, href: '#/recovery' })));
    const reminderDays = store.global.backupReminderDays || 7;
    const lastSafe = Math.max(store.device.lastBackupAt || 0, store.device.sync?.lastSyncAt || 0);
    if (counts.cards >= 10 && reminderDays > 0 && Date.now() - lastSafe > reminderDays * 86400000) {
      blocks.push(h('div', { class: 'callout' }, icon('shield'), h('div', { class: 'grow' }, lastSafe ? `Last backup or sync: ${formatDate(lastSafe)}. Your data lives on this device — keep an independent copy.` : 'Your study data lives only on this device. Export a backup or set up sync so a lost or reset device doesn’t lose your progress.'), button('Back up', { small: true, href: '#/settings/data' })));
    }

    // Due hero
    const startBtn = button(total ? 'Start review' : 'Nothing due', { kind: 'primary large', iconName: 'play', disabled: !total, onclick: () => startDaily().catch(errorToast) });
    const hero = h('section', { class: 'panel', 'aria-labelledby': 'due-title' },
      h('div', { class: 'due-hero' },
        h('div', {}, h('div', { class: 'big', id: 'due-title', 'aria-label': `${total} cards to study today` }, String(total)), h('div', { class: 'muted small' }, 'to study today')),
        h('div', { class: 'grow stack' },
          h('div', { class: 'breakdown' },
            h('span', {}, h('b', {}, String(reviews)), ' reviews'),
            h('span', {}, h('b', {}, String(counts.learning)), ' learning'),
            h('span', {}, h('b', {}, String(newToday)), ' new'),
            counts.overdue ? h('span', {}, h('b', {}, String(counts.overdue)), ' overdue') : null),
          total ? h('div', { class: 'faint small' }, `About ${Math.max(1, Math.round(est.minutes))} min${est.provisional ? ' (provisional estimate — Axon will learn your pace)' : ''}`) : h('div', { class: 'faint small' }, 'You’re all caught up. Cram or drill if you want extra practice — it won’t change your schedule.')),
        h('div', { class: 'row' }, startBtn)));
    blocks.push(hero);

    // Catch-up
    const plan = catchUpPlan({ backlog: counts.overdue, dailyDue: Math.max(0, reviews - counts.overdue) });
    if (counts.overdue >= 40) {
      blocks.push(h('div', { class: 'callout' }, icon('refresh'), h('div', { class: 'grow' }, `${counts.overdue} cards are overdue. A catch-up session of ${Math.min(50, counts.overdue)} keeps things manageable; the rest keep their real due dates. At ~${plan.perDay}/day you’d be caught up in about ${plan.days} days.`), button('Catch up', { small: true, onclick: async () => {
        const s = await createSession({ mode: 'catchup', limit: 50 });
        app.navigate(`/study/session/${s.id}`);
      } })));
    }

    // KPIs
    blocks.push(h('div', { class: 'kpis' },
      kpi('Reviewed today', String(reviewedToday)),
      kpi('Streak', `${streak} ${streak === 1 ? 'day' : 'days'}`),
      kpi('Due tomorrow', String(fc[1]?.due ?? 0)),
      kpi('Cards', String(counts.cards), `${app.cache.decks.size} deck${app.cache.decks.size === 1 ? '' : 's'}`)));

    // Activity + forecast
    const cells = heatmapLevels(activity, { today: tctx.today, days: 7 * 18 });
    const heat = h('div', { class: 'heatmap', role: 'img', 'aria-label': `Study activity over the last 18 weeks; ${cells.filter((c) => c.count).length} active days` }, cells.map((c) => h('div', { class: `cell l${c.level}`, title: `${c.day}: ${c.count} retrieval${c.count === 1 ? '' : 's'}` })));
    const fcData = fc.slice(0, 8).map((d, i) => ({ label: i === 0 ? 'Today' : d.day, value: d.due, tick: i === 0 ? 'Today' : new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }) }));
    blocks.push(h('div', { class: 'grid-2' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-header' }, h('h3', {}, 'Activity'), h('a', { class: 'small', href: '#/stats' }, 'Statistics')), heat,
        h('div', { class: 'heat-legend', style: { marginTop: '8px' } }, 'Less', [0, 1, 2, 3, 4].map((l) => h('span', { class: `cell l${l}`, style: { background: `var(--heat-${l})` } })), 'More')),
      h('section', { class: 'panel' }, chartWithTable(barChart(fcData, { label: 'Reviews due over the next 8 days' }), dataTable(['Day', 'Due'], fcData.map((d) => [d.label, String(d.value)])), { title: 'Upcoming reviews' }))));

    // Decks
    const decks = [...app.cache.decks.values()].filter((d) => !d.archived);
    const lastStudied = new Map();
    for (const e of recent) if (e.type === 'review' || e.type === 'practice') lastStudied.set(e.deckId, Math.max(lastStudied.get(e.deckId) || 0, e.ts));
    decks.sort((a, b) => (lastStudied.get(b.id) || b.updatedAt || 0) - (lastStudied.get(a.id) || a.updatedAt || 0));
    blocks.push(h('section', { class: 'stack' }, h('div', { class: 'row between' }, h('h2', {}, 'Recent decks'), h('a', { href: '#/decks', class: 'small' }, 'All decks')), h('div', { class: 'deck-grid' }, decks.slice(0, 6).map((d) => deckCard(d, { lastStudied: lastStudied.get(d.id) })))));
    replace(body, blocks);
  };
  const off = app.onChange(render);
  await render();
  return { destroy: () => { destroyed = true; off(); } };
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

function onboarding() {
  return h('section', { class: 'hero', 'aria-labelledby': 'welcome' },
    h('h1', { id: 'welcome' }, 'Welcome to Axon'),
    h('p', {}, 'Type your answers. Axon checks them — including maths and chemistry notation — and uses how quickly and fluently you recall to schedule each card with FSRS. No Again/Hard/Good/Easy buttons needed.'),
    h('p', { class: 'small' }, 'Everything is stored on this device and works offline. Sync and backups are optional.'),
    h('div', { class: 'onboard-options' },
      h('button', { class: 'option-card', onclick: async () => {
        const name = await promptDialog({ title: 'New deck', label: 'Deck name', placeholder: 'e.g. Organic chemistry', confirmLabel: 'Create deck' });
        if (!name || !name.trim()) return;
        const deck = await store.createDeck({ name: name.trim() });
        await app.cache.load();
        app.navigate(`/deck/${deck.id}`);
      } }, icon('plus'), h('b', {}, 'Create a deck'), h('span', {}, 'Start empty and add cards one by one.')),
      h('a', { class: 'option-card', href: '#/import' }, icon('upload'), h('b', {}, 'Import cards'), h('span', {}, 'Paste notes, or load TXT, CSV, TSV, Anki or JSON — hundreds of cards at once.')),
      h('button', { class: 'option-card', onclick: async () => {
        const deck = await createSampleDeck();
        await app.cache.load();
        toast('Sample deck added');
        app.navigate(`/deck/${deck.id}`);
      } }, icon('sparkles'), h('b', {}, 'Try the tour deck'), h('span', {}, 'Eleven cards showing text, maths, chemistry, cloze and hints.'))),
    h('p', { class: 'faint small', style: { marginTop: '20px' } }, 'Tip: install Axon from your browser’s menu (“Add to Home Screen” / “Install app”) for a full-screen, offline app.'));
}

export { addDays };
