import { createLogger, errorMessage, type Logger } from '@mercer/core';
import type { SwisClient } from './client';
import type { FieldAvailability } from './query-builder';
import {
  CUSTOM_PROPERTY_SYSTEM_COLUMNS,
  NODE_CUSTOM_PROPERTIES,
  NODE_CUSTOM_PROPERTIES_TARGET,
  SWQL_RESERVED,
  probedEntities,
  schemaProbeQuery,
} from './queries';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Learns which entity properties exist on this Orion instance (Metadata.Property) and which node
 * custom properties are defined. Until the first successful refresh it answers optimistically.
 */
export class SchemaProbe implements FieldAvailability {
  /** entity (lower) → property (lower) → property (original case) */
  private props: Map<string, Map<string, string>> | null = null;
  private cpFields: string[] = [];
  private readonly log: Logger;
  lastRefreshAt: Date | null = null;

  constructor(
    private readonly client: SwisClient,
    logger?: Logger,
  ) {
    this.log = logger ?? createLogger('swis-probe');
  }

  get loaded(): boolean {
    return this.props !== null;
  }

  has(entity: string, prop: string): boolean {
    if (!this.props) return true;
    const set = this.props.get(entity.toLowerCase());
    if (!set) return true; // entity not described (e.g. Metadata restricted) — be optimistic
    return set.has(prop.toLowerCase());
  }

  /** Validated node custom-property column names (safe to splice into SWQL). */
  get customPropertyFields(): readonly string[] {
    return this.cpFields;
  }

  properties(entity: string): string[] {
    return [...(this.props?.get(entity.toLowerCase())?.values() ?? [])];
  }

  async refresh(): Promise<void> {
    const entities = [...probedEntities(), NODE_CUSTOM_PROPERTIES_TARGET];
    const params = Object.fromEntries(entities.map((e, i) => [`e${i}`, e]));
    try {
      const rows = await this.client.query<{ EntityName: string; Name: string }>(
        schemaProbeQuery(entities.length),
        params,
        { label: 'schemaProbe' },
      );
      const map = new Map<string, Map<string, string>>();
      for (const r of rows) {
        const key = String(r.EntityName).toLowerCase();
        let props = map.get(key);
        if (!props) map.set(key, (props = new Map()));
        props.set(String(r.Name).toLowerCase(), String(r.Name));
      }
      if (map.size > 0) this.props = map;
      else this.log.warn('Metadata.Property returned nothing; using optimistic field list');
    } catch (err) {
      this.log.warn({ err: errorMessage(err) }, 'schema probe failed; using optimistic field list');
    }
    await this.refreshCustomProperties();
    this.lastRefreshAt = new Date();
  }

  private async refreshCustomProperties(): Promise<void> {
    let names: string[];
    try {
      const rows = await this.client.query<{ Field: string }>(
        NODE_CUSTOM_PROPERTIES,
        { target: NODE_CUSTOM_PROPERTIES_TARGET },
        { label: 'customProperties' },
      );
      names = rows.map((r) => String(r.Field));
    } catch (err) {
      this.log.warn(
        { err: errorMessage(err) },
        'Orion.CustomProperty not readable; falling back to Metadata.Property',
      );
      names = this.properties(NODE_CUSTOM_PROPERTIES_TARGET);
    }
    const accepted: string[] = [];
    for (const name of names) {
      if (CUSTOM_PROPERTY_SYSTEM_COLUMNS.has(name)) continue;
      if (!IDENT.test(name) || SWQL_RESERVED.has(name.toLowerCase())) {
        this.log.warn({ field: name }, 'skipping custom property with an unsafe/reserved name');
        continue;
      }
      accepted.push(name);
    }
    this.cpFields = [...new Set(accepted)].sort();
  }
}
