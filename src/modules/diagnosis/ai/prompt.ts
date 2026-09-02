import type { ChatMessage } from './openrouter.js';
import { TAGS, ROOT_CAUSE_SIDES } from './schema.js';
import type { LogDeviceEntry } from '../logs/types.js';

export interface PromptInput {
  feature: { key: string; label: string };
  submission: {
    occurred_on: string;
    is_positive: boolean;
    issue_categories: { key: string; label: string }[];
    feedback_text: string | null;
    details: Record<string, unknown>;
    detailLabels: Record<string, string>;
    platform: string | null;
    app_version: string | null;
    firmware_version: string | null;
    os_version: string | null;
  };
  device: LogDeviceEntry | null;
  excerpt: string;
  windowLabel: string;
  coverage: 'full' | 'partial' | 'none';
}

export const SYSTEM_PROMPT = `You are a senior engineer triaging internal tester feedback for Luna, a smart-ring health app.
The stack, from the metal up:
- firmware: code running on the ring itself (sensors, sleep/HR/SpO2 algorithms on-device, BLE stack on the ring). Firmware logs are "cmd: N,M" style command traces.
- sdk: the ring SDK inside the phone app that talks BLE to the ring (pairing, reconnects, daily sync, realtime data). Ring logs (BEHAVIOR/BLE on Android, ring-trace on iOS) come from this layer.
- app: the Luna app's own logic and UI (screens, local computation, what it shows the user). App logs are API request/response dumps the app made.
- backend: Luna's cloud API. Errors with HTTP 4xx/5xx, "success": false, or server messages in app logs point here.
- user_expectation: the product behaved as designed but the tester expected something else.
- not_a_bug: nothing wrong is visible and the report is not actionable.
- insufficient_logs: the logs do not cover the time or the subsystem, so no honest call can be made.

Rules:
1. Decide root_cause_side from evidence in the excerpt. If the excerpt does not support a call, answer insufficient_logs with low confidence rather than guessing.
2. Quote evidence lines verbatim from the excerpt; never invent lines. Prefer 2-5 lines that a colleague could grep for.
3. Tags come only from the allowed list.
4. Times in the excerpt are IST (UTC+05:30). "~" after a time means it was inferred, not logged.
5. Write for an engineer: specific, short, no filler. Summary is one paragraph.
6. suggested_fix names the next concrete check or change and which team owns it.
7. If the tester gave times (sleep, workout), compare them with what the logs show around those times.
8. A positive report with no anomaly is not_a_bug.

Allowed root_cause_side: ${ROOT_CAUSE_SIDES.join(', ')}.
Allowed tags: ${TAGS.join(', ')}.`;

function fmtDetails(details: Record<string, unknown>, labels: Record<string, string>): string {
  const entries = Object.entries(details).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '(none)';
  return entries.map(([k, v]) => `- ${labels[k] ?? k}: ${String(v)}`).join('\n');
}

export function buildMessages(input: PromptInput): ChatMessage[] {
  const s = input.submission;
  const d = input.device;
  const user = `# Feedback
Feature: ${input.feature.label} (${input.feature.key})
Result reported by tester: ${s.is_positive ? 'working fine' : 'ISSUE'}
Issue categories: ${s.issue_categories.map((c) => `${c.label} [${c.key}]`).join(', ') || '(none)'}
Date the issue occurred (IST): ${s.occurred_on}
Tester's words: ${s.feedback_text ? JSON.stringify(s.feedback_text) : '(none)'}
Feature details the tester entered:
${fmtDetails(s.details, s.detailLabels)}

# App-reported context
platform=${s.platform ?? '?'} app_version=${s.app_version ?? '?'} firmware_version=${s.firmware_version ?? '?'} os=${s.os_version ?? '?'}

# Device matched in the logging service
${d ? `platform=${d.platform ?? '?'} model=${d.device_manufacturer ?? ''} ${d.device_model ?? ''} os=${d.os_version ?? '?'} app=${d.version_name ?? '?'} fv=${d.fv ?? '?'} battery=${d.batt_perct ?? '?'}% last_upload=${d.updated_at ?? '?'}` : '(no device entry found)'}

# Log excerpt
Search window: ${input.windowLabel}. Coverage: ${input.coverage}${input.coverage === 'partial' ? ' (no lines inside the window; nearest lines shown)' : ''}.
Sections are tagged "===== [source] =====". ${input.excerpt.split('\n').length} lines.

${input.excerpt}

# Task
Return the diagnosis as JSON matching the schema.`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
