// Safe rendering of user content: the sanitiser allow-list, Markdown in
// answers, code that contains dollar signs, prompts with "|", and local
// images in the study feedback.
import assert from 'node:assert/strict';
import { newContext, openApp, seedDeck, inApp, startReview, answer, assertNoErrors } from './harness.mjs';

function render(page, cases) {
  return page.evaluate(async (list) => {
    const r = await import(new URL('./js/ui/render.js', location.href).href);
    await r.ensureMath();
    return list.map(([text, mode]) => (mode ? r.answerHtml(text, mode) : r.markdownToHtml(text)));
  }, cases);
}

export const tests = [
  {
    name: 'card HTML is limited to the allow-list: no forms, inputs, inline styles, video or srcset',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      const [form, styled, media, script, link] = await render(page, [
        ['<form action="https://evil.example"><input name="p"><button>Go</button></form>'],
        ['<b style="position:fixed;inset:0">x</b><style>body{display:none}</style>'],
        ['<video src="https://x.example/v.mp4"></video><audio src="https://x.example/a.mp3"></audio><img srcset="https://x.example/a.png 1x" alt="pic">'],
        ['<img src=x onerror="alert(1)"><script>alert(1)</script><svg onload="alert(1)"></svg>'],
        ['[ok](https://example.com) [bad](javascript:alert(1))'],
      ]);
      for (const bad of ['<form', '<input', '<button', 'style=', '<style', '<video', '<audio', 'srcset', 'onerror', '<script', '<svg', 'javascript:']) {
        assert.equal([form, styled, media, script, link].join('').includes(bad), false, `${bad} removed`);
      }
      assert.match(link, /href="https:\/\/example\.com"[^>]*rel="noopener noreferrer nofollow"/);
      await ctx.close();
    },
  },
  {
    name: 'Markdown: list numbering, tables, literal $ inside code, block Markdown in multi-line answers',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      const [ol, table, fenced, inline, multi, single] = await render(page, [
        ['3. third\n4. fourth'],
        ['| a | b |\n|---|---|\n| 1 | 2 |'],
        ['```\ncp $HOME/$USER .\n```'],
        ['run `echo $x$` then $y$'],
        ['- first\n- second', 'text'],
        ['1. e4', 'text'],
      ]);
      assert.match(ol, /<ol start="3">/);
      assert.match(table, /<table>[\s\S]*<td>1<\/td>/);
      assert.match(fenced, /<code>cp \$HOME\/\$USER \.\n<\/code>/, 'no maths inside a code block');
      assert.match(inline, /<code>echo \$x\$<\/code>/);
      assert.match(inline, /class="katex"/, 'maths outside code still renders');
      assert.match(multi, /<ul>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ul>/);
      assert.equal(single.includes('<ol'), false, 'a one-line answer stays literal');
      await ctx.close();
    },
  },
  {
    name: 'a "|" in a prompt is shown, and images in the answer appear in the feedback',
    async run({ browser, url }) {
      const ctx = await newContext(browser);
      const page = await openApp(ctx, url);
      const mediaId = await inApp(page, async ({ store }) => {
        const c = document.createElement('canvas');
        c.width = 12;
        c.height = 12;
        c.getContext('2d').fillRect(0, 0, 12, 12);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        return (await store.putMedia(blob, { name: 'sq.png' })).id;
      });
      await seedDeck(page, { cards: [['What is P(A|B) called?', `conditional probability\n\n![diagram](axon-media:${mediaId})`]] });
      await startReview(page);
      const prompt = await page.textContent('#study-prompt');
      assert.match(prompt, /P\(A \| B\) called\?/, 'the whole question is shown');
      assert.equal(await answer(page, 'conditional probability'), 'feedback');
      await page.waitForFunction(() => {
        const img = document.querySelector('.feedback .answer img');
        return img && img.getAttribute('src')?.startsWith('blob:') && img.naturalWidth > 0;
      });
      assertNoErrors(page);
      await ctx.close();
    },
  },
];
