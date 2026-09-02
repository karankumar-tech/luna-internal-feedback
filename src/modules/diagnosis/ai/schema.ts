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
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Strict JSON schema for OpenRouter `response_format`. Every property required; no extras. */
export const VERDICT_JSON_SCHEMA = {
  name: 'luna_feedback_diagnosis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['root_cause_side', 'confidence', 'severity', 'tags', 'reproducible', 'summary', 'evidence', 'suggested_fix', 'questions_for_tester', 'fw_version_seen', 'app_version_seen'],
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
    },
  },
} as const;
