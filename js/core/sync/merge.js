/**
 * Dataset merge used by Gist sync and backup restore.
 *
 *  - Review events: union by immutable event id (idempotent, retry-safe).
 *  - Versioned records (decks, cards, links, plans): descendant wins;
 *    divergent edits get a field-level three-way merge, otherwise an
 *    explicit conflict is recorded and the local version is kept. The
 *    other version is always preserved in the revision history.
 *  - Deletions propagate through tombstones; an edit made after (or
 *    concurrently with) a deletion becomes a delete/edit conflict instead
 *    of being silently lost.
 *  - Unit overlays (suspend, bury, postpone) are last-writer-wins by their
 *    own timestamps. FSRS state is never merged: units whose event sets
 *    changed are rebuilt by replaying history (see history.js).
 *  - Settings: per-key last-writer-wins.
 * The result is deterministic: two devices merging the same inputs reach
 * identical records and version hashes.
 */

import { VERSIONED_TYPES, contentOf, revisionIndex, isAncestor, commonAncestor, threeWay, stamp } from './versioning.js';

function byId(list) {
  const m = new Map();
  for (const x of list || []) if (x && x.id != null) m.set(x.id, x);
  return m;
}

function inc(obj, key, n = 1) {
  obj[key] = (obj[key] || 0) + n;
}

export function emptyDataset() {
  return { decks: [], cards: [], links: [], plans: [], revisions: [], tombstones: [], events: [], units: [], media: [], settings: { values: {}, updatedAt: {} } };
}

/** Deterministic merge version: same on every device for the same inputs. */
function mergedVersion(type, base, merged, a, b) {
  const [p, m] = a.version.hash < b.version.hash ? [a.version.hash, b.version.hash] : [b.version.hash, a.version.hash];
  const record = { ...base, ...merged, version: { ...base.version, hash: p, rev: Math.max(a.version.rev, b.version.rev) } };
  return stamp(type, record, { deviceId: 'merge', ts: Math.max(a.version.ts, b.version.ts) + 1, mergeParent: m });
}

export function mergeRecord(type, l, r, index, report, newRevisions) {
  if (!l) {
    inc(report.added, type);
    return r;
  }
  if (!r) return l;
  const lh = l.version?.hash;
  const rh = r.version?.hash;
  if (lh && lh === rh) return l;
  if (!lh) {
    inc(report.updated, type);
    return r;
  }
  if (!rh) return l;
  if (isAncestor(lh, rh, index)) {
    inc(report.updated, type);
    return r;
  }
  if (isAncestor(rh, lh, index)) return l;
  const baseHash = commonAncestor(lh, rh, index);
  const base = baseHash ? index.get(baseHash)?.snapshot ?? null : null;
  const { merged, conflicts } = threeWay(base, contentOf(type, l), contentOf(type, r));
  if (merged) {
    const { record, revision } = mergedVersion(type, l, merged, l, r);
    newRevisions.push(revision);
    index.set(revision.hash, revision);
    report.autoMerged++;
    inc(report.updated, type);
    return record;
  }
  report.conflicts.push({
    id: `edit:${l.id}:${[lh, rh].sort().join(':')}`,
    kind: 'edit',
    recordType: type,
    recordId: l.id,
    localHash: lh,
    remoteHash: rh,
    baseHash,
    fields: conflicts,
    local: contentOf(type, l),
    remote: contentOf(type, r),
    base,
    remoteRecord: r,
  });
  return l;
}

function mergeTombstones(a = [], b = []) {
  const m = byId(a);
  for (const t of b) {
    const x = m.get(t.id);
    if (!x) {
      m.set(t.id, t);
      continue;
    }
    const revokedAt = Math.max(x.revokedAt || 0, t.revokedAt || 0) || null;
    const deletedAt = Math.max(x.deletedAt, t.deletedAt);
    const latest = x.deletedAt >= t.deletedAt ? x : t;
    m.set(t.id, { ...latest, deletedAt, revokedAt, revoked: !!revokedAt && revokedAt > deletedAt });
  }
  return [...m.values()];
}

function lww(a, b, tsKey) {
  const ta = a?.[tsKey] || 0;
  const tb = b?.[tsKey] || 0;
  if (ta !== tb) return ta > tb ? a : b;
  return (a?.deviceId || '') >= (b?.deviceId || '') ? a : b;
}

function sameEventFacts(a, b) {
  return a.type === b.type && a.unitId === b.unitId && a.ts === b.ts && (a.rating ?? null) === (b.rating ?? null) && (a.targetId ?? null) === (b.targetId ?? null);
}

/**
 * @param {object} local dataset
 * @param {object} remote dataset (already validated)
 */
export function mergeDatasets(local, remote) {
  const L = { ...emptyDataset(), ...local };
  const R = { ...emptyDataset(), ...remote };
  const report = { added: {}, updated: {}, removed: {}, conflicts: [], autoMerged: 0, newEvents: 0, unitsToReplay: new Set(), integrity: [], revokedTombstones: 0 };
  const revisions = byId(L.revisions);
  for (const r of R.revisions) if (!revisions.has(r.id)) revisions.set(r.id, r);
  const index = revisionIndex([...revisions.values()]);
  const newRevisions = [];
  const tombstones = mergeTombstones(L.tombstones, R.tombstones);
  const out = {};

  for (const type of VERSIONED_TYPES) {
    const lm = byId(L[type]);
    const rm = byId(R[type]);
    const merged = new Map();
    for (const id of new Set([...lm.keys(), ...rm.keys()])) merged.set(id, mergeRecord(type, lm.get(id), rm.get(id), index, report, newRevisions));
    out[type] = merged;
  }

  // Tombstones
  for (const t of tombstones) {
    if (t.revoked) continue;
    const coll = out[t.type];
    if (!coll || !coll.has(t.id)) continue;
    const rec = coll.get(t.id);
    const h = rec.version?.hash;
    if (!h || !t.lastHash || h === t.lastHash || isAncestor(h, t.lastHash, index)) {
      coll.delete(t.id);
      inc(report.removed, t.type);
    } else if (rec.version?.resurrects && isAncestor(t.lastHash, h, index) && rec.version.ts > t.deletedAt) {
      t.revoked = true;
      t.revokedAt = rec.version.ts;
      report.revokedTombstones++;
    } else {
      report.conflicts.push({
        id: `delete-edit:${t.id}:${t.lastHash}:${h}`,
        kind: 'delete-edit',
        recordType: t.type,
        recordId: t.id,
        tombstone: t,
        local: contentOf(t.type, rec),
      });
    }
  }

  // Events: union by id
  const events = byId(L.events);
  for (const e of R.events) {
    const existing = events.get(e.id);
    if (!existing) {
      events.set(e.id, e);
      report.newEvents++;
      if (e.unitId) report.unitsToReplay.add(e.unitId);
      if (e.type === 'correction' && e.unitId) report.unitsToReplay.add(e.unitId);
    } else if (!sameEventFacts(existing, e)) {
      report.integrity.push({ id: e.id, message: 'Two different events share one id; the local copy was kept' });
    }
  }
  const localEventIds = new Set(L.events.map((e) => e.id));

  // Units: union; overlays and suspension are LWW by their timestamps
  const units = byId(L.units);
  for (const r of R.units) {
    const l = units.get(r.id);
    if (!l) {
      units.set(r.id, { ...r });
      report.unitsToReplay.add(r.id);
      continue;
    }
    const o = lww(l, r, 'overlaysAt');
    const s = lww(l, r, 'suspendedAt');
    units.set(r.id, { ...l, overlays: o.overlays || {}, overlaysAt: o.overlaysAt || 0, suspended: !!s.suspended, suspendedAt: s.suspendedAt || 0 });
  }
  // Units referenced only by remote events
  for (const e of R.events) if (e.unitId && !localEventIds.has(e.id)) report.unitsToReplay.add(e.unitId);

  // Media: content-addressed union
  const media = byId(L.media);
  for (const m of R.media) {
    const x = media.get(m.id);
    if (!x || (!x.data && m.data)) media.set(m.id, m);
  }

  // Settings: per-key LWW
  const settings = { values: { ...(L.settings?.values || {}) }, updatedAt: { ...(L.settings?.updatedAt || {}) } };
  for (const [k, v] of Object.entries(R.settings?.values || {})) {
    const rt = R.settings.updatedAt?.[k] || 0;
    const lt = settings.updatedAt[k] || 0;
    if (rt > lt) {
      settings.values[k] = v;
      settings.updatedAt[k] = rt;
    }
  }

  for (const r of newRevisions) revisions.set(r.id, r);
  return {
    dataset: {
      decks: [...out.decks.values()],
      cards: [...out.cards.values()],
      links: [...out.links.values()],
      plans: [...out.plans.values()],
      revisions: [...revisions.values()],
      tombstones,
      events: [...events.values()],
      units: [...units.values()],
      media: [...media.values()],
      settings,
    },
    report,
  };
}
