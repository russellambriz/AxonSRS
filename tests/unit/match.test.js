// Spec 12.3–12.5: multiple accepted answers, maths/chemistry normalisation,
// typo tolerance without accepting different formulas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAnswer, matchOrderedAnswers, typoMatch, normalizeText, answerDiff } from '../../js/core/match/index.js';
import { compareMath, canonicalKey, previewLatex, parseMath } from '../../js/core/match/math.js';
import { compareChem, parseChem, toMhchem } from '../../js/core/match/chem.js';

const T = (input, accepted, opts) => matchAnswer(input, accepted, opts);

test('plain text: whitespace, Unicode, case and punctuation normalisation', () => {
  assert.ok(T('  paris. ', ['Paris']).correct);
  assert.ok(T('don’t', ["don't"]).correct);
  assert.ok(T('well–known', ['well-known']).correct);
  assert.ok(T('Mitochondrion', ['**Mitochondrion**']).correct, 'Markdown formatting in the stored answer is ignored');
  assert.ok(T('cafe\u0301', ['café']).correct, 'NFC normalisation');
  assert.equal(T('Paris', ['paris'], { caseSensitive: true }).correct, false);
});

test('multiple accepted answers', () => {
  const r = T('1/sqrt(2)', ['sqrt(2)/2', '1/sqrt(2)'], { mode: 'math' });
  assert.ok(r.correct);
  assert.equal(r.matchedIndex, 1);
  assert.equal(T('2', ['sqrt(2)/2', '1/sqrt(2)'], { mode: 'math' }).correct, false);
});

test('typo tolerance is cautious and visible', () => {
  const r = T('photosynthsis', ['photosynthesis']);
  assert.ok(r.correct && r.typoTolerated);
  assert.ok(r.warnings.includes('typo'));
  // short words, numbers, signs, first letters, confusable prefixes/suffixes
  assert.equal(T('cat', ['bat']).correct, false);
  assert.equal(T('12 cats', ['13 cats']).correct, false);
  assert.equal(T('-5', ['5']).correct, false);
  assert.equal(T('hypothyroidism', ['hyperthyroidism']).correct, false);
  assert.equal(T('sulfite', ['sulfate']).correct, false);
  assert.equal(T('absorption', ['adsorption']).correct, false);
  assert.equal(T('ilium', ['ileum']).correct, false);
  assert.equal(T('xhotosynthesis', ['photosynthesis']).correct, false, 'first letter must match');
  // a typed word that is another known term in the deck is not a typo
  assert.equal(T('glucosee', ['glucose'], { vocabulary: new Set(['glucosee']) }).correct, false);
  // strict spelling
  assert.equal(T('photosynthsis', ['photosynthesis'], { typoTolerance: 'off' }).correct, false);
});

test('typo tolerance never applies to maths or chemistry formulas', () => {
  assert.equal(T('x^3', ['x^2'], { mode: 'math' }).correct, false);
  assert.equal(T('SO3^2-', ['SO4^2-'], { mode: 'chem' }).correct, false);
  assert.equal(T('NO2^-', ['NO3^-'], { mode: 'chem' }).correct, false);
});

test('typoMatch budget rules', () => {
  assert.equal(typoMatch('recieve', 'receive').ok, true);
  assert.equal(typoMatch('abcdefgh', 'abxyefgh').ok, false, 'too many edits for an 8-letter word');
  assert.equal(typoMatch('one two', 'one').ok, false, 'word counts must match');
});

test('accent policy', () => {
  assert.ok(T('esta', ['está']).typoTolerated);
  assert.equal(T('esta', ['está'], { accentPolicy: 'strict' }).correct, false);
  const ignore = T('esta', ['está'], { accentPolicy: 'ignore' });
  assert.ok(ignore.correct && !ignore.typoTolerated);
});

test('maths: notation variants are equal', () => {
  const eq = (a, b) => assert.equal(compareMath(a, b).equal, true, `${a} ≡ ${b}`);
  eq('√3', 'sqrt(3)');
  eq('3^(1/2)', 'sqrt(3)');
  eq('π', 'pi');
  eq('2π', '2*pi');
  eq('½', '1/2');
  eq('\\frac{1}{2}', '1/2');
  eq('x²', 'x^2');
  eq('x**2', 'x^{2}');
  eq('2x+1', '1+2x');
  eq('1/x', 'x^-1');
  eq('6.02×10^23', '6.02e23');
  eq('sin^-1(x)', 'arcsin(x)');
  eq('sin^2(x)', 'sin(x)^2');
  eq('e^x', 'exp(x)');
  eq('|x|', 'abs(x)');
  eq('y=2x', '2x=y');
  eq('x>2', '2<x');
  eq('(x+1)(x-1)', '(x-1)(x+1)');
  eq('\\sqrt{2}/2', 'sqrt(2)/2');
  eq('−3', '-3');
  eq('x₁', 'x_1');
  eq('∛8', '8^(1/3)');
  eq('±2', '\\pm 2');
});

test('maths: different expressions are not accepted without verification', () => {
  const ne = (a, b, opts) => assert.equal(compareMath(a, b, opts).equal, false, `${a} ≢ ${b}`);
  ne('x-3', '3-x');
  ne('2/4', '1/2');
  ne('0.5', '1/2');
  ne('sqrt(2)/2', '1/sqrt(2)');
  ne('2*3', '6');
  ne('log(x)', 'ln(x)');
  ne('x^2+2x+1', '(x+1)^2');
  ne('(x+1)^2', 'x^2+2x+2', { equivalence: 'algebraic' });
  ne('0.7071', 'sqrt(2)/2', { equivalence: 'numeric' });
});

test('maths: optional numeric and algebraic equivalence', () => {
  assert.ok(compareMath('0.5', '1/2', { equivalence: 'numeric' }).equal);
  assert.ok(compareMath('sqrt(2)/2', '1/sqrt(2)', { equivalence: 'numeric' }).equal);
  const alg = compareMath('(x+1)^2', 'x^2+2x+1', { equivalence: 'algebraic' });
  assert.ok(alg.equal && alg.probabilistic);
  assert.ok(compareMath('3.14', 'pi', { tolerance: '0.01' }).equal);
  assert.equal(compareMath('3.1', 'pi', { tolerance: '0.01' }).equal, false);
  assert.ok(compareMath('2.99e8', '2.998e8', { tolerance: '0.5%' }).equal);
});

test('maths diagnostics: sign error, missing +C, parse errors', () => {
  assert.ok(compareMath('-cos(x)', 'cos(x)').diagnostics.includes('sign-error'));
  assert.ok(compareMath('x+1', '-x-1').diagnostics.includes('sign-error'));
  assert.ok(compareMath('x^2/2', 'x^2/2 + C').diagnostics.includes('missing-constant'));
  assert.ok(compareMath('sqrt(x', 'sqrt(x)').diagnostics.includes('unbalanced-parentheses'));
});

test('maths: canonical keys are deterministic and the preview prints LaTeX', () => {
  assert.equal(canonicalKey('b + a'), canonicalKey('a + b'));
  assert.equal(previewLatex('sqrt(2)/2').latex, '\\frac{\\sqrt{2}}{2}');
  assert.equal(previewLatex('(x+1').ok, false);
  assert.throws(() => parseMath(''));
});

test('chemistry: notation variants are equal', () => {
  const eq = (a, b) => assert.equal(compareChem(a, b).equal, true, `${a} ≡ ${b}`);
  eq('SO₄²⁻', 'SO4^2-');
  eq('SO4^{2-}', 'SO4^2-');
  eq('SO4 2-', 'SO4^2-');
  eq('SO4(2-)', 'SO4^2-');
  eq('SO4--', 'SO4^2-');
  eq('Fe3+', 'Fe^3+');
  eq('Fe+3', 'Fe^3+');
  eq('NH4+', 'NH4^+');
  eq('Ca(OH)2', 'Ca(OH)₂');
  eq('CuSO4·5H2O', 'CuSO4.5H2O');
  eq('2H2 + O2 -> 2H2O', 'O2 + 2H2 → 2H2O');
  eq('Na+ + Cl- -> NaCl', 'Na^+ + Cl^- → NaCl');
  eq('[Cu(NH3)4]2+', '[Cu(NH3)4]^2+');
  eq('e-', 'e⁻');
});

test('chemistry: identity is protected (elements, counts, charges, case)', () => {
  const ne = (a, b, diag) => {
    const r = compareChem(a, b);
    assert.equal(r.equal, false, `${a} ≢ ${b}`);
    if (diag) assert.ok(r.diagnostics.includes(diag), `${a} vs ${b} → ${diag} (got ${r.diagnostics})`);
  };
  ne('SO4^2+', 'SO4^2-', 'charge-sign');
  ne('SO3^2-', 'SO4^2-', 'atom-count');
  ne('SO4', 'SO4^2-', 'charge-missing');
  ne('Fe^2+', 'Fe^3+', 'charge-mismatch');
  ne('CO', 'Co', 'element-mismatch');
  ne('co', 'CO', 'element-case');
  ne('OH2', 'H2O', 'arrangement-differs');
  ne('CuSO4.4H2O', 'CuSO4.5H2O', 'atom-count');
  ne('H2 + O2 -> H2O', '2H2 + O2 → 2H2O', 'coefficient-mismatch');
  ne('N2 + 3H2 -> 2NH3', 'N2 + 3H2 <=> 2NH3', 'arrow-mismatch');
  ne('NaCl', 'NaCl(aq)', 'state-missing');
  ne('Xx2', 'H2');
});

test('chemistry: ambiguous charge readings are resolved only when they match, with a warning', () => {
  const r = compareChem('SO42-', 'SO4^2-');
  assert.ok(r.equal);
  assert.ok(r.warnings.includes('ambiguous-charge-read'));
  const sp = parseChem('SO42-').species;
  assert.equal(sp.parts[0].groups[1].count, 42, 'primary reading keeps digits as a count');
});

test('mhchem conversion never passes TeX commands from user input', () => {
  assert.equal(toMhchem('\\href{x}{y} SO4'), 'hrefxy SO4');
  assert.equal(toMhchem('SO₄²⁻'), 'SO4^2-');
});

test('ordered multi-answer groups (cloze) need every part, in order', () => {
  const groups = [['Paris'], ['France']];
  assert.ok(matchOrderedAnswers('Paris; France', groups).correct);
  assert.equal(matchOrderedAnswers('France; Paris', groups).correct, false);
  assert.ok(matchOrderedAnswers('Paris', groups).diagnostics.includes('answer-count'));
});

test('diff highlights missing and extra characters', () => {
  assert.deepEqual(answerDiff('SO3^2-', 'SO4^2-'), [{ type: 'same', text: 'SO' }, { type: 'extra', text: '3' }, { type: 'missing', text: '4' }, { type: 'same', text: '^2-' }]);
  assert.deepEqual(answerDiff('Canberra', 'Jupiter'), [{ type: 'extra', text: 'Canberra' }], 'unrelated answers are not interleaved');
  assert.equal(normalizeText('  A  B. '), 'a b');
});

test('display formatting in a stored or typed answer never causes a wrong result', () => {
  const ok = (typed, stored, mode = 'text') => assert.equal(matchAnswer(typed, [stored], { mode }).correct, true, `${typed} vs ${stored} (${mode})`);
  ok('1/2', '$\\frac{1}{2}$', 'math');
  ok('2x+1', '$2x + 1$', 'math');
  ok('x^2', '$x^{2}$', 'math');
  ok('$x^2$', 'x^2', 'math');
  ok('H2O', '\\ce{H2O}', 'chem');
  ok('H2O', '$\\ce{H2O}$', 'chem');
  ok('SO4^2-', 'SO<sub>4</sub><sup>2-</sup>', 'chem');
  ok('Paris', '<b>Paris</b>');
  ok('H2O', 'H<sub>2</sub>O');
  ok('conditional probability', 'conditional probability\n\n![diagram](axon-media:sha256-x)');
  ok('µ', 'μ');
  ok('∆H', 'ΔH');
  ok('5°C', '5 °C');
  ok('50 %', '50%');
  assert.equal(matchAnswer('Rome', ['<b>Paris</b>']).correct, false);
});

test('chemistry accepts more charge notations without loosening identity', () => {
  const chem = (typed, stored) => matchAnswer(typed, [stored], { mode: 'chem' });
  for (const [t, s] of [['SO4^-2', 'SO4^2-'], ['Fe^+3', 'Fe^3+'], ['SO4^(2-)', 'SO4^2-'], ['SO4²-', 'SO4^2-'], ['SO4²−', 'SO4^2-']]) assert.equal(chem(t, s).correct, true, `${t} = ${s}`);
  const amb = chem('Fe^3+', 'Fe3+');
  assert.equal(amb.correct, true, 'a stored ambiguous charge accepts its charge reading');
  assert.deepEqual(amb.warnings, ['ambiguous-charge-read']);
  for (const [t, s] of [['Fe^2+', 'Fe3+'], ['SO4^2+', 'SO4^2-'], ['SO3^2-', 'SO4^2-'], ['SO4^-3', 'SO4^2-']]) assert.equal(chem(t, s).correct, false, `${t} ≠ ${s}`);
});

test('typo tolerance never confuses chemical or anatomical terms that differ by a few letters', () => {
  for (const [t, e] of [['chlorine', 'chloride'], ['fluorine', 'fluoride'], ['alkane', 'alkene'], ['alkene', 'alkyne'], ['butane', 'butene'], ['neutron', 'neuron'], ['neuron', 'neutron'], ['arteries', 'arterioles'], ['ethanol', 'ethanal'], ['mitosis', 'meiosis']]) {
    assert.equal(matchAnswer(t, [e]).correct, false, `${t} ≠ ${e}`);
  }
  for (const [t, e] of [['Canbera', 'Canberra'], ['photosynthesys', 'photosynthesis'], ['mitochondira', 'mitochondria']]) {
    const r = matchAnswer(t, [e]);
    assert.equal(r.correct && r.typoTolerated, true, `${t} ≈ ${e}`);
  }
});

test('maths: mixed numbers are fractions, and algebraic checks sample both signs', () => {
  const m = (t, e, eq = 'notation') => matchAnswer(t, [e], { mode: 'math', mathEquivalence: eq }).correct;
  assert.equal(m('1 1/2', '1/2'), false, '1 1/2 is not 1 × 1/2');
  assert.equal(m('1 1/2', '3/2'), true);
  assert.equal(m('1½', '1 1/2'), true);
  assert.equal(m('2 1/2', '1', 'numeric'), false);
  assert.equal(m('abs(x)', 'x', 'algebraic'), false);
  assert.equal(m('sqrt(x^2)', 'x', 'algebraic'), false);
  assert.equal(m('x', 'x+1e-10', 'algebraic'), false);
  assert.equal(m('(x+1)^2', 'x^2+2x+1', 'algebraic'), true);
  assert.equal(m('sin(x)^2+cos(x)^2', '1', 'algebraic'), true);
});

test('diagnostics: one flipped sign in a sum, and a missing or different unit', () => {
  const d = (t, e, mode = 'math') => matchAnswer(t, [e], { mode }).diagnostics;
  assert.ok(d('x - 2', 'x + 2').includes('sign-error'));
  assert.ok(d('x^2 - 3x + 2', 'x^2 + 3x + 2').includes('sign-error'));
  assert.equal(d('x + 3', 'x + 2').includes('sign-error'), false);
  assert.ok(d('3e8', '3e8 m/s', 'text').includes('unit-missing'));
  assert.ok(d('3e8 km/s', '3e8 m/s', 'text').includes('unit-mismatch'));
  assert.ok(d('25', '25 °C', 'text').includes('unit-missing'));
  assert.equal(d('4e8 m/s', '3e8 m/s', 'text').includes('unit-mismatch'), false, 'a different number is not a unit error');
});
