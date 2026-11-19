/**
 * A deterministic, Mercer-like synthetic Orion world: sites with FortiGate WAN edges, Cisco /
 * MikroTik switching, Ubiquiti APs, CyberPower UPSes, CompuWeigh scale PCs and HQ servers.
 * Records use Orion property names so the SWQL engine can project them directly.
 *
 * PLACEHOLDER data only — it mirrors packages/db seed-data so mapping works end to end.
 */

export type Rec = Record<string, unknown>;

export interface MockSite {
  prefix: string;
  /** Value written to the Site custom property ('' = property empty → caption fallback). */
  cpSite: string;
  cpDivision: string;
  city: string;
  kind: 'hq' | 'grain' | 'agronomy' | 'feed' | 'energy';
  /** Whether Orion has a dependency FW → site group configured. */
  dependencies: boolean;
}

/** SolarWinds group names where they differ from the Site property (the full site names). */
const SITE_GROUP_NAMES: Record<string, string> = {
  ROCK: 'Rockford Elevator',
  FTR: 'Fort Recovery Elevator',
  STH: 'St. Henry Elevator',
  MEN: 'Mendon Elevator',
  OHC: 'Ohio City Agronomy',
  VWRT: 'Van Wert Agronomy Center',
  WAPA: 'Wapakoneta Energy',
};

export const MOCK_SITES: MockSite[] = [
  {
    prefix: 'CEL',
    cpSite: 'Celina HQ',
    cpDivision: 'Corporate',
    city: 'Celina',
    kind: 'hq',
    dependencies: true,
  },
  {
    prefix: 'ROCK',
    cpSite: 'Rockford',
    cpDivision: 'Grain',
    city: 'Rockford',
    kind: 'grain',
    dependencies: true,
  },
  {
    prefix: 'COLD',
    cpSite: 'Coldwater Elevator',
    cpDivision: 'Grain',
    city: 'Coldwater',
    kind: 'grain',
    dependencies: true,
  },
  {
    prefix: 'FTR',
    cpSite: 'Fort Recovery',
    cpDivision: 'Grain',
    city: 'Fort Recovery',
    kind: 'grain',
    dependencies: false,
  },
  {
    prefix: 'STH',
    cpSite: 'St Henry',
    cpDivision: 'Grain',
    city: 'St. Henry',
    kind: 'grain',
    dependencies: true,
  },
  { prefix: 'MEN', cpSite: '', cpDivision: '', city: 'Mendon', kind: 'grain', dependencies: false },
  {
    prefix: 'OHC',
    cpSite: 'Ohio City',
    cpDivision: 'Agronomy',
    city: 'Ohio City',
    kind: 'agronomy',
    dependencies: true,
  },
  {
    prefix: 'VWRT',
    cpSite: 'Van Wert',
    cpDivision: 'Agronomy Center',
    city: 'Van Wert',
    kind: 'agronomy',
    dependencies: false,
  },
  {
    prefix: 'WAPA',
    cpSite: 'Wapakoneta',
    cpDivision: 'Energy',
    city: 'Wapakoneta',
    kind: 'energy',
    dependencies: true,
  },
  {
    prefix: 'CFM',
    cpSite: 'Celina Feed Mill',
    cpDivision: 'Feed Mill',
    city: 'Celina',
    kind: 'feed',
    dependencies: true,
  },
  {
    prefix: 'MPS',
    cpSite: 'MPS Feed - St. Marys',
    cpDivision: 'MPS',
    city: 'St. Marys',
    kind: 'feed',
    dependencies: true,
  },
  {
    prefix: 'HFS',
    cpSite: 'Heartland Feed Services',
    cpDivision: 'Heartland',
    city: '',
    kind: 'feed',
    dependencies: false,
  },
  // Not in the seed list → exercises site auto-creation.
  {
    prefix: 'SPV',
    cpSite: 'Spencerville',
    cpDivision: 'Grain',
    city: 'Spencerville',
    kind: 'grain',
    dependencies: false,
  },
];

export const STATUS_NAMES: Record<number, string> = {
  0: 'Unknown',
  1: 'Up',
  2: 'Down',
  3: 'Warning',
  4: 'Shutdown',
  9: 'Unmanaged',
  12: 'Unreachable',
  14: 'Critical',
  17: 'Could Not Poll',
};

export const ALERT_DEFS = {
  nodeDown: { AlertID: 1, Name: 'Node is down', Severity: 2, ObjectType: 'Node' },
  highCpu: { AlertID: 2, Name: 'High CPU load', Severity: 1, ObjectType: 'Node' },
  interfaceDown: { AlertID: 3, Name: 'Interface is down', Severity: 1, ObjectType: 'Interface' },
  highUtil: {
    AlertID: 4,
    Name: 'High interface utilization',
    Severity: 1,
    ObjectType: 'Interface',
  },
  upsOnBattery: { AlertID: 5, Name: 'UPS on battery', Severity: 3, ObjectType: 'Node' },
  highResponse: { AlertID: 6, Name: 'High response time', Severity: 1, ObjectType: 'Node' },
  ifErrors: {
    AlertID: 7,
    Name: 'Interface errors and discards',
    Severity: 4,
    ObjectType: 'Interface',
  },
} as const;
export type AlertKey = keyof typeof ALERT_DEFS;

export const EVENT_TYPES: Record<number, string> = {
  1: 'Node Down',
  5: 'Node Up',
  10: 'Interface Down',
  11: 'Interface Up',
  14: 'Node Unreachable',
  20: 'Alert Triggered',
  21: 'Alert Reset',
};

const HOST = 'orion.mock.local';
export const nodeUri = (id: number) => `swis://${HOST}/Orion/Orion.Nodes/NodeID=${id}`;
export const ifaceUri = (nodeId: number, id: number) =>
  `${nodeUri(nodeId)}/Interfaces/InterfaceID=${id}`;
export const groupUri = (id: number) => `swis://${HOST}/Orion/Orion.Groups/ContainerID=${id}`;

/** SWIS-like naive UTC timestamp with 7 fractional digits ("2026-11-16T15:25:28.6520000"). */
export function swisTime(d: Date, withZ = false): string {
  return d.toISOString().replace(/\.(\d{3})Z$/, (_, ms: string) => `.${ms}0000${withZ ? 'Z' : ''}`);
}

interface DeviceTemplate {
  suffix: string;
  vendor: string;
  machineType: string;
  isServer?: boolean;
  ifaces: string[];
  role: string;
}

function devicesFor(site: MockSite): DeviceTemplate[] {
  const fw: DeviceTemplate = {
    suffix: 'FW01',
    vendor: 'Fortinet',
    machineType: site.kind === 'hq' ? 'Fortinet FortiGate 100F' : 'Fortinet FortiGate 60F',
    ifaces: ['wan1', 'wan2', 'internal1'],
    role: 'firewall',
  };
  const ups: DeviceTemplate = {
    suffix: 'UPS01',
    vendor: 'CyberPower Systems',
    machineType: 'CyberPower OR1500LCDRM1U',
    ifaces: ['eth0'],
    role: 'ups',
  };
  const ap = (n: number): DeviceTemplate => ({
    suffix: `AP0${n}`,
    vendor: 'Ubiquiti Networks',
    machineType: 'UniFi U6-LR',
    ifaces: ['eth0'],
    role: 'access_point',
  });
  switch (site.kind) {
    case 'hq':
      return [
        fw,
        {
          suffix: 'CORE01',
          vendor: 'Cisco',
          machineType: 'Cisco Catalyst 9300-48P',
          ifaces: ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Gi1/0/4', 'Te1/1/1'],
          role: 'core_switch',
        },
        {
          suffix: 'SW02',
          vendor: 'Cisco',
          machineType: 'Cisco Catalyst 2960X-48',
          ifaces: ['Gi1/0/1', 'Gi1/0/48'],
          role: 'switch',
        },
        {
          suffix: 'DC01',
          vendor: 'Microsoft',
          machineType: 'Windows Server 2022 Standard',
          isServer: true,
          ifaces: ['Ethernet0'],
          role: 'server',
        },
        {
          suffix: 'SQL01',
          vendor: 'Microsoft',
          machineType: 'Windows Server 2022 Standard',
          isServer: true,
          ifaces: ['Ethernet0'],
          role: 'server',
        },
        {
          suffix: 'APP01',
          vendor: 'net-snmp',
          machineType: 'Linux Ubuntu 22.04',
          isServer: true,
          ifaces: ['ens160'],
          role: 'server',
        },
        ap(1),
        ap(2),
        ap(3),
        ups,
      ];
    case 'grain':
      return [
        fw,
        {
          suffix: 'SW01',
          vendor: 'MikroTik',
          machineType: 'MikroTik CRS326-24G-2S+',
          ifaces: ['ether1', 'ether2', 'ether3', 'sfp-plus1'],
          role: 'switch',
        },
        {
          suffix: 'SCALE01',
          vendor: 'Microsoft',
          machineType: 'Windows 10 Pro',
          ifaces: ['Ethernet'],
          role: 'scale_system',
        },
        {
          suffix: 'SCALE02',
          vendor: 'Microsoft',
          machineType: 'Windows 10 Pro',
          ifaces: ['Ethernet'],
          role: 'scale_system',
        },
        ap(1),
        ap(2),
        ups,
      ];
    case 'feed':
      return [
        fw,
        {
          suffix: 'SW01',
          vendor: 'Cisco',
          machineType: 'Cisco Catalyst 2960X-24',
          ifaces: ['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/24'],
          role: 'switch',
        },
        {
          suffix: 'BATCH01',
          vendor: 'Microsoft',
          machineType: 'Windows Server 2019 Standard',
          isServer: true,
          ifaces: ['Ethernet0'],
          role: 'server',
        },
        ap(1),
        ups,
      ];
    default:
      return [
        fw,
        {
          suffix: 'RTR01',
          vendor: 'MikroTik',
          machineType: 'MikroTik RouterBOARD hEX',
          ifaces: ['ether1', 'ether2'],
          role: 'router',
        },
        ap(1),
        ups,
      ];
  }
}

export interface World {
  nodes: Rec[];
  customProps: Rec[];
  interfaces: Rec[];
  topology: Rec[];
  dependencies: Rec[];
  groups: Rec[];
  groupMembers: Rec[];
  alertConfigs: Rec[];
  alertObjects: Rec[];
  alertActive: Rec[];
  events: Rec[];
  alertHistory: Rec[];
  statusInfo: Rec[];
  eventTypes: Rec[];
  customPropertyDefs: Rec[];
  engines: Rec[];
  seq: { alertActive: number; alertObject: number; event: number; history: number };
  /** Site prefix → node IDs (FW first). */
  siteNodes: Map<string, number[]>;
  roleOf: Map<number, string>;
}

/** Build the world. `now` is injected so tests are deterministic. */
export function buildWorld(now = new Date()): World {
  const w: World = {
    nodes: [],
    customProps: [],
    interfaces: [],
    topology: [],
    dependencies: [],
    groups: [],
    groupMembers: [],
    alertConfigs: Object.values(ALERT_DEFS).map((d) => ({
      ...d,
      AlertRefID: `00000000-0000-0000-0000-00000000000${d.AlertID}`,
      Description: `Mock: ${d.Name}`,
      Enabled: true,
    })),
    alertObjects: [],
    alertActive: [],
    events: [],
    alertHistory: [],
    statusInfo: Object.entries(STATUS_NAMES).map(([id, name]) => ({
      StatusId: Number(id),
      StatusName: name,
    })),
    eventTypes: Object.entries(EVENT_TYPES).map(([id, name]) => ({
      EventType: Number(id),
      Name: name,
    })),
    customPropertyDefs: ['Site', 'Division', 'City', 'Comments'].map((f) => ({
      Field: f,
      DataType: 'nvarchar',
      Description: `Mock ${f}`,
      TargetEntity: 'Orion.NodesCustomProperties',
    })),
    engines: [{ EngineID: 1, ServerName: 'ORION01' }],
    seq: { alertActive: 1000, alertObject: 500, event: 10_000, history: 20_000 },
    siteNodes: new Map(),
    roleOf: new Map(),
  };
  let nodeId = 100;
  let ifaceId = 1000;
  let containerId = 1;
  let depId = 1;
  const boot = new Date(now.getTime() - 21 * 86_400_000);

  MOCK_SITES.forEach((site, siteIdx) => {
    const ids: number[] = [];
    const ifacesByNode = new Map<number, number[]>();
    devicesFor(site).forEach((d, devIdx) => {
      const id = nodeId++;
      ids.push(id);
      w.roleOf.set(id, d.role);
      const caption = `${site.prefix}-${d.suffix}`;
      w.nodes.push({
        NodeID: id,
        Caption: caption,
        DNS: `${caption.toLowerCase()}.mercer.local`,
        SysName: caption,
        IPAddress: `10.${20 + siteIdx}.0.${devIdx + 1}`,
        Status: 1,
        StatusDescription: 'Node status is Up.',
        ResponseTime: 8 + ((id * 7) % 25),
        PercentLoss: 0,
        CPULoad: 5 + ((id * 13) % 30),
        PercentMemoryUsed: 30 + ((id * 11) % 40),
        Vendor: d.vendor,
        MachineType: d.machineType,
        LastBoot: swisTime(boot),
        Unmanaged: false,
        ObjectSubType: d.isServer ? 'Agent' : 'SNMP',
        Location: site.city,
        IsServer: !!d.isServer,
        Uri: nodeUri(id),
      });
      w.customProps.push({
        NodeID: id,
        Site: site.cpSite || null,
        Division: site.cpDivision || null,
        City: site.city || null,
        Comments: null,
        InstanceType: 'Orion.NodesCustomProperties',
        Uri: `${nodeUri(id)}/CustomProperties`,
      });
      const myIfaces: number[] = [];
      d.ifaces.forEach((name, i) => {
        const iid = ifaceId++;
        myIfaces.push(iid);
        const isWan = d.role === 'firewall' && name.startsWith('wan');
        w.interfaces.push({
          InterfaceID: iid,
          NodeID: id,
          Name: name,
          Caption: `${caption} · ${name}`,
          FullName: `${caption} - ${name}`,
          Alias: isWan ? 'ISP circuit' : i === d.ifaces.length - 1 ? 'uplink' : null,
          TypeDescription: 'Ethernet',
          Status: name === 'wan2' ? 2 : 1, // wan2 unused/down by design (realistic noise source)
          OperStatus: name === 'wan2' ? 2 : 1,
          AdminStatus: 1,
          InPercentUtil: isWan ? 18 + (iid % 20) : (iid * 3) % 15,
          OutPercentUtil: isWan ? 9 + (iid % 10) : (iid * 5) % 12,
          Inbps: 1e6 * (1 + (iid % 50)),
          Outbps: 5e5 * (1 + (iid % 40)),
          Speed: isWan ? 1e8 : 1e9,
          InErrorsThisHour: 0,
          OutErrorsThisHour: 0,
          InDiscardsThisHour: 0,
          OutDiscardsThisHour: 0,
          UnManaged: false,
          Uri: ifaceUri(id, iid),
        });
      });
      ifacesByNode.set(id, myIfaces);
    });
    w.siteNodes.set(site.prefix, ids);

    // Topology: switch/router uplink ↔ FW internal; other devices ↔ switch ports.
    const [fwId, swId, ...rest] = ids as [number, number, ...number[]];
    const fwIfaces = ifacesByNode.get(fwId)!;
    const swIfaces = ifacesByNode.get(swId)!;
    w.topology.push({
      SrcNodeID: swId,
      SrcInterfaceID: swIfaces.at(-1)!,
      DestNodeID: fwId,
      DestInterfaceID: fwIfaces.at(-1)!,
      LayerType: 'L2',
    });
    rest.forEach((child, i) => {
      w.topology.push({
        SrcNodeID: child,
        SrcInterfaceID: ifacesByNode.get(child)![0]!,
        DestNodeID: swId,
        DestInterfaceID: swIfaces[i % Math.max(1, swIfaces.length - 1)]!,
        LayerType: 'L2',
      });
    });

    // Group per site, named after the site as an admin would; dependency FW → group where configured.
    const cid = containerId++;
    const siteName = SITE_GROUP_NAMES[site.prefix] ?? (site.cpSite || site.city || site.prefix);
    w.groups.push({
      ContainerID: cid,
      Name: `Site - ${siteName}`,
      Status: 1,
      Description: `All nodes at ${siteName}`,
      Uri: groupUri(cid),
    });
    ids.slice(1).forEach((id) => {
      w.groupMembers.push({
        ContainerID: cid,
        MemberUri: nodeUri(id),
        MemberPrimaryID: id,
        MemberEntityType: 'Orion.Nodes',
        Name: w.nodes.find((n) => n.NodeID === id)!.Caption,
        Status: 1,
      });
    });
    if (site.dependencies) {
      w.dependencies.push({
        DependencyId: depId++,
        Name: `${site.prefix} WAN edge → site`,
        ParentUri: nodeUri(fwId),
        ChildUri: groupUri(cid),
        AutoManaged: false,
        ParentEntityType: 'Orion.Nodes',
        ChildEntityType: 'Orion.Groups',
      });
    }
  });

  // Baseline noise: the unused wan2 ports have a standing "Interface is down" alert.
  for (const i of w.interfaces.filter((x) => x.Name === 'wan2').slice(0, 3)) {
    raiseAlert(
      w,
      'interfaceDown',
      {
        uri: String(i.Uri),
        type: 'Orion.NPM.Interfaces',
        caption: String(i.Caption),
        nodeId: Number(i.NodeID),
      },
      new Date(now.getTime() - 3 * 86_400_000),
    );
  }
  return w;
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

export interface AlertTarget {
  uri: string;
  type: string;
  caption: string;
  nodeId: number;
}

function nodeRec(w: World, id: number): Rec {
  const n = w.nodes.find((x) => x.NodeID === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

export function nodeTarget(w: World, nodeId: number): AlertTarget {
  const n = nodeRec(w, nodeId);
  return { uri: String(n.Uri), type: 'Orion.Nodes', caption: String(n.Caption), nodeId };
}

export function addEvent(
  w: World,
  type: number,
  message: string,
  nodeId: number | null,
  netObject: string | null,
  at: Date,
): void {
  w.events.push({
    EventID: ++w.seq.event,
    EventTime: swisTime(at),
    EventType: type,
    Message: message,
    NetworkNode: nodeId ?? 0,
    NetObjectID: netObject,
    NetObjectType: netObject?.startsWith('I:') ? 'I' : 'N',
    Acknowledged: false,
  });
}

/** Raise (or re-raise) an alert. Returns the AlertActiveID, or null if already active. */
export function raiseAlert(
  w: World,
  key: AlertKey,
  target: AlertTarget,
  at: Date,
  message?: string,
): number | null {
  const def = ALERT_DEFS[key];
  let obj = w.alertObjects.find((o) => o.AlertID === def.AlertID && o.EntityUri === target.uri);
  if (obj && w.alertActive.some((a) => a.AlertObjectID === obj!.AlertObjectID)) return null;
  if (!obj) {
    obj = {
      AlertObjectID: ++w.seq.alertObject,
      AlertID: def.AlertID,
      EntityUri: target.uri,
      EntityType: target.type,
      EntityCaption: target.caption,
      RelatedNodeId: target.nodeId,
      RelatedNodeUri: nodeUri(target.nodeId),
      RelatedNodeCaption: String(nodeRec(w, target.nodeId).Caption),
      TriggeredCount: 0,
      LastTriggeredDateTime: null,
    };
    w.alertObjects.push(obj);
  }
  obj.TriggeredCount = Number(obj.TriggeredCount) + 1;
  obj.LastTriggeredDateTime = swisTime(at);
  const id = ++w.seq.alertActive;
  const text = message ?? `${def.Name}: ${target.caption}`;
  w.alertActive.push({
    AlertActiveID: id,
    AlertObjectID: obj.AlertObjectID,
    TriggeredDateTime: swisTime(at),
    TriggeredMessage: text,
    Acknowledged: false,
    AcknowledgedBy: null,
    AcknowledgedDateTime: null,
    AcknowledgedNote: null,
  });
  w.alertHistory.push({
    AlertHistoryID: ++w.seq.history,
    EventType: 0,
    TimeStamp: swisTime(at),
    Message: text,
    AccountID: null,
    AlertActiveID: id,
    AlertObjectID: obj.AlertObjectID,
  });
  addEvent(w, 20, `Alert triggered: ${text}`, target.nodeId, null, at);
  return id;
}

export function clearAlert(w: World, key: AlertKey, uri: string, at: Date): boolean {
  const def = ALERT_DEFS[key];
  const obj = w.alertObjects.find((o) => o.AlertID === def.AlertID && o.EntityUri === uri);
  if (!obj) return false;
  const idx = w.alertActive.findIndex((a) => a.AlertObjectID === obj.AlertObjectID);
  if (idx < 0) return false;
  const [a] = w.alertActive.splice(idx, 1);
  w.alertHistory.push({
    AlertHistoryID: ++w.seq.history,
    EventType: 1,
    TimeStamp: swisTime(at),
    Message: `Reset: ${def.Name}`,
    AccountID: null,
    AlertActiveID: a!.AlertActiveID,
    AlertObjectID: obj.AlertObjectID,
  });
  addEvent(
    w,
    21,
    `Alert reset: ${def.Name} on ${String(obj.EntityCaption)}`,
    Number(obj.RelatedNodeId),
    null,
    at,
  );
  return true;
}

/** Acknowledge by AlertObjectID (the real Orion.AlertActive.Acknowledge contract). */
export function acknowledge(
  w: World,
  alertObjectIds: number[],
  note: string,
  at: Date,
  by = 'mas-writeback',
): number {
  let n = 0;
  for (const a of w.alertActive) {
    if (alertObjectIds.includes(Number(a.AlertObjectID)) && !a.Acknowledged) {
      a.Acknowledged = true;
      a.AcknowledgedBy = by;
      a.AcknowledgedDateTime = swisTime(at);
      a.AcknowledgedNote = note;
      w.alertHistory.push({
        AlertHistoryID: ++w.seq.history,
        EventType: 2,
        TimeStamp: swisTime(at),
        Message: note,
        AccountID: by,
        AlertActiveID: a.AlertActiveID,
        AlertObjectID: a.AlertObjectID,
      });
      n++;
    }
  }
  return n;
}

/** Orion.AlertActive.AppendNote: a note on each active alert, kept in the alert history. */
export function appendNote(
  w: World,
  alertObjectIds: number[],
  note: string,
  at: Date,
  by = 'mas-writeback',
): number {
  let n = 0;
  for (const a of w.alertActive) {
    if (!alertObjectIds.includes(Number(a.AlertObjectID))) continue;
    a.NumberOfNotes = Number(a.NumberOfNotes ?? 0) + 1;
    w.alertHistory.push({
      AlertHistoryID: ++w.seq.history,
      EventType: 3,
      TimeStamp: swisTime(at),
      Message: note,
      AccountID: by,
      AlertActiveID: a.AlertActiveID,
      AlertObjectID: a.AlertObjectID,
    });
    n++;
  }
  return n;
}

/** SWIS update on a group URI: only Name and Description, like the properties MAS writes. */
export function updateGroup(
  w: World,
  containerId: number,
  props: Record<string, unknown>,
): boolean {
  const g = w.groups.find((x) => Number(x.ContainerID) === containerId);
  if (!g) return false;
  for (const k of ['Name', 'Description'] as const)
    if (k in props) g[k] = props[k] === null ? null : String(props[k]);
  return true;
}

/** Set a node's status, raising/clearing "Node is down" and emitting events like Orion. */
export function setNodeStatus(
  w: World,
  nodeId: number,
  status: number,
  at: Date,
  opts: { alert?: boolean } = {},
): void {
  const n = nodeRec(w, nodeId);
  const prev = Number(n.Status);
  if (prev === status) return;
  n.Status = status;
  n.StatusDescription = `Node status is ${STATUS_NAMES[status] ?? status}.`;
  const down = status === 2;
  n.ResponseTime = down || status === 12 ? -1 : 10;
  n.PercentLoss = down || status === 12 ? 100 : 0;
  for (const i of w.interfaces.filter((x) => x.NodeID === nodeId && x.Name !== 'wan2')) {
    i.Status = status === 1 ? 1 : status === 12 ? 12 : 0;
  }
  if (status === 2) {
    addEvent(w, 1, `${String(n.Caption)} is Down.`, nodeId, `N:${nodeId}`, at);
    if (opts.alert !== false)
      raiseAlert(w, 'nodeDown', nodeTarget(w, nodeId), at, `${String(n.Caption)} is down.`);
  } else if (status === 12) {
    addEvent(w, 14, `${String(n.Caption)} is Unreachable.`, nodeId, `N:${nodeId}`, at);
  } else if (status === 1) {
    addEvent(w, 5, `${String(n.Caption)} is Up.`, nodeId, `N:${nodeId}`, at);
    clearAlert(w, 'nodeDown', String(n.Uri), at);
  }
}

export function setInterfaceUtil(
  w: World,
  interfaceId: number,
  inPct: number,
  outPct: number,
): void {
  const i = w.interfaces.find((x) => x.InterfaceID === interfaceId);
  if (!i) throw new Error(`no interface ${interfaceId}`);
  i.InPercentUtil = inPct;
  i.OutPercentUtil = outPct;
  i.Inbps = (Number(i.Speed) * inPct) / 100;
  i.Outbps = (Number(i.Speed) * outPct) / 100;
}

export function findNodeByCaption(w: World, caption: string): Rec | undefined {
  return w.nodes.find((n) => String(n.Caption).toLowerCase() === caption.toLowerCase());
}
