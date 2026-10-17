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
  // Chemical nomenclature: element vs anion, alkane/alkene/alkyne, alcohol/aldehyde/ketone.
  ['ine', 'ide'], ['ine', 'ite'], ['ine', 'ate'], ['ane', 'ene'], ['ene', 'yne'], ['ane', 'yne'],
  ['anol', 'anal'], ['anol', 'anone'], ['anal', 'anone'], ['ol', 'al'],
];
const CONFUSABLE_WORDS = [
  ['ileum', 'ilium'], ['mucous', 'mucus'], ['perineal', 'peroneal'], ['prostate', 'prostrate'], ['palpation', 'palpitation'],
  ['neuron', 'neutron'], ['neurons', 'neutrons'], ['artery', 'arteriole'], ['arteries', 'arterioles'], ['vein', 'venule'], ['veins', 'venules'],
  ['mitosis', 'meiosis'], ['absorption', 'adsorption'], ['absorb', 'adsorb'], ['affect', 'effect'], ['allele', 'allelle'],
  ['ileal', 'iliac'], ['xylem', 'phloem'], ['diffusion', 'infusion'], ['efflux', 'influx'], ['anion', 'cation'], ['anode', 'cathode'],
];

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
  s = s.replace(/(\d)\s+(?=[°%‰′″])/g, '$1');
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
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * Remove display-only markup from an answer before comparing it: images,
 * HTML tags, maths delimiters ($…$, \\(…\\)), \\ce{…} and HTML entities.
 * <sub>/<sup> keep their content (as ^… for superscripts in maths and
 * chemistry, so SO<sub>4</sub><sup>2-</sup> reads as SO4^2-). Applied to
 * both the stored and the typed answer, so the same answer written with or
 * without formatting compares equal.
 */
export function answerForMatching(text, mode = 'text') {
  let s = String(text ?? '');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/<img\b[^>]*>/gi, ' ');
  const sup = mode === 'text' ? '$1' : '^($1)';
  s = s.replace(/<sub>([\s\S]*?)<\/sub>/gi, '$1').replace(/<sup>([\s\S]*?)<\/sup>/gi, sup);
  s = s.replace(/<\/?[a-z][^>]*>/gi, '');
  s = s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]);
  s = s.replace(/\\ce\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, '$1').replace(/\$([^$\n]+?)\$/g, '$1');
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, '$1').replace(/\\\[([\s\S]+?)\\\]/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

export function matchAnswer(input, accepted, options = {}) {
  const opts = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const typed = answerForMatching(input, opts.mode);
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
  const answers = (accepted || []).map((a) => answerForMatching(a, opts.mode)).filter((a) => basicNormalize(a));
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
  result.closestIndex = closestAnswerIndex(typed, answers);
  const unit = unitDiagnostic(typed, answers[result.closestIndex]);
  if (unit) diagnostics.add(unit);
  result.diagnostics = [...diagnostics];
  return result;
}

const QUANTITY_RE = /^\s*([-+−]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:\s*(?:e|E)[-+]?\d+|\s*[×x*]\s*10\s*\^\s*\(?[-+]?\d+\)?)?)\s*(.*?)\s*$/;

/**
 * Number-with-unit answers ("3e8 m/s", "25 °C"): when the number is right
 * but the unit is missing or different, say so ("unit-missing" /
 * "unit-mismatch"). The answer is still marked wrong.
 */
export function unitDiagnostic(typed, expected) {
  if (!expected) return null;
  const e = QUANTITY_RE.exec(expected);
  const t = QUANTITY_RE.exec(typed);
  if (!e || !t || !e[2] || !/[A-Za-zµμ°Ω%‰]/.test(e[2])) return null;
  if (!compareMath(t[1], e[1], { equivalence: 'numeric' }).equal) return null;
  const norm = (u) => u.replace(/\s+/g, '').replace(/·|\*/g, '.');
  if (!t[2]) return 'unit-missing';
  if (norm(t[2]) !== norm(e[2])) return 'unit-mismatch';
  return null;
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
  return diffAnswer(basicNormalize(typed), basicNormalize(stripFormatting(answerForMatching(expected))));
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
  'unit-missing': 'Missing unit',
  'unit-mismatch': 'Different unit',
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
