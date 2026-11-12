#!/usr/bin/env bash
# Tandem prod probe - SILENT when all green; prints ONLY anomaly lines (no_agent cron).
# 24/7 cadence - every check runs on every pass (machine intervals only, no hour-of-day logic).
# Versioned at scripts/tandem-prod-probe.sh in the repo; this profile copy is a deploy of
# that file. Targets are env-overridable; defaults are the live prod values.
PROFILE_DIR="${TANDEM_PROFILE_DIR:-/root/.hermes/profiles/nampa}"
PROBE_STATE="${TANDEM_PROBE_STATE:-$PROFILE_DIR/cron/output/tandem}"
CT_KEY="${TANDEM_CT_KEY:-/root/.ssh/tandem_ct102}"
CT_ADDR="${TANDEM_CT_ADDR:-root@100.64.0.3}"
GH_BIN=$(command -v gh 2>/dev/null || echo /usr/sbin/gh)
if [ -n "${TANDEM_CT_ADDR:-}" ] && [ "${TANDEM_CT_ADDR}" != "root@100.64.0.3" ] && [ -z "${TANDEM_PROBE_STATE:-}" ]; then
  echo "probe: non-default TANDEM_CT_ADDR requires TANDEM_PROBE_STATE (inspection run must not write the prod trail)" >&2
  exit 2
fi
mkdir -p "$PROBE_STATE" 2>/dev/null || true
CT=(ssh -i "$CT_KEY" -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$CT_ADDR")
# Epoch stamps: settings retention stamps are epoch **ms**; probe math is seconds.
to_epoch_s() { case "${1:-}" in ''|*[!0-9]*) echo 0 ;; *) if [ "$1" -gt 100000000000 ]; then echo $(( $1 / 1000 )); else echo "$1"; fi ;; esac; }
# GATING-BLOCK predicate (#419/#424), factored so --selfcheck can exercise its gating and
# every block-shaped arm shares ONE copy of the clause: the block branch is added only
# when the origin columns exist AND the image's sweeps heal that shape (>= 2.78.20).
# $1 = prod version (may be empty), $2 = origin-column count. Empty = branch omitted.
own_block_predicate() {
  if [ "${2:-}" = "2" ] && [ -n "${1:-}" ] && [ "$(printf '%s\n%s\n' 2.78.20 "${1}" | sort -V | tail -1)" = "${1}" ]; then
    printf "%s" "(s.category = 'paused' and t.park_from_status is null and t.pre_block_status is not null and exists (select 1 from task_statuses o where o.id = t.pre_block_status and o.category = 'in_review'))"
  fi
}
# OWNERSHIP predicate for the stranded-round arms (#419): in_review, plus — when the
# image can heal it — a review-flow-owned PAUSED gating auto-block (origin column set,
# no park origin, recorded home resolving to in_review). $1 = prod version, $2 = columns.
own_predicate() {
  if [ -n "$(own_block_predicate "${1:-}" "${2:-}")" ]; then
    printf "%s" "(s.category = 'in_review' or $(own_block_predicate "${1:-}" "${2:-}"))"
  else
    printf "%s" "s.category = 'in_review'"
  fi
}
# The 5f strand-shape SQL, factored so the live pass, --selfcheck and --strand-sql share
# ONE copy: the arms' regression test executes exactly these bytes against a seeded test
# database, so the detector is pinned by the SQL that ships, never a test-side copy.
# #424: the wedge arm's inner set gains the gating-block branch — a block recording an
# in-review home whose CURRENT round is closed (no PENDING row in max(round), at least
# one verdict row in it) is a lost settle flip. It needs no updated_at discriminator:
# every legal exit clears both machine origins, a park carries park_from_status, and a
# settle re-blocks from the LANDED status (never from an in-review home).
strand_sql() {
  local own blkarm
  own=$(own_predicate "${1:-}" "${2:-}")
  blkarm=""
  if [ -n "$(own_block_predicate "${1:-}" "${2:-}")" ]; then
    blkarm=" union select distinct t.id from tasks t join task_statuses s on s.id = t.status where $(own_block_predicate "${1:-}" "${2:-}") and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id))"
  fi
  printf "%s" "select 'wedge', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status where s.category = 'in_review' and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING') and (select max(coalesce(r.decided_at, r.created_at)) from task_reviews r where r.task_id = t.id) > t.updated_at${blkarm}) x), 'none') union all select 'strand', coalesce(string_agg(t.id::text, ',' order by t.id), 'none') from tasks t join task_statuses s on s.id = t.status where s.category = 'waiting_answer' and not exists (select 1 from task_obligations o where o.task_id = t.id and o.role = 'ANSWER' and o.status = 'PENDING') and (select max(coalesce(o.resolved_at, o.created_at)) from task_obligations o where o.task_id = t.id and o.role = 'ANSWER') > t.updated_at union all select 'orphanans', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_obligations o on o.task_id = t.id where s.category = 'waiting_answer' and o.role = 'ANSWER' and o.status = 'PENDING' and o.employee_id is null and not exists (select 1 from task_obligations o2 where o2.task_id = t.id and o2.role = 'ANSWER' and o2.status = 'PENDING' and o2.employee_id is not null)) x), 'none') union all select 'stallrv', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_reviews r on r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null join ai_employees a on a.user_id = r.reviewer_id where $own and r.round = (select max(r2.round) from task_reviews r2 where r2.task_id = t.id) and r.created_at < now() - interval '5 minutes' and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.status = 'RUNNING') and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.employee_id = r.reviewer_id and tr.started_at >= r.created_at)) x), 'none') union all select 'lostsettle', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_reviews r on r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null join ai_employees a on a.user_id = r.reviewer_id where $own and (t.assignee_id is null or r.reviewer_id <> t.assignee_id) and r.round = (select max(r2.round) from task_reviews r2 where r2.task_id = t.id) and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.status = 'RUNNING') and exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.employee_id = r.reviewer_id and tr.status = 'DONE' and tr.started_at >= r.created_at and tr.finished_at < now() - interval '2 minutes' and not exists (select 1 from task_runs tr2 join task_messages tm2 on tm2.id = tr2.message_id where tm2.task_id = t.id and tr2.employee_id = r.reviewer_id and (tr2.started_at, tr2.id) > (tr.started_at, tr.id)))) x), 'none')"
}
if [ "${1:-}" = "--selfcheck" ]; then
  [ "$(own_predicate 2.78.19 2)" = "s.category = 'in_review'" ] || { echo "selfcheck fail: own floor"; exit 1; }
  [ "$(own_predicate 2.78.20 2)" != "s.category = 'in_review'" ] || { echo "selfcheck fail: own block branch"; exit 1; }
  [ "$(own_predicate 3.0.0 2)" != "s.category = 'in_review'" ] || { echo "selfcheck fail: own major"; exit 1; }
  [ "$(own_predicate 2.78.20 1)" = "s.category = 'in_review'" ] || { echo "selfcheck fail: own column gate"; exit 1; }
  [ "$(own_predicate '' 2)" = "s.category = 'in_review'" ] || { echo "selfcheck fail: own empty version"; exit 1; }
  [ -z "$(own_block_predicate 2.78.19 2)" ] || { echo "selfcheck fail: block floor"; exit 1; }
  [ -n "$(own_block_predicate 2.78.20 2)" ] || { echo "selfcheck fail: block on"; exit 1; }
  [ -z "$(own_block_predicate 2.78.20 1)" ] || { echo "selfcheck fail: block column gate"; exit 1; }
  [ -z "$(own_block_predicate '' 2)" ] || { echo "selfcheck fail: block empty version"; exit 1; }
  STR_ON=$(strand_sql 2.78.20 2); STR_OFF=$(strand_sql 2.78.19 2)
  printf '%s' "$STR_ON" | grep -qF "park_from_status is null" || { echo "selfcheck fail: strand block branch"; exit 1; }
  printf '%s' "$STR_ON" | grep -qF "r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')" || { echo "selfcheck fail: strand decided rows"; exit 1; }
  printf '%s' "$STR_ON" | grep -qF "select 'wedge'" || { echo "selfcheck fail: strand wedge arm"; exit 1; }
  printf '%s' "$STR_ON" | grep -qF "select 'lostsettle'" || { echo "selfcheck fail: strand lostsettle arm"; exit 1; }
  printf '%s' "$STR_OFF" | grep -qF "park_from_status" && { echo "selfcheck fail: strand block branch not gated"; exit 1; }
  printf '%s' "$STR_OFF" | grep -qF "select 'wedge'" || { echo "selfcheck fail: strand wedge floor"; exit 1; }
  [ "$(to_epoch_s 1793957516932)" = "1793957516" ] || { echo "selfcheck fail: epoch ms"; exit 1; }
  [ "$(to_epoch_s 1793957516)" = "1793957516" ] || { echo "selfcheck fail: epoch s"; exit 1; }
  printf 'img unhealthy\n' | grep -qw healthy && { echo "selfcheck fail: unhealthy matched healthy"; exit 1; }
  printf 'img healthy\n' | grep -qw healthy || { echo "selfcheck fail: healthy missed"; exit 1; }
  echo "ok probe selfcheck"
  exit 0
fi
if [ "${1:-}" = "--strand-sql" ]; then
  # emit the exact 5f strand SQL for an explicit (version, origin-column-count) pair:
  # the arms' regression test seeds a test DB and runs these bytes (no network, no state)
  strand_sql "${2:-}" "${3:-}"
  printf '\n'
  exit 0
fi
# overlap window = since the last overlap fix; update by: date -u '+%F %H:%M+00' > <marker>
OVS_RAW=$(cat "$PROBE_STATE/overlap-since" 2>/dev/null)
if OVS_TS=$(date -u -d "$OVS_RAW" +%s 2>/dev/null) && [ -n "$OVS_TS" ]; then
  OVS=$(date -u -d "@$OVS_TS" '+%F %H:%M+00')
else
  OVS='2026-10-30 02:55+00'
fi
anom=()
if ! { : > "$PROBE_STATE/.probe-write-test"; } 2>/dev/null; then
  anom+=("probe_state: unwritable ($PROBE_STATE — state-confirmed detectors + deploy window degraded)")
else
  rm -f "$PROBE_STATE/.probe-write-test"
fi

# 1. container health + image
IMG=$("${CT[@]}" 'docker inspect work-ultranomic-net-tandem-1 --format "{{.Config.Image}} {{.State.Health.Status}}" 2>/dev/null' 2>/dev/null) || IMG="container_inspect: failed (CT102 ssh or docker inspect — container missing?)"
echo "$IMG" | grep -qw healthy || anom+=("container: $IMG")

# 2. public + version
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://work.ultranomic.net/)
[ "$CODE" = "200" ] || anom+=("public=$CODE")
V=$(curl -s --max-time 10 -X POST https://work.ultranomic.net/rpc/meta/version | grep -o '[0-9]*\.[0-9]*\.[0-9]*' | head -1)
[ -z "$V" ] && anom+=("version_rpc: unreadable (no semver from POST /rpc/meta/version — version/retention/stranded arms degraded)")
TAG=$("$GH_BIN" release view --repo namhtpyn/tandem --json tagName --jq .tagName 2>/dev/null | sed 's/^v//')
# Deploy-window guard (2026-10-31): the release train tags BEFORE the CT102 bump,
# so prod!=latest for the bump's duration is EXPECTED. The window is measured from
# the FIRST sighting of this mismatch (state file), never the tag's commit date —
# every tag in this repo is lightweight (creatordate == commit date, already old
# when tagged). Alert only when the mismatch persists >20 min (= stalled bump).
[ -n "$V" ] && [ -z "$TAG" ] && anom+=("tag_oracle: unavailable (gh release view failed — version-drift check blind)")
DEPLOYWIN=""
if [ -n "$V" ] && [ -n "$TAG" ]; then
  if [ "$V" = "$TAG" ]; then
    rm -f "$PROBE_STATE/version-mismatch-since"
  else
    MISM="$PROBE_STATE/version-mismatch-since"
    [ -f "$MISM" ] || date -u +%s > "$MISM" 2>/dev/null
    MISINCE=$(cat "$MISM" 2>/dev/null)
    case "$MISINCE" in ''|*[!0-9]*) MISINCE=0 ;; esac
    NOWS=$(date -u +%s)
    [ "$MISINCE" -gt "$NOWS" ] && MISINCE=$NOWS
    MAGE=$(( NOWS - MISINCE ))
    if [ "$MAGE" -gt 1200 ]; then
      anom+=("version: prod=$V latest=$TAG (mismatch ${MAGE}s)")
    else
      DEPLOYWIN="version: prod=$V latest=$TAG (mismatch ${MAGE}s — deploy window, suppressed)"
    fi
  fi
fi

# 3. run hygiene (one psql pass)
# ghostset (#147): RUNNING rows past the run_timeout_ms SETTING + 5 min margin —
# mirrors the reaper's WHERE (settings-aware, never a fixed interval; 30 min default
# fallback when the setting is absent/unparseable). Replaced the old fixed-40min
# 'stale' count: that shape false-alarmed a legitimately long configured run.
SQL="with t as (select coalesce((select nullif(regexp_replace(value, '[^0-9]', '', 'g'), '')::bigint from settings where key='run_timeout_ms' limit 1), 1800000) as ms) select 'ghostset', coalesce(string_agg(r.id::text, ',' order by r.id), 'none') from task_runs r, t where r.status='RUNNING' and r.started_at < now() - make_interval(secs => (t.ms + 300000) / 1000.0) union all select 'overlap', count(*)::text from task_runs a join task_runs b on a.employee_id=b.employee_id and a.id<b.id where a.started_at > now() - interval '3 hours' and b.started_at > now() - interval '3 hours' and a.started_at < coalesce(b.finished_at, now()) and b.started_at < coalesce(a.finished_at, now()) and a.started_at > '$OVS' union all select 'dangling', count(*)::text from tasks t where not exists (select 1 from task_statuses s where s.id = t.status) union all select 'fails6h', count(*)::text from task_runs where status='FAILED' and started_at > now() - interval '6 hours' union all select 'oidc_plain', count(*)::text from settings where key='oidc_providers' and value not like 'v1:%' union all select 'stranded', count(*)::text from tasks t join task_statuses s on s.id = t.status and s.category = 'working' join ai_employees ae on ae.user_id = t.assignee_id where not exists (select 1 from task_runs r join task_messages m on m.id = r.message_id where m.task_id = t.id and (r.status = 'RUNNING' or coalesce(r.finished_at, t.updated_at) > now() - interval '25 minutes')) and t.updated_at < now() - interval '25 minutes' union all select 'disp_hb', case when v.ts is null then 'absent' when v.ts < (extract(epoch from now())::bigint - 120) * 1000 then 'stale ' || (((extract(epoch from now())::bigint * 1000 - v.ts) / 1000)::int)::text else 'ok' end from (select nullif(regexp_replace(value, '[^0-9]', '', 'g'), '')::bigint as ts from settings where key='dispatcher_last_tick' limit 1) v union all select 'phantomob', count(*)::text from task_obligations o join tasks t on t.id = o.task_id join task_statuses s on s.id = t.status where o.status = 'PENDING' and s.category in ('done','cancelled') union all select 'redis_hb', case when v.ts is null then 'absent' when v.ts < (extract(epoch from now())::bigint - 120) * 1000 then 'stale ' || (((extract(epoch from now())::bigint * 1000 - v.ts) / 1000)::int)::text else 'ok' end from (select nullif(regexp_replace(value, '[^0-9]', '', 'g'), '')::bigint as ts from settings where key='dispatcher_redis_ok' limit 1) v;"
PSQLERR=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$SQL\"" 2>&1 >/dev/null | grep -m1 ERROR)
OUT=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$SQL\"" 2>/dev/null) || OUT="db-unreachable"
if echo "$OUT" | grep -q db-unreachable; then anom+=("db: unreachable ${PSQLERR:-psql failed}"); fi
# ghost RUNNING rows (#147): 2-consecutive rule (a legitimately mid-cycle long run
# never pings on one pass), deduped by run-id fingerprint set (an unchanged ghost
# set re-alerts nothing; a CHANGED set re-alerts with the new ids).
GHOSTS=$(echo "$OUT" | awk -F'|' '/^ghostset/{print $2}')
if [ -n "$GHOSTS" ] && [ "$GHOSTS" != "none" ]; then
  PREV=$(cat "$PROBE_STATE/ghost-runs.prev" 2>/dev/null || echo none)
  if [ "$PREV" != "none" ]; then
    if [ "$(cat "$PROBE_STATE/ghost-runs.alerted" 2>/dev/null || echo none)" != "$GHOSTS" ]; then
      anom+=("ghost_running: $GHOSTS (past run_timeout+5m, 2 consecutive passes)")
      echo "$GHOSTS" > "$PROBE_STATE/ghost-runs.alerted"
    fi
  fi
  echo "$GHOSTS" > "$PROBE_STATE/ghost-runs.prev"
else
  echo "none" > "$PROBE_STATE/ghost-runs.prev"
  rm -f "$PROBE_STATE/ghost-runs.alerted"
fi
OVL=$(echo "$OUT" | awk -F'|' '/^overlap/{print $2}')
DANG=$(echo "$OUT" | awk -F'|' '/^dangling/{print $2}'); F6=$(echo "$OUT" | awk -F'|' '/^fails6h/{print $2}')
[ "${OVL:-0}" != "0" ] && anom+=("overlapping_runs=$OVL (post-fix window)")
[ "${F6:-0}" -gt 2 ] 2>/dev/null && anom+=("failed_runs_6h=$F6")
[ "${DANG:-0}" -gt 1 ] && anom+=("dangling_status=$DANG (issue #62 tracks 1)")
OIDCP=$(echo "$OUT" | awk -F'|' '/^oidc_plain/{print $2}')
[ "${OIDCP:-0}" != "0" ] && anom+=("oidc_plaintext_row=1 (issue #61 relic is back)")

# 5b. parked-round re-arm ladder (#211): an infra-class park whose re-arm ladder burnt
# (park_rearm_attempts >= 5 = ladder length 4 + final park, still BLOCKED with a park
# origin) is a round the machine TRIED to heal and could not — frozen silently is the
# exact wedge class #211 bans. Separate psql pass, NOT an arm of the main UNION: a
# pre-2.62.6 image has no park_rearm columns and one bad arm would kill every check
# (the UNION-type law). Column-absent guard skips silently on the old image.
PRSQL="select coalesce(string_agg(t.id::text, ',' order by t.id), 'none') from tasks t join task_statuses s on s.id = t.status where s.category = 'paused' and t.park_from_status is not null and t.park_rearm_attempts >= 5"
PRCOL=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"select count(*) from information_schema.columns where table_name='tasks' and column_name='park_rearm_attempts'\"" 2>/dev/null) || PRCOL="guard-error"
if [ "$PRCOL" = "guard-error" ]; then
  anom+=("parkrearm_guard: column probe failed — detector blind")
elif [ "$PRCOL" = "1" ]; then
  PRERR=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$PRSQL\"" 2>&1 >/dev/null | grep -m1 ERROR)
  PRVAL=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$PRSQL\"" 2>/dev/null) || PRVAL="db-unreachable"
  if [ "$PRVAL" = "db-unreachable" ]; then
    anom+=("parkrearm: unreachable ${PRERR:-psql failed}")
  elif [ -n "$PRVAL" ] && [ "$PRVAL" != "none" ] && [ "$PRVAL" != "0" ]; then
    anom+=("parkrearm: exhausted parked round(s) [$PRVAL] — re-arm ladder burnt, frozen silently")
  fi
fi

# 5c. verdict-less review parks (#276): 'review parked — review finished without a
# verdict after a re-dispatch' reaching 2 in 24h is the review-contract compliance
# signal (reviewers repeatedly failing the envelope contract despite the corrected
# re-dispatch brief). Separate psql pass — one bad arm must never kill the main
# UNION (probe law #4).
VLSQL="select count(*) from task_messages where body like '%finished without a verdict after a re-dispatch%' and created_at > now() - interval '24 hours'"
VLERR=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$VLSQL\"" 2>&1 >/dev/null | grep -m1 ERROR)
VL=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$VLSQL\"" 2>/dev/null) || VL="db-unreachable"
if [ "$VL" = "db-unreachable" ]; then
  anom+=("vless_parks: unreachable ${VLERR:-psql failed}")
elif [ "${VL:-0}" -ge 2 ] 2>/dev/null; then
  anom+=("vless_parks=$VL in 24h (verdict-less review parks — review-contract compliance, #276)")
fi

# 5d. channel health (#271 slice 3): settings channels:health — the service stamps
# {stampedAt, channels:[{key,kind,homeserverUrl,connected,healthCap,healthOk,
# lastSyncOkAt}]} every 60s. Separate psql pass (probe law #4); ABSENT key =
# pre-slice image / no channels → silent (chan_stamp 'absent'). Alert classes
# per SPEC: stamp stale (tick dead), connected:false (adapter down/dead-token/
# config dropped), transport stale (connected+capable+read-ok, lastSyncOkAt
# >300s old), capable never-synced (null, 2-consecutive rule = grace), backlog
# (unprocessed events+outbox rows, DB-derived, oldest >30 min).
CHSQL="with h as (select value from settings where key='channels:health' limit 1), nm as (select (extract(epoch from now())::bigint * 1000) as ts from (select 1) x) select 'chan_stamp', case when (select value from h) is null then 'absent' when ((select value from h)::jsonb->>'stampedAt')::bigint < (select ts - 600000 from nm) then 'stale' else 'ok' end from (select 1) z union all select 'chan_down', coalesce((select count(*)::text from h, jsonb_array_elements(h.value::jsonb->'channels') c where (c->>'connected')::boolean is false), '0') union all select 'chan_sync_stale', coalesce((select count(*)::text from h, jsonb_array_elements(h.value::jsonb->'channels') c where (c->>'connected')::boolean is true and (c->>'healthCap')::boolean is true and (c->>'healthOk')::boolean is true and (c->>'lastSyncOkAt') is not null and (c->>'lastSyncOkAt')::bigint < (select ts - 300000 from nm)), '0') union all select 'chan_neversync', coalesce((select count(*)::text from h, jsonb_array_elements(h.value::jsonb->'channels') c where (c->>'connected')::boolean is true and (c->>'healthCap')::boolean is true and (c->>'healthOk')::boolean is true and (c->>'lastSyncOkAt') is null), '0') union all select 'chan_backlog', (select count(*) from channel_events where processed_at is null)::text || '+' || (select count(*) from channel_outbox where processed_at is null)::text || '+' || coalesce((select max(extract(epoch from (now()-oldest)))::int from (select received_at as oldest from channel_events where processed_at is null union all select created_at as oldest from channel_outbox where processed_at is null) u), 0)::text"
CHERR=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$CHSQL\"" 2>&1 >/dev/null | grep -m1 ERROR)
CHOUT=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$CHSQL\"" 2>/dev/null) || CHOUT="db-unreachable"
if [ "$CHOUT" = "db-unreachable" ]; then
  anom+=("chanhealth: unreachable ${CHERR:-psql failed}")
else
  CHS=$(echo "$CHOUT" | awk -F'|' '/^chan_stamp/{print $2}')
  case "$CHS" in
    stale*) anom+=("channels_stamp_stale (>600s — channels health tick dead, #271)") ;;
  esac
  CHD=$(echo "$CHOUT" | awk -F'|' '/^chan_down/{print $2}')
  [ "${CHD:-0}" -gt 0 ] 2>/dev/null && anom+=("channels_down=$CHD (connected:false — adapter down/dead-token/parse-dropped config, #271)")
  CSS=$(echo "$CHOUT" | awk -F'|' '/^chan_sync_stale/{print $2}')
  [ "${CSS:-0}" -gt 0 ] 2>/dev/null && anom+=("channels_transport_stale=$CSS (lastSyncOkAt >300s old — sync loop alive, homeserver unreachable, #271)")
  # capable never-synced (null): grace via 2-consecutive rule (a boot tick can
  # transiently see null before the first poll lands)
  CNS=$(echo "$CHOUT" | awk -F'|' '/^chan_neversync/{print $2}')
  if [ "${CNS:-0}" -gt 0 ] 2>/dev/null; then
    PREV_CNS=$(cat "$PROBE_STATE/chan-neversync.prev" 2>/dev/null || echo 0)
    if [ "${PREV_CNS:-0}" -gt 0 ] 2>/dev/null; then
      anom+=("channels_never_synced=$CNS (capable+read-ok+null, 2 consecutive passes — start ok, transport never completed a poll, #271)")
    fi
    echo "$CNS" > "$PROBE_STATE/chan-neversync.prev"
  else
    echo 0 > "$PROBE_STATE/chan-neversync.prev"
  fi
  CBL=$(echo "$CHOUT" | awk -F'|' '/^chan_backlog/{print $2}')
  BLN=$(echo "$CBL" | awk -F'+' '{print $1+$2}')
  BLA=$(echo "$CBL" | awk -F'+' '{print $3}')
  if [ "${BLN:-0}" -gt 0 ] 2>/dev/null && [ "${BLA:-0}" -gt 1800 ] 2>/dev/null; then
    anom+=("channels_backlog=$BLN rows oldest=${BLA}s (deferral parity holds them — adapter down or pipeline wedge, #271)")
  fi
fi

# 5e. retention watchdog (#266, margin-keyed on mechanisms — never raw state):
# Two arms, both heartbeat-shaped:
# (a) NOT RUNNING: retention_last_attempt absent past a 1h post-deploy grace
#     (since-version file mtime) or older than 25h -> the tick is not invoking
#     the leg (or the leg's settings read dies before its first write).
# (b) RUNS BUT NEVER COMPLETES: attempt fresh (<25h) while retention_last_run
#     is absent or older than 25h -> passes start and keep failing.
# The past-horizon retained COUNT is operational data, never an alarm (a backlog
# larger than one day's 500-row batch legally drains over several days; inflow
# above the batch is a capacity decision) — no count-keyed alert by design.
# Separate psql pass (probe law #4); SCHEMA-SYMMETRY: columns verified against
# the live schema (task_runs.status/finished_at/output/prompt, task_messages.
# task_id, tasks.status, task_statuses.category, settings.value).
RETFLOOR=2.74.0
if [ -n "$V" ] && [ "$(printf '%s\n%s\n' "$RETFLOOR" "$V" | sort -V | tail -1)" = "$V" ]; then
  # first sight of a post-retention image: start the deploy grace now, silent
  if [ ! -f "$PROBE_STATE/retention-since-version" ]; then printf '%s\n' "$V" > "$PROBE_STATE/retention-since-version"; fi
  RTSINCE=$(stat -c %Y "$PROBE_STATE/retention-since-version" 2>/dev/null || echo 0)
  RTSQL="select (select coalesce(nullif(regexp_replace(value, '[^0-9]', '', 'g'), ''), '0')::bigint from settings where key='retention_last_run' limit 1), (select coalesce(nullif(regexp_replace(value, '[^0-9]', '', 'g'), ''), '0')::bigint from settings where key='retention_last_attempt' limit 1), (select count(*) from task_runs r join task_messages m on m.id = r.message_id join tasks t on t.id = m.task_id join task_statuses s on s.id = t.status where r.status <> 'RUNNING' and r.finished_at < now() - interval '30 days' and s.category in ('done','cancelled') and (r.output <> '' or r.prompt is not null))"
  RTERR=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$RTSQL\"" 2>&1 >/dev/null | grep -m1 ERROR)
  RTOUT=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$RTSQL\"" 2>/dev/null) || RTOUT="db-unreachable"
  if [ "$RTOUT" = "db-unreachable" ]; then
    anom+=("retention: unreachable ${RTERR:-psql failed}")
  else
    RTSTAMP=$(to_epoch_s "$(echo "$RTOUT" | awk -F'|' '{print $1}')")
    RTATT=$(to_epoch_s "$(echo "$RTOUT" | awk -F'|' '{print $2}')")
    RT=$(echo "$RTOUT" | awk -F'|' '{print $3}')
    NOWS=$(date +%s)
    # arm (a): not running — absent past the deploy grace, or stale past 25h
    if [ "${RTATT:-0}" -eq 0 ] 2>/dev/null; then
      if [ "$RTSINCE" -gt 0 ] 2>/dev/null && [ $((NOWS - RTSINCE)) -gt 3600 ] 2>/dev/null; then
        anom+=("retention_never_ticked (no attempt stamp >1h after the post-retention deploy — leg not wired/ticking, #266)")
      fi
    elif [ "$RTATT" -lt $((NOWS - 90000)) ] 2>/dev/null; then
      anom+=("retention_attempt_stale=$(( (NOWS - RTATT) / 3600 ))h (>25h — daily retention leg stopped running, #266)")
    # arm (b): runs but never completes — attempts fresh, run stamp absent
    # PERSISTENTLY (>1h since first seen: a first pass in flight is legal; a
    # leg whose every pass fails is not) or stale past 25h
    elif [ "${RTSTAMP:-0}" -eq 0 ] 2>/dev/null; then
      RNW="$PROBE_STATE/retention-never-ran-since"
      if [ -f "$RNW" ]; then
        RNWT=$(cat "$RNW" 2>/dev/null || echo 0)
        if [ "$RNWT" -gt 0 ] 2>/dev/null && [ $((NOWS - RNWT)) -gt 3600 ] 2>/dev/null; then
          anom+=("retention_never_completes (attempts fresh but NO full pass in >1h — every pass failing, #266)")
        fi
      else
        printf '%s\n' "$NOWS" > "$RNW"
      fi
    elif [ "$RTSTAMP" -lt $((NOWS - 90000)) ] 2>/dev/null; then
      anom+=("retention_never_completes (attempts fresh, last full pass >25h — every pass failing, #266)")
    else
      rm -f "$PROBE_STATE/retention-never-ran-since"
    fi
    # count recorded for ops visibility only — never alert-keyed (#266)
    printf '%s %s\n' "$NOWS" "${RT:-0}" >> "$PROBE_STATE/retention-history"
    tail -200 "$PROBE_STATE/retention-history" > "$PROBE_STATE/retention-history.tmp" 2>/dev/null && mv "$PROBE_STATE/retention-history.tmp" "$PROBE_STATE/retention-history"
  fi
fi

# 5f. strand shapes — watchdog coverage for the shipped bug classes that no other
# check covers (watchlist "candidate probe" entries, probed 2026-11-06):
#   (a) DEAD-ROUND WEDGE (#292 class): an in_review-category task with NO PENDING
#       review row whose newest verdict landed AFTER the task's last write — the
#       round opened, every row left PENDING, and the task never left in_review
#       (round-open teardown / settle-arbitration regressions). The
#       newest-verdict-after-last-write invariant is what separates the machine
#       wedge from a LEGAL manual move into in_review (the human re-open bumps
#       tasks.updated_at past every verdict, so it never matches) and from a live
#       round (PENDING rows exist).
#       BLOCK BRANCH (#424): the same wedge can strand a task in a child-derived
#       gating auto-block — #419 keeps the round running there, so a kill between
#       recordVerdict's row write and flipTask leaves a PAUSED block (origin
#       resolving to in_review, no park origin) with a CLOSED current round: no
#       PENDING row in max(round) and at least one verdict row in it. That branch
#       needs no updated_at discriminator — every legal exit clears both machine
#       origins (a hand-made block, an owner move), a park carries park_from_status,
#       and a settle re-blocks from the LANDED status, never from an in-review home
#       — while a block whose round still holds a PENDING row is a live round.
#   (b) WAITING-ANSWER STRAND (#314 class): a waiting_answer-category task with no
#       PENDING ANSWER obligation whose newest ANSWER resolution landed AFTER the
#       task's last write — the flow's obligation was cancelled/resolved without
#       the status moving (the answerQuestion cancel-before-CAS race #314 closed).
#       The same invariant excludes manual parks (the park write is newest) and
#       live questions (PENDING row).
#   (c) ANSWER-HOLDER ORPHAN (#369 class): a waiting_answer-category task whose only
#       PENDING ANSWER obligation has a NULL holder — the FK set-null signature of
#       an employee delete whose return arm never ran. No legal write path produces
#       it (ask/forward always name a holder), so it needs no manual-freedom
#       discriminator. The removal/boot heal returns the task; a surviving count
#       means the heal itself is broken.
#   (d) STALLED REVIEW TURN (#397 class): a task the review flow still owns — an
#       in_review-category status, or a PAUSED GATING auto-block whose recorded origin
#       resolves to in_review (#419: a child-derived block does not stop the round, and a
#       parked round never matches) — holding a PENDING AI reviewer row in its CURRENT
#       round with NO RUNNING run on the task and no run opened for that reviewer since
#       the row was minted, older than 5 min — the crash window between the round-open
#       transaction and the reviewer turn (#394 moved the dispatch after the commit). The tick sweep re-fires it within seconds, so a
#       surviving shape means the sweep itself is broken. No legal write path produces
#       it: a human verdict moves the row off PENDING, a live turn has its run row, and a
#       reviewer that already had a turn is excluded by the run-since-row predicate.
#   (e) LOST SETTLE (#402 class): the same review-flow-owned task (in_review, or a
#       PAUSED block from an in-review origin, #419) holding a PENDING AI
#       reviewer row in its CURRENT round whose NEWEST run in that round is DONE,
#       finished >2 min ago, with no live run on the task — the crash/deploy window
#       between finish()'s guarded RUNNING→DONE write and its settle. The tick's
#       settle-replay arm heals it within seconds, so a surviving shape means the arm
#       itself is broken. No legal write path produces it: a human verdict moves the
#       row off PENDING, a landed settle either resolves the row or mints the next turn
#       (a later run), and a live turn has its RUNNING row. The reviewer-is-not-the-
#       assignee clause keeps a WORK run (always minted for the assignee) out of the arm.
#       The sweep heals within ~1 min; the arm's 2-min window means a surviving shape is
#       a broken sweep, not a slow one.
# Two-pass confirm then id-set dedupe, mirroring ghostset: both shapes are illegal
# states, not slow ones, so 10 min apart is already persistence. Separate psql pass
# (probe law #4) + to_regclass guard for pre-review images (column-absent law).
# SCHEMA-SYMMETRY (probe law #5): task_statuses.category, task_reviews.task_id/
# status/decided_at/created_at, task_obligations.task_id/role/status/resolved_at/
# created_at, task_runs.status/employee_id/started_at, task_messages.task_id,
# ai_employees.user_id, tasks.status/updated_at, task_runs.finished_at/id — all
# verified against the live schema.
STRCOL=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"select (to_regclass('task_reviews') is not null and to_regclass('task_obligations') is not null)::int\"" 2>/dev/null) || STRCOL="guard-error"
# OWNERSHIP predicate (#419): the stranded-round arms cover a task the review flow still
# owns — in_review, plus (from 2.78.20, whose sweeps heal that shape) a PAUSED gating
# auto-block whose recorded origin resolves to in_review. Both gates are load-bearing:
# pre-#401 images lack the two origin columns (column-absent law — one missing column
# kills the whole UNION), and a pre-#419 image cannot heal the block shape, so the arm
# must stay silent there rather than misattribute cause.
ORIGCOL=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"select count(*) from information_schema.columns where table_name='tasks' and column_name in ('park_from_status','pre_block_status')\"" 2>/dev/null) || ORIGCOL="guard-error"
OWN=$(own_predicate "$V" "$ORIGCOL")
if [ "$ORIGCOL" = "guard-error" ] && [ -n "$V" ] && [ "$(printf '%s\n%s\n' 2.78.20 "$V" | sort -V | tail -1)" = "$V" ]; then
  # the image can heal the block shape but the column probe failed: the arm is blind,
  # never silently degraded (sibling guards PRCOL/STRCOL alert the same way)
  anom+=("origcol_guard: column probe failed — #419 block detection blind")
fi
if [ "$STRCOL" = "guard-error" ]; then
  anom+=("strand_guard: column probe failed — detector blind")
elif [ "$STRCOL" = "1" ]; then
  STRSQL=$(strand_sql "$V" "$ORIGCOL")
  STRERR=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$STRSQL\"" 2>&1 >/dev/null | grep -m1 ERROR)
  STROUT=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$STRSQL\"" 2>/dev/null) || STROUT="db-unreachable"
  if [ "$STROUT" = "db-unreachable" ]; then
    anom+=("strand: unreachable ${STRERR:-psql failed}")
  else
    WEDGE=$(echo "$STROUT" | awk -F'|' '/^wedge/{print $2}')
    STRAND=$(echo "$STROUT" | awk -F'|' '/^strand/{print $2}')
    # (a) dead-round wedge: previous-pass presence confirm + id-set dedupe (mirrors ghostset)
    if [ -n "${WEDGE:-}" ] && [ "$WEDGE" != "none" ] && [ "$(cat "$PROBE_STATE/wedge.prev" 2>/dev/null || echo none)" != "none" ]; then
      if [ "$(cat "$PROBE_STATE/wedge.alerted" 2>/dev/null || echo none)" != "$WEDGE" ]; then
        anom+=("wedge_round: review-flow-owned task (in_review or gating block) with no PENDING review row [$WEDGE] — dead round, #292/#424 class")
        echo "$WEDGE" > "$PROBE_STATE/wedge.alerted"
      fi
    else
      rm -f "$PROBE_STATE/wedge.alerted"
    fi
    printf '%s\n' "${WEDGE:-none}" > "$PROBE_STATE/wedge.prev"
    # (b) waiting-answer strand: previous-pass presence confirm + id-set dedupe (mirrors ghostset)
    if [ -n "${STRAND:-}" ] && [ "$STRAND" != "none" ] && [ "$(cat "$PROBE_STATE/strand.prev" 2>/dev/null || echo none)" != "none" ]; then
      if [ "$(cat "$PROBE_STATE/strand.alerted" 2>/dev/null || echo none)" != "$STRAND" ]; then
        anom+=("wa_strand: waiting_answer with no PENDING ANSWER obligation [$STRAND] — stranded question, #314 class")
        echo "$STRAND" > "$PROBE_STATE/strand.alerted"
      fi
    else
      rm -f "$PROBE_STATE/strand.alerted"
    fi
    printf '%s\n' "${STRAND:-none}" > "$PROBE_STATE/strand.prev"
    # (c) answer-holder orphan: previous-pass presence confirm + id-set dedupe
    ORPHANANS=$(echo "$STROUT" | awk -F'|' '/^orphanans/{print $2}')
    if [ -n "${ORPHANANS:-}" ] && [ "$ORPHANANS" != "none" ] && [ "$(cat "$PROBE_STATE/orphanans.prev" 2>/dev/null || echo none)" != "none" ]; then
      if [ "$(cat "$PROBE_STATE/orphanans.alerted" 2>/dev/null || echo none)" != "$ORPHANANS" ]; then
        anom+=("answer_orphan: waiting_answer with a NULL-holder PENDING ANSWER obligation [$ORPHANANS] — removal heal did not run, #369 class")
        echo "$ORPHANANS" > "$PROBE_STATE/orphanans.alerted"
      fi
    else
      rm -f "$PROBE_STATE/orphanans.alerted"
    fi
    printf '%s\n' "${ORPHANANS:-none}" > "$PROBE_STATE/orphanans.prev"
    # (d) stalled review turn: previous-pass presence confirm + id-set dedupe (#397).
    # VERSION FLOOR: the sweep ships in 2.78.13 — on an older image the crash-window shape
    # is real and the sweep does not exist yet, so the arm stays silent (it would
    # misattribute cause) and leaves no state behind. The #419 block branch is gated in
    # OWN above (2.78.20), so this floor keeps the older in-review detector alive.
    STALLFLOOR=2.78.13
    STALL_ARM=0
    if [ -n "$V" ] && [ "$(printf '%s\n%s\n' "$STALLFLOOR" "$V" | sort -V | tail -1)" = "$V" ]; then STALL_ARM=1; fi
    if [ "$STALL_ARM" = "1" ]; then
      STALLRV=$(echo "$STROUT" | awk -F'|' '/^stallrv/{print $2}')
      if [ -n "${STALLRV:-}" ] && [ "$STALLRV" != "none" ] && [ "$(cat "$PROBE_STATE/stallrv.prev" 2>/dev/null || echo none)" != "none" ]; then
        if [ "$(cat "$PROBE_STATE/stallrv.alerted" 2>/dev/null || echo none)" != "$STALLRV" ]; then
          anom+=("stalled_review: review-flow-owned task (in_review or a child-derived auto-block) with a PENDING AI reviewer and no turn in flight [$STALLRV] — stalled-review sweep not re-firing, #397/#419 class")
          echo "$STALLRV" > "$PROBE_STATE/stallrv.alerted"
        fi
      else
        rm -f "$PROBE_STATE/stallrv.alerted"
      fi
      printf '%s\n' "${STALLRV:-none}" > "$PROBE_STATE/stallrv.prev"
    fi
    # (e) lost settle: previous-pass presence confirm + id-set dedupe (#402).
    # VERSION FLOOR: the replay sweep ships in 2.78.18 — on an older image a DONE run
    # whose settle was lost is real and nothing heals it yet, so the arm stays silent
    # (it would misattribute cause) and leaves no state behind. The #419 block branch is
    # gated in OWN above (2.78.20).
    LOSTFLOOR=2.78.18
    LOST_ARM=0
    if [ -n "$V" ] && [ "$(printf '%s\n%s\n' "$LOSTFLOOR" "$V" | sort -V | tail -1)" = "$V" ]; then LOST_ARM=1; fi
    if [ "$LOST_ARM" = "1" ]; then
      LOSTSETTLE=$(echo "$STROUT" | awk -F'|' '/^lostsettle/{print $2}')
      if [ -n "${LOSTSETTLE:-}" ] && [ "$LOSTSETTLE" != "none" ] && [ "$(cat "$PROBE_STATE/lostsettle.prev" 2>/dev/null || echo none)" != "none" ]; then
        if [ "$(cat "$PROBE_STATE/lostsettle.alerted" 2>/dev/null || echo none)" != "$LOSTSETTLE" ]; then
          anom+=("lost_settle: review-flow-owned task with a PENDING AI reviewer whose newest run is DONE >2min and unsettled [$LOSTSETTLE] — settle-replay sweep not healing, #402/#419 class")
          echo "$LOSTSETTLE" > "$PROBE_STATE/lostsettle.alerted"
        fi
      else
        rm -f "$PROBE_STATE/lostsettle.alerted"
      fi
      printf '%s\n' "${LOSTSETTLE:-none}" > "$PROBE_STATE/lostsettle.prev"
    fi
  fi
fi

# 6. stranded-working (#88): a working status must be run-backed — the liveness sweep
# (shipped >= $SWEEP_FLOOR) bounces idle working tasks within 15 min, so 25 min of
# stranding means the sweep itself stopped working. Threshold > sweep grace = no
# race with the sweep; version-gated so pre-sweep prod (1 known relic, healed at
# bump) never pings.
STR=$(echo "$OUT" | awk -F'|' '/^stranded/{print $2}')

# 8. phantom obligations (#205): a PENDING obligation on a settled (done/cancelled-
# category) task is un-actionable forever — the inbox/badge/queue project it but no
# verb can ever resolve it. Fixed in #205 (category-resolved teardown); this detects
# any regression or relic rows.
PHO=$(echo "$OUT" | awk -F'|' '/^phantomob/{print $2}')
[ "${PHO:-0}" -gt 0 ] && anom+=("phantom_obligations=$PHO (PENDING obligation on settled task, #205)")

SWEEP_FLOOR=2.55.2
if [ "${STR:-0}" -gt 0 ] 2>/dev/null && [ -n "$V" ] && [ "$(printf '%s\n%s\n' "$SWEEP_FLOOR" "$V" | sort -V | tail -1)" = "$V" ]; then
  anom+=("stranded_working=$STR (liveness sweep not bouncing — check dispatcher logs)")
fi

# 7. dispatcher heartbeat (#180): the tick stamps settings dispatcher_last_tick every
# 30s — staleness > 120s means the tick is dead or its DB writes are failing. An
# ABSENT key = a pre-heartbeat image (< 2.60.13) and stays silent; all values cast
# to text so one bad row can never kill the UNION (probe law #4).
HB=$(echo "$OUT" | awk -F'|' '/^disp_hb/{print $2}')
case "$HB" in
  stale*) anom+=("dispatcher_heartbeat_stale=${HB#stale }s (>120s — tick dead or heartbeat writes failing, #180)") ;;
esac

# 7b. redis-ok stamp (#238): the tick stamps dispatcher_redis_ok only while a redis
# ping succeeds. Heartbeat FRESH + redis stamp STALE = the brick signature — the
# app is alive but the dispatch path rides a dead queue connection (or redis is
# down). Both stale = dispatcher dead, already alerted above — no double alert.
# Absent key = pre-image (< first #238 release) and stays silent, like the heartbeat.
RH=$(echo "$OUT" | awk -F'|' '/^redis_hb/{print $2}')
case "$RH" in
  stale*) [ "$HB" = "ok" ] && anom+=("dispatch_redis_unreachable (${RH#stale }s stale — heartbeat alive, redis ping stamp stale: redis down or queue connection dead, #238)") ;;
esac

# 4. queue depth
# sentinel first line: empty output = ssh/CT failure; UNREACHABLE = redis down/container missing
QOUT=$("${CT[@]}" 'R=work-ultranomic-net-redis-1; docker exec $R redis-cli ping 2>/dev/null | grep -q PONG || { echo UNREACHABLE; exit 0; }; echo PONG; for k in $(docker exec $R redis-cli --scan --pattern "bull:tandem-dispatch-*:wait"); do docker exec $R redis-cli llen "$k"; done' 2>/dev/null)
case "$QOUT" in
  *UNREACHABLE*|'') anom+=("queue_probe: unreadable (ssh/redis/container down — backlog detector blind)") ;;
  *)
    Q=$(printf '%s\n' "$QOUT" | awk 'NR>1 {s+=$1} END {print s+0}')
    [ "${Q:-0}" -gt 0 ] && anom+=("queue_wait_depth=$Q") ;;
esac

# 5. RBAC gate alive (2026-10-31, #82): unauthenticated admin-surface writes must
# be UNAUTHORIZED (middleware runs before input validation, so a minimal body
# still 401s — anything else means the role gate is gone or the surface leaked public)
RBAC1=$(curl -s --max-time 10 -X POST https://work.ultranomic.net/rpc/vault/secrets/create -H 'Content-Type: application/json' -d '{"json":{"name":"probe","value":"x"}}' | grep -c UNAUTHORIZED || true)
RBAC2=$(curl -s --max-time 10 -X POST https://work.ultranomic.net/rpc/settings/update -H 'Content-Type: application/json' -d '{"json":{}}' | grep -c UNAUTHORIZED || true)
[ "${RBAC1:-0}" -lt 1 ] || [ "${RBAC2:-0}" -lt 1 ] && anom+=("rbac_gate_open: unauthenticated admin write not rejected")

# 6. 24/7 CREEP TRIPWIRE (owner law 2026-10-31): human-cycle SCHEDULING must never
# reappear (self-heal edits can regress it back). Flags: cron schedules with
# weekday/weekend day-of-week fields (the monthly drill, dom-based, is allowed),
# or the ops skill carrying human-cycle language outside a law/exception line.
[ ! -f "$PROFILE_DIR/cron/jobs.json" ] && anom+=("probe_config: jobs.json missing under $PROFILE_DIR — creep/dead-man inputs blind")
CREEP=$(python3 - "$PROFILE_DIR/cron/jobs.json" 2>/dev/null <<'PY'
import json, sys
try:
    jobs = json.load(open(sys.argv[1])).get("jobs", [])
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    n = 0
    for j in jobs:
        f = str((j.get("schedule") or {}).get("expr") or "").split()
        if len(f) == 5 and f[4] not in ("*", "?"):
            n += 1
except Exception:
    print("ERR"); raise SystemExit
print(n)
PY
)
case "$CREEP" in ''|*[!0-9]*) anom+=("creep_unreadable: jobs.json scan failed"); CREEP=0 ;; esac
CREEP2=$(python3 - "$PROFILE_DIR/skills/infra/tandem-ops/SKILL.md" 2>/dev/null <<'PY'
import re, sys
try:
    t = open(sys.argv[1]).read().lower()
    n = 0
    for m in re.finditer(r'weekly|peak|off-peak|business hour|rest hour|morning pass|nightly', t):
        ctx = t[max(0, m.start() - 48):m.end() + 24]
        if re.search(r'never|no |not |law|banned|except|revert|forbid', ctx):
            continue
        n += 1
except Exception:
    print("ERR"); raise SystemExit
print(n)
PY
)
[ "${CREEP:-0}" -gt 0 ] && anom+=("human-cycle-creep: $CREEP cron schedule(s) encode weekday/weekend cycles")
case "$CREEP2" in ''|*[!0-9]*) anom+=("creep_unreadable: skill scan failed"); CREEP2=0 ;; esac
[ "${CREEP2:-0}" -gt 0 ] && anom+=("human-cycle-creep: $CREEP2 hit(s) in tandem-ops skill — critic purges (law/negation text excepted)")


# 7. pending memory proposals backing up = nobody triaging the queue
PM=$(ls "$PROFILE_DIR"/pending/memory/*.json 2>/dev/null | wc -l)
[ "${PM:-0}" -gt 10 ] && anom+=("pending-memory-backlog=$PM proposals awaiting triage")

# metrics trail (file-only; stdout stays empty on green)
M="$PROBE_STATE/passes.jsonl"
mkdir -p "$(dirname "$M")"
echo "$(date -u +%FT%TZ) probe green=$([ ${#anom[@]} -eq 0 ] && echo 1 || echo 0) anomalies=${#anom[@]} target=$CT_ADDR" >> "$M"
[ -n "$DEPLOYWIN" ] && echo "$(date -u +%FT%TZ) deploy-window suppressed: $DEPLOYWIN" >> "$PROBE_STATE/deploy-window.log"

# silent on green + repeat-suppression: an IDENTICAL anomaly line set to the last
# tick stays silent (a standing fault alerts once, not every 10 min); a change re-alerts.
if [ ${#anom[@]} -eq 0 ]; then
  echo "$(date -u +%FT%TZ) probe-cleared" > "$PROBE_STATE/last-anomaly" 2>/dev/null
  exit 0
fi
LINE="$(IFS='; '; echo "${anom[*]}")"
# Dedupe key blanks ticking ages: a standing fault's age growing is not a NEW set.
KEY=$(printf '%s' "$LINE" | sed -E 's/=[0-9]+h/=<age>h/g; s/=[0-9]+s([^a-z0-9]|$)/=<age>s\1/g; s/ [0-9]+s([^a-z0-9]|$)/ <age>s\1/g')
if [ -f "$PROBE_STATE/last-anomaly" ] && [ "$(cat "$PROBE_STATE/last-anomaly" 2>/dev/null)" = "$KEY" ]; then
  echo "$(date -u +%FT%TZ) probe repeat-suppressed: $LINE" >> "$M"
  exit 0
fi
echo "$KEY" > "$PROBE_STATE/last-anomaly"
LVL=1; [ ${#anom[@]} -ge 3 ] && LVL=0
case "$LINE" in *P0*|*unreachable*|*public=*|*version_rpc*|*container_inspect*) LVL=0 ;; esac
printf 'P%d: %s\n' "$LVL" "$LINE"
