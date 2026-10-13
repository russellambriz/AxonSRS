/** Settings: appearance, study, grading, input, data, sync, research, about. */

import { h, replace, formatDate, formatBytes, readFileAsText, downloadBlob } from '../dom.js';
import { icon } from '../icons.js';
import { app } from '../../app.js';
import { store, AxonStore } from '../../data/store.js';
import { page, button } from './common.js';
import { settingRow, switchControl, segmented, select, toast, confirmDialog, sheet, callout, errorToast, promptDialog } from '../components.js';
import { applyAppearance } from '../appearance.js';
import { ACTIONS, displayCombo, comboFromEvent } from '../keyboard.js';
import { exportBackup, exportAnkiFile } from '../exporters.js';
import { readBackup } from '../../core/backup.js';
import { open as openEnvelope, isEnvelope } from '../../core/sync/envelope.js';
import { createStudy } from '../../core/research.js';
import { APP_VERSION, DB_VERSION, RECORD_VERSION, SCHEDULER_VERSION, GRADING_VERSION, MATCHER_VERSION, READING_HEURISTIC_VERSION, LIBRARIES, CACHE_NAME, BACKUP_FORMAT } from '../../config.js';
import { systemTimeZone, isValidTimeZone } from '../../core/time.js';
import { uuid } from '../../core/util.js';
import { setAllowRemoteImages } from '../render.js';

const SECTIONS = [
  ['appearance', 'Appearance', 'sun'],
  ['study', 'Study', 'study'],
  ['grading', 'Grading', 'target'],
  ['input', 'Input & keyboard', 'keyboard'],
  ['data', 'Data & backup', 'shield'],
  ['sync', 'Sync', 'cloud'],
  ['research', 'Research', 'beaker'],
  ['about', 'About', 'info'],
];

export async function view(outlet, { section = 'appearance' }, query) {
  await app.cache.ensure();
  const { root, body } = page({ title: 'Settings' });
  outlet.append(root);
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' }, SECTIONS.map(([key, label, ic]) => h('a', { class: 'nav-link', href: `#/settings/${key}`, 'aria-current': key === section ? 'page' : 'false' }, icon(ic), h('span', {}, label))));
  const content = h('div', { class: 'stack loose' });
  body.append(h('div', { class: 'settings-layout' }, nav, content));
  const renderers = { appearance, study, grading, input, data, sync, research, about };
  const render = async () => replace(content, await (renderers[section] || appearance)(query, render));
  await render();
  return null;
}

const g = () => store.global;
const d = () => store.device;
const saveG = async (patch) => { await store.setGlobal(patch); };
const saveD = async (patch) => { await store.setDevice(patch); applyAppearance(store.device); };

function numberInput(value, onchange, { min, max, step = 1, width = '100px', placeholder = '' } = {}) {
  const el = h('input', { class: 'input', type: 'number', min: min != null ? String(min) : undefined, max: max != null ? String(max) : undefined, step: String(step), placeholder, style: { width } });
  el.value = value ?? '';
  el.addEventListener('change', () => onchange(el.value === '' ? null : Number(el.value)));
  return el;
}

/* ------------------------------------------------------------ appearance */

function appearance() {
  const slider = h('input', { type: 'range', min: '0.85', max: '1.4', step: '0.05', value: String(d().fontScale || 1), 'aria-label': 'Text size', style: { width: '180px' } });
  const label = h('span', { class: 'faint small num' }, `${Math.round((d().fontScale || 1) * 100)}%`);
  slider.addEventListener('input', () => {
    label.textContent = `${Math.round(Number(slider.value) * 100)}%`;
    document.documentElement.style.setProperty('--font-scale', slider.value);
  });
  slider.addEventListener('change', () => saveD({ fontScale: Number(slider.value) }));
  return [h('section', { class: 'panel' }, h('h2', {}, 'Appearance'),
    settingRow({ title: 'Theme', desc: 'System follows your device’s light/dark setting.', control: segmented({ options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], value: d().theme, onchange: (v) => saveD({ theme: v }) }) }),
    settingRow({ title: 'Text size', control: [slider, label] }),
    settingRow({ title: 'Dyslexia-friendly font', desc: 'Uses OpenDyslexic (bundled, works offline).', control: switchControl({ checked: d().dyslexiaFont, onchange: (v) => saveD({ dyslexiaFont: v }) }) }),
    settingRow({ title: 'Motion', desc: 'Reduce animations. “System” follows your device’s reduced-motion preference.', control: segmented({ options: [{ value: 'system', label: 'System' }, { value: 'reduce', label: 'Reduce' }], value: d().reduceMotion || 'system', onchange: (v) => saveD({ reduceMotion: v }) }) }),
    settingRow({ title: 'Load remote images in cards', desc: 'Off by default for privacy and offline reliability; images you add are stored locally.', control: switchControl({ checked: !!d().allowRemoteImages, onchange: async (v) => { await saveD({ allowRemoteImages: v }); setAllowRemoteImages(v); } }) }))];
}

/* ----------------------------------------------------------------- study */

function study() {
  const ret = h('input', { type: 'range', min: '70', max: '99', step: '1', value: String(Math.round((g().desiredRetention || 0.9) * 100)), 'aria-label': 'Desired retention', style: { width: '180px' } });
  const retLabel = h('span', { class: 'num', style: { minWidth: '40px' } }, `${ret.value}%`);
  ret.addEventListener('input', () => { retLabel.textContent = `${ret.value}%`; });
  ret.addEventListener('change', () => saveG({ desiredRetention: Number(ret.value) / 100 }));
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const tz = zones.length
    ? select({ label: 'Timezone', options: [{ value: '', label: `Device (${systemTimeZone()})` }, ...zones.map((z) => ({ value: z, label: z }))], value: g().timeZone || '', onchange: (v) => saveG({ timeZone: v }) })
    : (() => { const el = h('input', { class: 'input', placeholder: systemTimeZone(), value: g().timeZone || '' }); el.addEventListener('change', () => { if (!el.value || isValidTimeZone(el.value)) saveG({ timeZone: el.value }); else toast('Unknown timezone'); }); return el; })();
  const practice = g().practiceAffectsSchedule || {};
  const tts = g().tts || {};
  const voices = globalThis.speechSynthesis?.getVoices?.() || [];
  const focus = g().focusTimer || {};
  return [
    h('section', { class: 'panel' }, h('h2', {}, 'Scheduling'),
      settingRow({ title: 'Desired retention', desc: 'The recall probability FSRS aims for when a card comes due. Higher means more reviews. Default 90%. Decks can override this.', control: [ret, retLabel] }),
      settingRow({ title: 'Study day starts at', desc: 'Reviews after midnight but before this hour count for the previous day.', control: select({ label: 'Rollover hour', options: Array.from({ length: 13 }, (_, i) => ({ value: i, label: `${String(i).padStart(2, '0')}:00` })), value: g().rolloverHour ?? 4, onchange: (v) => saveG({ rolloverHour: Number(v) }) }) }),
      settingRow({ title: 'Study timezone', desc: 'Event timestamps are stored in UTC; study days are derived in this timezone (daylight saving handled).', control: tz }),
      settingRow({ title: 'Keep related cards apart', desc: 'Manual “related” links are spaced like siblings.', control: switchControl({ checked: g().relatedSpacing !== false, onchange: (v) => saveG({ relatedSpacing: v }) }) })),
    h('section', { class: 'panel' }, h('h2', {}, 'Practice modes'), h('p', { class: 'faint small' }, 'By default Cram, Drill, Speed, Interleaving and Exam practice are recorded as exposure only and never change your long-term FSRS schedule.'),
      ...['cram', 'drill', 'speed', 'interleave', 'exam'].map((m) => settingRow({ title: `Record ${m === 'interleave' ? 'interleaving' : m} as scheduling reviews`, control: switchControl({ checked: !!practice[m], onchange: (v) => saveG({ practiceAffectsSchedule: { ...g().practiceAffectsSchedule, [m]: v } }) }) }))),
    h('section', { class: 'panel' }, h('h2', {}, 'Review flow'),
      settingRow({ title: 'Retype after a mistake', desc: 'Type the correct answer once before moving on (never counted as recall). Turn off if typing is difficult; you can also skip it per card.', control: switchControl({ checked: g().requireRetype !== false, onchange: (v) => saveG({ requireRetype: v }) }) }),
      settingRow({ title: 'Auto-advance after a correct answer', desc: 'Milliseconds; 0 = off (press Enter to continue).', control: numberInput(g().autoAdvanceMs ?? 0, (v) => saveG({ autoAdvanceMs: v || 0 }), { min: 0, max: 10000, step: 100 }) }),
      settingRow({ title: 'Show “Why this grade?”', control: switchControl({ checked: g().showWhy !== false, onchange: (v) => saveG({ showWhy: v }) }) }),
      settingRow({ title: 'Ask for confidence (optional, 1–5)', desc: 'Stored separately from the automatic grade; never required.', control: switchControl({ checked: g().confidencePrompt !== false, onchange: (v) => saveG({ confidencePrompt: v }) }) }),
      settingRow({ title: 'Backup reminder', desc: 'Remind me when there has been no backup or sync for this many days (0 = never).', control: numberInput(g().backupReminderDays ?? 7, (v) => saveG({ backupReminderDays: v ?? 0 }), { min: 0, max: 90 }) })),
    h('section', { class: 'panel' }, h('h2', {}, 'Focus timer'),
      settingRow({ title: 'Session focus timer', desc: 'Pomodoro-style: after this much active study, Axon suggests a break at the next safe point. Paused time and background time do not count, and it never affects answer timing.', control: switchControl({ checked: !!focus.enabled, onchange: (v) => saveG({ focusTimer: { ...focus, enabled: v } }) }) }),
      settingRow({ title: 'Minutes of study', control: numberInput(focus.minutes ?? 25, (v) => saveG({ focusTimer: { ...g().focusTimer, minutes: v || 25 } }), { min: 1, max: 180 }) }),
      settingRow({ title: 'Break length (minutes)', control: numberInput(focus.breakMinutes ?? 5, (v) => saveG({ focusTimer: { ...g().focusTimer, breakMinutes: v || 5 } }), { min: 1, max: 60 }) })),
    h('section', { class: 'panel' }, h('h2', {}, 'Read aloud'),
      callout('info', 'Uses your browser’s speech synthesis. Some voices need a network connection (often on Chrome) while built-in system voices work offline (typically Safari on iOS/macOS, and most Android voices once downloaded).'),
      settingRow({ title: 'Enable read aloud', control: switchControl({ checked: !!tts.enabled, onchange: (v) => saveG({ tts: { ...g().tts, enabled: v } }) }) }),
      settingRow({ title: 'Read each question automatically', desc: 'Timing starts after the question has been read.', control: switchControl({ checked: !!tts.autoPrompt, onchange: (v) => saveG({ tts: { ...g().tts, autoPrompt: v } }) }) }),
      settingRow({ title: 'Read the answer after submitting', control: switchControl({ checked: !!tts.autoAnswer, onchange: (v) => saveG({ tts: { ...g().tts, autoAnswer: v } }) }) }),
      settingRow({ title: 'Speed', control: numberInput(tts.rate ?? 1, (v) => saveG({ tts: { ...g().tts, rate: v || 1 } }), { min: 0.5, max: 2, step: 0.1 }) }),
      voices.length ? settingRow({ title: 'Voice', control: select({ label: 'Voice', options: [{ value: '', label: 'Default' }, ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})${v.localService ? '' : ' · online'}` }))], value: tts.voice || '', onchange: (v) => saveG({ tts: { ...g().tts, voice: v } }) }) }) : null),
  ];
}

/* --------------------------------------------------------------- grading */

function grading(query, rerender) {
  const o = g().gradingOverrides || {};
  const th = o.thresholds || {};
  const setO = (patch) => saveG({ gradingOverrides: { ...g().gradingOverrides, ...patch } });
  return [
    h('section', { class: 'panel' }, h('h2', {}, 'Automatic grading'),
      h('p', { class: 'muted small' }, 'Axon infers Again/Hard/Good/Easy from correctness first, then — only for correct, independent answers with reliable timing and enough personal calibration — from how quickly and fluently you retrieved the answer. You can always correct a grade with “I knew that” or “I guessed”.'),
      settingRow({ title: 'Grading mode', desc: 'Manual: you choose the grade after each answer (accessibility or comparison). Research: cards are randomly assigned to automatic or manual grading (see Research).', control: segmented({ options: [{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual' }, { value: 'research', label: 'Research' }], value: g().gradingMode || 'auto', onchange: (v) => saveG({ gradingMode: v }) }) }),
      settingRow({ title: 'Highest grade after using a hint', control: segmented({ options: [{ value: 'good', label: 'Good' }, { value: 'hard', label: 'Hard' }], value: o.hintCeiling || 'good', onchange: (v) => setO({ hintCeiling: v }) }) }),
      settingRow({ title: '“I guessed” records', control: segmented({ options: [{ value: 'hard', label: 'Hard' }, { value: 'again', label: 'Again' }], value: o.guessedGrade || 'hard', onchange: (v) => setO({ guessedGrade: v }) }) }),
      settingRow({ title: 'Reading-time and warm-up adjustments', desc: 'Heuristics: subtract an estimated time to read the prompt, and allow extra time on the first card of a session. Raw measurements are always kept.', control: switchControl({ checked: o.heuristicsEnabled !== false, onchange: (v) => setO({ heuristicsEnabled: v }) }) })),
    h('details', { class: 'disclosure' }, h('summary', {}, 'Thresholds (advanced)'), h('div', { class: 'body' },
      h('p', { class: 'faint small' }, 'Hesitation is measured in robust standard deviations from your personal median (log scale) for the same input method and task type.'),
      settingRow({ title: 'Hard when hesitation ≥', control: numberInput(th.hard ?? 1.0, (v) => setO({ thresholds: { ...th, hard: v ?? 1 } }), { min: 0.3, max: 4, step: 0.1 }) }),
      settingRow({ title: 'Easy when hesitation ≤', control: numberInput(th.easy ?? -0.8, (v) => setO({ thresholds: { ...th, easy: v ?? -0.8 } }), { min: -4, max: 0, step: 0.1 }) }),
      settingRow({ title: 'Hard while calibration is provisional when ≥', control: numberInput(th.provisionalHard ?? 2.0, (v) => setO({ thresholds: { ...th, provisionalHard: v ?? 2 } }), { min: 0.5, max: 5, step: 0.1 }) }),
      settingRow({ title: 'Reset grading settings', control: button('Reset to defaults', { small: true, onclick: async () => { await saveG({ gradingOverrides: {} }); toast('Grading settings reset'); rerender(); } }) }))),
    h('section', { class: 'panel' }, h('h2', {}, 'Input method'),
      settingRow({ title: 'Input method on this device', desc: 'Axon detects physical keyboards, on-screen keyboards and voice per answer, and reports “unknown” when unsure. Override only if detection is wrong for you.', control: segmented({ options: [{ value: 'auto', label: 'Detect' }, { value: 'physical', label: 'Physical' }, { value: 'touch', label: 'Touchscreen' }], value: d().modalityOverride || 'auto', onchange: (v) => saveD({ modalityOverride: v }) }) }),
      settingRow({ title: 'Timing calibration', desc: 'Personal baselines rebuild automatically from correct, independent answers.', control: button('Reset calibration', { small: true, kind: 'danger', onclick: async () => { if (await confirmDialog({ title: 'Reset timing calibration?', message: 'Correct answers will be graded Good until enough new samples accumulate. Review history is not affected.', confirmLabel: 'Reset', danger: true })) { await store.resetCalibration(); toast('Calibration reset'); } } }) })),
  ];
}

/* ----------------------------------------------------------------- input */

function input(query, rerender) {
  const custom = h('input', { class: 'input', value: (g().toolbarCustom || []).join(' '), placeholder: 'Symbols separated by spaces', style: { width: '320px' } });
  custom.addEventListener('change', () => saveG({ toolbarCustom: custom.value.split(/\s+/).filter(Boolean).slice(0, 40) }));
  const rows = Object.entries(ACTIONS).map(([action, def]) => {
    const keys = app.shortcuts.keysFor(action);
    const change = h('button', { class: 'btn small', type: 'button', onclick: () => captureShortcut(action, rerender) }, 'Change');
    return h('tr', {}, h('td', {}, def.label), h('td', {}, keys.map((k) => h('kbd', { style: { marginRight: '4px' } }, displayCombo(k)))), h('td', {}, change, g().shortcuts?.[action] ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { const s = { ...g().shortcuts }; delete s[action]; await saveG({ shortcuts: s }); rerender(); } }, 'Reset') : null));
  });
  return [
    h('section', { class: 'panel' }, h('h2', {}, 'Symbol toolbar'),
      settingRow({ title: 'Symbol set', desc: 'Automatic picks maths or chemistry symbols from the card’s answer mode. You can also switch sets with the ⋯ button while studying.', control: segmented({ options: [{ value: 'auto', label: 'Automatic' }, { value: 'general', label: 'General' }, { value: 'math', label: 'Maths' }, { value: 'chem', label: 'Chemistry' }, { value: 'custom', label: 'Custom' }], value: g().toolbarPreset || 'auto', onchange: (v) => saveG({ toolbarPreset: v }) }) }),
      settingRow({ title: 'Custom symbols', control: custom })),
    h('section', { class: 'panel' }, h('h2', {}, 'Voice input'),
      callout('info', 'Voice answers use your browser’s speech recognition, which on most browsers sends audio to an online service and does not work offline. Voice timing is calibrated separately and never mixed with typing baselines.'),
      settingRow({ title: 'Show the microphone button', control: switchControl({ checked: !!g().voiceInput, onchange: (v) => saveG({ voiceInput: v }) }) })),
    h('section', { class: 'panel' }, h('h2', {}, 'Keyboard shortcuts'), h('p', { class: 'faint small' }, 'Single-key shortcuts only work when you are not typing in a field; the ⌥/Alt versions always work. Press ? anywhere for the cheat sheet.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, rows)))),
  ];
}

function captureShortcut(action, rerender) {
  const label = h('p', { class: 'muted' }, 'Press the new key combination…');
  const s = sheet({ title: `Shortcut: ${ACTIONS[action].label}`, content: label });
  const onKey = async (e) => {
    if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      s.close();
      return;
    }
    const combo = comboFromEvent(e);
    const problem = app.shortcuts.validate(action, combo);
    if (problem) {
      label.textContent = `${displayCombo(combo)}: ${problem}. Try another.`;
      return;
    }
    document.removeEventListener('keydown', onKey, true);
    await saveG({ shortcuts: { ...g().shortcuts, [action]: [combo] } });
    s.close();
    toast(`Shortcut set to ${displayCombo(combo)}`);
    rerender();
  };
  document.addEventListener('keydown', onKey, true);
  s.done.then(() => document.removeEventListener('keydown', onKey, true));
}

/* ------------------------------------------------------------------ data */

async function data(query, rerender) {
  const status = await AxonStore.storageStatus();
  const snaps = await store.listSnapshots();
  const persistText = status.persisted === true ? 'Granted — the browser will not evict Axon’s data under storage pressure.' : status.persisted === false ? 'Not granted — the browser may clear data under storage pressure (common on iOS). Keep backups or sync.' : 'Not supported by this browser.';
  const exportPass = h('input', { class: 'input', type: 'password', placeholder: 'Optional passphrase', autocomplete: 'new-password', style: { width: '200px' } });
  const blocks = [
    h('section', { class: 'panel' }, h('h2', {}, 'Storage on this device'),
      settingRow({ title: 'Persistent storage', desc: persistText, control: status.persisted ? h('span', { class: 'chip success' }, icon('check'), 'Persistent') : button('Request again', { small: true, onclick: async () => { const r = await AxonStore.requestPersistence(); toast(r.result === 'granted' ? 'Persistent storage granted' : r.result === 'denied' ? 'The browser declined. Installing Axon to the home screen often helps.' : 'Not supported here'); rerender(); } }) }),
      settingRow({ title: 'Space used', desc: status.quota ? `${formatBytes(status.usage)} of about ${formatBytes(status.quota)} available to this site.` : 'The browser does not report quota.', control: null }),
      callout('warning', 'Persistence does not protect against clearing site data, uninstalling the browser, or losing the device. Local snapshots are not a backup — export a backup or use sync.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Backup'),
      settingRow({ title: 'Export a full backup', desc: `Decks, cards, aliases, media, review history, revisions, scheduling state and settings. Never includes your GitHub token or passphrases. Last backup: ${d().lastBackupAt ? formatDate(d().lastBackupAt, { dateStyle: 'medium', timeStyle: 'short' }) : 'never'}.`, control: [
        button('JSON', { iconName: 'download', small: true, onclick: () => exportBackup({}).then((r) => toast(`Saved ${r.name} (${formatBytes(r.size)})`)).catch(errorToast) }),
        button('Compressed', { small: true, onclick: () => exportBackup({ compress: true }).then((r) => toast(`Saved ${r.name} (${formatBytes(r.size)})`)).catch(errorToast) }),
      ] }),
      settingRow({ title: 'Encrypted backup', desc: 'AES-256-GCM with a key derived from your passphrase (PBKDF2, 600 000 iterations). If you lose the passphrase the backup cannot be recovered.', control: [exportPass, button('Export', { small: true, iconName: 'lock', onclick: () => { if (exportPass.value.length < 8) return toast('Use a passphrase of at least 8 characters'); exportBackup({ passphrase: exportPass.value }).then((r) => { exportPass.value = ''; toast(`Saved ${r.name}`); }).catch(errorToast); } })] }),
      settingRow({ title: 'Restore or merge a backup', desc: 'Preview first. Merging never deletes anything on this device; replacing takes a snapshot first.', control: h('label', { class: 'btn small' }, icon('upload'), 'Choose file', h('input', { type: 'file', accept: '.json,.axon,application/json', class: 'visually-hidden', onchange: async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreFlow(await readFileAsText(f), rerender); } })) }),
      settingRow({ title: 'Export for Anki', desc: 'Plain-text notes with front, back, tags, deck and a scheduling note. Anki cannot import FSRS state or review history from text; image-occlusion cards are skipped. Use JSON backups for full fidelity.', control: button('Export all decks', { small: true, iconName: 'download', onclick: () => exportAnkiFile([...app.cache.decks.keys()]).then((r) => toast(`Exported ${r.count} notes`)).catch(errorToast) }) })),
    h('section', { class: 'panel' }, h('h2', {}, 'Local snapshots'), h('p', { class: 'faint small' }, 'Taken automatically before destructive imports, replacements and database upgrades (the last 3 are kept).'),
      snaps.length ? h('div', { class: 'list' }, snaps.map((s) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', {}, s.reason), h('div', { class: 'faint tiny' }, `${formatDate(s.createdAt, { dateStyle: 'medium', timeStyle: 'short' })} · ${formatBytes(s.size)} · ${s.counts.cards ?? 0} cards, ${s.counts.events ?? 0} events`)),
        button('Restore', { small: true, onclick: async () => { if (await confirmDialog({ title: 'Restore this snapshot?', message: 'Current data is snapshotted first, then replaced with this snapshot.', confirmLabel: 'Restore', danger: true })) { await store.restoreSnapshot(s.id); await app.cache.load(); toast('Snapshot restored'); rerender(); } } }),
        button('Delete', { small: true, kind: 'ghost', onclick: async () => { await store.deleteSnapshot(s.id); rerender(); } })))) : h('p', { class: 'faint' }, 'No snapshots yet.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Integrity'),
      settingRow({ title: 'Verify schedules', desc: 'Replays every card’s review history through the scheduler and compares the result with the stored schedule.', control: button('Verify', { small: true, onclick: async () => {
        const res = await store.verifySchedules();
        if (!res.mismatches.length) return toast(`All ${res.checked} schedules match their history`);
        if (await confirmDialog({ title: `${res.mismatches.length} schedule(s) differ from history`, message: 'Rebuild them from the review history? (A snapshot is taken first.)', confirmLabel: 'Rebuild' })) {
          await store.snapshot('before schedule rebuild');
          await store.rebuildSchedules(res.mismatches.map((m) => m.unitId));
          await app.cache.load();
          toast('Rebuilt from history');
        }
      } }) }),
      settingRow({ title: 'Recovery', desc: 'Interrupted imports, unsaved reviews and snapshots.', control: button('Open recovery', { small: true, href: '#/recovery' }) })),
  ];
  if (query.restore && app.pendingBackupText) {
    const text = app.pendingBackupText;
    app.pendingBackupText = null;
    setTimeout(() => restoreFlow(text, rerender), 50);
  }
  return blocks;
}

async function restoreFlow(text, rerender) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return errorToast(new Error('That file is not valid JSON.'));
  }
  try {
    if (isEnvelope(obj)) {
      let passphrase = null;
      if (obj.encryption) {
        passphrase = await promptDialog({ title: 'Encrypted backup', label: 'Passphrase', confirmLabel: 'Decrypt' });
        if (!passphrase) return;
      }
      obj = await openEnvelope(obj, { passphrase, expectedFormat: BACKUP_FORMAT });
    }
  } catch (err) {
    return errorToast(err);
  }
  const res = readBackup(obj);
  if (!res.ok) return errorToast(new Error(res.errors[0].message));
  const c = Object.fromEntries(Object.entries(res.dataset).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
  const s = sheet({
    title: 'Restore backup',
    content: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, `Made with Axon ${res.meta.app || '?'} on ${res.meta.exportedAt ? formatDate(res.meta.exportedAt, { dateStyle: 'medium', timeStyle: 'short' }) : 'an unknown date'}.`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, ['decks', 'cards', 'units', 'events', 'revisions', 'media', 'links', 'plans'].map((k) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, String(c[k] ?? 0))))))),
      res.migrations.length ? callout('info', `Upgraded from an older format (${res.migrations.join(', ')}).`) : null,
      res.errors.length ? h('div', { class: 'stack' }, callout('warning', `${res.errors.length} problem(s) found — valid records will still be restored:`), h('ul', { class: 'small' }, res.errors.slice(0, 20).map((e) => h('li', {}, `${e.collection}${e.index >= 0 ? ` #${e.index + 1}` : ''}${e.id ? ` (${String(e.id).slice(0, 12)})` : ''}: ${e.message}`)))) : callout('success', 'All records passed validation.'),
      callout('info', 'Merge keeps everything on this device and adds what the backup has (review events are combined by id, conflicting edits are flagged). Replace makes this device match the backup after taking a snapshot.')),
    footer: (close) => [
      h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: () => close('replace') }, 'Replace'),
      h('button', { class: 'btn primary', onclick: () => close('merge') }, 'Merge'),
    ],
  });
  const choice = await s.done;
  if (!choice) return;
  try {
    if (choice === 'replace') {
      if (!(await confirmDialog({ title: 'Replace all data?', message: 'Everything on this device will be replaced by the backup. A snapshot of the current data is saved first.', confirmLabel: 'Replace', danger: true }))) return;
      await store.replaceAll(res.dataset, { reason: 'backup restore (replace)' });
    } else {
      await store.snapshot('before backup merge');
      const out = await store.mergeIn(res.dataset, { reason: 'backup restore' });
      if (out.report.conflicts.length) toast(`${out.report.conflicts.length} conflict(s) need review`, { action: { label: 'Review', run: () => app.navigate('/conflicts') } });
    }
    await app.cache.load();
    toast('Backup restored');
    rerender();
  } catch (err) {
    errorToast(err, 'Restore failed — your data was not changed. ');
  }
}

/* ------------------------------------------------------------------ sync */

async function sync(query, rerender) {
  const cfg = d().sync || {};
  const svc = app.sync;
  await svc.loadCredentials();
  const intro = h('section', { class: 'panel stack' }, h('h2', {}, 'Sync with a GitHub Gist'),
    h('p', { class: 'muted small' }, 'Optional. Axon keeps working fully offline; each device studies on its own and sync merges the review histories when you are online. You provide a GitHub token; Axon stores your data in a secret Gist on your account.'),
    callout('warning', 'A secret Gist is not private: anyone who has its URL can read it. Turn on encryption to make the contents unreadable without your passphrase.'));
  if (!cfg.gistId) {
    const token = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'github_pat_… or ghp_…' });
    const gistId = h('input', { class: 'input', placeholder: 'Leave empty to create a new secret Gist' });
    let remember = false;
    let encrypt = false;
    let rememberPass = false;
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'At least 10 characters' });
    const pass2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repeat passphrase' });
    const passBox = h('div', { class: 'stack', hidden: true }, h('div', { class: 'grid-2' }, pass, pass2), callout('danger', 'If you lose the passphrase, the synced copy cannot be decrypted by anyone, including you. Your local data is unaffected.'), settingRow({ title: 'Remember the key on this device', desc: 'Stores a non-extractable encryption key in this browser so you don’t retype the passphrase. Anyone with access to this browser profile could sync.', control: switchControl({ checked: false, onchange: (v) => { rememberPass = v; } }) }));
    const connectBtn = button('Connect', { kind: 'primary', iconName: 'cloud', onclick: async () => {
      if (!token.value.trim()) return toast('Paste a token first');
      if (encrypt && (pass.value.length < 10 || pass.value !== pass2.value)) return toast(pass.value !== pass2.value ? 'Passphrases do not match' : 'Use at least 10 characters');
      connectBtn.disabled = true;
      try {
        await svc.connect({ token: token.value, gistId: gistId.value, rememberToken: remember, encrypt, passphrase: pass.value, rememberPassphrase: rememberPass });
        token.value = '';
        pass.value = '';
        pass2.value = '';
        toast('Connected — syncing now');
        await svc.sync({ reason: 'connect' }).catch((e) => errorToast(e));
        rerender();
      } catch (err) {
        connectBtn.disabled = false;
        errorToast(err);
      }
    } });
    return [intro, h('section', { class: 'panel stack' },
      h('h3', {}, 'Create a token'),
      h('ol', { class: 'small muted', style: { paddingLeft: '18px', margin: 0 } },
        h('li', {}, 'On GitHub open Settings → Developer settings → Personal access tokens.'),
        h('li', {}, 'Fine-grained token: under “Account permissions” set Gists to “Read and write”, nothing else. (Classic token: tick only the “gist” scope.)'),
        h('li', {}, 'Choose an expiry, generate it and paste it below. Never share it, and never put it in a backup, export or URL — Axon doesn’t.')),
      h('div', { class: 'field' }, h('label', {}, 'GitHub token'), token, h('div', { class: 'hint' }, 'Sent only to api.github.com.')),
      settingRow({ title: 'Remember the token on this device', desc: 'Stored in this browser’s IndexedDB, readable by anyone with access to this browser profile (and by malicious extensions). Off: you paste it each session.', control: switchControl({ checked: false, onchange: (v) => { remember = v; } }) }),
      h('div', { class: 'field' }, h('label', {}, 'Existing Gist (optional)'), gistId, h('div', { class: 'hint' }, 'To connect a second device, paste the Gist ID or URL shown on your first device.')),
      settingRow({ title: 'Encrypt synced data', desc: 'Compressed, then AES-256-GCM encrypted on this device. The passphrase is never uploaded.', control: switchControl({ checked: false, onchange: (v) => { encrypt = v; passBox.hidden = !v; } }) }),
      passBox,
      h('div', { class: 'row end' }, connectBtn))];
  }
  const st = svc.status;
  const tokenInput = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'GitHub token for this session' });
  const passInput = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Sync passphrase' });
  const needs = svc.needsToken() || svc.needsPassphrase();
  const conflicts = await store.listConflicts();
  return [intro, h('section', { class: 'panel stack' },
    h('div', { class: 'row between' }, h('h3', {}, 'Connected'), h('a', { href: `https://gist.github.com/${cfg.gistId}`, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Open Gist')),
    h('div', { class: 'faint small mono' }, `Gist ${cfg.gistId}${cfg.encrypt ? ' · encrypted' : ' · not encrypted'}`),
    h('div', {}, `Last successful sync: ${cfg.lastSyncAt ? formatDate(cfg.lastSyncAt, { dateStyle: 'medium', timeStyle: 'short' }) : 'never'}`),
    cfg.lastError ? callout('danger', `${cfg.lastError.message} (${formatDate(cfg.lastError.at, { timeStyle: 'short' })})`) : null,
    st.state === 'ok' && st.result ? h('div', { class: 'faint small' }, `Last run: received ${st.result.pulled?.newEvents ?? 0} new events, uploaded ${st.result.uploaded} file(s).`) : null,
    conflicts.length ? callout('warning', `${conflicts.length} conflict(s) need your decision.`) : null,
    conflicts.length ? button('Review conflicts', { small: true, href: '#/conflicts' }) : null,
    needs ? h('div', { class: 'stack' }, svc.needsToken() ? tokenInput : null, svc.needsPassphrase() ? passInput : null, button('Unlock', { small: true, onclick: async () => { try { await svc.unlock({ token: tokenInput.value || null, passphrase: passInput.value || null }); tokenInput.value = ''; passInput.value = ''; toast('Unlocked for this session'); rerender(); } catch (err) { errorToast(err); } } })) : null,
    h('div', { class: 'row' },
      button('Sync now', { kind: 'primary', iconName: 'refresh', disabled: needs, onclick: async () => { try { const r = await svc.sync({ reason: 'manual' }); toast(`Synced · ${r.pulled?.newEvents ?? 0} new events received`); } catch (err) { errorToast(err); } rerender(); } }),
      button('Disconnect', { onclick: async () => { if (await confirmDialog({ title: 'Disconnect sync?', message: 'This device stops syncing and forgets the token and key. Your local data and the Gist are not deleted.', confirmLabel: 'Disconnect' })) { await svc.disconnect(); rerender(); } } })),
    settingRow({ title: 'Sync automatically', desc: 'A couple of minutes after changes, on startup, and when the connection returns.', control: switchControl({ checked: cfg.autoSync !== false, onchange: (v) => saveD({ sync: { ...d().sync, autoSync: v } }) }) }),
    h('p', { class: 'faint tiny' }, 'Gist has no atomic multi-device transactions. Axon reads before writing, re-checks just before uploading, verifies the result, and merges any write that slipped in between from the Gist revision history. Review events are combined by id; simultaneous edits of the same card are flagged for you to resolve.'))];
}

/* -------------------------------------------------------------- research */

function research(query, rerender) {
  const s = g().research?.study;
  return [h('section', { class: 'panel stack' }, h('h2', {}, 'Research comparison mode'),
    h('p', { class: 'muted small' }, 'Compare Axon’s automatic grading with standard FSRS self-grading on your own material. Each card (with its siblings) is assigned to one arm for the whole study period, so answers don’t leak between conditions. Reports compare later independent recall and total study time, with sample sizes and uncertainty.'),
    callout('warning', 'One learner’s short trial cannot establish that either method is better. Treat results as descriptive.'),
    s ? h('div', { class: 'stack' }, h('div', {}, `Active study since ${s.startDay} · ${s.design} · ${s.gradingVersion}`),
      settingRow({ title: 'Use research grading now', desc: 'Grading mode must be “Research” for assignments to apply.', control: switchControl({ checked: g().gradingMode === 'research', onchange: (v) => saveG({ gradingMode: v ? 'research' : 'auto' }) }) }),
      h('div', { class: 'row' }, button('View results', { href: '#/stats' }), button('End study', { kind: 'danger', onclick: async () => { await saveG({ research: { study: { ...s, active: false, endDay: store.today() } }, gradingMode: 'auto' }); rerender(); } })))
      : h('div', { class: 'row' }, ...['randomized', 'all-axon', 'all-standard'].map((design) => button(design === 'randomized' ? 'Start randomized study' : design === 'all-axon' ? 'Start (all automatic)' : 'Start (all self-graded)', { kind: design === 'randomized' ? 'primary' : '', onclick: async () => {
        const study = createStudy({ id: uuid(), startDay: store.today(), design, schedulerVersion: SCHEDULER_VERSION, gradingVersion: GRADING_VERSION, desiredRetention: g().desiredRetention });
        await saveG({ research: { study }, gradingMode: 'research' });
        toast('Study started');
        rerender();
      } }))),
    h('p', { class: 'faint tiny' }, 'In the self-graded arm Axon still computes its automatic grade in the background (stored as a shadow value) but never uses it for scheduling. De-identified evaluation data can be exported from Statistics.'))];
}

/* ----------------------------------------------------------------- about */

function about() {
  const rows = [
    ['App', APP_VERSION], ['Cache', CACHE_NAME], ['Database schema', String(DB_VERSION)], ['Record format', String(RECORD_VERSION)],
    ['Scheduler', SCHEDULER_VERSION], ['Grading rules', GRADING_VERSION], ['Reading heuristic', READING_HEURISTIC_VERSION], ['Answer matcher', MATCHER_VERSION],
    ...Object.entries(LIBRARIES).map(([k, v]) => [k, v]),
  ];
  return [h('section', { class: 'panel stack' }, h('h2', {}, 'About Axon'),
    h('p', { class: 'muted' }, 'Offline-first, typed-answer spaced repetition. Layer A: FSRS memory scheduling. Layer B: automatic grades inferred from correctness and retrieval fluency.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'mono small' }, v)))))),
    h('p', { class: 'small' }, 'Open-source libraries are bundled locally under their licences (see ', h('a', { href: './vendor/README.md', target: '_blank' }, 'vendor/README.md'), '). Documentation: ', h('a', { href: 'https://github.com/russellambriz/AxonSRS#readme', target: '_blank', rel: 'noopener noreferrer' }, 'README'), '.'),
    h('p', { class: 'faint tiny' }, `Device id ${store.deviceId.slice(0, 8)} (used to merge history across devices).`))];
}

export { downloadBlob };
