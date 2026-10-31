#!/usr/bin/env bash
# Game-day restore drill — contract: SPEC.md "Ops drills". TEST STACK ONLY.
# Injects real failures, times detection + healing, verifies green, writes a
# markdown report. Refuses to run anywhere near prod; --selfcheck validates the
# guards with zero side effects (asserted by test/unit/restore-drill.test.ts).
#
# Usage:
#   scripts/restore-drill.sh --selfcheck
#   scripts/restore-drill.sh [--scenario redis-stop|bad-tag-deploy|settings-corrupt]... [--report PATH]
#
# Exit codes: 0 green · 1 a scenario failed to detect/heal · 2 refused by guards
set -u

PG_CONTAINER=tandem-pg
REDIS_CONTAINER=tandem-test-redis
REDIS_PORT=6399
DRILL_DB=tandem_drill
DRILL_COMPOSE_PROJECT=tandem-drill
DRILL_BADTAG_CONTAINER=tandem-drill-badtag
BAD_TAG=ghcr.io/namhtpyn/tandem:v9.9.9-drill-nonexistent
PROD_MARKERS='work-ultranomic-net|100\.64\.0\.3|100\.99\.13\.2|dockhand'
DETECT_CAP=30
HEAL_CAP=60

MODE=run
SCENARIOS=()
REPORT=
while [ $# -gt 0 ]; do
  case "$1" in
    --selfcheck) MODE=selfcheck ;;
    --scenario)
      case "$2" in
        redis-stop|bad-tag-deploy|settings-corrupt) SCENARIOS+=("$2") ;;
        *) echo "unknown scenario: $2" >&2; exit 2 ;;
      esac
      shift ;;
    --report) REPORT="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(redis-stop bad-tag-deploy settings-corrupt)

now_s() { date +%s.%N; }
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }

# --- guards: the drill may only ever touch the TEST stack -------------------
# Returns 0 = allowed; 1 = refused with reason in GUARD_REASON.
guard() {
  GUARD_REASON=
  if [ "${DRILL_TEST_STACK:-}" != "1" ]; then
    GUARD_REASON="DRILL_TEST_STACK=1 not set (explicit test-stack confirmation required)"
    return 1
  fi
  local url="${DATABASE_URL:-}"
  if printf '%s' "$url" | grep -Eq "$PROD_MARKERS"; then
    GUARD_REASON="prod marker in DATABASE_URL"
    return 1
  fi
  case "$url" in
    *127.0.0.1:55432*|*/tandem_drill) : ;;
    *) GUARD_REASON="DATABASE_URL is not the local test stack"; return 1 ;;
  esac
  return 0
}

refuse() { echo "REFUSE: $1" >&2; exit 2; }

if [ "$MODE" = selfcheck ]; then
  run_guard() { ( export "$@"; guard && echo ALLOW || echo "REFUSE: $GUARD_REASON" ); }
  rc=0
  expect() { # case_label expected_glob actual
    local label=$1 expected=$2 actual=$3
    case "$actual" in
      $expected) echo "ok   $label -> $actual" ;;
      *) echo "FAIL $label: expected $expected, got $actual"; rc=1 ;;
    esac
  }
  v1=$(run_guard DATABASE_URL=postgresql://tandem:tandem@127.0.0.1:55432/tandem_drill)
  expect "no DRILL_TEST_STACK confirmation" "REFUSE*" "$v1"
  v2=$(run_guard DRILL_TEST_STACK=1 DATABASE_URL=postgresql://tandem@work-ultranomic-net.internal:5432/tandem)
  expect "prod marker in DATABASE_URL" "REFUSE*" "$v2"
  v3=$(run_guard DRILL_TEST_STACK=1 DATABASE_URL=)
  expect "missing DATABASE_URL" "REFUSE*" "$v3"
  v4=$(run_guard DRILL_TEST_STACK=1 DATABASE_URL=postgresql://tandem:tandem@127.0.0.1:55432/tandem_drill)
  expect "test stack" "ALLOW" "$v4"
  exit $rc
fi

# --- run mode: guards bind BEFORE anything touches a container --------------
guard || refuse "$GUARD_REASON"
command -v docker >/dev/null 2>&1 || refuse "docker not available"
command -v flock >/dev/null 2>&1 || refuse "flock not available"
docker ps --format '{{.Names}}' | grep -Fxq "$PG_CONTAINER" || refuse "$PG_CONTAINER not running"
docker ps --format '{{.Names}}' | grep -Fxq "$REDIS_CONTAINER" || refuse "$REDIS_CONTAINER not running"
docker compose version >/dev/null 2>&1 || refuse "docker compose v2 not available"
if docker ps --format '{{.Names}}' | grep -Eq "$PROD_MARKERS"; then
  refuse "prod-named containers on this host"
fi
# the test stack is shared with the local unit/e2e gates — never overlap them
exec 9>/tmp/tandem-drill.lock
flock -n 9 || refuse "another drill holds the lock"
# bracketed pattern: an ancestor shell whose argv merely QUOTES this pattern
# must never match (pgrep self-match class — see pkill law)
if pgrep -f '[p]laywright|[v]itest' >/dev/null 2>&1; then
  refuse "unit/e2e processes in flight on the shared test stack"
fi

# --- cleanup net: whatever happens, leave the test stack as found -----------
REDIS_STOPPED=0
DRILL_DB_UP=0
COMPOSE_DIR=
cleanup() {
  if [ "$REDIS_STOPPED" = 1 ]; then docker start "$REDIS_CONTAINER" >/dev/null 2>&1; fi
  if [ -n "$COMPOSE_DIR" ]; then
    docker compose -p "$DRILL_COMPOSE_PROJECT" -f "$COMPOSE_DIR/compose.yaml" down --remove-orphans --timeout 5 >/dev/null 2>&1
    rm -rf "$COMPOSE_DIR"
  fi
  if [ "$DRILL_DB_UP" = 1 ]; then
    docker exec "$PG_CONTAINER" psql -U tandem -d postgres -tAc "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

if command -v redis-cli >/dev/null 2>&1; then
  redis_ping() { redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; }
else
  redis_ping() { docker exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null | grep -q PONG; }
fi

poll_until() { # cap_s interval cmd... -> 0 when cmd succeeds within cap
  local cap=$1 iv=$2; shift 2
  local deadline=$(( $(date +%s) + cap ))
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep "$iv"
  done
}
poll_until_fail() { # cap_s interval cmd... -> 0 when cmd fails within cap
  local cap=$1 iv=$2; shift 2
  local deadline=$(( $(date +%s) + cap ))
  while :; do
    if ! "$@" >/dev/null 2>&1; then return 0; fi
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep "$iv"
  done
}

pg_exec() { # db sql... (writes: -v ON_ERROR_STOP, stdin not used)
  docker exec "$PG_CONTAINER" psql -U tandem -tA -v ON_ERROR_STOP=1 -d "$1" "${@:2}"
}
pg_exec_stdin() { # db [psql args...] with SQL on stdin
  local db=$1; shift
  docker exec -i "$PG_CONTAINER" psql -U tandem -tA -v ON_ERROR_STOP=1 -d "$db" "$@"
}

# --- scenarios: backup -> inject -> detect -> heal -> verify ----------------
s_redis_stop() {
  DETECTOR=service-ping
  GAP=
  local t0
  t0=$(now_s)
  docker stop "$REDIS_CONTAINER" >/dev/null || { STATUS=inject-failed; return 1; }
  REDIS_STOPPED=1
  if poll_until_fail "$DETECT_CAP" 0.5 redis_ping; then
    T_DETECT=$(elapsed "$t0" "$(now_s)")
  else
    STATUS=detect-timeout; return 1
  fi
  docker start "$REDIS_CONTAINER" >/dev/null || { STATUS=heal-failed; return 1; }
  if poll_until "$HEAL_CAP" 0.5 redis_ping; then
    T_HEAL=$(elapsed "$t0" "$(now_s)")
    REDIS_STOPPED=0
    STATUS=OK
  else
    STATUS=heal-timeout; return 1
  fi
}

s_bad_tag_deploy() {
  DETECTOR=deploy-exit-status
  GAP=
  COMPOSE_DIR=$(mktemp -d)
  cat > "$COMPOSE_DIR/compose.yaml" <<EOF
services:
  drill:
    image: $BAD_TAG
    container_name: $DRILL_BADTAG_CONTAINER
EOF
  local t0
  t0=$(now_s)
  if timeout 120 docker compose -p "$DRILL_COMPOSE_PROJECT" -f "$COMPOSE_DIR/compose.yaml" up -d >/dev/null 2>&1; then
    STATUS=inject-unexpected-success; return 1
  fi
  T_DETECT=$(elapsed "$t0" "$(now_s)")
  # silent-no-op guard (the v2.54.0 incident class): a failed deploy must not
  # leave a container running under the bad tag
  if docker ps --format '{{.Names}}' | grep -Fxq "$DRILL_BADTAG_CONTAINER"; then
    STATUS=no-op-deploy; return 1
  fi
  docker compose -p "$DRILL_COMPOSE_PROJECT" -f "$COMPOSE_DIR/compose.yaml" down --remove-orphans >/dev/null 2>&1
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$DRILL_BADTAG_CONTAINER"; then
    STATUS=heal-failed; return 1
  fi
  rm -rf "$COMPOSE_DIR"
  COMPOSE_DIR=
  T_HEAL=$(elapsed "$t0" "$(now_s)")
  STATUS=OK
}

s_settings_corrupt() {
  DETECTOR=integrity-probe
  GAP="no live app-level detector for settings corruption — heal fired via drill probe (gap, not restore, is the finding)"
  local t0
  t0=$(now_s)
  docker exec "$PG_CONTAINER" psql -U tandem -d postgres -tAc "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null || { STATUS=setup-failed; return 1; }
  docker exec "$PG_CONTAINER" psql -U tandem -d postgres -tAc "CREATE DATABASE $DRILL_DB" >/dev/null || { STATUS=setup-failed; return 1; }
  DRILL_DB_UP=1
  pg_exec_stdin "$DRILL_DB" <<'SQL'
CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value, updated_at) VALUES ('drill.probe', '{"ok":true}', now());
SQL
  [ $? -eq 0 ] || { STATUS=setup-failed; return 1; }
  local backup corrupt
  backup=$(pg_exec "$DRILL_DB" -c "SELECT value FROM settings WHERE key = 'drill.probe'")
  if [ -z "$backup" ]; then STATUS=setup-failed; return 1; fi
  printf 'backup row: key=drill.probe value=%s\n' "$backup" >> "$EVIDENCE"
  pg_exec_stdin "$DRILL_DB" <<'SQL'
UPDATE settings SET value = 'corrupted-{"broken":' WHERE key = 'drill.probe';
SQL
  [ $? -eq 0 ] || { STATUS=inject-failed; return 1; }
  corrupt=$(pg_exec "$DRILL_DB" -c "SELECT value FROM settings WHERE key = 'drill.probe'")
  if [ "$corrupt" != "$backup" ]; then
    T_DETECT=$(elapsed "$t0" "$(now_s)")
  else
    STATUS=detect-miss; return 1
  fi
  pg_exec_stdin "$DRILL_DB" -v val="$backup" <<'SQL'
UPDATE settings SET value = :'val' WHERE key = 'drill.probe';
SQL
  [ $? -eq 0 ] || { STATUS=heal-failed; return 1; }
  local restored
  restored=$(pg_exec "$DRILL_DB" -c "SELECT value FROM settings WHERE key = 'drill.probe'")
  if [ "$restored" = "$backup" ]; then
    T_HEAL=$(elapsed "$t0" "$(now_s)")
    STATUS=OK
  else
    STATUS=heal-failed; return 1
  fi
}

# --- run all scenarios, record, report --------------------------------------
EVIDENCE=$(mktemp)
REPORT_TMP=$(mktemp)
FAILED=0
RESULTS=
RESULTS_GAPS=
for s in "${SCENARIOS[@]}"; do
  DETECTOR=unknown T_DETECT= T_HEAL= STATUS=not-run GAP=
  # scenario names carry dashes; function names carry underscores
  "s_$(printf '%s' "$s" | tr - _)"
  rc=$?
  [ "$STATUS" = OK ] || FAILED=1
  RESULTS+="| $s | $DETECTOR | ${T_DETECT:--} | ${T_HEAL:--} | $STATUS |"$'\n'
  [ -n "$GAP" ] && RESULTS_GAPS+="- $s: $GAP"$'\n'
done

{
  echo "# game-day drill $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "| scenario | detector | t_detect_s | t_heal_s | status |"
  echo "| --- | --- | --- | --- | --- |"
  printf '%s' "$RESULTS"
  echo
  if [ -n "${RESULTS_GAPS:-}" ]; then
    echo "## Detection gaps"
    printf '%s' "$RESULTS_GAPS"
  else
    echo "## Detection gaps"
    echo "- none"
  fi
} > "$REPORT_TMP"

if [ -n "$REPORT" ]; then
  mkdir -p "$(dirname "$REPORT")"
  cp "$REPORT_TMP" "$REPORT"
  cp "$EVIDENCE" "$REPORT.evidence.txt"
  echo "drill report: $REPORT"
fi
cat "$REPORT_TMP"
rm -f "$REPORT_TMP" "$EVIDENCE"

OK_COUNT=$(printf '%s' "$RESULTS" | grep -c '| OK |' || true)
echo "drill summary: $OK_COUNT/${#SCENARIOS[@]} scenarios green"
[ "$FAILED" = 0 ] || exit 1
exit 0
