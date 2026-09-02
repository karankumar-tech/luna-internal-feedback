import type { FieldDef, FeatureRule } from './fieldTypes.js';

export const SCHEMA_VERSION = 1;

export const FEATURE_KEYS = ['home', 'sleep', 'activity', 'workout'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

/** Fields every submission carries, regardless of feature. */
export const COMMON_FIELDS: readonly FieldDef[] = [
  { key: 'is_positive', type: 'boolean', label: 'Was this a positive experience?', required: true },
  { key: 'occurred_on', type: 'date', format: 'YYYY-MM-DD', label: 'Date the issue occurred', required: true },
  { key: 'user_id', type: 'number', label: 'User ID', required: true, integer: true, min: 1 },
  { key: 'email', type: 'string', format: 'email', label: 'Email', required: true, maxLength: 254 },
  { key: 'issue_categories', type: 'multi_select', label: 'What went wrong?', required: true, minItems: 1, optionsFrom: 'issue_categories' },
  { key: 'feedback_text', type: 'text', label: 'Tell us more', required: false, maxLength: 500, multiline: true },
];

export interface FeatureDefinition {
  key: FeatureKey;
  /** Feature-specific fields; stored under `details`. */
  fields: readonly FieldDef[];
  rules: readonly FeatureRule[];
}

export const FEATURE_DEFINITIONS: Record<FeatureKey, FeatureDefinition> = {
  home: {
    key: 'home',
    fields: [
      { key: 'peak_score_value', type: 'number', label: 'Peak score shown', required: false, min: 0, max: 100 },
    ],
    rules: [],
  },
  sleep: {
    key: 'sleep',
    fields: [
      { key: 'actual_start_time', type: 'time_12h', format: 'HH:MM AM/PM', label: 'Actual sleep start', required: false },
      { key: 'actual_end_time', type: 'time_12h', format: 'HH:MM AM/PM', label: 'Actual sleep end', required: false },
      { key: 'recorded_start_time', type: 'time_12h', format: 'HH:MM AM/PM', label: 'Recorded sleep start', required: false },
      { key: 'recorded_end_time', type: 'time_12h', format: 'HH:MM AM/PM', label: 'Recorded sleep end', required: false },
    ],
    rules: [
      { kind: 'time_pair_distinct', start: 'actual_start_time', end: 'actual_end_time' },
      { kind: 'time_pair_distinct', start: 'recorded_start_time', end: 'recorded_end_time' },
    ],
  },
  activity: {
    key: 'activity',
    fields: [
      { key: 'steps', type: 'number', label: 'Steps', required: false, integer: true, min: 0 },
      { key: 'active_calories', type: 'number', label: 'Active calories', required: false, min: 0, unit: 'kcal' },
      { key: 'total_calories', type: 'number', label: 'Total calories', required: false, min: 0, unit: 'kcal' },
    ],
    rules: [],
  },
  workout: {
    key: 'workout',
    fields: [
      { key: 'workout_type', type: 'string', label: 'Workout type', required: false, maxLength: 100 },
      { key: 'start_time', type: 'time_12h', format: 'HH:MM AM/PM', label: 'Workout start', required: false },
      { key: 'end_time', type: 'time_12h', format: 'HH:MM AM/PM', label: 'Workout end', required: false },
      { key: 'intensity', type: 'string', label: 'Intensity', required: false, maxLength: 50 },
    ],
    rules: [
      { kind: 'time_pair_distinct', start: 'start_time', end: 'end_time' },
    ],
  },
};

/** Optional client context the iOS module attaches; stored as columns for dashboard slicing. */
export const CLIENT_CONTEXT_KEYS = [
  'app_version',
  'build_number',
  'build_channel',
  'firmware_version',
  'os_version',
  'device_id',
  'session_id',
] as const;
export type ClientContextKey = (typeof CLIENT_CONTEXT_KEYS)[number];
