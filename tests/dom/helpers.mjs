/**
 * Helpers for driving the real study screen in jsdom (see env.mjs).
 * "Reload" here means: the old screen stops dead (no destroy, no unload
 * handlers, pending timers dropped), then a new screen is built from what
 * IndexedDB holds. Nothing carries over in memory except the app's data
 * cache, which a real reload also rebuilds from IndexedDB.
 */
import './env.mjs';

const { store } = await import('../../js/data/store.js');
const { app } = await import('../../js/app.js');
const model = await import('../../js/core/model.js');
const { createSession } = await import('../../js/study/session.js');
const studyView = await import('../../js/ui/views/study.js');

let booted = false;
export async function boot() {
  if (booted) return { store, app };
  await store.init();
  app.init();
  app.router = { navigate: (p) => { app.__navigated = p; } };
  booted = true;
  return { store, app };
}

export const SULFATE = ['Formula of the sulfate ion', 'SO4^2-', { answerMode: 'chem' }];

/** A fresh deck and a daily session on it. Returns the session id. */
export async function freshSession(cards = [SULFATE, ['Capital of France', 'Paris'], ['Largest planet', 'Jupiter']]) {
  await boot();
  localStorage.removeItem('axon-ink-mode'); // each test starts in Type mode
  const deck = await store.createDeck({ name: `Deck ${Math.random().toString(36).slice(2, 7)}` });
  await store.saveCards(cards.map(([front, back, extra]) => model.createCard({ deckId: deck.id, front, back, ...(extra || {}) }, store.deviceId)));
  await app.cache.load();
  const s = await createSession({ mode: 'daily', deckIds: [deck.id] });
  // Put the sulfate card first so every test answers the same question.
  const sulfateUnit = s.queue.find((id) => [app.cache.cards.get(app.cache.units.get(id)?.cardId)?.front].flat().join('') === SULFATE[0]);
  if (sulfateUnit) {
    const queue = [sulfateUnit, ...s.queue.filter((id) => id !== sulfateUnit)];
    await store.saveSession({ ...s, queue });
  }
  return s.id;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 4000, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

let current = null;
/** The screen now open: { outlet, handle, sessionId }. */
export const current_ = () => current;

/** Open the study screen for a session in a fresh outlet. */
export async function open(sessionId) {
  const main = document.getElementById('main');
  const outlet = document.createElement('div');
  main.replaceChildren(outlet);
  const handle = await studyView.view(outlet, { id: sessionId });
  current = { outlet, handle, sessionId };
  await waitFor(() => ['question', 'done', 'locked'].includes(phase()), { what: 'the question' });
  return current;
}

/** The page dies without running any unload code, then opens again. */
export async function reload() {
  const { handle, sessionId } = current;
  handle.kill();
  await app.cache.load();
  return open(sessionId);
}

/** Leave the screen the way the router does (destroy), e.g. a sidebar link. */
export function navigateAway() {
  current.handle.destroy();
  document.getElementById('main').replaceChildren();
}

export const q = (sel) => current.outlet.querySelector(sel);
export const qa = (sel) => [...current.outlet.querySelectorAll(sel)];
export const phase = () => current?.outlet.querySelector('.study')?.dataset.phase;
export const prompt = () => (q('#study-prompt')?.textContent || '').trim();
export const input = () => q('.answer-input');
export const inkMode = () => q('.study').classList.contains('ink-mode');
export const strokes = () => Number(q('.ink-canvas').dataset.strokes);
export const toolDisabled = (label) => button(label, '.ink-tools').disabled;
export const saveState = () => (q('.draft-state') && !q('.draft-state').hidden ? q('.draft-state').dataset.state : 'none');
export const pressed = () => qa('.confidence-pick .chip').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);

export function button(label, scope = '') {
  const b = qa(`${scope} button`).find((x) => x.textContent.trim() === label || x.getAttribute('aria-label') === label);
  if (!b) throw new Error(`No button "${label}"`);
  return b;
}

export function click(label, scope) {
  button(label, scope).click();
}

/** Type like a keyboard: one input event per character. */
export function type(text) {
  const el = input();
  el.focus();
  for (const ch of text) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: `Key${ch.toUpperCase()}`, bubbles: true }));
    el.value += ch;
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
  }
}

/** Replace the field's text in one edit (select all + type, or cut). */
export function setText(text) {
  const el = input();
  el.value = text;
  el.dispatchEvent(new InputEvent('input', { inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null, bubbles: true }));
}

/** One mouse stroke on the pad from (x, y) by (dx, dy). */
export function stroke({ x = 40, y = 40, dx = 0, dy = 60, id = 3, type: pointerType = 'mouse' } = {}) {
  const c = q('.ink-canvas');
  const fire = (name, px, py) => c.dispatchEvent(new PointerEvent(name, { pointerId: id, pointerType, clientX: px, clientY: py, buttons: name === 'pointerup' ? 0 : 1, button: 0, pressure: 0.5, bubbles: true, cancelable: true }));
  fire('pointerdown', x, y);
  for (let i = 1; i <= 4; i++) fire('pointermove', x + (dx * i) / 4, y + (dy * i) / 4);
  fire('pointerup', x + dx, y + dy);
}

export async function waitSaved(what = 'Saved') {
  await waitFor(() => saveState() === 'saved', { what });
}

export async function storedSession(id = current.sessionId) {
  return store.getSession(id);
}

export { store, app, model };
