/** Shape of the event catalog built from reference/luna-critical-events.xlsx. */

/** One curated critical event: a fault worth naming, with what it means and who owns it. */
export interface CatalogEvent {
  /** Stable sheet id: FW-01, RL-07, APP-22. Used as the event code on a diagnosis. */
  id: string;
  /** Which layer the event is observed in. Matches the diagnosis `root_cause_side` vocabulary. */
  domain: 'firmware' | 'sdk' | 'app';
  priority: string | null;
  area: string | null;
  /** Exception | Derived | Context | Not logged — how the event is detected today. */
  kind: string | null;
  /** Device-neutral `area.what` name, e.g. `device.restart`. */
  event: string;
  reasons: string[];
  /** failure | exception | anomaly | gap | context. */
  type: string | null;
  /** critical | error | warning | info, as the sheet grades it. */
  severity: string | null;
  /** The tracked operation this failure counts against (App sheet only). */
  operation: string | null;
  /** Diagnosis tag, so events and feedback join on the same vocabulary. */
  tag: string | null;
  means: string | null;
  detect: string | null;
  /** Literal log fragments that identify the event. Lower-cased at match time. */
  match: string[];
}

/** One line from a vendor log dictionary. Explains lines no curated event covers. */
export interface CatalogDictionaryEntry {
  source: 'firmware' | 'ring_ios' | 'ring_android' | 'app';
  /** The log function or line as the vendor documents it, placeholders intact. */
  fn: string;
  /** Vendor's description. Mostly Chinese; the model reads it fine. */
  desc: string;
  type: string | null;
  match: string[];
}

export interface Catalog {
  version: number;
  source: string;
  generated_from: string;
  events: CatalogEvent[];
  dictionary: CatalogDictionaryEntry[];
}
