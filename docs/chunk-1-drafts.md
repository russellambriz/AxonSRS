# Chunk 1 follow-up — unfinished answers before submission

Scope: what a learner has typed, written and chosen for the card in front of
them, before they check it. Restoring a pending self-check, the feedback or
correction stage, scheduler and Undo design, statistics, OCR, sync and
native Pencil are out of scope.

## What was wrong (live 1b8b734, reproduced 7 Nov 2026)

| | Failure | Cause |
| --- | --- | --- |
| A | Typed draft and confidence lost on reload | `present()` in `js/ui/views/study.js` always reset the field, the pad and confidence; nothing stored a draft |
| B | Lost after Pause and leave, then Resume | `leave()` and `pause()` saved only the session position |
| C | Ink erased by Write → Type → Write | `toggleInk()` called `this.ink.clear()` |
| D | Ink and confidence lost on reload in Write mode | as A; only the mode lived in `localStorage` |

## Design

- **One state per attempt.** `js/study/drafts.js` (`DraftKeeper`) holds the
  unfinished answer for the card on screen: text, ink strokes, confidence,
  mode, help used. The field and the pad are views of it.
- **Bound to the attempt.** Key `sessionId:index:unitId:attempts`
  (`js/core/draft.js`). A later appearance of the same card is a new attempt
  and starts empty.
- **Stored on the session record** (`session.draft`) through the existing
  store. No database upgrade, no new store, no sync.
- **Retired atomically.** `putSessionInTx` in `js/data/store.js` keeps a
  stored draft only while it belongs to the session's current attempt. A
  review, skip, undo, finish or end that moves the session on drops it in
  the same transaction, so a submitted answer can never come back as a draft,
  and a failed submission leaves it in place.
- **Ordered, revision-checked writes.** One write in flight; edits made
  meanwhile go into the next write. `store.saveDraft` is compare-and-swap on
  `rev` and refuses a write for an attempt that is over (`consumed`).
- **Hydrate before save.** The stored draft is read before the card is
  usable; nothing is written until it is applied, so an empty editor at
  start-up cannot overwrite a saved draft. A late read for another attempt is
  ignored (key check).
- **Answer shown = draft finished.** When the answer is shown before a grade
  (self-check, compare), the draft is marked `exposed` and never restored.
  The correction trace runs after that and is never saved into the draft;
  the original answer's ink stays separate from correction strokes.
- **Pause and leave wait for the save.** If it fails and the answer is not
  blank, leaving asks first ("Leave without saving your answer?").
- **Help counts.** A hint or worked solution opened before a reload is shown
  again and still recorded on the review; no new hint or reveal event is
  logged on restore.

## The guarantee and the unsaved window

Once the indicator shows **Saved**, the answer is committed to IndexedDB
(`durability: 'strict'`) and comes back after a reload, a crash of the tab,
Pause, or leaving and returning on this device and browser profile.

Not yet saved, at most:

- typing in the last ~250 ms (debounce), plus the time of one IndexedDB
  write; a finished stroke, Undo, Redo, Clear, confidence and mode switches
  start a write at once;
- the stroke under the pencil, which is saved when it ends;
- anything after a **Couldn't save** until Retry (or the next edit)
  succeeds. It stays on screen meanwhile.

Hiding the page (`visibilitychange`, `pagehide`) also starts a save, but the
browser may not finish it if the page is killed at that moment.

## Several tabs

The existing study lock (one tab studies at a time) is the policy. When
another tab takes over, this tab stops writing at once. If two writers still
meet (for example the lock is unsupported), the store refuses the older
revision; that tab shows "Changed in another tab. Couldn't save" and Retry
keeps its own version.

## Migration

None needed: older sessions have no `draft` field and simply start empty. A
draft written by a newer app version (`v` above `DRAFT_VERSION`) is ignored,
not misread. Starting the app again is repeat-safe (tested).

## Limits

- Drafts live in this browser profile only (no sync), like the rest of the
  study state.
- Ink is restored at its CSS-pixel positions. After a large resize or
  rotation it keeps its place on the pad rather than scaling.
- A pending self-check (answer already shown) is not restored: by design it
  comes back as practice.
- If a submission fails and the learner reloads, answers again, and later
  also retries the earlier saved review from Recovery, both are kept, as
  before this change.

## Service worker: deploying this

PR #18 (live 1b8b734) changed `js/ui/views/editor.js` and
`js/ui/views/pencil.js` without a version bump, so `sw.js` did not change
and installed copies of the app kept the 1.0.17 files from before #18.
This change adds two files to the precache list, so `sw.js` changes and a
new worker installs; but with the same cache name it would write the new
files into the cache the old worker is still serving from, mixing versions.
The separate release commit (1.0.18, `axon-v19`) gives it a fresh cache, so
the update is all-or-nothing and also carries #18's files to installed
copies. The bump is a release step, not evidence that anything works.

Deployment check after merging:

1. The Pages workflow for the merge commit succeeds.
2. On a device that already has the app installed, open it online; the
   update prompt appears (or it updates at the next safe point), and
   Settings → About shows the new version.
3. `sw.js` on the site has the new `CACHE_NAME`, and the precache list
   includes `js/core/draft.js` and `js/study/drafts.js`.
4. Repeat the four checks (A–D) on the installed app, then 21–23 on iPad.
