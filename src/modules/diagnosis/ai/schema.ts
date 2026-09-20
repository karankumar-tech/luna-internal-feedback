import { z } from 'zod';

export const ROOT_CAUSE_SIDES = ['firmware', 'sdk', 'app', 'backend', 'user_expectation', 'not_a_bug', 'insufficient_logs'] as const;
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const REPRODUCIBLE = ['likely', 'unlikely', 'unknown'] as const;
export const TAGS = [
  'ble_disconnect', 'ble_pairing', 'sync_timeout', 'sync_partial', 'data_gap', 'sensor_quality', 'algorithm_output',
  'firmware_reboot', 'firmware_cmd_error', 'app_crash', 'app_ui_state', 'app_background_kill', 'api_error_4xx',
  'api_error_5xx', 'auth_session', 'battery', 'permissions', 'time_zone', 'user_expectation', 'other',
] as const;

export const EvidenceSchema = z.object({
  source: z.enum(['app', 'ring', 'firmware']),
  ts: z.string().nullable(),
  line: z.string().max(500),
  why: z.string().max(300),
});

/** What the model must return. Mirrors the JSON schema sent as response_format. */
export const VerdictSchema = z.object({
  root_cause_side: z.enum(ROOT_CAUSE_SIDES),
  confidence: z.number().min(0).max(1),
  severity: z.enum(SEVERITIES),
  tags: z.array(z.enum(TAGS)).max(6),
  reproducible: z.enum(REPRODUCIBLE),
  summary: z.string().max(600),
  evidence: z.array(EvidenceSchema).max(8),
  suggested_fix: z.string().max(800),
  questions_for_tester: z.array(z.string().max(200)).max(5),
  fw_version_seen: z.string().nullable(),
  app_version_seen: z.string().nullable(),
  // Both are asked for as required fields in VERDICT_JSON_SCHEMA, but tolerated when absent:
  // a model that drops them should not cost us an otherwise good verdict.
  /** Catalog ids (FW-01, RL-07, APP-22). Unknown ids are dropped before they are stored. */
  event_codes: z.array(z.string().max(20)).max(6).nullish().transform((v) => v ?? []),
  /** Free text: the recurring problem this ticket is an instance of, for clustering. */
  issue_kind: z.object({
    title: z.string().max(80),
    rationale: z.string().max(240),
  }).nullish().transform((v) => v ?? null),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Strict JSON schema for OpenRouter `response_format`. Every property required; no extras. */
export const VERDICT_JSON_SCHEMA = {
  name: 'luna_feedback_diagnosis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['root_cause_side', 'confidence', 'severity', 'tags', 'reproducible', 'summary', 'evidence', 'suggested_fix', 'questions_for_tester', 'fw_version_seen', 'app_version_seen', 'event_codes', 'issue_kind'],
    properties: {
      root_cause_side: { type: 'string', enum: [...ROOT_CAUSE_SIDES], description: 'Which layer most likely caused the issue. Use insufficient_logs when the logs cannot support a call.' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are about root_cause_side.' },
      severity: { type: 'string', enum: [...SEVERITIES] },
      tags: { type: 'array', items: { type: 'string', enum: [...TAGS] }, maxItems: 6, description: 'Only from the fixed list. Empty if none apply.' },
      reproducible: { type: 'string', enum: [...REPRODUCIBLE] },
      summary: { type: 'string', description: 'One paragraph for an engineer: what happened and why you think so. Max 600 chars.' },
      evidence: {
        type: 'array', maxItems: 8,
        items: {
          type: 'object', additionalProperties: false, required: ['source', 'ts', 'line', 'why'],
          properties: {
            source: { type: 'string', enum: ['app', 'ring', 'firmware'] },
            ts: { type: ['string', 'null'], description: 'The HH:MM:SS shown at the start of the excerpt line, or null.' },
            line: { type: 'string', description: 'The log line quoted verbatim (trim to 500 chars).' },
            why: { type: 'string', description: 'Why this line matters.' },
          },
        },
      },
      suggested_fix: { type: 'string', description: 'Concrete next step: what to check, change, or whom to route to.' },
      questions_for_tester: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      fw_version_seen: { type: ['string', 'null'], description: 'Firmware version visible in the logs, else null.' },
      app_version_seen: { type: ['string', 'null'], description: 'App version visible in the logs, else null.' },
      event_codes: {
        type: 'array', items: { type: 'string' }, maxItems: 6,
        description: 'Ids of matched catalog events (e.g. FW-01, RL-07, APP-22), only from the list given in the prompt and only when the excerpt really shows them. Empty if none fit.',
      },
      issue_kind: {
        type: ['object', 'null'], additionalProperties: false, required: ['title', 'rationale'],
        description: 'The recurring problem this ticket is an instance of, so tickets can be grouped. Reuse one of the existing kinds listed in the prompt when it fits; otherwise name a new one.',
        properties: {
          title: { type: 'string', description: 'Short, specific and reusable, e.g. "Sleep start recorded hours late". Not a restatement of this one ticket.' },
          rationale: { type: 'string', description: 'One sentence: why this ticket belongs to that kind.' },
        },
      },
    },
  },
} as const;
