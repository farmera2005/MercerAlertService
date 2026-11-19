/**
 * A deliberately small SWQL interpreter — enough for MAS's query catalog and discovery:
 * SELECT [TOP n] <alias.Prop AS X | COUNT(..) | MAX(..) | GETUTCDATE()>, FROM with INNER/LEFT
 * JOIN ... ON a.X = b.Y, WHERE (=, >, IN, AND), GROUP BY, ORDER BY [DESC], WITH ROWS a TO b.
 * Unknown properties fail with a SWIS-style 400, like the real server.
 */
import type { Rec, World } from './world';

export class SwqlError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface EntityTable {
  rows: () => Rec[];
  /** Property names (case preserved). */
  props: () => string[];
}

export function entityTables(w: World, dropFields: Set<string>): Map<string, EntityTable> {
  const t =
    (rows: () => Rec[], explicit?: string[]) =>
    (name: string): EntityTable => ({
      rows,
      props: () => {
        const base = explicit ?? Object.keys(rows()[0] ?? {});
        return base.filter((p) => !dropFields.has(`${name}.${p}`.toLowerCase()));
      },
    });
  const defs: Array<[string, (n: string) => EntityTable]> = [
    ['Orion.Nodes', t(() => w.nodes)],
    [
      'Orion.NodesCustomProperties',
      t(
        () => w.customProps,
        ['NodeID', 'Site', 'Division', 'City', 'Comments', 'InstanceType', 'Uri'],
      ),
    ],
    ['Orion.NPM.Interfaces', t(() => w.interfaces)],
    [
      'Orion.TopologyConnections',
      t(
        () => w.topology,
        ['SrcNodeID', 'SrcInterfaceID', 'DestNodeID', 'DestInterfaceID', 'LayerType'],
      ),
    ],
    [
      'Orion.Dependencies',
      t(
        () => w.dependencies,
        [
          'DependencyId',
          'Name',
          'ParentUri',
          'ChildUri',
          'AutoManaged',
          'ParentEntityType',
          'ChildEntityType',
        ],
      ),
    ],
    ['Orion.Container', t(() => w.groups, ['ContainerID', 'Name', 'Status', 'Description', 'Uri'])],
    [
      'Orion.ContainerMembers',
      t(
        () => w.groupMembers,
        ['ContainerID', 'MemberUri', 'MemberPrimaryID', 'MemberEntityType', 'Name', 'Status'],
      ),
    ],
    ['Orion.AlertConfigurations', t(() => w.alertConfigs)],
    [
      'Orion.AlertObjects',
      t(
        () => w.alertObjects,
        [
          'AlertObjectID',
          'AlertID',
          'EntityUri',
          'EntityType',
          'EntityCaption',
          'RelatedNodeId',
          'RelatedNodeUri',
          'RelatedNodeCaption',
          'TriggeredCount',
          'LastTriggeredDateTime',
        ],
      ),
    ],
    [
      'Orion.AlertActive',
      t(
        () => w.alertActive,
        [
          'AlertActiveID',
          'AlertObjectID',
          'TriggeredDateTime',
          'TriggeredMessage',
          'Acknowledged',
          'AcknowledgedBy',
          'AcknowledgedDateTime',
          'AcknowledgedNote',
        ],
      ),
    ],
    [
      'Orion.Events',
      t(
        () => w.events,
        [
          'EventID',
          'EventTime',
          'EventType',
          'Message',
          'NetworkNode',
          'NetObjectID',
          'NetObjectType',
          'Acknowledged',
        ],
      ),
    ],
    ['Orion.EventTypes', t(() => w.eventTypes, ['EventType', 'Name'])],
    [
      'Orion.AlertHistory',
      t(
        () => w.alertHistory,
        [
          'AlertHistoryID',
          'EventType',
          'TimeStamp',
          'Message',
          'AccountID',
          'AlertActiveID',
          'AlertObjectID',
        ],
      ),
    ],
    ['Orion.StatusInfo', t(() => w.statusInfo, ['StatusId', 'StatusName'])],
    [
      'Orion.CustomProperty',
      t(() => w.customPropertyDefs, ['Field', 'DataType', 'Description', 'TargetEntity']),
    ],
    ['Orion.Engines', t(() => w.engines, ['EngineID', 'ServerName'])],
  ];
  const map = new Map<string, EntityTable>();
  for (const [name, mk] of defs) map.set(name.toLowerCase(), mk(name));

  // Metadata entities describe the tables above.
  const describe = () =>
    defs.flatMap(([full]) =>
      map
        .get(full.toLowerCase())!
        .props()
        .map((p) => ({ EntityName: full, Name: p, Type: 'System.String', IsNullable: true })),
    );
  map.set('metadata.property', {
    rows: describe,
    props: () => ['EntityName', 'Name', 'Type', 'IsNullable'],
  });
  map.set('metadata.entity', {
    rows: () =>
      defs.map(([n]) => ({
        FullName: n,
        Namespace: n.split('.').slice(0, -1).join('.'),
        // Like Orion: group properties (e.g. Description) can be written with SWIS update.
        CanUpdate: n === 'Orion.Container',
      })),
    props: () => ['FullName', 'Namespace', 'CanUpdate'],
  });
  map.set('metadata.verbargument', {
    rows: () => [
      {
        EntityName: 'Orion.AlertActive',
        VerbName: 'Acknowledge',
        Position: 0,
        Name: 'alertObjectIds',
        Type: 'System.Int32[]',
      },
      {
        EntityName: 'Orion.AlertActive',
        VerbName: 'Acknowledge',
        Position: 1,
        Name: 'notes',
        Type: 'System.String',
      },
      {
        EntityName: 'Orion.AlertActive',
        VerbName: 'AppendNote',
        Position: 0,
        Name: 'alertObjectIds',
        Type: 'System.Int32[]',
      },
      {
        EntityName: 'Orion.AlertActive',
        VerbName: 'AppendNote',
        Position: 1,
        Name: 'note',
        Type: 'System.String',
      },
    ],
    props: () => ['EntityName', 'VerbName', 'Position', 'Name', 'Type'],
  });
  return map;
}

// ---------------------------------------------------------------------------------------------

interface SelectItem {
  kind: 'prop' | 'count' | 'max' | 'func';
  alias?: string;
  prop?: string;
  func?: string;
  as: string;
}

function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSelectItem(raw: string): SelectItem {
  const m = /^(.*?)\s+AS\s+(\w+)$/i.exec(raw);
  const expr = (m ? m[1]! : raw).trim();
  const as = m ? m[2]! : expr.split('.').pop()!;
  let x: RegExpExecArray | null;
  if ((x = /^COUNT\(\s*(\w+)\.(\w+)\s*\)$/i.exec(expr)))
    return { kind: 'count', alias: x[1], prop: x[2], as };
  if ((x = /^MAX\(\s*(\w+)\.(\w+)\s*\)$/i.exec(expr)))
    return { kind: 'max', alias: x[1], prop: x[2], as };
  if ((x = /^(GETUTCDATE|GETDATE)\(\s*\)$/i.exec(expr)))
    return { kind: 'func', func: x[1]!.toUpperCase(), as };
  if ((x = /^(\w+)\.(\w+)$/.exec(expr))) return { kind: 'prop', alias: x[1], prop: x[2], as };
  throw new SwqlError(`mock-swis: unsupported select expression "${expr}"`);
}

type Ctx = Record<string, Rec>;

function getProp(rec: Rec | undefined, prop: string): unknown {
  if (!rec) return null;
  if (prop in rec) return rec[prop] ?? null;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === prop.toLowerCase());
  return key ? (rec[key] ?? null) : null;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export interface ExecOptions {
  utcNow: Date;
}

/** Execute SWQL against the mock tables. */
export function executeSwql(
  sql: string,
  params: Record<string, unknown>,
  tables: Map<string, EntityTable>,
  opts: ExecOptions,
): Rec[] {
  const q = sql.replace(/\s+/g, ' ').trim();
  const m =
    /^SELECT\s+(?:TOP\s+(\d+)\s+)?(.+?)\s+FROM\s+(.+?)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP BY\s+(.+?))?(?:\s+ORDER BY\s+(.+?))?(?:\s+WITH ROWS\s+(\d+)\s+TO\s+(\d+))?$/i.exec(
      q,
    );
  if (!m) throw new SwqlError(`mock-swis: cannot parse query: ${q.slice(0, 200)}`);
  const [, top, selectPart, fromPart, wherePart, groupPart, orderPart, rowsFrom, rowsTo] = m;

  // FROM + JOINs
  const joinRe = /\s+(INNER|LEFT)\s+JOIN\s+/i;
  const segments = fromPart!.split(joinRe);
  const [baseEntity, baseAlias] = segments[0]!.trim().split(/\s+/);
  const aliases = new Map<string, EntityTable>();
  const baseTbl = tables.get(baseEntity!.toLowerCase());
  if (!baseTbl) throw new SwqlError(`Source entity [${baseEntity}] not found in catalog`);
  aliases.set(baseAlias!, baseTbl);
  const joins: Array<{
    type: string;
    alias: string;
    tbl: EntityTable;
    on: [string, string, string, string];
  }> = [];
  for (let i = 1; i < segments.length; i += 2) {
    const type = segments[i]!.toUpperCase();
    const jm = /^([\w.]+)\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)$/i.exec(
      segments[i + 1]!.trim(),
    );
    if (!jm) throw new SwqlError(`mock-swis: unsupported join: ${segments[i + 1]}`);
    const tbl = tables.get(jm[1]!.toLowerCase());
    if (!tbl) throw new SwqlError(`Source entity [${jm[1]}] not found in catalog`);
    aliases.set(jm[2]!, tbl);
    joins.push({ type, alias: jm[2]!, tbl, on: [jm[3]!, jm[4]!, jm[5]!, jm[6]!] });
  }

  const items = splitTopLevel(selectPart!).map(parseSelectItem);
  // Property validation (what real SWIS does).
  const assertProp = (alias: string, prop: string) => {
    const tbl = aliases.get(alias);
    if (!tbl) throw new SwqlError(`Unknown alias ${alias}`);
    if (!tbl.props().some((p) => p.toLowerCase() === prop.toLowerCase())) {
      throw new SwqlError(`Cannot resolve property ${prop}`);
    }
  };
  for (const it of items) if (it.alias && it.prop) assertProp(it.alias, it.prop);

  // Build joined contexts.
  let ctxs: Ctx[] = baseTbl.rows().map((r) => ({ [baseAlias!]: r }));
  for (const j of joins) {
    const [a1, p1, a2, p2] = j.on;
    const [otherAlias, otherProp, myProp] = a1 === j.alias ? [a2, p2, p1] : [a1, p1, p2];
    const index = new Map<string, Rec[]>();
    for (const r of j.tbl.rows()) {
      const k = String(getProp(r, myProp));
      const list = index.get(k);
      if (list) list.push(r);
      else index.set(k, [r]);
    }
    const next: Ctx[] = [];
    for (const c of ctxs) {
      const matches = index.get(String(getProp(c[otherAlias], otherProp))) ?? [];
      if (matches.length) for (const r of matches) next.push({ ...c, [j.alias]: r });
      else if (j.type === 'LEFT') next.push({ ...c, [j.alias]: {} });
    }
    ctxs = next;
  }

  // WHERE
  if (wherePart) {
    const conds = wherePart.split(/\s+AND\s+/i).map((c) => c.trim());
    for (const cond of conds) {
      let x: RegExpExecArray | null;
      if ((x = /^(\w+)\.(\w+)\s*(=|>|<|>=|<=)\s*(@\w+|'[^']*'|-?\d+)$/.exec(cond))) {
        const [, alias, prop, op, rhs] = x;
        assertProp(alias!, prop!);
        const value = rhs!.startsWith('@')
          ? params[rhs!.slice(1)]
          : rhs!.startsWith("'")
            ? rhs!.slice(1, -1)
            : Number(rhs);
        ctxs = ctxs.filter((c) => {
          const v = getProp(c[alias!], prop!);
          const d = cmp(v, value);
          return op === '='
            ? d === 0
            : op === '>'
              ? d > 0
              : op === '<'
                ? d < 0
                : op === '>='
                  ? d >= 0
                  : d <= 0;
        });
      } else if ((x = /^(\w+)\.(\w+)\s+IN\s*\((.+)\)$/i.exec(cond))) {
        const [, alias, prop, list] = x;
        const values = new Set(
          splitTopLevel(list!).map((v) =>
            v.startsWith('@') ? String(params[v.slice(1)]) : v.replace(/^'|'$/g, ''),
          ),
        );
        ctxs = ctxs.filter((c) => values.has(String(getProp(c[alias!], prop!))));
      } else {
        throw new SwqlError(`mock-swis: unsupported WHERE condition: ${cond}`);
      }
    }
  }

  const project = (c: Ctx): Rec => {
    const out: Rec = {};
    for (const it of items) {
      if (it.kind === 'prop') out[it.as] = getProp(c[it.alias!], it.prop!);
      else if (it.kind === 'func') out[it.as] = opts.utcNow.toISOString().replace('Z', '0000Z');
    }
    return out;
  };

  let rows: Rec[];
  const hasAgg = items.some((i) => i.kind === 'count' || i.kind === 'max');
  if (groupPart || hasAgg) {
    const keys = groupPart
      ? splitTopLevel(groupPart).map((g) => g.split('.') as [string, string])
      : [];
    const groups = new Map<string, Ctx[]>();
    for (const c of ctxs) {
      const k = JSON.stringify(keys.map(([a, p]) => getProp(c[a], p)));
      const list = groups.get(k);
      if (list) list.push(c);
      else groups.set(k, [c]);
    }
    if (!groupPart && groups.size === 0) groups.set('[]', []);
    rows = [...groups.values()].map((list) => {
      const out = list[0] ? project(list[0]) : project({});
      for (const it of items) {
        if (it.kind === 'count')
          out[it.as] = list.filter((c) => getProp(c[it.alias!], it.prop!) !== null).length;
        if (it.kind === 'max') {
          const vals = list.map((c) => getProp(c[it.alias!], it.prop!)).filter((v) => v !== null);
          out[it.as] = vals.length ? vals.reduce((a, b) => (cmp(a, b) >= 0 ? a : b)) : null;
        }
      }
      return out;
    });
  } else {
    if (orderPart) {
      const order = splitTopLevel(orderPart).map((o) => {
        const om = /^(\w+)\.(\w+)(?:\s+(ASC|DESC))?$/i.exec(o.trim());
        if (!om) throw new SwqlError(`mock-swis: unsupported ORDER BY ${o}`);
        return { alias: om[1]!, prop: om[2]!, desc: (om[3] ?? '').toUpperCase() === 'DESC' };
      });
      ctxs.sort((x, y) => {
        for (const o of order) {
          const d = cmp(getProp(x[o.alias], o.prop), getProp(y[o.alias], o.prop));
          if (d !== 0) return o.desc ? -d : d;
        }
        return 0;
      });
    }
    rows = ctxs.map(project);
  }

  if (top) rows = rows.slice(0, Number(top));
  if (rowsFrom && rowsTo) rows = rows.slice(Number(rowsFrom) - 1, Number(rowsTo));
  return rows;
}
