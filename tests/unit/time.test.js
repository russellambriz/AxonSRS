// Spec 17.10: study-day rollover, timezone changes, daylight saving and clock skew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studyDay, studyDayStart, studyDayEnd, addDays, daysBetween, localTimeToUtc, detectClockJump, tzOffset, isValidTimeZone } from '../../js/core/time.js';

const NY = { timeZone: 'America/New_York', rolloverHour: 4 };

test('rollover hour: 02:00 local belongs to the previous study day', () => {
  // 2026-03-10 02:00 in New York (EDT, UTC-4) = 06:00Z
  assert.equal(studyDay(Date.UTC(2026, 2, 10, 6), NY), '2026-03-09');
  assert.equal(studyDay(Date.UTC(2026, 2, 10, 9), NY), '2026-03-10');
  assert.equal(studyDay(Date.UTC(2026, 2, 10, 3, 59), { timeZone: 'UTC', rolloverHour: 4 }), '2026-03-09');
  assert.equal(studyDay(Date.UTC(2026, 2, 10, 4, 0), { timeZone: 'UTC', rolloverHour: 4 }), '2026-03-10');
  assert.equal(studyDay(Date.UTC(2026, 2, 10, 0, 30), { timeZone: 'UTC', rolloverHour: 0 }), '2026-03-10');
});

test('daylight saving: spring forward and fall back produce 23 h and 25 h study days', () => {
  // US DST 2026: clocks change at 02:00 on 8 March and 1 November. With a
  // 04:00 rollover those instants fall inside study days 7 March and 31 October.
  const spring = studyDayEnd('2026-03-07', NY) - studyDayStart('2026-03-07', NY);
  const fall = studyDayEnd('2026-10-31', NY) - studyDayStart('2026-10-31', NY);
  assert.equal(studyDayEnd('2026-03-08', NY) - studyDayStart('2026-03-08', NY), 24 * 3600000);
  const normal = studyDayEnd('2026-06-01', NY) - studyDayStart('2026-06-01', NY);
  assert.equal(normal, 24 * 3600000);
  assert.equal(spring, 23 * 3600000);
  assert.equal(fall, 25 * 3600000);
  // boundaries land exactly on local 04:00
  assert.equal(new Date(studyDayStart('2026-03-07', NY)).toISOString(), '2026-03-07T09:00:00.000Z');
  assert.equal(new Date(studyDayStart('2026-03-08', NY)).toISOString(), '2026-03-08T08:00:00.000Z');
});

test('nonexistent local times (DST gap) resolve to the first valid instant', () => {
  const t = localTimeToUtc('2026-03-08', 2, 'America/New_York');
  assert.equal(new Date(t).toISOString(), '2026-03-08T07:00:00.000Z');
  // ambiguous fall-back hour resolves to the earlier instant
  const amb = localTimeToUtc('2026-11-01', 1, 'America/New_York');
  assert.equal(new Date(amb).toISOString(), '2026-11-01T05:00:00.000Z');
});

test('timezone travel: same UTC event, different study days, events keep UTC timestamps', () => {
  const ts = Date.UTC(2026, 5, 15, 23, 30); // 23:30Z
  assert.equal(studyDay(ts, { timeZone: 'Asia/Tokyo', rolloverHour: 4 }), '2026-06-16');
  assert.equal(studyDay(ts, { timeZone: 'America/Los_Angeles', rolloverHour: 4 }), '2026-06-15');
  assert.equal(studyDay(ts, { timeZone: 'Pacific/Kiritimati', rolloverHour: 4 }), '2026-06-16');
  assert.equal(tzOffset(ts, 'Asia/Kolkata'), 5.5 * 3600000);
  assert.ok(isValidTimeZone('Europe/Paris'));
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
});

test('calendar arithmetic across month and leap-year boundaries', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2026-03-01', '2026-02-27'), -2);
});

test('clock jumps inside a session are detected by comparing wall and monotonic clocks', () => {
  assert.equal(detectClockJump({ wallStart: 0, monoStart: 0, wallNow: 5000, monoNow: 5000 }), null);
  assert.equal(detectClockJump({ wallStart: 0, monoStart: 0, wallNow: 3600000, monoNow: 5000 }).kind, 'forward');
  assert.equal(detectClockJump({ wallStart: 3600000, monoStart: 0, wallNow: 0, monoNow: 5000 }).kind, 'backward');
});
