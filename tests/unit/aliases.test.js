// Spec 17.13: literal pipes and backslashes survive alias import/export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAnswers, encodeAnswers, encodeAnswer, addAlias, splitUnescaped } from '../../js/core/aliases.js';

test('pipe separates alternatives and trims whitespace', () => {
  assert.deepEqual(decodeAnswers('sqrt(2)/2 | 1/sqrt(2)'), ['sqrt(2)/2', '1/sqrt(2)']);
  assert.deepEqual(decodeAnswers('  a|b |  c  '), ['a', 'b', 'c']);
  assert.deepEqual(decodeAnswers('single'), ['single']);
  assert.deepEqual(decodeAnswers(''), []);
  assert.deepEqual(decodeAnswers('a||b'), ['a', 'b']);
});

test('escaped pipe is a literal, not a separator', () => {
  assert.deepEqual(decodeAnswers('a \\| b | c'), ['a | b', 'c']);
  assert.deepEqual(decodeAnswers('\\|x\\|'), ['|x|']);
});

test('backslashes: \\\\ is a literal backslash, other backslashes are kept (LaTeX)', () => {
  assert.deepEqual(decodeAnswers('\\frac{1}{2}'), ['\\frac{1}{2}']);
  assert.deepEqual(decodeAnswers('C:\\\\path | b'), ['C:\\path', 'b']);
});

test('round trip preserves every value exactly', () => {
  const cases = [
    ['plain', 'two words'],
    ['a|b', 'c'],
    ['ends with backslash\\', 'x'],
    ['\\|', '\\\\'],
    ['\\frac{\\sqrt{2}}{2}', '|x|'],
    ['back\\slash|pipe\\|both'],
    ['', 'only after empty'].filter(Boolean),
  ];
  for (const list of cases) {
    assert.deepEqual(decodeAnswers(encodeAnswers(list)), list, `round trip of ${JSON.stringify(list)}`);
  }
});

test('a literal pipe in an alias can never create an extra alternative', () => {
  const alias = 'x | y';
  const encoded = encodeAnswers(['first', alias]);
  assert.deepEqual(decodeAnswers(encoded), ['first', 'x | y']);
  assert.equal(encodeAnswer('a|b'), 'a\\|b');
});

test('addAlias appends once', () => {
  assert.deepEqual(addAlias(['a'], ' b '), ['a', 'b']);
  assert.deepEqual(addAlias(['a', 'b'], 'b'), ['a', 'b']);
});

test('splitUnescaped handles escaped multi-character separators', () => {
  assert.deepEqual(splitUnescaped('ratio \\:: x :: y', '::'), ['ratio :: x ', ' y']);
  assert.deepEqual(splitUnescaped('a::b::c', '::'), ['a', 'b', 'c']);
});
