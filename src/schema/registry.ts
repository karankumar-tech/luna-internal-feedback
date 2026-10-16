import type { FieldDef, FeatureRule } from './fieldTypes.js';

export const SCHEMA_VERSION = 1;

export const FEATURE_KEYS = ['home', 'sleep', 'activity', 'workout', 'apps', 'other'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

/** Fields every submission carries, regardless of feature. */
export const COMMON_FIELDS: readonly FieldDef[] = [
  { key: 'is_positive', type: 'boolean', label: 'Was this a positive experience?', required: true },
  { key: 'occurred_on', type: 'date', format: 'YYYY-MM-DD', label: 'Date the issue occurred', required: true, requiredIf: { field: 'is_positive', equals: false }, help: 'Required for issues. Optional for positive feedback; defaults to today (IST).' },
  { key: 'user_id', type: 'number', label: 'User ID', required: true, integer: true, min: 1 },
  { key: 'email', type: 'string', format: 'email', label: 'Email', required: true, maxLength: 254 },
  { key: 'issue_categories', type: 'multi_select', label: 'What went wrong?', required: true, minItems: 1, optionsFrom: 'issue_categories', requiredIf: { field: 'is_positive', equals: false }, help: 'Required for issues. Omit (or send []) for positive feedback.' },
  { key: 'feedback_text', type: 'text', label: 'Tell us more', required: false, maxLength: 500, multiline: true },
  {
    key: 'device_serial', type: 'string', label: 'Ring or band serial number', required: false, maxLength: 64,
    help: 'Fill automatically from the connected ring or band, e.g. R2N08250600302. Not typed by the tester. Used to fetch device logs; email is the fallback.',
  },
];

/**
 * The mini apps inside Luna, for the Apps feature's "Which app?" dropdown. The key is what the app
 * sends and what is stored; adding one here (and deploying) is all it takes to offer it.
 */
export const LUNA_APPS = {
  cycle_tracker: 'Cycle tracker',
  calorie_tracker: 'Calorie tracker',
  circadian: 'Circadian',
  luna_age: 'Luna Age',
  vo2_max: 'VO2 max',
  sleep_planner: 'Sleep planner',
  supplement_planner: 'Supplement planner',
  hydration: 'Hydration',
  caffeine_window: 'Caffeine window',
  jet_lag_planner: 'Jet lag planner',
  pregnancy_tracker: 'Pregnancy tracker',
  hyrox_training: 'Hyrox training',
  running_trainer: 'Running trainer',
} as const satisfies Record<string, string>;

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
  apps: {
    key: 'apps',
    fields: [
      {
        key: 'app', type: 'string', label: 'Which app?', required: true,
        options: Object.keys(LUNA_APPS), optionLabels: { ...LUNA_APPS },
        help: 'The app inside Luna you were using when it happened.',
      },
    ],
    rules: [],
  },
  other: {
    key: 'other',
    fields: [
      { key: 'screen', type: 'string', label: 'Where in the app did it happen?', required: false, maxLength: 100 },
    ],
    rules: [],
  },
};

/**
 * A report's details as people read them: each field's label, and an option's label instead of its
 * key ("Which app?" → "Cycle tracker"). Empty values are left out; unknown keys keep their own name.
 */
export function readableDetails(featureKey: string, details: Record<string, unknown>): [label: string, value: string][] {
  const fields = FEATURE_DEFINITIONS[featureKey as FeatureKey]?.fields ?? [];
  return Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const f = fields.find((x) => x.key === k);
      const shown = f?.type === 'string' && typeof v === 'string' ? f.optionLabels?.[v] ?? v : String(v);
      return [f?.label ?? k, shown];
    });
}

/**
 * Where an issue lives: the iOS or Android app (what the app sends on its own), or the backend or the
 * ring's firmware, which QA picks for issues that are not the app's.
 */
export const PLATFORMS = ['ios', 'android', 'backend', 'firmware'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Record<Platform, string> = { ios: 'iOS', android: 'Android', backend: 'Backend', firmware: 'Firmware' };

/**
 * Which ring of the release train the report came from.
 * Stage is the default because that is the only build testing today; the field exists so
 * UAT and production reports can be told apart the day those users are let in.
 */
export const ENVIRONMENTS = ['stage', 'uat', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
export const DEFAULT_ENVIRONMENT: Environment = 'stage';

/**
 * Who a report came from. Internal testers report through the app; CX files customer problems
 * from its own tool through /v1/cx/*. The API key decides which, never the request body.
 */
export const ORIGINS = ['internal', 'cx'] as const;
export type Origin = (typeof ORIGINS)[number];

/** How the customer reached CX. */
export const CX_CHANNELS = ['email', 'chat', 'call', 'whatsapp', 'social', 'app_store', 'play_store', 'other'] as const;
export type CxChannel = (typeof CX_CHANNELS)[number];

/** A CX report is about a customer on the released app unless the CX tool says otherwise. */
export const DEFAULT_CX_ENVIRONMENT: Environment = 'production';

/** Optional client context the app attaches; stored as columns for dashboard slicing. */
export const CLIENT_CONTEXT_KEYS = [
  'environment',
  'platform',
  'app_version',
  'build_number',
  'build_channel',
  'firmware_version',
  'os_version',
  'device_id',
  'session_id',
] as const;
export type ClientContextKey = (typeof CLIENT_CONTEXT_KEYS)[number];

/** Client context field definitions, exposed in the schema so the app knows the allowed values. */
export const CLIENT_CONTEXT_FIELDS: readonly FieldDef[] = [
  {
    key: 'environment', type: 'string', label: 'Environment', required: false, options: [...ENVIRONMENTS],
    help: `Which backend the app is pointed at. Omit it and the server records "${DEFAULT_ENVIRONMENT}".`,
  },
  {
    key: 'platform', type: 'string', label: 'Platform', required: false, options: [...PLATFORMS], optionLabels: { ...PLATFORM_LABELS },
    help: 'The phone the app runs on (ios, android), or backend / firmware for an issue that lives there rather than in the app.',
  },
  { key: 'app_version', type: 'string', label: 'App version', required: false, maxLength: 200 },
  { key: 'build_number', type: 'string', label: 'Build number', required: false, maxLength: 200 },
  { key: 'build_channel', type: 'string', label: 'Build channel', required: false, maxLength: 200 },
  { key: 'firmware_version', type: 'string', label: 'Ring firmware version', required: false, maxLength: 200 },
  { key: 'os_version', type: 'string', label: 'OS version', required: false, maxLength: 200 },
  { key: 'device_id', type: 'string', label: 'Device ID', required: false, maxLength: 200 },
  { key: 'session_id', type: 'string', label: 'Session ID', required: false, maxLength: 200 },
];
