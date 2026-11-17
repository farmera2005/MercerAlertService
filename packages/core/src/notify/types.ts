import type { IncidentKind, IncidentStatus, Priority } from '../correlation/types';

export const CHANNEL_KINDS = ['teams', 'sms', 'pushover'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const NOTIFICATION_PURPOSES = [
  'incident_open',
  'incident_update',
  'incident_resolved',
  'escalation',
  'self_alert',
  'test',
  'digest',
] as const;
export type NotificationPurpose = (typeof NOTIFICATION_PURPOSES)[number];

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed', 'suppressed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Why a planned message was recorded but not sent. */
export const SUPPRESS_REASONS = [
  'maintenance',
  'quiet_hours',
  'shadow_mode',
  'rate_limited',
  'no_contact',
  'channel_not_configured',
  'channel_disabled',
  'provider_not_configured',
] as const;
export type SuppressReason = (typeof SUPPRESS_REASONS)[number];

export const PAGE_VIA = ['sms', 'pushover', 'both', 'none'] as const;
export type PageVia = (typeof PAGE_VIA)[number];

export interface Person {
  id: number;
  name: string;
  phoneE164: string | null;
  pushoverUserKey: string | null;
  pageVia: PageVia;
  isItLead: boolean;
  active: boolean;
  /** Order in the weekly rotation (null = not in the rotation). */
  rotationPosition: number | null;
}

export const HOURS_MATCH = ['any', 'business', 'after'] as const;
export type HoursMatch = (typeof HOURS_MATCH)[number];

export interface RouteMatch {
  divisions?: string[];
  priorities?: Priority[];
  kinds?: IncidentKind[];
  siteIds?: number[];
  hours?: HoursMatch;
}

export interface RoutingRule {
  id: number;
  name: string;
  position: number;
  enabled: boolean;
  match: RouteMatch;
  /** Teams channel to post to (null: this rule only pages). */
  channelKey: string | null;
  pageOncall: boolean;
  escalateAfterMin: number | null;
  /** Stop evaluating later rules when this one matches. */
  stop: boolean;
}

export interface ChannelInfo {
  key: string;
  name: string;
  enabled: boolean;
  /** A webhook URL is saved. */
  configured: boolean;
}

/** What the planner needs to know about an incident. */
export interface NotifyIncident {
  id: number;
  status: IncidentStatus;
  priority: Priority;
  kind: IncidentKind;
  title: string;
  summary: string;
  siteId: number | null;
  siteName: string | null;
  affectedSiteIds: number[];
  divisionCode: string | null;
  divisionName: string | null;
  alertCount: number;
  openedAt: Date;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  snoozedUntil: Date | null;
  snoozedBy: string | null;
  materialRev: number;
  inMaintenance: boolean;
  seeded: boolean;
  recoveryTargetMin: number;
  /** The AI summary when one exists (enrichment only: never changes who is notified). */
  ai: NotifyAiSummary | null;
}

export interface NotifyAiSummary {
  whatIsAffected: string;
  likelyCause: string;
  confidence: 'low' | 'medium' | 'high';
  firstSteps: string[];
}

/** What has been notified so far for one incident (incident_notify_state). */
export interface NotifyState {
  lastStatus: IncidentStatus;
  lastPriority: Priority;
  lastKind: IncidentKind;
  lastMaterialRev: number;
  updateCount: number;
  pagedAt: Date | null;
  pagedPersonIds: number[];
  lastSnoozedUntil: Date | null;
  /** Seen only as a pre-existing (seeded) incident: nothing was announced. */
  baselined: boolean;
  /** A card carrying the AI summary has been posted. */
  aiSummaryPosted: boolean;
}
