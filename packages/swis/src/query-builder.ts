import { SwisSchemaError } from './errors';

export interface FieldSpec {
  /** Entity alias used in FROM (e.g. "aa"). */
  alias: string;
  /** Property on that entity (e.g. "AlertActiveID"). */
  prop: string;
  /** Result key (explicit `AS`). Defaults to prop. */
  as?: string;
  required?: boolean;
}

export interface QuerySpec {
  name: string;
  /** alias → full entity name, used by the schema probe. */
  entities: Record<string, string>;
  fields: FieldSpec[];
  /** FROM clause including joins, without the word FROM. */
  from: string;
  /** Extra join appended only when extra (dynamic) fields are selected. */
  joinForExtras?: string;
  where?: string;
  /** ORDER BY expressions; must reference required fields so paging is stable. */
  orderBy: string[];
}

/** Answers "does entity X have property Y?" — null means "unknown, assume yes". */
export interface FieldAvailability {
  has(entity: string, prop: string): boolean;
}

export interface BuiltSelect {
  select: string;
  dropped: string[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(name: string): string {
  if (!IDENT.test(name))
    throw new SwisSchemaError(`unsafe SWQL identifier: ${JSON.stringify(name)}`);
  return name;
}

export function fieldKey(f: FieldSpec): string {
  return f.as ?? f.prop;
}

/** Build the SELECT list, dropping optional fields the instance doesn't have. */
export function buildSelect(
  spec: QuerySpec,
  avail: FieldAvailability | null,
  extra: string[] = [],
): BuiltSelect {
  const parts: string[] = [];
  const dropped: string[] = [];
  const missingRequired: string[] = [];
  for (const f of spec.fields) {
    const entity = spec.entities[f.alias];
    if (!entity) throw new SwisSchemaError(`${spec.name}: unknown alias ${f.alias}`);
    if (avail && !avail.has(entity, f.prop)) {
      if (f.required) missingRequired.push(`${entity}.${f.prop}`);
      else dropped.push(`${entity}.${f.prop}`);
      continue;
    }
    parts.push(`${f.alias}.${assertIdentifier(f.prop)} AS ${assertIdentifier(fieldKey(f))}`);
  }
  if (missingRequired.length) {
    throw new SwisSchemaError(
      `${spec.name}: required SWIS fields missing in this Orion version: ${missingRequired.join(', ')}. Run "pnpm swis:discover".`,
    );
  }
  parts.push(...extra);
  return { select: `SELECT ${parts.join(', ')}`, dropped };
}

function tail(spec: QuerySpec, hasExtras: boolean): string {
  const from = `FROM ${spec.from}${hasExtras && spec.joinForExtras ? ` ${spec.joinForExtras}` : ''}`;
  const where = spec.where ? ` WHERE ${spec.where}` : '';
  return `${from}${where} ORDER BY ${spec.orderBy.join(', ')}`;
}

function rows(start: number, end: number): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error(`invalid WITH ROWS range ${start}..${end}`);
  }
  return `WITH ROWS ${start} TO ${end}`;
}

/** Snapshot page: `... ORDER BY key WITH ROWS start TO end`. */
export function buildPagedQuery(
  spec: QuerySpec,
  avail: FieldAvailability | null,
  extra: string[] = [],
): { build: (start: number, end: number) => string; dropped: string[] } {
  const { select, dropped } = buildSelect(spec, avail, extra);
  const t = tail(spec, extra.length > 0);
  return { build: (start, end) => `${select} ${t} ${rows(start, end)}`, dropped };
}

/** Incremental page: spec.where must contain `> @cursor`. */
export function buildIncrementalQuery(
  spec: QuerySpec,
  avail: FieldAvailability | null,
): { build: (pageSize: number) => string; dropped: string[] } {
  if (!spec.where?.includes('@cursor'))
    throw new Error(`${spec.name}: incremental spec needs @cursor`);
  const { select, dropped } = buildSelect(spec, avail);
  const t = tail(spec, false);
  return { build: (pageSize) => `${select} ${t} ${rows(1, pageSize)}`, dropped };
}

/** Every (entity, property) a spec references — used by discovery to report gaps. */
export function specFields(
  spec: QuerySpec,
): Array<{ entity: string; prop: string; required: boolean }> {
  return spec.fields.map((f) => ({
    entity: spec.entities[f.alias] ?? '?',
    prop: f.prop,
    required: !!f.required,
  }));
}
