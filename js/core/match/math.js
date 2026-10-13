/**
 * Mathematics notation parser, canonicaliser, evaluator and LaTeX printer.
 *
 * Matching philosophy: two answers are "notation-equivalent" when they
 * describe the same expression tree after sound, purely notational
 * rewrites (Unicode vs ASCII, LaTeX vs plain, redundant parentheses,
 * commutative ordering, a-b = a+(-1)b, a/b = a*b^-1, sqrt(x) = x^(1/2),
 * scientific notation). No arithmetic simplification is performed in
 * that mode, so "2/4" is NOT accepted for "1/2" unless the card enables
 * numeric equivalence.
 *
 * Optional modes:
 *  - numeric:   constant expressions compared by value (1/2 = 0.5).
 *  - algebraic: expressions with variables compared at deterministic
 *               pseudo-random points. This is probabilistic evidence, not
 *               a proof, and is labelled as such in match results.
 */

import { seededRandom } from '../util.js';

export const GREEK = Object.freeze({
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
});

const GREEK_CHAR_TO_NAME = (() => {
  const map = {};
  for (const [name, ch] of Object.entries(GREEK)) if (!map[ch]) map[ch] = name;
  map['µ'] = 'mu';
  map['ϕ'] = 'phi';
  map['ϵ'] = 'epsilon';
  return map;
})();

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'arsinh', 'arcosh', 'artanh', 'asinh', 'acosh', 'atanh',
  'ln', 'log', 'exp', 'sqrt', 'cbrt', 'abs', 'floor', 'ceil', 'max', 'min', 'sgn',
]);
const FUNCTION_ALIASES = { asin: 'arcsin', acos: 'arccos', atan: 'arctan', asinh: 'arsinh', acosh: 'arcosh', atanh: 'artanh' };
const INVERSE_TRIG = { sin: 'arcsin', cos: 'arccos', tan: 'arctan', sinh: 'arsinh', cosh: 'arcosh', tanh: 'artanh' };
const CONSTANTS = new Set(['pi', 'e', 'inf', 'deg']);
const KNOWN_NAMES = [...FUNCTIONS, ...Object.keys(GREEK), 'inf', 'infty'].sort((a, b) => b.length - a.length);

const SUPERSCRIPTS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i', 'ˣ': 'x' };
const SUBSCRIPTS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x', 'ₙ': 'n', 'ᵢ': 'i', 'ⱼ': 'j', 'ₖ': 'k', 'ₘ': 'm', 'ₜ': 't' };
const VULGAR = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };

const LATEX_SYMBOLS = {
  cdot: '*', times: '*', ast: '*', div: '/', pm: '±', mp: '∓', infty: 'inf', leq: '<=', le: '<=', geq: '>=', ge: '>=',
  neq: '!=', ne: '!=', lt: '<', gt: '>', degree: '°', circ: '°', to: '->',
};
const LATEX_IGNORED = new Set(['left', 'right', 'displaystyle', 'textstyle', 'big', 'Big', 'bigl', 'bigr', 'Bigl', 'Bigr', ',', ';', ':', '!', ' ', 'quad', 'qquad', 'mathrm', 'mathit', 'text', 'operatorname', 'mathbf']);

export class MathParseError extends Error {
  constructor(message, code = 'syntax') {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Preprocessing and tokenising                                        */
/* ------------------------------------------------------------------ */

function preprocess(input) {
  let s = String(input).normalize('NFC');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  // Mixed numbers like 1½ mean 1 + 1/2.
  s = s.replace(/(\d)([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_, d, f) => `(${d}+${VULGAR[f]})`);
  s = s.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (f) => `(${VULGAR[f]})`);
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱˣ]+/g, (run) => `^(${[...run].map((c) => SUPERSCRIPTS[c]).join('')})`);
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₙᵢⱼₖₘₜ]+/g, (run) => `_(${[...run].map((c) => SUBSCRIPTS[c]).join('')})`);
  s = s
    .replace(/[×⋅·∙✕]/g, '*')
    .replace(/÷/g, '/')
    .replace(/[−–—‐‑]/g, '-')
    .replace(/∗/g, '*')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=')
    .replace(/≠/g, '!=')
    .replace(/∞/g, ' inf ')
    .replace(/\*\*/g, '^')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')');
  return s;
}

function tokenize(input) {
  const s = preprocess(input);
  const tokens = [];
  let i = 0;
  const push = (t, v, extra) => tokens.push({ t, v, pos: i, ...extra });
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m || m[0] === '.') throw new MathParseError(`Unexpected "." at position ${i + 1}`);
      // Avoid swallowing "2e" (2 times e) — the regex requires digits after e.
      push('num', m[0]);
      i += m[0].length;
      continue;
    }
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      if (!m) throw new MathParseError('Dangling backslash');
      const cmd = m[1];
      i += m[0].length;
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') { push('frac'); continue; }
      if (cmd === 'sqrt') { push('sqrt'); continue; }
      if (cmd === '{') { push('(', '{'); continue; }
      if (cmd === '}') { push(')', '}'); continue; }
      if (cmd === '|') { push('|'); continue; }
      if (LATEX_IGNORED.has(cmd)) {
        if (cmd === 'left' || cmd === 'right') {
          // \left. / \right. are invisible delimiters
          if (s[i] === '.') i++;
        }
        continue;
      }
      if (cmd in LATEX_SYMBOLS) {
        const v = LATEX_SYMBOLS[cmd];
        if (v === '*' || v === '/' || v === '±' || v === '∓') push('op', v);
        else if (v === 'inf') push('id', 'inf');
        else if (v === '°') push('op', '°');
        else if (v === '->') throw new MathParseError('Arrows are not supported in mathematics mode', 'unsupported');
        else push('rel', v);
        continue;
      }
      if (cmd in GREEK) { push('id', cmd === 'varepsilon' ? 'epsilon' : cmd === 'vartheta' ? 'theta' : cmd === 'varphi' ? 'phi' : cmd); continue; }
      if (FUNCTIONS.has(cmd)) { push('fn', FUNCTION_ALIASES[cmd] || cmd); continue; }
      throw new MathParseError(`Unsupported command \\${cmd}`, 'unsupported');
    }
    if (GREEK_CHAR_TO_NAME[ch]) { push('id', GREEK_CHAR_TO_NAME[ch]); i++; continue; }
    if (/[A-Za-z]/.test(ch)) {
      const m = /^[A-Za-z]+/.exec(s.slice(i));
      splitIdentifier(m[0]).forEach((part) => {
        if (FUNCTIONS.has(part)) push('fn', FUNCTION_ALIASES[part] || part);
        else push('id', part === 'infty' ? 'inf' : part);
      });
      i += m[0].length;
      continue;
    }
    if (ch === '√') { push('sqrt'); i++; continue; }
    if (ch === '∛') { push('cbrt'); i++; continue; }
    if (ch === '∜') { push('root4'); i++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { push('(', ch); i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { push(')', ch); i++; continue; }
    if (ch === '|') { push('|'); i++; continue; }
    if (ch === ',') { push(','); i++; continue; }
    if (ch === '<' || ch === '>' || ch === '=' || ch === '!') {
      const two = s.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '!=' || two === '==') {
        push('rel', two === '==' ? '=' : two);
        i += 2;
        continue;
      }
      if (ch === '!') { push('op', '!'); i++; continue; }
      push('rel', ch);
      i++;
      continue;
    }
    if ('+-*/^_%'.includes(ch)) { push('op', ch); i++; continue; }
    if (ch === '±' || ch === '∓' || ch === '°') { push('op', ch); i++; continue; }
    throw new MathParseError(`Unrecognised symbol "${ch}"`, 'symbol');
  }
  return tokens;
}

/** Split a run of letters into known names and single-letter symbols. */
function splitIdentifier(run) {
  if (FUNCTIONS.has(run) || run in GREEK || CONSTANTS.has(run) || run === 'infty') return [run];
  const parts = [];
  let i = 0;
  while (i < run.length) {
    const match = KNOWN_NAMES.find((name) => run.startsWith(name, i));
    if (match) {
      parts.push(match);
      i += match.length;
    } else {
      parts.push(run[i]);
      i++;
    }
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/* Parser (Pratt)                                                      */
/* ------------------------------------------------------------------ */

const CLOSERS = { '(': ')', '[': ']', '{': '}' };

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
    this.absDepth = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.i + offset];
  }

  next() {
    return this.tokens[this.i++];
  }

  atEnd() {
    return this.i >= this.tokens.length;
  }

  parseTop() {
    if (!this.tokens.length) throw new MathParseError('Empty expression', 'empty');
    const node = this.parseList();
    if (!this.atEnd()) {
      const tok = this.peek();
      if (tok.t === ')') throw new MathParseError('Unbalanced parentheses: unexpected closing bracket', 'parens');
      throw new MathParseError(`Unexpected "${tok.v || tok.t}"`);
    }
    return node;
  }

  parseList() {
    const items = [this.parseRelation()];
    while (this.peek() && this.peek().t === ',') {
      this.next();
      items.push(this.parseRelation());
    }
    return items.length > 1 ? { k: 'tuple', items } : items[0];
  }

  parseRelation() {
    let left = this.parseExpr(0);
    while (this.peek() && this.peek().t === 'rel') {
      const op = this.next().v;
      const right = this.parseExpr(0);
      left = { k: 'rel', op, a: left, b: right };
    }
    return left;
  }

  startsOperand(tok) {
    if (!tok) return false;
    if (tok.t === '|') return this.absDepth === 0;
    return ['num', 'id', 'fn', '(', 'sqrt', 'cbrt', 'root4', 'frac'].includes(tok.t);
  }

  parseExpr(minBp) {
    let left = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
        if (10 < minBp) break;
        this.next();
        const right = this.parseExpr(11);
        left = { k: tok.v === '+' ? 'add' : 'sub', a: left, b: right };
        continue;
      }
      if (tok.t === 'op' && (tok.v === '±' || tok.v === '∓')) {
        if (10 < minBp) break;
        this.next();
        const right = this.parseExpr(11);
        left = { k: 'pm', a: left, b: right, sign: tok.v };
        continue;
      }
      if (tok.t === 'op' && (tok.v === '*' || tok.v === '/')) {
        if (20 < minBp) break;
        this.next();
        const right = this.parseExpr(21);
        left = { k: tok.v === '*' ? 'mul' : 'div', a: left, b: right };
        continue;
      }
      if (tok.t === 'op' && tok.v === '^') {
        if (30 < minBp) break;
        this.next();
        const right = this.parseExpr(30);
        left = { k: 'pow', a: left, b: right };
        continue;
      }
      if (tok.t === 'op' && (tok.v === '!' || tok.v === '%' || tok.v === '°')) {
        if (40 < minBp) break;
        this.next();
        left = { k: tok.v === '!' ? 'fact' : tok.v === '%' ? 'pct' : 'deg', a: left };
        continue;
      }
      if (this.startsOperand(tok)) {
        if (22 < minBp) break;
        const right = this.parseExpr(23);
        left = { k: 'mul', a: left, b: right, implicit: true };
        continue;
      }
      break;
    }
    return left;
  }

  parsePrefix() {
    const tok = this.next();
    if (!tok) throw new MathParseError('Expression ends unexpectedly', 'incomplete');
    switch (tok.t) {
      case 'op':
        if (tok.v === '-') return { k: 'neg', a: this.parseExpr(25) };
        if (tok.v === '+') return this.parseExpr(25);
        if (tok.v === '±' || tok.v === '∓') return { k: 'pm1', a: this.parseExpr(25), sign: tok.v };
        throw new MathParseError(`Unexpected operator "${tok.v}"`);
      case 'num':
        return { k: 'num', v: tok.v };
      case 'id':
        return this.parseSubscript({ k: 'sym', name: tok.v });
      case 'fn':
        return this.parseFunction(tok.v);
      case '(': {
        if (this.peek() && this.peek().t === ')') throw new MathParseError('Empty parentheses', 'parens');
        const inner = this.parseList();
        this.expectClose(tok.v);
        return { k: 'group', a: inner, bracket: tok.v };
      }
      case '|': {
        this.absDepth++;
        const inner = this.parseExpr(0);
        const close = this.next();
        this.absDepth--;
        if (!close || close.t !== '|') throw new MathParseError('Unclosed absolute value bars', 'parens');
        return { k: 'fn', name: 'abs', args: [inner] };
      }
      case 'frac': {
        const a = this.parseGroupArgument();
        const b = this.parseGroupArgument();
        return { k: 'div', a, b, frac: true };
      }
      case 'sqrt': {
        let index = null;
        const p = this.peek();
        if (p && p.t === '(' && p.v === '[') {
          this.next();
          index = this.parseExpr(0);
          this.expectClose('[');
        }
        const arg = this.parseRadicand();
        return index ? { k: 'root', index, a: arg } : { k: 'fn', name: 'sqrt', args: [arg] };
      }
      case 'cbrt':
        return { k: 'root', index: { k: 'num', v: '3' }, a: this.parseRadicand() };
      case 'root4':
        return { k: 'root', index: { k: 'num', v: '4' }, a: this.parseRadicand() };
      case ')':
        throw new MathParseError('Unbalanced parentheses: unexpected closing bracket', 'parens');
      case 'rel':
        throw new MathParseError(`Unexpected "${tok.v}"`);
      case ',':
        throw new MathParseError('Unexpected comma');
      default:
        throw new MathParseError('Unexpected token');
    }
  }

  parseRadicand() {
    const p = this.peek();
    if (p && p.t === '(') return this.parsePrefix();
    // √x^2 means sqrt(x^2); √3x means sqrt(3)·x.
    return this.parseExpr(29);
  }

  parseGroupArgument() {
    const p = this.peek();
    if (!p) throw new MathParseError('\\frac needs two arguments', 'incomplete');
    if (p.t === '(') {
      this.next();
      const inner = this.parseList();
      this.expectClose(p.v);
      return { k: 'group', a: inner, bracket: p.v };
    }
    // \frac12 style single-token arguments
    if (p.t === 'num' && p.v.length > 1 && /^\d+$/.test(p.v)) {
      this.next();
      const first = { k: 'num', v: p.v[0] };
      this.tokens.splice(this.i, 0, { t: 'num', v: p.v.slice(1) });
      return first;
    }
    return this.parsePrefix();
  }

  parseSubscript(node) {
    const p = this.peek();
    if (p && p.t === 'op' && p.v === '_') {
      this.next();
      const q = this.next();
      if (!q) throw new MathParseError('Subscript is missing', 'incomplete');
      let sub;
      if (q.t === 'num' || q.t === 'id') sub = q.v;
      else if (q.t === '(') {
        const parts = [];
        while (this.peek() && this.peek().t !== ')') {
          const t = this.next();
          parts.push(t.v ?? t.t);
        }
        this.expectClose(q.v);
        sub = parts.join('');
      } else throw new MathParseError('Invalid subscript');
      return { ...node, name: `${node.name}_${sub}` };
    }
    return node;
  }

  parseFunction(name) {
    let base = null;
    let power = null;
    let p = this.peek();
    if (p && p.t === 'op' && p.v === '_' && name === 'log') {
      this.next();
      base = this.parsePrefix();
      p = this.peek();
    }
    if (p && p.t === 'op' && p.v === '^') {
      this.next();
      power = this.parsePrefix();
      p = this.peek();
    }
    let args;
    if (p && p.t === '(' && p.v !== '[') {
      this.next();
      args = [];
      if (this.peek() && this.peek().t === ')') throw new MathParseError(`${name}() needs an argument`, 'incomplete');
      args.push(this.parseRelation());
      while (this.peek() && this.peek().t === ',') {
        this.next();
        args.push(this.parseRelation());
      }
      this.expectClose(p.v);
    } else {
      if (!this.peek()) throw new MathParseError(`${name} needs an argument`, 'incomplete');
      args = [this.parseExpr(21)];
    }
    let node = { k: 'fn', name, args };
    if (base) node.base = base;
    if (power) {
      const p0 = power.k === 'group' ? power.a : power;
      const isMinusOne = p0.k === 'neg' && p0.a.k === 'num' && Number(p0.a.v) === 1;
      if (isMinusOne && INVERSE_TRIG[name]) node = { k: 'fn', name: INVERSE_TRIG[name], args };
      else node = { k: 'pow', a: node, b: power, fnPower: true };
    }
    return node;
  }

  expectClose(open) {
    const tok = this.next();
    if (!tok || tok.t !== ')') throw new MathParseError('Unbalanced parentheses: missing closing bracket', 'parens');
    const expected = CLOSERS[open] || ')';
    if (tok.v !== expected && !(open === '{' && tok.v === '}')) {
      throw new MathParseError(`Mismatched brackets: "${open}" closed by "${tok.v}"`, 'parens');
    }
  }
}

export function parseMath(input) {
  return new Parser(tokenize(input)).parseTop();
}

/* ------------------------------------------------------------------ */
/* Canonicalisation                                                     */
/* ------------------------------------------------------------------ */

const NUM = (v, decimal = false, exp10 = null) => (exp10 === null ? { k: 'num', value: v, decimal } : { k: 'num', value: v, decimal, exp10 });
const MINUS_ONE = NUM(-1);

function isNum(n, v) {
  return n.k === 'num' && (v === undefined || n.value === v);
}

export function canonicalize(node) {
  switch (node.k) {
    case 'group':
      return canonicalize(node.a);
    case 'num': {
      const raw = String(node.v ?? node.value);
      return NUM(Number(raw), /[.eE]/.test(raw));
    }
    case 'sym':
      return { k: 'sym', name: node.name === 'infty' ? 'inf' : node.name };
    case 'neg':
      return makeMul([MINUS_ONE, canonicalize(node.a)]);
    case 'add':
      return makeAdd([canonicalize(node.a), canonicalize(node.b)]);
    case 'sub':
      return makeAdd([canonicalize(node.a), makeMul([MINUS_ONE, canonicalize(node.b)])]);
    case 'mul':
      return makeMul([canonicalize(node.a), canonicalize(node.b)]);
    case 'div':
      return makeMul([canonicalize(node.a), makePow(canonicalize(node.b), MINUS_ONE)]);
    case 'pow':
      return makePow(canonicalize(node.a), canonicalize(node.b));
    case 'root':
      return makePow(canonicalize(node.a), makePow(canonicalize(node.index), MINUS_ONE));
    case 'pm':
      return makeAdd([canonicalize(node.a), { k: 'fn', name: node.sign === '∓' ? 'mp' : 'pm', args: [canonicalize(node.b)] }]);
    case 'pm1':
      return { k: 'fn', name: node.sign === '∓' ? 'mp' : 'pm', args: [canonicalize(node.a)] };
    case 'fact':
      return { k: 'fn', name: 'fact', args: [canonicalize(node.a)] };
    case 'pct':
      return makeMul([canonicalize(node.a), makePow(NUM(100), MINUS_ONE)]);
    case 'deg':
      return makeMul([canonicalize(node.a), { k: 'sym', name: 'deg' }]);
    case 'fn': {
      const name = FUNCTION_ALIASES[node.name] || node.name;
      const args = node.args.map(canonicalize);
      if (name === 'sqrt') return makePow(args[0], makePow(NUM(2), MINUS_ONE));
      if (name === 'cbrt') return makePow(args[0], makePow(NUM(3), MINUS_ONE));
      if (name === 'exp') return makePow({ k: 'sym', name: 'e' }, args[0]);
      if (name === 'log' && node.base) {
        const base = canonicalize(node.base);
        if (base.k === 'sym' && base.name === 'e') return { k: 'fn', name: 'ln', args };
        return { k: 'fn', name: 'log', args, base };
      }
      return { k: 'fn', name, args };
    }
    case 'rel': {
      let { op } = node;
      let a = canonicalize(node.a);
      let b = canonicalize(node.b);
      if (op === '>' || op === '>=') {
        [a, b] = [b, a];
        op = op === '>' ? '<' : '<=';
      }
      if (op === '=' || op === '!=') {
        if (keyOf(a) > keyOf(b)) [a, b] = [b, a];
      }
      return { k: 'rel', op, a, b };
    }
    case 'tuple':
      return { k: 'tuple', items: node.items.map(canonicalize) };
    default:
      throw new MathParseError(`Unknown node ${node.k}`);
  }
}

function makeAdd(terms) {
  const flat = [];
  for (const t of terms) {
    if (t.k === 'add') flat.push(...t.terms);
    else if (!isNum(t, 0)) flat.push(t);
  }
  if (!flat.length) return NUM(0);
  if (flat.length === 1) return flat[0];
  flat.sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
  return { k: 'add', terms: flat };
}

function makeMul(factors) {
  const flat = [];
  for (const f of factors) {
    if (f.k === 'mul') flat.push(...f.factors);
    else flat.push(f);
  }
  let negative = false;
  const rest = [];
  for (const f of flat) {
    if (isNum(f, -1)) negative = !negative;
    else if (isNum(f, 1)) continue;
    else rest.push(f);
  }
  // Scientific notation: a × 10^n with a literal a and integer n is one number.
  for (;;) {
    const p10 = rest.findIndex((f) => f.k === 'num' && f.exp10 != null);
    if (p10 < 0) break;
    const coeffIndex = rest.findIndex((g, j) => j !== p10 && g.k === 'num' && g.exp10 == null);
    if (coeffIndex < 0) {
      rest[p10] = NUM(rest[p10].value, true);
      break;
    }
    const value = Number(`${rest[coeffIndex].value}e${rest[p10].exp10}`);
    const keep = rest.filter((_, j) => j !== p10 && j !== coeffIndex);
    rest.length = 0;
    rest.push(NUM(value, true), ...keep);
  }
  if (negative) {
    const idx = rest.findIndex((f) => f.k === 'num');
    if (idx >= 0) rest[idx] = NUM(-rest[idx].value, rest[idx].decimal);
    else rest.unshift(MINUS_ONE);
  }
  if (!rest.length) return NUM(1);
  if (rest.length === 1) return rest[0];
  rest.sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
  return { k: 'mul', factors: rest };
}

function makePow(base, exp) {
  if (isNum(exp, 1)) return base;
  // Powers of ten with integer exponents are scientific notation.
  if (isNum(base, 10) && exp.k === 'num' && Number.isInteger(exp.value) && Math.abs(exp.value) <= 300) {
    return NUM(Number(`1e${exp.value}`), true, exp.value);
  }
  return { k: 'pow', base, exp };
}

function formatNumber(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const s = v.toPrecision(12);
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return `${m.replace(/\.?0+$/, '')}e${e}`;
  }
  return s.replace(/\.?0+$/, '');
}

/** Stable string key for a canonical node. */
export function keyOf(node) {
  if (node._key) return node._key;
  let key;
  switch (node.k) {
    case 'num': key = `n:${formatNumber(node.value)}`; break;
    case 'sym': key = `s:${node.name}`; break;
    case 'add': key = `add(${node.terms.map(keyOf).join(',')})`; break;
    case 'mul': key = `mul(${node.factors.map(keyOf).join(',')})`; break;
    case 'pow': key = `pow(${keyOf(node.base)},${keyOf(node.exp)})`; break;
    case 'fn': key = `fn:${node.name}(${node.args.map(keyOf).join(',')}${node.base ? `;b=${keyOf(node.base)}` : ''})`; break;
    case 'rel': key = `rel:${node.op}(${keyOf(node.a)},${keyOf(node.b)})`; break;
    case 'tuple': key = `tup(${node.items.map(keyOf).join(',')})`; break;
    default: key = `?${node.k}`;
  }
  Object.defineProperty(node, '_key', { value: key, enumerable: false });
  return key;
}

export function canonicalKey(input) {
  return keyOf(canonicalize(parseMath(input)));
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                           */
/* ------------------------------------------------------------------ */

function factorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

const FN_IMPL = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, arsinh: Math.asinh, arcosh: Math.acosh, artanh: Math.atanh,
  ln: Math.log, exp: Math.exp, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  sgn: Math.sign, fact: factorial,
};

/** Evaluate a canonical node numerically. Unknown symbols come from env. */
export function evaluate(node, env = {}) {
  switch (node.k) {
    case 'num': return node.value;
    case 'sym':
      if (node.name in env) return env[node.name];
      if (node.name === 'pi') return Math.PI;
      if (node.name === 'e') return Math.E;
      if (node.name === 'inf') return Infinity;
      if (node.name === 'deg') return Math.PI / 180;
      return NaN;
    case 'add': return node.terms.reduce((s, t) => s + evaluate(t, env), 0);
    case 'mul': return node.factors.reduce((p, f) => p * evaluate(f, env), 1);
    case 'pow': {
      const b = evaluate(node.base, env);
      const e = evaluate(node.exp, env);
      // Real odd roots of negative numbers (e.g. cube root of -8).
      if (b < 0 && !Number.isInteger(e)) {
        const inv = 1 / e;
        if (Number.isInteger(Math.round(inv)) && Math.abs(inv - Math.round(inv)) < 1e-9 && Math.round(inv) % 2 !== 0) {
          return -Math.pow(-b, e);
        }
      }
      return Math.pow(b, e);
    }
    case 'fn': {
      const args = node.args.map((a) => evaluate(a, env));
      if (node.name === 'log') {
        const base = node.base ? evaluate(node.base, env) : 10;
        return Math.log(args[0]) / Math.log(base);
      }
      if (node.name === 'max') return Math.max(...args);
      if (node.name === 'min') return Math.min(...args);
      if (node.name === 'pm' || node.name === 'mp') return NaN;
      const impl = FN_IMPL[node.name];
      return impl ? impl(args[0]) : NaN;
    }
    default:
      return NaN;
  }
}

export function freeSymbols(node, out = new Set()) {
  switch (node.k) {
    case 'sym':
      if (!CONSTANTS.has(node.name)) out.add(node.name);
      break;
    case 'add': node.terms.forEach((t) => freeSymbols(t, out)); break;
    case 'mul': node.factors.forEach((t) => freeSymbols(t, out)); break;
    case 'pow': freeSymbols(node.base, out); freeSymbols(node.exp, out); break;
    case 'fn': node.args.forEach((t) => freeSymbols(t, out)); if (node.base) freeSymbols(node.base, out); break;
    case 'rel': freeSymbols(node.a, out); freeSymbols(node.b, out); break;
    case 'tuple': node.items.forEach((t) => freeSymbols(t, out)); break;
    default: break;
  }
  return out;
}

function children(node) {
  switch (node.k) {
    case 'add': return node.terms;
    case 'mul': return node.factors;
    case 'tuple': return node.items;
    case 'pow': return [node.base, node.exp];
    case 'rel': return [node.a, node.b];
    case 'fn': return node.base ? [...node.args, node.base] : node.args;
    default: return [];
  }
}

function hasPlusMinus(node) {
  if (node.k === 'fn' && (node.name === 'pm' || node.name === 'mp')) return true;
  return children(node).some(hasPlusMinus);
}

/** Additive inverse with the sign pushed into sums and coefficients. */
function negate(node) {
  if (node.k === 'num') return NUM(-node.value, node.decimal);
  if (node.k === 'add') return makeAdd(node.terms.map(negate));
  return makeMul([MINUS_ONE, node]);
}

export function nearlyEqual(a, b, rel = 1e-12, abs = 1e-12) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}

/**
 * Parse a tolerance string: "0.01" (absolute) or "1%" (relative).
 */
export function parseTolerance(spec) {
  if (spec == null || spec === '') return null;
  const s = String(spec).trim();
  const m = /^(\d*\.?\d+)\s*(%)?$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] ? { relative: v / 100 } : { absolute: v };
}

/* ------------------------------------------------------------------ */
/* Comparison                                                           */
/* ------------------------------------------------------------------ */

/**
 * Compare a user answer with one accepted answer.
 * @returns {{equal:boolean, method:string, probabilistic?:boolean, diagnostics:string[], error?:object}}
 */
export function compareMath(userInput, expectedInput, options = {}) {
  const equivalence = options.equivalence || 'notation';
  let userTree;
  let expectedTree;
  try {
    expectedTree = canonicalize(parseMath(expectedInput));
  } catch (err) {
    return { equal: false, method: 'unparseable-expected', diagnostics: [], expectedError: err };
  }
  try {
    userTree = canonicalize(parseMath(userInput));
  } catch (err) {
    return { equal: false, method: 'unparseable-user', diagnostics: [diagnosticForParseError(err)], error: err };
  }
  const uk = keyOf(userTree);
  const ek = keyOf(expectedTree);
  if (uk === ek) return { equal: true, method: 'notation', diagnostics: [] };

  const tolerance = parseTolerance(options.tolerance);
  const userFree = freeSymbols(userTree);
  const expFree = freeSymbols(expectedTree);
  const comparable = userTree.k !== 'rel' && expectedTree.k !== 'rel' && userTree.k !== 'tuple' && expectedTree.k !== 'tuple'
    && !hasPlusMinus(userTree) && !hasPlusMinus(expectedTree);

  if (comparable && userFree.size === 0 && expFree.size === 0 && (equivalence !== 'notation' || tolerance)) {
    const a = evaluate(userTree);
    const b = evaluate(expectedTree);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      if (tolerance) {
        const diff = Math.abs(a - b);
        const ok = tolerance.absolute != null ? diff <= tolerance.absolute + 1e-15 : diff <= tolerance.relative * Math.abs(b) + 1e-15;
        if (ok) return { equal: true, method: 'numeric-tolerance', diagnostics: [] };
      } else if (equivalence !== 'notation' && nearlyEqual(a, b)) {
        return { equal: true, method: 'numeric', diagnostics: [] };
      }
    }
  }

  if (comparable && equivalence === 'algebraic' && (userFree.size || expFree.size)) {
    const result = randomPointsEqual(userTree, expectedTree, new Set([...userFree, ...expFree]));
    if (result) return { equal: true, method: 'algebraic-sampled', probabilistic: true, diagnostics: [] };
  }

  return { equal: false, method: 'none', diagnostics: mathDiagnostics(userTree, expectedTree) };
}

function randomPointsEqual(a, b, symbols) {
  const names = [...symbols];
  const rand = seededRandom(`${keyOf(a)}|${keyOf(b)}`);
  let valid = 0;
  for (let trial = 0; trial < 16 && valid < 8; trial++) {
    const env = {};
    for (const n of names) env[n] = 0.3 + rand() * 2.4;
    const x = evaluate(a, env);
    const y = evaluate(b, env);
    if (!Number.isFinite(x) && !Number.isFinite(y)) continue;
    if (!nearlyEqual(x, y, 1e-9, 1e-11)) return false;
    valid++;
  }
  return valid >= 6;
}

const INTEGRATION_CONSTANTS = new Set(['C', 'c', 'K']);

export function mathDiagnostics(userTree, expectedTree) {
  const diagnostics = [];
  const ek = keyOf(expectedTree);
  if (userTree.k !== 'rel' && expectedTree.k !== 'rel') {
    if (keyOf(negate(userTree)) === ek) diagnostics.push('sign-error');
    else {
      const free = freeSymbols(userTree).size + freeSymbols(expectedTree).size;
      if (!free) {
        const a = evaluate(userTree);
        const b = evaluate(expectedTree);
        if (Number.isFinite(a) && Number.isFinite(b) && b !== 0 && nearlyEqual(a, -b)) diagnostics.push('sign-error');
      }
    }
    if (expectedTree.k === 'add') {
      const constIndex = expectedTree.terms.findIndex((t) => t.k === 'sym' && INTEGRATION_CONSTANTS.has(t.name));
      if (constIndex >= 0) {
        const rest = makeAdd(expectedTree.terms.filter((_, i) => i !== constIndex));
        if (keyOf(rest) === keyOf(userTree)) diagnostics.push('missing-constant');
      }
    }
    if (keyOf(makePow(userTree, MINUS_ONE)) === ek) diagnostics.push('reciprocal');
  } else if (userTree.k === 'rel' && expectedTree.k === 'rel') {
    if (keyOf(userTree.a) === keyOf(expectedTree.a) && keyOf(negate(userTree.b)) === keyOf(expectedTree.b)) {
      diagnostics.push('sign-error');
    } else if (keyOf(userTree.b) === keyOf(expectedTree.b) && keyOf(negate(userTree.a)) === keyOf(expectedTree.a)) {
      diagnostics.push('sign-error');
    }
    if (expectedTree.op === '=' && userTree.op === '=') {
      for (const side of ['a', 'b']) {
        const exp = expectedTree[side];
        if (exp.k === 'add') {
          const constIndex = exp.terms.findIndex((t) => t.k === 'sym' && INTEGRATION_CONSTANTS.has(t.name));
          if (constIndex >= 0) {
            const rest = makeAdd(exp.terms.filter((_, i) => i !== constIndex));
            const other = side === 'a' ? 'b' : 'a';
            const candidates = [userTree.a, userTree.b];
            if (candidates.some((c) => keyOf(c) === keyOf(rest)) && candidates.some((c) => keyOf(c) === keyOf(expectedTree[other]))) {
              diagnostics.push('missing-constant');
            }
          }
        }
      }
    }
  }
  return diagnostics;
}

function diagnosticForParseError(err) {
  if (err.code === 'parens') return 'unbalanced-parentheses';
  if (err.code === 'incomplete') return 'incomplete-expression';
  return 'unreadable-expression';
}

/* ------------------------------------------------------------------ */
/* LaTeX printing (live preview)                                        */
/* ------------------------------------------------------------------ */

const LATEX_FN = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'ln', 'log', 'exp', 'max', 'min']);

function symLatex(name) {
  const [base, sub] = name.split('_');
  let out;
  if (base === 'inf') out = '\\infty';
  else if (base in GREEK) out = `\\${base}`;
  else if (base === 'deg') out = '^{\\circ}';
  else out = base.length > 1 ? `\\mathrm{${base}}` : base;
  return sub !== undefined ? `${out}_{${sub}}` : out;
}

function needsParensForPower(node) {
  return !['num', 'sym', 'group', 'fn'].includes(node.k) || (node.k === 'num' && node.v.startsWith('-'));
}

/** Render a raw (non-canonical) tree to LaTeX, preserving how it was typed. */
export function toLatex(node) {
  switch (node.k) {
    case 'num': return node.v.replace(/[eE]([+-]?\d+)$/, '\\times 10^{$1}');
    case 'sym': return symLatex(node.name);
    case 'group': {
      const inner = toLatex(node.a);
      return node.bracket === '[' ? `\\left[${inner}\\right]` : `\\left(${inner}\\right)`;
    }
    case 'neg': return `-${toLatex(node.a)}`;
    case 'add': return `${toLatex(node.a)}+${toLatex(node.b)}`;
    case 'sub': return `${toLatex(node.a)}-${toLatex(node.b)}`;
    case 'pm': return `${toLatex(node.a)}${node.sign === '∓' ? '\\mp' : '\\pm'}${toLatex(node.b)}`;
    case 'pm1': return `${node.sign === '∓' ? '\\mp' : '\\pm'}${toLatex(node.a)}`;
    case 'mul': {
      const a = toLatex(node.a);
      const b = toLatex(node.b);
      const numberNext = node.b.k === 'num' || (node.b.k === 'pow' && node.b.a.k === 'num');
      if (!node.implicit || numberNext) return `${a}\\cdot ${b}`;
      return `${a}${/^[A-Za-z0-9]/.test(b) && /[A-Za-z]$/.test(a) ? ' ' : ''}${b}`;
    }
    case 'div': return `\\frac{${toLatex(unwrap(node.a))}}{${toLatex(unwrap(node.b))}}`;
    case 'pow': {
      const base = needsParensForPower(node.a) ? `\\left(${toLatex(node.a)}\\right)` : toLatex(node.a);
      if (node.fnPower && node.a.k === 'fn') {
        const fn = node.a;
        return `${fnName(fn.name)}^{${toLatex(unwrap(node.b))}}${fnArgs(fn)}`;
      }
      return `${base}^{${toLatex(unwrap(node.b))}}`;
    }
    case 'root': return `\\sqrt[${toLatex(unwrap(node.index))}]{${toLatex(unwrap(node.a))}}`;
    case 'fact': return `${toLatex(node.a)}!`;
    case 'pct': return `${toLatex(node.a)}\\%`;
    case 'deg': return `${toLatex(node.a)}^{\\circ}`;
    case 'fn': {
      if (node.name === 'sqrt') return `\\sqrt{${toLatex(unwrap(node.args[0]))}}`;
      if (node.name === 'cbrt') return `\\sqrt[3]{${toLatex(unwrap(node.args[0]))}}`;
      if (node.name === 'abs') return `\\left|${toLatex(node.args[0])}\\right|`;
      const base = node.base ? `_{${toLatex(unwrap(node.base))}}` : '';
      return `${fnName(node.name)}${base}${fnArgs(node)}`;
    }
    case 'rel': {
      const op = { '=': '=', '<': '<', '>': '>', '<=': '\\le', '>=': '\\ge', '!=': '\\ne' }[node.op];
      return `${toLatex(node.a)}${op}${toLatex(node.b)}`;
    }
    case 'tuple': return node.items.map(toLatex).join(',\\,');
    default: return '';
  }
}

function unwrap(node) {
  return node.k === 'group' && node.bracket !== '[' ? node.a : node;
}

function fnName(name) {
  if (LATEX_FN.has(name)) return `\\${name}`;
  return `\\operatorname{${name}}`;
}

function fnArgs(node) {
  return `\\left(${node.args.map((a) => toLatex(unwrap(a))).join(',')}\\right)`;
}

/** Convenience for the live preview. */
export function previewLatex(input) {
  try {
    return { ok: true, latex: toLatex(parseMath(input)) };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

