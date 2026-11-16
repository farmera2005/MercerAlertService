/**
 * Synthetic storm scenarios. Each scenario is a list of timed steps so it can run either in
 * real time inside the mock server (scaled by `speed`) or step-by-step on a virtual clock
 * (the M2 simulator).
 */
import {
  clearAlert,
  findNodeByCaption,
  nodeTarget,
  raiseAlert,
  setInterfaceUtil,
  setNodeStatus,
  type AlertKey,
  type AlertTarget,
  type World,
} from './world';

export type OutageMode = 'none' | '503' | 'timeout' | 'auth';

export interface ScenarioEnv {
  world: World;
  setOutage(mode: OutageMode): void;
}

export interface ScenarioStep {
  atSec: number;
  label: string;
  apply(env: ScenarioEnv, at: Date): void;
}

export interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

type Params = Record<string, unknown>;

const str = (p: Params, k: string, d: string) => (typeof p[k] === 'string' ? (p[k] as string) : d);
const num = (p: Params, k: string, d: number) => (p[k] === undefined ? d : Number(p[k]));

function siteNodeIds(w: World, prefix: string): number[] {
  const ids = w.siteNodes.get(prefix.toUpperCase());
  if (!ids)
    throw new Error(`unknown site prefix ${prefix} (known: ${[...w.siteNodes.keys()].join(', ')})`);
  return ids;
}

function siteHasDependency(w: World, fwId: number): boolean {
  return w.dependencies.some((d) => String(d.ParentUri).endsWith(`NodeID=${fwId}`));
}

function ifaceTarget(w: World, interfaceId: number): AlertTarget {
  const i = w.interfaces.find((x) => x.InterfaceID === interfaceId)!;
  return {
    uri: String(i.Uri),
    type: 'Orion.NPM.Interfaces',
    caption: String(i.Caption),
    nodeId: Number(i.NodeID),
  };
}

/** Site WAN edge down + N child alerts (default 30), optional recovery. */
function siteWanDown(p: Params): Scenario {
  const prefix = str(p, 'site', 'ROCK');
  const childAlerts = num(p, 'childAlerts', 30);
  const recoverAfter = num(p, 'recoverAfterSec', 0);
  const raised: Array<[AlertKey, string]> = [];
  const steps: ScenarioStep[] = [
    {
      atSec: 0,
      label: `${prefix} FortiGate down`,
      apply: ({ world }, at) => {
        const [fw] = siteNodeIds(world, prefix);
        setNodeStatus(world, fw!, 2, at);
      },
    },
    {
      atSec: 20,
      label: `${prefix} children unreachable + ${childAlerts} child alerts`,
      apply: ({ world }, at) => {
        const [fw, ...children] = siteNodeIds(world, prefix);
        const deps = siteHasDependency(world, fw!);
        for (const c of children) setNodeStatus(world, c, deps ? 12 : 2, at, { alert: false });
        const ifaces = world.interfaces
          .filter((i) => [fw, ...children].includes(Number(i.NodeID)) && i.Name !== 'wan2')
          .map((i) => Number(i.InterfaceID));
        const targets: Array<[AlertKey, AlertTarget]> = [
          ...children.map((c) => ['nodeDown', nodeTarget(world, c)] as [AlertKey, AlertTarget]),
          ...ifaces.map((i) => ['interfaceDown', ifaceTarget(world, i)] as [AlertKey, AlertTarget]),
          ...children.map((c) => ['highResponse', nodeTarget(world, c)] as [AlertKey, AlertTarget]),
          ...ifaces.map((i) => ['ifErrors', ifaceTarget(world, i)] as [AlertKey, AlertTarget]),
        ];
        for (const [key, t] of targets.slice(0, childAlerts)) {
          if (raiseAlert(world, key, t, at) !== null) raised.push([key, t.uri]);
        }
      },
    },
  ];
  if (recoverAfter > 0) {
    steps.push({
      atSec: 20 + recoverAfter,
      label: `${prefix} recovered`,
      apply: ({ world }, at) => {
        for (const id of siteNodeIds(world, prefix)) setNodeStatus(world, id, 1, at);
        for (const [key, uri] of raised.splice(0)) clearAlert(world, key, uri, at);
      },
    });
  }
  return {
    name: 'site-wan-down',
    description: `WAN edge at ${prefix} down with ${childAlerts} child alerts`,
    steps,
  };
}

/** An access point bouncing up/down. */
function flappingAp(p: Params): Scenario {
  const caption = str(p, 'node', 'ROCK-AP01');
  const flaps = num(p, 'flaps', 6);
  const period = num(p, 'periodSec', 60);
  const steps: ScenarioStep[] = [];
  for (let i = 0; i < flaps; i++) {
    steps.push({
      atSec: i * period,
      label: `${caption} down (${i + 1}/${flaps})`,
      apply: ({ world }, at) =>
        setNodeStatus(world, Number(findNodeByCaption(world, caption)!.NodeID), 2, at),
    });
    steps.push({
      atSec: i * period + period / 2,
      label: `${caption} up (${i + 1}/${flaps})`,
      apply: ({ world }, at) =>
        setNodeStatus(world, Number(findNodeByCaption(world, caption)!.NodeID), 1, at),
    });
  }
  return { name: 'flapping-ap', description: `${caption} flaps ${flaps}× every ${period}s`, steps };
}

/** UPS on battery at a (grain) site. */
function upsOnBattery(p: Params): Scenario {
  const prefix = str(p, 'site', 'COLD');
  const recoverAfter = num(p, 'recoverAfterSec', 0);
  const ups = () => `${prefix.toUpperCase()}-UPS01`;
  const steps: ScenarioStep[] = [
    {
      atSec: 0,
      label: `${ups()} on battery`,
      apply: ({ world }, at) => {
        const n = findNodeByCaption(world, ups())!;
        raiseAlert(
          world,
          'upsOnBattery',
          nodeTarget(world, Number(n.NodeID)),
          at,
          `${ups()}: utility power lost, running on battery (est. 38 min).`,
        );
      },
    },
  ];
  if (recoverAfter > 0) {
    steps.push({
      atSec: recoverAfter,
      label: `${ups()} back on utility power`,
      apply: ({ world }, at) => {
        const n = findNodeByCaption(world, ups())!;
        clearAlert(world, 'upsOnBattery', String(n.Uri), at);
      },
    });
  }
  return { name: 'ups-on-battery', description: `UPS on battery at ${prefix}`, steps };
}

/** Slow-burn WAN saturation; "High interface utilization" fires once ≥ 90 %. */
function interfaceSaturation(p: Params): Scenario {
  const caption = str(p, 'node', 'CEL-FW01');
  const ifName = str(p, 'iface', 'wan1');
  const from = num(p, 'fromPct', 60);
  const to = num(p, 'toPct', 98);
  const duration = num(p, 'durationSec', 1800);
  const count = Math.max(2, num(p, 'steps', 10));
  const steps: ScenarioStep[] = [];
  for (let i = 0; i < count; i++) {
    const pct = from + ((to - from) * i) / (count - 1);
    steps.push({
      atSec: (duration * i) / (count - 1),
      label: `${caption} ${ifName} → ${pct.toFixed(0)}%`,
      apply: ({ world }, at) => {
        const node = findNodeByCaption(world, caption)!;
        const iface = world.interfaces.find((x) => x.NodeID === node.NodeID && x.Name === ifName)!;
        setInterfaceUtil(world, Number(iface.InterfaceID), pct, pct * 0.4);
        if (pct >= 90)
          raiseAlert(
            world,
            'highUtil',
            ifaceTarget(world, Number(iface.InterfaceID)),
            at,
            `${String(iface.Caption)} receive utilization ${pct.toFixed(0)}%`,
          );
      },
    });
  }
  return {
    name: 'interface-saturation',
    description: `${caption} ${ifName} ramps ${from}%→${to}%`,
    steps,
  };
}

/** SWIS itself becomes unavailable. */
function swisDown(p: Params): Scenario {
  const mode = str(p, 'mode', '503') as OutageMode;
  const duration = num(p, 'durationSec', 300);
  const steps: ScenarioStep[] = [
    { atSec: 0, label: `SWIS outage (${mode})`, apply: (env) => env.setOutage(mode) },
  ];
  if (duration > 0)
    steps.push({ atSec: duration, label: 'SWIS restored', apply: (env) => env.setOutage('none') });
  return { name: 'swis-down', description: `SWIS unavailable (${mode}) for ${duration}s`, steps };
}

export const SCENARIOS: Record<string, (p: Params) => Scenario> = {
  'site-wan-down': siteWanDown,
  'flapping-ap': flappingAp,
  'ups-on-battery': upsOnBattery,
  'interface-saturation': interfaceSaturation,
  'swis-down': swisDown,
};

export function buildScenario(name: string, params: Params = {}): Scenario {
  const factory = SCENARIOS[name];
  if (!factory)
    throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  return factory(params);
}
