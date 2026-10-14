/**
 * Central version registry.
 *
 * Every component whose behaviour affects stored data records its version
 * so historical events stay interpretable after upgrades. Bump APP_VERSION
 * and CACHE_NAME (and the matching constant in ../sw.js) on every release.
 */

export const APP_NAME = 'Axon';
export const APP_VERSION = '1.0.1';

/** Service-worker cache name. Must match CACHE_NAME in sw.js (tested). */
export const CACHE_NAME = 'axon-v2';

/** IndexedDB structural schema version. */
export const DB_NAME = 'axon';
export const DB_VERSION = 1;

/** Shape version of stored records (cards, decks, units, events). */
export const RECORD_VERSION = 1;

export const BACKUP_FORMAT = 'axon-backup';
export const BACKUP_FORMAT_VERSION = 1;

export const SYNC_FORMAT = 'axon-sync';
export const SYNC_FORMAT_VERSION = 1;

/** Pinned scheduler library and Axon's own interval-fuzz layer. */
export const FSRS_LIBRARY = 'ts-fsrs@5.4.2';
export const FUZZ_VERSION = 'axon-fuzz@1';
export const SCHEDULER_VERSION = `${FSRS_LIBRARY} (FSRS-6) + ${FUZZ_VERSION}`;

/** Automatic grading rules (Axon Retrieval Fluency). */
export const GRADING_VERSION = 'axon-fluency@1.0.0';

/** Reading-time floor and warm-up heuristics. */
export const READING_HEURISTIC_VERSION = 'axon-reading@1';

/** Answer matching engine. */
export const MATCHER_VERSION = 'axon-match@1.0.0';

/** Library versions shown in Settings → About and README. */
export const LIBRARIES = Object.freeze({
  'ts-fsrs': '5.4.2',
  katex: '0.18.9',
  marked: '18.0.14',
  dompurify: '3.4.16',
  fflate: '0.8.3',
  opendyslexic: '@fontsource/opendyslexic 5.3.0',
});
