import { auditLog } from '../schema';
import type { DbOrTx } from '../client';

export interface AuditEntry {
  actorType: 'user' | 'kiosk' | 'system';
  actorId?: string | null;
  actorLabel: string;
  action: string;
  targetType?: string;
  targetId?: string | number;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** Write an audit row. Call inside the same transaction as the change it records. */
export async function writeAudit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    actorLabel: e.actorLabel,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId === undefined ? undefined : String(e.targetId),
    before: e.before ?? null,
    after: e.after ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
  });
}
