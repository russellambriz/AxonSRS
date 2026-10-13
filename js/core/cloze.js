/**
 * Cloze deletion syntax.
 *
 *   {{c1::answer}}           numbered cloze, one study unit per number
 *   {{c1::answer::hint}}     with a hint shown in the blank
 *   {{c1::a|b}}              accepted alternatives (pipe, "\|" escapes)
 *   {{answer}}               unnumbered: every blank is its own unit
 *
 * Semantics
 *  - Different numbers (c1, c2) → distinct units with stable ids "c1", "c2".
 *  - Repeated occurrences of one number are hidden together.
 *  - If one number hides several distinct answers they are expected in
 *    reading order, separated by ";" (identical answers count once).
 *  - Unnumbered blanks get content-derived ids "u-<hash>" (plus "-2", "-3"
 *    for repeats of the same text), so inserting or editing another blank
 *    never changes their identity.
 *  - Malformed syntax is reported, never silently dropped.
 */

import { decodeAnswers } from './aliases.js';
import { hashHex, escapeHtml } from './util.js';
import { dedupeKey } from './text.js';

const OPEN = '{{';
const CLOSE = '}}';

export function hasCloze(text) {
  return typeof text === 'string' && text.includes(OPEN) && text.includes(CLOSE);
}

/**
 * @returns {{ blanks: object[], groups: Map<string, object>, errors: object[] }}
 */
export function parseCloze(text) {
  const source = String(text ?? '');
  const blanks = [];
  const errors = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf(OPEN, i);
    const strayClose = source.indexOf(CLOSE, i);
    if (strayClose >= 0 && (open < 0 || strayClose < open)) {
      errors.push({ index: strayClose, message: 'Closing "}}" without a matching "{{"' });
      i = strayClose + 2;
      continue;
    }
    if (open < 0) break;
    const close = source.indexOf(CLOSE, open + 2);
    if (close < 0) {
      errors.push({ index: open, message: 'Cloze opened with "{{" is never closed' });
      break;
    }
    const nestedOpen = source.indexOf(OPEN, open + 2);
    if (nestedOpen >= 0 && nestedOpen < close) {
      errors.push({ index: nestedOpen, message: 'Nested "{{" inside a cloze' });
      i = nestedOpen;
      continue;
    }
    const inner = source.slice(open + 2, close);
    const raw = source.slice(open, close + 2);
    const parsed = parseInner(inner);
    if (parsed.error) errors.push({ index: open, message: parsed.error, raw });
    else blanks.push({ ...parsed, start: open, end: close + 2, raw });
    i = close + 2;
  }

  // Identities for unnumbered blanks: content hash + occurrence index.
  const seen = new Map();
  for (const blank of blanks) {
    if (blank.number != null) {
      blank.key = `c${blank.number}`;
    } else {
      const base = `u-${hashHex(dedupeKey(blank.answers[0])).slice(-8)}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      blank.key = n === 1 ? base : `${base}-${n}`;
    }
  }

  const groups = new Map();
  for (const blank of blanks) {
    if (!groups.has(blank.key)) groups.set(blank.key, { key: blank.key, number: blank.number, blanks: [], ordered: [] });
    const group = groups.get(blank.key);
    group.blanks.push(blank);
    const k = dedupeKey(blank.answers[0]);
    if (!group.ordered.some((o) => dedupeKey(o.answers[0]) === k)) group.ordered.push({ answers: blank.answers, hint: blank.hint });
  }
  return { blanks, groups, errors };
}

function parseInner(inner) {
  let body = inner;
  let number = null;
  const numbered = /^c(\d+)::/i.exec(body);
  if (numbered) {
    number = Number(numbered[1]);
    if (number < 1) return { error: 'Cloze numbers start at c1' };
    body = body.slice(numbered[0].length);
  } else if (/^c\d*::/i.test(body)) {
    return { error: 'Cloze number is missing (use c1::, c2::, …)' };
  }
  const hintSplit = splitHint(body);
  const answers = decodeAnswers(hintSplit.answer);
  if (!answers.length) return { error: 'Cloze has no answer' };
  return { number, answers, hint: hintSplit.hint ? hintSplit.hint.trim() : '' };
}

function splitHint(body) {
  // The hint separator is the last unescaped "::".
  let idx = -1;
  for (let j = 0; j < body.length - 1; j++) {
    if (body[j] === '\\') {
      j++;
      continue;
    }
    if (body[j] === ':' && body[j + 1] === ':') idx = j;
  }
  if (idx < 0) return { answer: body, hint: '' };
  return { answer: body.slice(0, idx), hint: body.slice(idx + 2) };
}

/** Unit keys in first-appearance order. */
export function clozeKeys(text) {
  return [...parseCloze(text).groups.keys()];
}

function blankLabel(group, blank) {
  const idx = group.ordered.findIndex((o) => dedupeKey(o.answers[0]) === dedupeKey(blank.answers[0]));
  const multi = group.ordered.length > 1;
  const hint = blank.hint ? escapeHtml(blank.hint) : '…';
  return multi ? `[${idx + 1}: ${hint}]` : `[${hint}]`;
}

/**
 * Markdown prompt for one cloze unit: the unit's blanks are hidden, other
 * blanks show their first answer.
 */
export function clozePrompt(text, key) {
  const { blanks, groups } = parseCloze(text);
  const group = groups.get(key);
  let out = '';
  let pos = 0;
  for (const blank of blanks) {
    out += text.slice(pos, blank.start);
    if (blank.key === key && group) out += `<span class="cloze-blank">${blankLabel(group, blank)}</span>`;
    else out += blank.answers[0];
    pos = blank.end;
  }
  out += text.slice(pos);
  return out;
}

/** Markdown with the unit's answers highlighted (feedback view). */
export function clozeReveal(text, key) {
  const { blanks } = parseCloze(text);
  let out = '';
  let pos = 0;
  for (const blank of blanks) {
    out += text.slice(pos, blank.start);
    out += blank.key === key ? `<span class="cloze-answer">${blank.answers[0]}</span>` : blank.answers[0];
    pos = blank.end;
  }
  out += text.slice(pos);
  return out;
}

/** Plain text with all clozes filled in (search, TTS, dedupe). */
export function clozeFilled(text) {
  const { blanks } = parseCloze(text);
  let out = '';
  let pos = 0;
  for (const blank of blanks) {
    out += text.slice(pos, blank.start) + blank.answers[0];
    pos = blank.end;
  }
  return out + text.slice(pos);
}

/** Expected answers for one unit as ordered alternative groups. */
export function clozeAnswerGroups(text, key) {
  const group = parseCloze(text).groups.get(key);
  return group ? group.ordered.map((o) => o.answers) : [];
}

/** Human-readable instruction for multi-answer groups. */
export function clozeInstruction(text, key) {
  const groups = clozeAnswerGroups(text, key);
  return groups.length > 1 ? `Type ${groups.length} answers in order, separated by “;”` : '';
}

/**
 * Add an alias to every blank of a unit whose first answer matches the
 * expected answer at `orderIndex`. Returns the new text.
 */
export function addClozeAlias(text, key, orderIndex, alias) {
  const { blanks, groups } = parseCloze(text);
  const group = groups.get(key);
  if (!group || !group.ordered[orderIndex]) return text;
  const target = dedupeKey(group.ordered[orderIndex].answers[0]);
  const escaped = String(alias).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\}\}/g, '} }').replace(/::/g, ': :');
  let out = '';
  let pos = 0;
  for (const blank of blanks) {
    out += text.slice(pos, blank.start);
    if (blank.key === key && dedupeKey(blank.answers[0]) === target && !blank.answers.includes(String(alias).trim())) {
      const inner = blank.raw.slice(2, -2);
      const hintSplit = splitHint(blank.number != null ? inner.replace(/^c\d+::/i, '') : inner);
      const prefix = blank.number != null ? `c${blank.number}::` : '';
      const hint = hintSplit.hint ? `::${hintSplit.hint}` : '';
      out += `{{${prefix}${hintSplit.answer.trim()}|${escaped}${hint}}}`;
    } else {
      out += blank.raw;
    }
    pos = blank.end;
  }
  return out + text.slice(pos);
}

/** Preview rows for the import screen. */
export function clozePreview(text) {
  const { groups, errors } = parseCloze(text);
  const rows = [...groups.values()].map((g) => ({
    key: g.key,
    prompt: clozePrompt(text, g.key).replace(/<[^>]+>/g, ''),
    expected: g.ordered.map((o) => o.answers.join(' | ')).join('; '),
  }));
  return { rows, errors };
}
