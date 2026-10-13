/**
 * Record shapes, defaults and derived study units.
 *
 * A *card* (note) holds content. A *study unit* is one independently
 * scheduled thing to recall: a direction of a basic card, one cloze
 * number, or one image-occlusion mask. Unit ids are deterministic
 * (`${cardId}:${key}`) so every device derives the same ids.
 */

import { RECORD_VERSION } from '../config.js';
import { uuid, hashHex, stableStringify } from './util.js';
import { parseCloze, clozePrompt, clozeReveal, clozeAnswerGroups, clozeInstruction, clozeFilled, hasCloze } from './cloze.js';
import { dedupeKey, plainText, collapseWhitespace } from './text.js';
import { decodeAnswers } from './aliases.js';

export const TASK_TYPES = Object.freeze(['recall', 'calculation', 'multistep']);
export const TASK_TYPE_LABELS = Object.freeze({ recall: 'Recall', calculation: 'Calculation', multistep: 'Multi-step reasoning' });
export const ANSWER_MODES = Object.freeze(['text', 'math', 'chem']);
export const ANSWER_MODE_LABELS = Object.freeze({ text: 'Plain text', math: 'Mathematics', chem: 'Chemistry' });
export const DIRECTIONS = Object.freeze(['forward', 'reverse', 'both']);

export const DEFAULT_DECK_SETTINGS = Object.freeze({
  direction: 'forward',
  newPerDay: 20,
  reviewsPerDay: 9999,
  desiredRetention: null, // null → use global setting
  answerMode: 'text',
  taskType: 'recall',
  caseSensitive: false,
  typoTolerance: 'cautious',
  accentPolicy: 'typo',
  mathEquivalence: 'notation',
  siblingSpacing: 'spread', // 'spread' | 'nextDay' | 'off'
  siblingGap: 4,
  newOrder: 'mixed', // 'mixed' | 'after' | 'before'
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  leechThreshold: 4,
  leechAction: 'flag', // 'flag' | 'suspend'
  autoAdvance: null, // null → global
});

export function createDeck(fields = {}, deviceId = 'local') {
  const now = Date.now();
  return {
    id: fields.id || uuid(),
    name: (fields.name || 'Untitled deck').trim(),
    description: fields.description || '',
    color: fields.color || pickDeckColor(fields.name || ''),
    group: fields.group || '',
    settings: { ...DEFAULT_DECK_SETTINGS, ...(fields.settings || {}) },
    archived: false,
    createdAt: fields.createdAt || now,
    updatedAt: now,
    version: fields.version || null,
    recordVersion: RECORD_VERSION,
    deviceId,
  };
}

const DECK_COLORS = ['#5b5bd6', '#0d9488', '#d97706', '#db2777', '#2563eb', '#7c3aed', '#059669', '#dc2626', '#0891b2', '#65a30d'];
export function pickDeckColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DECK_COLORS[h % DECK_COLORS.length];
}

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim().length);
  if (value == null || value === '') return [];
  return decodeAnswers(String(value));
}

/** Normalise a card-like object into the stored shape. */
export function createCard(fields = {}, deviceId = 'local') {
  const now = Date.now();
  const front = asList(fields.front);
  const back = asList(fields.back);
  const kind = fields.kind || (fields.occlusion ? 'occlusion' : front.length && hasCloze(front[0]) ? 'cloze' : 'basic');
  return {
    id: fields.id || uuid(),
    deckId: fields.deckId,
    kind,
    front: kind === 'cloze' && typeof fields.front === 'string' ? [fields.front] : front,
    back,
    hint: fields.hint || '',
    explanation: fields.explanation || '',
    tags: normalizeTags(fields.tags),
    answerMode: ANSWER_MODES.includes(fields.answerMode) ? fields.answerMode : null,
    taskType: TASK_TYPES.includes(fields.taskType) ? fields.taskType : 'recall',
    match: fields.match || {},
    media: fields.media || [],
    audio: fields.audio || {},
    occlusion: fields.occlusion || null,
    suspended: !!fields.suspended,
    flags: fields.flags || {},
    createdAt: fields.createdAt || now,
    updatedAt: now,
    version: fields.version || null,
    recordVersion: RECORD_VERSION,
    deviceId,
  };
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/[\s,]+/);
  const out = [];
  for (const t of list) {
    const tag = String(t).trim().replace(/^#/, '');
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Effective settings for a card: deck settings with card overrides. */
export function effectiveCardSettings(card, deck) {
  const s = { ...DEFAULT_DECK_SETTINGS, ...(deck?.settings || {}) };
  const m = card.match || {};
  return {
    answerMode: card.answerMode || s.answerMode,
    taskType: card.taskType || s.taskType || 'recall',
    caseSensitive: m.caseSensitive ?? s.caseSensitive,
    typoTolerance: m.strictSpelling ? 'off' : (m.typoTolerance ?? s.typoTolerance),
    accentPolicy: m.accentPolicy ?? s.accentPolicy,
    mathEquivalence: m.mathEquivalence ?? s.mathEquivalence,
    numericTolerance: m.numericTolerance ?? '',
  };
}

/**
 * Study unit keys for a card under a deck's direction setting.
 * Inactive keys (e.g. a reverse unit after switching back to forward
 * only) keep their history; the caller marks them inactive.
 */
export function unitKeys(card, deck) {
  if (card.kind === 'cloze') return [...parseCloze(card.front[0] || '').groups.keys()];
  if (card.kind === 'occlusion') return (card.occlusion?.masks || []).map((m) => `o-${m.id}`);
  const direction = deck?.settings?.direction || 'forward';
  if (direction === 'both') return ['fwd', 'rev'];
  if (direction === 'reverse') return ['rev'];
  return ['fwd'];
}

export function unitId(cardId, key) {
  return `${cardId}:${key}`;
}

export function splitUnitId(id) {
  const idx = id.lastIndexOf(':');
  return { cardId: id.slice(0, idx), key: id.slice(idx + 1) };
}

export function unitKind(key) {
  if (key === 'fwd') return 'forward';
  if (key === 'rev') return 'reverse';
  if (key.startsWith('o-')) return 'occlusion';
  return 'cloze';
}

/**
 * Everything the study screen needs to present one unit.
 * `answerGroups` is a list of alternative lists; most units have one group.
 */
export function unitContent(card, key) {
  const kind = unitKind(key);
  const base = {
    unitKey: key,
    kind,
    hint: card.hint || '',
    explanation: card.explanation || '',
    instruction: '',
    occlusion: null,
  };
  if (kind === 'forward') {
    return { ...base, prompt: card.front[0] || '', answerGroups: [card.back], answerDisplay: card.back[0] || '', answerSide: 'back' };
  }
  if (kind === 'reverse') {
    return { ...base, prompt: card.back[0] || '', answerGroups: [card.front], answerDisplay: card.front[0] || '', answerSide: 'front' };
  }
  if (kind === 'cloze') {
    const text = card.front[0] || '';
    const groups = clozeAnswerGroups(text, key);
    return {
      ...base,
      prompt: clozePrompt(text, key),
      reveal: clozeReveal(text, key),
      extra: card.back[0] || '',
      answerGroups: groups,
      answerDisplay: groups.map((g) => g[0]).join('; '),
      instruction: clozeInstruction(text, key),
      answerSide: 'cloze',
    };
  }
  const maskId = key.slice(2);
  const mask = (card.occlusion?.masks || []).find((m) => m.id === maskId);
  return {
    ...base,
    prompt: card.front[0] || card.occlusion?.title || '',
    answerGroups: [mask ? mask.label : []],
    answerDisplay: mask ? mask.label[0] || '' : '',
    occlusion: { imageId: card.occlusion?.imageId, alt: card.occlusion?.alt || '', masks: card.occlusion?.masks || [], activeMaskId: maskId, revealMode: card.occlusion?.reveal || 'all' },
    answerSide: 'mask',
  };
}

/** Plain-text summary for lists and search. */
export function cardSummary(card) {
  const front = card.kind === 'cloze' ? clozeFilled(card.front[0] || '') : card.front[0] || card.occlusion?.title || 'Image occlusion';
  return { front: plainText(front), back: plainText(card.back.join(' | ')) };
}

/** Search haystack (lower-case). */
export function cardSearchText(card) {
  const s = cardSummary(card);
  return `${s.front} ${s.back} ${card.hint} ${card.explanation} ${card.tags.join(' ')} ${(card.occlusion?.masks || []).map((m) => m.label.join(' ')).join(' ')}`.toLowerCase();
}

/** Key used to detect duplicates on import and against existing decks. */
export function cardDedupeKey(card) {
  const front = card.kind === 'cloze' ? card.front[0] || '' : card.front[0] || '';
  return `${dedupeKey(front)}\u0000${dedupeKey(card.back[0] || '')}`;
}

export function cardFrontKey(card) {
  return dedupeKey(card.front[0] || '');
}

/** Fields that define what a card tests (used for revision hashing). */
export function contentFields(card) {
  return {
    kind: card.kind,
    front: card.front,
    back: card.back,
    hint: card.hint,
    explanation: card.explanation,
    tags: card.tags,
    answerMode: card.answerMode,
    taskType: card.taskType,
    match: card.match,
    media: card.media,
    audio: card.audio,
    occlusion: card.occlusion,
    suspended: card.suspended,
    deckId: card.deckId,
  };
}

export function contentHash(card) {
  return hashHex(stableStringify(contentFields(card)));
}

function semanticForm(text) {
  return collapseWhitespace(plainText(String(text || ''))).toLowerCase();
}

/**
 * Classify an edit for each affected unit:
 *  - 'none'        nothing relevant changed
 *  - 'formatting'  only presentation (Markdown emphasis, whitespace, case of prompt)
 *  - 'aliases'     accepted alternatives added/removed, primary answer unchanged
 *  - 'substantive' the prompt or the primary answer changed → offer schedule reset
 * Returns a map unitKey → classification.
 */
export function classifyEdit(before, after, deck) {
  const result = {};
  const keys = new Set([...unitKeys(before, deck), ...unitKeys(after, deck)]);
  for (const key of keys) {
    const a = unitContent(before, key);
    const b = unitContent(after, key);
    const promptA = semanticForm(a.prompt);
    const promptB = semanticForm(b.prompt);
    const primaryA = (a.answerGroups || []).map((g) => semanticForm(g[0])).join(';');
    const primaryB = (b.answerGroups || []).map((g) => semanticForm(g[0])).join(';');
    const altsA = JSON.stringify(a.answerGroups);
    const altsB = JSON.stringify(b.answerGroups);
    if (promptA !== promptB || primaryA !== primaryB || before.answerMode !== after.answerMode) result[key] = 'substantive';
    else if (altsA !== altsB) result[key] = 'aliases';
    else if (a.prompt !== b.prompt || a.answerDisplay !== b.answerDisplay || a.hint !== b.hint || a.explanation !== b.explanation) result[key] = 'formatting';
    else result[key] = 'none';
  }
  return result;
}

/** Validation for cards created in the editor or by import. */
export function validateCard(card) {
  const errors = [];
  const warnings = [];
  if (!card.deckId) errors.push('No deck selected');
  if (card.kind === 'cloze') {
    const parsed = parseCloze(card.front[0] || '');
    parsed.errors.forEach((e) => errors.push(`Cloze: ${e.message}`));
    if (!parsed.groups.size && !parsed.errors.length) errors.push('Cloze card has no {{…}} blanks');
  } else if (card.kind === 'occlusion') {
    if (!card.occlusion?.imageId) errors.push('Image occlusion needs an image');
    if (!(card.occlusion?.masks || []).length) errors.push('Add at least one mask');
    (card.occlusion?.masks || []).forEach((m, i) => { if (!m.label?.length) errors.push(`Mask ${i + 1} needs a label`); });
  } else {
    if (!card.front.length) errors.push('Front is empty');
    if (!card.back.length) errors.push('Back is empty');
  }
  const tooLong = [...card.front, ...card.back, card.hint, card.explanation].some((f) => String(f).length > 20000);
  if (tooLong) errors.push('A field is longer than 20,000 characters');
  if (card.answerMode === 'math' || card.answerMode === 'chem') {
    // Parse checks are reported by the editor's live preview; not errors.
  }
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Deck vocabulary: every accepted answer word, used by typo tolerance to
 * refuse "typos" that are actually another known term.
 */
export function buildVocabulary(cards) {
  const vocab = new Set();
  for (const card of cards) {
    const lists = [card.front, card.back, ...((card.occlusion?.masks || []).map((m) => m.label))];
    for (const list of lists) {
      for (const answer of list || []) {
        for (const w of dedupeKey(answer).split(' ')) if (w.length >= 4) vocab.add(w);
      }
    }
  }
  return vocab;
}
