/**
 * Names, units and device tags for benchmark data.
 *
 * Apple Health names everything by identifier ("HKQuantityTypeIdentifierHeartRate") and lets each
 * app choose its units. Nothing here is a fixed list of what may be stored: an identifier this file
 * has never seen still gets a key, a readable label and a sensible way to total it, so a new device
 * writing a new kind of sample shows up without a code change.
 */

export type Agg = 'sum' | 'avg';

export interface MetricInfo {
  key: string;
  label: string;
  unit: string;
  agg: Agg;
}

const QUANTITY_PREFIX = 'HKQuantityTypeIdentifier';
const ACTIVITY_PREFIX = 'HKWorkoutActivityType';

/** Quantities that add up over time; everything else is a reading that is averaged. */
const CUMULATIVE = /StepCount|Distance|EnergyBurned|FlightsClimbed|StrokeCount|PushCount|ExerciseTime|StandTime|MoveTime/;

const KNOWN: Record<string, { key: string; label: string }> = {
  HeartRate: { key: 'heart_rate', label: 'Heart rate' },
  RestingHeartRate: { key: 'resting_heart_rate', label: 'Resting heart rate' },
  WalkingHeartRateAverage: { key: 'walking_heart_rate', label: 'Walking heart rate' },
  HeartRateVariabilitySDNN: { key: 'hrv_sdnn', label: 'Heart rate variability (SDNN)' },
  HeartRateRecoveryOneMinute: { key: 'heart_rate_recovery', label: 'Heart rate recovery, 1 min' },
  ActiveEnergyBurned: { key: 'active_energy', label: 'Active calories' },
  BasalEnergyBurned: { key: 'basal_energy', label: 'Resting calories' },
  StepCount: { key: 'steps', label: 'Steps' },
  FlightsClimbed: { key: 'flights', label: 'Flights climbed' },
  RespiratoryRate: { key: 'respiratory_rate', label: 'Breathing rate' },
  OxygenSaturation: { key: 'oxygen_saturation', label: 'Blood oxygen' },
  AppleSleepingWristTemperature: { key: 'wrist_temperature', label: 'Wrist temperature' },
  VO2Max: { key: 'vo2_max', label: 'VO2 max' },
  RunningSpeed: { key: 'running_speed', label: 'Running speed' },
  WalkingSpeed: { key: 'walking_speed', label: 'Walking speed' },
  RunningPower: { key: 'running_power', label: 'Running power' },
  CyclingPower: { key: 'cycling_power', label: 'Cycling power' },
  CyclingCadence: { key: 'cycling_cadence', label: 'Cycling cadence' },
  RunningStrideLength: { key: 'stride_length', label: 'Stride length' },
  RunningVerticalOscillation: { key: 'vertical_oscillation', label: 'Vertical oscillation' },
  RunningGroundContactTime: { key: 'ground_contact_time', label: 'Ground contact time' },
};

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
const words = (s: string) => {
  const w = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** Key, label, unit and how to total it, for an Apple Health quantity identifier. */
export function metricOf(identifier: string, unit: string): MetricInfo {
  const name = identifier.startsWith(QUANTITY_PREFIX) ? identifier.slice(QUANTITY_PREFIX.length) : identifier;
  const agg: Agg = CUMULATIVE.test(name) ? 'sum' : 'avg';
  // Every kind of distance (walking, cycling, swimming…) is the workout's distance.
  if (/^Distance/.test(name)) return { key: 'distance', label: 'Distance', unit: 'km', agg };
  const known = KNOWN[name];
  const key = (known?.key ?? snake(name)).replace(/[^a-z0-9_]/g, '_').slice(0, 60);
  return { key, label: known?.label ?? words(name), unit: unitOf(key, unit), agg };
}

/** The unit a metric is stored in, given the unit the app wrote. */
function unitOf(key: string, unit: string): string {
  const u = unit.trim();
  if (u === 'count/min') return key === 'respiratory_rate' ? 'breaths/min' : 'bpm';
  if (/^(kcal|Cal|kJ|cal)$/.test(u)) return 'kcal';
  if (/^(km\/hr|m\/s|mi\/hr|km\/h|mph)$/.test(u)) return 'km/h';
  if (u === 'degF' || u === 'degC') return '°C';
  if (u === 'count') return '';
  return u;
}

/** Converts one value from the unit an app wrote into the stored unit. */
export function convert(info: MetricInfo, unit: string, value: number): number {
  const u = unit.trim();
  if (info.key === 'distance') {
    if (u === 'm') return value / 1000;
    if (u === 'mi') return value * 1.609344;
    if (u === 'ft') return value * 0.0003048;
    if (u === 'yd') return value * 0.0009144;
    if (u === 'cm') return value / 100_000;
    return value;
  }
  if (u === 'kJ') return value / 4.184;
  if (u === 'cal') return value / 1000;
  if (u === 'm/s') return value * 3.6;
  if (u === 'mi/hr' || u === 'mph') return value * 1.609344;
  if (u === 'degF') return (value - 32) / 1.8;
  // Health stores percentages as fractions: 0.97 is 97%.
  if (u === '%' && Math.abs(value) <= 1) return value * 100;
  return value;
}

// ---------------------------------------------------------------------------------------------
// Workout types
// ---------------------------------------------------------------------------------------------

const ACTIVITY_LABELS: Record<string, string> = {
  traditional_strength_training: 'Strength training',
  functional_strength_training: 'Functional strength',
  high_intensity_interval_training: 'HIIT',
  other: 'Other workout',
  mixed_cardio: 'Mixed cardio',
  cross_training: 'Cross training',
};

/** "HKWorkoutActivityTypeTraditionalStrengthTraining" -> "traditional_strength_training". */
export function activityKey(identifier: string | null | undefined): string {
  if (!identifier) return 'other';
  const name = identifier.startsWith(ACTIVITY_PREFIX) ? identifier.slice(ACTIVITY_PREFIX.length) : identifier;
  return snake(name).replace(/[^a-z0-9_]/g, '_').slice(0, 60) || 'other';
}

export function activityLabel(key: string | null | undefined): string {
  if (!key) return 'Workout';
  const known = ACTIVITY_LABELS[key];
  if (known) return known;
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Whether pace (time per km) is the natural way to read this workout's speed. */
export function isOnFoot(activity: string | null | undefined): boolean {
  return /running|walking|hiking/.test(activity ?? '');
}

// ---------------------------------------------------------------------------------------------
// Device tags
// ---------------------------------------------------------------------------------------------

/**
 * Brands we expect to test against. A tag is free text (a-z, 0-9, _), so a brand that is not here
 * can still be typed in; these only get a label and a guess from the source name.
 */
export const DEVICE_TAGS: { tag: string; label: string; match?: RegExp }[] = [
  { tag: 'luna', label: 'Luna', match: /luna|lifeos|gonoise|noisefit|\bnoise\b/ },
  { tag: 'polar', label: 'Polar', match: /polar/ },
  { tag: 'garmin', label: 'Garmin', match: /garmin|^connect$/ },
  { tag: 'fitbit', label: 'Fitbit', match: /fitbit|google health/ },
  { tag: 'apple_watch', label: 'Apple Watch', match: /apple watch|\bwatch\d/ },
  { tag: 'whoop', label: 'Whoop', match: /whoop/ },
  { tag: 'oura', label: 'Oura', match: /oura/ },
  { tag: 'ultrahuman', label: 'Ultrahuman', match: /ultrahuman/ },
  { tag: 'samsung', label: 'Samsung', match: /samsung|galaxy/ },
  { tag: 'coros', label: 'Coros', match: /coros/ },
  { tag: 'suunto', label: 'Suunto', match: /suunto/ },
  { tag: 'wahoo', label: 'Wahoo', match: /wahoo/ },
  { tag: 'amazfit', label: 'Amazfit', match: /amazfit|zepp/ },
  { tag: 'strava', label: 'Strava', match: /strava/ },
  { tag: 'phone', label: 'Phone', match: /iphone|ipad/ },
  { tag: 'other', label: 'Other' },
];

export const TEST_TAG = 'luna';

/**
 * Which device the others are measured against, best first. Chest straps and sports watches lead;
 * the phone comes last because it only counts steps from a pocket.
 */
const REFERENCE_ORDER = ['polar', 'garmin', 'coros', 'suunto', 'wahoo', 'apple_watch', 'whoop', 'oura', 'fitbit', 'samsung', 'ultrahuman', 'amazfit', 'strava', 'other', 'phone'];

export function referenceRank(tag: string): number {
  const i = REFERENCE_ORDER.indexOf(tag);
  return i === -1 ? REFERENCE_ORDER.indexOf('other') : i;
}

export function tagLabel(tag: string): string {
  return DEVICE_TAGS.find((t) => t.tag === tag)?.label ?? words(tag.replace(/_/g, ' '));
}

/** A first guess at the brand from what the source calls itself and the hardware it reports. */
export function guessTag(source: string, device?: { name?: string; manufacturer?: string; model?: string; hardware?: string } | null): string {
  const text = [source, device?.manufacturer, device?.name, device?.model, device?.hardware].filter(Boolean).join(' ').toLowerCase();
  for (const t of DEVICE_TAGS) if (t.match && t.match.test(text)) return t.tag;
  return 'other';
}
