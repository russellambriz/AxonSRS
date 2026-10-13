/**
 * Import engine: format detection, deterministic parsing, field mapping,
 * validation and duplicate detection. Fully local; no AI involved.
 *
 * Every non-empty source line ends up in exactly one of: a draft card, a
 * header/directive, or the `unused` list shown to the user. Nothing is
 * silently discarded. Input is treated strictly as data.
 */

import { parseDelimited, countOutsideQuotes } from './csv.js';
import { htmlToText, looksLikeHtml } from './html.js';
import { splitUnescaped, decodeAnswers } from '../aliases.js';
import { hasCloze, parseCloze, clozePreview } from '../cloze.js';
import { dedupeKey } from '../text.js';
import { TASK_TYPES, ANSWER_MODES, normalizeTags } from '../model.js';
import { notesToDrafts } from './notes.js';

export const FORMATS = Object.freeze({
  tsv: 'Tab-separated (Front⇥Back)',
  delimiter: 'Delimiter (Front :: Back)',
  qa: 'Labeled Q: / A:',
  frontback: 'Labeled Front: / Back:',
  csv: 'CSV (comma)',
  csvSemicolon: 'CSV (semicolon)',
  anki: 'Anki plain-text export',
  notes: 'Structured notes (headings & bullets)',
  json: 'JSON',
});

export const FIELD_NAMES = Object.freeze(['front', 'back', 'tags', 'deck', 'hint', 'explanation', 'taskType', 'answerMode', 'ignore']);

const HEADER_ALIASES = {
  front: ['front', 'question', 'q', 'term', 'prompt', 'text'],
  back: ['back', 'answer', 'a', 'definition', 'response'],
  tags: ['tags', 'tag'],
  deck: ['deck', 'decks'],
  hint: ['hint'],
  explanation: ['explanation', 'extra', 'notes', 'back extra', 'solution', 'worked solution'],
  taskType: ['task', 'task type', 'tasktype', 'type'],
  answerMode: ['mode', 'answer mode', 'answermode', 'format'],
};

const LABELS = {
  q: 'front', question: 'front', front: 'front',
  a: 'back', answer: 'back', back: 'back',
  hint: 'hint', tags: 'tags', tag: 'tags', deck: 'deck',
  explanation: 'explanation', solution: 'explanation', extra: 'explanation',
  task: 'taskType', type: 'taskType', 'task type': 'taskType', mode: 'answerMode', 'answer mode': 'answerMode',
};

const MAX_FIELD = 20000;

/* ------------------------------------------------------------------ */
/* Detection                                                            */
/* ------------------------------------------------------------------ */

function nonEmptyLines(text) {
  return text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
}

/**
 * Score each candidate format; returns the best plus all candidates so
 * the user can correct the choice.
 */
export function detectFormat(text) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  const trimmed = t.trim();
  const candidates = [];
  if (!trimmed) return { format: null, candidates };
  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      candidates.push({ format: 'json', score: 1 });
    } catch {
      /* not JSON */
    }
  }
  if (/^#(separator|html|tags column|deck column|notetype|columns|guid column):/im.test(t)) candidates.push({ format: 'anki', score: 0.98 });
  const lines = nonEmptyLines(t);
  const n = Math.max(1, lines.length);
  const qaLines = lines.filter((l) => /^\s*(q|question)\s*[:.]\s*/i.test(l)).length;
  const aLines = lines.filter((l) => /^\s*(a|answer)\s*[:.]\s*/i.test(l)).length;
  if (qaLines && aLines) candidates.push({ format: 'qa', score: Math.min(0.97, 0.5 + 0.47 * ((qaLines + aLines) / n)) });
  const fLines = lines.filter((l) => /^\s*front\s*:/i.test(l)).length;
  const bLines = lines.filter((l) => /^\s*back\s*:/i.test(l)).length;
  if (fLines && bLines) candidates.push({ format: 'frontback', score: Math.min(0.97, 0.5 + 0.47 * ((fLines + bLines) / n)) });
  const tabLines = lines.filter((l) => l.includes('\t')).length;
  if (tabLines) candidates.push({ format: 'tsv', score: 0.5 + 0.45 * (tabLines / n) });
  const dLines = lines.filter((l) => /\s::\s|[^:\\]::[^:]/.test(l)).length;
  if (dLines) candidates.push({ format: 'delimiter', score: 0.5 + 0.44 * (dLines / n), delimiter: '::' });
  for (const [fmt, delim] of [['csv', ','], ['csvSemicolon', ';']]) {
    const counts = lines.slice(0, 200).map((l) => countOutsideQuotes(l, delim));
    const withDelim = counts.filter((c) => c >= 1).length;
    if (!withDelim) continue;
    const mode = mostCommon(counts.filter((c) => c >= 1));
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    candidates.push({ format: fmt, score: 0.35 + 0.5 * consistent * (withDelim / counts.length) });
  }
  const headings = lines.filter((l) => /^\s{0,3}#{1,6}\s/.test(l)).length + t.split(/\r?\n/).filter((l) => /^\s{0,3}#{1,6}\s/.test(l)).length;
  const bullets = lines.filter((l) => /^\s*[-*+]\s+\S/.test(l)).length;
  if (bullets && (headings || bullets / n > 0.4)) candidates.push({ format: 'notes', score: 0.45 + 0.4 * (bullets / n) + (headings ? 0.1 : 0) });
  candidates.sort((a, b) => b.score - a.score);
  return { format: candidates[0]?.format || 'notes', candidates };
}

function mostCommon(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  let best = null;
  let bestN = -1;
  for (const [k, v] of m) if (v > bestN) { best = k; bestN = v; }
  return best;
}

/* ------------------------------------------------------------------ */
/* Parsing into rows                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse source text in a given format.
 * @returns {{ format, columns: string[]|null, mapping: object, rows: object[], errors: object[], unused: object[], directives: object, drafts?: object[] }}
 */
export function parseImport(text, format, options = {}) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  switch (format) {
    case 'tsv': return parseTable(src, '\t', format, options);
    case 'csv': return parseTable(src, ',', format, options);
    case 'csvSemicolon': return parseTable(src, ';', format, options);
    case 'anki': return parseAnki(src, options);
    case 'delimiter': return parseDelimiterLines(src, options.delimiter || '::', options);
    case 'qa': return parseLabeled(src, /^\s*(q|question)\s*[:.]\s?/i, options);
    case 'frontback': return parseLabeled(src, /^\s*front\s*:\s?/i, options);
    case 'json': return parseJson(src, options);
    case 'notes': return { format, ...notesToDrafts(src, options) };
    default: throw new Error(`Unknown format ${format}`);
  }
}

function headerMapping(fields) {
  const mapping = {};
  let matched = 0;
  fields.forEach((f, i) => {
    const key = f.trim().toLowerCase();
    for (const [name, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key) && !Object.values(mapping).includes(name)) {
        mapping[i] = name;
        matched++;
        return;
      }
    }
    mapping[i] = 'ignore';
  });
  return matched >= 2 && Object.values(mapping).includes('front') ? mapping : null;
}

export function defaultMapping(columnCount) {
  const order = ['front', 'back', 'tags', 'deck', 'hint', 'explanation'];
  const mapping = {};
  for (let i = 0; i < columnCount; i++) mapping[i] = order[i] || 'ignore';
  return mapping;
}

function parseTable(src, delimiter, format, options) {
  const { rows, errors } = parseDelimited(src, delimiter);
  let mapping = options.mapping || null;
  let headerRow = null;
  const dataRows = rows.filter((r) => !(r.fields.length === 1 && r.fields[0].trim().startsWith('#')));
  if (!mapping && dataRows.length) {
    const hm = headerMapping(dataRows[0].fields);
    if (hm && options.hasHeader !== false) {
      mapping = hm;
      headerRow = dataRows.shift();
    }
  } else if (options.hasHeader && dataRows.length) {
    headerRow = dataRows.shift();
  }
  const columnCount = Math.max(0, ...dataRows.map((r) => r.fields.length));
  if (!mapping) mapping = defaultMapping(columnCount);
  const unused = [];
  const out = [];
  for (const r of dataRows) {
    if (r.fields.every((f) => !f.trim())) continue;
    if (r.fields.length < 2) {
      unused.push({ line: r.line, text: r.raw, reason: `Only one column — expected a ${delimiter === '\t' ? 'tab' : `"${delimiter}"`} separator` });
      continue;
    }
    out.push({ line: r.line, raw: r.raw, fields: r.fields });
  }
  return {
    format,
    columns: headerRow ? headerRow.fields : Array.from({ length: columnCount }, (_, i) => `Column ${i + 1}`),
    hasHeader: !!headerRow,
    mapping,
    rows: out,
    errors,
    unused,
    directives: {},
  };
}

function parseAnki(src, options) {
  const lines = src.split(/\r?\n/);
  const directives = {};
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#([a-z ]+):(.*)$/i.exec(lines[i]);
    if (!m) break;
    directives[m[1].trim().toLowerCase()] = m[2].trim();
    bodyStart = i + 1;
  }
  const sepName = (directives.separator || 'tab').toLowerCase();
  const delimiter = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ', colon: ':' }[sepName] || directives.separator || '\t';
  const body = lines.slice(bodyStart).join('\n');
  const parsed = parseDelimited(body, delimiter);
  const html = directives.html ? directives.html.toLowerCase() === 'true' : null;
  const columnCount = Math.max(0, ...parsed.rows.map((r) => r.fields.length));
  const mapping = options.mapping || defaultMapping(columnCount);
  if (!options.mapping) {
    for (let i = 0; i < columnCount; i++) mapping[i] = i === 0 ? 'front' : i === 1 ? 'back' : 'ignore';
    if (directives['tags column']) mapping[Number(directives['tags column']) - 1] = 'tags';
    if (directives['deck column']) mapping[Number(directives['deck column']) - 1] = 'deck';
    if (directives['notetype column']) mapping[Number(directives['notetype column']) - 1] = 'ignore';
    if (directives['guid column']) mapping[Number(directives['guid column']) - 1] = 'ignore';
    if (directives.columns) {
      directives.columns.split(delimiter === '\t' ? '\t' : delimiter).forEach((name, i) => {
        const hm = headerMapping([name, 'x']);
        if (hm && hm[0] !== 'ignore') mapping[i] = hm[0];
      });
    }
  }
  const rows = [];
  const unused = [];
  for (const r of parsed.rows) {
    if (r.fields.every((f) => !f.trim())) continue;
    if (r.fields.length < 2) {
      unused.push({ line: r.line + bodyStart, text: r.raw, reason: 'Only one column' });
      continue;
    }
    rows.push({ line: r.line + bodyStart, raw: r.raw, fields: r.fields, html: html ?? r.fields.some(looksLikeHtml) });
  }
  return {
    format: 'anki',
    columns: Array.from({ length: columnCount }, (_, i) => `Column ${i + 1}`),
    hasHeader: false,
    mapping,
    rows,
    errors: parsed.errors.map((e) => ({ ...e, line: e.line + bodyStart })),
    unused,
    directives,
  };
}

function parseDelimiterLines(src, delimiter, options) {
  const lines = src.split(/\r?\n/);
  const rows = [];
  const unused = [];
  lines.forEach((text, i) => {
    if (!text.trim() || text.trim().startsWith('#')) {
      if (text.trim().startsWith('#')) unused.push({ line: i + 1, text, reason: 'Comment or heading line' });
      return;
    }
    const parts = splitUnescaped(text, delimiter).map((p) => p.trim());
    if (parts.length < 2) {
      unused.push({ line: i + 1, text, reason: `No "${delimiter}" separator` });
      return;
    }
    rows.push({ line: i + 1, raw: text, fields: parts });
  });
  const columnCount = Math.max(0, ...rows.map((r) => r.fields.length));
  return { format: 'delimiter', columns: Array.from({ length: columnCount }, (_, i) => `Part ${i + 1}`), hasHeader: false, mapping: options.mapping || defaultMapping(columnCount), rows, errors: [], unused, directives: { delimiter } };
}

/**
 * Labeled blocks (Q:/A: or Front:/Back:). A new block begins at each
 * start label; blank lines inside a block are allowed. Continuation lines
 * append to the most recent field.
 */
function parseLabeled(src, startRe, options) {
  const lines = src.split(/\r?\n/);
  const records = [];
  const unused = [];
  let current = null;
  let field = null;
  const labelRe = /^\s*(q|question|a|answer|front|back|hint|tags?|deck|explanation|solution|extra|task type|task|type|answer mode|mode)\s*[:.]\s?(.*)$/i;
  lines.forEach((text, i) => {
    const line = i + 1;
    const m = labelRe.exec(text);
    if (m) {
      const name = LABELS[m[1].toLowerCase()];
      if (startRe.test(text) || !current) {
        if (current) records.push(current);
        current = { line, raw: '', named: {} };
      }
      current.named[name] = current.named[name] ? `${current.named[name]}\n${m[2]}` : m[2];
      current.raw += `${text}\n`;
      field = name;
      return;
    }
    if (!text.trim()) {
      if (current) current.raw += '\n';
      return;
    }
    if (current && field) {
      current.named[field] = current.named[field] ? `${current.named[field]}\n${text}` : text;
      current.raw += `${text}\n`;
    } else {
      unused.push({ line, text, reason: 'Text before the first label' });
    }
  });
  if (current) records.push(current);
  const rows = records.map((r) => ({ line: r.line, raw: r.raw.trim(), named: Object.fromEntries(Object.entries(r.named).map(([k, v]) => [k, v.trim()])) }));
  return { format: startRe.source.includes('front') ? 'frontback' : 'qa', columns: null, hasHeader: false, mapping: null, rows, errors: [], unused, directives: {} };
}

function parseJson(src, options) {
  let data;
  try {
    data = JSON.parse(src);
  } catch (err) {
    return { format: 'json', rows: [], errors: [{ line: 1, message: `Invalid JSON: ${err.message}` }], unused: [], mapping: null, columns: null, directives: {} };
  }
  if (data && data.format === 'axon-backup') {
    return { format: 'json', backup: data, rows: [], errors: [], unused: [], mapping: null, columns: null, directives: {} };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.cards) ? data.cards : null;
  if (!list) return { format: 'json', rows: [], errors: [{ line: 1, message: 'JSON must be an array of cards or an Axon backup' }], unused: [], mapping: null, columns: null, directives: {} };
  const rows = [];
  const unused = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      unused.push({ line: i + 1, text: JSON.stringify(item), reason: 'Not an object' });
      return;
    }
    const named = {};
    for (const [k, v] of Object.entries(item)) {
      const hm = headerMapping([k, 'x']);
      const name = hm && hm[0] !== 'ignore' ? hm[0] : LABELS[k.toLowerCase()];
      if (name) named[name] = Array.isArray(v) ? (name === 'tags' ? v.join(' ') : v.map(String).map((s) => s.replace(/\|/g, '\\|')).join(' | ')) : String(v ?? '');
    }
    rows.push({ line: i + 1, raw: JSON.stringify(item), named });
  });
  return { format: 'json', columns: null, hasHeader: false, mapping: null, rows, errors: [], unused, directives: {} };
}

/* ------------------------------------------------------------------ */
/* Drafts, validation, duplicates                                       */
/* ------------------------------------------------------------------ */

function fieldsFromRow(row, mapping) {
  if (row.named) return { ...row.named };
  const out = {};
  row.fields.forEach((value, i) => {
    const name = mapping[i];
    if (!name || name === 'ignore') return;
    out[name] = out[name] ? `${out[name]} ${value}` : value;
  });
  return out;
}

/**
 * Build editable drafts from parsed rows.
 * @param parsed result of parseImport
 * @param options { defaultDeck, defaultTaskType, defaultAnswerMode }
 */
export function buildDrafts(parsed, options = {}) {
  if (parsed.drafts) return parsed.drafts.map((d) => validateDraft(d, options));
  return parsed.rows.map((row, idx) => {
    const f = fieldsFromRow(row, parsed.mapping || {});
    const warnings = [];
    for (const key of ['front', 'back', 'hint', 'explanation']) {
      if (f[key] && (row.html || (parsed.format === 'anki' && looksLikeHtml(f[key])))) {
        const conv = htmlToText(f[key]);
        f[key] = conv.text;
        warnings.push(...conv.warnings);
      }
    }
    const draft = {
      id: `d${idx + 1}`,
      line: row.line,
      source: row.raw,
      front: (f.front ?? '').trim(),
      back: (f.back ?? '').trim(),
      tags: normalizeTags(f.tags || ''),
      deck: (f.deck || '').trim() || options.defaultDeck || '',
      hint: (f.hint || '').trim(),
      explanation: (f.explanation || '').trim(),
      taskType: (f.taskType || '').trim().toLowerCase() || options.defaultTaskType || 'recall',
      answerMode: (f.answerMode || '').trim().toLowerCase() || options.defaultAnswerMode || '',
      warnings,
      include: true,
    };
    return validateDraft(draft, options);
  });
}

const TASK_ALIASES = { recall: 'recall', fact: 'recall', calculation: 'calculation', calc: 'calculation', compute: 'calculation', multistep: 'multistep', 'multi-step': 'multistep', reasoning: 'multistep', 'multi-step reasoning': 'multistep' };
const MODE_ALIASES = { text: 'text', plain: 'text', math: 'math', maths: 'math', mathematics: 'math', chem: 'chem', chemistry: 'chem' };

export function validateDraft(draft, options = {}) {
  const d = { ...draft, errors: [], warnings: [...(draft.warnings || [])] };
  const kind = hasCloze(d.front) ? 'cloze' : 'basic';
  d.kind = kind;
  if (!d.front.trim()) d.errors.push('Front is empty');
  if (kind === 'basic' && !d.back.trim()) d.errors.push('Back is empty');
  if (kind === 'cloze') {
    const parsed = parseCloze(d.front);
    parsed.errors.forEach((e) => d.errors.push(`Cloze: ${e.message}`));
    if (!parsed.groups.size && !parsed.errors.length) d.errors.push('No cloze blanks found');
    d.cloze = clozePreview(d.front).rows;
  } else if (/{{|}}/.test(d.front)) {
    d.errors.push('Malformed cloze braces');
  }
  if (d.front.length > MAX_FIELD || d.back.length > MAX_FIELD) d.errors.push('Field longer than 20,000 characters');
  const task = TASK_ALIASES[d.taskType] || null;
  if (!task) {
    d.warnings.push(`Unknown task type "${d.taskType}" — using Recall`);
    d.taskType = 'recall';
  } else d.taskType = task;
  if (d.answerMode) {
    const mode = MODE_ALIASES[d.answerMode] || null;
    if (!mode) {
      d.warnings.push(`Unknown answer mode "${d.answerMode}" — using the deck default`);
      d.answerMode = '';
    } else d.answerMode = mode;
  }
  if (kind === 'basic' && decodeAnswers(d.back).length > 1) d.warnings.push(`${decodeAnswers(d.back).length} accepted answers (separated by |)`);
  d.status = d.errors.length ? 'invalid' : 'valid';
  if (!TASK_TYPES.includes(d.taskType)) d.taskType = 'recall';
  if (d.answerMode && !ANSWER_MODES.includes(d.answerMode)) d.answerMode = '';
  return d;
}

function draftKey(d) {
  return `${dedupeKey(d.front)}\u0000${dedupeKey(decodeAnswers(d.back)[0] || '')}`;
}

/**
 * Mark duplicates within the import and against existing cards.
 * existing: array of { id, deckId, front: string[], back: string[] }
 * Sets draft.duplicate = { type: 'within'|'existing'|'similar', ofDraft?, cardId?, identical } and a default action.
 */
export function markDuplicates(drafts, existing = []) {
  const existingByKey = new Map();
  const existingByFront = new Map();
  for (const c of existing) {
    const key = `${dedupeKey(c.front[0] || '')}\u0000${dedupeKey(c.back[0] || '')}`;
    if (!existingByKey.has(key)) existingByKey.set(key, c);
    const fk = dedupeKey(c.front[0] || '');
    if (!existingByFront.has(fk)) existingByFront.set(fk, c);
  }
  const seen = new Map();
  return drafts.map((d) => {
    const out = { ...d, duplicate: null, action: d.status === 'invalid' ? 'skip' : (d.action || 'import') };
    if (d.status === 'invalid') return out;
    const key = draftKey(d);
    if (seen.has(key)) {
      out.duplicate = { type: 'within', ofDraft: seen.get(key), identical: true };
      out.action = 'skip';
      return out;
    }
    seen.set(key, d.id);
    const ex = existingByKey.get(key);
    if (ex) {
      out.duplicate = { type: 'existing', cardId: ex.id, deckId: ex.deckId, identical: true };
      out.action = 'skip';
      return out;
    }
    const similar = existingByFront.get(dedupeKey(d.front));
    if (similar) out.duplicate = { type: 'similar', cardId: similar.id, deckId: similar.deckId, identical: false };
    return out;
  });
}

/** Counts for the confirmation step. */
export function importSummary(drafts, unused = [], errors = []) {
  const s = { total: drafts.length, valid: 0, invalid: 0, toImport: 0, toUpdate: 0, skipped: 0, duplicates: 0, unused: unused.length, parseErrors: errors.length };
  for (const d of drafts) {
    if (d.status === 'valid') s.valid++;
    else s.invalid++;
    if (d.duplicate) s.duplicates++;
    if (!d.include || d.action === 'skip' || d.status === 'invalid') s.skipped++;
    else if (d.action === 'update') s.toUpdate++;
    else s.toImport++;
  }
  return s;
}

/** Text of everything not imported, so the user can keep it. */
export function notImportedText(drafts, unused = []) {
  const lines = [];
  for (const d of drafts) {
    if (d.status === 'invalid' || !d.include || d.action === 'skip') lines.push(`# line ${d.line}: ${d.status === 'invalid' ? d.errors.join('; ') : d.duplicate ? 'duplicate' : 'excluded'}\n${d.source}`);
  }
  for (const u of unused) lines.push(`# line ${u.line}: ${u.reason}\n${u.text}`);
  return lines.join('\n');
}
