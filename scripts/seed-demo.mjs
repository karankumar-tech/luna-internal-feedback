// Inserts realistic demo submissions flagged is_test=true (emails @luna-demo.invalid) so they can be removed
// with --clean (deletes every is_test row) or from the dashboard, without touching real feedback.
// Usage: node scripts/seed-demo.mjs [count]   |   node scripts/seed-demo.mjs --clean
import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
if (process.argv.includes('--clean')) {
  const r = await c.query('delete from luna_feedback.submissions where is_test');
  console.log('removed', r.rowCount); await c.end(); process.exit(0);
}
const n = Number(process.argv[2] || 60);
const cats = { home: ['wrong_peak_score','peak_score_not_loaded','guidance_incorrect'], sleep: ['incorrect_sleep','sleep_not_recorded','incorrect_sleep_stage','vitals_not_recorded'], activity: ['incorrect_steps','incorrect_total_calories','incorrect_active_calories','incorrect_training_load','workout_not_showing'], workout: ['incorrect_duration','incorrect_calories','hr_not_showing','map_not_loading','incorrect_zones','incorrect_intensity','start_workout_fail','end_workout_fail'] };
const texts = ['Sleep showed 3h but I slept a full night.', 'Peak score stuck on yesterday.', 'Steps were double what my phone counted.', 'HR flatlined 10 min into the run.', 'All good today.', 'Worked as expected.', 'Map never loaded after the workout ended.', 'Training load jumped with no workout.', '', 'Vitals missing for the whole night.'];
const users = [10482, 10491, 10502, 10510, 10533, 10547, 10561, 10578, 10590];
const fw = ['1.9.1', '1.9.2', '1.9.2', '1.9.3'];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const today = new Date(); const rows = [];
for (let i = 0; i < n; i++) {
  const feature = rnd(Object.keys(cats));
  const positive = Math.random() < 0.42;
  const d = new Date(today); d.setUTCDate(d.getUTCDate() - Math.floor(Math.random() * 28));
  const occurred = d.toISOString().slice(0, 10);
  const picks = positive ? [rnd(cats[feature])] : [...new Set([rnd(cats[feature]), ...(Math.random() < 0.3 ? [rnd(cats[feature])] : [])])];
  const details = feature === 'home' ? { peak_score_value: 40 + Math.floor(Math.random() * 60) }
    : feature === 'sleep' ? { actual_start_time: '11:30 PM', actual_end_time: '06:45 AM', recorded_start_time: '01:10 AM', recorded_end_time: '05:00 AM' }
    : feature === 'activity' ? { steps: 4000 + Math.floor(Math.random() * 9000), active_calories: 300 + Math.floor(Math.random() * 400), total_calories: 1900 + Math.floor(Math.random() * 600) }
    : { workout_type: rnd(['Outdoor Run', 'Cycling', 'Strength', 'Yoga']), start_time: '06:00 AM', end_time: '06:45 AM', intensity: rnd(['Low', 'Moderate', 'High']) };
  const user = rnd(users);
  const platform = Math.random() < 0.7 ? 'ios' : 'android';
  rows.push([feature, positive, occurred, user, `tester${user}@luna-demo.invalid`, picks, positive ? rnd(['All good today.', 'Worked as expected.', '']) : rnd(texts), JSON.stringify(details), platform, '2.4.0', String(500 + Math.floor(Math.random() * 15)), 'stage', rnd(fw), platform === 'ios' ? 'iOS 19.1' : 'Android 16', crypto.randomUUID().toUpperCase(), crypto.randomUUID(), new Date(d.getTime() + Math.floor(Math.random() * 86400000)).toISOString()]);
}
for (const r of rows) await c.query(`insert into luna_feedback.submissions (feature_key,is_positive,occurred_on,user_id,email,issue_categories,feedback_text,details,platform,app_version,build_number,build_channel,firmware_version,os_version,device_id,session_id,created_at,is_test) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,true)`, r);
console.log('inserted', rows.length); await c.end();
