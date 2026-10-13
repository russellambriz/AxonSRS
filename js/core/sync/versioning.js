/**
 * Hash-chained record versions for conflict detection.
 *
 * Every edit of a deck, card, link or exam plan gets a new version whose
 * `parent` is the previous version hash, and a revision snapshot is kept.
 * Two devices that edited the same record since their common ancestor
 * produce divergent chains; the merge then performs a field-level
 * three-way merge or records an explicit conflict.
 */

import { hashHex, stableStringify } from '../util.js';
import { contentFields } from '../model.js';

export const VERSIONED_TYPES = Object.freeze(['decks', 'cards', 'links', 'plans']);

export function contentOf(type, record) {
  switch (type) {
    case 'cards':
      return contentFields(record);
    case 'decks':
      return { name: record.name, description: record.description, color: record.color, group: record.group, settings: record.settings, archived: !!record.archived };
    case 'links':
      return { a: record.a, b: record.b, kind: record.kind || 'related' };
    case 'plans':
      return { name: record.name, examDate: record.examDate, deckIds: record.deckIds, tags: record.tags, dailyMinutes: record.dailyMinutes, targetCoverage: record.targetCoverage, archived: !!record.archived, alterSchedule: !!record.alterSchedule };
    default:
      throw new Error(`Unversioned type ${type}`);
  }
}

/** Assign a new version to `record` (returns { record, revision }). */
export function stamp(type, record, { deviceId, ts = Date.now(), mergeParent = null, resurrects = false } = {}) {
  const parent = record.version?.hash || null;
  const content = contentOf(type, record);
  const hash = hashHex(stableStringify({ c: content, p: parent, m: mergeParent, d: deviceId, t: ts }));
  const version = { rev: (record.version?.rev || 0) + 1, hash, parent, deviceId, ts };
  if (mergeParent) version.mergeParent = mergeParent;
  if (resurrects) version.resurrects = true;
  const next = { ...record, version, updatedAt: ts };
  return { record: next, revision: revisionFor(type, next) };
}

export function revisionFor(type, record) {
  const v = record.version;
  return {
    id: `${record.id}@${v.hash}`,
    recordId: record.id,
    recordType: type,
    hash: v.hash,
    parent: v.parent,
    mergeParent: v.mergeParent || null,
    ts: v.ts,
    deviceId: v.deviceId,
    snapshot: contentOf(type, record),
  };
}

/** Index revisions by hash for ancestry queries. */
export function revisionIndex(revisions) {
  const m = new Map();
  for (const r of revisions) m.set(r.hash, r);
  return m;
}

function parentsOf(hash, index) {
  const r = index.get(hash);
  if (!r) return [];
  return [r.parent, r.mergeParent].filter(Boolean);
}

/** True if `ancestor` is `descendant` or one of its ancestors. */
export function isAncestor(ancestor, descendant, index, limit = 20000) {
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  const queue = [descendant];
  const seen = new Set();
  while (queue.length && seen.size < limit) {
    const h = queue.shift();
    if (h === ancestor) return true;
    if (seen.has(h)) continue;
    seen.add(h);
    queue.push(...parentsOf(h, index));
  }
  return false;
}

/** Lowest common ancestor hash of two versions, if known. */
export function commonAncestor(a, b, index, limit = 20000) {
  const ancestorsA = new Set();
  const qa = [a];
  while (qa.length && ancestorsA.size < limit) {
    const h = qa.shift();
    if (ancestorsA.has(h)) continue;
    ancestorsA.add(h);
    qa.push(...parentsOf(h, index));
  }
  const qb = [b];
  const seen = new Set();
  while (qb.length && seen.size < limit) {
    const h = qb.shift();
    if (ancestorsA.has(h)) return h;
    if (seen.has(h)) continue;
    seen.add(h);
    qb.push(...parentsOf(h, index));
  }
  return null;
}

/**
 * Field-level three-way merge of content snapshots.
 * @returns {{ merged: object|null, conflicts: string[] }}
 */
export function threeWay(base, local, remote) {
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {}), ...Object.keys(base || {})]);
  const merged = {};
  const conflicts = [];
  for (const k of keys) {
    const b = stableStringify(base ? base[k] : undefined);
    const l = stableStringify(local[k]);
    const r = stableStringify(remote[k]);
    if (l === r) merged[k] = local[k];
    else if (base && l === b) merged[k] = remote[k];
    else if (base && r === b) merged[k] = local[k];
    else {
      conflicts.push(k);
      merged[k] = local[k];
    }
  }
  return { merged: conflicts.length ? null : merged, conflicts };
}
