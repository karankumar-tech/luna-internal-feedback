// One real diagnosis against the live logging API + OpenRouter, using a test submission.
// Usage: node scripts/diagnose-live.mjs <email> <serial|-> <feature> <occurred_on> [platform]
import 'dotenv/config';
import { buildApp } from '../dist/build-app.js';
const [email, serial, feature = 'sleep', occurredOn, platform = 'android'] = process.argv.slice(2);
if (!email || !occurredOn) { console.error('usage: email serial|- feature occurred_on [platform]'); process.exit(1); }
const app = buildApp({ logger: false });
await app.ready();
const cats = { sleep: ['incorrect_sleep'], home: ['wrong_peak_score'], activity: ['incorrect_steps'], workout: ['hr_not_showing'], other: ['app_crash'] };
const r = await app.inject({ method: 'POST', url: `/v1/feedback/${feature}`, headers: { 'x-api-key': app.config.APP_API_KEY, 'content-type': 'application/json' },
  payload: { is_test: true, is_positive: false, occurred_on: occurredOn, user_id: 900099, email, issue_categories: cats[feature], feedback_text: 'Live diagnosis check: sleep looked wrong last night.', device_serial: serial === '-' ? null : serial, details: feature === 'sleep' ? { actual_start_time: '11:30 PM', actual_end_time: '06:45 AM' } : {}, client: { platform } } });
if (r.statusCode !== 201) { console.error(r.body); process.exit(1); }
const id = r.json().id; console.log('submission', id, '(auto run started in background; waiting for it)');
const t = Date.now();
let d = null;
while (Date.now() - t < 120_000) { d = await app.diagnosis.get(id); if (d && !['pending', 'running'].includes(d.status)) break; await new Promise((res) => setTimeout(res, 500)); }
console.log('status:', d ? d.status : 'none', d && d.error ? d.error : '', `in ${((Date.now() - t) / 1000).toFixed(1)}s`);
if (d) {
  console.log(JSON.stringify({ side: d.root_cause_side, confidence: d.confidence, severity: d.severity, tags: d.tags, reproducible: d.reproducible, coverage: d.log_coverage, lines: d.log_excerpt_lines, fw: d.fw_version_seen, appv: d.app_version_seen, model: d.model, tokens: [d.prompt_tokens, d.completion_tokens], cost: d.cost_usd, ms: d.duration_ms, files: d.log_files, device: d.log_device && { platform: d.log_device.platform, model: d.log_device.device_model, updated: d.log_device.updated_at } }, null, 1));
  console.log('\nSUMMARY:', d.summary); console.log('\nFIX:', d.suggested_fix); console.log('\nEVIDENCE:'); for (const e of d.evidence) console.log(' -', `[${e.source}] ${e.ts ?? ''} ${e.line}\n     why: ${e.why}`);
  console.log('\nQUESTIONS:', d.questions_for_tester); console.log('\n--- excerpt (first 30 lines) ---'); console.log((d.log_excerpt || '').split('\n').slice(0, 30).join('\n'));
}
if (process.env.KEEP === '1') console.log('\nKEPT submission', id, '(delete later: node -e … or from the dashboard Test data card)');
else { await app.db.query('delete from luna_feedback.submissions where id = $1', [id]); console.log('\ncleaned up test submission'); }
await app.close();
