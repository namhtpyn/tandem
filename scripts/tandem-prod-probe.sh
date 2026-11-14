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
CT=(ssh -i "$CT_KEY" -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$CT_ADDR")
# Epoch stamps: settings retention stamps are epoch **ms**; probe math is seconds.
to_epoch_s() { case "${1:-}" in ''|*[!0-9]*) echo 0 ;; *) if [ "$1" -gt 100000000000 ]; then echo $(( $1 / 1000 )); else echo "$1"; fi ;; esac; }
# GATING-BLOCK predicate (#419/#424), factored so --selfcheck can exercise its gating and
# every block-shaped arm shares ONE copy of the clause: the block branch is added only
# when the origin columns exist AND the image's sweeps heal that shape (>= 2.78.20).
# $1 = prod version (may be empty), $2 = origin-column count. Empty = branch omitted.
own_block_predicate() {
  case "${1:-}" in
    [0-9]*.[0-9]*.[0-9]*) ;; # x.y.z shape first (sort -V ranks garbage above 2.78.20)
    *) return 0 ;;
  esac
  case "${1}" in
    *[!0-9.]*) return 0 ;; # ... and nothing but digits/dots (2.78.20-rc1 is BELOW the floor)
  esac
  if [ "${2:-}" = "2" ] && [ "$(printf '%s\n%s\n' 2.78.20 "${1}" | sort -V | tail -1)" = "${1}" ]; then
    printf "%s" "(s.category = 'paused' and t.park_from_status is null and t.pre_block_status is not null and exists (select 1 from task_statuses o where o.id = t.pre_block_status and o.category = 'in_review'))"
  fi
}
# OWNERSHIP predicate for the stranded-round arms (#419): in_review, plus — when the
# image can heal it — a review-flow-owned PAUSED gating auto-block (origin column set,
# no park origin, recorded home resolving to in_review). $1 = prod version, $2 = columns.
# The in_review half is a literal in the wedge arm and here; only the GATE-ORIGIN test
# has one copy (a shape added here reaches stallrv/lostsettle, never the wedge).
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
# #424: the wedge arm's inner set carries the gating-block branch. BOTH branches read the
# CURRENT round only: no PENDING row in max(round) (any PENDING row there — a
# NULL-reviewer void row from a removed reviewer included — means the round is still
# suspended and its block restore settles it, never a wedge), at least one VERDICT row,
# and NO OWNER STATUS WRITE newer than that round's newest verdict (#430).
# THE OWNER-STATUS DISCRIMINATOR replaces the old verdict-vs-updated_at ordering, whose
# mask was fatal: a machine status write (the child-restore that lands the task back in
# review) or a title/assignee edit stamped updated_at past the killing verdict and the
# shape read as a legal manual move. The manual move is the ONLY writer of a `status: …`
# activity body (tasks.setStatus); every machine path logs its OWN body (auto-blocked /
# unblocked / park / round closed), so the row is unforgeable by machine paths and a
# legal re-queue into an in-review status over an already-decided round always carries
# its move NEWER than the verdict. Free text cannot forge it either: the 1:1 activity
# payload must carry kind='STATUS' (a note or a human verdict body that merely starts
# `status: ` is not a status write), and the row commits in the SAME transaction as the
# status write. The body — not the author — is the key: author_id is ON DELETE SET NULL,
# so a deleted mover would read as a machine write.
# Columns verified against the live prod schema (probe law #5): task_messages.task_id /
# body / created_at and task_message_activities.message_id / payload, riding
# task_messages_task_idx.
# A lost settle flip has the block write first and the killing verdict after it (the
# verdict ROW is written before the flip's task write).
# A park carries park_from_status and owns its round — a parked round that closed is the
# same lost-flip shape and is OUT of this arm by declaration (#431). The two non-settle
# block egresses (#427) leave a non-paused row, so no paused-row arm reads them. An
# origin that no longer RESOLVES (its status was deleted after the block recorded it) is
# the ORPHAN-HOME arm's shape (#432), appended last so this slice never carries it.
# current round holds at least one VERDICT row (a closed round, not a minted-empty one)
decided_clause() {
  printf "%s" "exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id))"
}
# no OWNER status write (tasks.setStatus's `status: …` activity row) newer than the
# newest verdict of the current round. Two filters make the row unforgeable by free text:
# the `status: …` body has exactly one writer in the codebase (tasks.setStatus — every
# machine path logs its own body: auto-blocked / unblocked / park / round closed), and
# the 1:1 activity payload must carry kind='STATUS' (a NOTE or VERDICT row whose text
# merely starts with `status: ` is not a status write). The body — not the author — is
# the key: author_id is ON DELETE SET NULL, so a deleted mover would read as a machine
# write. tasks.setStatus commits the row in the SAME transaction as the status write, so
# a landed owner move always carries it.
owner_gap_clause() {
  printf "%s" "not exists (select 1 from task_messages m where m.task_id = t.id and m.body like 'status: %' and exists (select 1 from task_message_activities a where a.message_id = m.id and a.payload->>'kind' = 'STATUS') and m.created_at > (select max(coalesce(r.decided_at, r.created_at)) from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)))"
}
# #430 OWNER-STATUS RULE FLOOR: the absence of an owner record is decisive ONLY when the
# server guarantees that every landed manual move carries its row. `tasks.setStatus`
# writes the row in the same transaction as the status write from 2.78.24 (OWNER-MOVE
# RECORD); on an older image the row was written later, outside the transaction, so a
# crash between the status write and the log could lose it — a missing record there
# proves nothing. Old images therefore keep the retired verdict-vs-updated_at ordering
# (maskable by a later write, but never a false alarm); 2.78.24+ uses the owner record.
# The floor gates the WRITER's atomicity: if a release ever moves the record OUT of
# setStatus's transaction, RE-DERIVE the floor for that release, never assume it. A
# per-row deploy-stamp boundary was considered and REJECTED (#438, 2026-11-14) — the
# pre-floor era is verified closed (the arm emitted `none` on prod under both the
# 2.78.24 and 2.78.23 SQL at the discriminator's merge). The manual-move surface also
# rides the employee tier DELIBERATELY: an agent/API-key credential that performs a
# setStatus transition performs a REAL owner move and mints the same record (no
# humanProcedure gate — it would break a future agent-driven re-queue).
OWNER_FLOOR=2.78.24
owner_floor_met() {
  case "${1:-}" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) return 1 ;;
  esac
  case "${1}" in
    *[!0-9.]*) return 1 ;;
  esac
  [ "$(printf '%s\n%s\n' "$OWNER_FLOOR" "${1}" | sort -V | tail -1)" = "${1}" ]
}
# the retired rule (pre-2.78.24 images): a verdict newer than the task's last write
legacy_rule() {
  printf "%s" "(select max(coalesce(r.decided_at, r.created_at)) from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) > t.updated_at"
}
# READY-ROUND arm (#443, task-wide per #445): a ready/working-category task owning a
# PENDING row of ANY round for a LIVE AI reviewer, with NO running run on the task — the
# parked/stranded round a legal egress or a teardown regression left behind. The note-dispatch
# bounce produced the CURRENT-round shape every time an owner sent a note to a parked task
# (the flip returned the task to work and left the round; no sweep reaches a ready-category
# task, so the reviewer never decided and its verdict was discarded). The LAW is task-wide:
# a ready task must own no live round AT ALL — pinning the clause to `round = max(round)`
# left an older-round strand invisible (a resubmit opens the next round insert-only, older
# rows are never superseded, and review.service documents that a superseded max round can
# hide an older round that is still live), so a teardown regression leaving ONLY
# non-current-round rows alerted never (#445). Below 2.78.26 the bounce shape is LEGAL —
# the arm stays silent there rather than misattribute cause; from the floor the flip tears
# every open round down in the same transaction, so a surviving count is a guard regression
# or a direct-SQL write. Both machine-egress exclusions are PER-ROW (keyed on each row's
# own created_at, evaluated per round, never per task): the manual-freedom exception rides
# the owner status WRITE (the `status: …` body with the 1:1 kind='STATUS' payload,
# tasks.setStatus's unforgeable signature) — a manual move out of review legally leaves the
# round's PENDING rows behind and its own move row is always newer than the rows it
# stranded — and the declared HOLD-LANDING exception rides the `review round resumed …`
# STATUS-payload note newer than the re-opened row; a row of ANY round with no newer
# exclusion record is the alert. Residual producers, exhaustive by declaration: every
# legal flip either supersedes the rows it strands (the egress teardown, terminal settles,
# 'no live reviewers') or writes a newer STATUS-kind record; the escalation replacement
# mint (review.service) targets a live round on an in_review task, never this scope; a
# verdict bounce cannot strand its own round's siblings — the round matrix returns
# `waiting` and never flips while any PENDING row of the deciding round remains, so the
# flip proceeds only on the round's LAST verdict; what a bounce CAN strand is a NEWER
# round's live rows when a stale AI verdict binds to the older round it was dispatched
# for — the flip is a raw write (no note), so those rows land unrecorded and the arm's
# firing on them is the law, not a false positive.
# NOT reader-scoped on purpose: the parked reviewer WAS dispatched (its turn failed), so the
# stalled-review arm's never-dispatched clause would exclude the exact shape.
READY_FLOOR=2.78.26
ready_floor_met() {
  [ "$(at_least "$READY_FLOOR" "${1:-}")" = "1" ]
}
ready_owner_gap() {
  printf "%s" "not exists (select 1 from task_messages m where m.task_id = t.id and m.body like 'status: %' and exists (select 1 from task_message_activities a2 where a2.message_id = m.id and a2.payload->>'kind' = 'STATUS') and m.created_at > r.created_at)"
}
# HOLD-LANDING exception: SPEC's review section DECLARES one legal ready/working shape — an
# answer that lands while a verdict is held, whose repair flip loses the dispatcher's claim,
# leaves the re-opened round on a ready/working status with the reviewer owed a vote and only
# a thread note ('review round resumed …'). That note is a machine body carrying the 1:1
# kind='STATUS' payload and is written AFTER the row it re-opened (the re-open keeps
# created_at), so the arm excludes any row a resume note is newer than. Free text cannot
# forge the exclusion (a NOTE's payload kind is NOTE, never STATUS).
ready_hold_gap() {
  printf "%s" "not exists (select 1 from task_messages m3 join task_message_activities a3 on a3.message_id = m3.id where m3.task_id = t.id and m3.body like 'review round resumed%' and a3.payload->>'kind' = 'STATUS' and m3.created_at > r.created_at)"
}
ready_round_arm() {
  printf "%s" " union all select 'readyround', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_reviews r on r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null join ai_employees a on a.user_id = r.reviewer_id where s.category in ('ready', 'working') and r.created_at < now() - interval '5 minutes' and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.status = 'RUNNING') and $(ready_owner_gap) and $(ready_hold_gap)) x), 'none')"
}
strand_sql() {
  local own blkarm orphan decided gap rule ready
  own=$(own_predicate "${1:-}" "${2:-}")
  ready=""
  if ready_floor_met "${1:-}"; then ready=$(ready_round_arm); fi
  decided=$(decided_clause);
  gap=$(owner_gap_clause)
  if owner_floor_met "${1:-}"; then rule="$decided and $gap"; else rule="$(legacy_rule)"; fi
  blkarm=""
  if [ -n "$(own_block_predicate "${1:-}" "${2:-}")" ]; then
    blkarm=" union select distinct t.id from tasks t join task_statuses s on s.id = t.status where $(own_block_predicate "${1:-}" "${2:-}") and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and $rule"
  fi
  # ORPHAN-HOME arm (#432): a PAUSED row with a recorded origin (block or park home) that
  # names NO task_statuses row — the home was deleted after the block recorded it — with
  # the wedge's current-round clause (no PENDING row in max(round), at least one verdict
  # row) plus its OWN verdict-vs-write ordering (the newest verdict of that round NEWER
  # than the task's last write; the wedge's owner-status discriminator is #430's, this arm
  # keeps the simpler test). EITHER column alone
  # dangles: a row carrying both origins (no live writer emits that, but the schema
  # permits it) still fires when one of them lost its row. No legal write path produces
  # it: a gating block records the task's own status (a row that exists at write time), a
  # park records an in-review home, a hand-made block clears both origins, and
  # statuses.remove re-homes every recorded reference inside its delete transaction
  # (STATUS-ORIGIN MEMORY LAW) — so a surviving count means a direct-SQL delete, a guard
  # regression, or the ghost-task window the law declares (a task moved into the status
  # while it was being deleted). The arm also requires NEITHER origin to resolve to an
  # in-review home: the flip can still land through a resolvable park origin, so such a
  # row is not this shape (the wedge's park exclusion, mirrored). VERSION-INDEPENDENT on purpose (a pre-guard image still produces
  # the strand, so no image floor), but COLUMN-GATED like the block branch: the arm reads
  # park_from_status, and an origin column absent on the running image would kill the
  # WHOLE UNION (probe law #5 / #325) and blind every arm.
  orphan=""
  if [ "${2:-}" = "2" ]; then
    orphan=" union all select 'orphanhome', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status where s.category = 'paused' and ((t.pre_block_status is not null and not exists (select 1 from task_statuses o where o.id = t.pre_block_status)) or (t.park_from_status is not null and not exists (select 1 from task_statuses o where o.id = t.park_from_status))) and not exists (select 1 from task_statuses o where o.category = 'in_review' and (o.id = t.pre_block_status or o.id = t.park_from_status)) and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and (select max(coalesce(r.decided_at, r.created_at)) from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) > t.updated_at) x), 'none')"
  fi
  # RE-KEYED-HOME arm (#435): a PAUSED row with a recorded origin that RESOLVES to a
  # task_statuses row whose category is NOT in_review — the home EXISTS, but its category
  # moved after the block recorded it (statuses.save's block-state-home guard is a
  # read-then-write check; a gating block landing inside its read->upsert window is the
  # DECLARED residual producer, the orphan arm's ghost-task race class). The flip refuses
  # on the non-review home, the round closes on the verdict row with NO task write, and
  # the task stays blocked: the wedge's in_review branch cannot see it (the origin
  # resolves outside in_review), the ORPHAN-HOME arm cannot (the home exists), and the
  # teardown heals read it as owner-settled. A terminal-by-owner shape is excluded BY
  # CONSTRUCTION, not by a category term — a legal owner settle leaves the paused
  # category and clears both origins in the same statement, so a row still carrying an
  # origin cannot be owner-settled — which is why the arm fires on a resolved
  # done/cancelled home too (that IS the counterexample: in_review -> done under a
  # blocked task). Current-round clause + verdict-vs-write ordering mirrored from the
  # orphan arm (the owner-status discriminator is the WEDGE's, #430). Per-column resolve,
  # VERSION-independent (a pre-guard image produces the strand too), COLUMN-gated like
  # every arm that reads park_from_status (#325).
  rekey=""
  if [ "${2:-}" = "2" ]; then
    rekey=" union all select 'rekeyhome', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status where s.category = 'paused' and ((t.pre_block_status is not null and exists (select 1 from task_statuses o where o.id = t.pre_block_status and o.category <> 'in_review')) or (t.park_from_status is not null and exists (select 1 from task_statuses o where o.id = t.park_from_status and o.category <> 'in_review'))) and not exists (select 1 from task_statuses o where o.category = 'in_review' and (o.id = t.pre_block_status or o.id = t.park_from_status)) and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and (select max(coalesce(r.decided_at, r.created_at)) from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) > t.updated_at) x), 'none')"
  fi
  printf "%s" "select 'wedge', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status where s.category = 'in_review' and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and $rule${blkarm}) x), 'none') union all select 'strand', coalesce(string_agg(t.id::text, ',' order by t.id), 'none') from tasks t join task_statuses s on s.id = t.status where s.category = 'waiting_answer' and not exists (select 1 from task_obligations o where o.task_id = t.id and o.role = 'ANSWER' and o.status = 'PENDING') and (select max(coalesce(o.resolved_at, o.created_at)) from task_obligations o where o.task_id = t.id and o.role = 'ANSWER') > t.updated_at union all select 'orphanans', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_obligations o on o.task_id = t.id where s.category = 'waiting_answer' and o.role = 'ANSWER' and o.status = 'PENDING' and o.employee_id is null and not exists (select 1 from task_obligations o2 where o2.task_id = t.id and o2.role = 'ANSWER' and o2.status = 'PENDING' and o2.employee_id is not null)) x), 'none') union all select 'stallrv', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_reviews r on r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null join ai_employees a on a.user_id = r.reviewer_id where $own and r.round = (select max(r2.round) from task_reviews r2 where r2.task_id = t.id) and r.created_at < now() - interval '5 minutes' and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.status = 'RUNNING') and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.employee_id = r.reviewer_id and tr.started_at >= r.created_at)) x), 'none') union all select 'lostsettle', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_reviews r on r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null join ai_employees a on a.user_id = r.reviewer_id where $own and (t.assignee_id is null or r.reviewer_id <> t.assignee_id) and r.round = (select max(r2.round) from task_reviews r2 where r2.task_id = t.id) and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.status = 'RUNNING') and exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.employee_id = r.reviewer_id and tr.status = 'DONE' and tr.started_at >= r.created_at and tr.finished_at < now() - interval '2 minutes' and not exists (select 1 from task_runs tr2 join task_messages tm2 on tm2.id = tr2.message_id where tm2.task_id = t.id and tr2.employee_id = r.reviewer_id and (tr2.started_at, tr2.id) > (tr.started_at, tr.id)))) x), 'none')${ready}${orphan}${rekey}"
}
# the wedge arm alone (the SQL's first emission) — selfcheck greps THIS, never the whole
# strand SQL: `park_from_status` also rides $own inside the stallrv/lostsettle arms, so a
# whole-SQL grep stays green with the wedge branch deleted (r1 review, P3)
strand_wedge_arm() {
  strand_sql "${1:-}" "${2:-}" | sed "s/ union all select 'strand'.*//"
}
# the orphan-home arm alone (#432) — same slice discipline: its clauses are pinned on the
# arm's own bytes, never a whole-SQL substring (the wedge shares two of them verbatim)
strand_orphan_arm() {
  strand_sql "${1:-}" "${2:-}" | sed "s/.*select 'orphanhome'/select 'orphanhome'/; s/ union all select 'rekeyhome'.*//"
}
# the RE-KEYED-HOME arm alone (#435) — sliced to its own bytes; it is the UNION's LAST
# emission, so the slice starts at its select and runs to the end
strand_rekey_arm() {
  strand_sql "${1:-}" "${2:-}" | sed "s/.*select 'rekeyhome'/select 'rekeyhome'/"
}
# the ready-round arm alone (#443) — sliced to its own bytes; the orphan arm follows it in
# the UNION, so the slice also cuts that tail off
strand_ready_arm() {
  strand_sql "${1:-}" "${2:-}" | sed "s/.*select 'readyround'/select 'readyround'/; s/ union all select 'orphanhome'.*//"
}
# VERSION FLOOR helper: 1 when the live version is at/above $1 (empty version = 0, the
# arms that use it stay silent on an unreadable version rather than misattribute cause).
# SEMVER SHAPE FIRST, stricter than the sibling floor helpers on purpose: $V is scraped
# from an HTTP body, and `sort -V` ranks a calendar date (`2026.11.13`) or an IP
# (`100.64.0`) above every real version — a shape-unguarded floor opens on garbage, and an
# arm gated on it then runs against the wrong image. Exactly three numeric components, no
# padding, and a major below 100 (this product's :: 2; a year and a three-digit octet are
# the realistic garbage shapes, and both are >= 100).
at_least() {
  local v="${2:-}" maj
  printf '%s' "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo 0; return; }
  maj="${v%%.*}"
  # LENGTH before arithmetic: a 20+ digit major overflows `$(( ))` (2^63..2^64-1 wraps
  # NEGATIVE and slips under the `-lt 100` bound it was supposed to fail), so the digit
  # count is the real guard. 2 digits covers this product (major 2) with room to spare.
  [ "${#maj}" -le 2 ] || { echo 0; return; }
  maj=$((10#$maj)) # base-10 explicitly: `08` is not a valid octal literal
  [ "$maj" -lt 100 ] || { echo 0; return; }
  [ "$(printf '%s\n%s\n' "$1" "$v" | sort -V | tail -1)" = "$v" ] && echo 1 || echo 0
}
# EGRESS-ORIGIN arm (#427): a task OUTSIDE the paused category still carrying a gating
# origin. Post-2.78.25 no legal write path produces it — every egress clears both origins
# in the SAME statement that lands the status — and every discriminator resolves those
# columns on a paused row only, so no gating arm heals it (statuses.remove's re-home is the
# one repair, and it fires only on a DELETE). Keyed on the ORIGINS alone, never the
# ledger: the block's own resume legally leaves the attempt ledger on a live row (#211
# bounded cycles), so a ledger term would alert on a healthy row.
egress_sql() {
  printf "%s" "select 'egressorigin', coalesce(string_agg(t.id::text, ',' order by t.id), 'none') from tasks t join task_statuses s on s.id = t.status where s.category <> 'paused' and (t.park_from_status is not null or t.pre_block_status is not null)"
}
# gate: the image is at/above the release whose egresses clear the origins. Returns shell
# TRUE/FALSE (no comparison literal anywhere), so the pass calls it directly and the
# selfcheck owns its truth table — a flipped literal can no longer ship a dead arm.
egress_arm_on() {
  [ "$(at_least 2.78.25 "${1:-}")" = "1" ]
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
  [ -z "$(own_block_predicate guard-error 2)" ] || { echo "selfcheck fail: block non-semver version"; exit 1; }
  [ -z "$(own_block_predicate 2.78.x 2)" ] || { echo "selfcheck fail: block partial semver"; exit 1; }
  [ -z "$(own_block_predicate 2.78.20-rc1 2)" ] || { echo "selfcheck fail: block pre-release semver"; exit 1; }
  printf '%s' "$(own_predicate 2.78.20 2)" | grep -qF "s.category = 'in_review'" || { echo "selfcheck fail: own in_review half"; exit 1; }
  printf '%s' "$(strand_sql 2.78.20 2)" | grep -qF "where (s.category = 'in_review' or (s.category = 'paused'" || { echo "selfcheck fail: own predicate not reaching stallrv/lostsettle"; exit 1; }
  STR_ON=$(strand_sql 2.78.24 2)
  WEDGE_ON=$(strand_wedge_arm 2.78.24 2)
  WEDGE_PRE=$(strand_wedge_arm 2.78.23 2)
  WEDGE_OFF=$(strand_wedge_arm 2.78.19 2)
  printf '%s' "$STR_ON" | grep -qF "select 'lostsettle'" || { echo "selfcheck fail: strand lostsettle arm"; exit 1; }
  printf '%s' "$WEDGE_ON" | grep -qF "select 'wedge'" || { echo "selfcheck fail: strand wedge arm"; exit 1; }
  printf '%s' "$WEDGE_ON" | grep -qF "park_from_status is null" || { echo "selfcheck fail: wedge block branch"; exit 1; }
  printf '%s' "$WEDGE_ON" | grep -qF "r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')" || { echo "selfcheck fail: wedge decided rows"; exit 1; }
  # #430: at the atomic-writer floor (2.78.24+) the manual-freedom discriminator is the
  # ABSENT OWNER status write — an activity row whose body is `status: …` AND whose 1:1
  # payload carries kind='STATUS', NEWER than the current round's newest verdict — carried
  # by BOTH branches. The FULL clause is pinned (body + kind + verdict filter + round
  # binding): a pin that stops before any one of those terms stays green when that term is
  # dropped. Older images MUST keep the retired verdict-vs-write ordering (a lost record
  # there proves nothing), so its presence is pinned below the floor and its absence at it.
  GAP_CLAUSE="m.body like 'status: %' and exists (select 1 from task_message_activities a where a.message_id = m.id and a.payload->>'kind' = 'STATUS') and m.created_at > (select max(coalesce(r.decided_at, r.created_at)) from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)))"
  DEC_CLAUSE="exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id))"
  [ "$(printf '%s' "$WEDGE_ON" | grep -oF "$GAP_CLAUSE" | wc -l)" = "2" ] || { echo "selfcheck fail: wedge owner-status clause (both branches)"; exit 1; }
  [ "$(printf '%s' "$WEDGE_ON" | grep -oF "$DEC_CLAUSE" | wc -l)" = "2" ] || { echo "selfcheck fail: wedge decided-round clause (both branches)"; exit 1; }
  [ "$(printf '%s' "$WEDGE_PRE" | grep -oF "$GAP_CLAUSE" | wc -l)" = "0" ] || { echo "selfcheck fail: owner clause must not reach a pre-floor image"; exit 1; }
  [ "$(printf '%s' "$WEDGE_PRE" | grep -oF ') > t.updated_at' | wc -l)" = "2" ] || { echo "selfcheck fail: pre-floor wedge must keep the verdict-vs-write rule (both branches)"; exit 1; }
  [ "$(printf '%s' "$WEDGE_OFF" | grep -oF ') > t.updated_at' | wc -l)" = "1" ] || { echo "selfcheck fail: pre-block floor verdict-vs-write rule"; exit 1; }
  printf '%s' "$WEDGE_ON" | grep -qF "t.updated_at" && { echo "selfcheck fail: floor wedge still keys on updated_at"; exit 1; }
  owner_floor_met 2.78.24 || { echo "selfcheck fail: owner floor met at 2.78.24"; exit 1; }
  owner_floor_met 2.78.100 || { echo "selfcheck fail: owner floor met above (sort -V)"; exit 1; }
  owner_floor_met 3.0.0 || { echo "selfcheck fail: owner floor met at the next major"; exit 1; }
  owner_floor_met 2.78.23 && { echo "selfcheck fail: owner floor met below 2.78.24"; exit 1; }
  owner_floor_met 2.78.24-rc1 && { echo "selfcheck fail: owner floor met on a pre-release"; exit 1; }
  owner_floor_met '' && { echo "selfcheck fail: owner floor met on an empty version"; exit 1; }
  owner_floor_met guard-error && { echo "selfcheck fail: owner floor met on a non-semver"; exit 1; }
  [ "$(printf '%s' "$WEDGE_ON" | grep -oF "r.status = 'PENDING' and r.round = (select max(r3.round)" | wc -l)" = "2" ] || { echo "selfcheck fail: wedge live-round clause (both branches)"; exit 1; }
  printf '%s' "$WEDGE_OFF" | grep -qF "park_from_status" && { echo "selfcheck fail: wedge block branch not gated"; exit 1; }
  printf '%s' "$WEDGE_OFF" | grep -qF "select 'wedge'" || { echo "selfcheck fail: wedge floor"; exit 1; }
  # ORPHAN-HOME arm (#432) — clauses pinned on the arm's own slice (the wedge shares the
  # current-round + verdict-newer clauses verbatim, so a whole-SQL grep would stay green
  # with this arm deleted).
  ORPHAN_ON=$(strand_orphan_arm 2.78.19 2)
  [ "$(printf '%s' "$ORPHAN_ON" | grep -oF "select 'orphanhome'" | wc -l)" = "1" ] || { echo "selfcheck fail: orphan arm"; exit 1; }
  printf '%s' "$ORPHAN_ON" | grep -qF "s.category = 'paused'" || { echo "selfcheck fail: orphan paused scope"; exit 1; }
  printf '%s' "$ORPHAN_ON" | grep -qF "(t.pre_block_status is not null and not exists (select 1 from task_statuses o where o.id = t.pre_block_status)) or (t.park_from_status is not null and not exists (select 1 from task_statuses o where o.id = t.park_from_status))" || { echo "selfcheck fail: orphan dangling clause (per column)"; exit 1; }
  printf '%s' "$ORPHAN_ON" | grep -qF "not exists (select 1 from task_statuses o where o.category = 'in_review' and (o.id = t.pre_block_status or o.id = t.park_from_status))" || { echo "selfcheck fail: orphan in-review-resolver exclusion"; exit 1; }
  [ "$(printf '%s' "$ORPHAN_ON" | grep -oF ") > t.updated_at" | wc -l)" = "1" ] || { echo "selfcheck fail: orphan write discriminator"; exit 1; }
  printf '%s' "$ORPHAN_ON" | grep -qF "r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')" || { echo "selfcheck fail: orphan verdict scope"; exit 1; }
  printf '%s' "$ORPHAN_ON" | grep -qF "r.status = 'PENDING' and r.round = (select max(r3.round)" || { echo "selfcheck fail: orphan live-round clause"; exit 1; }
  # VERSION-independent (no image floor — a pre-guard image produces the strand too) but
  # COLUMN-gated: an arm referencing park_from_status on a one-column image would kill the
  # whole UNION, so the arm must VANISH at the column-count-1 gate pair
  [ "$(printf '%s' "$(strand_sql 2.78.19 2)" | grep -oF "select 'orphanhome'" | wc -l)" = "1" ] || { echo "selfcheck fail: orphan arm missing at the pre-guard version"; exit 1; }
  printf '%s' "$(strand_sql 2.78.19 1)" | grep -qF "orphanhome" && { echo "selfcheck fail: orphan arm emitted without the park column"; exit 1; }
  # RE-KEYED-HOME arm (#435) — same slice discipline as the orphan arm: the wedge, strand,
  # orphanans, stallrv, lostsettle and ready arms share the current-round + verdict-newer
  # clauses verbatim, so every pin greps the arm's OWN bytes only.
  REKEY_ON=$(strand_rekey_arm 2.78.19 2)
  [ "$(printf '%s' "$REKEY_ON" | grep -oF "select 'rekeyhome'" | wc -l)" = "1" ] || { echo "selfcheck fail: rekey arm"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "s.category = 'paused'" || { echo "selfcheck fail: rekey paused scope"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "(t.pre_block_status is not null and exists (select 1 from task_statuses o where o.id = t.pre_block_status and o.category <> 'in_review')) or (t.park_from_status is not null and exists (select 1 from task_statuses o where o.id = t.park_from_status and o.category <> 'in_review'))" || { echo "selfcheck fail: rekey resolve clause (per column)"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "not exists (select 1 from task_statuses o where o.category = 'in_review' and (o.id = t.pre_block_status or o.id = t.park_from_status))" || { echo "selfcheck fail: rekey in-review-resolver exclusion"; exit 1; }
  [ "$(printf '%s' "$REKEY_ON" | grep -oF ") > t.updated_at" | wc -l)" = "1" ] || { echo "selfcheck fail: rekey write discriminator"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')" || { echo "selfcheck fail: rekey verdict scope"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "r.status = 'PENDING' and r.round = (select max(r3.round)" || { echo "selfcheck fail: rekey live-round clause"; exit 1; }
  # the rekey arm rides the same gates as the orphan arm: present at the pre-guard
  # version, VANISHING at the one-column gate, and never leaking into the orphan slice
  [ "$(printf '%s' "$(strand_sql 2.78.19 2)" | grep -oF "select 'rekeyhome'" | wc -l)" = "1" ] || { echo "selfcheck fail: rekey arm missing at the pre-guard version"; exit 1; }
  printf '%s' "$(strand_sql 2.78.19 1)" | grep -qF "rekeyhome" && { echo "selfcheck fail: rekey arm emitted without the park column"; exit 1; }
  printf '%s' "$(strand_orphan_arm 2.78.19 2)" | grep -qF "rekeyhome" && { echo "selfcheck fail: rekey arm leaked into the orphan slice"; exit 1; }
  printf '%s' "$(strand_sql 2.78.20 2)" | grep -qF "orphanhome" || { echo "selfcheck fail: orphan arm missing at the current gate pair"; exit 1; }
  # and it must never ride the wedge slice, whose clause counts assume one branch set
  printf '%s' "$WEDGE_OFF" | grep -qF "orphanhome" && { echo "selfcheck fail: orphan arm leaked into the wedge slice"; exit 1; }
  # READY-ROUND arm (#443): floor matrix + the SQL's own clauses. BELOW the floor the
  # note-dispatch bounce produces the shape legally (a send on a parked task), so the arm
  # must be ABSENT there — a misattributed alert on a pre-fix image is worse than silence.
  # At/above it the arm is present exactly once, and its scope/reviewer/run/owner clauses
  # are pinned on the arm's OWN bytes (a whole-SQL grep would stay green with the arm
  # deleted: the wedge shares several of these fragments).
  ready_floor_met 2.78.25 && { echo "selfcheck fail: ready arm on below the #443 floor"; exit 1; }
  ready_floor_met 2.78.26 || { echo "selfcheck fail: ready arm off at the #443 floor"; exit 1; }
  ready_floor_met 2.78.100 || { echo "selfcheck fail: ready arm off above the floor"; exit 1; }
  ready_floor_met 3.0.0 || { echo "selfcheck fail: ready arm off at the next major"; exit 1; }
  ready_floor_met '' && { echo "selfcheck fail: ready arm on with no version"; exit 1; }
  ready_floor_met guard-error && { echo "selfcheck fail: ready arm on with a guard error"; exit 1; }
  ready_floor_met 2026.11.13 && { echo "selfcheck fail: ready arm opened on a date"; exit 1; }
  ready_floor_met 2.78.26-rc1 && { echo "selfcheck fail: ready arm opened on a pre-release"; exit 1; }
  printf '%s' "$(strand_sql 2.78.25 2)" | grep -qF "readyround" && { echo "selfcheck fail: ready arm emitted below the #443 floor"; exit 1; }
  [ "$(printf '%s' "$(strand_sql 2.78.26 2)" | grep -oF "select 'readyround'" | wc -l)" = "1" ] || { echo "selfcheck fail: ready arm missing at/above the floor"; exit 1; }
  READY_ON=$(strand_ready_arm 2.78.26 2)
  printf '%s' "$READY_ON" | grep -qF "s.category in ('ready', 'working')" || { echo "selfcheck fail: ready arm scope"; exit 1; }
  printf '%s' "$READY_ON" | grep -qF "join ai_employees a on a.user_id = r.reviewer_id" || { echo "selfcheck fail: ready arm live-reviewer clause"; exit 1; }
  # #445: the round clause is TASK-WIDE — pinning `round = max(round)` hid an older-round
  # strand (resubmit opens the next round insert-only, older rows are never superseded), so
  # the subselect must be GONE from the arm's bytes; its absence is the pin
  printf '%s' "$READY_ON" | grep -qF "r.round = (select max" && { echo "selfcheck fail: ready arm still pins the current round (#445 made it task-wide)"; exit 1; }
  printf '%s' "$READY_ON" | grep -qF "tr.status = 'RUNNING'" || { echo "selfcheck fail: ready arm live-run clause"; exit 1; }
  # the never-dispatched clause (stallrv's own run-age compare) must NOT ride this arm —
  # a parked reviewer WAS dispatched; pin its distinctive bytes absent
  printf '%s' "$READY_ON" | grep -qF "tr.started_at >= r.created_at" && { echo "selfcheck fail: ready arm imported the never-dispatched clause"; exit 1; }
  READY_GAP="m.body like 'status: %' and exists (select 1 from task_message_activities a2 where a2.message_id = m.id and a2.payload->>'kind' = 'STATUS') and m.created_at > r.created_at)"
  [ "$(printf '%s' "$READY_ON" | grep -oF "$READY_GAP" | wc -l)" = "1" ] || { echo "selfcheck fail: ready arm owner-status gap clause"; exit 1; }
  # the HOLD-LANDING exclusion (the one declared legal shape): the resume note must be
  # newer than the row it re-opened, carry the machine STATUS kind, and ride this arm only
  READY_HOLD="m3.body like 'review round resumed%' and a3.payload->>'kind' = 'STATUS' and m3.created_at > r.created_at)"
  [ "$(printf '%s' "$READY_ON" | grep -oF "$READY_HOLD" | wc -l)" = "1" ] || { echo "selfcheck fail: ready arm hold-landing gap clause"; exit 1; }
  # the stalled-review arm's never-dispatched clause must NOT ride this arm: a parked
  # reviewer WAS dispatched (its turn failed), so importing it would exclude the exact
  # #443 shape from the only arm that can see it
  printf '%s' "$READY_ON" | grep -qF "tr.status = 'DONE'" && { echo "selfcheck fail: ready arm carries the stalled-review dispatch clause"; exit 1; }
  # no slice leakage: the sibling arms' clause counts assume their own branch set
  printf '%s' "$WEDGE_OFF" | grep -qF "readyround" && { echo "selfcheck fail: ready arm leaked into the wedge slice"; exit 1; }
  printf '%s' "$ORPHAN_ON" | grep -qF "readyround" && { echo "selfcheck fail: ready arm leaked into the orphan slice"; exit 1; }
  # EGRESS-ORIGIN arm (#427): the floor matrix, the column gate, and the SQL's clauses —
  # the detector is pinned by the bytes that ship (a test-side copy is not a pin). A
  # shape-unguarded floor (a date/IP that sorts above every version) must stay CLOSED.
  egress_arm_on 2.78.24 && { echo "selfcheck fail: egress arm on below the floor"; exit 1; }
  egress_arm_on 2.78.25 || { echo "selfcheck fail: egress arm off at the floor"; exit 1; }
  egress_arm_on 3.0.0 || { echo "selfcheck fail: egress arm off above the floor"; exit 1; }
  egress_arm_on '' && { echo "selfcheck fail: egress arm on with no version"; exit 1; }
  egress_arm_on 2026.11.13 && { echo "selfcheck fail: egress arm opened on a date"; exit 1; }
  egress_arm_on 9223372036854775808.1.1 && { echo "selfcheck fail: egress arm opened on an overflowing major"; exit 1; }
  egress_arm_on 999999999999999999999999999999.1.1 && { echo "selfcheck fail: egress arm opened on a huge major"; exit 1; }
  egress_arm_on 100.64.0 && { echo "selfcheck fail: egress arm opened on an IP"; exit 1; }
  egress_arm_on 2.78.25-rc1 && { echo "selfcheck fail: egress arm opened on a pre-release"; exit 1; }
  # a leading-zero major must NOT crash the arithmetic (`08` is not a valid octal literal);
  # the verdict is irrelevant, the absence of a shell error is the assertion
  egress_arm_on 08.1.2; [ $? -le 1 ] || { echo "selfcheck fail: leading-zero major crashed"; exit 1; }
  [ "$(at_least 2.78.25 2.78.25)" = "1" ] || { echo "selfcheck fail: floor equal"; exit 1; }
  [ "$(at_least 2.78.25 2.78.26)" = "1" ] || { echo "selfcheck fail: floor above"; exit 1; }
  [ "$(at_least 2.78.25 2.78.24)" = "0" ] || { echo "selfcheck fail: floor below"; exit 1; }
  [ "$(at_least 2.78.25 '')" = "0" ] || { echo "selfcheck fail: floor empty"; exit 1; }
  [ "$(at_least 2.78.25 2026.11.13)" = "0" ] || { echo "selfcheck fail: floor non-semver date"; exit 1; }
  [ "$(at_least 2.78.25 2.78.25-rc1)" = "0" ] || { echo "selfcheck fail: floor non-semver pre-release"; exit 1; }
  EGSQL_PIN=$(egress_sql)
  printf '%s' "$EGSQL_PIN" | grep -qF "s.category <> 'paused'" || { echo "selfcheck fail: egress scope"; exit 1; }
  printf '%s' "$EGSQL_PIN" | grep -qF "t.park_from_status is not null or t.pre_block_status is not null" || { echo "selfcheck fail: egress origin clause"; exit 1; }
  printf '%s' "$EGSQL_PIN" | grep -qF 't.updated_at' && { echo "selfcheck fail: egress arm reads a mutable stamp"; exit 1; }
  printf '%s' "$EGSQL_PIN" | grep -qF 'park_rearm' && { echo "selfcheck fail: egress arm keys on the ledger"; exit 1; }
  printf '%s' "$EGSQL_PIN" | grep -qF "select 'egressorigin'" || { echo "selfcheck fail: egress arm tag"; exit 1; }
  # WIRING pin (r1 review, mutation-proved): the emit mode and the pass are two places;
  # without this, deleting the pass's whole arm block keeps every other assertion green and
  # ships a detector that never runs. Assert the gate + the alert are in the SHIPPED file,
  # exactly once each.
  EGPASS=$(grep -cE '^[[:space:]]*if egress_arm_on "\$V"; then' "$0" 2>/dev/null || true)
  [ "$EGPASS" = "1" ] || { echo "selfcheck fail: egress pass gate missing ($EGPASS)"; exit 1; }
  EGALERT=$(grep -cE '^[[:space:]]*anom\+=\("egress_origin:' "$0" 2>/dev/null || true)
  [ "$EGALERT" = "1" ] || { echo "selfcheck fail: egress alert line missing ($EGALERT)"; exit 1; }
  EGPSQL=$(grep -cE '^[[:space:]]*EGSQL=\$\(egress_sql\)' "$0" 2>/dev/null || true)
  [ "$EGPSQL" = "1" ] || { echo "selfcheck fail: egress pass does not run the shipped SQL ($EGPSQL)"; exit 1; }
  # a degraded column probe must ALERT, never sit silent (probe law #2: a blind detector
  # that reports nothing is indistinguishable from a healthy one)
  EGCOLALERT=$(grep -cE '^[[:space:]]*anom\+=\("egress_guard: origin columns=' "$0" 2>/dev/null || true)
  [ "$EGCOLALERT" = "1" ] || { echo "selfcheck fail: egress column-degraded alert missing ($EGCOLALERT)"; exit 1; }
  [ "$(to_epoch_s 1793957516932)" = "1793957516" ] || { echo "selfcheck fail: epoch ms"; exit 1; }
  [ "$(to_epoch_s 1793957516)" = "1793957516" ] || { echo "selfcheck fail: epoch s"; exit 1; }
  printf 'img unhealthy\n' | grep -qw healthy && { echo "selfcheck fail: unhealthy matched healthy"; exit 1; }
  printf 'img healthy\n' | grep -qw healthy || { echo "selfcheck fail: healthy missed"; exit 1; }
  echo "ok probe selfcheck"
  exit 0
fi
if [ "${1:-}" = "--egress-sql" ]; then
  # Emit the exact egress-origin SQL a pass would run (no network, no state writes): the
  # arm's regression test (test/e2e/probe-egress-origin.spec.ts) seeds a test DB and runs
  # THESE bytes, never a test-side copy. An optional column-count arg replicates the pass's
  # column gate: the clause names both columns, so a one-column image must refuse (exit 2)
  # rather than print bytes that throw — that path is pinned by the same spec.
  if [ -n "${2:-}" ] && [ "$2" != "2" ]; then exit 2; fi
  egress_sql
  printf '\n'
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
mkdir -p "$PROBE_STATE" 2>/dev/null || true
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

# 5b-ii. EGRESS EXHAUSTION (#427, floor-gated): every legal egress from a paused block
# (the two settle flips, the owner's manual move, abandon's cancel, the note-dispatch
# bounce, and the idle-liveness bounce — which CASes on the status its scan read precisely
# so a block landing in the scan window is never yanked out) clears both gating origins in
# the SAME statement that lands the status. An
# ORIGIN on a row that is NOT in the paused category is therefore an illegal shape after
# that release: it is a restore home for a block that does not exist, every discriminator
# resolves those columns on a paused row only, and nothing heals it — the next auto-block
# overwrites the home, a later park inherits a home it never recorded.
# NOT timestamp-scoped on purpose (r1 review, P1): `updated_at` is the row's last write,
# not the egress wire, so ANY benign edit (a title save, a reassignment, a dispatch claim)
# bumps it — a pre-fix leftover touched once would alert as a live egress failure and
# drown a real regression. The shape is strictly illegal on a floored image and the floor
# is the discriminator: no pre-fix row can be told apart from a live failure, so the arm
# reports both and the operator reads the row's own history.
# Keyed on the ORIGINS alone, never the ledger: the block's own resume legally leaves the
# attempt ledger on a live row (#211 bounded cycles), so a ledger term would alert on a
# healthy row. Own psql pass (probe law #4) + column gate (column-absent law).
if egress_arm_on "$V"; then
  # the arm's OWN column probe: the verge flow below runs later in the file, and this arm
  # must never assume a column count it did not read (column-absent law)
  EGCOL=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"select count(*) from information_schema.columns where table_name='tasks' and column_name in ('park_from_status','pre_block_status')\"" 2>/dev/null) || EGCOL="guard-error"
  if [ "$EGCOL" = "guard-error" ]; then
    anom+=("egress_guard: column probe failed — #427 origin-exhaustion detection blind")
  elif [ "$EGCOL" != "2" ]; then
    # a floored image that does not carry both origin columns is a BROKEN probe, not a
    # healthy one: the arm cannot run at all, so staying silent would be a blind detector
    anom+=("egress_guard: origin columns=$EGCOL on $V (expected 2) — #427 arm blind")
  elif [ "$EGCOL" = "2" ]; then
    EGSQL=$(egress_sql)
    EGERR=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$EGSQL\"" 2>&1 >/dev/null | grep -m1 ERROR)
    EGOUT=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"$EGSQL\"" 2>/dev/null) || EGOUT="db-unreachable"
    if [ "$EGOUT" = "db-unreachable" ]; then
      anom+=("egress: unreachable ${EGERR:-psql failed}")
    else
      EGRIDS=$(echo "$EGOUT" | awk -F'|' '/^egressorigin/{print $2}')
      if [ -n "${EGRIDS:-}" ] && [ "$EGRIDS" != "none" ]; then
        anom+=("egress_origin: non-blocked row(s) still carrying a gating origin [$EGRIDS] — an egress did not exhaust its block memory, #427 class")
      fi
    fi
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
#   (a) DEAD-ROUND WEDGE (#292 class, #430): a review-flow-owned task whose CURRENT
#       round has NO PENDING row, holds at least one VERDICT row, was decided after the
#       activity store existed, and takes NO OWNER status write newer than that round's
#       newest verdict — the round opened, its verdicts landed, and the task never left
#       the review-flow shape (round-open teardown / settle-arbitration regressions).
#       The OWNER-status discriminator replaces the retired verdict-vs-updated_at
#       ordering: a manual move is an authored `status: …` activity row (body + payload
#       kind STATUS, committed in the same transaction as the status write), so a legal
#       re-queue over a decided round always carries its move AFTER the verdict, while a
#       machine status write (auto-block/unblock, park, settle) logs its own body and can
#       never look like one; a task write that is NOT a status write (a title edit, the
#       child-restore) no longer masks the shape. VERSION-GATED: this rule is sound only
#       on an image that writes the record ATOMICALLY with the status move (2.78.24+);
#       below the floor the arm keeps the retired verdict-vs-write ordering, because an
#       old image could lose a move's record to a crash and a missing row would prove
#       nothing. A PENDING row in the current round means a live (or suspended) round,
#       and an older round's rows are debris the current-round clause ignores.
#       BLOCK BRANCH (#424): the same wedge can strand a task in a child-derived
#       gating auto-block — #419 keeps the round running there, so a kill between
#       recordVerdict's row write and flipTask leaves a PAUSED block (origin
#       resolving to in_review, no park origin) with a CLOSED current round: no
#       PENDING row in max(round) and at least one verdict row in it. That branch
#       carries the SAME owner-status discriminator as the in_review half,
#       and it reads the CURRENT round only: any PENDING row there — a void row from a
#       removed reviewer included — means the round is still suspended, never a wedge.
#       A PARK's closed round is out of this arm's scope (#431).
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
# created_at, task_runs.status/employee_id/started_at, task_messages.task_id/body/
# created_at, task_message_activities.message_id/payload, ai_employees.user_id,
# tasks.status/updated_at, task_runs.finished_at/id — all verified against the live
# schema.
STRCOL=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"select (to_regclass('task_reviews') is not null and to_regclass('task_obligations') is not null)::int\"" 2>/dev/null) || STRCOL="guard-error"
# OWNERSHIP predicate (#419), built INSIDE strand_sql so the pass, --selfcheck and
# --strand-sql share one copy: the stranded-round arms cover a task the review flow still
# owns — in_review, plus (from 2.78.20, whose sweeps heal that shape) a PAUSED gating
# auto-block whose recorded origin resolves to in_review. Both gates are load-bearing:
# pre-#401 images lack the two origin columns (column-absent law — one missing column
# kills the whole UNION), and a pre-#419 image cannot heal the block shape, so the arm
# must stay silent there rather than misattribute cause.
ORIGCOL=$("${CT[@]}" "docker exec -i work-ultranomic-net-tandem-db-1 psql -U tandem -d tandem -t -A -c \"select count(*) from information_schema.columns where table_name='tasks' and column_name in ('park_from_status','pre_block_status')\"" 2>/dev/null) || ORIGCOL="guard-error"
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
        anom+=("wedge_round: review-flow-owned task (in_review or gating block) with no PENDING row in its current round [$WEDGE] — dead round, #292/#424/#430 class")
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
    # inside strand_sql (2.78.20), so this floor keeps the older in-review detector alive.
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
    # gated inside strand_sql (2.78.20).
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
    # (f) orphan home: a block/park whose recorded origin names NO task_statuses row and
    # whose current round closed anyway (#432). VERSION-INDEPENDENT: a pre-guard image
    # produces the strand and a post-guard one only reaches it by a guard regression, so
    # the arm alerts wherever it is seen (no floor, no state left behind by gating).
    # Previous-pass presence confirm + id-set dedupe, like every other shape arm.
    ORPHANHOME=$(echo "$STROUT" | awk -F'|' '/^orphanhome/{print $2}')
    if [ -n "${ORPHANHOME:-}" ] && [ "$ORPHANHOME" != "none" ] && [ "$(cat "$PROBE_STATE/orphanhome.prev" 2>/dev/null || echo none)" != "none" ]; then
      if [ "$(cat "$PROBE_STATE/orphanhome.alerted" 2>/dev/null || echo none)" != "$ORPHANHOME" ]; then
        anom+=("orphan_home: blocked task whose recorded block/park home names no status row [$ORPHANHOME] — the settle flip cannot land, #432 class")
        echo "$ORPHANHOME" > "$PROBE_STATE/orphanhome.alerted"
      fi
    else
      rm -f "$PROBE_STATE/orphanhome.alerted"
    fi
    printf '%s\n' "${ORPHANHOME:-none}" > "$PROBE_STATE/orphanhome.prev"
    # (g) ready-category task owning a live PENDING row of ANY round (#443, task-wide per
    # #445): the parked/stranded round a legal egress or a teardown regression left behind
    # — no sweep reaches a ready task (stalled-review and lost-settle require review-flow
    # ownership), so the reviewer never decides, and an older round's rows are never
    # superseded (a resubmit opens the next round insert-only), so the clause is pinned to
    # NO round — `round = max(round)` left an older-round strand invisible (#445). Below the
    # floor the note-dispatch bounce produces the shape legally, so the arm is gated OUT
    # here (no state, no alert): the floor is the release whose dispatch flip resolves the
    # round in the same transaction. Previous-pass presence confirm + id-set dedupe.
    if ready_floor_met "$V"; then
      READYROUND=$(echo "$STROUT" | awk -F'|' '/^readyround/{print $2}')
      if [ -n "${READYROUND:-}" ] && [ "$READYROUND" != "none" ] && [ "$(cat "$PROBE_STATE/readyround.prev" 2>/dev/null || echo none)" != "none" ]; then
        if [ "$(cat "$PROBE_STATE/readyround.alerted" 2>/dev/null || echo none)" != "$READYROUND" ]; then
          anom+=("ready_round: ready/working task owning a live PENDING AI reviewer row of ANY round with no running run [$READYROUND] — round left behind by an egress or a teardown regression, #443 class (task-wide per #445)")
          echo "$READYROUND" > "$PROBE_STATE/readyround.alerted"
        fi
      else
        rm -f "$PROBE_STATE/readyround.alerted"
      fi
      printf '%s\n' "${READYROUND:-none}" > "$PROBE_STATE/readyround.prev"
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
