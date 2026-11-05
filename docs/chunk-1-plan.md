# Chunk 1 — Trustworthy answers, learning evidence and grading

Working plan and handoff for the Chunk 1 prompt
(`AxonSRS_Chunk_1_Coder_Prompt.txt`, sections 1–17). Anyone picking this up
(Claude, Grok or a person) should read this file first, then continue from
the first unchecked item under **Status**.

**Branch:** `claude/axonsrs-github-pages-setup-43lha6`. Push there only.
**Do not push to `main`**: `main` is the live GitHub Pages site. Do not bump
the version or cache name (`tools/bump-version.mjs`) in this chunk; that
happens at release time, on request.

## Status

Update this list in the same commit as the work.

- [x] 1. Audit and plan (this file).
- [x] 2. Central outcome policy (`js/core/outcome.js`), wired into
      `planReview` and `planOverride`; unit tests
      (`tests/unit/outcome.test.js`). Evaluator reports `unresolved` for
      unreadable math/chem (`matchAnswer`). Default "I guessed" → Again.
      planReview now takes `policy`, `confidence`, `dontKnow`, `selfHelp`;
      the study screen does not pass them yet (step 3), so today it uses
      the standard policy with no confidence.
- [ ] 3. Study screen: pre-submission confidence, "I don't know", outcome
      labels, self-assessment panel (ink, manual, unresolved), unresolved
      phase, effort buttons, alias split, timing under a disclosure.
- [ ] 4. Exposure integrity: a card whose answer was shown but not yet
      graded, or whose review was undone, comes back as practice; persisted
      across reloads.
- [ ] 5. Settings and onboarding copy (policy switch, remove hint-ceiling and
      "I guessed" settings, accurate welcome text, plain-language grade
      meanings).
- [ ] 6. Statistics consistency: shared outcome rule reads the new evidence;
      unaided recall with an explicit denominator; new vs delayed; pre- vs
      post-feedback confidence; session summary; research policy notice.
- [ ] 7. Persistence checks: double submit, reload during commit, storage
      failure, backup round trip of the new fields, legacy events stay
      "unknown".
- [ ] 8. Docs: README, REQUIREMENTS.md, `docs/chunk-1-report.md` (final
      handoff per section 17 of the prompt).

### Merged since the plan was first written

PRs #1–#7 (Grok/Cursor) added ink cards (a side that is only handwriting,
self-graded through `submitInk`/`manualGrade`), the "Create with Pencil"
studio (`js/ui/views/pencil.js`, `js/core/pencil.js`, `js/core/ink.js`), a
handwriting card editor, ink smoothing, Reverse Recall sessions and a
version 1.0.5 commit on this branch. Those paths go through the same
`planReview`, so the outcome policy covers them; their self-grading
buttons are replaced by the self-assessment panel in step 3.

## How to work in this repo

- Vanilla ES modules, no build step, no new dependencies, no CDN. Paths are
  relative (`./js/...`); the site is served under `/AxonSRS/`.
- After adding a shipped file under `js/`, `css/`, `vendor/` or `icons/`, run
  `node tools/update-precache.mjs`. Files in `docs/` and `tests/` are not
  shipped.
- Tests: `npm test` (node --test, ~200 unit tests, a few seconds) and
  `node tests/browser/run.mjs "<regex>"` (Playwright + Chromium; omit the
  regex for all; the `perf` spec takes ~2 minutes). `npm run check` = precache
  check + unit tests. Run the relevant suites before every commit and record
  the counts in the commit message or this file.
- Commit trailer used in this repo: see `git log -1`.
- Never commit tokens, secrets or personal deck data.

## Audit: existing behaviour vs the prompt

Traced path: `js/ui/views/study.js` (`present` → `submit`/`submitInk` →
`commit` → `planReview` in `js/core/review.js` → `store.commitReview` in
`js/data/store.js` → `afterSaved` → `renderFeedback`), corrections via
`planOverride`/`planUndo` and `store.commitCorrection`, replay in
`js/core/history.js`, statistics in `js/core/stats.js` (shared `outcome()`
and `answerClass()`), session state in `store.saveSession`.

Already correct (keep, add tests where missing):

- One review per presentation: `cur.eventId` is the event id;
  `store.commitReview` refuses duplicates and stale heads; failed saves keep
  the answer in `localStorage` (`axon-pending-review`) and offer Retry
  (`tests/browser/storage.spec.mjs`). Phase guards stop double submit.
- Corrections are events (`type: 'correction'`, `kind: 'override' | 'void'`)
  replayed in order (`replayUnit`), so correcting an older review does not
  overwrite later state (`tests/unit/review.test.js`, `history.test.js`).
- Wrong answers are Again and requeued; retyping is a `copy` exposure event,
  never a review (`tests/browser/session.spec.mjs`).
- Practice modes (cram, drill, speed, interleave) record `practice` events
  and never touch the schedule unless the per-mode setting says so.
- Calibration exclusions: assisted, typo-tolerated, unreliable timing,
  overrides, self-judged ink, unknown modality (`calibrationSample`).
- Evaluator (checked with probes, see `tests/unit/match*.test.js`):
  `sqrt(x^2)` ≠ `x` under both equivalence modes; `abs(x)` = `sqrt(x^2)`
  only under algebraic equivalence (flagged as sampled, not proof); missing
  `+ C` rejected with a `missing-constant` diagnostic; `ln(x^2)` ≠ `2ln(x)`;
  numeric tolerance is explicit (`1%` or absolute). Chemistry: `NH4` ≠
  `NH4^+` (charge-missing), `SO4^-` ≠ `SO4^2-`, `Co` ≠ `CO`, coefficients
  must match the accepted equation exactly. Text: case and typo tolerance
  follow card/deck settings.
- Handwriting pad (`js/ui/inkpad.js`): blank pad cannot be checked; ink is
  snapshotted before the answer is shown; the pad is hidden after Check, so
  the assessed ink cannot be edited.

Defects / gaps against the prompt:

1. **Timing changes the grade by default** (`gradeReview` → Hard/Easy).
   Prompt §5.1/§10: default must be Good for a correct independent answer;
   timing only in an explicitly experimental policy (research "axon" arm
   keeps it).
2. **Hint caps at Good** (`hintCeiling: 'good'`). Prompt §5.5: an
   answer-bearing hint or worked solution before commit → Again ("Answered
   with help").
3. **"I guessed" gives Hard** (`guessedGrade: 'hard'`). Prompt §5.4: Again.
4. **"I knew that"** raises the grade; prompt §6 calls it ambiguous. Replace
   with explicit effort ratings for independent successes ("Took effort" →
   Hard, "It was easy" → Easy) and keep "I guessed without remembering".
5. **Confidence is asked after feedback** (1–5 `self-rating` event). Prompt
   §6/§11: optional Guessing / Unsure / Confident before submission, stored
   with the review as pre-feedback; "Guessing" = no recall → Again even if
   the literal answer matches. Old 1–5 ratings stay labelled post-feedback.
6. **Unparseable answers are marked wrong.** `compareMath`/`compareChem`
   return `unparseable-user`, but `matchAnswer` reports plain incorrect
   (e.g. `2x+`, `NH4)+`). Prompt §5.7/§8: unresolved → "Needs your check":
   edit the notation (independent status kept, answer not shown) or compare
   and self-assess (provenance `self`).
7. **Undo re-presents the card as a fresh live test** (grade shopping after
   seeing the answer). Prompt §9: retain exposure — the retry is practice.
8. **Reload while the answer is shown but not graded** (ink self-check,
   manual grading) re-presents an unseen test. Prompt §12: restore as
   exposed (practice).
9. **"Correct & save alias"** combines two operations. Prompt §9: "My answer
   is correct" (this review) and "Also accept this answer in future" (card
   definition) are separate actions.
10. **Self-grading buttons** for ink are raw Again/Hard/Good/Easy. Prompt §7:
    first decision Correct on my own / Not correct / Needed help or saw the
    answer; effort (Hard/Good/Easy) only in manual mode; success disabled
    when assistance is already recorded.
11. **Feedback shows timing internals** in the main hierarchy. Prompt §6:
    move timing into the "Why this grade?" disclosure.
12. **Welcome copy** promises automatic grading with no buttons (home.js).
13. **Statistics**: first-attempt accuracy drops nothing but voided events;
    there is no explicit unaided-recall denominator, new-card first tests are
    mixed into retention-style figures in places, the session summary counts
    hinted answers as "first-try correct".
14. **Research**: reviews do not record which grading policy produced them.

## Design

### Outcome policy (`js/core/outcome.js`, new)

One pure function used by every grading path:

```
assessOutcome({ match, assistance, confidence, retrieval, selfAssessment,
                phase, policy, manualRating, timingGrade })
  → { class, independent, evaluation, provenance, retrieval, confidence,
      phase, rating, reason, policy }
```

- `policy`: `'standard@2'` (default) or `'timing-experimental@1'` (Settings
  switch; research "axon" arm). Stored as `event.grading.policy`.
- `class`: `success` · `failed` · `assisted` · `revealed` · `guessed` ·
  `dont-know` · `self-help` (self-reported "needed help").
- `evaluation`: `correct` · `incorrect` · `unresolved` · `none`;
  `provenance`: `evaluator` · `self`.
- `retrieval`: `recalled` · `recalled-unsure` · `guess` · `none` · `unknown`.
- `confidence`: `guessing` · `unsure` · `confident` · `null`, with
  `confidenceTiming: 'pre-feedback'` when set.
- `phase`: `new` (no prior state) · `learning` · `relearning` · `review`.

Rating (scheduled reviews; practice uses the same evidence, no schedule):

| Situation | class | Rating |
|---|---|---|
| Correct, independent | success | Good; manual mode: chosen Hard/Good/Easy; timing policy: fluency grade (never Again) |
| Correct, "Unsure" | success | as above (low confidence is not failure) |
| Incorrect | failed | Again |
| "Guessing" before submit, or "I guessed without remembering" after | guessed | Again |
| "I don't know" / reveal before answering | dont-know / revealed | Again |
| Hint or worked solution before commit | assisted | Again (once per presentation) |
| Unresolved, edited and re-checked | per new result | independent kept (answer was not shown) |
| Unresolved, compared and self-assessed | per self-assessment, provenance self | |
| Handwriting | self-assessed, same rules | |
| Copy after a failure | `copy` event | none |
| Skip | `skip` event | none |

New cards use the same mapping (FSRS new-card transition); `phase: 'new'`
keeps them out of delayed-retention figures.

Corrections (`planOverride`):

- `correct` ("My answer is correct"): evaluation → correct with provenance
  `user-correction`; class recomputed with the original assistance and
  confidence (a hinted answer stays `assisted`, Again).
- `alias`: legacy kind kept for history; the UI now does `correct` and then
  offers "Also accept “…” in future" (card edit only).
- `guessed` → Again; `manual` (effort) → Hard or Easy for an independent
  success; `knew` kept only for legacy events.

### Event fields (additive; no DB migration)

`event.outcome = { v: 'axon-outcomes@2', class, independent, evaluation,
provenance, retrieval, confidence, confidenceTiming, phase, reason }`,
`event.grading.policy`, `event.assistance.priorExposure`,
`event.response.unresolved`. Legacy events have no `outcome`; statistics
treat their unknown facts as unknown (never "independent"), and legacy
`self-rating` events stay "after feedback".

### Study screen

- Composer (question phase): optional confidence chips **Guessing · Unsure ·
  Confident** (tap again to clear; "Guessing" has a one-line explanation);
  actions **I don't know** (was Reveal), Hint, Skip, Write/Type, Edit.
- Typed submit → evaluator. `unresolved` → phase `unresolved`: "I couldn't
  check this form reliably. Edit the notation, or compare with the answer."
  Buttons **Edit answer** (back to question, timing marked repaired) and
  **Compare with the answer** (marks exposure, shows the self-assessment
  panel).
- Self-assessment panel (ink, unresolved compare, manual mode): **Not
  correct** · **Correct on my own** · **I needed help or saw the answer**;
  in manual mode "Correct on my own" splits into Took effort / Correct /
  Easy with plain meanings. Success buttons are disabled when a hint,
  solution or reveal is already recorded.
- Feedback: verdict labels Correct · Not quite · Answered with help · Answer
  revealed · New card — study the answer · Guessed — not counted as recalled
  · Needs your check; committed response and correct answer; timing and
  grading internals inside the disclosure.
- After an independent success: **Took effort** · **It was easy** · **I
  guessed without remembering**. After a failure: **My answer is correct**,
  then optionally **Also accept “…” in future**.

### Statistics

- `outcome()` in `js/core/stats.js` reads `event.outcome` when present,
  falls back to legacy rules otherwise.
- Unaided recall (scheduled first attempts, not voided): numerator =
  independent successes; denominator = completed assessment opportunities
  including assisted, revealed, guessed, don't-know; shown with n, help
  rate and reveal rate; skipped/abandoned/unresolved-cancelled counted
  separately. "Accuracy among unaided attempts" stays, labelled
  conditional. New-card first tests (`phase: 'new'`) are labelled
  separately from delayed reviews.
- Confidence: pre-feedback (new) and post-feedback 1–5 (older versions)
  reported separately.
- Research: `comparisonReport` counts reviews per grading policy and the
  view warns when a study mixes policies.

## Test plan (prompt §14)

Unit (`tests/unit/outcome.test.js` new, plus review/stats/backup tests):
T01–T05, T13, T15, T16, T19, T28–T33, T36, T40–T45. Browser
(`tests/browser/session.spec.mjs`, `grading.spec.mjs` new): T06, T07,
T14, T17, T18, T20–T27, T34, T35, T37–T39. Existing tests that relied on
timing grades through `planReview` must pass `policy:
'timing-experimental@1'`.

## Handoff prompt (paste into another assistant if this stops)

> You are continuing Chunk 1 of the Axon (AxonSRS) app on branch
> `claude/axonsrs-github-pages-setup-43lha6`. Read `docs/chunk-1-plan.md`
> fully, then `README.md`. Check `git log` to see which Status items are
> done, run `npm test` to confirm a green baseline, and continue with the
> first unchecked Status item, following the Design section exactly. Keep
> commits small, run the relevant unit and browser tests before each
> commit, tick the Status item in this file in the same commit, and push
> to the same branch (never to `main`). Do not bump versions. When all
> items are done, write `docs/chunk-1-report.md` as required by section
> 17 of the prompt: behaviour, files changed, outcome→scheduler mapping,
> migration notes, tests actually run with results, before/after examples
> (correct, hinted, genuine guess, parse failure, evaluator correction),
> limitations, risks and Chunk 2 follow-ups. Never claim tests or device
> checks you did not run.
