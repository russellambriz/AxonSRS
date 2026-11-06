// Write Mode: fullscreen ink, edge chrome, and a return to the same strokes.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, startReview, assertNoErrors } from './harness.mjs';

const stroke = (page, { type = 'pen', id = 7, x = 30, y = 36 } = {}) => page.evaluate(({ type: t, id: pid, x: ox, y: oy }) => {
  const c = document.querySelector('.ink-canvas');
  const r = c.getBoundingClientRect();
  const fire = (name, dx, dy) => c.dispatchEvent(new PointerEvent(name, {
    pointerType: t, pointerId: pid, isPrimary: true, clientX: r.left + dx, clientY: r.top + dy,
    pressure: name === 'pointerup' ? 0 : 0.65, buttons: name === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
  }));
  fire('pointerdown', ox, oy);
  fire('pointermove', ox + 36, oy + 12);
  fire('pointerup', ox + 70, oy + 8);
}, { type, id, x, y });

export const tests = [
  {
    name: 'write mode keeps strokes and the undo stack, hides pen chrome, and restores the page',
    async run({ browser, url }) {
      const ctx = await newContext(browser, { viewport: { width: 1180, height: 820 }, hasTouch: true });
      const page = await openApp(ctx, url);
      await seedDeck(page, { cards: [['Capital of Peru', 'Lima']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write', exact: true }).click();
      await page.locator('.ink-canvas').waitFor();
      await page.waitForFunction(() => document.querySelector('.ink-canvas')?.width > 0);
      await stroke(page);
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '1');

      const kept = await page.evaluate(() => {
        const stage = document.querySelector('.study-stage');
        const filler = document.createElement('div');
        filler.dataset.writeFiller = '1';
        filler.style.cssText = 'height:1800px;flex:none';
        stage.append(filler);
        stage.scrollTop = 80;
        const pad = document.querySelector('.ink-pad');
        const before = pad.inkState();
        const input = document.querySelector('.answer-input');
        return {
          scroll: stage.scrollTop,
          strokes: before.strokes.length,
          history: before.history.length,
          redo: before.redo.length,
          x: before.strokes[0].pts[0].x,
          eraser: before.eraser,
          inputConnected: input.isConnected,
          inputHidden: getComputedStyle(input).display === 'none',
          touchAction: getComputedStyle(pad.querySelector('.ink-canvas')).touchAction,
        };
      });
      assert.equal(kept.strokes, 1);
      assert.equal(kept.history, 1);
      assert.equal(kept.inputConnected, true, 'the typed answer stays mounted');
      assert.equal(kept.inputHidden, true, 'ink mode keeps the typed answer hidden');
      assert.equal(kept.touchAction, 'none');

      await page.getByRole('button', { name: 'Write Mode', exact: true }).click();
      const layer = page.locator('dialog.write-overlay');
      await layer.waitFor();
      await page.waitForFunction(() => document.querySelector('dialog.write-overlay .ink-canvas')?.width > 0);
      const box = await layer.boundingBox();
      const vp = page.viewportSize();
      assert.ok(box.width >= vp.width - 2 && box.height >= vp.height - 2, `overlay ${box.width}×${box.height} should fill ${vp.width}×${vp.height}`);
      assert.match(await layer.locator('.write-prompt').innerText(), /Capital of Peru/);
      assert.equal(await layer.getAttribute('data-chrome'), 'shown');
      assert.equal(await layer.getAttribute('data-prompt'), 'shown');

      const mapping = await page.evaluate(async () => {
        const pad = document.querySelector('.ink-pad');
        const before = pad.inkState();
        const stroke0 = before.strokes[0];
        const pts = stroke0.pts;
        const point = pts[0];
        const history = before.history;
        const c = document.querySelector('dialog.write-overlay .ink-canvas');
        const o = document.querySelector('dialog.write-overlay .ink-overlay');
        const layer = document.querySelector('dialog.write-overlay');
        const r = c.getBoundingClientRect();
        const origP = PointerEvent.prototype.getPredictedEvents;
        PointerEvent.prototype.getPredictedEvents = function () {
          if (this.type !== 'pointermove' || this.buttons === 0) return [];
          return [new PointerEvent('pointermove', { pointerType: 'pen', clientX: r.left + 400, clientY: r.top + 40, pressure: 0.4, buttons: 1 })];
        };
        const fire = (name, type, buttons, dx, dy) => c.dispatchEvent(new PointerEvent(name, {
          pointerType: type, pointerId: type === 'pen' ? 21 : 22, clientX: r.left + dx, clientY: r.top + dy,
          pressure: name === 'pointerup' ? 0 : 0.7, buttons, bubbles: true, cancelable: true,
        }));
        fire('pointerdown', 'mouse', 1, 24, 30);
        const mouseChrome = layer.dataset.chrome;
        fire('pointerup', 'mouse', 0, 24, 30);
        fire('pointermove', 'pen', 0, 48, 40);
        const hover = pad.dataset.hover;
        const hoverInk = (() => {
          const ctx2 = o.getContext('2d');
          const { data } = ctx2.getImageData(0, 0, o.width, o.height);
          return data.some((v, i) => i % 4 === 3 && v > 0);
        })();
        fire('pointerdown', 'pen', 1, 48, 40);
        const down = layer.dataset.chrome;
        fire('pointermove', 'pen', 1, 90, 56);
        const wet = pad.dataset.predicted;
        const started = performance.now();
        fire('pointerup', 'pen', 0, 90, 56);
        const justUp = layer.dataset.chrome;
        const during = pad.inkState();
        const added = during.strokes[during.strokes.length - 1];
        during.view.zoom = 2;
        during.view.panX = 14;
        during.view.panY = -6;
        PointerEvent.prototype.getPredictedEvents = origP;
        const waited = await new Promise((resolve) => {
          const check = () => {
            if (layer.dataset.chrome === 'shown') resolve(performance.now() - started);
            else if (performance.now() - started > 1500) resolve(-1);
            else requestAnimationFrame(check);
          };
          check();
        });
        return {
          mouseChrome,
          hover,
          hoverInk,
          down,
          wet,
          justUp,
          waited,
          sameStroke: during.strokes[0] === stroke0 && during.strokes[0].pts === pts && during.strokes[0].pts[0] === point,
          sameHistory: during.history === history,
          history: during.history.length,
          strokes: during.strokes.length,
          x: added.pts[0].x,
          y: added.pts[0].y,
          far: added.pts.some((p) => p.x > 300),
        };
      });
      assert.equal(mapping.mouseChrome, 'shown', 'a mouse does not hide the chrome');
      assert.equal(mapping.hover, '1');
      assert.equal(mapping.hoverInk, true, 'the hover nib uses the same canvas');
      assert.equal(mapping.down, 'hidden');
      assert.equal(mapping.justUp, 'hidden', 'chrome stays hidden until the lift delay');
      assert.equal(mapping.wet, '1', 'the predicted tail is the wet layer');
      assert.equal(mapping.far, false, 'the predicted tail is not stored');
      assert.ok(mapping.waited >= 160, `chrome returned in ${mapping.waited}ms`);
      assert.equal(mapping.sameStroke, true);
      assert.equal(mapping.sameHistory, true);
      assert.equal(mapping.history, 3, 'the new strokes joined the same undo stack');
      assert.ok(Math.abs(mapping.x - 48) < 0.6, `pen x ${mapping.x}`);
      assert.ok(Math.abs(mapping.y - 40) < 0.6, `pen y ${mapping.y}`);
      await page.waitForFunction(() => document.querySelector('dialog.write-overlay')?.dataset.prompt === 'collapsed', null, { timeout: 2500 });
      await page.getByRole('button', { name: 'Show the question' }).click();
      assert.equal(await layer.getAttribute('data-prompt'), 'shown');

      const palm = await page.evaluate(() => {
        const c = document.querySelector('dialog.write-overlay .ink-canvas');
        const before = c.dataset.strokes;
        const r = c.getBoundingClientRect();
        c.dispatchEvent(new PointerEvent('pointerdown', {
          pointerType: 'touch', pointerId: 30, clientX: r.left + 16, clientY: r.top + 16,
          pressure: 0.5, buttons: 1, width: 80, height: 80, bubbles: true, cancelable: true,
        }));
        c.dispatchEvent(new PointerEvent('pointerup', {
          pointerType: 'touch', pointerId: 30, clientX: r.left + 20, clientY: r.top + 20, buttons: 0, bubbles: true,
        }));
        return { before, after: c.dataset.strokes };
      });
      assert.equal(palm.after, palm.before, 'a palm still does not draw');

      await page.keyboard.press('Escape');
      await layer.waitFor({ state: 'detached' });
      const restored = await page.evaluate(() => {
        const pad = document.querySelector('.composer .ink-pad');
        const stage = document.querySelector('.study-stage');
        const state = pad.inkState();
        return {
          inComposer: !!pad,
          writing: state.writing,
          strokes: state.strokes.length,
          history: state.history.length,
          zoom: state.view.zoom,
          panX: state.view.panX,
          panY: state.view.panY,
          scroll: stage.scrollTop,
          x: state.strokes[0].pts[0].x,
        };
      });
      assert.equal(restored.inComposer, true);
      assert.equal(restored.writing, false);
      assert.equal(restored.strokes, mapping.strokes);
      assert.equal(restored.history, mapping.history);
      assert.equal(restored.zoom, 1);
      assert.equal(restored.panX, 0);
      assert.equal(restored.panY, 0);
      assert.equal(kept.scroll, 80, 'the study stage can scroll');
      assert.equal(restored.scroll, kept.scroll);
      assert.equal(restored.x, kept.x, 'the first point was not rewritten');
      await page.getByRole('button', { name: 'Undo stroke' }).click();
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), String(mapping.strokes - 1));
      await page.getByRole('button', { name: 'Undo stroke' }).click();
      await page.getByRole('button', { name: 'Undo stroke' }).click();
      assert.equal(await page.getAttribute('.ink-canvas', 'data-strokes'), '0');
      assert.equal(await page.locator('.answer-input').count(), 1);
      assertNoErrors(page);
      await ctx.close();
    },
  },
  {
    name: 'reduced motion snaps the chrome, and the control is on for study, pencil and the editor until turned off',
    async run({ browser, url }) {
      const reduced = await newContext(browser, { viewport: { width: 1100, height: 800 }, hasTouch: true, reducedMotion: 'reduce' });
      const page = await openApp(reduced, url);
      await seedDeck(page, { cards: [['Snap', 'now']] });
      await startReview(page);
      await page.getByRole('button', { name: 'Write', exact: true }).click();
      await page.locator('.ink-canvas').waitFor();
      await page.getByRole('button', { name: 'Write Mode', exact: true }).click();
      await page.locator('dialog.write-overlay').waitFor();
      await page.waitForFunction(() => document.querySelector('dialog.write-overlay .ink-canvas')?.width > 0);
      const snap = await page.evaluate(() => {
        const c = document.querySelector('dialog.write-overlay .ink-canvas');
        const r = c.getBoundingClientRect();
        const fire = (name, buttons) => c.dispatchEvent(new PointerEvent(name, {
          pointerType: 'pen', pointerId: 9, clientX: r.left + 32, clientY: r.top + 32,
          pressure: 0.5, buttons, bubbles: true, cancelable: true,
        }));
        fire('pointerdown', 1);
        const down = document.querySelector('dialog.write-overlay').dataset.chrome;
        fire('pointerup', 0);
        return { down, up: document.querySelector('dialog.write-overlay').dataset.chrome };
      });
      assert.equal(snap.down, 'hidden');
      assert.equal(snap.up, 'shown', 'reduced motion shows the chrome on lift');
      await page.locator('dialog.write-overlay').getByRole('button', { name: 'Done', exact: true }).click();
      await page.locator('dialog.write-overlay').waitFor({ state: 'detached' });
      await reduced.close();

      const ctx = await newContext(browser, { viewport: { width: 1366, height: 1024 }, hasTouch: true });
      const studio = await openApp(ctx, url);
      await studio.evaluate(() => { location.hash = '#/settings/study'; });
      const toggle = studio.getByRole('switch', { name: 'Write Mode control' });
      await toggle.waitFor();
      assert.equal(await toggle.isChecked(), true);
      const deckId = await seedDeck(studio, { name: 'Pencil pages', cards: [] });
      await studio.evaluate((id) => { location.hash = `#/pencil?deck=${id}`; }, deckId);
      await studio.getByRole('heading', { name: 'Create with Pencil' }).waitFor();
      await studio.waitForFunction(() => [...document.querySelectorAll('.pencil-paper .ink-canvas')].some((c) => c.width > 0));
      await stroke(studio, { id: 4, x: 40, y: 50 });
      const beforeWrite = await studio.evaluate(() => {
        const pad = document.querySelector('.pencil-paper .pad-front');
        const state = pad.inkState();
        return { strokes: state.strokes.length, history: state.history.length, points: state.strokes[0]?.pts.length || 0 };
      });
      assert.equal(beforeWrite.history, 1);
      await studio.getByRole('button', { name: 'Write Mode', exact: true }).click();
      await studio.locator('dialog.write-overlay.write-paper').waitFor();
      const pencilSame = await studio.evaluate(() => {
        const pad = document.querySelector('dialog.write-overlay .ink-pad');
        const state = pad.inkState();
        const stroke0 = state.strokes[0];
        const history = state.history;
        return { strokes: state.strokes.length, history: history.length, color: stroke0.color };
      });
      assert.equal(pencilSame.strokes, 1);
      assert.equal(pencilSame.history, 1);
      await studio.locator('dialog.write-overlay').getByRole('button', { name: 'Undo stroke' }).click();
      assert.equal(await studio.evaluate(() => document.querySelector('dialog.write-overlay .ink-canvas')?.dataset.strokes), '0');
      await studio.locator('dialog.write-overlay').getByRole('button', { name: 'Redo stroke' }).click();
      assert.equal(await studio.evaluate(() => document.querySelector('dialog.write-overlay .ink-canvas')?.dataset.strokes), '1');
      await studio.keyboard.press('Escape');
      await studio.locator('dialog.write-overlay').waitFor({ state: 'detached' });
      const back = await studio.evaluate(() => {
        const pad = document.querySelector('.pencil-paper .pad-front');
        const state = pad.inkState();
        return { strokes: state.strokes.length, history: state.history.length, writing: state.writing, inPaper: !!pad.closest('.pencil-paper') };
      });
      assert.equal(back.inPaper, true);
      assert.equal(back.writing, false);
      assert.equal(back.strokes, 1);
      assert.equal(back.history, 1);
      await studio.getByRole('button', { name: 'Clear', exact: true }).click();

      await studio.evaluate((id) => { location.hash = `#/card/new?deck=${id}`; }, deckId);
      await studio.locator('.editor-ink-host .write-mode-btn').first().waitFor();
      assert.equal(await studio.getByRole('button', { name: 'Write Mode', exact: true }).count(), 2);

      await studio.evaluate(() => { location.hash = '#/settings/study'; });
      await toggle.waitFor();
      await toggle.evaluate((el) => el.click());
      assert.equal(await studio.evaluate(() => localStorage.getItem('axon-write-mode-control')), '0');
      await studio.evaluate((id) => { location.hash = `#/pencil?deck=${id}`; }, deckId);
      await studio.getByRole('heading', { name: 'Create with Pencil' }).waitFor();
      assert.equal(await studio.getByRole('button', { name: 'Write Mode', exact: true }).count(), 0);
      assertNoErrors(studio);
      await ctx.close();
    },
  },
];
