/**
 * Pure rules for creating cards with Apple Pencil. A typed answer is
 * matched as text. A side that is only ink is the card itself and is
 * self-graded. No DOM.
 */

import { plainText } from './text.js';

export const PAPER = '#f6f3ee';

/** Ink colours chosen for the light paper sheet, so they read in either theme. */
export const PEN_COLORS = [
  { id: 'graphite', label: 'Graphite', hex: '#1c1917' },
  { id: 'blue', label: 'Blue', hex: '#1d4ed8' },
  { id: 'green', label: 'Green', hex: '#047857' },
  { id: 'amber', label: 'Amber', hex: '#b45309' },
  { id: 'rose', label: 'Rose', hex: '#be123c' },
];

/** Multipliers on the pressure width. Fine < medium < broad. */
export const PEN_WIDTHS = [
  { id: 'fine', label: 'Fine', scale: 0.62 },
  { id: 'medium', label: 'Medium', scale: 1 },
  { id: 'broad', label: 'Broad', scale: 1.75 },
];

export const PENCIL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
export const PENCIL_MAX_IMAGE = 5 * 1024 * 1024;

export function penColor(id) {
  return PEN_COLORS.find((c) => c.id === id) || PEN_COLORS[0];
}

export function penWidth(id) {
  return PEN_WIDTHS.find((w) => w.id === id) || PEN_WIDTHS[1];
}

/**
 * Same limits as a pasted or uploaded card image. Returns a message, or
 * null when the file may be stored.
 */
export function imageRejectReason({ type = '', size = 0 } = {}) {
  if (!PENCIL_IMAGE_TYPES.includes(type)) return `Unsupported image type ${type || 'unknown'} (use PNG, JPEG, GIF, WebP or AVIF; SVG is not allowed for safety)`;
  if (size > PENCIL_MAX_IMAGE) return `Image is ${(size / 1048576).toFixed(1)} MB; the limit is 5 MB`;
  return null;
}

function clean(text) {
  return String(text || '').replace(/\s+$/g, '').replace(/^\s+/g, '');
}

const IMAGE_MD = /!\[[^\]]*\]\([^)]*\)/g;

/**
 * True when this side is handwriting and nothing else: at least one image,
 * and no text outside those images. Alt text inside the image does not count.
 */
export function isInkAnswer(markdown) {
  const raw = String(markdown || '');
  if (!/!\[[^\]]*\]\([^)]*\)/.test(raw)) return false;
  return plainText(raw.replace(IMAGE_MD, ' ')) === '';
}

const SIDE_IMAGE = /!\[([^\]]*)\]\(axon-media:([^)\s]+)\)/g;

/**
 * Split one side of a pencil card into typed text and its ink images.
 * Image alt text is not part of the typed text.
 */
export function splitPencilSide(markdown) {
  const images = [];
  const text = String(markdown || '').replace(SIDE_IMAGE, (_, alt, id) => {
    images.push({ alt, id });
    return '\n';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, images };
}

/** Every non-empty alternative on this side is ink, so nothing is matched. */
export function isInkSide(parts) {
  const list = (Array.isArray(parts) ? parts : [parts]).map((s) => String(s ?? '').trim()).filter(Boolean);
  return list.length > 0 && list.every((part) => isInkAnswer(part));
}

/**
 * Which editor control a Basic side starts in.
 * What is already on the card wins, so opening a saved card never hides its
 * text behind an empty pad or its ink behind the raw image markdown.
 * A blank side uses the choice remembered on this device, then the device:
 * a touch screen (where a pencil can be used) starts on ink; a mouse-only
 * computer stays on the text box.
 */
export function chooseSideMode({ stored = null, touch = false, inkContent = false, hasText = false } = {}) {
  if (inkContent) return 'ink';
  if (hasText) return 'text';
  if (stored === 'ink' || stored === 'text') return stored;
  return touch ? 'ink' : 'text';
}

function fail(error) {
  return { ok: false, error, front: '', back: '', mediaIds: [], handwritten: false };
}

/**
 * Front and back markdown for one pencil card.
 * `handwritten` prints the back drawing as the answer and stores no typed
 * answer. Otherwise `answer` is required and is what gets matched; a back
 * drawing is only a note beside that text.
 */
export function composePencilCard({ prompt = '', answer = '', frontImage = null, backImage = null, handwritten = false } = {}) {
  const typed = clean(answer);
  const promptText = clean(prompt);
  const frontParts = [];
  if (promptText) frontParts.push(promptText);
  if (frontImage?.id) frontParts.push(`![${frontImage.alt || 'Handwritten prompt'}](axon-media:${frontImage.id})`);
  const mediaIds = [frontImage?.id, backImage?.id].filter(Boolean);
  if (!promptText && !frontImage?.id) return fail('Add a prompt: sketch it on the page, or type one.');
  if (handwritten) {
    if (!backImage?.id) return fail('Write the answer on the back. That handwriting is the card.');
    return {
      ok: true,
      error: null,
      front: frontParts.join('\n\n'),
      back: `![${backImage.alt || 'Handwritten answer'}](axon-media:${backImage.id})`,
      mediaIds,
      handwritten: true,
    };
  }
  if (!typed) return fail('Type the answer Axon should check. A drawing is not graded.');
  const backParts = [typed];
  if (backImage?.id) backParts.push(`![${backImage.alt || 'Handwritten note'}](axon-media:${backImage.id})`);
  return { ok: true, error: null, front: frontParts.join('\n\n'), back: backParts.join('\n\n'), mediaIds, handwritten: false };
}
