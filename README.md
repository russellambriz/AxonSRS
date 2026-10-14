# Axon — adaptive spaced repetition

Axon is an offline-first, typed-answer flashcard app (a Progressive Web App).
You type every answer; Axon checks it with matchers built for plain text,
mathematics and chemistry, and **infers the review grade from how you
answered**: accuracy first, then retrieval latency, typing fluency and your
own history. Scheduling uses the FSRS memory model. Most of the time you
never press Again/Hard/Good/Easy.

- **Live site:** <https://russellambriz.github.io/AxonSRS/> (after GitHub Pages
  is enabled, see [Deploying](#deploying-to-github-pages))
- **Requirements checklist:** [`REQUIREMENTS.md`](REQUIREMENTS.md): every
  requirement, where it lives, how it is verified, and its status.

Contents: [Quick start](#quick-start) · [Cards and answers](#cards-decks-and-answers) ·
[Importing](#importing) · [Studying](#studying) · [Study modes](#study-modes) ·
[Scheduling](#scheduling-fsrs) · [How grading works](#how-grading-works) ·
[Corrections and history](#corrections-undo-and-history) ·
[Statistics](#statistics) · [Exam plans](#exam-plans-and-workload) ·
[Research mode](#research-comparison-mode) · [Offline](#offline-installation-and-updates) ·
[Backups](#backups-snapshots-and-recovery) · [Gist sync](#sync-with-a-github-gist) ·
[Security](#security-and-privacy) · [Accessibility](#accessibility) ·
[Shortcuts](#keyboard-shortcuts) · [Performance](#performance) ·
[Testing](#testing) · [Versions](#versions) · [Limitations](#known-limitations) ·
[Development](#development)

---

## Quick start

1. Open the site in a current browser (Chrome, Edge, Firefox or Safari).
2. On first launch, choose **Try the tour deck** (eleven cards showing text,
   maths, chemistry, cloze and hints), **Create a deck** or **Import cards**.
3. Press **Start review**. Type the answer and press **Enter**. Read the
   feedback, then press **Enter** again to continue.
4. Optional: install it (browser menu → *Install app* / *Add to Home
   Screen*). It then opens full-screen and works without a connection.

Everything is stored on your device in IndexedDB. Nothing leaves it unless you
export a backup or turn on Gist sync. Export a backup now and then (Settings →
Data & backup); the home screen reminds you.

## Cards, decks and answers

**Decks** hold cards plus study settings: study direction (front→back,
back→front, or both, each direction scheduled independently), new cards per
day, review limit, answer mode, task type, typo tolerance, case sensitivity,
accent policy, sibling spacing, learning steps, leech threshold and
auto-advance. Decks can be renamed, coloured, grouped, duplicated, archived
and deleted. Deleted decks and cards go to a trash you can restore from.

**Answer modes**:

| Mode | Accepts as equal | Never accepts |
| --- | --- | --- |
| Plain text | surrounding/repeated spaces, Unicode forms, case (configurable), punctuation variants, **cautious** typos (with a visible "typo accepted" warning) | different numbers or signs; confusable technical terms (e.g. *hyper-/hypo-*, *-ase/-ose*); typos in maths or chemistry |
| Mathematics | `sqrt(3)` = `√3`, `pi` = `π`, `1/2` = `½`, `x^2` = `x²`, implicit multiplication, scientific notation; optionally numeric or algebraic equivalence (verified by evaluation, never assumed) | expressions that differ; a parser, not symbol stripping, decides |
| Chemistry | `SO4^2-` = `SO₄²⁻` = `SO4(2-)`, charges in common notations, hydrates (`·`, `.`, `*`), equations with `->` / `→` / `⇌` | a different element, atom count or charge, or wrong letter case (`Co` ≠ `CO`) |

Near misses get targeted diagnostics: *sign error*, *missing constant of
integration (+ C)*, *reciprocal*, *charge sign error*, *charge mismatch*,
*missing ionic charge*, *atom count mismatch*, *different elements*, *element
symbols are case-sensitive*.

**Alternative answers** are separated by `|`:
`sqrt(2)/2 | 1/sqrt(2)`. Write `\|` for a literal pipe inside an answer and
`\\` for a literal backslash where it would otherwise be ambiguous. Internally
answers are stored as lists, so a literal pipe can never create an extra
alternative.

**Markdown** is supported in fronts, backs, hints and explanations
(headings, bold, italic, lists, code, links), with `$…$` / `$$…$$` for KaTeX
and `\ce{…}` for chemistry. Everything is sanitised (DOMPurify) before
display; KaTeX runs with `trust: false` and size and expansion limits.

**Task type** (independent of answer mode): *Recall* (retrieve a fact),
*Calculation* (apply a known procedure) or *Multi-step reasoning*. Each has its
own timing baselines, so a correct calculation is never graded Hard just for
taking longer than a fact. Problem-solving cards are graded on correctness
until 30 comparable answers exist.

**Hint** (optional): showing it caps that review's grade (Good by default,
configurable to Hard). **Explanation / worked solution** (optional): shown
after answering; opening it *before* answering counts as assistance.

**Cloze deletions**: `{{c1::Paris}} is the capital of {{c2::France}}`.

- Each number (`c1`, `c2`, …) is its own study unit with a stable id and its
  own schedule. Editing one cloze does not reset the others.
- Repeated occurrences of the same number are hidden together. If they hide
  *different* answers, you type them in reading order separated by `;` (the
  prompt says so).
- `{{c1::answer::hint}}` adds a hint; alternatives use `|` inside a cloze.
- Unnumbered `{{answer}}` blanks also work. Each gets a deterministic
  identity derived from its content and position.
- Malformed syntax (unclosed braces, empty answers) is flagged in the editor
  and the import preview; the preview shows each generated question and
  answer.

**Images** (PNG, JPEG, GIF, WebP, AVIF up to 5 MB) can be pasted or
uploaded into any field, with alt text. They are stored as IndexedDB blobs
keyed by their SHA-256 (identical images are stored once). SVG and HTML are
never executed; remote images are blocked unless you allow them in Settings.

**Image occlusion**: upload an image, drag rectangles over the labels to
hide, and name each one (alternatives with `|`). Each mask becomes its own
study unit; masks of one image are siblings. Masks are stored as fractions of
the image, so they stay aligned at any size. Options: random or fixed mask
order, and *hide all* / *show others* / *progressive reveal*. Editing or
deleting a mask leaves the other masks' history alone.

**Audio clips** (MP3, M4A, OGG, WebM, WAV, AAC) can be attached to a card's
prompt and answer. They play during study and are included in backups and
sync like images.

**Related cards**: besides automatic siblings (directions, clozes,
occlusions), you can link any cards as *related*. Related cards are kept apart
in sessions (see sibling spacing). Links survive editing, backups and sync,
and deleting a link never touches review history.

**Edits**: Axon distinguishes formatting edits (no effect on the schedule),
alias changes, and substantive edits that change what the card tests; for the
latter it asks whether to keep or reset the schedule. Every saved version is
kept as a revision so old answers stay interpretable.

## Importing

**Decks → Import** (or press `I`). Paste text or choose a file; everything is
parsed locally.

1. **Source**: paste, or load `.txt`, `.csv`, `.tsv`, an Anki text export or a
   JSON file (an Axon backup opens the restore preview instead).
2. **Format & fields**: the format and separator are detected (with a match
   score) and you can override them. Map columns to front, back, tags, deck,
   hint, explanation, task type or answer mode, and choose the target deck,
   default answer mode and task type.
3. **Preview**: every draft with its status. Click a cell to edit it, untick
   drafts to discard them.
4. **Confirm**: shows exactly how many cards will be created, updated and
   skipped.

Supported text formats:

```
Sulfate	SO4^2-                      A: tab-separated (front, back, tags…)
Sulfate :: SO4^2-                    B: delimiter (:: detected; any separator can be typed; \ escapes it)
Q: What is the formula for sulfate?  C: labelled Q/A (blank lines optional)
A: SO4^2-
Front: What is the derivative of sin(x)?   D: multiline blocks
Back: cos(x)
```

CSV/TSV support quoted fields, embedded separators, quotes and newlines,
semicolon CSV and a UTF-8 BOM. A header row is used for mapping. Anki
"Notes in Plain Text" exports (with `#separator`, `#html`, `#tags column`
headers) work, including Anki clozes; HTML is converted to text and scripts
are removed.

**Structured notes**: headings with bullet lists (`- Term :: definition`,
also `:`, `—`, `–`, `-`, `=`, `→`), definition lists (a term followed by a
`: definition` line) and Q/A blocks become editable drafts. Headings become
tags, or deck names if you choose.

**Duplicates** are detected within the paste and against your collection. For
each you choose **skip** (keep the existing card and its history), **update**
(change the existing card, keeping its history) or **import as new**. Updates
take a local snapshot first.

**Nothing is silently discarded**: rows with problems are listed with line
numbers, unrecognised lines are kept in their own panel, and both can be
downloaded. An import is a single database transaction, so an interrupted
import leaves no partial cards and appears on the Recovery screen.

## Studying

- One card at a time, in one answer field that stays mounted (and, on phones,
  keeps the keyboard open) across cards.
- Timing starts only when the prompt, including maths and images, is
  rendered.
- **Enter** submits, and **Enter** again advances after the feedback
  (optional auto-advance after correct answers, Settings → Study). Holding
  Enter never submits *and* advances, and Enter while an input method
  (IME) is composing never submits.
- Feedback shows the correct answer, your answer with the differences
  highlighted, a timing breakdown (first key, typing, total), the next
  interval and an optional **Why this grade?** disclosure.
- **Wrong answer** → recorded as Again; you retype the correct answer once
  (accessibility bypass: *Skip retyping*, `Alt+B`). Copying it is logged as
  copying, never as recall. The card returns later in the session.
- **Mark correct & save as alias** (`Alt+A`): when you typed a valid synonym
  or notation, this adds what you typed as an accepted answer, skips retyping,
  and replaces the failed review with a correct one exactly once, using the
  original timing.
- **I knew that** / **I guessed** (`Alt+K` / `Alt+G`) correct a misleading
  automatic grade; both are stored as explicit overrides.
- **Undo** (`Alt+Z`) reverses the last review's schedule, statistics and queue
  effects. Aliases you added are removed separately.
- **Skip**, **Reveal** (counts as Again), **Hint**, **Worked solution**,
  **Edit** (`Alt+E`; timing pauses and the review is flagged), **Read aloud**,
  **Voice input** and **Pause** are all one key away. See
  [Shortcuts](#keyboard-shortcuts).
- **Symbol toolbar** above the input (π √ ^ / ( ) - + ² ³ θ Δ ± ∞, a chemistry
  preset with → ⇌ Δ ⁺ ⁻ ₂ ₃ ₄ (aq) (s) (g) (l), or your own set). It switches
  automatically by answer mode, inserts at the caret, replaces a selection and
  keeps focus.
- **Live preview**: in maths and chemistry modes your typing is rendered
  above the input, so a misplaced parenthesis is visible before you submit.
- **Optional confidence rating** (1–5) after feedback. It is stored
  separately and never required.
- **Read aloud** uses the browser's speech synthesis. Built-in system voices
  usually work offline (Safari on iOS/macOS, most Android voices once
  downloaded); some Chrome voices need a connection.
- **Voice input** uses the browser's speech recognition, which on most
  browsers sends audio to an online service and does not work offline. Voice
  answers have their own timing baseline and never affect typing baselines.
- **Focus timer** (Settings → Study): Pomodoro-style; Axon suggests a break
  after the chosen minutes of active study and pauses timing during it.
- Only **one tab studies at a time** (Web Locks). Another tab can take over,
  and the first one then stops. Writes are also guarded per card, so the
  same review can never be scheduled twice, even without Web Locks.

## Study modes

| Mode | What it does | Changes the FSRS schedule? |
| --- | --- | --- |
| **Daily Review** | Due reviews, learning cards and today's new cards | Yes |
| **Cram** | Any decks/tags, all cards, shuffled or in order; can keep related cards together | No* |
| **Drill weakest** | Ranks cards by recent failures, low predicted recall, slow normalised retrieval, frequent corrections and difficulty | No* |
| **Speed practice** | Already learned cards, with an optional per-card timer | No* |
| **Interleaving** | Mixes decks and/or tags, alternating topics while respecting sibling spacing | No* |
| **Catch-up** | A manageable slice of an overdue backlog (most overdue first, or the cards still most likely to be recalled first) | Yes |
| **Exam practice** | Cards from an exam plan | No* |

\* Practice is recorded as **exposure** (it counts for statistics and marks
later tests as "affected by practice") but leaves the long-term schedule
alone. Each practice mode has an explicit *Record as scheduling reviews*
switch.

**Vacation / postpone** (Study → Vacation): postpone due cards by a number
of days or until a date, optionally spreading their return over several days.
This adds an *availability overlay*: FSRS state, intervals, history, calibration
and the real due date are unchanged, cards stay overdue for statistics, and
nothing is marked as reviewed. Card states stay distinct: **suspended** (by
you, until unsuspended), **buried/deferred** (held back by sibling spacing
until a later study day), **postponed** (vacation overlay).

Sessions can be paused, resumed (also after reloading or updating the app)
and ended; completed reviews are already saved.

## Scheduling (FSRS)

- **Layer A** is FSRS-6 via the pinned **ts-fsrs 5.4.2**, checked against
  reference cases generated with **py-fsrs 6.3.2**
  (`tests/fixtures/fsrs-reference.json`). Default parameters, learning steps
  1 min and 10 min, relearning step 10 min, maximum interval 100 years.
- **Desired retention**: 90% by default (Settings → Study, per-deck
  override). Changing it affects future reviews only.
- **Every state change goes through the scheduler.** Each review event
  records the full parameter set it used, so history can be replayed exactly
  even after settings or defaults change. *Settings → Data → Verify schedules*
  replays every card and compares.
- **Interval fuzz** (`axon-fuzz@1`): ts-fsrs's own fuzz is disabled, and Axon
  applies its own exactly once. Only intervals **longer than 7 days** vary.
  The range is the standard FSRS/Anki fuzz range (about ±5–15% depending on
  length). Its upper end is capped so that predicted retrievability on the
  new due date stays within **2 percentage points** of desired retention.
  The choice is deterministic (seeded by the review's event id), so replay
  reproduces it, and the original interval, chosen interval, bounds and seed
  are stored with the review. "Retention-safe" means only this bounded
  *predicted* drop, not a guarantee about real recall.
- **Leeches**: a card with at least the deck's threshold of lapses (default
  4) and difficulty ≥ 7 is badged as a leech in review, in the card browser
  and in Statistics, with one-click fixes: edit the prompt, add a hint,
  suspend, or create a related practice card. Decks can be set to suspend
  leeches automatically.
- **Sibling spacing**: directions, clozes and occlusions from one note, plus
  manually linked cards, are spread apart in a session (`spread`, minimum gap
  configurable), deferred to the next study day (`nextDay`), or left
  together (`off`). Deferred siblings are shown separately from completed
  reviews, and recent sibling-answer exposure is tracked.
- **Study day**: your time zone and a rollover hour (default 04:00) define
  study days. Events keep UTC timestamps; DST days of 23 or 25 hours and
  travel across time zones are handled.

## How grading works

Axon Retrieval Fluency, `axon-fluency@1.0.0` (Layer B), turns each answer into
an FSRS rating.

**1. Accuracy decides first.** Incorrect, revealed, or answered after
viewing the worked solution → **Again**. Nothing about speed can rescue a
wrong answer.

**2. Measurements** (raw values are always stored as measured):
time to first intentional keystroke (*latency*, treated as a proxy for
retrieval effort, not a direct measure of memory), typing time, total time,
answer length and typing effort (symbols cost more than letters),
corrections, pauses, input origins (typed, paste, toolbar, dictation,
autofill, IME), hidden or editor time (excluded), clock anomalies and the
input modality.

**3. Adjustments** (stored separately as *adjusted* values, versioned as
`axon-reading@1`, can be turned off in Settings → Grading):

- **Reading-time floor**, a heuristic estimate of the time needed to read
  the prompt, subtracted from latency: 250 ms + 160 ms/word + 120 ms per maths
  token + 700 ms per image, capped at 4 s. Adjusted latency is clamped at 0.
  For prompts over 60 words or with more than one image the estimate is
  marked unreliable and grading falls back to Good.
- **Warm-up**: 1.5 s of leniency (capped at 3 s) on the first card after
  starting or resuming a session.

**4. Baselines.** Personal timing baselines are kept separately for each
**modality × task type** (physical keyboard, touch keyboard, voice; recall,
calculation, multi-step). They are robust rolling statistics (median and
MAD of log latency and log time-per-effort over the last 200 eligible
answers), blended with conservative priors until 25 samples exist. Modality is
detected per review from keyboard, pointer and viewport signals with a
confidence score; *unknown* is a legitimate result, and you can override
it. Only clean answers calibrate: correct, unassisted, no typo tolerance, no
override, reliable timing, known modality, not speed practice.
Toolbar-heavy, IME and voice answers don't contribute typing speed.

**5. Grade.** A hesitation score is computed in baseline units:

```
hesitation = z(latency) + 0.35·max(0, z(typing)) + 0.25·corrections + 0.35·pauses
```

| Calibration (eligible samples) | Hard | Easy |
| --- | --- | --- |
| none (< 8) | never | never; correct answers are **Good** |
| provisional (8–24) | hesitation ≥ 2.0 | never |
| personal (25+) | hesitation ≥ 1.0 | hesitation ≤ −0.8 and all Easy conditions |

Otherwise a correct answer is **Good**. **Easy** additionally requires:
the previous scheduled review of this card was correct, unassisted, graded
Good or better and not typo-tolerated; no corrections or pauses; typing not
slower than usual; and the answer still counts as fast when only **half** of
the reading allowance is subtracted. So the reading heuristic alone can never
produce Easy.

**6. Caps and fallbacks.** A hint caps the grade (Good by default). A
typo-tolerated answer can't be Easy. "I guessed" gives Hard (configurable to
Again), never Easy. If timing is unreliable (hidden tab, long idle gap,
editor opened, clock jump, paste/autofill, unknown or low-confidence modality,
anticipatory answer < 120 ms, unreliable reading estimate), a correct answer
is **Good**. Uncertain timing never upgrades assisted recall.

**7. Explanation.** Every review stores the inferred grade, a **confidence**
value, machine-readable reason codes (e.g. `FLUENT`, `HESITANT`,
`TIMING_UNRELIABLE`, `EASY_NEEDS_HISTORY`, `HINT_CEILING`), a one-line
explanation, the rule version and the configuration used, and which
measurements were excluded and why. The confidence value is a heuristic,
**not a calibrated probability**, and is labelled as such.

**Manual mode** (Settings → Grading) shows Again/Hard/Good/Easy buttons and
stores Axon's automatic grade alongside as a shadow, for accessibility or
comparison.

**Limitations of automatic grading.** Latency mixes reading, recall,
planning and motor time; the reading floor is a population heuristic.
Typing speed varies with fatigue, device and keyboard layout. Hybrid devices
can be misclassified (hence confidence and *unknown*). Thresholds are
sensible defaults, not values validated on a population. Whether automatic
grading schedules better than self-grading **is an open question**; use
[research mode](#research-comparison-mode) to compare them on your own
data. Axon makes no claim to be better than Anki or self-graded FSRS.

## Corrections, undo and history

- **Event-sourced.** Every review, practice answer, hint, reveal, copy,
  skip, edit, sibling exposure, self-rating and correction is an immutable
  event with a UUID, device id, per-device sequence number, parent event (the
  state it was based on), and the scheduler and grading versions.
- **Schedules are derived.** A card's current FSRS state is the result of
  replaying its effective history (reviews minus voided ones, with overrides
  applied) through the scheduler with each event's own parameters. Stored
  states are a cache that can be verified or rebuilt.
- **Corrections are linked events.** Undo writes a *void*, and alias rescue
  and knew/guessed write an *override*. Nothing is erased, so synchronised
  history stays consistent. If newer reviews depend on a corrected one, they
  are replayed through the scheduler, never restored from an old snapshot.
- **Atomic and idempotent.** A review, the resulting state, the calibration
  sample and the session queue are written in one IndexedDB transaction. A
  retry with the same event id is ignored. If saving fails, your answer stays
  on screen with a Retry button, and the pending review is kept for the
  Recovery screen.
- **Replay order**: by timestamp, then device id, then sequence, then event
  id. An event never replays before its parent, even if its device clock was
  behind (causal repair). A review timestamped before the previous one is
  scheduled from the previous review time (clamped) and flagged.
- **Concurrent reviews**: if two devices review the same card from the same
  earlier state while offline, both events are kept. They are replayed in
  order with their true elapsed times (not as two independent delayed
  tests), and the card is flagged in **Settings → Sync → Review conflicts**,
  where you can keep both or keep one (the other is voided, reversibly).
  "Latest timestamp wins" is never used for schedules.
- **Clock checks**: in-session durations use `performance.now()` only;
  wall-clock jumps during a card make that timing unreliable;
  future-dated or out-of-order events are flagged for reconciliation.

## Statistics

Statistics → reviewed today, due tomorrow, a 30-day workload forecast, a
365-day activity heatmap, current and longest streak, study time, typical retrieval latency (the
median first-keystroke latency, raw and after the reading-time estimate; the
median is used because response times are skewed), weekly first-attempt accuracy with 95% Wilson
intervals, retention calibration (predicted vs observed recall), predicted
recall now, strongest and weakest cards, leeches, per-deck trends, an
exposure breakdown, and calibration status per baseline. Each chart has a
data-table view.

Rules applied throughout:

- **Observed recall** (what happened) is shown separately from **predicted
  retrievability** (what the model estimates).
- **First-attempt accuracy** is separate from **eventual success** after
  retries.
- **Hinted, revealed, overridden and independent** answers are counted
  separately. Copying the correct answer never counts as recall.
- Delayed tests preceded by optional practice or sibling-answer exposure are
  **marked and excluded** from retention calibration. When practice exists,
  predicted recall is flagged as possibly incomplete, because the memory model
  doesn't include it.
- Each card's history (in the editor) lists every attempt with its answer,
  correctness, inferred grade, effective rating, overrides, timing and
  interval.

## Exam plans and workload

**Study → Exam plans**: set an exam date, decks and/or tags, a daily time
budget and target coverage. Axon reports coverage, unintroduced and weak
cards, the reviews already due before the exam, new cards needed per day, and
the estimated workload against your budget, **with a warning when the budget
is unlikely to be enough**. Observed recall and predicted recall are shown
separately. Estimates use your own median time per review once 20 reviews
exist and are labelled *provisional* before that. A plan never changes your
schedule; exam practice is recorded as exposure. There is no claim of
readiness or of a score.

**Catch-up** after missed days suggests a per-day pace that clears the backlog
within about a week under a daily cap, and keeps the real due dates and
overdue status of everything not yet done.

## Research comparison mode

Settings → Research starts a study period that assigns each card
(**sibling group**, so a note's directions and clozes share one condition) to
**Axon automatic grading** or **standard FSRS self-grading**, stably and at
random, or puts all cards in one arm. Assignment, start date, scheduler
settings and grading version are recorded. The report compares **later
independent delayed recall** (≥ 1 day after the previous review, excluding
tests affected by practice or sibling exposure) and **total study time**,
with sample counts, median elapsed intervals and 95% intervals. It says
plainly when there are too few delayed tests (aim for 100+ per arm), and that
one learner's results do not establish superiority. Shadow grades are stored
separately and never touch live scheduling. A de-identified CSV export
(hashed ids, no card content, answers, tokens or device names) is available.

## Offline, installation and updates

- The service worker pre-caches the **complete app shell**: 111 files,
  including KaTeX and its fonts, mhchem, marked, DOMPurify, fflate and
  OpenDyslexic, all bundled locally. After one online visit, Axon cold-starts
  and works fully offline: studying, editing, importing, statistics,
  backups.
- Routing is hash-based (`#/study`, `#/decks`, …), so reloading any screen
  or launching the installed app never hits a GitHub Pages 404.
- **Updates are safe.** A new version downloads completely in the background
  into its own cache, while the old one keeps serving. A small banner
  offers to update. If you're mid-card, giving feedback, correcting, importing
  or saving, the switch waits for the next safe point, then reloads into the
  same screen (a study session continues with the next card). Only Axon's own
  old caches (`axon-*`) are removed. **IndexedDB is never touched by
  updates.**
- **Persistent storage**: Axon asks the browser not to evict its data
  (`navigator.storage.persist()`). Settings → Data shows whether that was
  granted, denied or unsupported, and how much space is used. On iOS/iPadOS
  Safari, installing to the Home Screen improves the odds; unused websites can
  otherwise be cleared after a period of inactivity. Persistence does **not**
  protect against clearing site data, uninstalling the browser or losing the
  device, so keep backups or use sync.
- Each device works offline on its own. Data moves between devices only when
  you sync (which needs a connection) or move a backup file.

## Backups, snapshots and recovery

**Settings → Data & backup**:

- **Export a full backup**: decks, cards (with aliases, hints,
  explanations, task types, clozes, occlusions), units and scheduling state,
  every event, revisions, links, plans, media (base64) and synced settings, as
  versioned JSON (`axon-backup` v1). Optionally gzip-compressed and/or
  encrypted with a passphrase (AES-256-GCM, key from PBKDF2-SHA-256 with
  600,000 iterations and a random salt, fresh 96-bit nonce per encryption,
  header authenticated). **A lost passphrase cannot be recovered.** Backups
  never contain your GitHub token or sync key. Large collections are much
  smaller compressed (136 MB → 8 MB for the 10,000-card test collection).
- **Restore or merge**: a preview shows what the file contains and any
  validation problems. **Merge** adds the backup to this device (events by
  id, edits merged, conflicts flagged) and never deletes anything. **Replace**
  makes this device match the backup, after a snapshot. Older formats are
  migrated (cards without a task type become Recall). Damaged records are
  reported and skipped while valid ones are restored; cards whose deck is
  missing go to a *Recovered cards* deck; files from a newer version are
  refused with a clear message.
- **Local snapshots** are taken automatically before replacing data,
  importing updates to existing cards, restoring a snapshot, rebuilding
  schedules, and **before every database upgrade**. The last three are kept,
  in a separate database. They are not a backup: they live on the same device.
- **Recovery** (Settings → Data → Recovery) lists unsaved reviews (retry
  safely), interrupted imports, the last database upgrade, and snapshots to
  restore or download.
- If the database can't be opened (a newer version wrote it, an upgrade
  failed, storage is unavailable or full), Axon shows an explanation and lets
  you download the latest snapshot. It **never replaces a damaged database
  with an empty one**.
- **Export for Anki**: Anki "Notes in Plain Text" (File → Import in Anki)
  with front, back (alternatives kept as `a | b`), tags, deck, note type
  (*Basic*, *Basic (and reversed card)*, *Cloze*) and a readable scheduling
  note. Anki cannot import FSRS state or review history from text, and image
  occlusion, media and history are not representable in that format; use
  JSON backups for full fidelity. This is not an `.apkg` exporter.

## Sync with a GitHub Gist

Optional, in **Settings → Sync**.

1. Create a token on GitHub (Settings → Developer settings → Personal
   access tokens). Fine-grained: *Account permissions → Gists: Read and
   write*, nothing else. Classic: only the `gist` scope.
2. Paste it, optionally turn on **Encrypt synced data** and choose a
   passphrase (10+ characters), and press **Connect**. Axon creates a
   **secret Gist** on your account.
3. On another device, paste the same token (or another one), the **Gist ID
   or URL** shown on the first device, and the same passphrase.

**Important:** a *secret* Gist is unlisted, not private. Anyone with its URL
can read it. Turn on encryption so the contents are unreadable without your
passphrase.

**Credentials**: the token is held in memory for the session unless you
choose **Remember the token on this device**, which stores it in this
browser's IndexedDB, readable by anyone with access to the browser profile
and by malicious extensions. The same applies to *Remember the key*. The token
is only ever sent to `api.github.com`; large files are downloaded from
`gist.githubusercontent.com` over HTTPS **without** the token. It is never
put in URLs, exports, backups or the Gist.

**What is synced**: everything in a backup (decks, cards, units, events,
revisions, links, plans, tombstones, media, synced settings). Device-only
settings (theme on this device, sync credentials) are not. The Gist holds:

```
axon-manifest.json        version, device, per-file SHA-256 (sealed like the rest)
axon-records.json         decks, cards, units, links, plans, tombstones, settings
axon-revisions.json       card/deck revision history
axon-events-YYYY-MM.json  review events by UTC month
axon-media-<id>.json      one file per media asset
```

Each file is a versioned envelope (format, compression, encryption and KDF
parameters). Its JSON is gzip-compressed (native `CompressionStream`, or the
bundled fflate fallback) and then optionally AES-256-GCM encrypted.
Decompression is capped at 128 MB.

**How a sync works** (manual, or automatically after changes and when the
connection returns):

1. Read the Gist (following `raw_url` for truncated files), verify each file
   against the manifest's hashes, and merge into local data.
2. Build the upload, and upload only the files whose content changed (each
   at most 8 MB, checked before upload).
3. Re-read the Gist's latest revision just before writing. If another device
   wrote in the meantime, start again from step 1.
4. Upload (data files first, manifest last), then **re-read and verify** our
   manifest is current. If revisions slipped in between, merge each one
   from the Gist history and push the union again.

**Merge rules**: events are merged by id (idempotent, retry-safe, no
duplicates). Records carry a hash-chained version history, so a descendant
edit wins over its ancestor. Concurrent edits to *different* fields merge
automatically. Concurrent edits to the *same* field keep your local value,
preserve the remote one, and are listed under **Review conflicts** for you to
choose. Deletions travel as tombstones; an edit after a delete becomes a
conflict instead of disappearing. Per-unit overlays (postpone, suspend) and
settings use last-writer-wins per key with their own timestamps.

**Limits and races**: a Gist is not a transactional database. If two devices
keep writing at the same moment, Axon retries (three times) and then stops
with a clear message. Nothing is lost, because the Gist keeps every revision
and local data is untouched. If a file would exceed 8 MB (usually because of
large media), sync stops, explains why, and your local data stays as it is;
export a backup instead. Errors such as a bad token, missing permission, rate
limits and network failures are explained in plain language.

## Security and privacy

- No accounts, analytics or third-party requests. The only network access is
  to GitHub, and only when you turn on sync (the tests check that no other
  host appears in the code).
- Card content, imports and backups are treated as data: Markdown is
  sanitised, imported HTML is reduced to text, SVG uploads are refused,
  KaTeX runs untrusted with limits, and mhchem never receives raw TeX
  commands from user input.
- No tokens or secrets in the repository (checked by a test).
- All paths are relative (`./…`), and the app works only under its own scope.

## Accessibility

- Light and dark themes (system by default), adjustable font size,
  **OpenDyslexic** (bundled), reduced motion, visible focus indicators,
  keyboard operation throughout.
- Correctness, timing and grade explanations are announced through ARIA live
  regions. Every control has an accessible name (checked by the layout
  tests).
- Retype bypass, manual grading, voice input, read-aloud, the symbol toolbar
  and auto-advance help users who cannot type quickly. Their samples are kept
  out of typing calibration.
- Touch targets are at least 44 px (40 px for compact buttons) on touch
  screens.

## Keyboard shortcuts

Press **`?`** anywhere for the cheat sheet. Single-letter shortcuts never fire
while you are typing in a field; the **Alt** versions always work.
Customise them in Settings → Input & keyboard (conflicts are rejected).

| Action | Keys |
| --- | --- |
| Submit / continue | Enter |
| Leave the answer field (so single keys work) / back to it | Esc |
| Edit current card | Alt+E or E |
| Hint · Reveal (counts as Again) · Skip | Alt+H / H · Alt+R / R · Alt+S / S |
| Undo last review | Alt+Z or U |
| Mark correct & save as alias · Mark correct (no alias) | Alt+A / A · Alt+C / C |
| I knew that · I guessed | Alt+K / K · Alt+G / G |
| Skip retyping (accessibility) | Alt+B or B |
| Worked solution · Why this grade? | Alt+W / W · Alt+Y / Y |
| Read aloud · Voice input · Pause session | Alt+T / T · Alt+M / M · Alt+P / P |
| Manual grades (manual mode) | 1–4 (or Alt+1–4) |
| Go to Home / Decks / Study / Statistics / Settings | Alt+1 … Alt+5 |
| Search · New card · Import | / · N · I |

## Performance

Measured by `tests/browser/perf.spec.mjs` with a generated collection of
**10,000 cards in 10 decks** (text, maths and chemistry), **~37,000 review
events** produced by Axon's own scheduler and grader over 200 days, and
**10,000 revisions**. Environment: headless Chromium 141 (Playwright 1.56)
on a 4-vCPU Intel Xeon 2.1 GHz Linux container with 15 GB RAM. This is
**not** a phone; expect mobile devices to be slower.

| Operation | Measured (two full runs) |
| --- | --- |
| Cold boot to home with counts (first boot builds the activity summary) | 2.4–2.9 s |
| Later boots (summary cached) | 0.5–0.6 s |
| Open the card browser (virtualised; < 120 rows in the DOM) | 81–86 ms |
| Search 10,000 cards (from typing to the filtered list) | 250–310 ms |
| Scroll the whole list, per frame | 25–27 ms |
| Deck page | 57–63 ms |
| Statistics page (all 37,000 events) | 1.9–2.0 s |
| Start a daily session | 0.32–0.33 s |
| Answer → feedback including the database write | 0.35–0.36 s |
| Replay and verify all 10,000 schedules | 2.3–2.4 s |
| Sync merge with nothing new | 7.0–7.2 s |
| Export a full backup | 11–13 s (136 MB JSON; 7.9 MB compressed) |
| Bulk-write the whole generated collection (one-off, like restoring a huge backup or a first sync to a new device) | 89–93 s |
| IndexedDB usage | 73 MB |

Each review event is about 3.4 KB (it carries its scheduler parameters,
grading details and before/after states, so it can be replayed and
explained). The one-off bulk write is dominated by IndexedDB's per-record
cost (about 1.6 ms per event, which has eight indexes, in this environment).
Day-to-day reviews write one event each.

## Testing

```bash
npm test               # 151 unit tests (node --test), ~1 s
npm run test:browser   # 23 browser tests (Playwright + Chromium), ~4 min
npm run check          # pre-cache list is current + unit tests
```

No build is needed; the tests import the same ES modules the app ships.
Browser tests need Playwright with Chromium (`npm i -D playwright`, or set
`PLAYWRIGHT_MODULE` / `CHROMIUM_PATH`). They serve the repository exactly like
GitHub Pages, under `/AxonSRS/` only, and fail if anything is requested
outside it. Results, timings and screenshots go to `test-results/` (not
committed).

- **Unit**: answer matching, aliases and escaping, import parsing (all
  formats, malformed rows, duplicates), cloze semantics, grading (baselines,
  modality, task types, reading floor, warm-up, caps, fallbacks), FSRS
  against py-fsrs reference cases, fuzz bounds, replay, concurrency, clock
  skew, corrections, undo, queues (limits, siblings, catch-up, postpone,
  drills), time zones and DST, statistics, planning, research, sync merge,
  encryption, compression, Gist client, chunking, backups, GitHub Pages paths.
- **Browser**: persistence across reloads; a synthetic v1→v2 schema
  migration with snapshot; a failing migration; refusal to open newer data;
  a failed review transaction (synthetic quota error) with no partial writes;
  persistence denied/unsupported; offline cold start with the server stopped;
  an update arriving mid-review; shortcut letters typed in the answer field;
  IME composition; held Enter; toolbar insertion and calibration exclusion;
  one study tab at a time; image occlusion created and studied offline;
  leech actions; the import wizard; alias rescue and undo; cram; in-session
  editing; plain and encrypted backup round trips through the UI; two-device
  sync through a mocked Gist API; responsive layout at 1280, 834, 390 and
  320 px (light and dark) with checks for horizontal scroll, unnamed controls
  and touch-target size; the 10,000-card performance run.

**Device coverage, honestly:** everything ran in desktop Chromium.
Tablet and phone sizes are **Chromium emulation** (viewport, touch,
`pointer: coarse`), which is not the same as Safari on an iPhone or Chrome on
an Android phone. No physical device and no WebKit browser was available, so
real on-screen keyboards, iOS storage eviction, installation prompts, speech
recognition and system TTS voices are **untested**.

## Versions

| Component | Version | Notes |
| --- | --- | --- |
| App | 1.0.2 | cache `axon-v3` |
| Scheduler | ts-fsrs 5.4.2 (FSRS-6, default parameters) + `axon-fuzz@1` | reference-checked against py-fsrs 6.3.2 |
| Grading rules | `axon-fluency@1.0.0` | thresholds above; recorded on every review |
| Reading/warm-up heuristic | `axon-reading@1` | can be disabled |
| Answer matcher | `axon-match@1.0.0` | text, maths, chemistry |
| Database | IndexedDB `axon`, schema v1, record shape v1 | migrations snapshot first |
| Backup / sync formats | `axon-backup` v1 / `axon-sync` v1 | versioned envelopes |
| Libraries (`vendor/`, licences included) | KaTeX 0.18.9 (+ mhchem), marked 18.0.14, DOMPurify 3.4.16, fflate 0.8.3, OpenDyslexic (@fontsource 5.3.0) | SHA-256 in `vendor/README.md` |

Old reviews keep the versions and parameters they were made with. A future
grading or scheduler change will apply to new reviews only, unless an
explicit, reversible migration is offered.

## Known limitations

- Automatic grading uses heuristics with default thresholds; it is not
  validated against a population (see [How grading works](#how-grading-works)).
- Gist sync is not transactional; heavy simultaneous writes from several
  devices can need a retry (data is never lost). Files over 8 MB (large media)
  can't be synced.
- A first sync or restore of a very large history takes a while (about
  90 s for 37,000 events in the test environment).
- The statistics page and a sync read the whole review history; with tens of
  thousands of reviews they take a few seconds (see [Performance](#performance)).
- Speech recognition usually needs a connection; some TTS voices do too.
- Anki export is plain text (no `.apkg`, no FSRS state, media or history).
- Only tested in Chromium; phone and tablet results are emulation (see
  [Testing](#testing)).

## Deploying to GitHub Pages

The repository root *is* the site; there is no build step.

1. Push to `main`.
2. In the repository on GitHub: **Settings → Pages → Build and deployment →
   Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**
3. After about a minute the site is live at
   <https://russellambriz.github.io/AxonSRS/>.

`.nojekyll` makes Pages serve every file as-is. All URLs are relative
(`./…`), including `manifest.json` (`start_url` and `scope` are `./`), icons,
service-worker registration and its cache list.

**Releasing a new version** (every push to `main` that changes shipped
files):

```bash
npm run release -- 1.0.3   # bumps CACHE_NAME (axon-vN → N+1) in sw.js and js/config.js,
                           # sets APP_VERSION, refreshes the pre-cache list
npm run check              # pre-cache list current + unit tests
git commit -am "Release 1.0.3" && git push origin main
```

Without a new cache name, installed copies keep serving the old version.

## Development

```bash
npm run serve        # http://localhost:8080/AxonSRS/ (same layout as GitHub Pages)
```

```
index.html, manifest.json, sw.js, .nojekyll, icons/
css/app.css                design system and layout
js/main.js                 boot (storage, shell, router, service worker)
js/app.js                  shared context: cache, counts, busy registry
js/config.js               all versions
js/core/                   pure logic (no DOM): matching, import, cloze, model,
                           scheduler, fluency (grading), history (replay), queue,
                           stats, planner, research, backup, anki, sync/*
js/data/                   IndexedDB (db.js), store.js, settings, sync service
js/study/                  session building, trial timing recorder
js/ui/                     DOM helpers, components, router, keyboard, rendering,
                           occlusion editor, views/*
vendor/                    pinned third-party libraries with licences
tests/unit/                node --test suites
tests/browser/             Playwright specs, harness and runner
tests/serve.mjs            GitHub-Pages-like static server
tools/                     update-precache.mjs, bump-version.mjs
```

Never commit tokens, secrets or personal deck data. The Gist token is typed
into the app and stays on the device.
