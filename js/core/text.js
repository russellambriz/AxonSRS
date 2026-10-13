/**
 * Text normalisation helpers used by matching, deduplication and import.
 */

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const SPACES = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/** Characters that look different but mean the same in ordinary prose. */
const PROSE_EQUIVALENTS = [
  [/[‘’‚‛′´`]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−﹣－]/g, '-'],
  [/…/g, '...'],
];

export function collapseWhitespace(text) {
  return String(text).replace(ZERO_WIDTH, '').replace(SPACES, ' ').trim();
}

/** NFC + invisible characters removed + whitespace collapsed. */
export function basicNormalize(text) {
  return collapseWhitespace(String(text).normalize('NFC'));
}

export function normalizeProsePunctuation(text) {
  let out = text;
  for (const [re, rep] of PROSE_EQUIVALENTS) out = out.replace(re, rep);
  return out;
}

export function stripDiacritics(text) {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
}

export function hasDiacritics(text) {
  return /\p{M}/u.test(text.normalize('NFD'));
}

/**
 * Remove Markdown emphasis and math delimiters so a stored answer such as
 * "**Paris**" or "$x^2$" compares against what a user would type.
 * This is for comparison only; display keeps the original.
 */
export function stripFormatting(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\$\$([\s\S]+?)\$\$/g, '$1')
    .replace(/\$([^$\n]+?)\$/g, '$1')
    .replace(/\\\(([\s\S]+?)\\\)/g, '$1')
    .replace(/\\\[([\s\S]+?)\\\]/g, '$1');
}

/** Plain-text approximation of Markdown for previews, TTS and dedupe keys. */
export function plainText(markdown) {
  return collapseWhitespace(stripFormatting(markdown).replace(/<[^>]+>/g, ' '));
}

/** Key used for duplicate detection: case-folded, formatting-free. */
export function dedupeKey(text) {
  return normalizeProsePunctuation(basicNormalize(stripFormatting(text))).toLocaleLowerCase();
}

/** Count user-perceived characters (grapheme clusters). */
export function graphemeLength(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++;
    return n;
  }
  return [...text].length;
}

export function wordCount(text) {
  const t = collapseWhitespace(text);
  if (!t) return 0;
  return t.split(' ').length;
}

/**
 * Effort-weighted answer length. Symbols that need shifted keys, a
 * toolbar or a long-press cost more than letters, so typing speed is
 * normalised by effort rather than raw character count.
 */
export function typingEffort(text) {
  let effort = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch) && ch.charCodeAt(0) < 128) effort += 1;
    else if (ch === ' ') effort += 0.5;
    else if (/[\^()/*+\-=_.,]/.test(ch)) effort += 1.5;
    else if (/[\p{L}\p{N}]/u.test(ch)) effort += 1.5;
    else effort += 2;
  }
  return effort;
}
