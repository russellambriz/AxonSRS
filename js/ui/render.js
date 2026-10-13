/**
 * Safe rich-content rendering: Markdown (marked) → sanitised HTML
 * (DOMPurify) → KaTeX math (mhchem for chemistry) → local media.
 *
 * Order matters for safety:
 *  1. Math segments are lifted out and replaced with inert tokens so
 *     Markdown cannot mangle them.
 *  2. Markdown is rendered and the result sanitised with a strict
 *     allow-list (no scripts, no event handlers, no style attributes, no
 *     javascript:/data: URLs, no SVG/MathML input from users).
 *  3. Tokens are replaced with KaTeX output, which KaTeX generates itself
 *     with trust:false (no \href, \url, \includegraphics, \html*), and with
 *     expansion/size limits.
 *  4. axon-media: image references are resolved to local object URLs.
 *     Remote images are blocked unless the user allows them.
 */

import { marked } from '../../vendor/marked/marked.esm.js';
import DOMPurify from '../../vendor/dompurify/purify.es.mjs';
import { previewLatex } from '../core/match/math.js';
import { toMhchem } from '../core/match/chem.js';
import { h } from './dom.js';

let katex = null;
const katexReady = import('../../vendor/katex/katex.mjs')
  .then(async (m) => {
    katex = m.default;
    await import('../../vendor/katex/contrib/mhchem.mjs');
    return katex;
  })
  .catch((err) => {
    console.warn('KaTeX failed to load', err);
    return null;
  });

export function ensureMath() {
  return katexReady;
}

const KATEX_OPTIONS = Object.freeze({ throwOnError: false, strict: 'ignore', trust: false, maxSize: 20, maxExpand: 500, output: 'htmlAndMathml' });

marked.use({ gfm: true, breaks: true, async: false });

const ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'span', 'sub', 'sup', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'mark', 'kbd'];
const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'class', 'colspan', 'rowspan', 'start'];
const ALLOWED_CLASSES = new Set(['cloze-blank', 'cloze-answer']);

let allowRemoteImages = false;
export function setAllowRemoteImages(v) {
  allowRemoteImages = !!v;
  cache.clear();
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (!/^(https?:|mailto:|#)/i.test(href)) node.removeAttribute('href');
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (src.startsWith('axon-media:')) {
      node.setAttribute('data-media', src.slice('axon-media:'.length));
      node.removeAttribute('src');
      node.setAttribute('loading', 'lazy');
    } else if (!/^https:/i.test(src) || !allowRemoteImages) {
      node.setAttribute('data-blocked', src);
      node.removeAttribute('src');
    }
  }
  if (node.hasAttribute && node.hasAttribute('class')) {
    const kept = node.getAttribute('class').split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c));
    if (kept.length) node.setAttribute('class', kept.join(' '));
    else node.removeAttribute('class');
  }
});

function sanitize(html) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|axon-media:|#)/i,
    ALLOW_DATA_ATTR: false,
    USE_PROFILES: { html: true },
  });
}

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)|\\ce\{((?:[^{}]|\{[^{}]*\})*)\}/g;

function extractMath(text) {
  const segments = [];
  const out = text.replace(MATH_RE, (m, d1, d2, i1, i2, ce) => {
    let tex;
    let display = false;
    if (d1 != null || d2 != null) {
      tex = d1 ?? d2;
      display = true;
    } else if (ce != null) tex = `\\ce{${ce}}`;
    else tex = i1 ?? i2;
    segments.push({ tex, display, source: m });
    return `AXONMATH${segments.length - 1}X`;
  });
  return { text: out, segments };
}

function katexHtml(tex, display) {
  if (!katex) return `<code class="math-pending">${escape(tex)}</code>`;
  try {
    return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
  } catch (err) {
    return `<span class="math-error" title="${escape(err.message)}">${escape(tex)}</span>`;
  }
}

function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const cache = new Map();
const CACHE_LIMIT = 600;

/**
 * Markdown + math → sanitised HTML string (safe to assign to innerHTML).
 */
export function markdownToHtml(text, { inline = false } = {}) {
  const key = `${inline ? 'i' : 'b'}|${katex ? 'k' : 'n'}|${text}`;
  const hit = cache.get(key);
  if (hit != null) return hit;
  const { text: withTokens, segments } = extractMath(String(text ?? ''));
  const raw = inline ? marked.parseInline(withTokens) : marked.parse(withTokens);
  let html = sanitize(raw);
  html = html.replace(/AXONMATH(\d+)X/g, (_, i) => {
    const seg = segments[Number(i)];
    return seg ? katexHtml(seg.tex, seg.display) : '';
  });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}

export function hasMath(text) {
  MATH_RE.lastIndex = 0;
  return MATH_RE.test(String(text || ''));
}

/** Render into an element and resolve media; resolves when images are decoded. */
export async function renderInto(el, text, { inline = false, media = null } = {}) {
  if (hasMath(text)) await katexReady;
  el.innerHTML = markdownToHtml(text, { inline });
  await resolveMedia(el, media);
  return el;
}

export function richBlock(text, opts = {}) {
  const el = h(opts.inline ? 'span' : 'div', { class: ['rich', opts.class] });
  el.innerHTML = markdownToHtml(text, opts);
  if (!katex && hasMath(text)) katexReady.then(() => { el.innerHTML = markdownToHtml(text, opts); resolveMedia(el, opts.media); });
  resolveMedia(el, opts.media);
  return el;
}

const mediaUrls = new Map();

/** media: async (id) => Blob|null */
export async function resolveMedia(root, media) {
  const imgs = [...root.querySelectorAll('img[data-media]')];
  const blocked = [...root.querySelectorAll('img[data-blocked]')];
  for (const img of blocked) {
    const span = h('span', { class: 'blocked-media', title: img.dataset.blocked }, img.alt ? `Image: ${img.alt} (remote image blocked)` : 'Remote image blocked');
    img.replaceWith(span);
  }
  if (!media) return;
  await Promise.all(imgs.map(async (img) => {
    const id = img.dataset.media;
    let url = mediaUrls.get(id);
    if (!url) {
      const blob = await media(id);
      if (!blob) {
        img.replaceWith(h('span', { class: 'blocked-media' }, `Missing image (${id.slice(0, 18)}…)`));
        return;
      }
      url = URL.createObjectURL(blob);
      mediaUrls.set(id, url);
    }
    img.src = url;
    try {
      await img.decode();
    } catch {
      /* decode errors are non-fatal */
    }
  }));
}

export async function mediaUrl(id, media) {
  if (mediaUrls.has(id)) return mediaUrls.get(id);
  const blob = await media(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  mediaUrls.set(id, url);
  return url;
}

/** Render an expected answer according to the card's answer mode. */
export function answerHtml(answer, mode) {
  if (mode === 'math') {
    if (hasMath(answer)) return markdownToHtml(answer, { inline: true });
    const p = previewLatex(answer);
    if (p.ok && katex) return katexHtml(p.latex, false);
  }
  if (mode === 'chem' && katex) {
    if (hasMath(answer)) return markdownToHtml(answer, { inline: true });
    return katexHtml(`\\ce{${toMhchem(answer)}}`, false);
  }
  return markdownToHtml(answer, { inline: true });
}

/** Live preview of what the learner is typing (math/chem modes). */
export function livePreviewHtml(input, mode) {
  if (!input.trim() || !katex) return { html: '', error: null };
  if (mode === 'math') {
    const p = previewLatex(input);
    if (!p.ok) return { html: '', error: p.error };
    return { html: katexHtml(p.latex, false), error: null };
  }
  if (mode === 'chem') return { html: katexHtml(`\\ce{${toMhchem(input)}}`, false), error: null };
  return { html: '', error: null };
}

export { katexReady };
