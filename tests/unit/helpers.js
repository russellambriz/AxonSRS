// Shared fixtures for unit tests: deterministic clocks, cards, units, trials.
import { createCard, createDeck, unitKeys, unitId } from '../../js/core/model.js';
import { schedulerParams } from '../../js/core/scheduler.js';
import { planReview, evaluateAnswer } from '../../js/core/review.js';

export const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
export const DAY = 86400000;
export const MIN = 60000;

export function makeDeck(settings = {}) {
  return createDeck({ id: 'deck-1', name: 'Test', settings }, 'dev-A');
}

export function makeCard(fields = {}) {
  return createCard({ id: 'card-1', deckId: 'deck-1', front: 'Sulfate', back: 'SO4^2-', answerMode: 'chem', ...fields }, 'dev-A');
}

export function makeUnits(card, deck) {
  return unitKeys(card, deck).map((key) => ({ id: unitId(card.id, key), cardId: card.id, deckId: card.deckId, key, state: null, headEventId: null, active: true, suspended: false, overlays: {}, perf: { recent: [] } }));
}

export function rawTrial({ latencyMs = 1500, typingMs = 1000, text = '' } = {}) {
  return {
    raw: { latencyMs, typingMs, totalMs: latencyMs + typingMs, activeMs: latencyMs + typingMs, effort: 6, answerLength: text.length, corrections: 0, pauses: 0, longestGapMs: 300, hiddenMs: 0, origins: { typed: 6 } },
    responseText: text,
    modality: { kind: 'physical', confidence: 0.9 },
    prompt: { words: 1, mathTokens: 0, images: 0, chars: 7 },
    assistance: { hintShown: false, revealed: false, solutionViewed: false },
    isWarmup: false,
  };
}

let counter = 0;
/** Plan a review of `unit` with typed `text` at time `at`. */
export function review({ unit, card, deck, text, at, live = true, deviceId = 'dev-A', mode = 'daily', eventId = `ev-${++counter}`, baseline = null, params = schedulerParams(), gradeMode = 'auto', manualRating = null, research = null, firstAttempt = true }) {
  const match = evaluateAnswer(card, deck, unit.key, text);
  return planReview({
    eventId, now: at, deviceId, seq: counter, sessionId: 's1', mode, live, unit, card, deck,
    trial: rawTrial({ text }), match, baseline, params, studyDay: '2026-01-05', timeZone: 'UTC', gradeMode, manualRating, research, firstAttempt,
  });
}
