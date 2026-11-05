# Chunk 1 report — trustworthy answers, learning evidence and grading

Branch `claude/axonsrs-github-pages-setup-43lha6` (not merged to `main`, not
deployed). Plan, audit and design: [`chunk-1-plan.md`](chunk-1-plan.md).

## 1. What changed and why

Before this chunk, a correct answer's grade came from response-time
heuristics by default, a hint capped the grade at Good, "I guessed" gave
Hard, confidence was asked only after feedback, an answer the evaluator
could not read counted as wrong, and Undo re-presented a card whose answer
had been seen as a fresh test. Each of those let the review history claim
more (or less) than the learner had shown.

Now every grading path (typed, handwritten, manual mode, corrections) goes
through one versioned rule, `axon-outcomes@2` in `js/core/outcome.js`.
Every review stores its evidence separately from the FSRS grade:
correctness, who judged it, help used before answering, the learner's
retrieval report and pre-feedback confidence, and whether the card was new.
The student-facing flow stays simple: optional Guessing / Unsure / Confident
chips, "I don't know", a clear outcome label, one self-check panel, and
corrections with unambiguous names.

## 2. Files and their roles

| File | Role |
| --- | --- |
| `js/core/outcome.js` (new) | `assessOutcome` (the policy), `explainOutcome` (plain-language reason), `phaseOf`, policy ids |
| `js/core/review.js` | `planReview` records `outcome`, `grading.policy`, `grading.timingGrade`; `planOverride` applies the policy to "My answer is correct", "I guessed", effort ratings; legacy reviews keep their timing semantics |
| `js/core/match/index.js` | `matchAnswer` reports `unresolved` when no accepted answer can read the response |
| `js/core/fluency.js` | `NOTATION_REPAIRED` exclusion; default "I guessed" → Again |
| `js/core/stats.js` | shared `outcome()` reads the new evidence; `assessmentBreakdown()`, `confidenceAnalysis()` |
| `js/core/research.js` | reviews counted per grading policy; mixed-policy flag |
| `js/ui/views/study.js` | confidence chips, "I don't know", unresolved phase, self-check panel, outcome labels, corrections and `acceptAlias`, exposure tracking (`markExposed`, undo), session summary |
| `js/ui/views/stats.js` | observed recall with its denominator, new vs delayed, confidence tables, research warning |
| `js/ui/views/settings.js`, `js/data/settings.js` | experimental response-time switch (`gradingPolicy`), removed hint-ceiling and "I guessed" settings, reworded texts |
| `js/ui/views/home.js` | accurate welcome text |
| `js/ui/keyboard.js` | shortcut labels for the renamed actions |
| `css/app.css` | confidence chips, compact on phones; shorter pad on short phone screens |
| `tests/unit/outcome.test.js` (new), `tests/browser/grading.spec.mjs` (new) | acceptance matrix tests |
| `tests/unit/{review,stats,backup,fluency,helpers}`, `tests/browser/{flows,session,pencil,recall,stats,harness}` | updated for the new semantics |
| `README.md`, `REQUIREMENTS.md`, `docs/` | documentation |

## 3. Outcome → scheduler mapping (scheduled reviews)

| Evidence | `outcome.class` | FSRS rating |
| --- | --- | --- |
| Correct, no help, not a guess | `success` | Good (3). Hard/Easy only from an explicit choice (manual mode, "Took effort", "It was easy") or the experimental timing policy. A typo-tolerated answer is never Easy. |
| Correct with "Unsure" | `success` | as above |
| Not correct | `failed` | Again (1) |
| "Guessing" before checking, or "I guessed without remembering" | `guessed` | Again |
| Hint or worked solution before answering | `assisted` | Again (once per presentation) |
| Answer already seen in this session (self-check pending at reload, or undone review) | `assisted` (`ANSWER_SEEN`), recorded as practice | none (practice) |
| "I don't know" / answer shown | `dont-know` / `revealed` | Again |
| Evaluator cannot read the answer | not graded until edited (still independent) or self-checked (`provenance: self`) | per result |
| Handwriting | self-checked: Not correct / Correct on my own / I needed help | Again / Good (manual mode: Hard/Good/Easy) / Again |
| Copy, skip | exposure events | none |

New cards use the same mapping with FSRS's new-card transition; `phase:
'new'` keeps them out of delayed-recall figures and the feedback reads "New
card — study the answer". Practice modes keep their declared scheduling
setting.

## 4. Migration and compatibility

- No database migration (DB version unchanged). All new fields are additive
  on new events. Backups and sync carry events whole, so the new fields
  survive both (tested: `tests/unit/backup.test.js` T40/T41).
- Older reviews have no `outcome`: statistics apply the rule they were
  recorded under and count them as legacy; confidence and guesses are
  unknown for them, never invented. Older 1–5 confidence ratings stay as
  post-feedback ratings.
- Corrections to older reviews use the legacy timing policy
  (`legacy-fluency`), so past meaning does not change silently.
- Research studies: reviews record their policy; the report warns when a
  study spans a policy change. The automatic arm keeps the timing policy.
- An older app version reading newer data ignores the extra fields; it
  would show the newer reviews with its own (older) statistics rules.

## 5. Tests actually run

Final run on the last commit of this chunk:

- `npm run check` (precache check + unit tests): 233/233 passed.
- Browser suite, all specs except perf (`node tests/browser/run.mjs
  "^(?!perf)"`, Playwright + Chromium): 53/53 passed.
- Perf spec (10,000 cards, ~37,000 reviews): passed; cold boot 2.4 s,
  statistics page 1.75 s, answer → feedback including the save 0.36 s,
  sync merge with nothing new 6.4 s (no regression).
- Not run: anything on a physical iPad or with Apple Pencil (no device in
  this environment). Viewport simulation is not a Pencil test.

## 6. Before / after examples

| Case | Before | After |
| --- | --- | --- |
| Correct typed answer, a bit slow | Hard (timing) | Good, "Correct" |
| Correct after a hint | up to Good | Again, "Answered with help"; recall checked again later |
| Literally correct, but a guess | Good or Easy unless "I guessed" (→ Hard) | "Guessing" before checking or "I guessed without remembering" → Again, "Guessed, not counted as recalled" |
| `2x+` on a maths card | wrong, Again | "Needs your check": edit (no penalty, answer hidden) or compare and check yourself |
| Evaluator rejects a valid synonym | "Mark correct & save alias": rescue plus card change in one step | "My answer is correct" fixes this review once (help kept); "Also accept this answer next time" is a separate card change |

## 7. Limits

- Automatic checking covers text, maths (notation or sampled algebraic
  equivalence, not proof) and chemistry formulas/equations as before. No
  OCR, no AI grading, no universal algebra. `(x^2-1)/(x-1)` vs `x+1` is
  still accepted under algebraic equivalence (differs at one point).
- Handwriting is never recognised; it is self-checked.
- Not verified on a real iPad with Apple Pencil Pro: ink input, palm
  rejection, hardware-keyboard Enter, Scribble in the answer box, and
  interruption recovery on iPadOS all need a device check. At 320×640 in
  pen mode the composer is cramped (prompt visible but small).

## 8. Risks and Chunk 2 follow-ups

- Existing users move from timing grades to Good-by-default: intervals
  grow a little differently. The experimental switch restores timing grades.
- Hints now cost a lapse; learners who lean on hints will see more
  relearning. Watch whether a "partial hint" distinction is needed.
- Practice-after-exposure keeps the card due; a learner who undoes often
  may see the same card next session.
- Follow-ups: modelling extra exposures (practice) in the memory model; an
  explicit "learn" step for new cards before the first test; per-deck
  confidence prompts; a device test pass on iPad.

## 9. Review location

Commits on `claude/axonsrs-github-pages-setup-43lha6` after `83242d8`. No
preview or production deployment was made; `main` (the live site) is
unchanged.
