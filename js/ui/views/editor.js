/**
 * Card editor with live preview, validation, media, related links,
 * scheduling history and revisions.
 */

import { h, replace, formatDate } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store } from '../../data/store.js';
import { page, button, deckOptions, unitChip } from './common.js';
import { select, segmented, switchControl, toast, confirmDialog, sheet, callout, errorToast, settingRow } from '../components.js';
import { richBlock, answerHtml, ensureMath, mediaUrl } from '../render.js';
import { createCard, unitKeys, unitContent, validateCard, classifyEdit, TASK_TYPE_LABELS, ANSWER_MODE_LABELS, effectiveCardSettings, cardSummary } from '../../core/model.js';
import { encodeAnswers, decodeAnswers } from '../../core/aliases.js';
import { parseCloze } from '../../core/cloze.js';
import { previewLatex } from '../../core/match/math.js';
import { parseChem } from '../../core/match/chem.js';
import { unitHistory } from '../../core/stats.js';
import { formatInterval, formatDuration, debounce } from '../../core/util.js';
import { retrievability, STATE_NAMES, RATING_LABELS } from '../../core/scheduler.js';
import { occlusionEditor } from '../occlusion.js';
import { percent } from '../dom.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
const AUDIO_TYPES = /^audio\/(mpeg|mp4|ogg|webm|wav|x-wav|aac)$/;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_AUDIO = 2 * 1024 * 1024;

export const mediaFetcher = async (id) => (await store.getMedia(id))?.blob || null;

export async function newCardView(outlet, params, query) {
  await app.cache.ensure();
  const deckId = query.deck && app.cache.decks.has(query.deck) ? query.deck : [...app.cache.decks.keys()][0];
  if (!deckId) {
    outlet.append(h('div', { class: 'view narrow' }, h('div', { class: 'empty' }, h('h2', {}, 'Create a deck first'), h('p', {}, 'Cards live in decks.'), button('Go to decks', { kind: 'primary', href: '#/decks' }))));
    return null;
  }
  const card = createCard({ deckId, front: '', back: '', kind: query.kind || 'basic' }, store.deviceId);
  card.front = [];
  return editorView(outlet, card, { isNew: true, relatedTo: query.relatedTo || null });
}

export async function view(outlet, { id }, query = {}) {
  await app.cache.ensure();
  const card = app.cache.cards.get(id) || (await store.getCard(id));
  if (!card) {
    outlet.append(h('div', { class: 'view narrow' }, h('div', { class: 'empty' }, h('h2', {}, 'Card not found'), h('p', {}, 'It may have been deleted.'), button('Back to decks', { href: '#/decks', kind: 'primary' }))));
    return null;
  }
  return editorView(outlet, structuredClone(card), { isNew: false, focus: query.focus || null });
}

/**
 * Editor UI. Also used inline from the study screen (onDone callback).
 * Returns { destroy } for router views or { el } when embedded.
 */
export async function editorView(outlet, card, { isNew, embedded = false, onDone = null, relatedTo = null, focus = null }) {
  const original = structuredClone(card);
  const draft = structuredClone(card);
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    schedulePreview();
  };
  const deck = () => app.cache.decks.get(draft.deckId);

  const pg = embedded ? null : page({
    title: isNew ? 'New card' : 'Edit card',
    crumbs: [{ label: 'Decks', href: '#/decks' }, { label: deck()?.name || 'Deck', href: `#/deck/${draft.deckId}` }],
  });
  const container = embedded ? h('div', { class: 'stack loose' }) : pg.body;

  // ---------------- fields ----------------
  const field = (label, control, hint = '') => h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
  const textarea = (value, { rows = 3, placeholder = '', mono = false, onInput }) => {
    const t = h('textarea', { class: ['textarea', mono && 'mono'], rows: String(rows), placeholder, spellcheck: 'true' });
    t.value = value;
    t.addEventListener('input', () => onInput(t.value));
    t.addEventListener('paste', (e) => handlePaste(e, t));
    t.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        save(false);
      }
    });
    return t;
  };

  const frontInput = textarea(draft.kind === 'cloze' ? draft.front[0] || '' : encodeAnswers(draft.front), { rows: 3, placeholder: 'Question, term or prompt (Markdown, $math$, \\ce{chemistry})', onInput: (v) => { draft.front = draft.kind === 'cloze' ? [v] : decodeAnswers(v); markDirty(); } });
  const backInput = textarea(draft.kind === 'cloze' ? draft.back[0] || '' : encodeAnswers(draft.back), { rows: 2, placeholder: 'Answer — separate accepted alternatives with |', onInput: (v) => { draft.back = draft.kind === 'cloze' ? (v.trim() ? [v] : []) : decodeAnswers(v); markDirty(); } });
  const hintInput = textarea(draft.hint, { rows: 2, placeholder: 'Optional hint (using it caps the grade)', onInput: (v) => { draft.hint = v; markDirty(); } });
  const explInput = textarea(draft.explanation, { rows: 3, placeholder: 'Optional explanation or worked solution, shown after answering', onInput: (v) => { draft.explanation = v; markDirty(); } });
  const tagsInput = h('input', { class: 'input', placeholder: 'tags separated by spaces' });
  tagsInput.value = draft.tags.join(' ');
  tagsInput.addEventListener('input', () => { draft.tags = [...new Set(tagsInput.value.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean))]; markDirty(); });

  const frontLabel = h('label', {}, 'Front');
  const backLabel = h('label', {}, 'Back');
  const frontHint = h('div', { class: 'hint' });
  const backHint = h('div', { class: 'hint' });
  const clozeBtn = h('button', { class: 'btn small', type: 'button', onclick: insertCloze }, '{{c…}} Insert cloze');
  const imageBtn = h('label', { class: 'btn small', tabindex: '0' }, icon('image'), 'Image', h('input', { type: 'file', accept: IMAGE_TYPES.join(','), class: 'visually-hidden', onchange: (e) => { const f = e.target.files[0]; if (f) insertImage(f, lastFocused || frontInput); e.target.value = ''; } }));
  let lastFocused = null;
  for (const t of [frontInput, backInput, hintInput, explInput]) t.addEventListener('focus', () => { lastFocused = t; });

  const occlusionHost = h('div', { class: 'stack' });
  const frontField = h('div', { class: 'field' }, h('div', { class: 'row between' }, frontLabel, h('div', { class: 'row tight' }, clozeBtn, imageBtn)), frontInput, frontHint);
  const backField = h('div', { class: 'field' }, backLabel, backInput, backHint);

  function applyKind() {
    const kind = draft.kind;
    clozeBtn.hidden = kind !== 'cloze';
    occlusionHost.hidden = kind !== 'occlusion';
    backField.hidden = kind === 'occlusion';
    if (kind === 'cloze') {
      frontLabel.textContent = 'Text with clozes';
      frontHint.textContent = 'Wrap hidden text in {{c1::…}}. Different numbers become separate cards; the same number is hidden together. Add a hint with {{c1::answer::hint}} and alternatives with {{c1::a|b}}.';
      backLabel.textContent = 'Extra (shown after answering)';
      backHint.textContent = '';
    } else if (kind === 'occlusion') {
      frontLabel.textContent = 'Title or question (optional)';
      frontHint.textContent = '';
      renderOcclusionEditor();
    } else {
      frontLabel.textContent = 'Front';
      frontHint.textContent = 'In “Back → Front” or “Both” decks this side is also typed as an answer.';
      backLabel.textContent = 'Back';
      backHint.textContent = 'Separate accepted answers with | (type \\| for a literal pipe).';
    }
  }

  const kindControl = segmented({
    label: 'Card type',
    options: [{ value: 'basic', label: 'Basic' }, { value: 'cloze', label: 'Cloze' }, { value: 'occlusion', label: 'Image occlusion' }],
    value: draft.kind,
    onchange: (v) => {
      const text = frontInput.value;
      draft.kind = v;
      draft.front = v === 'cloze' ? [text] : decodeAnswers(text);
      draft.back = v === 'cloze' ? (backInput.value.trim() ? [backInput.value] : []) : decodeAnswers(backInput.value);
      if (v === 'occlusion' && !draft.occlusion) draft.occlusion = { imageId: null, alt: '', masks: [], order: 'random', reveal: 'hideAll' };
      applyKind();
      markDirty();
    },
  });

  const deckSelect = select({ label: 'Deck', options: deckOptions(), value: draft.deckId, onchange: (v) => { draft.deckId = v; markDirty(); } });
  const modeSelect = select({ label: 'Answer mode', options: [{ value: '', label: `Deck default (${ANSWER_MODE_LABELS[deck()?.settings?.answerMode || 'text']})` }, ...Object.entries(ANSWER_MODE_LABELS).map(([value, label]) => ({ value, label }))], value: draft.answerMode || '', onchange: (v) => { draft.answerMode = v || null; markDirty(); } });
  const taskSelect = select({ label: 'Task type', options: Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({ value, label })), value: draft.taskType || 'recall', onchange: (v) => { draft.taskType = v; markDirty(); } });

  // Advanced
  const tolInput = h('input', { class: 'input', placeholder: 'e.g. 0.01 or 1%', style: { width: '140px' } });
  tolInput.value = draft.match?.numericTolerance || '';
  tolInput.addEventListener('input', () => { draft.match = { ...draft.match, numericTolerance: tolInput.value.trim() || undefined }; markDirty(); });
  const audioHost = h('div', { class: 'stack' });
  const relatedHost = h('div', { class: 'stack' });
  const advanced = h('details', { class: 'disclosure' }, h('summary', {}, 'Advanced'), h('div', { class: 'body stack' },
    settingRow({ title: 'Case sensitivity', control: segmented({ options: [{ value: 'deck', label: 'Deck default' }, { value: 'on', label: 'Case-sensitive' }, { value: 'off', label: 'Ignore case' }], value: draft.match?.caseSensitive == null ? 'deck' : draft.match.caseSensitive ? 'on' : 'off', onchange: (v) => { draft.match = { ...draft.match, caseSensitive: v === 'deck' ? undefined : v === 'on' }; markDirty(); } }) }),
    settingRow({ title: 'Exact spelling only', desc: 'Turn off typo tolerance for this card (useful for technical terms).', control: switchControl({ checked: !!draft.match?.strictSpelling, onchange: (v) => { draft.match = { ...draft.match, strictSpelling: v || undefined }; markDirty(); } }) }),
    settingRow({ title: 'Maths equivalence', control: segmented({ options: [{ value: 'deck', label: 'Deck default' }, { value: 'notation', label: 'Notation' }, { value: 'numeric', label: 'Numeric' }, { value: 'algebraic', label: 'Algebraic' }], value: draft.match?.mathEquivalence || 'deck', onchange: (v) => { draft.match = { ...draft.match, mathEquivalence: v === 'deck' ? undefined : v }; markDirty(); } }) }),
    settingRow({ title: 'Numeric tolerance', desc: 'Accept numbers within an absolute amount (0.01) or a percentage (1%). Maths mode only.', control: tolInput }),
    settingRow({ title: 'Suspended', desc: 'Suspended cards never appear in study until unsuspended.', control: switchControl({ checked: !!draft.suspended, onchange: (v) => { draft.suspended = v; markDirty(); } }) }),
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Audio clips'), audioHost),
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Related cards'), relatedHost)));

  const errorsEl = h('div', { class: 'stack' });
  const previewEl = h('div', { class: 'stack' });
  const saveBtn = button(isNew ? 'Add card' : 'Save', { kind: 'primary', onclick: () => save(false) });
  const saveNextBtn = isNew ? button('Add & next', { onclick: () => save(true) }) : null;
  const footer = h('div', { class: 'row end' },
    !isNew && !embedded ? button('Duplicate', { iconName: 'copy', onclick: duplicate }) : null,
    !isNew && !embedded ? button('Delete', { kind: 'danger', iconName: 'trash', onclick: remove }) : null,
    h('span', { class: 'grow' }),
    button('Cancel', { onclick: cancel }),
    saveNextBtn, saveBtn);

  const form = h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('label', {}, 'Deck'), deckSelect), h('div', { class: 'field' }, h('div', { class: 'label' }, 'Type'), kindControl)),
    frontField, occlusionHost, backField,
    h('div', { class: 'grid-2' }, field('Answer mode', modeSelect), field('Task type', taskSelect, 'Calculation and multi-step cards aren’t graded Hard just for taking longer.')),
    field('Hint', hintInput),
    field('Explanation / worked solution', explInput, 'Viewing it before answering counts as assistance.'),
    field('Tags', tagsInput),
    advanced, errorsEl, footer);

  container.append(h('div', { class: 'editor-grid' }, h('section', { class: 'panel' }, form), h('section', { class: 'panel', 'aria-label': 'Preview' }, h('h3', {}, 'Preview'), previewEl)));
  if (!embedded) outlet.append(pg.root);
  else outlet.append(container);

  // ---------------- media ----------------
  async function storeImage(file) {
    if (!IMAGE_TYPES.includes(file.type)) throw new Error(`Unsupported image type ${file.type || 'unknown'} (use PNG, JPEG, GIF, WebP or AVIF; SVG is not allowed for safety)`);
    if (file.size > MAX_IMAGE) throw new Error(`Image is ${(file.size / 1048576).toFixed(1)} MB; the limit is 5 MB`);
    return store.putMedia(file, { name: file.name || 'image' });
  }

  async function insertImage(file, target) {
    try {
      const id = await storeImage(file);
      const alt = (file.name || 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[[\]]/g, '');
      const md = `![${alt}](axon-media:${id})`;
      const start = target.selectionStart ?? target.value.length;
      target.setRangeText(md, start, target.selectionEnd ?? start, 'end');
      target.dispatchEvent(new Event('input'));
      draft.media = [...new Set([...(draft.media || []), id])];
      toast('Image added — edit the text in [ ] to change its alternative text');
    } catch (err) {
      errorToast(err);
    }
  }

  function handlePaste(e, target) {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      insertImage(file, target);
    }
  }

  function insertCloze() {
    const t = frontInput;
    const parsed = parseCloze(t.value);
    const next = Math.max(0, ...parsed.blanks.map((b) => b.number || 0)) + 1;
    const start = t.selectionStart;
    const end = t.selectionEnd;
    const sel = t.value.slice(start, end) || 'answer';
    t.setRangeText(`{{c${next}::${sel}}}`, start, end, 'end');
    t.focus();
    t.dispatchEvent(new Event('input'));
  }

  async function renderOcclusionEditor() {
    const occ = draft.occlusion;
    const upload = h('label', { class: 'btn' }, icon('image'), occ?.imageId ? 'Replace image' : 'Choose image', h('input', { type: 'file', accept: IMAGE_TYPES.join(','), class: 'visually-hidden', onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const id = await storeImage(f);
        draft.occlusion = { ...draft.occlusion, imageId: id, alt: draft.occlusion?.alt || f.name.replace(/\.[a-z0-9]+$/i, '') };
        markDirty();
        renderOcclusionEditor();
      } catch (err) {
        errorToast(err);
      }
    } }));
    const altInput = h('input', { class: 'input', placeholder: 'Describe the image for screen readers' });
    altInput.value = occ?.alt || '';
    altInput.addEventListener('input', () => { draft.occlusion = { ...draft.occlusion, alt: altInput.value }; markDirty(); });
    const parts = [h('div', { class: 'row' }, upload, h('span', { class: 'faint small' }, 'PNG, JPEG, GIF, WebP or AVIF up to 5 MB'))];
    if (occ?.imageId) {
      const url = await mediaUrl(occ.imageId, mediaFetcher);
      if (!url) parts.push(callout('danger', 'The image for this card is missing on this device (it may not have synced yet).'));
      else parts.push(occlusionEditor({ imageUrl: url, masks: occ.masks || [], onChange: (masks) => { draft.occlusion = { ...draft.occlusion, masks }; markDirty(); } }));
      parts.push(h('div', { class: 'field' }, h('label', {}, 'Alternative text'), altInput));
      parts.push(settingRow({ title: 'Presentation', desc: 'Random order reduces memorising positions instead of content.', control: segmented({ options: [{ value: 'random', label: 'Random order' }, { value: 'fixed', label: 'Fixed order' }], value: occ.order || 'random', onchange: (v) => { draft.occlusion = { ...draft.occlusion, order: v }; markDirty(); } }) }));
      parts.push(settingRow({ title: 'Other masks while answering', control: segmented({ options: [{ value: 'hideAll', label: 'Hide all' }, { value: 'hideOne', label: 'Show others' }, { value: 'progressive', label: 'Progressive reveal' }], value: occ.reveal || 'hideAll', onchange: (v) => { draft.occlusion = { ...draft.occlusion, reveal: v }; markDirty(); } }) }));
    }
    replace(occlusionHost, parts);
  }

  async function renderAudio() {
    const row = (slot, label) => {
      const id = draft.audio?.[slot];
      const input = h('input', { type: 'file', accept: 'audio/*', class: 'visually-hidden', onchange: async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        if (!AUDIO_TYPES.test(f.type)) return errorToast(new Error(`Unsupported audio type ${f.type || 'unknown'}`));
        if (f.size > MAX_AUDIO) return errorToast(new Error(`Audio is ${(f.size / 1048576).toFixed(1)} MB; the limit is 2 MB`));
        const mid = await store.putMedia(f, { name: f.name });
        draft.audio = { ...(draft.audio || {}), [slot]: mid };
        markDirty();
        renderAudio();
      } });
      return h('div', { class: 'row tight' }, h('span', { class: 'small', style: { minWidth: '120px' } }, label), id ? h('span', { class: 'chip success' }, icon('volume'), 'Attached') : h('span', { class: 'faint small' }, 'None'),
        h('label', { class: 'btn small' }, id ? 'Replace' : 'Attach', input),
        id ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => { draft.audio = { ...draft.audio, [slot]: null }; markDirty(); renderAudio(); } }, 'Remove') : null);
    };
    replace(audioHost, row('prompt', 'With the question'), row('answer', 'With the answer'), h('p', { class: 'faint tiny' }, 'Clips up to 2 MB are stored on this device and included in backups and sync.'));
  }

  function renderRelated() {
    const links = app.cache.links.filter((l) => l.a === draft.id || l.b === draft.id);
    replace(relatedHost,
      links.length ? h('div', { class: 'list' }, links.map((l) => {
        const other = app.cache.cards.get(l.a === draft.id ? l.b : l.a);
        return h('div', { class: 'list-row' }, icon('link'), other ? h('a', { class: 'grow truncate', href: `#/card/${other.id}` }, cardSummary(other).front) : h('span', { class: 'grow faint' }, 'Deleted card'), h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { await store.removeLink(l.id); await app.cache.load(); renderRelated(); } }, 'Unlink'));
      })) : h('p', { class: 'faint small' }, isNew ? 'Save the card first, then link related cards.' : 'No linked cards. Related cards are kept apart in study sessions.'),
      !isNew ? h('button', { class: 'btn small', type: 'button', onclick: linkPicker }, icon('link'), 'Link a card…') : null);
  }

  async function linkPicker() {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Search cards' });
    const results = h('div', { class: 'list' });
    const s = sheet({ title: 'Link a related card', content: h('div', { class: 'stack' }, input, results) });
    const run = debounce(() => {
      const q = input.value.toLowerCase().trim();
      const list = [...app.cache.cards.values()].filter((c) => c.id !== draft.id && (!q || cardSummary(c).front.toLowerCase().includes(q))).slice(0, 30);
      replace(results, list.map((c) => h('button', { class: 'list-row clickable', style: { border: 0, background: 'transparent', width: '100%', textAlign: 'left' }, onclick: async () => {
        await store.addLink(draft.id, c.id);
        await app.cache.load();
        s.close();
        renderRelated();
      } }, h('span', { class: 'truncate' }, cardSummary(c).front))));
    }, 120);
    input.addEventListener('input', run);
    run();
    setTimeout(() => input.focus(), 30);
  }

  // ---------------- preview & validation ----------------
  const schedulePreview = debounce(renderPreview, 120);
  async function renderPreview() {
    const d = deck();
    const v = validateCard(draft);
    const issues = [...v.errors];
    const notes = [];
    const s = effectiveCardSettings(draft, d);
    const keys = draft.kind === 'basic' ? ['fwd', 'rev'] : unitKeys(draft, d);
    const activeKeys = new Set(unitKeys(draft, d));
    await ensureMath();
    const blocks = [];
    for (const key of keys) {
      if (draft.kind === 'basic' && key === 'rev' && !activeKeys.has('rev')) continue;
      if (draft.kind === 'basic' && key === 'fwd' && !activeKeys.has('fwd')) continue;
      const c = unitContent(draft, key);
      const label = key === 'fwd' ? 'Front → Back' : key === 'rev' ? 'Back → Front' : key.startsWith('o-') ? `Mask ${key.slice(2)}` : `Cloze ${key.startsWith('c') ? key.slice(1) : '(unnumbered)'}`;
      const answers = h('div', { class: 'row tight' });
      for (const group of c.answerGroups) {
        for (const a of group) {
          const chip = h('span', { class: 'chip' });
          chip.innerHTML = answerHtml(a, s.answerMode);
          answers.append(chip);
          if (s.answerMode === 'math') {
            const p = previewLatex(a);
            if (!p.ok) notes.push(`“${a}” could not be read as maths (${p.error}); it will be matched as exact text.`);
          }
          if (s.answerMode === 'chem') {
            try {
              parseChem(a);
            } catch (err) {
              notes.push(`“${a}” could not be read as a formula (${err.message}); it will be matched as exact text.`);
            }
          }
        }
      }
      blocks.push(h('div', { class: 'stack', style: { gap: '8px' } },
        h('div', { class: 'faint tiny', style: { textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 } }, label),
        c.prompt ? richBlock(c.prompt, { class: 'preview-box', media: mediaFetcher }) : h('div', { class: 'preview-box faint' }, '(empty prompt)'),
        c.instruction ? h('div', { class: 'faint small' }, c.instruction) : null,
        h('div', { class: 'row tight' }, h('span', { class: 'faint small' }, 'Accepted:'), answers)));
    }
    if (draft.explanation) blocks.push(h('div', { class: 'stack', style: { gap: '6px' } }, h('div', { class: 'faint tiny', style: { textTransform: 'uppercase', fontWeight: 600 } }, 'Explanation'), richBlock(draft.explanation, { class: 'preview-box', media: mediaFetcher })));
    replace(previewEl, blocks.length ? blocks : h('p', { class: 'faint' }, 'Start typing to see a preview.'));
    replace(errorsEl, [...issues.map((e) => callout('danger', e)), ...notes.map((n) => callout('warning', n))]);
    saveBtn.disabled = issues.length > 0;
    if (saveNextBtn) saveNextBtn.disabled = issues.length > 0;
  }

  // ---------------- actions ----------------
  async function save(addAnother) {
    const v = validateCard(draft);
    if (!v.valid) {
      renderPreview();
      return;
    }
    try {
      let resets = new Map();
      if (!isNew) {
        const changes = classifyEdit(original, draft, deck());
        const units = app.cache.unitsOfCard(draft.id).filter((u) => u.state && changes[u.key] === 'substantive');
        if (units.length) {
          const choice = await sheet({
            title: 'This edit changes what the card tests',
            content: h('div', { class: 'stack' }, h('p', { class: 'muted' }, `The prompt or main answer changed for ${units.length} study unit${units.length > 1 ? 's' : ''} with review history. Keep the current schedule (the history stays attached), or start this card over as new? Either way the old answers remain in the history.`)),
            footer: (close) => [h('button', { class: 'btn', onclick: () => close('cancel') }, 'Back to editing'), h('button', { class: 'btn', onclick: () => close('keep') }, 'Keep schedule'), h('button', { class: 'btn primary', onclick: () => close('reset') }, 'Start over')],
          }).done;
          if (!choice || choice === 'cancel') return;
          if (choice === 'reset') resets = new Map([[draft.id, units.map((u) => u.key)]]);
        }
      }
      const saved = await store.saveCard(draft, { resets, sessionId: embedded ? 'in-session' : null });
      if (isNew && relatedTo) await store.addLink(saved.id, relatedTo);
      dirty = false;
      await app.cache.load();
      if (embedded) {
        onDone?.(saved);
        return;
      }
      if (addAnother) {
        toast('Card added');
        app.router.navigate(`/card/new?deck=${draft.deckId}&kind=${draft.kind}`);
        return;
      }
      toast(isNew ? 'Card added' : 'Saved');
      app.navigate(`/deck/${saved.deckId}`);
    } catch (err) {
      errorToast(err);
    }
  }

  async function cancel() {
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', message: 'Your edits to this card have not been saved.', confirmLabel: 'Discard', danger: true }))) return;
    dirty = false;
    if (embedded) onDone?.(null);
    else history.length > 1 ? history.back() : app.navigate(`/deck/${draft.deckId}`);
  }

  async function remove() {
    const ok = await confirmDialog({ title: 'Delete this card?', message: 'Its review history is kept. You can undo right after.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    const trashId = await store.deleteCards([draft.id]);
    dirty = false;
    app.navigate(`/deck/${draft.deckId}`);
    toast('Card deleted', { action: { label: 'Undo', run: () => store.restoreTrash(trashId) }, timeout: 10000 });
  }

  async function duplicate() {
    const copy = createCard({ ...draft, id: undefined, version: null, createdAt: undefined }, store.deviceId);
    const saved = await store.saveCard(copy);
    await app.cache.load();
    toast('Duplicated (without review history)');
    app.navigate(`/card/${saved.id}`);
  }

  // ---------------- history & revisions ----------------
  async function renderHistory() {
    if (isNew || embedded) return;
    const [events, revisions] = await Promise.all([store.eventsForCard(draft.id), store.revisionsFor(draft.id)]);
    const units = app.cache.unitsOfCard(draft.id);
    const sections = [];
    for (const u of units) {
      const d = deck();
      const params = store.paramsFor(d);
      const r = u.state ? retrievability(u.state, Date.now(), params) : null;
      const rows = unitHistory(events, u.id).reverse();
      const label = u.key === 'fwd' ? 'Front → Back' : u.key === 'rev' ? 'Back → Front' : u.key.startsWith('o-') ? 'Mask' : `Cloze ${u.key}`;
      sections.push(h('section', { class: 'panel stack' },
        h('div', { class: 'row between' }, h('h3', {}, `${label}${u.active ? '' : ' (inactive)'}`), h('div', { class: 'row tight' }, unitChip(u, draft), u.leech ? h('span', { class: 'chip danger' }, 'Leech') : null)),
        u.state ? h('div', { class: 'timing' },
          h('span', {}, 'State ', h('b', {}, STATE_NAMES[u.state.state])),
          h('span', {}, 'Due ', h('b', {}, formatDate(u.state.due, { dateStyle: 'medium', timeStyle: 'short' }))),
          h('span', {}, 'Interval ', h('b', {}, formatInterval(u.state.scheduled_days || 0))),
          h('span', {}, 'Stability ', h('b', {}, `${u.state.stability.toFixed(1)} d`)),
          h('span', {}, 'Difficulty ', h('b', {}, u.state.difficulty.toFixed(2))),
          h('span', {}, 'Reviews ', h('b', {}, String(u.state.reps))),
          h('span', {}, 'Lapses ', h('b', {}, String(u.state.lapses))),
          r != null ? h('span', { title: 'Model estimate, not an observation' }, 'Predicted recall now ', h('b', {}, percent(r))) : null) : h('p', { class: 'faint small' }, 'Not studied yet.'),
        u.overlays?.postponedUntil ? callout('info', `Postponed until ${u.overlays.postponedUntil} (its real due date is unchanged).`) : null,
        rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ['When', 'Type', 'Answer', 'Result', 'Grade', 'First key', 'Total', 'Interval'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows.slice(0, 60).map((x) => h('tr', { title: x.explanation || '' },
            h('td', { class: 'nowrap' }, formatDate(x.ts, { dateStyle: 'short', timeStyle: 'short' })),
            h('td', {}, x.type === 'review' ? (x.mode === 'daily' || x.mode === 'catchup' ? 'Review' : `Review (${x.mode})`) : x.type, x.voided ? h('span', { class: 'chip' }, 'undone') : null),
            h('td', { class: 'mono truncate', style: { maxWidth: '180px' } }, x.response ?? ''),
            h('td', {}, x.correct == null ? '' : x.correct ? '✓' : '✗', x.diagnostics.length ? h('span', { class: 'faint tiny' }, ` ${x.diagnostics.join(', ')}`) : null),
            h('td', {}, x.effectiveRating ? RATING_LABELS[x.effectiveRating] : '', x.overrides.length ? h('span', { class: 'faint tiny' }, ` (${x.overrides.join(', ')})`) : ''),
            h('td', { class: 'num' }, x.latencyMs != null ? formatDuration(x.latencyMs) : ''),
            h('td', { class: 'num' }, x.totalMs != null ? formatDuration(x.totalMs) : ''),
            h('td', { class: 'num' }, x.intervalDays != null ? formatInterval(x.intervalDays) : '')))))) : null,
        h('div', { class: 'row tight' },
          u.state ? button('Reset schedule', { small: true, iconName: 'refresh', onclick: async () => {
            if (!(await confirmDialog({ title: 'Reset this schedule?', message: 'The unit starts over as new. A reset event is recorded; history is kept.', confirmLabel: 'Reset', danger: true }))) return;
            await store.saveCard(app.cache.cards.get(draft.id), { resets: new Map([[draft.id, [u.key]]]) });
            await app.cache.load();
            renderHistory();
          } }) : null,
          button(u.suspended ? 'Unsuspend unit' : 'Suspend unit', { small: true, onclick: async () => { await store.patchUnits([{ unitId: u.id, suspended: !u.suspended }]); await app.cache.load(); renderHistory(); } }),
          button('Bury until tomorrow', { small: true, onclick: async () => { await store.patchUnits([{ unitId: u.id, overlays: { buriedUntil: (await import('../../core/time.js')).addDays(store.today(), 1) } }]); await app.cache.load(); toast('Buried until the next study day'); renderHistory(); } }),
          u.overlays?.postponedUntil ? button('Cancel postponement', { small: true, onclick: async () => { await store.patchUnits([{ unitId: u.id, overlays: { postponedUntil: null } }]); await app.cache.load(); renderHistory(); } }) : null)));
    }
    revisions.sort((a, b) => b.ts - a.ts);
    sections.push(h('details', { class: 'disclosure' }, h('summary', {}, `Revisions (${revisions.length})`), h('div', { class: 'body list' }, revisions.slice(0, 50).map((rev, i) => h('div', { class: 'list-row' },
      h('div', { class: 'grow' }, h('div', { class: 'small' }, `${formatDate(rev.ts, { dateStyle: 'medium', timeStyle: 'short' })}${rev.deviceId === 'merge' ? ' · merged' : rev.deviceId === store.deviceId ? ' · this device' : ' · another device'}`), h('div', { class: 'faint tiny truncate' }, `${(rev.snapshot.front || [])[0] || ''} → ${(rev.snapshot.back || []).join(' | ')}`)),
      i === 0 ? h('span', { class: 'chip' }, 'Current') : button('Restore', { small: true, onclick: async () => {
        const current = app.cache.cards.get(draft.id);
        await store.saveCard({ ...current, ...rev.snapshot });
        await app.cache.load();
        toast('Restored that version (as a new revision)');
        app.router.navigate(`/card/${draft.id}`);
      } }))))));
    replace(historyHost, sections);
  }

  const historyHost = h('div', { class: 'stack loose' });
  if (!isNew && !embedded) container.append(h('h2', {}, 'Scheduling & history'), historyHost);

  applyKind();
  renderAudio();
  renderRelated();
  renderPreview();
  renderHistory();
  if (!embedded) {
    setTimeout(() => {
      const target = focus === 'hint' ? hintInput : frontInput;
      target.focus();
      if (focus) target.scrollIntoView({ block: 'center' });
    }, 30);
  }
  if (!embedded) app.leaveGuard = async () => (!dirty || confirmDialog({ title: 'Leave without saving?', message: 'Your changes to this card will be lost.', confirmLabel: 'Leave', danger: true }));
  return {
    el: container,
    destroy: () => {
      app.leaveGuard = null;
      schedulePreview.cancel();
    },
  };
}
