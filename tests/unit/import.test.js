// Spec 12.1–12.2: import parsing for TXT, CSV, TSV, multiline content,
// quoted separators and malformed rows; never silently discarding input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseImport, buildDrafts, markDuplicates, importSummary, notImportedText, validateDraft } from '../../js/core/import/index.js';
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

test('nothing is dropped silently: # lines in tables, unknown JSON keys, headers the user marks', () => {
  const t = parseImport('# Chapter 3\nfront\tback\na\tb', 'tsv');
  assert.ok(t.unused.some((u) => u.text === '# Chapter 3'), 'comment line reported');
  const hdr = parseImport('Word,Meaning\nchat,cat', 'csv', { hasHeader: true });
  assert.equal(hdr.rows.length, 1, 'an unrecognised header row is still treated as a header when asked');
  const json = parseImport(JSON.stringify([{ front: 'a', back: 'b', source: 'book', page: 3 }]), 'json');
  assert.deepEqual(json.columns, ['front', 'back', 'source', 'page']);
  assert.equal(json.mapping[2], 'ignore', 'unknown keys are visible columns, mapped to ignore');
  const remapped = buildDrafts(parseImport(JSON.stringify([{ front: 'a', back: 'b', source: 'book' }]), 'json', { mapping: { 0: 'front', 1: 'back', 2: 'tags' } }));
  assert.deepEqual(remapped[0].tags, ['book'], 'and can be mapped');
});

test('Anki exports with GUID, note type and deck columns map front and back correctly', () => {
  const src = '#separator:tab\n#html:true\n#guid column:1\n#notetype column:2\n#deck column:3\nabc123\tBasic\tChem\tSulfate\tSO<sub>4</sub><sup>2-</sup>';
  const parsed = parseImport(src, 'anki');
  const [d] = buildDrafts(parsed);
  assert.equal(d.front, 'Sulfate');
  assert.equal(d.deck, 'Chem');
  assert.equal(d.status, 'valid');
  const old = buildDrafts(parseImport('Capital<br>of France\t<b>Paris</b>', 'tsv'));
  assert.equal(old[0].back, '**Paris**', 'HTML in a header-less Anki export is converted to Markdown');
  assert.equal(old[0].front.includes('<br>'), false);
});

test('pasted cloze lines are detected as cloze, not the :: separator', () => {
  const src = '{{c1::Paris}} is the capital of {{c2::France}}\n{{c1::Rome}} is the capital of Italy';
  assert.equal(detectFormat(src).format, 'cloze');
  const drafts = buildDrafts(parseImport(src, 'cloze'));
  assert.deepEqual(drafts.map((d) => [d.kind, d.status]), [['cloze', 'valid'], ['cloze', 'valid']]);
});

test('duplicate choices survive edits, fixed rows can be imported, within-import duplicates can be kept', () => {
  const existing = [{ id: 'c1', deckId: 'd', front: ['Sulfate'], back: ['SO4^2-'] }];
  let drafts = markDuplicates(buildDrafts(parseImport('Sulfate\tSO4^2-\nNitrate\t\nNitrate\tNO3^-\nNitrate\tNO3^-', 'tsv')), existing);
  assert.equal(drafts[0].action, 'skip');
  drafts[0] = { ...drafts[0], userAction: 'update' };
  drafts = markDuplicates(drafts, existing);
  assert.equal(drafts[0].action, 'update', 'an explicit choice survives a re-check');
  assert.equal(drafts[1].status, 'invalid');
  drafts[1] = validateDraft({ ...drafts[1], back: 'NO3^-' });
  drafts = markDuplicates(drafts, existing);
  assert.equal(drafts[1].action, 'import', 'a fixed row is no longer stuck on skip');
  const within = drafts.findIndex((d) => d.duplicate?.type === 'within');
  drafts[within] = { ...drafts[within], userAction: 'import' };
  assert.equal(markDuplicates(drafts, existing)[within].action, 'import');
});
