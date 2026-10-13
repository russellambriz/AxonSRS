/**
 * Answer matching engine: distinct plain-text, mathematics and chemistry
 * modes. Every mode prefers rejecting an ambiguous answer over accepting a
 * wrong one; cards can always list explicit aliases.
 */

import { MATCHER_VERSION } from '../../config.js';
import { basicNormalize, normalizeProsePunctuation, stripFormatting, stripDiacritics, hasDiacritics } from '../text.js';
import { editDistance } from '../levenshtein.js';
import { compareMath } from './math.js';
import { compareChem } from './chem.js';
import { diffAnswer } from './diff.js';

export const DEFAULT_MATCH_OPTIONS = Object.freeze({
  mode: 'text',
  caseSensitive: false,
  typoTolerance: 'cautious',
  accentPolicy: 'typo',
  mathEquivalence: 'notation',
  numericTolerance: '',
  vocabulary: null,
});

/**
 * Affix and word pairs whose swap changes meaning in scientific
 * vocabulary. Typo tolerance never bridges these. The list cannot be
 * complete, which is why the deck vocabulary check, per-card strict
 * spelling and a visible "typo accepted" warning also exist.
 */
const CONFUSABLE_PREFIXES = [
  ['hypo', 'hyper'], ['inter', 'intra'], ['ante', 'anti'], ['hetero', 'homo'], ['hydro', 'hygro'],
  ['micro', 'macro'], ['mono', 'poly'], ['exo', 'endo'], ['sub', 'super'], ['sub', 'supra'], ['pre', 'post'],
  ['ab', 'ad'], ['uni', 'bi'], ['bi', 'tri'], ['di', 'tri'], ['mono', 'di'], ['cis', 'trans'], ['ortho', 'para'],
  ['meta', 'para'], ['afferent', 'efferent'], ['hypo', 'hypa'], ['dys', 'dis'],
];
const CONFUSABLE_SUFFIXES = [
  ['ate', 'ite'], ['ide', 'ate'], ['ide', 'ite'], ['ous', 'ic'], ['phagia', 'phasia'], ['ectomy', 'otomy'],
  ['ostomy', 'otomy'], ['ectomy', 'ostomy'], ['emia', 'uria'], ['itis', 'osis'], ['plasia', 'plasty'], ['ase', 'ose'],
];
const CONFUSABLE_WORDS = [['ileum', 'ilium'], ['mucous', 'mucus'], ['perineal', 'peroneal'], ['prostate', 'prostrate'], ['palpation', 'palpitation']];

function crossesConfusable(a, b) {
  for (const [x, y] of CONFUSABLE_PREFIXES) {
    if ((a.startsWith(x) && b.startsWith(y) && !a.startsWith(y)) || (a.startsWith(y) && b.startsWith(x) && !b.startsWith(y))) return true;
  }
  for (const [x, y] of CONFUSABLE_SUFFIXES) {
    if ((a.endsWith(x) && b.endsWith(y)) || (a.endsWith(y) && b.endsWith(x))) return true;
  }
  for (const [x, y] of CONFUSABLE_WORDS) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

/** Text normalisation applied to both sides in text mode. */
export function normalizeText(text, { caseSensitive = false } = {}) {
  let s = basicNormalize(stripFormatting(text));
  s = normalizeProsePunctuation(s);
  s = s.replace(/\s*([,;:])\s*/g, '$1 ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[.!?;,:]+$/u, '').trim();
  return caseSensitive ? s : s.toLocaleLowerCase();
}

function isWord(token) {
  return /^\p{L}+$/u.test(token);
}

/**
 * Cautious typo tolerance. Returns { ok, edits, reason }.
 * Rules (documented in README):
 *  - same number of words; only alphabetic words may differ
 *  - words with digits, signs or symbols must match exactly
 *  - a differing word must be ≥ 5 letters and keep its first letter
 *  - ≤ 1 edit for 5–8 letters, ≤ 2 for longer words, ≤ 2 edits in total
 *  - never across confusable prefixes (hypo/hyper, inter/intra, …)
 *  - never when the typed word is itself another known answer in the deck
 */
export function typoMatch(typed, expected, vocabulary = null) {
  const ta = typed.split(' ');
  const ea = expected.split(' ');
  if (ta.length !== ea.length) return { ok: false, reason: 'word-count' };
  let total = 0;
  for (let i = 0; i < ta.length; i++) {
    const t = ta[i];
    const e = ea[i];
    if (t === e) continue;
    if (!isWord(t) || !isWord(e)) return { ok: false, reason: 'non-word-difference' };
    const len = [...e].length;
    if (len < 5) return { ok: false, reason: 'short-word' };
    if ([...t][0] !== [...e][0]) return { ok: false, reason: 'first-letter' };
    const allowed = len <= 8 ? 1 : 2;
    const d = editDistance(t, e, allowed);
    if (d > allowed) return { ok: false, reason: 'too-different' };
    if (crossesConfusable(t, e)) return { ok: false, reason: 'confusable' };
    if (vocabulary && vocabulary.has(t)) return { ok: false, reason: 'known-term' };
    total += d;
  }
  if (total === 0) return { ok: true, edits: 0 };
  if (total > 2) return { ok: false, reason: 'too-many-edits' };
  return { ok: true, edits: total };
}

function compareText(input, expected, opts) {
  const u = normalizeText(input, opts);
  const e = normalizeText(expected, opts);
  if (u === e) return { equal: true, method: 'exact', warnings: [] };
  const warnings = [];
  let uu = u;
  let ee = e;
  if (opts.accentPolicy !== 'strict' && (hasDiacritics(u) || hasDiacritics(e))) {
    uu = stripDiacritics(u);
    ee = stripDiacritics(e);
    if (uu === ee) {
      if (opts.accentPolicy === 'ignore') return { equal: true, method: 'accent-insensitive', warnings: [] };
      return { equal: true, method: 'accent', typoTolerated: true, warnings: ['accent'] };
    }
  }
  if (opts.typoTolerance === 'cautious') {
    const typo = typoMatch(uu, ee, opts.vocabulary);
    if (typo.ok && typo.edits > 0) {
      warnings.push('typo');
      if (uu !== u || ee !== e) warnings.push('accent');
      return { equal: true, method: 'typo', typoTolerated: true, edits: typo.edits, warnings };
    }
  }
  return { equal: false, method: 'none', warnings: [] };
}

/**
 * Match `input` against a list of accepted answers.
 * @param {string} input
 * @param {string[]} accepted
 * @param {object} options see DEFAULT_MATCH_OPTIONS
 */
export function matchAnswer(input, accepted, options = {}) {
  const opts = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const typed = String(input ?? '');
  const result = {
    version: MATCHER_VERSION,
    mode: opts.mode,
    correct: false,
    matchedIndex: -1,
    matchedAnswer: null,
    method: 'none',
    typoTolerated: false,
    warnings: [],
    diagnostics: [],
    closestIndex: 0,
    probabilistic: false,
  };
  if (!basicNormalize(typed)) {
    result.diagnostics.push('empty');
    return result;
  }
  const answers = (accepted || []).filter((a) => basicNormalize(a));
  if (!answers.length) {
    result.diagnostics.push('no-accepted-answers');
    return result;
  }

  // Strict matches win over typo-tolerated ones across all alternatives.
  let tolerant = null;
  const diagnostics = new Set();
  for (let i = 0; i < answers.length; i++) {
    const expected = answers[i];
    let cmp;
    if (opts.mode === 'math') {
      cmp = compareMath(typed, expected, { equivalence: opts.mathEquivalence, tolerance: opts.numericTolerance });
      if (cmp.method === 'unparseable-expected') cmp = compareText(typed, expected, { ...opts, typoTolerance: 'off', accentPolicy: 'strict' });
    } else if (opts.mode === 'chem') {
      cmp = compareChem(typed, expected);
      if (cmp.method === 'unparseable-expected') cmp = compareText(typed, expected, { ...opts, typoTolerance: 'off', accentPolicy: 'strict', caseSensitive: true });
    } else {
      cmp = compareText(typed, expected, opts);
    }
    (cmp.diagnostics || []).forEach((d) => diagnostics.add(d));
    if (cmp.equal && !cmp.typoTolerated) {
      return {
        ...result,
        correct: true,
        matchedIndex: i,
        matchedAnswer: expected,
        closestIndex: i,
        method: cmp.method,
        probabilistic: !!cmp.probabilistic,
        warnings: cmp.warnings || [],
      };
    }
    if (cmp.equal && cmp.typoTolerated && !tolerant) tolerant = { i, cmp };
  }
  if (tolerant) {
    return {
      ...result,
      correct: true,
      matchedIndex: tolerant.i,
      matchedAnswer: answers[tolerant.i],
      closestIndex: tolerant.i,
      method: tolerant.cmp.method,
      typoTolerated: true,
      warnings: tolerant.cmp.warnings,
    };
  }
  result.diagnostics = [...diagnostics];
  result.closestIndex = closestAnswerIndex(typed, answers);
  return result;
}

export function closestAnswerIndex(typed, answers) {
  let best = 0;
  let bestD = Infinity;
  const t = normalizeText(typed);
  answers.forEach((a, i) => {
    const d = editDistance(t, normalizeText(a), 200);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Diff for the correction screen, computed on lightly normalised forms. */
export function answerDiff(typed, expected) {
  return diffAnswer(basicNormalize(typed), basicNormalize(stripFormatting(expected)));
}

/**
 * Cloze groups with several distinct answers expect them in order,
 * separated by ";". Each part is matched with the card's mode.
 */
export function matchOrderedAnswers(input, answerGroups, options = {}) {
  const parts = String(input).split(';').map((s) => s.trim());
  if (answerGroups.length === 1) return matchAnswer(input, answerGroups[0], options);
  if (parts.length !== answerGroups.length) {
    return {
      ...matchAnswer('', ['x'], options),
      correct: false,
      diagnostics: ['answer-count'],
      expectedCount: answerGroups.length,
      typedCount: parts.filter(Boolean).length,
    };
  }
  const results = parts.map((p, i) => matchAnswer(p, answerGroups[i], options));
  const correct = results.every((r) => r.correct);
  return {
    version: MATCHER_VERSION,
    mode: options.mode || 'text',
    correct,
    parts: results,
    matchedIndex: correct ? 0 : -1,
    matchedAnswer: correct ? results.map((r) => r.matchedAnswer).join('; ') : null,
    method: correct ? 'ordered' : 'none',
    typoTolerated: results.some((r) => r.typoTolerated),
    warnings: [...new Set(results.flatMap((r) => r.warnings))],
    diagnostics: [...new Set(results.flatMap((r) => r.diagnostics))],
    closestIndex: 0,
    probabilistic: results.some((r) => r.probabilistic),
  };
}

export const DIAGNOSTIC_LABELS = Object.freeze({
  'sign-error': 'Sign error',
  'missing-constant': 'Missing constant of integration (+ C)',
  reciprocal: 'Looks like the reciprocal of the answer',
  'unbalanced-parentheses': 'Unbalanced parentheses',
  'incomplete-expression': 'Expression is incomplete',
  'unreadable-expression': 'Could not read the expression',
  'charge-sign': 'Charge sign error',
  'charge-mismatch': 'Charge mismatch',
  'charge-missing': 'Missing ionic charge',
  'atom-count': 'Atom count mismatch',
  'element-mismatch': 'Different elements',
  'element-case': 'Element symbols are case-sensitive',
  'arrangement-differs': 'Same atoms, different formula arrangement',
  'ambiguous-charge': 'Ambiguous charge — use ^ (for example SO4^2-)',
  'state-missing': 'Missing state symbol',
  'state-mismatch': 'Different state symbol',
  'coefficient-mismatch': 'Coefficients differ (check balancing)',
  'arrow-mismatch': 'Different reaction arrow',
  'sides-swapped': 'Reactants and products are swapped',
  'not-an-equation': 'A full equation was expected',
  'structure-mismatch': 'Different kind of answer',
  'unreadable-formula': 'Could not read the formula',
  'answer-count': 'Wrong number of answers (separate with ;)',
  empty: 'No answer typed',
});

export const WARNING_LABELS = Object.freeze({
  typo: 'Typo accepted',
  accent: 'Accent difference accepted',
  'ambiguous-charge-read': 'Charge read from ambiguous notation — use ^ to be explicit',
});
