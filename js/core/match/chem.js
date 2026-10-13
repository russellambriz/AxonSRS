/**
 * Chemistry notation parser and comparator.
 *
 * Equivalence is notation-only: Unicode subscripts vs ASCII digits,
 * superscript vs caret vs trailing ionic charges, middle dot vs period
 * for hydrates, arrow spellings, species order within one side of an
 * equation. Chemical identity is protected — element symbols (which are
 * case-sensitive: Co is not CO), atom counts, grouping and charges must
 * match exactly. Ambiguous input is rejected with an explanation rather
 * than guessed.
 */

export const ELEMENTS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr '
  + 'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg '
  + 'Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og D T').split(' '));

const SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };

export class ChemParseError extends Error {
  constructor(message, code = 'syntax') {
    super(message);
    this.code = code;
  }
}

const FORWARD_ARROWS = ['-->', '->', '→', '⟶', '=>', '⇒', '='];
const EQUILIBRIUM_ARROWS = ['<=>', '<-->', '<->', '⇌', '⇄', '↔', '⟷'];

function preprocess(input) {
  let s = String(input).normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => SUB[c]);
  // Superscript runs become caret charges; a leading superscript before an
  // element is an isotope mass number, e.g. ¹⁴C.
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, (run) => `^{${[...run].map((c) => SUP[c] ?? c).join('')}}`);
  s = s.replace(/[−–—]/g, '-').replace(/[·•∙⋅×*]/g, '.').replace(/\s+/g, ' ').trim();
  return s;
}

/** Split an equation into sides at the arrow. */
function splitEquation(s) {
  const arrows = [...EQUILIBRIUM_ARROWS.map((a) => [a, 'equilibrium']), ...FORWARD_ARROWS.map((a) => [a, 'forward'])];
  for (const [arrow, kind] of arrows) {
    const idx = s.indexOf(arrow);
    if (idx >= 0) {
      // "=" only counts as an arrow when it is not part of a caret charge.
      const left = s.slice(0, idx).trim();
      const right = s.slice(idx + arrow.length).trim();
      if (right.includes(arrow) && arrow !== '=') throw new ChemParseError('More than one reaction arrow', 'equation');
      return { left, right, arrow: kind };
    }
  }
  return null;
}

/**
 * Split one side into species. A "+" separates species when surrounded
 * by spaces, or when directly followed by a coefficient or an element and
 * not preceded by a charge context ("^", digit followed by sign).
 */
function splitSpecies(side) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < side.length; i++) {
    const ch = side[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === '+' && depth === 0) {
      const before = side[i - 1];
      const after = side[i + 1];
      const spaced = before === ' ' && after === ' ';
      const followedBySpecies = /^\d*\s*[A-Z([]/.test(side.slice(i + 1)) && before !== '^' && before !== '+' && current.trim().length > 0;
      const trailingChargeContext = /\^\{?[0-9]*$/.test(current);
      if (spaced || (followedBySpecies && !trailingChargeContext)) {
        parts.push(current.trim());
        current = '';
        if (after === ' ') i++;
        continue;
      }
    }
    current += ch;
  }
  parts.push(current.trim());
  if (parts.some((p) => !p)) throw new ChemParseError('Empty species around "+"', 'equation');
  return parts;
}

function parseCharge(body) {
  const b = body.replace(/[{}\s]/g, '');
  let m = /^(\d*)([+-])$/.exec(b);
  if (m) return (m[2] === '+' ? 1 : -1) * (m[1] ? Number(m[1]) : 1);
  m = /^([+-])(\d+)$/.exec(b);
  if (m) return (m[1] === '+' ? 1 : -1) * Number(m[2]);
  m = /^([+]+|[-]+)$/.exec(b);
  if (m) return (m[1][0] === '+' ? 1 : -1) * m[1].length;
  throw new ChemParseError(`Unreadable charge "${body}"`, 'charge');
}

/**
 * Parse a single species such as "2SO4^2-(aq)" or "CuSO4.5H2O".
 */
export function parseSpecies(raw) {
  let s = raw.trim();
  if (!s) throw new ChemParseError('Empty formula', 'empty');
  let coefficient = 1;
  const coeff = /^(\d+(?:\/\d+)?|\d*\.\d+)\s*(?=[A-Z([e])/.exec(s);
  if (coeff) {
    coefficient = coeff[1].includes('/') ? coeff[1] : Number(coeff[1]);
    s = s.slice(coeff[0].length);
  }
  let state = null;
  const stateMatch = /\((aq|s|l|g)\)$/i.exec(s);
  if (stateMatch) {
    state = stateMatch[1].toLowerCase();
    s = s.slice(0, -stateMatch[0].length).trim();
  }
  // Electrons
  if (/^e(\^?\{?-\}?|\^\{?1-\}?)$/.test(s) || s === 'e-') {
    return { coefficient, state, electron: true, parts: [], charge: -1, ambiguousCharge: false };
  }
  const hydrateParts = s.split(/\s*\.\s*(?=\d*[A-Z([])/);
  const parts = [];
  let charge = 0;
  let ambiguousCharge = false;
  let alternative = null;
  hydrateParts.forEach((partText, index) => {
    let text = partText;
    let multiplier = 1;
    if (index > 0) {
      const m = /^(\d+)/.exec(text);
      if (m) {
        multiplier = Number(m[1]);
        text = text.slice(m[1].length);
      }
    }
    const isLast = index === hydrateParts.length - 1;
    const parsed = parseFormulaPart(text, isLast);
    if (parsed.charge && !isLast) throw new ChemParseError('A charge can only appear at the end of a formula', 'charge');
    if (isLast) {
      charge = parsed.charge;
      ambiguousCharge = parsed.ambiguousCharge;
      if (parsed.alternative) alternative = { multiplier, ...parsed.alternative };
    }
    parts.push({ multiplier, groups: parsed.groups });
  });
  const species = { coefficient, state, electron: false, parts: stripOuterBrackets(parts), charge, ambiguousCharge, alternative: null };
  if (alternative) {
    const altParts = [...parts.slice(0, -1), { multiplier: alternative.multiplier, groups: alternative.groups }];
    species.alternative = { ...species, parts: stripOuterBrackets(altParts), charge: alternative.charge, ambiguousCharge: false, alternative: null };
  }
  return species;
}

/** Outer square brackets around a whole complex are notation only. */
function stripOuterBrackets(parts) {
  if (parts.length === 1 && parts[0].groups.length === 1) {
    const g = parts[0].groups[0];
    if (g.kind === 'group' && g.bracket === '[' && g.count === 1) return [{ ...parts[0], groups: g.items }];
  }
  return parts;
}

function parseFormulaPart(text, allowCharge) {
  let i = 0;
  let isotope = null;
  const stack = [{ items: [], bracket: null }];
  let charge = 0;
  let ambiguousCharge = false;
  let alternative = null;
  let lastCountText = '';
  const readCount = () => {
    const m = /^\d+/.exec(text.slice(i));
    if (!m) {
      lastCountText = '';
      return 1;
    }
    i += m[0].length;
    lastCountText = m[0];
    return Number(m[0]);
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ') {
      // "SO4 2-" — a space followed by a charge
      const rest = text.slice(i + 1);
      if (allowCharge && /^(\d*[+-]|[+-]\d*|[+]+|[-]+)$/.test(rest)) {
        charge = parseCharge(rest);
        i = text.length;
        break;
      }
      throw new ChemParseError('Unexpected space inside formula', 'syntax');
    }
    if (ch === '^') {
      i++;
      let body;
      if (text[i] === '{') {
        const close = text.indexOf('}', i);
        if (close < 0) throw new ChemParseError('Unclosed charge braces', 'charge');
        body = text.slice(i + 1, close);
        i = close + 1;
      } else {
        const m = /^(\d*[+-]+|[+-]\d*)/.exec(text.slice(i));
        if (!m) throw new ChemParseError('Charge expected after ^', 'charge');
        body = m[0];
        i += m[0].length;
      }
      // Isotope mass number before an element: ^{14}C
      if (/^\d+$/.test(body) && /[A-Z]/.test(text[i] || '')) {
        isotope = Number(body);
        continue;
      }
      if (!allowCharge) throw new ChemParseError('A charge can only appear at the end of a formula', 'charge');
      if (i < text.length) {
        const tail = text.slice(i);
        if (!/^\s*$/.test(tail)) throw new ChemParseError('Unexpected text after charge', 'charge');
      }
      charge = parseCharge(body);
      break;
    }
    if (ch === '(' || ch === '[') {
      // "(2-)" at the very end is a charge
      const m = /^\((\d*[+-]|[+-]\d*)\)$/.exec(text.slice(i));
      if (m && allowCharge) {
        charge = parseCharge(m[1]);
        i = text.length;
        break;
      }
      stack.push({ items: [], bracket: ch });
      i++;
      continue;
    }
    if (ch === ')' || ch === ']') {
      const top = stack.pop();
      if (!top || stack.length === 0 || (ch === ')' && top.bracket !== '(') || (ch === ']' && top.bracket !== '[')) {
        throw new ChemParseError('Unbalanced brackets', 'parens');
      }
      i++;
      const count = readCount();
      stack[stack.length - 1].items.push({ kind: 'group', bracket: top.bracket, items: top.items, count });
      continue;
    }
    if (/[A-Z]/.test(ch)) {
      let symbol = ch;
      if (/[a-z]/.test(text[i + 1] || '') && ELEMENTS.has(ch + text[i + 1])) symbol = ch + text[i + 1];
      else if (/[a-z]/.test(text[i + 1] || '') && !ELEMENTS.has(ch)) {
        throw new ChemParseError(`Unknown element "${ch + text[i + 1]}"`, 'element');
      }
      if (!ELEMENTS.has(symbol)) throw new ChemParseError(`Unknown element "${symbol}"`, 'element');
      i += symbol.length;
      const count = readCount();
      stack[stack.length - 1].items.push({ kind: 'el', symbol, count, isotope });
      isotope = null;
      continue;
    }
    if (ch === '+' || ch === '-') {
      if (!allowCharge) throw new ChemParseError('A charge can only appear at the end of a formula', 'charge');
      const rest = text.slice(i);
      if (!/^([+]+|[-]+|[+-]\d+)$/.test(rest)) throw new ChemParseError(`Unexpected "${ch}"`, 'syntax');
      charge = parseCharge(rest);
      // "Fe3+", "SO42-", "NH4+": digits right before a bare sign are read as
      // a count (primary reading), and an alternative reading treats the last
      // digit as the charge magnitude. compareChem accepts the alternative
      // only when it is the one that matches, and says so.
      const items = stack[0].items;
      const last = items[items.length - 1];
      if (last && lastCountText && /^[+-]$/.test(rest) && /\d$/.test(text.slice(0, i)) && lastCountText.slice(-1) !== '0') {
        ambiguousCharge = true;
        const altLast = { ...last, count: Number(lastCountText.slice(0, -1) || 1) };
        alternative = { groups: [...items.slice(0, -1), altLast], charge: (rest === '+' ? 1 : -1) * Number(lastCountText.slice(-1)) };
      }
      i = text.length;
      break;
    }
    if (/[a-z]/.test(ch)) throw new ChemParseError(`Element symbols start with a capital letter ("${ch}")`, 'element-case');
    throw new ChemParseError(`Unexpected "${ch}"`, 'syntax');
  }
  if (stack.length !== 1) throw new ChemParseError('Unbalanced brackets', 'parens');
  if (!stack[0].items.length) throw new ChemParseError('No elements found', 'empty');
  return { groups: stack[0].items, charge, ambiguousCharge, alternative };
}

function groupKey(items) {
  return items.map((it) => (it.kind === 'el'
    ? `${it.isotope ? `[${it.isotope}]` : ''}${it.symbol}${it.count === 1 ? '' : it.count}`
    : `${it.bracket}${groupKey(it.items)}${it.bracket === '(' ? ')' : ']'}${it.count === 1 ? '' : it.count}`)).join('');
}

export function speciesKey(sp, { includeState = true, includeCoefficient = true } = {}) {
  const body = sp.electron ? 'e' : sp.parts.map((p) => `${p.multiplier === 1 ? '' : p.multiplier}${groupKey(p.groups)}`).join('.');
  const charge = sp.charge ? `^${Math.abs(sp.charge)}${sp.charge > 0 ? '+' : '-'}` : '';
  const coeff = includeCoefficient && sp.coefficient !== 1 ? `${sp.coefficient}` : '';
  const state = includeState && sp.state ? `(${sp.state})` : '';
  return `${coeff}${body}${charge}${state}`;
}

export function atomCounts(sp) {
  const counts = {};
  const walk = (items, mult) => {
    for (const it of items) {
      if (it.kind === 'el') counts[it.symbol] = (counts[it.symbol] || 0) + it.count * mult;
      else walk(it.items, mult * it.count);
    }
  };
  for (const p of sp.parts) walk(p.groups, p.multiplier);
  return counts;
}

export function parseChem(input) {
  const s = preprocess(input);
  if (!s) throw new ChemParseError('Empty answer', 'empty');
  const eq = splitEquation(s);
  if (eq) {
    if (!eq.left || !eq.right) throw new ChemParseError('An equation needs both sides', 'equation');
    return {
      kind: 'equation',
      arrow: eq.arrow,
      left: splitSpecies(eq.left).map(parseSpecies),
      right: splitSpecies(eq.right).map(parseSpecies),
    };
  }
  const species = splitSpecies(s);
  if (species.length > 1) return { kind: 'list', items: species.map(parseSpecies) };
  return { kind: 'species', species: parseSpecies(s) };
}

function sideKey(list, opts) {
  return list.map((sp) => speciesKey(sp, opts)).sort().join(' + ');
}

function sameAtoms(a, b) {
  const x = atomCounts(a);
  const y = atomCounts(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if ((x[k] || 0) !== (y[k] || 0)) return false;
  return true;
}

function speciesDiagnostics(user, expected) {
  const d = [];
  if (user.ambiguousCharge) d.push('ambiguous-charge');
  if (user.alternative) user = { ...user.alternative, ambiguousCharge: true };
  const bodyU = speciesKey({ ...user, charge: 0 }, { includeState: false, includeCoefficient: false });
  const bodyE = speciesKey({ ...expected, charge: 0 }, { includeState: false, includeCoefficient: false });
  if (bodyU === bodyE) {
    if (user.charge !== expected.charge) {
      if (user.charge === -expected.charge && user.charge !== 0) d.push('charge-sign');
      else if (user.charge === 0) d.push('charge-missing');
      else d.push('charge-mismatch');
    }
    if (expected.state && user.state !== expected.state) d.push(user.state ? 'state-mismatch' : 'state-missing');
    if (user.coefficient !== expected.coefficient) d.push('coefficient-mismatch');
  } else if (!user.electron && !expected.electron) {
    const ua = atomCounts(user);
    const ea = atomCounts(expected);
    const ue = Object.keys(ua).sort().join();
    const ee = Object.keys(ea).sort().join();
    if (ue !== ee) d.push('element-mismatch');
    else if (sameAtoms(user, expected)) d.push('arrangement-differs');
    else d.push('atom-count');
    if (user.charge !== expected.charge) d.push(user.charge === -expected.charge && user.charge ? 'charge-sign' : 'charge-mismatch');
  }
  return d;
}

/**
 * Compare a user answer with one accepted chemistry answer.
 */
export function compareChem(userInput, expectedInput) {
  let expected;
  let user;
  try {
    expected = parseChem(expectedInput);
  } catch (err) {
    return { equal: false, method: 'unparseable-expected', diagnostics: [], expectedError: err };
  }
  try {
    user = parseChem(userInput);
  } catch (err) {
    const diag = err.code === 'element-case' || err.code === 'element' ? 'element-case' : err.code === 'parens' ? 'unbalanced-parentheses' : 'unreadable-formula';
    // Detect case-only errors: "so4" for "SO4" is a different identity, never accepted.
    return { equal: false, method: 'unparseable-user', diagnostics: [diag], error: err };
  }
  if (expected.kind !== user.kind) {
    return { equal: false, method: 'none', diagnostics: [expected.kind === 'equation' ? 'not-an-equation' : 'structure-mismatch'] };
  }
  if (expected.kind === 'species') {
    const e = expected.species;
    const u = user.species;
    const eKey = speciesKey(e);
    const keyFor = (sp) => speciesKey(e.state ? sp : { ...sp, state: null });
    if (keyFor(u) === eKey) return { equal: true, method: 'chem', diagnostics: [] };
    if (u.alternative && keyFor(u.alternative) === eKey) {
      return { equal: true, method: 'chem', diagnostics: [], warnings: ['ambiguous-charge-read'] };
    }
    return { equal: false, method: 'none', diagnostics: speciesDiagnostics(u, e) };
  }
  if (expected.kind === 'list') {
    const ek = sideKey(expected.items);
    const uk = sideKey(resolveAlternatives(user.items, expected.items, {}, []));
    return ek === uk ? { equal: true, method: 'chem', diagnostics: [] } : { equal: false, method: 'none', diagnostics: [] };
  }
  // Equation
  const stripStates = !hasStates(expected);
  const opts = { includeState: !stripStates };
  const warnings = [];
  user = {
    ...user,
    left: resolveAlternatives(user.left, expected.left, opts, warnings),
    right: resolveAlternatives(user.right, expected.right, opts, warnings),
  };
  const el = sideKey(expected.left, opts);
  const er = sideKey(expected.right, opts);
  const ul = sideKey(user.left, opts);
  const ur = sideKey(user.right, opts);
  const diagnostics = [];
  if (user.arrow !== expected.arrow) diagnostics.push('arrow-mismatch');
  if (el === ul && er === ur && !diagnostics.length) return { equal: true, method: 'chem', diagnostics: [], warnings };
  if (el === ur && er === ul) diagnostics.push('sides-swapped');
  const noCoeff = { includeState: !stripStates, includeCoefficient: false };
  if (sideKey(expected.left, noCoeff) === sideKey(user.left, noCoeff) && sideKey(expected.right, noCoeff) === sideKey(user.right, noCoeff) && (el !== ul || er !== ur)) {
    diagnostics.push('coefficient-mismatch');
  }
  // Pairwise species diagnostics for charge errors
  const pairs = [...pairSpecies(user.left, expected.left), ...pairSpecies(user.right, expected.right)];
  for (const [u, e] of pairs) for (const d of speciesDiagnostics(u, e)) if (d.startsWith('charge') && !diagnostics.includes(d)) diagnostics.push(d);
  return { equal: false, method: 'none', diagnostics };
}

function resolveAlternatives(userList, expectedList, opts, warnings) {
  const expectedKeys = new Set(expectedList.map((sp) => speciesKey(sp, opts)));
  return userList.map((sp) => {
    if (sp.alternative && !expectedKeys.has(speciesKey(sp, opts)) && expectedKeys.has(speciesKey(sp.alternative, opts))) {
      if (!warnings.includes('ambiguous-charge-read')) warnings.push('ambiguous-charge-read');
      return sp.alternative;
    }
    return sp;
  });
}

function hasStates(eq) {
  return [...eq.left, ...eq.right].some((s) => s.state);
}

function pairSpecies(userList, expectedList) {
  const pairs = [];
  const used = new Set();
  for (const e of expectedList) {
    const body = speciesKey({ ...e, charge: 0 }, { includeState: false, includeCoefficient: false });
    const idx = userList.findIndex((u, i) => !used.has(i) && speciesKey({ ...u, charge: 0 }, { includeState: false, includeCoefficient: false }) === body);
    if (idx >= 0) {
      used.add(idx);
      pairs.push([userList[idx], e]);
    }
  }
  return pairs;
}

/**
 * Convert typed chemistry to an mhchem string for KaTeX preview. Only
 * characters that mhchem understands are kept; backslashes and braces
 * from user input are removed so input cannot inject TeX commands.
 */
export function toMhchem(input) {
  const s = preprocess(input).replace(/[\\]/g, '');
  return s.replace(/\^\{([^}]*)\}/g, '^$1').replace(/[{}]/g, '');
}
