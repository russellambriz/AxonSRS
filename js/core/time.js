/**
 * Study-day arithmetic.
 *
 * Durable timestamps are UTC milliseconds. A *study day* is a calendar
 * date string (YYYY-MM-DD) in the user's chosen IANA timezone, rolling
 * over at a configurable local hour (default 04:00) rather than midnight.
 * Because the boundary is computed from local wall-clock time, daylight
 * saving transitions and timezone changes are handled by the platform's
 * timezone database (Intl), not by fixed offsets.
 */

const formatterCache = new Map();

function formatter(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimeZone(tz) {
  try {
    formatter(tz).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock parts of a UTC timestamp in `timeZone`. */
export function localParts(ts, timeZone) {
  const parts = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** Offset (ms) of `timeZone` from UTC at instant `ts`. */
export function tzOffset(ts, timeZone) {
  const p = localParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function dayString(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return { year: y, month: m, day: d };
}

/** Add whole calendar days to a YYYY-MM-DD string. */
export function addDays(day, n) {
  const { year, month, day: d } = parseDay(day);
  const t = new Date(Date.UTC(year, month - 1, d + n));
  return dayString(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function daysBetween(dayA, dayB) {
  const a = parseDay(dayA);
  const b = parseDay(dayB);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
}

/** Study day containing instant `ts`. */
export function studyDay(ts, { timeZone = 'UTC', rolloverHour = 4 } = {}) {
  const p = localParts(ts, timeZone);
  const day = dayString(p.year, p.month, p.day);
  return p.hour < rolloverHour ? addDays(day, -1) : day;
}

/**
 * UTC instant at which local wall time in `timeZone` reads
 * `day` at `hour`:00. If that wall time does not exist (spring-forward
 * gap) the first valid instant after it is returned; if it occurs twice
 * (fall-back) the earlier one is returned.
 */
export function localTimeToUtc(day, hour, timeZone) {
  const { year, month, day: d } = parseDay(day);
  const naive = Date.UTC(year, month - 1, d, hour, 0, 0);
  // Two-pass offset resolution
  let guess = naive - tzOffset(naive, timeZone);
  const offset2 = tzOffset(guess, timeZone);
  guess = naive - offset2;
  const p = localParts(guess, timeZone);
  if (p.hour !== hour || p.day !== d) {
    // Gap: step forward minute by minute (at most a few hours) to the first valid instant.
    for (let t = guess; t < guess + 4 * 3600000; t += 60000) {
      const q = localParts(t, timeZone);
      if (dayString(q.year, q.month, q.day) === day && q.hour >= hour) return t;
      if (dayString(q.year, q.month, q.day) > day) return t;
    }
  }
  // Prefer the earlier instant for ambiguous (repeated) wall times.
  const earlier = guess - 3600000;
  const e = localParts(earlier, timeZone);
  if (e.hour === hour && e.minute === 0 && dayString(e.year, e.month, e.day) === day) return earlier;
  return guess;
}

/** Start instant (UTC ms) of a study day. */
export function studyDayStart(day, { timeZone = 'UTC', rolloverHour = 4 } = {}) {
  return localTimeToUtc(day, rolloverHour, timeZone);
}

/** End instant (exclusive) of a study day = start of the next one. */
export function studyDayEnd(day, opts = {}) {
  return studyDayStart(addDays(day, 1), opts);
}

/**
 * Detect implausible clock behaviour inside a session by comparing the
 * wall clock with the monotonic clock. Returns null or a description.
 */
export function detectClockJump({ wallStart, monoStart, wallNow, monoNow, toleranceMs = 120000 }) {
  const wallDelta = wallNow - wallStart;
  const monoDelta = monoNow - monoStart;
  const drift = wallDelta - monoDelta;
  if (Math.abs(drift) > toleranceMs) return { driftMs: drift, kind: drift > 0 ? 'forward' : 'backward' };
  return null;
}
