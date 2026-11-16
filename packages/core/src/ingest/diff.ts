import { isDownLike, type StatusNorm } from '../orion';

// ---------------------------------------------------------------------------------------------
// Active alerts
// ---------------------------------------------------------------------------------------------

export interface ActiveAlertKey {
  alertActiveId: number;
  alertObjectId: number;
  acknowledged: boolean;
}

export type AlertChangeKind = 'raised' | 'retriggered' | 'cleared' | 'acked' | 'unacked';

export interface AlertChange {
  change: AlertChangeKind;
  alertActiveId: number;
  alertObjectId: number;
  /** For `retriggered`: the AlertActiveID that disappeared for the same AlertObjectID. */
  previousAlertActiveId?: number;
}

/**
 * Diff two complete active-alert snapshots keyed by AlertActiveID.
 * A new AlertActiveID for an AlertObjectID that was active in `prev` under a different ID is a
 * re-trigger (the alert cleared and fired again between polls) — reported once as `retriggered`
 * rather than as `cleared` + `raised`.
 */
export function diffActiveAlerts(
  prev: readonly ActiveAlertKey[],
  next: readonly ActiveAlertKey[],
): AlertChange[] {
  const prevById = new Map(prev.map((a) => [a.alertActiveId, a]));
  const nextById = new Map(next.map((a) => [a.alertActiveId, a]));
  const prevByObject = new Map<number, ActiveAlertKey>();
  for (const a of prev) if (!nextById.has(a.alertActiveId)) prevByObject.set(a.alertObjectId, a);

  const changes: AlertChange[] = [];
  const consumedPrev = new Set<number>();

  for (const n of next) {
    const p = prevById.get(n.alertActiveId);
    if (!p) {
      const sameObject = prevByObject.get(n.alertObjectId);
      if (sameObject && !consumedPrev.has(sameObject.alertActiveId)) {
        consumedPrev.add(sameObject.alertActiveId);
        changes.push({
          change: 'retriggered',
          alertActiveId: n.alertActiveId,
          alertObjectId: n.alertObjectId,
          previousAlertActiveId: sameObject.alertActiveId,
        });
      } else {
        changes.push({
          change: 'raised',
          alertActiveId: n.alertActiveId,
          alertObjectId: n.alertObjectId,
        });
      }
      continue;
    }
    if (p.acknowledged !== n.acknowledged) {
      changes.push({
        change: n.acknowledged ? 'acked' : 'unacked',
        alertActiveId: n.alertActiveId,
        alertObjectId: n.alertObjectId,
      });
    }
  }

  for (const p of prev) {
    if (nextById.has(p.alertActiveId) || consumedPrev.has(p.alertActiveId)) continue;
    changes.push({
      change: 'cleared',
      alertActiveId: p.alertActiveId,
      alertObjectId: p.alertObjectId,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------------------------
// Node / interface status
// ---------------------------------------------------------------------------------------------

export interface StatusSnapshot {
  statusNorm: StatusNorm | null;
  status: number | null;
}

export interface StatusChange {
  id: number;
  from: StatusNorm | null;
  to: StatusNorm;
  fromCode: number | null;
  toCode: number | null;
  /** First time we have seen this entity. */
  isNew: boolean;
}

/**
 * Status transitions between the stored snapshot and a complete new fetch. Entities seen for the
 * first time only produce a transition when they are not healthy (a node that is already down
 * when MAS starts matters; 1,500 "unknown → up" rows do not).
 */
export function diffStatuses(
  prev: ReadonlyMap<number, StatusSnapshot>,
  next: ReadonlyArray<{ id: number; statusNorm: StatusNorm; status: number | null }>,
): StatusChange[] {
  const out: StatusChange[] = [];
  for (const n of next) {
    const p = prev.get(n.id);
    if (!p) {
      if (isDownLike(n.statusNorm) || n.statusNorm === 'warning') {
        out.push({
          id: n.id,
          from: null,
          to: n.statusNorm,
          fromCode: null,
          toCode: n.status,
          isNew: true,
        });
      }
      continue;
    }
    if (p.statusNorm !== n.statusNorm) {
      out.push({
        id: n.id,
        from: p.statusNorm,
        to: n.statusNorm,
        fromCode: p.status,
        toCode: n.status,
        isNew: false,
      });
    }
  }
  return out;
}

/** IDs present in the stored snapshot but absent from a complete fetch. */
export function removedIds(
  prev: ReadonlyMap<number, unknown>,
  next: ReadonlyArray<{ id: number }>,
): number[] {
  const seen = new Set(next.map((n) => n.id));
  return [...prev.keys()].filter((id) => !seen.has(id));
}
