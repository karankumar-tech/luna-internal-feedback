export type LogSource = 'app' | 'ring' | 'firmware';

export interface LogFileRef {
  source: LogSource;
  url: string;
  /** YYYY-MM-DD taken from the upload path, or null when the path has no date. */
  date: string | null;
}

/** One (user, phone) entry from list-botfetch, normalised. */
export interface LogDeviceEntry {
  user_id: number | null;
  device_id: number | null;
  platform: string | null;
  device_model: string | null;
  device_manufacturer: string | null;
  os_version: string | null;
  fv: string | null;
  version_name: string | null;
  batt_perct: number | null;
  updated_at: string | null;
  files: Record<LogSource, LogFileRef[]>;
}

export interface LogLine {
  source: LogSource;
  /** Sub-source for display: 'ring/BEHAVIOR', 'ring/BLE', 'ring/ios', 'app', 'firmware'. */
  channel: string;
  /** Epoch ms, or null when the line carries no usable timestamp. */
  ts: number | null;
  /** True when ts was inferred (session header, previous line) rather than parsed from the line. */
  approx: boolean;
  text: string;
}

export interface ParsedFile {
  ref: LogFileRef;
  lines: LogLine[];
  bytes: number;
  /** Members actually read from a zip, if any. */
  members?: string[];
}
