/**
 * Settings defaults. "Global" settings sync across devices (per-key
 * last-writer-wins); "device" settings stay on this device (theme,
 * input-modality override, sync credentials, storage choices).
 */

export const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  desiredRetention: 0.9,
  maximumInterval: 36500,
  gradingMode: 'auto', // 'auto' | 'manual' | 'research'
  gradingOverrides: {},
  showWhy: true,
  confidencePrompt: true,
  requireRetype: true,
  autoAdvanceMs: 0,
  practiceAffectsSchedule: { cram: false, drill: false, speed: false, interleave: false, exam: false },
  timeZone: '', // '' → device timezone
  rolloverHour: 4,
  learnAheadMinutes: 20,
  toolbarPreset: 'auto', // 'auto' | 'math' | 'chem' | 'general' | 'custom'
  toolbarCustom: ['π', '√', '^', '/', '(', ')', '-', '+', '²', '³', 'θ', 'Δ', '±', '∞'],
  shortcuts: {},
  tts: { enabled: false, autoPrompt: false, autoAnswer: false, rate: 1, voice: '' },
  voiceInput: false,
  focusTimer: { enabled: false, minutes: 25, breakMinutes: 5 },
  backupReminderDays: 7,
  research: { study: null },
  leechMinDifficulty: 7,
  relatedSpacing: true,
});

export const DEFAULT_DEVICE_SETTINGS = Object.freeze({
  theme: 'system', // 'system' | 'light' | 'dark'
  fontScale: 1,
  dyslexiaFont: false,
  reduceMotion: 'system',
  modalityOverride: 'auto', // 'auto' | 'physical' | 'touch' | 'voice'
  sync: { gistId: '', rememberToken: false, autoSync: true, encrypt: false, rememberPassphrase: false, lastSyncAt: null, lastError: null, lastRemoteVersion: null },
  lastBackupAt: null,
  onboarded: false,
  persistAsked: false,
});

export function mergeSettings(defaults, stored) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(stored || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) out[k] = { ...defaults[k], ...v };
    else out[k] = v;
  }
  return out;
}
