// Spec 10, 12.19, 17.22–17.24: responsive layout at desktop, tablet and
// phone sizes (Chromium emulation — not real devices), no horizontal
// scrolling, accessible names, touch-target sizes, dark mode.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SHOTS, newContext, openApp, waitReady, waitPhase, startReview, answer, assertNoErrors } from './harness.mjs';

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  tablet: { viewport: { width: 834, height: 1194 }, hasTouch: true, deviceScaleFactor: 2 },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
  'small-phone': { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
};

/** Problems on the current screen: overflow, unnamed controls, small targets. */
function audit(page, { touch }) {
  return page.evaluate((isTouch) => {
    const problems = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) {
      const wide = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('.table-wrap, .chart-scroll, .katex-display, pre, .scroll-x'));
      problems.push(`horizontal scroll ${doc.scrollWidth}px > ${window.innerWidth}px: ${wide.slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`).join(', ')}`);
    }
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('[hidden], [aria-hidden="true"], .visually-hidden');
    };
    const nameOf = (el) => {
      const t = (x) => (x || '').replace(/\s+/g, ' ').trim();
      if (el.getAttribute('aria-label')) return t(el.getAttribute('aria-label'));
      if (el.getAttribute('aria-labelledby')) return t(el.getAttribute('aria-labelledby').split(' ').map((id) => document.getElementById(id)?.textContent).join(' '));
      if (el.labels?.length) return t([...el.labels].map((l) => l.textContent).join(' '));
      if (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName)) return t(el.textContent) || t(el.title);
      return t(el.title) || t(el.placeholder);
    };
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=switch], [role=button], summary')) {
      if (!visible(el) && !(el.matches('input') && el.closest('label'))) continue;
      if (!nameOf(el)) problems.push(`unnamed ${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ').join('.')}` : ''}`);
    }
    if (isTouch) {
      for (const el of document.querySelectorAll('.bottom-nav a, .submit-btn, .answer-input, .composer .actions .btn, .btn.primary')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 40 || r.width < 40) problems.push(`small touch target ${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
      const input = document.querySelector('.answer-input');
      if (input && visible(input) && parseFloat(getComputedStyle(input).fontSize) < 16) problems.push('answer field font < 16px (iOS zooms on focus)');
    }
    return problems;
  }, touch);
}

async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((h) => location.hash === h && document.querySelector('#main .view, #main .study'), hash);
  await page.waitForTimeout(250);
}

export const tests = [
  {
    name: 'every main screen fits desktop, tablet and phone widths without horizontal scrolling or unnamed controls',
    async run({ browser, url, report }) {
      const all = {};
      for (const [name, opts] of Object.entries(VIEWPORTS)) {
        for (const scheme of name === 'phone' ? ['light', 'dark'] : ['light']) {
          const ctx = await newContext(browser, { ...opts, colorScheme: scheme });
          const page = await openApp(ctx, url);
          const shot = async (screen) => {
            const problems = await audit(page, { touch: !!opts.hasTouch });
            const path = join(SHOTS, `${name}${scheme === 'dark' ? '-dark' : ''}-${screen}.png`);
            if (screen.startsWith('study')) await page.screenshot({ path });
            else {
              // Playwright's fullPage capture drops touch emulation for the
              // rest of the context, so grow the viewport instead.
              const height = await page.evaluate(() => Math.min(6000, document.documentElement.scrollHeight));
              await page.setViewportSize({ width: opts.viewport.width, height: Math.max(opts.viewport.height, height) });
              await page.screenshot({ path });
              await page.setViewportSize(opts.viewport);
            }
            if (problems.length) all[`${name}${scheme === 'dark' ? '-dark' : ''} ${screen}`] = problems;
          };
          await shot('onboarding');
          await page.getByText('Try the tour deck').click();
          await page.waitForFunction(() => location.hash.startsWith('#/deck/'));
          await waitReady(page);
          await page.waitForTimeout(300);
          const deckHash = await page.evaluate(() => location.hash);
          await shot('deck');
          const screens = [['#/', 'home'], ['#/decks', 'decks'], ['#/cards', 'cards'], ['#/import', 'import'], ['#/stats', 'stats'], ['#/plans', 'plans'], ['#/settings/appearance', 'settings'], ['#/settings/data', 'settings-data'], ['#/settings/sync', 'settings-sync'], ['#/card/new', 'editor']];
          for (const [hash, screen] of screens) {
            if (scheme === 'dark' && !['#/', '#/stats', '#/cards'].includes(hash)) continue;
            await go(page, hash);
            await shot(screen);
          }
          await go(page, deckHash);
          assert.equal(await startReview(page), 'question');
          await page.waitForTimeout(300);
          await shot('study-question');
          await answer(page, 'Canberra');
          await page.waitForTimeout(300);
          await shot('study-feedback');
          assertNoErrors(page);
          await ctx.close();
        }
      }
      report('layout problems', Object.keys(all).length ? all : 'none');
      assert.deepEqual(all, {}, `layout problems:\n${JSON.stringify(all, null, 2)}`);
    },
  },
  {
    name: 'phone study screen: composer stays above the on-screen keyboard and the prompt stays visible',
    async run({ browser, url }) {
      const ctx = await newContext(browser, VIEWPORTS.phone);
      const page = await openApp(ctx, url);
      await page.getByText('Try the tour deck').click();
      await page.waitForFunction(() => location.hash.startsWith('#/deck/'));
      await startReview(page);
      // Simulate an on-screen keyboard by shrinking the visual viewport (the
      // layout viewport stays the same, as on iOS Safari).
      await page.setViewportSize({ width: 390, height: 844 - 300 });
      await page.waitForTimeout(300);
      const geo = await page.evaluate(() => {
        const comp = document.querySelector('.composer').getBoundingClientRect();
        const prompt = document.querySelector('#study-prompt').getBoundingClientRect();
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        return { compBottom: comp.bottom, compTop: comp.top, promptTop: prompt.top, promptBottom: prompt.bottom, vh };
      });
      assert.ok(geo.compBottom <= geo.vh + 1, `composer visible (${geo.compBottom} ≤ ${geo.vh})`);
      assert.ok(geo.promptBottom > 0 && geo.promptTop < geo.compTop, 'prompt not hidden behind the composer');
      await page.screenshot({ path: join(SHOTS, 'phone-study-keyboard.png') });
      await ctx.close();
    },
  },
];
