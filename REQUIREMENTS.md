# Axon — requirements checklist

Every requirement from the specification (Sections 1–19), mapped to where it
is implemented, the build phase it belongs to, how it is verified, and its
status. Nothing here is aspirational: a requirement that is not done or not
verified says so.

**Status**

| Mark | Meaning |
| --- | --- |
| ✅ | Implemented and verified by an automated test (named in *Verification*) |
| ☑️ | Implemented; checked by hand or visually in headless Chromium (screenshots in `test-results/screenshots/` after `npm run test:browser`), no dedicated assertion |
| ⚠️ | Implemented, but depends on a browser API or device that the test environment does not provide, so it is unverified |
| ⛔ | Not met or blocked; the reason is given |

**Verification keys**: `U:` unit test in `tests/unit/<file>.test.js` (`node --test`).
`B:` browser test in `tests/browser/<file>.spec.mjs` (Playwright, headless
Chromium, served from `/AxonSRS/` like GitHub Pages). Test titles are quoted
in short form.

**Phases** (Section 13 + 16.10): P1 functional core · P2 memory engine · P3
study experience · P4 offline & sync · P5 production readiness · P6 visual
study materials.

---

## Technical constraints

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Vanilla HTML/CSS/JS, native ES modules, no framework, no build step | whole repo; `index.html` loads `js/main.js` as a module | P1 | U:paths "static imports between modules are relative"; there is no build script | ✅ |
| Static GitHub Pages hosting; everything works under `/AxonSRS/` | relative URLs everywhere; `tests/serve.mjs` serves only `/AxonSRS/` and fails any test that requests outside it | P5 | U:paths (6 tests); every B: test asserts no request outside `/AxonSRS/` | ✅ |
| IndexedDB persistence | `js/data/db.js`, `js/data/store.js` | P1 | B:storage "persist across reloads" | ✅ |
| Fully offline study and card management | `sw.js`, `js/ui/pwa.js` | P4 | B:offline "cold-starts and studies offline" | ✅ |
| Modular, documented code; no placeholders or simulated features | `js/core` (pure logic), `js/data` (storage, sync), `js/ui` (views); every module has a header comment | P5 | code review; features below are each tested | ☑️ |
| Pinned, browser-compatible libraries | `vendor/` (ts-fsrs 5.4.2, KaTeX 0.18.9 + mhchem, marked, DOMPurify, fflate, OpenDyslexic) with licences and SHA-256 in `vendor/README.md`; `js/config.js` `LIBRARIES` | P1 | file hashes listed; U:scheduler reference cases pin the FSRS version | ✅ |

## 1. UI/UX

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Minimal, consistent design system (type scale, spacing, accent, states) | `css/app.css` (tokens at the top) | P1 | screenshots at 4 sizes, light and dark | ☑️ |
| Light and dark themes, system preference by default | `css/app.css` `prefers-color-scheme`; `js/ui/appearance.js`; Settings → Appearance | P1 | B:layout renders phone dark mode | ✅ |
| Responsive layouts for phone, tablet, desktop | `css/app.css` breakpoints; sidebar ↔ bottom nav | P5 | B:layout "every main screen fits desktop, tablet and phone widths" (1280, 834, 390, 320 px; emulation) | ✅ (emulated) |
| No unnecessary modals or steps | review flow is type → Enter → Enter; confirmations only for destructive actions | P3 | B:study, B:flows exercise the flow by keyboard alone | ✅ |
| Contrast, focus indicators, keyboard control, reduced motion | `css/app.css` `:focus-visible`, `prefers-reduced-motion`; `js/ui/keyboard.js` | P3 | B:layout checks every control has an accessible name; keyboard-only flows in B:study/B:flows; contrast checked visually | ☑️ |
| Fast with thousands of cards | virtual list, cached activity summary, batched writes | P5 | B:perf "10,000 cards with ~37,000 reviews" (timings in README) | ✅ |
| Desktop: sidebar with decks, search, settings | `js/ui/shell.js` | P1 | screenshots | ☑️ |
| Dashboard: due, progress, activity, recent decks | `js/ui/views/home.js` | P1 | screenshots; B:perf boots to it | ✅ |
| Deck cards with statistics | `js/ui/views/decks.js` | P1 | screenshots | ☑️ |
| Centred, distraction-free review | `js/ui/views/study.js` | P3 | screenshots | ☑️ |
| Keyboard-first controls | `js/ui/keyboard.js` (`ACTIONS`) | P3 | B:study, B:flows (Alt+A alias, Alt+Z undo, Alt+E edit, Escape, H) | ✅ |
| Efficient bulk editing and importing | `js/ui/views/browser.js` bulk bar; `js/ui/views/import.js` | P1 | B:flows "import wizard"; bulk actions checked by hand | ✅ / ☑️ |
| Mobile bottom navigation | `js/ui/shell.js` `.bottom-nav` | P3 | B:layout phone screens | ✅ |
| Large touch targets | `css/app.css` `@media (pointer: coarse)` 44 px / 40 px | P3 | B:layout asserts ≥ 40 px for primary, composer and nav controls on touch | ✅ (emulated) |
| No horizontal overflow | `css/app.css` | P3 | B:layout asserts no horizontal scroll on every screen | ✅ (emulated) |
| No needless scrolling during review; question and input visible with keyboard open | `js/ui/viewport.js` (visualViewport, `dvh`, safe areas), sticky composer | P3 | B:layout "composer stays above the on-screen keyboard" (viewport shrink simulates a keyboard) | ✅ (emulated; ⚠️ not on a physical phone) |
| Keep input focus across card transitions | one persistent `<input>`; `focusInput` after each transition; blur recovery | P3 | B:study "toolbar" asserts focus stays; transitions keep the same element | ✅ |
| Navigation: Home, Decks, Study, Statistics, Settings | `js/ui/routes.js`, `js/ui/shell.js` | P1 | screenshots; B:offline visits every route | ✅ |
| Onboarding and empty states | `js/ui/views/home.js` `onboarding()`, `js/ui/views/sample.js` (tour deck), `emptyState` | P1 | B:layout starts from onboarding and loads the tour deck | ✅ |

## 2. Card and deck management

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Create, rename, edit, duplicate, organise (groups, colours, archive), delete decks | `js/ui/views/decks.js`, `deck.js`; `store.createDeck/saveDeck/duplicateDeck/deleteDeck` | P1 | used by every B: test; duplicate/rename checked by hand | ☑️ |
| Create, edit, duplicate, delete cards | `js/ui/views/editor.js`; `store.saveCards/deleteCards` | P1 | B:study "image occlusion" (create), B:flows "editing" (edit) | ✅ |
| Search and filter cards | `js/ui/views/browser.js` (debounced search, status/tag/task/mode filters, sort) | P1 | B:perf "search 10k cards" | ✅ |
| Multi-select bulk actions (move, tag, suspend, task type, export, delete) | `browser.js` bulk bar (shift-click ranges) | P1 | checked by hand | ☑️ |
| Tags | `model.js`, editor, import mapping | P1 | U:import "Format A … tags column" | ✅ |
| Card history and scheduling information | editor "Scheduling & history"; `stats.unitHistory` | P1 | U:stats "card history shows inferred grade, effective rating, overrides and voids" | ✅ |
| Pause/suspend cards | card and unit `suspended`; queue status `suspended` | P1 | U:queue "status vocabulary"; B:study "leech … Suspend" | ✅ |
| Deck-specific study settings | `DEFAULT_DECK_SETTINGS` in `model.js`; deck settings sheet | P1 | U:queue, U:review use deck settings | ✅ |
| Undo destructive actions | Trash with restore (`store.deleteCards/restoreTrash`); snapshots before destructive imports | P1 | checked by hand; U:backup covers snapshot data | ☑️ |
| Directions: front→back, back→front, both, with independent schedules | `unitKeys` in `model.js` | P2 | U:review "forward and reverse directions keep independent schedules" | ✅ |
| Answer formats: text, maths, chemistry, scientific notation, Unicode, KaTeX | `js/core/match/*`, `js/ui/render.js` | P2 | U:match (18 tests) | ✅ |
| Alternatives with `\|`, escaped literal pipe | `js/core/aliases.js` | P2 | U:aliases (7 tests) | ✅ |
| Formatting differences don't cause wrong results | normalisation in `text.js`, `match/*` | P2 | U:match "plain text: whitespace, Unicode, case and punctuation normalisation" | ✅ |
| Safe Markdown (headings, emphasis, lists, code, links) with KaTeX, chemistry, images | `render.js` (marked → DOMPurify → KaTeX after sanitising, `trust: false`) | P1 | U:import "HTML conversion strips scripts"; rendering checked visually | ✅ / ☑️ |

## 3. Import engine

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| `.txt`, `.csv`, `.tsv`, Anki text/CSV, JSON backups, pasted text | `js/core/import/*` | P1 | U:import (13 tests) | ✅ |
| Paste/upload, auto-detect format and separator, editable preview, field mapping, duplicates, validation, confirmation with counts | `js/ui/views/import.js` | P1 | B:flows "import wizard" | ✅ |
| Formats A (tab), B (`::`), C (Q:/A:), D (Front:/Back:) | `import/index.js` | P1 | U:import "Format A/B/C/D" | ✅ |
| Choose or correct detected format | import step 2 format select | P1 | B:flows (detected text shown) | ✅ |
| UTF-8, quoted CSV, embedded newlines, escaped separators | `import/csv.js` | P1 | U:import "CSV: quoted fields …", "semicolon CSV and UTF-8 BOM", "Format B … escaped separators" | ✅ |
| Duplicates within import and against decks; skip / update / import as new | `markDuplicates`, preview select | P1 | U:import "duplicates within the import and against existing cards"; B:flows | ✅ |
| Identical card keeps its review history | "skip" and "update" keep units | P1 | B:flows asserts the existing schedule is unchanged | ✅ |
| Report invalid/skipped rows; never silently discard | "Parsing problems" and "Not recognised (kept)" panels with download | P1 | U:import "malformed rows are reported", "unmatched lines are kept"; B:flows downloads them | ✅ |
| Text treated as data | `import/html.js`, DOMPurify | P1 | U:import "HTML conversion strips scripts and keeps text as data" | ✅ |
| Structured notes → editable drafts (accept/edit/discard each) | `import/notes.js`, import preview | P1 | U:import "structured notes become drafts" | ✅ |
| No AI API; all local | no network calls in import code | P1 | U:paths "only network origin … GitHub API" | ✅ |

## 4. Adaptive retrieval engine

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Layer A: correct, pinned FSRS | `js/core/scheduler.js` wrapping ts-fsrs 5.4.2 (FSRS-6) | P2 | U:scheduler "matches py-fsrs 6.3.2 reference cases" | ✅ |
| Layer B: automatic grade from behaviour | `js/core/fluency.js` (`axon-fluency@1.0.0`) | P2 | U:fluency (15 tests) | ✅ |
| Metrics: first-key latency, typing time, total, length, corrections/backspaces, pauses, correctness, typo, reveal, override, modality, history | `js/study/trial.js`, `review.js` | P2 | U:stats "trial recorder measures latency …"; U:review "a wrong answer records … measurements" | ✅ |
| `performance.now()` for durations | `TrialRecorder` | P2 | U:stats trial tests use an injected monotonic clock | ✅ |
| Separate baselines: physical keyboard, touch (and voice, per task type) | `baselineKey(modality, taskType)` | P2 | U:fluency "device baselines are separate", "task types: separate baselines" | ✅ |
| Robust rolling statistics | median/MAD in log space, window 200 | P2 | U:fluency "baselines are rolling, robust and support exact removal" | ✅ |
| Account for length, modality, prompt complexity, maths, typing speed, individual | effort-normalised typing, reading floor, personal baselines | P2 | U:fluency | ✅ |
| Provisional thresholds, personalised after enough data | calibration levels none (<8) / provisional (8–24) / personal (25+) | P2 | U:fluency "sparse calibration is conservative" | ✅ |
| Ignore interruptions, hidden tabs, idle; pause when hidden | `TrialRecorder.pause/resume`; idle cap | P2 | U:stats "hidden time and in-session editing are excluded"; U:fluency "unreliable timing falls back" | ✅ |
| Incorrect→Again, hesitant→Hard, fluent→Good, consistently rapid→Easy | `gradeReview` | P2 | U:fluency "typical fluent answer → Good; hesitant → Hard; consistently rapid → Easy" | ✅ |
| Accuracy dominates; no reward for fast guessing; never Easy for shortness; typo ≠ Easy; conservative with few samples | `gradeReview` | P2 | U:fluency "accuracy dominates", "Easy needs history and consistency", "typo-tolerated answers never get Easy" | ✅ |
| Configurable, explainable thresholds | `DEFAULT_GRADING_CONFIG`; Settings → Grading; "Why this grade?" | P2 | U:fluency "every grade stores reasons, explanation, confidence and versions" | ✅ |
| Raw measurements stored apart from the grade | event `grading.measurements.raw/adjusted` | P2 | U:review, U:fluency | ✅ |
| "I knew that" / "I guessed" | `planOverride` kinds `knew`/`guessed` | P2 | U:review "“I knew that” and “I guessed” are explicit overrides" | ✅ |
| Manual grading mode | Settings → Grading mode; manual buttons | P2 | U:review "manual grading uses the chosen rating and keeps Axon’s grade as a shadow" | ✅ |
| Wrong answer: show correct answer, highlight differences, retype once (with bypass), record Again, copying ≠ recall, requeue | `study.js` feedback/retype; `diff.js`; `review.js` | P2/P3 | U:review "a wrong answer records Again … and requeues"; U:match "diff highlights …"; B:flows (retype + bypass) | ✅ |
| Inferred grade → FSRS rating; state only via scheduler | `applyRating` | P2 | U:review "correct answers update FSRS state through the scheduler only" | ✅ |
| Desired retention setting (default 90%) | Settings → Study; `schedulerParams` | P2 | U:scheduler "desired retention changes intervals for future reviews only"; B:storage persists 0.87 | ✅ |
| Replayable history; no silent behaviour change on migration | per-event params; `replayUnit`; Settings → Data → Verify schedules | P2 | U:history "historical transitions use each event’s own recorded parameters"; B:perf replays all 10,000 schedules | ✅ |
| No superiority claims | research report wording; README | P5 | U:stats "research mode … reports with sample sizes and cautions" | ✅ |
| Research comparison (standard FSRS vs automatic), recall, time, calibration, delayed tests, without changing stored data | `js/core/research.js`; Settings → Research; Statistics | P2 | U:stats research + de-identified export tests | ✅ (logic) / ☑️ (UI) |

## 5. Study experience

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| One card at a time; input stays mounted | `StudyScreen` | P3 | B:study tests reuse the same input across cards | ✅ |
| Timing starts when the question is readable (incl. maths/images) | `present()` awaits KaTeX and `img.decode()` before `trial.start()` | P3 | code; B:study occlusion waits for the image | ☑️ |
| Enter submits; feedback; Enter advances; optional auto-advance | `primaryAction`; `autoAdvanceMs` | P3 | B:study "holding Enter submits once …" | ✅ |
| Correct answer and compact timing breakdown | `renderFeedback` | P3 | screenshots (feedback) | ☑️ |
| Undo last review | `planUndo`; Alt+Z / U | P3 | U:review "undo reverses scheduling exactly"; B:flows | ✅ |
| Skip without counting as recalled | `skip` exposure event | P3 | U:review "exposure events are typed separately" | ✅ |
| No double submission | phase machine + event-id idempotency | P3 | B:study "holding Enter"; B:storage duplicate commit refused | ✅ |
| Persistent input; `autocomplete/autocorrect/autocapitalize="off"`, `spellcheck="false"`, `enterkeyhint="done"` | `buildDom` | P3 | code | ☑️ |
| visualViewport, `dvh`, safe areas; tested fallbacks | `js/ui/viewport.js`, CSS | P3 | B:layout "composer stays above the on-screen keyboard" | ✅ (emulated) / ⚠️ (real iOS/Android keyboards untested) |
| TTS for prompts/answers; offline limits documented | `speak()`, Settings → Study (read-aloud) | P3 | headless Chromium has no voices | ⚠️ |
| Local audio clips on cards (IndexedDB blobs, stable ids) in backups/sync | editor "Audio clips", `putMedia` (sha256 ids), backup media | P3 | U:backup media round trip (image); audio uses the same path | ✅ (storage) / ⚠️ (playback not automated) |
| Voice input as its own modality and baseline, excluded from typing calibration | `voice()` (Web Speech), `classifyModality` | P3 | U:fluency "modality detection: physical, touch, voice and unknown"; speech recognition itself unavailable headless | ✅ (grading) / ⚠️ (recognition) |
| Symbol toolbar `π √ ^ / ( ) - + ² ³ θ Δ ± ∞`, caret insertion, selection replace, focus kept, customisable | `renderSymbols`, `insertSymbol`; Settings → Input | P3 | B:study "toolbar symbols insert at the caret" | ✅ |

## 6. Answer matching (`axon-match@1.0.0`)

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Text: whitespace, Unicode, spaces, case option, alternatives | `match/index.js`, `text.js` | P2 | U:match "plain text …", "multiple accepted answers" | ✅ |
| Cautious Levenshtein with visible warning; no false acceptance of numbers, signs, technical terms | `typoMatch` (confusable affixes, deck vocabulary, first letter) | P2 | U:match "typo tolerance is cautious and visible", "never applies to maths or chemistry formulas", "typoMatch budget rules" | ✅ |
| Maths: `sqrt(3)`/`√3`, `pi`/`π`, fractions, superscripts/caret, optional numeric equivalence; real parser; no unverified algebra | `match/math.js` (Pratt parser, canonical keys) | P2 | U:match maths tests (5) | ✅ |
| Chemistry: subscripts, superscript charges, ASCII, charge formats; identity protected | `match/chem.js` | P2 | U:match chemistry tests (4) | ✅ |
| Manual aliases; prefer false negatives over false positives | aliases + alias rescue | P2 | U:match, U:review alias rescue | ✅ |

## 7. Study modes

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Daily Review | `queue.js`, `session.js` | P3 | B:storage, B:study, B:perf | ✅ |
| Cram: any deck, all/shuffled/tags | launcher, `queue.js` | P3 | U:review "cram (practice) records exposure but never changes the schedule"; B:flows "cram session" | ✅ |
| Drill Weakest (failures, low R, slow, corrections, difficulty) | `queue.js` `drillScore` | P3 | U:queue "drill weakest prioritises …" | ✅ |
| Speed Practice with optional timer | launcher, study timer | P3 | U:queue "speed practice uses only learned cards" | ✅ (logic) / ☑️ (timer) |
| Drills don't change FSRS by default; explicit opt-in | `recordAsReviews`, `practiceAffectsSchedule` | P3 | U:review cram test; B:flows cram | ✅ |
| Interleaving mode (decks/tags, sibling spacing, exposure recorded) | `queue.js` interleave | P3 | U:queue "… interleaving alternates topics" | ✅ |
| Vacation/postpone (days or date, redistribute; state, history, due dates kept; distinct from suspend/bury/defer) | `postponeDialog`, unit overlays | P3 | U:queue "postpone/vacation creates overlays only", "status vocabulary"; U:stats forecast with postponement | ✅ |
| Pause, resume, abandon sessions without losing reviews | sessions store; Resume/End | P3 | B:storage (session index after reload); B:offline (resume after update) | ✅ |

## 8. Statistics

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Reviewed today, due tomorrow, accuracy over time, latency, median normalised speed, study time, heatmap, streak, predicted recall, strongest/weakest, per-deck trends | `js/core/stats.js`, `js/ui/views/stats.js`, home | P3 | U:stats (summary, streaks, forecast, calibration, accuracy); B:perf renders statistics | ✅ |
| Scientifically cautious; observed recall separate from predicted retrievability | stats copy, calibration chart, Wilson intervals | P3 | U:stats "retention calibration compares predicted and observed recall" | ✅ |
| Card history (answer times, grades, errors, intervals) | editor history | P3 | U:stats "card history …" | ✅ |
| Works offline | all computed locally | P3 | B:offline opens Statistics offline | ✅ |

## 9. Storage and sync

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| IndexedDB stores: decks, cards, units, events, calibration, settings, imports, sync metadata, tombstones (+ revisions, media, sessions, conflicts, snapshots) | `STORES` in `db.js` | P1 | B:storage | ✅ |
| Stable UUIDs, versioned schema, transactions, migrations | `MIGRATIONS`, `openWithSafety`, `transaction` | P1 | B:storage "schema migration … synthetic v2", "a failing migration leaves the database untouched" | ✅ |
| Updates never destroy progress | SW never touches IndexedDB; migration snapshots | P4 | U:paths "service worker never touches IndexedDB"; B:offline update test | ✅ |
| Gist sync: token, create/connect secret Gist, push/pull, last sync, explained errors, manual and auto-on-reconnect | `js/data/sync.js`, `core/sync/gist.js`, Settings → Sync | P4 | B:data "two devices sync through a mocked Gist"; U:sync "Gist client explains authentication, permission, rate-limit and network errors" | ✅ (mocked API) |
| Warn that a secret Gist is not private | Settings → Sync callout | P4 | screenshot | ☑️ |
| AES-256-GCM, salted PBKDF2-SHA-256 (600 000), fresh nonce, passphrase never uploaded, key not in Gist, loss warning | `core/sync/crypto.js`, `envelope.js` | P4 | U:sync "encryption round trip; wrong passphrase and tampering are detected", "600 000 PBKDF2 iterations"; B:data checks the Gist holds no plaintext or passphrase | ✅ |
| No tokens in code, commits, URLs or exports; stored only with consent, with explanation | token kept in memory unless "Remember" is on (then IndexedDB `secrets`) | P4 | U:paths "no tokens or secrets are committed"; B:data token not in localStorage, secrets or exports | ✅ |
| Sync safety: stable ids, events merged by id, independent updates kept, tombstones, conflict detection, never overwrite newer work, read before write, verify after write, explicit conflict resolution, idempotent, retry-safe; races handled explicitly | `core/sync/merge.js`, `versioning.js`, `SyncService.syncOnce` (race check, verify, intervening revisions); Conflicts screen | P4 | U:sync (merge, tombstones, conflicts, versioning); B:data two-way sync | ✅ |
| Backups: JSON export/import, versioned format, preview, duplicates, validation, partial-invalid recovery | `core/backup.js`, Settings → Data | P4 | U:backup (5 tests); B:data "full backup round trip through the UI" | ✅ |

## 10. PWA and offline

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Manifest, icons, service worker, installable, standalone | `manifest.json`, `icons/`, `sw.js` | P4 | U:paths "manifest start_url, scope, id and icons are relative" | ✅ (installability prompt itself not automated) |
| Offline shell, creation, study, scheduling, statistics | `sw.js` pre-cache (111 files) | P4 | B:offline "cold-starts and studies offline"; B:study occlusion created and studied offline | ✅ |
| Version-aware cache updates | versioned `CACHE_NAME`, `npm run release` | P4 | U:paths "cache name is versioned and matches js/config.js"; B:offline update test | ✅ |
| Pinned KaTeX bundled locally with fonts | `vendor/katex` | P4 | B:offline asserts no KaTeX font failed offline | ✅ |
| Service worker paths/scope under `/AxonSRS/` | `register('./sw.js', { scope: './' })` | P4 | U:paths | ✅ |
| Cold start offline after install | — | P4 | B:offline (browser offline **and** server stopped) | ✅ |
| Never delete IndexedDB on cache update | `sw.js` deletes only `axon-*` caches | P4 | U:paths; B:offline | ✅ |

## 11. Reliability, security, performance

| Requirement | Where | Phase | Verification | Status |
| --- | --- | --- | --- | --- |
| Safe rendering of user content; no script injection | DOMPurify; KaTeX inserted after sanitising; SVG media refused | P5 | U:import HTML stripping; U:backup "SVG media is refused" | ✅ |
| Restricted KaTeX (`trust: false`, `maxExpand`, `maxSize`); mhchem never receives raw TeX commands | `render.js`, `toMhchem` | P5 | U:match "mhchem conversion never passes TeX commands from user input" | ✅ |
| Minimal external network use | only `api.github.com` (+ raw Gist host) when sync is on; remote images blocked by default | P5 | U:paths "the only network origin …" | ✅ |
| Loading, empty and error states | views, `renderFatal`, recovery screen | P5 | B:storage fatal screens; screenshots | ✅ |
| Large decks without lag; no full-list DOM; debounced search; listener cleanup | `VirtualList`, debounce, `AbortController` per screen | P5 | B:perf (< 120 rows in DOM for 10,000 cards) | ✅ |
| Storage errors and quota exhaustion handled | `classifyError`; retryable review save | P5 | B:storage "a failed review transaction …" (synthetic quota error) | ✅ |
| No duplicate submissions or repeated scheduling | event-id idempotency, stale-head guard | P5 | B:storage, B:study "stale writes are refused" | ✅ |
| Accessibility for slow typists | retype bypass, manual grading, voice, TTS, symbol toolbar, font options | P5 | B:flows bypass | ✅ / ⚠️ (voice, TTS) |
| Studying never needs the cloud | — | P5 | B:offline | ✅ |

## 12. Testing requirements

| # | Requirement | Verification | Status |
| --- | --- | --- | --- |
| 1 | Import parsing TXT/CSV/TSV/multiline | U:import | ✅ |
| 2 | Quoted separators, malformed rows | U:import | ✅ |
| 3 | Multiple accepted answers | U:match, U:aliases | ✅ |
| 4 | Maths and chemistry normalisation | U:match | ✅ |
| 5 | Typo tolerance without accepting wrong formulas | U:match | ✅ |
| 6 | Time-based grading across device baselines | U:fluency | ✅ |
| 7 | First review and sparse calibration | U:fluency | ✅ |
| 8 | Wrong answers, retyping, event recording | U:review; B:flows | ✅ |
| 9 | FSRS transitions and intervals | U:scheduler | ✅ |
| 10 | Independent forward/reverse scheduling | U:review | ✅ |
| 11 | Cram without scheduled reviews | U:review; B:flows | ✅ |
| 12 | IndexedDB persistence and migrations | B:storage | ✅ |
| 13 | Sync merging, duplicate prevention, deletions | U:sync; B:data | ✅ |
| 14 | Encryption and wrong passphrases | U:sync; B:data (wrong passphrase on restore) | ✅ |
| 15 | GitHub Pages relative paths | U:paths | ✅ |
| 16 | Offline loading and navigation | B:offline | ✅ |
| — | Responsive testing on desktop, Android Chrome, iPhone Safari | Desktop Chromium and **emulated** tablet/phone sizes only (B:layout). No physical Android or iOS device, and no WebKit browser, was available. | ⛔ physical devices |

## 13–14. Phases and delivery

| Requirement | Status |
| --- | --- |
| Phases 1–5, then Phase 6 | ✅ all six phases complete; the Phase 6 features (images, occlusion) were then covered by the full unit and browser suites |
| Inspect repo first; preserve existing code and data | ✅ (repository was empty) |
| Complete README (setup, imports, scheduling, offline, deployment, backup, Gist sync) | ✅ `README.md` |
| Explain grading methodology and limitations | ✅ README "How grading works" |
| Run all automated tests | ✅ 151 unit + 23 browser tests pass (see README "Testing") |
| Verify it runs as a static GitHub Pages site | ✅ locally under `/AxonSRS/`; ⛔ live URL: no GitHub Pages build has run on the repository yet (Pages has to be enabled in the repository settings) and this environment cannot reach `github.io` |
| Commit and push to `main` | ✅ pushed (verified with `git push`) |
| Report features, tests, deployment, limitations | ✅ README and delivery report |

## 15. Ergonomics, cognitive accuracy, safeguards

| Requirement | Where | Verification | Status |
| --- | --- | --- | --- |
| Reading-time floor (words, maths, images) | `readingFloor` (`axon-reading@1`) | U:fluency "reading-time floor: bounded, never negative latency, never alone produces Easy" | ✅ |
| Warm-up buffer on first card after start/resume | `warmupMs` | U:fluency "warm-up leniency on the first card" | ✅ |
| Dynamic per-review modality detection (keys, pointer, viewport) | `classifyModality`, trial signals | U:fluency modality test | ✅ |
| Deterministic, retention-safe fuzz for intervals > 7 days | `fuzzInterval` (`axon-fuzz@1`) | U:scheduler fuzz tests (3) | ✅ |
| Leech detection (≥ 4 lapses, high difficulty), badges in review and browser, edit/hint/suspend actions | `isLeech`, unit `leech`, `leechActions` | U:review leech test; U:stats; B:study "leech cards offer one-click fixes" | ✅ |
| "Mark Correct & Save as Alias" (one click/shortcut, appends alias, bypasses retype, records correct with original metrics) | `override('alias')`, Alt+A | U:review alias rescue; B:flows | ✅ |
| Live maths/chemistry preview above the input | `livePreviewHtml` | screenshots | ☑️ |
| Sign, charge and +C diagnostics | `match/math.js`, `chem.js`, `DIAGNOSTIC_LABELS` | U:match "maths diagnostics: sign error, missing +C"; U:review charge-sign | ✅ |
| Toolbar presets (general/maths/chemistry/custom, auto by mode) | `TOOLBAR_PRESETS` | B:study toolbar (chemistry preset) | ✅ |
| Inline in-session editing (E / Alt+E / icon) without losing place | `edit()` | B:flows "editing the current card mid-session" | ✅ |
| Hint field caps the grade; cloze syntax `{{c1::…}}` and `{{…}}` | `cloze.js`, hint ceiling | U:fluency hint ceiling; U:cloze (8 tests) | ✅ |
| `navigator.storage.persist()` with status and quota in Settings | `AxonStore.requestPersistence/storageStatus` | B:storage "persistence denied or unsupported" | ✅ |
| `.nojekyll`; hash routing (no 404 on refresh) | `.nojekyll`, `router.js` | U:paths; B:offline deep link `#/stats` cold start | ✅ |
| Gzip before AES-GCM; truncated Gist files via `raw_url` | `compress.js`, `GistClient.fileContent` | U:sync compression and truncation tests; B:data uses raw_url | ✅ |
| Keep keyboard open on mobile Done/Enter (keydown/beforeinput interception) | `onKeydown`, `onBeforeInput`, `onBlur` | B:study Enter tests (desktop); ⚠️ real mobile keyboards untested | ✅ / ⚠️ |

## 16. Additional learning, grading and reliability

| Requirement | Where | Verification | Status |
| --- | --- | --- | --- |
| 16.1 Task types (recall, calculation, multi-step) independent of answer mode; separate baselines; correctness-led problem solving; default Recall on migration; bulk change | `TASK_TYPE_LABELS`, `baselineKey`, migration 0→1, browser bulk | U:fluency task types; U:backup "task type defaults to Recall" | ✅ |
| 16.1 Explanation / worked solution; viewing before answering counts as assistance; in editing, import, backup, sync | `explanation` field, `solutionViewed` | U:fluency "solution-viewed answers are Again"; U:backup round trip | ✅ |
| 16.2 Grade, confidence, reason codes, explanation, rule version, config, raw vs adjusted, exclusions stored; "Why this grade?" | `gradeReview` output, feedback disclosure | U:fluency "every grade stores …" | ✅ |
| 16.2 Unreliable/unknown/insufficient → Good (correct) / Again (incorrect); assistance rules apply separately; reveal = Again; hint ceiling; no Easy for guesses; "I knew that" is an override; confidence not presented as calibrated | `gradeReview`, `overrideGrade` | U:fluency (unreliable timing, overrides, hints) | ✅ |
| 16.2 Optional 1–5 confidence self-rating, stored separately | feedback confidence buttons, `self-rating` event | U:stats exposure breakdown includes it | ✅ |
| 16.2 Reading/warm-up: labelled heuristic, clamped ≥ 0, versioned, bounded, never alone Easy, conservative for complex prompts, can be disabled | `adjustMeasurements`, `heuristicsEnabled` | U:fluency reading-floor and warm-up tests | ✅ |
| 16.2 Modality: unknown allowed, confidence stored, user override, ambiguous samples excluded, minimum sample count, copying/reveal/interrupted excluded | `classifyModality`, `modalityOverride`, `calibrationSample` | U:fluency "calibration samples exclude …" | ✅ |
| 16.2 Fuzz exactly once (library fuzz off), original/chosen/seed recorded, bounds documented and tested | `applyRating` transition record | U:scheduler | ✅ |
| 16.3 Sibling groups (directions, clozes, occlusions), spacing, next-day deferral, buried/deferred ≠ suspended, sibling exposure tracked, cram override | `queue.js` | U:queue sibling tests (4) | ✅ |
| 16.3 Manual bidirectional links, shown in browser/editor, respected by spacing, kept in backups/sync, independent of history | `links` store, `addLink` | U:queue "manual related links join sibling groups"; U:backup round trip | ✅ |
| 16.3 Cloze semantics (numbered units, repeated numbers together, ordered multi-answers, unnumbered ids, preview, malformed flagged, edit-stable ids) | `cloze.js` | U:cloze (8 tests) | ✅ |
| 16.4 New-card limits, duration estimates (provisional when sparse), study timezone and rollover, UTC events, forecast, catch-up, real due dates kept, never fake completion | `queue.js`, `planner.js`, `time.js` | U:queue limits/catch-up; U:stats workload; U:time (6 tests) | ✅ |
| 16.4 Exam plans (date, decks/tags, budget, coverage, weak/unintroduced, workload, feasibility warning, observed vs predicted, no guarantees, schedule untouched, exposure recorded) | `planner.analyzeExamPlan`, `views/plans.js` | U:stats "exam plans report coverage, weak items, workload and a feasibility warning without changing schedules" | ✅ (logic) / ☑️ (UI) |
| 16.5 Atomic review commit (event + state + calibration + queue), unique id, idempotent, retryable on failure | `store.commitReview` | B:storage "a failed review transaction saves nothing … retries exactly once" | ✅ |
| 16.5 Audit history; amendments as linked correction events | `correction` events | U:review; B:flows | ✅ |
| 16.5 Alias rescue: right side, bypass retype, replace failure once, remove requeue, consistent stats/calibration, original metrics, override visible | `planOverride` | U:review alias rescue; B:flows | ✅ |
| 16.5 Structured aliases, pipe/backslash escaping | `aliases.js` | U:aliases | ✅ |
| 16.5 Undo consistent; dependent reviews reconciled by replay; alias removal separate; formatting vs substantive edits; preserve-or-reset choice; revisions kept; timing paused in editor | `planUndo`, `classifyEdit`, `revisions` store | U:review undo; U:history reset events; B:flows | ✅ |
| 16.6 Event history authoritative, schedules derived and rebuildable; device ids, seq, parent refs, versions, parameters | `history.js` | U:history (8 tests); B:perf verifies all schedules | ✅ |
| 16.6 Concurrent same-card reviews kept, deterministic policy, flagged; stable ordering with tie-breaks and clock-skew repair; not latest-timestamp-wins | `orderEvents`, `detectConcurrent` | U:history concurrency, clock skew, ties | ✅ |
| 16.6 One study tab at a time; transaction-level duplicate protection regardless | Web Locks + stale-head guard | B:study "only one tab studies at a time …" | ✅ |
| 16.6 `performance.now()` for durations, wall clock for events; clock jumps detected | `TrialRecorder`, `detectClockJump`, scheduler clamp | U:stats clock jump; U:time; U:review backwards clock | ✅ |
| 16.6 Timezone travel, DST, rollover | `time.js` | U:time | ✅ |
| 16.7 Single-letter shortcuts inactive in fields; modifier alternatives; composition respected; input/beforeinput; origins (paste, toolbar, dictation, autofill, typing) without false certainty; key repeat; two-step submit/advance; accessible live regions | `keyboard.js`, `study.js`, `trial.js` | B:study (letters, IME, held Enter, toolbar); U:stats input origins | ✅ |
| 16.8 Distinct event types (review, practice, hint, reveal, copy, sibling exposure, correction, edit, skip, abandon) | `exposureEvent` | U:review "exposure events are typed separately" | ✅ |
| 16.8 First-attempt vs eventual success; hinted/revealed/overridden/independent separated; practice-affected delayed tests marked; predicted R flagged when practice not modelled | `stats.js` | U:stats (classification, eventual success, calibration exclusions) | ✅ |
| 16.8 Research: stable group-level assignment, recorded settings, recall and time compared, sample sizes and uncertainty, shadow schedules separate, no superiority claims, de-identified export | `research.js` | U:stats research and export tests | ✅ |
| 16.9 SW updates: full shell first, never forced mid-card/feedback/correction/import/write, unobtrusive notice, no version mixing, old cache kept until ready, Axon-scoped, IndexedDB untouched | `sw.js`, `pwa.js`, busy registry | B:offline "an update found mid-review waits for a safe point" | ✅ |
| 16.9 Persistence status (granted/denied/unsupported) and its limits; snapshots not presented as backups; snapshots before destructive imports/migrations; backup reminders and last backup; recovery screen; never silently replace a damaged DB; reviews durable | Settings → Data, `#/recovery`, `renderFatal` | B:storage (persistence, migrations, failed transaction) | ✅ |
| 16.9 Versioned envelope (compression, encryption, KDF params); CompressionStream detection with fflate fallback; bounded decompression; size check before upload; local data kept on failure; raw_url only over validated HTTPS without token; honest offline-transfer wording | `envelope.js`, `compress.js`, `gist.js`, `sync.js` | U:sync (fallback, bounds, truncation); B:data | ✅ |
| 16.10 (P6) Local raster images in prompts/explanations with alt text; paste/upload with type and size limits; IndexedDB blobs with stable ids; no SVG/HTML execution | editor image insert, `putMedia`, `resolveMedia` | U:backup SVG refused; B:study occlusion upload | ✅ |
| 16.10 Image occlusion: labelled masks, typed answers, stable unit ids and independent schedules, siblings, aligned when resized (fractional geometry), edit/delete masks without resetting others, in backup/restore/sync, media deduplicated, missing/oversized reported, offline | `js/ui/occlusion.js`, `unitKeys` | B:study "image occlusion: draw and label masks, then study the card offline" | ✅ |
| 16.10 Random mask order; progressive reveal; options in editing/backup/sync | occlusion settings | checked by hand | ☑️ |
| 16.10 Re-run production checks after Phase 6 | — | full unit and browser suites run after P6 work | ✅ |

## 17. Additional acceptance tests

| # | Test | Verification | Status |
| --- | --- | --- | --- |
| 1 | Recall/Calculation/Multi-step baselines | U:fluency task types | ✅ |
| 2 | Unreliable timing falls back | U:fluency | ✅ |
| 3 | Reading adjustment never negative, never alone Easy | U:fluency | ✅ |
| 4 | Unknown modality, sample exclusion | U:fluency | ✅ |
| 5 | Hint/reveal/guess/typo/override interactions | U:fluency | ✅ |
| 6 | Fuzz once, within bounds | U:scheduler | ✅ |
| 7 | Sibling spacing across reverse cards and cloze groups | U:queue | ✅ |
| 8 | Cloze generation, malformed syntax, multiple blanks, stable ids | U:cloze | ✅ |
| 9 | Daily limits and catch-up keep real due dates | U:queue | ✅ |
| 10 | Rollover, timezones, DST, clock skew | U:time, U:history | ✅ |
| 11 | Alias rescue reverses failure exactly once | U:review; B:flows | ✅ |
| 12 | Undo after sync with dependent reviews | U:review "including after later reviews on another device" | ✅ |
| 13 | Literal pipes and backslashes through import/export | U:aliases; U:backup; U:import | ✅ |
| 14 | Failed transactions keep answers, no partial updates | B:storage | ✅ |
| 15 | Concurrent same-card offline reviews | U:history | ✅ |
| 16 | Deterministic reconstruction from merged history | U:history; B:perf verify | ✅ |
| 17 | Duplicate reviews across tabs | B:study | ✅ |
| 18 | E typed normally in the answer field | B:study | ✅ |
| 19 | IME Enter and held Enter | B:study | ✅ |
| 20 | Toolbar/alternative input not contaminating calibration | B:study; U:stats input origins; U:fluency | ✅ |
| 21 | Practice, copying, reveals excluded from recall metrics | U:stats | ✅ |
| 22 | Stable assignment and exposure flags | U:stats research | ✅ |
| 23 | Update during an active review | B:offline | ✅ |
| 24 | Persistence denied/unsupported | B:storage | ✅ |
| 25 | Failed migrations, interrupted imports, invalid backups, quota | B:storage (migration, quota); U:backup (invalid data); interrupted imports leave no partial cards (single transaction; recovery screen lists them) | ✅ / ☑️ (interrupted-import screen) |
| 26 | Compression fallback, oversized payloads, truncated Gist content, encrypted restore | U:sync; B:data | ✅ |
| 27 | Image/occlusion editing, sibling scheduling, accessible text, offline | B:study occlusion; U:queue | ✅ |
| 28 | Complete backup round trips | U:backup; B:data | ✅ |
| — | Deterministic clocks; FSRS reference cases for the pinned version | U:scheduler (py-fsrs 6.3.2 fixtures, `tests/fixtures/`) | ✅ |
| — | Performance with ≥ 10,000 cards and substantial history, environment and results reported | B:perf; README "Performance" | ✅ |
| — | Emulation distinguished from physical devices | README and delivery report | ✅ |

## 18. Delivery safeguards

| Requirement | Status |
| --- | --- |
| Checklist mapping every requirement (this file) | ✅ |
| 16.1–16.9 integrated into the original phases; Phase 6 after them; checks re-run | ✅ |
| README covers task types, confidence, cloze, exposure-aware stats, exam planning, corrections, replay/conflict policy, recovery, media | ✅ |
| Exact scheduler, matcher and grading-rule versions and their limits documented | ✅ README "Versions" and `js/config.js` |
| Normal studying stays simple; advanced tools tucked away | ✅ (research, diagnostics and grading internals live in Settings and disclosures) |
| Report everything as implemented / verified / blocked; no planned or mocked features described as done | ✅ (this file; ⚠️/⛔ rows) |
| No superiority claims | ✅ |

## 19. Premium features and accessibility

| Requirement | Where | Verification | Status |
| --- | --- | --- | --- |
| Dyslexia-friendly font (OpenDyslexic, bundled) and adjustable font size | `vendor/opendyslexic`, `appearance.js`, Settings → Appearance | screenshots | ☑️ |
| ARIA live announcements for correctness, timing, grade explanation | `#sr-live`, `#sr-alert`, `announce()` | code; feedback container is `aria-live="polite"` | ☑️ |
| Session focus timer that pauses timing and keeps state | Settings → Study, study screen | checked by hand | ☑️ |
| Customisable shortcuts with validation and an always-available cheat sheet (`?`) | Settings → Input & keyboard, `views/shortcuts.js`, `Shortcuts.validate` | checked by hand; single-key safety covered by B:study | ☑️ / ✅ |
| Anki-compatible export (front, back, tags, deck, scheduling note) with documented limits vs `.apkg` | `core/anki.js`, Settings → Data | U:backup "Anki export preserves front, back (with aliases), tags, deck and scheduling notes" | ✅ |
| Leech actions in statistics and card browser (edit, hint, suspend, related practice card) | `leechActions` | B:study "leech cards offer one-click fixes" | ✅ |
| All optional, non-blocking, offline | — | B:offline | ✅ |
