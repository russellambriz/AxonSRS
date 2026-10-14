/**
 * Smart bulk import: paste/upload → detect format → map fields →
 * editable preview with validation and duplicates → confirm.
 */

import { h, replace, readFileAsText, downloadBlob } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button, deckOptions } from './common.js';
import { select, segmented, switchControl, toast, callout, errorToast, settingRow } from '../components.js';
import { detectFormat, parseImport, buildDrafts, markDuplicates, importSummary, notImportedText, validateDraft, FORMATS, FIELD_NAMES } from '../../core/import/index.js';
import { createCard, createDeck, normalizeTags, ANSWER_MODE_LABELS, TASK_TYPE_LABELS } from '../../core/model.js';
import { decodeAnswers } from '../../core/aliases.js';
import { isEnvelope } from '../../core/sync/envelope.js';

const MAX_SOURCE_STORED = 2 * 1024 * 1024;
const FIELD_LABELS = { front: 'Front', back: 'Back', tags: 'Tags', deck: 'Deck', hint: 'Hint', explanation: 'Explanation', taskType: 'Task type', answerMode: 'Answer mode', ignore: 'Ignore' };

export async function view(outlet, params, query) {
  await app.cache.ensure();
  const { root, body } = page({ title: 'Import cards', sub: 'Paste text or load a file. Everything is parsed locally on this device.', crumbs: [{ label: 'Decks', href: '#/decks' }] });
  outlet.append(root);
  const firstDeck = query.deck && app.cache.decks.has(query.deck) ? query.deck : [...app.cache.decks.keys()][0] || '';
  const st = {
    step: 1,
    text: '',
    fileName: '',
    format: null,
    candidates: [],
    options: { delimiter: '::', hasHeader: undefined, mapping: null, headingsAsDecks: false },
    parsed: null,
    drafts: [],
    targetDeckId: firstDeck,
    newDeckName: firstDeck ? '' : 'Imported cards',
    defaultMode: '',
    defaultTask: 'recall',
    shown: 200,
    result: null,
  };
  const stepsEl = h('div', { class: 'steps', 'aria-label': 'Import steps' });
  const panel = h('div', { class: 'stack loose' });
  body.append(stepsEl, panel);

  function renderSteps() {
    replace(stepsEl, ['Source', 'Format & fields', 'Preview', 'Confirm'].map((label, i) => h('span', { class: st.step === i + 1 ? 'on' : '', 'aria-current': st.step === i + 1 ? 'step' : undefined }, `${i + 1}. ${label}`)));
  }

  function go(step) {
    st.step = step;
    app.setBusy('import', step > 1 && !st.result ? 'an import in progress' : null);
    renderSteps();
    render();
  }

  function analyze() {
    const det = detectFormat(st.text);
    st.format = det.format;
    st.candidates = det.candidates;
    st.options.mapping = null;
    reparse();
  }

  function reparse() {
    try {
      st.parsed = parseImport(st.text, st.format, { ...st.options, defaultDeck: '' });
      if (!st.options.mapping && st.parsed.mapping) st.options.mapping = { ...st.parsed.mapping };
      rebuild();
    } catch (err) {
      errorToast(err);
    }
  }

  function rebuild() {
    const drafts = buildDrafts(st.parsed, { defaultTaskType: st.defaultTask, defaultAnswerMode: st.defaultMode });
    const targetCards = [...app.cache.cards.values()];
    st.drafts = markDuplicates(drafts, targetCards);
  }

  // -------------------------------------------------------------- step 1
  function stepSource() {
    const ta = h('textarea', { class: 'textarea mono', rows: '14', placeholder: 'Paste cards here, for example:\n\nSulfate\tSO4^2-\nNitrate :: NO3^-\nQ: What is the derivative of sin(x)?\nA: cos(x)\n\n# Notes with headings\n- Mitochondria — site of aerobic respiration', 'aria-label': 'Text to import' });
    ta.value = st.text;
    ta.addEventListener('input', () => { st.text = ta.value; });
    const drop = h('div', { class: 'dropzone' }, icon('upload'), h('p', {}, 'Drop a file here, or ', h('label', { class: 'btn small', style: { display: 'inline-flex' } }, 'choose a file', h('input', { type: 'file', class: 'visually-hidden', accept: '.txt,.csv,.tsv,.md,.json,.axon,text/plain,text/csv,text/tab-separated-values,application/json', onchange: (e) => loadFile(e.target.files[0]) }))), h('p', { class: 'faint small' }, 'TXT, CSV, TSV, Markdown notes, Anki “Notes in Plain Text” exports, JSON card lists or Axon backups. UTF-8.'));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); });
    async function loadFile(file) {
      if (!file) return;
      if (file.size > 50 * 1024 * 1024) return errorToast(new Error('That file is larger than 50 MB.'));
      const text = await readFileAsText(file);
      try {
        const obj = JSON.parse(text);
        if (obj?.format === 'axon-backup' || (isEnvelope(obj) && obj.format === 'axon-backup')) {
          replace(panel, callout('info', 'This is an Axon backup. Backups are restored with a preview of what will change.'), h('div', { class: 'row' }, button('Restore this backup', { kind: 'primary', onclick: () => { app.pendingBackupText = text; app.navigate('/settings/data?restore=1'); } }), button('Choose another file', { onclick: () => render() })));
          return;
        }
      } catch {
        /* not JSON */
      }
      st.text = text;
      st.fileName = file.name;
      ta.value = text;
      toast(`Loaded ${file.name}`);
    }
    return [
      h('section', { class: 'panel stack' }, ta, drop),
      h('div', { class: 'row end' }, button('Next', { kind: 'primary', iconName: 'chevronRight', onclick: () => {
        if (!st.text.trim()) return toast('Paste some text or choose a file first');
        analyze();
        go(2);
      } })),
    ];
  }

  // -------------------------------------------------------------- step 2
  function stepFormat() {
    const formatOptions = [...new Set([...st.candidates.map((c) => c.format), ...Object.keys(FORMATS)])].map((f) => {
      const c = st.candidates.find((x) => x.format === f);
      return { value: f, label: `${FORMATS[f]}${c ? ` — ${Math.round(c.score * 100)}% match` : ''}` };
    });
    const parts = [];
    parts.push(settingRow({ title: 'Format', desc: st.candidates.length ? `Detected: ${FORMATS[st.format]}. Change it if the preview looks wrong.` : 'Choose how the text is organised.', control: select({ label: 'Format', options: formatOptions, value: st.format, onchange: (v) => { st.format = v; st.options.mapping = null; reparse(); render(); } }) }));
    if (st.format === 'delimiter') {
      const d = h('input', { class: 'input mono', style: { width: '90px' }, value: st.options.delimiter });
      d.addEventListener('change', () => { st.options.delimiter = d.value || '::'; reparse(); render(); });
      parts.push(settingRow({ title: 'Separator', desc: 'Between front and back on each line. Escape a literal separator with a backslash.', control: d }));
    }
    if (st.format === 'csv' || st.format === 'csvSemicolon' || st.format === 'tsv') {
      parts.push(settingRow({ title: 'First row is a header', control: switchControl({ checked: !!st.parsed?.hasHeader, onchange: (v) => { st.options.hasHeader = v; st.options.mapping = null; reparse(); render(); } }) }));
    }
    if (st.format === 'notes') {
      parts.push(settingRow({ title: 'Use top-level headings as deck names', desc: 'Otherwise headings become tags.', control: switchControl({ checked: st.options.headingsAsDecks, onchange: (v) => { st.options.headingsAsDecks = v; reparse(); } }) }));
    }
    if (st.parsed?.mapping && st.parsed.columns) {
      const sample = st.parsed.rows[0]?.fields || [];
      parts.push(h('div', { class: 'stack' }, h('h3', {}, 'Field mapping'), h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Column'), h('th', {}, 'Example'), h('th', {}, 'Use as'))),
        h('tbody', {}, st.parsed.columns.map((col, i) => h('tr', {}, h('td', {}, col), h('td', { class: 'mono small truncate', style: { maxWidth: '260px' } }, sample[i] ?? ''), h('td', {}, select({ label: `Use column ${i + 1} as`, options: FIELD_NAMES.map((f) => ({ value: f, label: FIELD_LABELS[f] })), value: st.options.mapping[i] || 'ignore', onchange: (v) => { st.options.mapping = { ...st.options.mapping, [i]: v }; reparse(); } })))))))));
    }
    const deckSel = select({ label: 'Target deck', options: [...deckOptions(), { value: '__new', label: '+ New deck…' }], value: st.targetDeckId || '__new', onchange: (v) => { st.targetDeckId = v === '__new' ? '' : v; render(); } });
    const newName = h('input', { class: 'input', placeholder: 'New deck name', value: st.newDeckName });
    newName.addEventListener('input', () => { st.newDeckName = newName.value; });
    parts.push(settingRow({ title: 'Import into', desc: 'Rows with their own deck column go to that deck (created if needed).', control: [deckSel, !st.targetDeckId ? newName : null] }));
    parts.push(settingRow({ title: 'Default answer mode', control: select({ label: 'Default answer mode', options: [{ value: '', label: 'Deck default' }, ...Object.entries(ANSWER_MODE_LABELS).map(([value, label]) => ({ value, label }))], value: st.defaultMode, onchange: (v) => { st.defaultMode = v; rebuild(); } }) }));
    parts.push(settingRow({ title: 'Default task type', control: select({ label: 'Default task type', options: Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({ value, label })), value: st.defaultTask, onchange: (v) => { st.defaultTask = v; rebuild(); } }) }));
    const s = importSummary(st.drafts, st.parsed?.unused, st.parsed?.errors);
    return [
      h('section', { class: 'panel' }, parts),
      callout('info', `${s.total} card draft${s.total === 1 ? '' : 's'} found · ${s.invalid} with problems · ${s.duplicates} duplicate${s.duplicates === 1 ? '' : 's'} · ${s.unused} line${s.unused === 1 ? '' : 's'} not recognised`),
      h('div', { class: 'row between' }, button('Back', { iconName: 'chevronLeft', onclick: () => go(1) }), button('Preview', { kind: 'primary', iconName: 'chevronRight', onclick: () => { rebuild(); go(3); } })),
    ];
  }

  // -------------------------------------------------------------- step 3
  function stepPreview() {
    const s = importSummary(st.drafts, st.parsed.unused, st.parsed.errors);
    const rows = st.drafts.slice(0, st.shown).map((d, i) => draftRow(d, i));
    const table = h('div', { class: 'table-wrap' }, h('table', { class: 'import-table' },
      h('thead', {}, h('tr', {}, h('th', {}, h('span', { class: 'visually-hidden' }, 'Include')), h('th', {}, 'Line'), h('th', {}, 'Front'), h('th', {}, 'Back'), h('th', {}, 'Tags'), h('th', {}, 'Status'))),
      h('tbody', {}, rows)));
    const unused = st.parsed.unused || [];
    const errors = st.parsed.errors || [];
    return [
      h('div', { class: 'row' },
        h('span', { class: 'chip success' }, `${s.valid} valid`),
        s.invalid ? h('span', { class: 'chip danger' }, `${s.invalid} invalid`) : null,
        s.duplicates ? h('span', { class: 'chip warning' }, `${s.duplicates} duplicate${s.duplicates === 1 ? '' : 's'}`) : null,
        unused.length ? h('span', { class: 'chip' }, `${unused.length} unrecognised line${unused.length === 1 ? '' : 's'}`) : null,
        h('span', { class: 'grow' }),
        h('span', { class: 'faint small' }, 'Click a cell to edit it.')),
      h('section', { class: 'panel flush' }, table, st.drafts.length > st.shown ? h('div', { class: 'row', style: { padding: '12px' } }, button(`Show ${Math.min(500, st.drafts.length - st.shown)} more`, { small: true, onclick: () => { st.shown += 500; render(); } })) : null),
      errors.length ? h('section', { class: 'panel' }, h('h3', {}, 'Parsing problems'), h('ul', {}, errors.map((e) => h('li', { class: 'small' }, `Line ${e.line}: ${e.message}`)))) : null,
      unused.length ? h('section', { class: 'panel stack' }, h('div', { class: 'row between' }, h('h3', {}, 'Not recognised (kept, not discarded)'), button('Download these lines', { small: true, iconName: 'download', onclick: downloadNotImported })), h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, unused.slice(0, 200).map((u) => h('tr', {}, h('td', { class: 'num faint' }, String(u.line)), h('td', { class: 'mono small' }, u.text), h('td', { class: 'faint small' }, u.reason))))))) : null,
      h('div', { class: 'row between' }, button('Back', { iconName: 'chevronLeft', onclick: () => go(2) }), button('Continue', { kind: 'primary', iconName: 'chevronRight', onclick: () => go(4) })),
    ];
  }

  function editable(value, onchange, label) {
    const td = h('td', { contenteditable: 'true', spellcheck: 'false', 'aria-label': label });
    td.textContent = value;
    td.addEventListener('blur', () => {
      if (td.textContent !== value) onchange(td.textContent);
    });
    td.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        td.blur();
      }
    });
    return td;
  }

  function draftRow(d, i) {
    const update = (patch) => {
      const next = validateDraft({ ...st.drafts[i], ...patch });
      st.drafts[i] = next;
      st.drafts = markDuplicates(st.drafts.map((x) => ({ ...x, action: x.action })), [...app.cache.cards.values()]);
      render();
    };
    const include = h('input', { type: 'checkbox', 'aria-label': `Include line ${d.line}` });
    include.checked = d.include && d.status === 'valid';
    include.disabled = d.status !== 'valid';
    include.addEventListener('change', () => { st.drafts[i] = { ...st.drafts[i], include: include.checked }; render(); });
    const status = [];
    for (const e of d.errors) status.push(h('div', { class: 'small', style: { color: 'var(--danger)' } }, e));
    for (const w of d.warnings) status.push(h('div', { class: 'faint tiny' }, w));
    if (d.duplicate) {
      const label = d.duplicate.type === 'within' ? 'Duplicate within this import' : d.duplicate.type === 'existing' ? 'Already in your collection' : 'Same front as an existing card';
      status.push(h('div', { class: 'small', style: { color: 'var(--warning)' } }, label));
      if (d.duplicate.type !== 'within') {
        status.push(select({ label: 'Duplicate handling', options: [{ value: 'skip', label: 'Skip (keep existing + history)' }, { value: 'update', label: 'Update existing (keeps history)' }, { value: 'import', label: 'Import as new' }], value: d.action, onchange: (v) => { st.drafts[i] = { ...st.drafts[i], action: v, include: true }; render(); } }));
      }
    }
    if (d.cloze) status.push(h('div', { class: 'faint tiny' }, d.cloze.map((c) => `${c.key}: “${c.prompt}” → ${c.expected}`).join(' · ')));
    if (!status.length) status.push(h('span', { class: 'chip success' }, 'OK'));
    return h('tr', { class: [d.status === 'invalid' && 'invalid', d.duplicate && 'dup', (!d.include || d.action === 'skip') && 'off'] },
      h('td', {}, include),
      h('td', { class: 'num faint' }, String(d.line)),
      editable(d.front, (v) => update({ front: v }), `Front, line ${d.line}`),
      editable(d.back, (v) => update({ back: v }), `Back, line ${d.line}`),
      editable(d.tags.join(' '), (v) => update({ tags: normalizeTags(v) }), `Tags, line ${d.line}`),
      h('td', { style: { minWidth: '200px' } }, status));
  }

  function downloadNotImported() {
    downloadBlob(new Blob([notImportedText(st.drafts, st.parsed?.unused || [])], { type: 'text/plain;charset=utf-8' }), 'axon-not-imported.txt');
  }

  // -------------------------------------------------------------- step 4
  function stepConfirm() {
    const s = importSummary(st.drafts, st.parsed.unused, st.parsed.errors);
    const deckName = st.targetDeckId ? app.cache.decks.get(st.targetDeckId)?.name : st.newDeckName || 'Imported cards';
    const importBtn = button(`Import ${s.toImport + s.toUpdate} card${s.toImport + s.toUpdate === 1 ? '' : 's'}`, { kind: 'primary', iconName: 'check', disabled: s.toImport + s.toUpdate === 0, onclick: () => commit(importBtn) });
    return [
      h('section', { class: 'panel stack' },
        h('h3', {}, 'Ready to import'),
        h('div', { class: 'kpis' },
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'New cards'), h('div', { class: 'value' }, String(s.toImport))),
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Updated (history kept)'), h('div', { class: 'value' }, String(s.toUpdate))),
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Skipped'), h('div', { class: 'value' }, String(s.skipped))),
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Unrecognised lines'), h('div', { class: 'value' }, String(s.unused)))),
        h('p', { class: 'muted' }, `Into “${deckName}”${st.drafts.some((d) => d.deck) ? ' (and decks named in the file)' : ''}.`),
        s.toUpdate ? callout('info', 'A local snapshot is saved before existing cards are updated, so this can be reversed from Settings → Data.') : null,
        s.skipped || s.unused ? h('div', { class: 'row' }, h('span', { class: 'faint small grow' }, 'Skipped and unrecognised lines are not lost — download them to keep a copy.'), button('Download', { small: true, iconName: 'download', onclick: downloadNotImported })) : null),
      h('div', { class: 'row between' }, button('Back', { iconName: 'chevronLeft', onclick: () => go(3) }), importBtn),
    ];
  }

  async function commit(btn) {
    btn.disabled = true;
    let record;
    try {
      record = await store.beginImport({ fileName: st.fileName, format: st.format, source: st.text.length <= MAX_SOURCE_STORED ? st.text : null, total: st.drafts.length });
      const deckByName = new Map([...app.cache.decks.values()].map((d) => [d.name.toLowerCase(), d.id]));
      const newDecks = [];
      let targetId = st.targetDeckId;
      if (!targetId) {
        const d = createDeck({ name: st.newDeckName.trim() || 'Imported cards' }, store.deviceId);
        newDecks.push(d);
        targetId = d.id;
        deckByName.set(d.name.toLowerCase(), d.id);
      }
      const resolveDeck = (name) => {
        if (!name) return targetId;
        const key = name.trim().toLowerCase();
        if (deckByName.has(key)) return deckByName.get(key);
        const d = createDeck({ name: name.trim() }, store.deviceId);
        newDecks.push(d);
        deckByName.set(key, d.id);
        return d.id;
      };
      const newCards = [];
      const updates = [];
      for (const d of st.drafts) {
        if (d.status !== 'valid' || !d.include || d.action === 'skip') continue;
        const fields = {
          deckId: resolveDeck(d.deck),
          kind: d.kind,
          front: d.kind === 'cloze' ? [d.front] : decodeAnswers(d.front),
          back: d.kind === 'cloze' ? (d.back.trim() ? [d.back] : []) : decodeAnswers(d.back),
          hint: d.hint,
          explanation: d.explanation,
          tags: d.tags,
          taskType: d.taskType,
          answerMode: d.answerMode || null,
        };
        if (d.action === 'update' && d.duplicate?.cardId) {
          const existing = app.cache.cards.get(d.duplicate.cardId);
          if (existing) updates.push({ ...existing, ...fields, deckId: existing.deckId, tags: [...new Set([...existing.tags, ...fields.tags])] });
        } else {
          newCards.push(createCard(fields, store.deviceId));
        }
      }
      await store.commitImport(record, { newDecks, newCards, updates });
      await app.cache.load();
      st.result = { created: newCards.length, updated: updates.length, decks: newDecks.length, targetId };
      app.setBusy('import', null);
      render();
    } catch (err) {
      btn.disabled = false;
      errorToast(err, 'Import failed — nothing was saved. ');
    }
  }

  function stepResult() {
    const r = st.result;
    return [h('section', { class: 'panel' }, h('div', { class: 'empty' },
      h('div', { class: 'art' }, icon('check')),
      h('h2', {}, `Imported ${r.created} card${r.created === 1 ? '' : 's'}`),
      h('p', {}, `${r.updated ? `${r.updated} existing card${r.updated === 1 ? '' : 's'} updated with history kept. ` : ''}${r.decks ? `${r.decks} new deck${r.decks === 1 ? '' : 's'} created.` : ''}`),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, button('Open deck', { kind: 'primary', href: `#/deck/${r.targetId}` }), button('Import more', { onclick: () => { Object.assign(st, { step: 1, text: '', result: null, drafts: [], parsed: null, shown: 200 }); renderSteps(); render(); } }))))];
  }

  function render() {
    if (st.result) return replace(panel, stepResult());
    const views = { 1: stepSource, 2: stepFormat, 3: stepPreview, 4: stepConfirm };
    replace(panel, views[st.step]());
  }

  renderSteps();
  render();
  return { destroy: () => app.setBusy('import', null) };
}
