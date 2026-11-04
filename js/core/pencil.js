/**
 * Pure rules for creating cards with Apple Pencil. Drawings are images.
 * The typed answer is the only part Axon grades. No DOM.
 */

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

/**
 * Front and back markdown for one pencil card.
 * `answer` is the gradable text. Drawings are optional images and are
 * never treated as the answer. A prompt is required: typed text, a front
 * drawing, or both.
 */
export function composePencilCard({ prompt = '', answer = '', frontImage = null, backImage = null } = {}) {
  const typed = clean(answer);
  const promptText = clean(prompt);
  if (!typed) return { ok: false, error: 'Type the answer Axon should check. A drawing is not graded.', front: '', back: '', mediaIds: [] };
  if (!promptText && !frontImage) return { ok: false, error: 'Add a prompt: sketch it on the page, or type one.', front: '', back: '', mediaIds: [] };
  const frontParts = [];
  if (promptText) frontParts.push(promptText);
  if (frontImage?.id) frontParts.push(`![${frontImage.alt || 'Handwritten prompt'}](axon-media:${frontImage.id})`);
  const backParts = [typed];
  if (backImage?.id) backParts.push(`![${backImage.alt || 'Handwritten note'}](axon-media:${backImage.id})`);
  const mediaIds = [frontImage?.id, backImage?.id].filter(Boolean);
  return { ok: true, error: null, front: frontParts.join('\n\n'), back: backParts.join('\n\n'), mediaIds };
}
