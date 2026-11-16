/**
 * Deterministic incident titles and summaries in business terms. These are what notifications use
 * when AI is unavailable (and what the AI summary is checked against).
 */
import type { DeviceRole } from '../mapping';
import type { AlertRecord, IncidentKind, NodeInfo, SiteInfo } from './types';

const ROLE_NAME: Record<DeviceRole, [string, string]> = {
  firewall: ['firewall', 'firewalls'],
  core_switch: ['core switch', 'core switches'],
  switch: ['switch', 'switches'],
  router: ['router', 'routers'],
  access_point: ['access point', 'access points'],
  server: ['server', 'servers'],
  scale_system: ['scale system', 'scale systems'],
  ups: ['UPS', 'UPSes'],
  other: ['device', 'devices'],
};

export function roleName(role: DeviceRole, n = 1): string {
  return ROLE_NAME[role][n === 1 ? 0 : 1];
}

/** "2 scale systems, 3 access points and 1 switch" */
export function describeRoles(roles: readonly DeviceRole[]): string {
  const counts = new Map<DeviceRole, number>();
  for (const r of roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  const order: DeviceRole[] = [
    'scale_system',
    'server',
    'firewall',
    'core_switch',
    'router',
    'switch',
    'access_point',
    'ups',
    'other',
  ];
  const parts = order
    .filter((r) => counts.has(r))
    .map((r) => `${counts.get(r)} ${roleName(r, counts.get(r))}`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export interface TemplateInput {
  kind: IncidentKind;
  site: SiteInfo | null;
  rootNode: NodeInfo | null;
  downNodes: NodeInfo[];
  unreachableNodes: NodeInfo[];
  activeRecords: AlertRecord[];
  alertCount: number;
  flapChanges: number;
  flapWindowMin: number;
  harvestCriticalInHarvest: boolean;
  recoveryTargetMin: number;
  sourceReason?: string | null;
}

const hours = (min: number) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);

export function incidentTitle(i: TemplateInput): string {
  const where = i.site ? ` — ${i.site.name}` : '';
  const first = i.activeRecords[0];
  switch (i.kind) {
    case 'monitoring_source_down':
      return 'SolarWinds monitoring unavailable';
    case 'site_outage':
      return `Site down${where}`;
    case 'flapping':
      return `${i.rootNode?.caption ?? first?.entityCaption ?? 'Device'} flapping${where}`;
    case 'ups_power': {
      const ups = i.activeRecords.find((r) =>
        /battery/i.test(`${r.alertName} ${r.lastMessage ?? ''}`),
      );
      return `${ups ? 'UPS on battery' : 'Power / UPS alert'}${where}`;
    }
    case 'device_down':
      if (i.downNodes.length === 0)
        return `${i.unreachableNodes.length} device${i.unreachableNodes.length === 1 ? '' : 's'} unreachable${where}`;
      if (i.downNodes.length === 1 || i.rootNode)
        return `${(i.rootNode ?? i.downNodes[0])!.caption} down${where}`;
      return `${i.downNodes.length} devices down${where}`;
    case 'interface':
    case 'service':
    case 'generic':
    default: {
      if (!first) return `Alert${where}`;
      const more = i.activeRecords.length > 1 ? ` (+${i.activeRecords.length - 1} more)` : '';
      return `${first.alertName} — ${first.entityCaption ?? i.site?.name ?? 'unknown'}${more}`;
    }
  }
}

export function incidentSummary(i: TemplateInput): string {
  const s: string[] = [];
  const siteName = i.site?.name ?? 'an unmapped site';
  const division = i.site?.divisionName ? ` (${i.site.divisionName})` : '';
  const affected = [...i.downNodes, ...i.unreachableNodes].filter(
    (n) => n.nodeId !== i.rootNode?.nodeId,
  );
  switch (i.kind) {
    case 'monitoring_source_down':
      s.push(`MAS cannot reach SolarWinds${i.sourceReason ? ` (${i.sourceReason})` : ''}.`);
      s.push(
        'No new problems can be detected until it is back; existing incidents will not auto-resolve meanwhile.',
      );
      break;
    case 'site_outage':
      if (i.rootNode?.role === 'firewall')
        s.push(
          `The WAN edge firewall ${i.rootNode.caption} at ${siteName}${division} is down, so the whole site is cut off.`,
        );
      else s.push(`Every monitored device at ${siteName}${division} is down or unreachable.`);
      if (affected.length) s.push(`Affected: ${describeRoles(affected.map((n) => n.role))}.`);
      break;
    case 'device_down':
      if (i.rootNode) {
        s.push(
          `${i.rootNode.caption} (${roleName(i.rootNode.role)}) at ${siteName}${division} is down.`,
        );
        if (affected.length)
          s.push(
            `${affected.length} device${affected.length === 1 ? ' behind it is' : 's behind it are'} affected: ${describeRoles(affected.map((n) => n.role))}.`,
          );
      } else if (i.unreachableNodes.length) {
        s.push(
          `${describeRoles(i.unreachableNodes.map((n) => n.role))} at ${siteName}${division} ${i.unreachableNodes.length === 1 ? 'is' : 'are'} unreachable; Orion does not show which upstream device failed.`,
        );
      } else {
        s.push(`${describeRoles(i.downNodes.map((n) => n.role))} at ${siteName}${division} down.`);
      }
      break;
    case 'flapping':
      s.push(
        `${i.rootNode?.caption ?? i.activeRecords[0]?.entityCaption ?? 'A device'}${i.rootNode ? ` (${roleName(i.rootNode.role)})` : ''} at ${siteName} changed state ${i.flapChanges} times in the last ${i.flapWindowMin} minutes. Grouped into one incident instead of separate down/up alerts.`,
      );
      break;
    case 'ups_power': {
      const r =
        i.activeRecords.find((x) =>
          /battery|power|ups/i.test(`${x.alertName} ${x.lastMessage ?? ''}`),
        ) ?? i.activeRecords[0];
      s.push(
        `${r?.lastMessage ?? `${r?.alertName ?? 'UPS alert'} on ${r?.entityCaption ?? 'a UPS'}`}`.trim(),
      );
      s.push(
        `If utility power is not restored, network equipment at ${siteName}${division} will shut down when the battery runs out.`,
      );
      break;
    }
    default: {
      const r = i.activeRecords[0];
      if (r)
        s.push(
          `${r.alertName} on ${r.entityCaption ?? 'an Orion entity'} at ${siteName}${division}${r.lastMessage ? `: ${r.lastMessage}` : '.'}`,
        );
      if (i.activeRecords.length > 1)
        s.push(
          `${i.activeRecords.length - 1} related alert${i.activeRecords.length === 2 ? '' : 's'} grouped.`,
        );
    }
  }
  const scales = [...i.downNodes, ...i.unreachableNodes].filter((n) => n.role === 'scale_system');
  if (scales.length && i.kind !== 'monitoring_source_down')
    s.push(`Scales at ${siteName} may be offline.`);
  if (i.alertCount > 1 && i.kind !== 'flapping')
    s.push(`${i.alertCount} Orion alerts grouped into this incident.`);
  if (i.harvestCriticalInHarvest)
    s.push(`Harvest-critical site during harvest — recovery target ${hours(i.recoveryTargetMin)}.`);
  return s.join(' ');
}
