/**
 * Unfinished answers (drafts): what a learner has typed, written and chosen
 * for the card in front of them, before they check it.
 *
 * A draft belongs to one attempt: one session, one queue position, one
 * review unit and its attempt count in that session. A later appearance of
 * the same card is a new attempt and never inherits an earlier draft.
 *
 * A draft is not the submitted response. Once the answer is checked (a
 * review, a reveal, a skip, a self-check), the review event holds what was
 * submitted and the draft for that attempt is gone or no longer restorable.
 *
 * Stored on the session record (`session.draft`), so no database upgrade is
 * needed and older sessions simply have none. The store keeps a draft only
 * while it belongs to the session's current attempt (see `draftBelongsTo`),
 * and every draft write is compare-and-swap on `rev`.
 */

/** Version of the draft record itself. */
export const DRAFT_VERSION = 1;

/** Stages a stored draft can be in. Only `answering` is restored. */
export const DRAFT_STAGES = Object.freeze(['answering', 'exposed']);

export const CONFIDENCE_VALUES = Object.freeze(['guessing', 'unsure', 'confident']);

/** The attempt now in front of the learner in `session`, or null when the queue is finished. */
export function currentAttempt(session) {
  if (!session || !Array.isArray(session.queue)) return null;
  const index = session.index ?? 0;
  if (index >= session.queue.length) return null;
  const unitId = session.queue[index];
  const attempt = session.attempts?.[unitId] || 0;
  return { sessionId: session.id, index, unitId, attempt, key: attemptKey(session.id, index, unitId, attempt) };
}

export function attemptKey(sessionId, index, unitId, attempt) {
  return `${sessionId}:${index}:${unitId}:${attempt}`;
}

/** Does `draft` belong to the attempt `session` is on now? */
export function draftBelongsTo(draft, session) {
  if (!draft || !session) return false;
  if (session.status === 'completed' || session.status === 'abandoned') return false;
  const cur = currentAttempt(session);
  return !!cur && draft.key === cur.key;
}

/** Plain copy of pad strokes: CSS-pixel points of the pad, plus pen colour. Unknown fields are kept. */
export function cloneStrokes(strokes) {
  if (!Array.isArray(strokes)) return [];
  return strokes
    .filter((s) => s && Array.isArray(s.pts) && s.pts.length)
    .map((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p })) }));
}

/**
 * A stored draft as the study screen may use it, or null when there is
 * nothing to restore. Never invents content: missing fields stay empty.
 */
export function readDraft(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string') return null;
  if (raw.v != null && raw.v > DRAFT_VERSION) return null; // written by a newer app: leave it alone
  return {
    v: raw.v ?? DRAFT_VERSION,
    key: raw.key,
    unitId: raw.unitId ?? null,
    cardId: raw.cardId ?? null,
    cardUpdatedAt: raw.cardUpdatedAt ?? null,
    stage: DRAFT_STAGES.includes(raw.stage) ? raw.stage : 'answering',
    mode: raw.mode === 'write' ? 'write' : raw.mode === 'type' ? 'type' : null,
    text: typeof raw.text === 'string' ? raw.text : '',
    ink: { strokes: cloneStrokes(raw.ink?.strokes), width: raw.ink?.width ?? null, height: raw.ink?.height ?? null },
    confidence: CONFIDENCE_VALUES.includes(raw.confidence) ? raw.confidence : null,
    assistance: { hintShown: !!raw.assistance?.hintShown, solutionViewed: !!raw.assistance?.solutionViewed },
    rev: Number.isInteger(raw.rev) ? raw.rev : 0,
    savedAt: raw.savedAt ?? null,
  };
}

/** True when a draft holds nothing the learner made (no text, no ink, no confidence). */
export function isBlankDraft(d) {
  return !d || (!d.text && !(d.ink?.strokes?.length) && !d.confidence);
}
