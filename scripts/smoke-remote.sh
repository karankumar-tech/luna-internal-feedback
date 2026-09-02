#!/usr/bin/env bash
# Smoke-tests a deployed instance using the keys in .env. Cleans up its own rows.
# Usage: scripts/smoke-remote.sh https://luna-internal-feedback.vercel.app
set -euo pipefail
BASE="${1:?base url required}"
# Read keys via dotenv (values may contain characters the shell would interpret).
APP_API_KEY=$(node -e "require('dotenv').config({quiet:true}); process.stdout.write(process.env.APP_API_KEY||'')")
ADMIN_API_KEY=$(node -e "require('dotenv').config({quiet:true}); process.stdout.write(process.env.ADMIN_API_KEY||'')")
[ -n "$APP_API_KEY" ] && [ -n "$ADMIN_API_KEY" ] || { echo "APP_API_KEY / ADMIN_API_KEY missing in .env"; exit 1; }
J='content-type: application/json'
APP="x-api-key: $APP_API_KEY"; ADM="x-admin-key: $ADMIN_API_KEY"
RUN="smoke-$(date +%s)"
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; pass=$((pass+1)); else echo "  FAIL $1: expected $2 got $3"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' -m 20 "$@"; }

echo "== $BASE"
check "healthz"                 200 "$(code $BASE/healthz)"
check "schema without key"      401 "$(code $BASE/v1/feedback/schema)"
check "schema with app key"     200 "$(code -H "$APP" $BASE/v1/feedback/schema)"
check "admin with app key"      401 "$(code -H "$APP" $BASE/v1/admin/features)"
check "admin with admin key"    200 "$(code -H "$ADM" $BASE/v1/admin/features)"
FEATS=$(curl -s -H "$APP" $BASE/v1/feedback/schema | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).features.map(f=>f.key+':'+f.issue_categories.length).join(',')")
check "schema features"         "home:3,sleep:4,activity:5,workout:8,other:9" "$FEATS"

BODY='{"is_positive":false,"occurred_on":"2026-09-01","user_id":900002,"email":"'"$RUN"'@luna-test.invalid","issue_categories":["incorrect_sleep"],"feedback_text":"remote smoke","details":{"actual_start_time":"11:30 pm","actual_end_time":"6:45 AM"},"client":{"app_version":"2.4.0","build_channel":"stage"}}'
RESP=$(curl -s -m 20 -X POST -H "$APP" -H "$J" -H "Idempotency-Key: $RUN" $BASE/v1/feedback/sleep -d "$BODY")
ID=$(echo "$RESP" | node -pe "try{JSON.parse(require('fs').readFileSync(0,'utf8')).id}catch(e){''}")
check "POST sleep created"      36 "${#ID}"
IST=$(echo "$RESP" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).created_at_ist.slice(-6)")
check "created_at_ist offset"   "+05:30" "$IST"
TIMES=$(echo "$RESP" | node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8')).details;d.actual_start_time+'/'+d.actual_end_time")
check "times normalised"        "11:30 PM/06:45 AM" "$TIMES"
check "POST replay idempotent"  200 "$(code -X POST -H "$APP" -H "$J" -H "Idempotency-Key: $RUN" $BASE/v1/feedback/sleep -d "$BODY")"
check "POST invalid → 422"      422 "$(code -X POST -H "$APP" -H "$J" $BASE/v1/feedback/home -d '{"is_positive":true,"occurred_on":"2026-02-30","user_id":1,"email":"x@y.z","issue_categories":["nope"]}')"
check "POST unknown feature"    404 "$(code -X POST -H "$APP" -H "$J" $BASE/v1/feedback/nutrition -d "$BODY")"
check "GET by id"               200 "$(code -H "$APP" $BASE/v1/feedback/$ID)"
check "GET list filter"         1   "$(curl -s -H "$APP" "$BASE/v1/feedback?user_id=900002&feature=sleep" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).items.length")"

CAT=$(curl -s -m 20 -X POST -H "$ADM" -H "$J" $BASE/v1/admin/features/home/issue-categories -d '{"key":"zz_smoke_remote","label":"Smoke","sort_order":99}')
CID=$(echo "$CAT" | node -pe "try{JSON.parse(require('fs').readFileSync(0,'utf8')).id}catch(e){''}")
check "admin add category"      36 "${#CID}"
check "new category in schema"  yes "$(curl -s -H "$APP" $BASE/v1/feedback/schema/home | grep -q zz_smoke_remote && echo yes || echo no)"
check "deactivate category"     200 "$(code -X PATCH -H "$ADM" -H "$J" $BASE/v1/admin/issue-categories/$CID -d '{"is_active":false}')"
check "hidden after deactivate" no  "$(curl -s -H "$APP" $BASE/v1/feedback/schema/home | grep -q zz_smoke_remote && echo yes || echo no)"

echo "== cleanup (direct DB)"
node -e "
import('dotenv/config').then(async()=>{const pg=(await import('pg')).default;const c=new pg.Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false}});await c.connect();
const a=await c.query(\"delete from luna_feedback.submissions where email like '%@luna-test.invalid'\");
const b=await c.query(\"delete from luna_feedback.issue_categories where key='zz_smoke_remote'\");
console.log('  removed submissions:',a.rowCount,'categories:',b.rowCount);await c.end();})"
echo "== $pass passed, $fail failed"; [ $fail -eq 0 ]
