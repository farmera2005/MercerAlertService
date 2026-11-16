/**
 * Orion status and severity vocabularies. Values follow Orion.StatusInfo / Orion.AlertConfigurations;
 * `swis-discover` prints the instance's actual StatusInfo table so these can be confirmed.
 */
export const ORION_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: 'Unknown',
  1: 'Up',
  2: 'Down',
  3: 'Warning',
  4: 'Shutdown',
  5: 'Testing',
  6: 'Dormant',
  7: 'Not Present',
  8: 'Lower Layer Down',
  9: 'Unmanaged',
  10: 'Unplugged',
  11: 'External',
  12: 'Unreachable',
  14: 'Critical',
  15: 'Partly Available',
  16: 'Misconfigured',
  17: 'Could Not Poll',
  19: 'Unconfirmed',
  22: 'Active',
  24: 'Inactive',
  25: 'Expired',
  26: 'Monitoring Disabled',
  27: 'Disabled',
  28: 'Not Licensed',
  29: 'Other',
  30: 'Not Running',
};

export const STATUS_NORMS = [
  'up',
  'down',
  'warning',
  'critical',
  'unreachable',
  'unmanaged',
  'shutdown',
  'unplugged',
  'unknown',
  'other',
] as const;
export type StatusNorm = (typeof STATUS_NORMS)[number];

/** Map an Orion status code to the small vocabulary correlation works with. */
export function normalizeStatus(code: number | null | undefined): StatusNorm {
  switch (code) {
    case 1:
    case 22:
      return 'up';
    case 2:
    case 8: // lower layer down (interfaces)
      return 'down';
    case 3:
    case 15:
    case 19:
      return 'warning';
    case 14:
      return 'critical';
    case 12: // Orion marks dependency children Unreachable when the parent is down
      return 'unreachable';
    case 9:
    case 26:
    case 27:
      return 'unmanaged';
    case 4:
      return 'shutdown';
    case 10:
      return 'unplugged';
    case 0:
    case 17:
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'other';
  }
}

/** True for states that mean "this thing is not working" (used for transitions and tiles). */
export function isDownLike(s: StatusNorm): boolean {
  return s === 'down' || s === 'unreachable' || s === 'critical';
}

export const ORION_SEVERITIES = [
  'informational',
  'warning',
  'critical',
  'serious',
  'notice',
] as const;
export type OrionSeverity = (typeof ORION_SEVERITIES)[number];

/** Orion.AlertConfigurations.Severity: 0 Informational, 1 Warning, 2 Critical, 3 Serious, 4 Notice. */
export function orionSeverity(code: number | null | undefined): OrionSeverity {
  switch (code) {
    case 1:
      return 'warning';
    case 2:
      return 'critical';
    case 3:
      return 'serious';
    case 4:
      return 'notice';
    default:
      return 'informational';
  }
}

/** Ordering for "worst severity wins" comparisons. */
export const SEVERITY_RANK: Readonly<Record<OrionSeverity, number>> = {
  informational: 0,
  notice: 1,
  warning: 2,
  serious: 3,
  critical: 4,
};
