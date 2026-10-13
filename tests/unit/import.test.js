// Spec 12.1–12.2: import parsing for TXT, CSV, TSV, multiline content,
// quoted separators and malformed rows; never silently discarding input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseImport, buildDrafts, markDuplicates, importSummary, notImportedText } from '../../js/core/import/index.js';
import { parseDelimited } from '../../js/core/import/csv.js';
import { htmlToText } from '../../js/core/import/html.js';

function run(text, format = null, options = {}) {
  const fmt = format || detectFormat(text).format;
  const parsed = parseImport(text, fmt, options);
  return { fmt, parsed, drafts: buildDrafts(parsed, options) };
}

test('Format A: tab-separated with tags column', () => {
  const { fmt, drafts, parsed } = run('Sulfate\tSO4^2-\nNitrate\tNO3^-\tchem ions\n');
  assert.equal(fmt, 'tsv');
  assert.equal(drafts.length, 2);
  assert.deepEqual([drafts[0].front, drafts[0].back], ['Sulfate', 'SO4^2-']);
  assert.deepEqual(drafts[1].tags, ['chem', 'ions']);
  assert.equal(parsed.unused.length, 0);
});

test('Format B: delimiter with escaped separators', () => {
  const { fmt, drafts, parsed } = run('Sulfate :: SO4^2-\nRatio \\:: x :: y\nno separator here\n');
  assert.equal(fmt, 'delimiter');
  assert.deepEqual(drafts.map((d) => [d.front, d.back]), [['Sulfate', 'SO4^2-'], ['Ratio :: x', 'y']]);
  assert.equal(parsed.unused.length, 1, 'unrecognised line reported, not dropped');
  assert.equal(parsed.unused[0].line, 3);
});

test('Format C: labeled Q/A with blank lines and extra labels', () => {
  const text = 'Q: What is the formula for sulfate?\n\nA: SO4^2-\n\nQ: Derivative of sin(x)?\nA: cos(x)\nHint: trig\nTags: calc\n';
  const { fmt, drafts } = run(text);
  assert.equal(fmt, 'qa');
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].back, 'SO4^2-');
  assert.equal(drafts[1].hint, 'trig');
  assert.deepEqual(drafts[1].tags, ['calc']);
});

test('Format D: Front/Back multiline blocks', () => {
  const text = 'Front: What is the derivative of sin(x)?\n\nBack: cos(x)\n\nFront: Line one\ncontinued\nBack: answer\n';
  const { fmt, drafts } = run(text);
  assert.equal(fmt, 'frontback');
  assert.equal(drafts[1].front, 'Line one\ncontinued');
});

test('CSV: quoted fields, embedded commas, quotes and newlines; header mapping', () => {
  const text = 'front,back,tags\n"Hello, world","Bonjour, le monde",fr\n"Multi\nline","He said ""hi""",x\n';
  const { fmt, drafts, parsed } = run(text);
  assert.equal(fmt, 'csv');
  assert.equal(parsed.hasHeader, true);
  assert.equal(drafts[0].front, 'Hello, world');
  assert.equal(drafts[1].front, 'Multi\nline');
  assert.equal(drafts[1].back, 'He said "hi"');
});

test('CSV: malformed rows are reported with line numbers', () => {
  const r = parseDelimited('a,b\n"broken,quote\n', ',');
  assert.ok(r.errors.some((e) => /never closed/.test(e.message)));
  const { parsed } = run('front,back\nok,fine\n"unterminated,row\n', 'csv');
  assert.ok(parsed.errors.length >= 1);
  assert.ok(parsed.unused.length + parsed.rows.length >= 2, 'the broken row is still visible somewhere');
});

test('semicolon CSV and UTF-8 BOM', () => {
  const { fmt, drafts } = run('\uFEFFterm;definition\nÅngström;10⁻¹⁰ m\n', null, { hasHeader: false });
  assert.equal(fmt, 'csvSemicolon');
  assert.ok(drafts.some((d) => d.front === 'Ångström'));
});

test('Anki plain-text export with headers, HTML and cloze', () => {
  const text = '#separator:tab\n#html:true\n#tags column:3\nWhat is <b>H<sub>2</sub>O</b>?\tWater&nbsp;\tchem\n{{c1::Paris}} is the capital of {{c2::France}}\tExtra\tgeo\n[sound:a.mp3] Listen\tX\t\n';
  const { fmt, drafts } = run(text);
  assert.equal(fmt, 'anki');
  assert.equal(drafts[0].front, 'What is **H₂O**?');
  assert.equal(drafts[0].back, 'Water');
  assert.equal(drafts[1].kind, 'cloze');
  assert.equal(drafts[1].cloze.length, 2);
  assert.ok(drafts[2].warnings.some((w) => /Audio reference/.test(w)), 'media references are reported');
});

test('HTML conversion strips scripts and keeps text as data', () => {
  const r = htmlToText('<script>alert(1)</script><b>bold</b><img src="x.png" onerror="evil()">');
  assert.equal(r.text, '**bold**');
  assert.ok(r.warnings.length >= 2);
});

test('JSON card lists and Axon backups', () => {
  const { drafts } = run('[{"front":"a","back":["b","c|d"],"tags":["x","y"]}]');
  assert.equal(drafts[0].back, 'b | c\\|d');
  const backup = parseImport('{"format":"axon-backup","version":1,"data":{}}', 'json');
  assert.ok(backup.backup);
});

test('structured notes become drafts; unmatched lines are kept', () => {
  const text = '# Chemistry\n## Ions\n- Sulfate :: SO4^2-\n- Nitrate — NO3^-\n- Ammonium\n  - NH4^+\nRandom sentence without pattern\nQ: Avogadro?\nA: 6.022e23\n';
  const { fmt, drafts, parsed } = run(text);
  assert.equal(fmt, 'notes');
  assert.deepEqual(drafts.map((d) => d.front), ['Sulfate', 'Nitrate', 'Ammonium', 'Avogadro?']);
  assert.deepEqual(drafts[0].tags, ['chemistry', 'ions']);
  assert.equal(drafts[2].back, 'NH4^+');
  assert.equal(parsed.unused.length, 1);
  const decks = run(text, 'notes', { headingsAsDecks: true }).drafts;
  assert.equal(decks[0].deck, 'Chemistry');
});

test('validation: empty fields, malformed cloze, unknown task type', () => {
  const { drafts } = run('\tback only\nfront\t\n{{c1::open\tx\nok\tfine\tt\t\t\t\tweird-type\n', 'tsv');
  assert.equal(drafts[0].status, 'invalid');
  assert.equal(drafts[1].status, 'invalid');
  assert.equal(drafts[2].status, 'invalid');
  assert.ok(drafts[2].errors.some((e) => /Cloze|cloze/.test(e)));
});

test('duplicates within the import and against existing cards', () => {
  const { drafts } = run('Sulfate\tSO4^2-\nsulfate\tSO4^2-\nNitrate\tNO2\nNew\tcard\n');
  const existing = [{ id: 'c1', deckId: 'd', front: ['Sulfate'], back: ['SO4^2-'] }, { id: 'c2', deckId: 'd', front: ['Nitrate'], back: ['NO3^-'] }];
  const marked = markDuplicates(drafts, existing);
  assert.equal(marked[0].duplicate.type, 'existing');
  assert.equal(marked[0].action, 'skip', 'identical cards are skipped by default, preserving history');
  assert.equal(marked[1].duplicate.type, 'within');
  assert.equal(marked[2].duplicate.type, 'similar');
  assert.equal(marked[2].action, 'import');
  assert.equal(marked[3].duplicate, null);
  const s = importSummary(marked, [], []);
  assert.equal(s.toImport, 2);
  assert.equal(s.skipped, 2);
  assert.match(notImportedText(marked, [{ line: 9, text: 'zzz', reason: 'x' }]), /line 9/);
});
