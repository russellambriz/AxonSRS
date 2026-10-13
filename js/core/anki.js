/**
 * Anki-compatible plain-text export (File → Import in Anki).
 *
 * Produces Anki's "Notes in Plain Text" format with header directives:
 * separator, html:false, notetype/deck/tags columns. Basic cards map to
 * "Basic" (or "Basic (and reversed card)" for decks studied in both
 * directions), cloze cards to "Cloze". Accepted alternatives stay in the
 * pipe-separated form. Scheduling cannot be imported into Anki's
 * scheduler from plain text, so it is written as a human-readable notes
 * column. Media, image occlusion masks and review history are not
 * representable in this format (use the JSON backup for those).
 */

import { encodeAnswers } from './aliases.js';
import { RATING_NAMES, STATE_NAMES } from './scheduler.js';

function quote(field, sep) {
  const s = String(field ?? '');
  if (s.includes(sep) || s.includes('\n') || s.includes('"') || s.includes('\r')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function schedulingNote(units) {
  const parts = [];
  for (const u of units) {
    if (!u.state || u.state.state === 0) {
      parts.push(`${u.key}: new`);
      continue;
    }
    const s = u.state;
    const due = new Date(s.due).toISOString().slice(0, 10);
    parts.push(`${u.key}: ${STATE_NAMES[s.state]}, due ${due}, stability ${s.stability.toFixed(1)}d, difficulty ${s.difficulty.toFixed(1)}, reps ${s.reps}, lapses ${s.lapses}`);
  }
  return parts.length ? `Axon — ${parts.join('; ')}` : '';
}

/**
 * @param {object[]} cards
 * @param {Map} decksById
 * @param {Map} unitsByCard cardId → units[]
 * @param {{ separator?: '\t'|',' , includeScheduling?: boolean }} opts
 */
export function exportAnki(cards, decksById, unitsByCard = new Map(), { separator = '\t', includeScheduling = true } = {}) {
  const sepName = separator === '\t' ? 'tab' : separator === ',' ? 'comma' : 'semicolon';
  const lines = [
    `#separator:${sepName}`,
    '#html:false',
    '#notetype column:1',
    '#deck column:2',
    '#tags column:5',
    `#columns:Notetype${separator}Deck${separator}Front${separator}Back${separator}Tags${includeScheduling ? `${separator}Axon scheduling` : ''}`,
  ];
  const skipped = [];
  for (const card of cards) {
    if (card.kind === 'occlusion') {
      skipped.push({ id: card.id, reason: 'Image occlusion cards cannot be represented in Anki plain text' });
      continue;
    }
    const deck = decksById.get(card.deckId);
    const deckName = (deck?.name || 'Axon').replace(/\//g, '::');
    let notetype = 'Basic';
    if (card.kind === 'cloze') notetype = 'Cloze';
    else if (deck?.settings?.direction === 'both') notetype = 'Basic (and reversed card)';
    const front = card.kind === 'cloze' ? card.front[0] || '' : encodeAnswers(card.front);
    const back = card.kind === 'cloze' ? [card.back[0] || '', card.explanation].filter(Boolean).join('\n\n') : encodeAnswers(card.back);
    const tags = [...card.tags.map((t) => t.replace(/\s+/g, '_'))];
    const units = unitsByCard.get(card.id) || [];
    if (units.some((u) => u.leech)) tags.push('leech');
    const cols = [notetype, deckName, front, back, tags.join(' ')];
    if (includeScheduling) cols.push(schedulingNote(units));
    lines.push(cols.map((c) => quote(c, separator)).join(separator));
  }
  return { text: `${lines.join('\n')}\n`, skipped, count: cards.length - skipped.length };
}

export { RATING_NAMES };
