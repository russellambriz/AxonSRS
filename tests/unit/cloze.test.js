// Spec 17.8: cloze generation, malformed syntax, multiple blanks, stable ids after editing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCloze, clozeKeys, clozePrompt, clozeReveal, clozeAnswerGroups, clozeInstruction, addClozeAlias, clozePreview } from '../../js/core/cloze.js';
import { createCard, unitKeys, unitContent } from '../../js/core/model.js';

test('numbered clozes become separate units with stable ids', () => {
  const text = '{{c1::Paris}} is the capital of {{c2::France}}.';
  assert.deepEqual(clozeKeys(text), ['c1', 'c2']);
  assert.equal(clozePrompt(text, 'c1').replace(/<[^>]+>/g, ''), '[…] is the capital of France.');
  assert.equal(clozePrompt(text, 'c2').replace(/<[^>]+>/g, ''), 'Paris is the capital of […].');
  assert.match(clozeReveal(text, 'c2'), /cloze-answer">France/);
});

test('repeated occurrences of one number are hidden together; distinct answers are ordered', () => {
  const same = '{{c1::x}} + {{c1::x}} = 2{{c1::x}}';
  assert.deepEqual(clozeAnswerGroups(same, 'c1'), [['x']]);
  assert.equal(clozePrompt(same, 'c1').match(/cloze-blank/g).length, 3);
  const multi = '{{c1::Paris}} is in {{c1::France}}';
  assert.deepEqual(clozeAnswerGroups(multi, 'c1'), [['Paris'], ['France']]);
  assert.match(clozeInstruction(multi, 'c1'), /2 answers in order/);
  assert.match(clozePrompt(multi, 'c1'), /\[1: …\].*\[2: …\]/);
});

test('hints and alternatives inside clozes', () => {
  const text = '{{c1::sqrt(2)/2|1/sqrt(2)::exact value}}';
  assert.deepEqual(clozeAnswerGroups(text, 'c1'), [['sqrt(2)/2', '1/sqrt(2)']]);
  assert.match(clozePrompt(text, 'c1'), /\[exact value\]/);
});

test('unnumbered blanks get deterministic, content-derived identities', () => {
  const a = '{{alpha}} and {{beta}}';
  const keys = clozeKeys(a);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => k.startsWith('u-')));
  // Inserting another blank before them does not change their ids
  const b = '{{gamma}} then {{alpha}} and {{beta}}';
  const keysB = clozeKeys(b);
  assert.ok(keys.every((k) => keysB.includes(k)));
  // Repeats of the same text get suffixed ids, deterministically
  assert.deepEqual(clozeKeys('{{x}} {{x}}'), [clozeKeys('{{x}}')[0], `${clozeKeys('{{x}}')[0]}-2`]);
});

test('editing one cloze keeps the other cloze ids (and so their history)', () => {
  const before = createCard({ deckId: 'd', front: '{{c1::Paris}} is the capital of {{c2::France}}' });
  const after = { ...before, front: ['{{c1::Paris}} is the capital city of {{c2::France}} and {{c3::Europe}}'] };
  const k1 = unitKeys(before, null);
  const k2 = unitKeys(after, null);
  assert.deepEqual(k1, ['c1', 'c2']);
  assert.deepEqual(k2, ['c1', 'c2', 'c3']);
  assert.equal(unitContent(after, 'c2').answerDisplay, 'France');
});

test('malformed cloze syntax is reported, not silently dropped', () => {
  assert.ok(parseCloze('{{c1::open').errors.length);
  assert.ok(parseCloze('stray }} close').errors.length);
  assert.ok(parseCloze('{{c::no number}}').errors.length);
  assert.ok(parseCloze('{{c0::zero}}').errors.length);
  assert.ok(parseCloze('{{c1::}}').errors.length);
  assert.ok(parseCloze('{{c1::a {{c2::b}} }}').errors.length);
});

test('adding an alias only changes the targeted blank', () => {
  const text = '{{c1::Paris}} is in {{c2::France::country}}';
  const next = addClozeAlias(text, 'c2', 0, 'République française');
  assert.equal(next, '{{c1::Paris}} is in {{c2::France|République française::country}}');
  assert.deepEqual(clozeKeys(next), ['c1', 'c2']);
  const pipe = addClozeAlias('{{c1::a}}', 'c1', 0, 'x|y');
  assert.deepEqual(clozeAnswerGroups(pipe, 'c1'), [['a', 'x|y']]);
});

test('import preview lists generated questions and answers', () => {
  const p = clozePreview('{{c1::H2O}} is {{c2::water}}');
  assert.deepEqual(p.rows.map((r) => [r.key, r.expected]), [['c1', 'H2O'], ['c2', 'water']]);
  assert.equal(p.rows[0].prompt, '[…] is water');
});
