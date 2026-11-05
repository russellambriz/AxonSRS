/**
 * Outcome policy: the one rule every grading path uses to turn the
 * evidence of an answer into an FSRS rating (docs/chunk-1-plan.md).
 *
 * Evidence stays separate from the grade: literal correctness, who judged
 * it (evaluator, the learner, a later correction), assistance before the
 * answer was committed, the learner's own retrieval report and confidence,
 * and whether the card was new. Only an independent success can get a
 * successful grade. Assistance, a reveal, "I don't know" and a genuine
 * guess all map to Again once per presentation: a conservative, versioned
 * product rule, not a claim that every hint has the same effect on memory.
 */

import { State } from './scheduler.js';

export const OUTCOME_VERSION = 'axon-outcomes@2';

export const POLICIES = Object.freeze({
  // Correct and independent → Good; Hard/Easy only from an explicit rating.
  standard: 'standard@2',
  // Response-time heuristics may move an independent success to Hard or Easy.
  timing: 'timing-experimental@1',
});

/** Reviews recorded before policies were versioned used the timing grade. */
export const LEGACY_POLICY = 'legacy-fluency';

export const CONFIDENCE = Object.freeze(['guessing', 'unsure', 'confident']);

export const OUTCOME_LABELS = Object.freeze({
  success: 'Correct',
  failed: 'Not quite',
  assisted: 'Answered with help',
  revealed: 'Answer revealed',
  'dont-know': 'Answer revealed',
  guessed: 'Guessed, not counted as recalled',
});

/** Learning phase of the unit before this answer. */
export function phaseOf(state) {
  if (!state || state.state === State.New) return 'new';
  if (state.state === State.Learning) return 'learning';
  if (state.state === State.Relearning) return 'relearning';
  return 'review';
}

/**
 * @param {object} e
 *   correct       literal correctness: true, false, or null when unknown
 *                 (nothing written, or "I needed help")
 *   provenance    'evaluator' | 'self' | 'user-correction'
 *   assistance    { hintShown, solutionViewed, revealed, priorExposure }
 *                 recorded before the answer was committed
 *   confidence    'guessing' | 'unsure' | 'confident' | null (pre-feedback)
 *   dontKnow      the learner chose "I don't know"
 *   selfHelp      self-assessed "I needed help or saw the answer"
 *   guessed       "I guessed without remembering" (a later report)
 *   manualRating  explicit 2/3/4 for an independent success (manual mode)
 *   timingGrade   the response-time grade (timing policy only)
 */
export function assessOutcome({
  correct, provenance = 'evaluator', assistance = {}, confidence = null, dontKnow = false,
  selfHelp = false, guessed = false, typoTolerated = false, phase = 'review',
  policy = POLICIES.standard, manualRating = null, timingGrade = null,
}) {
  const a = assistance || {};
  const conf = CONFIDENCE.includes(confidence) ? confidence : null;
  const guess = conf === 'guessing' || guessed;
  let cls;
  let reason;
  if (dontKnow) [cls, reason] = ['dont-know', 'DONT_KNOW'];
  else if (a.revealed) [cls, reason] = ['revealed', 'REVEALED'];
  else if (selfHelp) [cls, reason] = ['assisted', 'SELF_NEEDED_HELP'];
  else if (!correct) [cls, reason] = ['failed', provenance === 'self' ? 'SELF_INCORRECT' : 'INCORRECT'];
  else if (a.hintShown) [cls, reason] = ['assisted', 'ASSISTED_HINT'];
  else if (a.solutionViewed) [cls, reason] = ['assisted', 'ASSISTED_SOLUTION'];
  else if (a.priorExposure) [cls, reason] = ['assisted', 'ANSWER_SEEN'];
  else if (guess) [cls, reason] = ['guessed', 'GUESSED'];
  else [cls, reason] = ['success', provenance === 'self' ? 'SELF_CORRECT' : provenance === 'user-correction' ? 'CORRECTED' : typoTolerated ? 'CORRECT_TYPO' : 'CORRECT'];
  const independent = cls === 'success';
  let rating = 1;
  if (independent) {
    if ([2, 3, 4].includes(manualRating)) rating = manualRating;
    else if (policy !== POLICIES.standard && [2, 3, 4].includes(timingGrade)) rating = timingGrade;
    else rating = 3;
    if (typoTolerated && rating === 4) rating = 3;
  }
  const retrieval = dontKnow || a.revealed ? 'none' : selfHelp ? 'none' : guess ? 'guess' : conf === 'unsure' ? 'recalled-unsure' : conf === 'confident' ? 'recalled' : 'unknown';
  return {
    v: OUTCOME_VERSION,
    class: cls,
    independent,
    evaluation: correct == null ? 'none' : correct ? 'correct' : 'incorrect',
    provenance,
    retrieval,
    confidence: conf,
    confidenceTiming: conf ? 'pre-feedback' : null,
    phase,
    reason,
    policy,
    rating,
  };
}

const RATING_WORDS = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

/** Plain-language reason for the recorded grade (feedback disclosure). */
export function explainOutcome(o, { manual = false, timingExplanation = '' } = {}) {
  const g = RATING_WORDS[o.rating];
  const first = o.phase === 'new' ? 'First time with this card. ' : '';
  const why = {
    CORRECT: 'Correct on your own.',
    CORRECT_TYPO: 'Correct on your own, with a small typo accepted.',
    SELF_CORRECT: 'You marked your answer correct.',
    CORRECTED: 'Your original answer was accepted. This review was updated.',
    INCORRECT: 'The answer did not match.',
    SELF_INCORRECT: 'You marked your answer as not correct.',
    ASSISTED_HINT: 'You used a hint before answering. This was practice with help; independent recall will be checked again.',
    ASSISTED_SOLUTION: 'You viewed the worked solution before answering. This was practice with help; independent recall will be checked again.',
    ANSWER_SEEN: 'You had already seen the answer for this card in this session, so this is practice with help.',
    SELF_NEEDED_HELP: 'You said you needed help or saw the answer. Independent recall will be checked again.',
    REVEALED: 'The answer was shown before you answered, so this counts as not recalled yet.',
    DONT_KNOW: 'You chose “I don’t know”, so this counts as not recalled yet.',
    GUESSED: 'You marked this as a guess, so it is not counted as recall, even though the answer matched.',
  }[o.reason] || '';
  let how = `Recorded as ${g}.`;
  if (o.independent && manual) how = `You rated it ${g}.`;
  else if (o.independent && o.policy !== POLICIES.standard && o.rating !== 3 && timingExplanation) how = `Recorded as ${g} by the experimental response-time policy: ${timingExplanation}`;
  return `${first}${why} ${how}`.trim();
}
