import { Badge } from './ui';
import { fmtTime } from './status';

export interface NotificationLogRow {
  id: number;
  purpose: string;
  kind: string;
  recipient: string;
  status: string;
  suppressReason: string | null;
  shadow: boolean;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

const PURPOSE: Record<string, string> = {
  incident_open: 'Opened',
  incident_update: 'Update',
  incident_resolved: 'Resolved',
  escalation: 'Escalation',
  self_alert: 'MAS alert',
  test: 'Test',
  digest: 'Digest',
};

const REASON: Record<string, string> = {
  maintenance: 'maintenance window',
  quiet_hours: 'quiet hours',
  shadow_mode: 'shadow mode',
  rate_limited: 'rate limit',
  no_contact: 'no contact details',
  channel_not_configured: 'channel has no webhook',
  channel_disabled: 'channel disabled',
  provider_not_configured: 'provider not set up',
};

/** Every notification for an incident: sent, queued, failed or deliberately not sent (and why). */
export function NotificationLog({ rows, tz }: { rows: NotificationLogRow[]; tz: string }) {
  if (rows.length === 0)
    return <p className="text-sm text-slate-400">Nothing sent for this incident.</p>;
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full text-left text-sm" data-testid="notification-log">
        <thead className="sticky top-0 bg-[#12161b] text-xs text-slate-400">
          <tr>
            <th className="py-2 pr-2">When</th>
            <th className="pr-2">What</th>
            <th className="pr-2">To</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-white/5 align-top">
              <td className="whitespace-nowrap py-1.5 pr-2 text-xs text-slate-400">
                {fmtTime(r.sentAt ?? r.createdAt, tz)}
              </td>
              <td className="pr-2">{PURPOSE[r.purpose] ?? r.purpose}</td>
              <td className="pr-2">
                {r.recipient}
                {r.shadow && (
                  <span className="ml-1">
                    <Badge tone="info">shadow</Badge>
                  </span>
                )}
              </td>
              <td>
                {r.status === 'sent' ? (
                  <Badge tone="ok">sent</Badge>
                ) : r.status === 'queued' ? (
                  <Badge tone="warn">{r.attempts ? `retrying (${r.attempts})` : 'queued'}</Badge>
                ) : r.status === 'failed' ? (
                  <Badge tone="bad">failed</Badge>
                ) : (
                  <span className="text-xs text-slate-400">
                    not sent: {REASON[r.suppressReason ?? ''] ?? r.suppressReason}
                  </span>
                )}
                {r.lastError && r.status !== 'sent' && (
                  <span className="block text-xs text-red-300">{r.lastError}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
