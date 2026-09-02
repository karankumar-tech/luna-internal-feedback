/**
 * Field type vocabulary shared by the GET /schema response and the POST validator.
 * Add a type here, teach buildValidator.ts about it, and the form contract updates itself.
 */

interface Base {
  key: string;
  label: string;
  required: boolean;
  help?: string;
}

export interface BooleanField extends Base { type: 'boolean' }
export interface TextField extends Base { type: 'text'; maxLength: number; multiline?: boolean }
export interface DateField extends Base { type: 'date'; format: 'YYYY-MM-DD'; allowFuture?: boolean }
export interface NumberField extends Base { type: 'number'; min?: number; max?: number; integer?: boolean; unit?: string }
export interface Time12hField extends Base { type: 'time_12h'; format: 'HH:MM AM/PM' }
export interface StringField extends Base { type: 'string'; maxLength?: number; format?: 'email'; options?: string[] }
export interface MultiSelectField extends Base { type: 'multi_select'; minItems: number; optionsFrom: 'issue_categories' }

export type FieldDef =
  | BooleanField
  | TextField
  | DateField
  | NumberField
  | Time12hField
  | StringField
  | MultiSelectField;

export type FieldType = FieldDef['type'];

/** Pairs of time fields that must not be identical when both are present. */
export interface TimePairRule {
  kind: 'time_pair_distinct';
  start: string;
  end: string;
}

export type FeatureRule = TimePairRule;
