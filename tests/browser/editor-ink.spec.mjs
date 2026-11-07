// The regular card editor: ink pads on a touch device, text boxes on a mouse,
// and a visible way to delete a saved card.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, idbAll, assertNoErrors } from './harness.mjs';

const strokeOn = (page, nth) => page.evaluate((index) => {
  const c = [...document.querySelectorAll('.editor-ink-host .ink-canvas')].filter((el) => el.getBoundingClientRect().width > 0)[index];
  const r = c.getBoundingClientRect();
  const fire = (name, x, y) => c.dispatchEvent(new PointerEvent(name, {
    pointerType: 'pen', pointerId: 20 + index, clientX: r.left + x, clientY: r.top + y,
    pressure: name === 'pointerup' ? 0 : 0.7, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
  }));
  fire('pointerdown', 28, 36);
  fire('pointermove', 90, 48);
  fire('pointermove', 140, 30);
  fire('pointerup', 140, 30);
}, nth);

export const tests = [
  {
    name: 'a mouse gets the typed editor; a touch device gets ink pads that save a self-graded card and can be cleared and deleted',
    async run({ browser, url }) {
      const mouse = await newContext(browser);
      const mousePage = await openApp(mouse, url);
      await seedDeck(mousePage, { name: 'Chemistry Polyatomics', cards: [] });
      await mousePage.evaluate(() => { location.hash = '#/card/new'; });
      await mousePage.getByRole('button', { name: 'Add card' }).first().waitFor();
      assert.equal(await mousePage.locator('textarea').nth(0).isVisible(), true, 'keyboard users still get the front text box');
      assert.equal(await mousePage.locator('.editor-ink-host').first().isVisible(), false);
      await mouse.close();

      const ctx = await newContext(browser, { viewport: { width: 1024, height: 900 }, hasTouch: true });
      const page = await openApp(ctx, url);
      const deckId = await seedDeck(page, { name: 'Chemistry Polyatomics', cards: [] });
      await page.evaluate((id) => { location.hash = `#/card/new?deck=${id}`; }, deckId);
      await page.getByRole('button', { name: 'Add card' }).first().waitFor();
      const quick = await page.evaluate(() => {
        const row = document.querySelector('.editor-quick-add');
        const header = document.querySelector('.view-header .quick-add');
        const title = document.querySelector('.view-header h1');
        let anchor = row?.previousElementSibling;
        while (anchor?.hidden) anchor = anchor.previousElementSibling;
        const buttons = [...document.querySelectorAll('.quick-add-btn')];
        const headerBox = header.getBoundingClientRect();
        const titleBox = title.getBoundingClientRect();
        const primary = header.querySelector('.btn.primary');
        return {
          label: anchor?.querySelector('label')?.textContent || '',
          rowTexts: [...row.querySelectorAll('button')].map((b) => b.textContent),
          headerTexts: [...header.querySelectorAll('button')].map((b) => b.textContent),
          footerTexts: [...document.querySelectorAll('.editor-footer button')].map((b) => b.textContent),
          headerRight: headerBox.left + 8 >= titleBox.right || headerBox.top >= titleBox.bottom - 4,
          corner: primary.getBoundingClientRect().right >= headerBox.right - 2,
          minH: Math.min(...buttons.map((b) => b.getBoundingClientRect().height)),
          minW: Math.min(...buttons.map((b) => b.getBoundingClientRect().width)),
          disabled: buttons.every((b) => b.disabled),
          rowName: row.getAttribute('aria-label'),
        };
      });
      assert.equal(quick.label, 'Back', 'quick add sits on the Back field');
      assert.deepEqual(quick.rowTexts, ['Add & next', 'Add card']);
      assert.deepEqual(quick.headerTexts, ['Add card', 'Add & next']);
      assert.deepEqual(quick.footerTexts, ['Cancel', 'Add card', 'Add & next']);
      assert.equal(quick.headerRight, true, 'header actions stay at the top right');
      assert.equal(quick.corner, true, 'Add & next is the corner button');
      assert.equal(quick.rowName, 'Add this card');
      assert.ok(quick.minH >= 44, `touch height ${quick.minH}`);
      assert.ok(quick.minW >= 44, `touch width ${quick.minW}`);
      assert.equal(quick.disabled, true, 'an empty card cannot be saved yet');
      await page.locator('.editor-ink-host .ink-canvas').first().waitFor();
      assert.equal(await page.locator('.editor-ink-host').count(), 2);
      assert.equal(await page.locator('textarea').nth(0).isVisible(), false, 'the front text box is not where Scribble would steal the ink');
      assert.equal(await page.locator('textarea').nth(1).isVisible(), false);
      await page.getByRole('button', { name: 'Clear Front' }).waitFor();
      await page.getByRole('button', { name: 'Clear Back' }).waitFor();
      await page.getByRole('button', { name: 'Undo stroke' }).first().waitFor();
      await page.getByRole('button', { name: 'Redo stroke' }).first().waitFor();
      await strokeOn(page, 0);
      await page.locator('img[alt="Handwritten prompt"]').waitFor();
      await strokeOn(page, 1);
      await page.locator('img[alt="Handwritten answer"]').waitFor();
      await page.getByRole('button', { name: 'Add card' }).first().click();
      await page.getByText('Card added').waitFor();
      const [card] = await idbAll(page, 'cards');
      assert.match(card.front.join('\n'), /^!\[Handwritten prompt\]\(axon-media:/);
      assert.match(card.back.join('\n'), /^!\[Handwritten answer\]\(axon-media:/);
      await page.getByRole('row', { name: /Handwritten/ }).click();
      await page.getByRole('button', { name: 'Delete card' }).waitFor();
      await page.evaluate((id) => { location.hash = `#/deck/${id}`; }, deckId);
      await page.getByRole('button', { name: /Delete Handwritten/ }).waitFor();
      await page.getByRole('button', { name: /Delete Handwritten/ }).click();
      await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
      await page.getByText('Card deleted').waitFor();
      assert.equal((await idbAll(page, 'cards')).length, 0);

      await page.evaluate((id) => { location.hash = `#/card/new?deck=${id}`; }, deckId);
      await page.locator('.editor-ink-host').first().waitFor();
      await page.getByRole('button', { name: 'Back: Type' }).click();
      await page.locator('textarea').nth(1).waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('axon-editor-sides')).back), 'text');
      await page.reload();
      await page.locator('textarea').nth(1).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Cloze' }).click();
      assert.equal(await page.locator('.editor-ink-host').first().isVisible(), false, 'cloze stays a text card');
      assert.equal(await page.locator('textarea').nth(0).isVisible(), true);
      assert.equal(await page.evaluate(() => {
        const row = document.querySelector('.editor-quick-add');
        let anchor = row.previousElementSibling;
        while (anchor?.hidden) anchor = anchor.previousElementSibling;
        return anchor.querySelector('label')?.textContent || '';
      }), 'Extra (shown after answering)');
      await page.getByRole('button', { name: 'Image occlusion' }).click();
      assert.equal(await page.evaluate(() => {
        const row = document.querySelector('.editor-quick-add');
        const back = row.previousElementSibling;
        let anchor = back;
        while (anchor?.hidden) anchor = anchor.previousElementSibling;
        return back.hidden && anchor.classList.contains('editor-occlusion');
      }), true, 'occlusion quick add follows the image');
      await page.getByRole('button', { name: 'Cloze' }).click();
      await page.locator('textarea').nth(0).fill('ATP is made by {{c1::mitochondria}}');
      await page.waitForFunction(() => {
        const ready = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Add & next' && !b.disabled);
        return ready.length >= 2;
      });
      const before = (await idbAll(page, 'cards')).length;
      await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Add & next' && !b.disabled);
        buttons[0].click();
        buttons[1].click();
      });
      await page.waitForFunction(() => {
        const el = document.activeElement;
        return el?.tagName === 'TEXTAREA' && el.value === '' && (el.getAttribute('placeholder') || '').includes('Question');
      });
      assert.equal((await idbAll(page, 'cards')).length, before + 1, 'a second tap while saving does not add another card');
      await page.evaluate((id) => { location.hash = `#/card/new?deck=${id}&kind=basic`; }, deckId);
      await page.locator('.editor-ink-host').first().waitFor();
      await page.waitForTimeout(80);
      const active = await page.evaluate(() => document.activeElement?.tagName || 'BODY');
      assert.equal(active === 'TEXTAREA' || active === 'INPUT', false, 'an ink front does not open the keyboard');
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
