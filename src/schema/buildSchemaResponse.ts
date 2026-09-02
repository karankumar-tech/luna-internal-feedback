import { createHash } from 'node:crypto';
import type { FieldDef } from './fieldTypes.js';
import { COMMON_FIELDS, FEATURE_DEFINITIONS, SCHEMA_VERSION, CLIENT_CONTEXT_KEYS, type FeatureKey } from './registry.js';

export interface CategoryOption {
  key: string;
  label: string;
}

export interface FeatureRow {
  key: string;
  label: string;
  sort_order: number;
  is_active: boolean;
}

export interface FeatureSchema {
  key: string;
  label: string;
  issue_categories: CategoryOption[];
  fields: FieldDef[];
  rules: { kind: string; start: string; end: string }[];
}

export interface SchemaResponse {
  schema_version: number;
  common_fields: FieldDef[];
  client_context_keys: readonly string[];
  features: FeatureSchema[];
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildFeatureSchema(feature: FeatureRow, categories: CategoryOption[]): FeatureSchema {
  const def = FEATURE_DEFINITIONS[feature.key as FeatureKey];
  return stripUndefined({
    key: feature.key,
    label: feature.label,
    issue_categories: categories,
    fields: def ? [...def.fields] : [],
    rules: def ? def.rules.map((r) => ({ ...r })) : [],
  });
}

export function buildSchemaResponse(
  features: FeatureRow[],
  categoriesByFeature: Map<string, CategoryOption[]>,
): SchemaResponse {
  const active = features.filter((f) => f.is_active).sort((a, b) => a.sort_order - b.sort_order);
  return stripUndefined({
    schema_version: SCHEMA_VERSION,
    common_fields: [...COMMON_FIELDS],
    client_context_keys: CLIENT_CONTEXT_KEYS,
    features: active.map((f) => buildFeatureSchema(f, categoriesByFeature.get(f.key) ?? [])),
  });
}

/** Weak ETag over the serialized payload so the app can short-circuit unchanged schemas. */
export function etagFor(payload: unknown): string {
  return `W/"${createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}"`;
}
