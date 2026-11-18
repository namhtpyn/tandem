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
# same lost-flip shape, read by the DECISION-PARK arm (parkclosed, appended last): a
# ladder-owned park is resumed by the re-arm sweep and an exhausted one by the 5b ladder
# arm, so only the DECISION park (park_rearm_after null, attempts 0) needs a reader here.
# The two non-settle
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
# BLOCK/PARK FLOW-RECORD floor (#466, 2.78.38): the gating auto-block note and the
# review park note commit in the SAME transaction as their guarded status write (SPEC
# "BLOCK-PARK RECORD"), so on a floored image every machine block/park carries its own
# flow record. The paused-row arms order a round's verdict against that record instead of
# `tasks.updated_at` — the stamp is MASKABLE: any later task write (a title/description/
# assignee edit) stamps past the verdict and a real strand reads as legal forever. A
# row with NO block/park note at all (pre-note-era state or a direct-SQL write) falls
# back to the stamp, so those rows stay covered until they drain. The notes predate the
# floor — what it adds is ATOMICITY: a pre-floor block whose note was lost to a crash is
# a DECLARED era-bounded residual (an older record can order that row). RE-DERIVE the
# floor for the release that actually ships the atomic writer — never assume it.
FLOW_FLOOR=2.78.38
flow_floor_met() {
  [ "$(at_least "$FLOW_FLOOR" "${1:-}")" = "1" ]
}
# the newest gating FLOW RECORD for the task: the block/park note bodies are single-writer
# machine strings (`auto-blocked: N subtask(s) open` #419, `review parked — <why>` #202)
# and the 1:1 activity payload must carry kind='STATUS'. The record is unforgeable by
# free text: each record body has exactly ONE writer (the gating block arm, parkRound), both mint
# kind='STATUS' and a fixed machine PREFIX ('auto-blocked:' / 'review parked — ') no
# other body produces; the park's <why> tail IS free text but sits AFTER the matched
# prefix, so it cannot mint a record — the same WRITER-SET argument as #430's owner
# record. NULL for a row with no such note: callers coalesce to tasks.updated_at.
flow_record_ts() {
  printf "%s" "(select max(m.created_at) from task_messages m where m.task_id = t.id and (m.body like 'auto-blocked:%' or m.body like 'review parked %') and exists (select 1 from task_message_activities a where a.message_id = m.id and a.payload->>'kind' = 'STATUS'))"
}
verdict_ts() { # $1 = max|min
  case "${1:-}" in max|min) ;; *) return 1 ;; esac
  printf "(select %s(coalesce(r.decided_at, r.created_at)) from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id))" "$1"
}
# paused-row ordering (#466): verdict vs the newest FLOW RECORD at/above the floor, the
# retired verdict-vs-write stamp below it. $1 = max|min, $2 = prod version.
paused_order() {
  case "${1:-}" in max|min) ;; *) return 1 ;; esac
  if flow_floor_met "${2:-}"; then
    printf "%s > coalesce(%s, t.updated_at)" "$(verdict_ts "$1")" "$(flow_record_ts)"
  else
    printf "%s > t.updated_at" "$(verdict_ts "$1")"
  fi
}
# RE-KEY per-verdict ordering (#468): at/above the flow floor the arm asks whether ANY
# verdict of the current round is NEWER than the record of the origin that makes the row
# TERMINAL — a round still LIVE when that block/park landed (one vote in, the settling
# vote after) is the split-timing wedge the aggregate MIN test missed, and a later task
# write cannot mask it. An all-older round is the legal #423 settle-then-reblock (its
# applied verdict predates its record). The record is the origin's OWN note, never the
# task-wide newest gating note: a park whose note was lost to the declared pre-floor
# crash residual must not order against an older auto-blocked note. Below the floor, and
# for a row carrying NO note of that kind, the MIN-vs-stamp test stands: the #467
# flip->supersede window (closed by 2.78.35's atomic sweep) could legally leave one
# verdict past the stamp on a pre-floor image, and a note-less row is exactly such a row
# until it drains. $1 = prod version, $2 = the origin's record-ts expression.
paused_order_any() {
  if flow_floor_met "${1:-}" && [ -n "${2:-}" ]; then
    printf "case when %s is null then %s > t.updated_at else exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id) and coalesce(r.decided_at, r.created_at) > %s) end" "${2:-}" "$(verdict_ts min)" "${2:-}"
  elif flow_floor_met "${1:-}"; then
    return 1
  else
    printf "%s > t.updated_at" "$(verdict_ts min)"
  fi
}
# the BLOCK's own note (#419): unlike flow_record_ts's task-wide newest gating note, this
# reads only the single-writer auto-block body, so a park-origin row never borrows it.
block_record_ts() {
  printf "%s" "(select max(m.created_at) from task_messages m where m.task_id = t.id and m.body like 'auto-blocked:%' and exists (select 1 from task_message_activities a where a.message_id = m.id and a.payload->>'kind' = 'STATUS'))"
}
# PARK RECORD (the park's OWN flow note): the arm orders its verdict against the note the
# park write itself produced. Unlike flow_record_ts (the task-wide newest gating note,
# which an older auto-blocked note can satisfy on a parked row whose park note never
# landed), this reads only the single-writer park body plus its 1:1 kind='STATUS' payload.
park_record_ts() {
  printf "%s" "(select max(m.created_at) from task_messages m where m.task_id = t.id and m.body like 'review parked %' and exists (select 1 from task_message_activities a where a.message_id = m.id and a.payload->>'kind' = 'STATUS'))"
}
# park-row ordering (#466): verdict vs the park's own record at/above the floor, the
# retired verdict-vs-write stamp below it. $1 = max|min, $2 = prod version.
park_order() {
  case "${1:-}" in max|min) ;; *) return 1 ;; esac
  if flow_floor_met "${2:-}"; then
    printf "%s > coalesce(%s, t.updated_at)" "$(verdict_ts "$1")" "$(park_record_ts)"
  else
    printf "%s > t.updated_at" "$(verdict_ts "$1")"
  fi
}
# HOME-CATEGORY RECORD floor (#491, 2.78.41): the gating auto-block note's payload carries
# the recorded home's CATEGORY at write time (`homeCategory`, minted in the block's own
# transaction), so the RE-KEYED-HOME arm can separate the legal #423 settle-then-reblock
# (the recorded category was ALREADY terminal) from a home re-keyed terminal AFTER the
# record (recorded non-terminal, resolves terminal now) over an all-older round — the
# strand no ordering term can see, because every verdict predates the note. The field
# exists only on notes written by a floored image; a pre-floor note carries no category
# and its row falls back to the ordering term, which is all a note-less row ever had.
# RE-DERIVE the floor for the release that actually ships the writer — never assume it.
HOME_CATEGORY_FLOOR=2.78.41
home_floor_met() {
  [ "$(at_least "$HOME_CATEGORY_FLOOR" "${1:-}")" = "1" ]
}
# the block origin's recorded-at-block category, read from the origin's OWN newest
# `auto-blocked:` record (never the task-wide newest gating note): a recorded category
# that DIFFERS from the category the recorded home carries NOW means the home was re-keyed
# AFTER the record — every legal block records the category its home had at write time, so
# the equality is what separates the legal classes (#423's settle, a hold-landing block)
# from the strand. A terminal->terminal re-key (done -> cancelled) is the same term. The
# round must be DECIDED (at least one verdict); when one is newer than the record the
# ordering term fires first, so no ordering conjunct is needed here. Empty below the floor
# and on a note-less row; a null or empty record never fires.
home_category_term() {
  home_floor_met "${1:-}" || return 1
  printf "exists (select 1 from task_messages mh join task_message_activities ah on ah.message_id = mh.id where mh.task_id = t.id and mh.body like 'auto-blocked:%%' and ah.payload->>'kind' = 'STATUS' and ah.payload->>'homeCategory' is not null and ah.payload->>'homeCategory' <> '' and not exists (select 1 from task_statuses oc where oc.id = t.pre_block_status and oc.category = ah.payload->>'homeCategory') and mh.created_at = %s) and exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id))" "$(block_record_ts)"
}
# the block-origin half of the RE-KEYED-HOME arm: the per-verdict ordering term, OR the
# category term at/above its floor. Below the floor the expression is the ordering term
# alone, byte-identical to the pre-#491 arm.
rekey_pre_half() {
  local order cat
  order=$(paused_order_any "${1:-}" "$(block_record_ts)")
  cat=$(home_category_term "${1:-}")
  if [ -n "$cat" ]; then printf "(%s or %s)" "$order" "$cat"; else printf "%s" "$order"; fi
}
# ALL-OLDER round vs the BLOCK's own record (#496): the strict negation of the ordering
# term — NO decided verdict of max(round) is newer than the newest auto-blocked record.
# The non-terminal half needs it because the ordering term itself is unusable there: a
# legal hold-landing block is closed by a verdict that POSTDATES its record, so ANY
# post-record verdict must keep that half silent instead of reading it as the strand.
block_all_older() {
  printf "not exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id) and coalesce(r.decided_at, r.created_at) > %s)" "$(block_record_ts)"
}
# NON-TERMINAL LATE RE-KEY half (#496, floor 2.78.41): the category term on a home that
# resolves NON-terminal (ready/working/todo/waiting_answer; in_review is excluded by the
# arm's own origin exclusion and re-stated here) — a status re-keyed into a non-terminal
# category while its task already sat blocked over a live round: the block recorded the
# category it read, the home resolves another one now, resolveRestoreTarget demotes a
# working target to to-do so the live round is dropped and the task lands in to-do when its
# children close — settledByOwner is false and the park heals are park-only, so no healer
# reaches it. The legal hold-landing class records the category it RESOLVES (recorded ==
# resolved) and stays silent, and the ordering term is NOT reused here (block_all_older).
# Empty below the floor and on a note-less row, so the pre-floor SQL stays byte-identical.
rekey_nonterminal_half() {
  local cat older
  home_floor_met "${1:-}" || return 1
  cat=$(home_category_term "${1:-}")
  [ -n "$cat" ] || return 1
  older=$(block_all_older)
  printf " or ((t.pre_block_status is not null and exists (select 1 from task_statuses o where o.id = t.pre_block_status and o.category not in ('done', 'cancelled', 'in_review')) and %s and %s))" "$cat" "$older"
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
  local own blkarm orphan rekey decided gap rule ready
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
  # row) plus its OWN verdict-vs-FLOW-EVENT ordering (#466): the newest verdict of that
  # round NEWER than the task's newest gating FLOW RECORD (BLOCK-PARK RECORD FLOOR,
  # 2.78.38), with the retired `tasks.updated_at` stamp below the floor and as the
  # record-less-row fallback — a later benign task edit can no longer mask the strand.
  # EITHER column alone
  # dangles: a row carrying both origins (no live writer emits that, but the schema
  # permits it) still fires when one of them lost its row. No legal write path produces
  # it: a gating block records the task's own status (a row that exists at write time), a
  # park records an in-review home, a hand-made block clears both origins, and
  # statuses.remove re-homes every recorded reference inside its delete transaction
  # (STATUS-ORIGIN MEMORY LAW) — so a surviving count means a direct-SQL delete, a guard
  # regression, or the ghost-task window the law declares (a task moved into the status
  # while it was being deleted). The arm also requires NEITHER origin to resolve to an
  # in-review home: the flip can still land through a resolvable park origin, so such a
  # row is not this shape (the wedge's park exclusion, mirrored). VERSION-INDEPENDENT as
  # an ARM on purpose (a pre-guard image still produces the strand, so no image floor on
  # emission — only its ORDERING term is floor-gated, #466), but COLUMN-GATED like the
  # block branch: the arm reads
  # park_from_status, and an origin column absent on the running image would kill the
  # WHOLE UNION (probe law #5 / #325) and blind every arm.
  orphan=""
  if [ "${2:-}" = "2" ]; then
    orphan=" union all select 'orphanhome', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status where s.category = 'paused' and ((t.pre_block_status is not null and not exists (select 1 from task_statuses o where o.id = t.pre_block_status)) or (t.park_from_status is not null and not exists (select 1 from task_statuses o where o.id = t.park_from_status))) and not exists (select 1 from task_statuses o where o.category = 'in_review' and (o.id = t.pre_block_status or o.id = t.park_from_status)) and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and $(paused_order max "${1:-}")) x), 'none')"
  fi
  # RE-KEYED-HOME arm (#435): a PAUSED row whose recorded block/park origin RESOLVES to
  # a TERMINAL (done/cancelled-category) home — the home EXISTS, but its category moved
  # after the block recorded it (statuses.save's block-state-home guard is a
  # read-then-write check; a gating block committing AFTER the homes read but BEFORE the
  # category upsert is the DECLARED residual producer, the orphan arm's ghost-task class). The flip refuses
  # on the terminal home, the round closes on the verdict row with NO task write, and the
  # task stays blocked: the wedge's in_review branch cannot see it (the origin resolves
  # outside in_review), the ORPHAN-HOME arm cannot (the home exists), and the teardown
  # heals read it as owner-settled. TERMINAL-only is a DECLARED SCOPE boundary, not a SQL
  # impossibility: a hold-landing repair round re-opened on a ready/working status and then
  # gating-blocked legally records a non-review home whose category MATCHES the one it
  # resolves, so `homeCategory` would separate it from a re-key into a NON-terminal
  # category — that wider term is OUT of this arm and tracked as #496 (SPEC states the
  # boundary). A terminal
  # home DOES legally host the #423 re-block-after-settle class (a settle to a terminal
  # status, then a still-open child re-blocks with the settled status as home): its
  # applied verdict PREDATES the re-block record, so a round whose verdicts are ALL older
  # than the record is legal. The ordering is therefore PER VERDICT (#468): at and above
  # the BLOCK-PARK RECORD FLOOR (#466, 2.78.38) the arm fires when ANY verdict of the
  # round is NEWER than the record of the origin that makes the row TERMINAL — its OWN
  # single-writer note (the block's `auto-blocked:` for a pre_block_status home, the
  # park's `review parked` for a park home), never the task-wide newest gating note: a
  # park whose note was lost to the declared pre-floor crash residual must not borrow an
  # older auto-blocked note. A round still LIVE when that note landed (one vote in, the
  # settling vote after) is the split-timing wedge the aggregate MIN test missed, and a
  # record ordering cannot be masked by a later task write. Every settle path at/above
  # the floor THAT LANDS ITS SWEEP supersedes its pending rows BEFORE its re-gate, so a
  # post-note verdict cannot be the #467 late-CAS window on a floored row (closed by
  # 2.78.35's atomic sweep): it means the round was open at the block — except on the
  # degraded path that skips its sweep (residual (a)). An ALL-OLDER round is the legal
  # #423 re-block, the LATE re-key the category term below FIRES on, or the PRE-BLOCK
  # re-key it cannot see (residual (c)). LATE re-key (#491, floor 2.78.41): a status
  # re-keyed terminal while its task already sits BLOCKED over a live round (the
  # block-state-home guard's read->upsert window, or a guard regression) — the block's
  # note records the NON-terminal category it read, the home resolves terminal now, the
  # pending turn is superseded by the owner-settled teardown and every verdict predates
  # the note, so the ordering term is blind and `home_category_term` fires. PRE-BLOCK
  # re-key (residual (c)): re-keyed BEFORE the task blocks, so the note records the
  # ALREADY-terminal category and the row is SQL-identical to #423 — silent by
  # declaration, and closing it needs the home's IDENTITY at the round's OWN verdict time,
  # which no row carries (a category record cannot split them: both read in_review then). Below the floor the retired MIN-vs-stamp test
  # stands, and a row carrying NO note of that kind falls back to it. THREE DECLARED
  # residuals this SQL cannot see — (a) and (b) verified 0 rows in prod at the 2.78.40
  # deploy; (c) is a FALSE NEGATIVE and cannot be counted (the row is indistinguishable
  # from #423 by declaration): (a) a
  # floored probe
  # cannot era-gate a ROW, so a SETTLE that lost its sweep — the pre-2.78.35
  # flip->supersede crash window, and at ANY version the degraded settle path (flip
  # committed on the pool, sweep skipped by design when its isolation tx fails) — can
  # leave a post-note verdict that reads as the wedge; the PENDING heal signature keeps
  # it silent until it drains, so the residue is rare (failed isolation tx AND a verdict
  # CAS in the window); (b) the record is the NEWEST note of that kind, never tied to the
  # episode that set the origin, so a row whose CURRENT note was lost to a pre-2.78.38
  # crash and that still carries an EARLIER same-kind note orders against the older
  # record — a legal #423 row can read as the wedge (pre-floor crash or direct write);
  # A NOTE-LOSS FALSE NEGATIVE rides the same class, the other way: a note-less row
  # whose round was split across the origin write (live at the write, the settling vote
  # after) falls back to MIN and stays SILENT — the split-timing class this term exists
  # for is only observable when the note survives (pre-floor crash or direct write only);
  # (c) the PRE-BLOCK re-key: the home was re-keyed BEFORE the block, so its record's
  # category is terminal and the row is SQL-identical to #423 — the category term cannot
  # see it, and splitting it needs a record that no row carries (the home's identity at
  # the round's verdict time, not its category — at verdict time both shapes read
  # in_review). A direct
  # owner settle clears both origins in the same statement, so the residual owner-settle
  # shape is that machine re-block, excluded by the all-older test. The current-round
  # clause is mirrored from the orphan arm. Per-column resolve,
  # VERSION-independent (a pre-guard image produces the strand too), COLUMN-gated like
  # every arm that reads park_from_status (#325).
  rekey=""
  if [ "${2:-}" = "2" ]; then
    rekey=" union all select 'rekeyhome', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status where s.category = 'paused' and not exists (select 1 from task_statuses o where o.category = 'in_review' and (o.id = t.pre_block_status or o.id = t.park_from_status)) and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and (((t.pre_block_status is not null and exists (select 1 from task_statuses o where o.id = t.pre_block_status and o.category in ('done', 'cancelled'))) and $(rekey_pre_half "${1:-}")$(rekey_nonterminal_half "${1:-}")) or ((t.park_from_status is not null and exists (select 1 from task_statuses o where o.id = t.park_from_status and o.category in ('done', 'cancelled'))) and $(paused_order_any "${1:-}" "$(park_record_ts)")))) x), 'none')"
  fi
  # FINAL-PARK arm (#431) — the DECISION-class park (park_rearm_after IS NULL with
  # park_rearm_attempts = 0 — an exhausted ladder always carries attempts = 5 and is the
  # 5b arm's shape, a ladder-owned park is resumed by the re-arm sweep) whose current
  # round CLOSED after the park write and whose settle flip never landed. The park is the
  # round's own stop; the round can still CLOSE on a vote that was already in flight (an
  # AI reviewer's late verdict — `recordVerdict` has no category gate — or a replay), and
  # `settleRound` -> `flipTask` accepts a paused row whose park_from_status resolves
  # in-review; a crash between the verdict row and the flip leaves the task BLOCKED with
  # the park standing and a closed round. The owner's repair is a STATUS MOVE — the human
  # verdict verbs refuse a non-in_review task, so no approval can arrive here. A PENDING
  # row with NO reviewer (a void row from a reviewer removed mid-round) is a NON-VOTE by
  # `settleRound`'s own filter (`reviewerId !== null`), so the current-round clause ignores
  # it: that round still closes, and no sweep restores a FINAL park to settle it.
  # No other reader sees it: `stallrv`/`lostsettle` require a live PENDING row,
  # `settleExtinguishedRound` refuses a decided round, the re-arm scan filters
  # park_rearm_after IS NOT NULL, `restoreUnblocked` withholds a FINAL park, and the wedge
  # arm's ownership predicate excludes every parked row (`park_from_status IS NULL`). A
  # legal park keeps a PENDING row in its current round (the round is suspended, not
  # closed) — the same current-round clause as every sibling arm. The origin must RESOLVE
  # into review (a terminal home is the RE-KEYED-HOME arm, a dangling one ORPHAN-HOME) and
  # the ordering is the write-vs-verdict discriminator against the PARK's OWN flow record
  # at the #466 floor (the park-only note, not the task-wide helper: a stale auto-blocked
  # note on a parked row would order against the wrong flow; the retired `updated_at` stamp
  # below the floor and for a record-less row). The record is the newest `review parked`
  # note ON THE TASK, so a row whose CURRENT park note never landed can be ordered against
  # an EARLIER park episode's note — pre-floor crash or direct write only, the declared
  # residual. MAX, not
  # MIN (the re-key arm is per-verdict from its floor and MIN below it) — a multi-reviewer
  # round split across the park write (a vote before, the closing vote after) is this same
  # owed-flip shape, and a park whose home resolves in-review can always land its flip, so
  # the re-key arm's terminal-home late-row case has no analogue here. The
  # alert names the park as the owner's own resolution: the verdict is already recorded, so
  # the repair is a status move, never a re-arm.
  # COLUMN FLOOR 2.78.37: the arm reads referral_target_id (shipped there) besides the
  # re-arm columns; an image without any of them would kill the WHOLE union (#325), so the
  # arm vanishes below that release.
  # DECLARED BOUNDARIES (the two shapes OUT, and why each must stay out):
  # (1) MIRROR ORDER — a decision park whose note is NEWER than every verdict (the runner's
  # non-rearmable anomaly park after a crashed flip) is indistinguishable in SQL from the
  # LEGAL waiver park (`review escalation target became the assignee — referral waived;
  # resolve to resume`: it supersedes the escalated row and parks over a closed round) and
  # from a reviewer-deletion closure, so this arm cannot fire there. The re-armable
  # settle-throw park of the same crash class is OUT too (decision-class gate) and is
  # healed by the re-arm sweep.
  # (2) REFERRAL-OWED — a parked round that still owes a referral vote is EXCLUDED (the
  # round is not decided; settleRound returns 'waiting'), and the referral heal is
  # review-flow-scoped, so such a park is the owner's to move; declared, not reported.
  parkclosed=""
  if [ "${2:-}" = "2" ] && [ "$(at_least 2.78.37 "${1:-}")" = "1" ]; then
    parkclosed=" union all select 'parkclosed', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status where s.category = 'paused' and t.park_from_status is not null and t.park_rearm_after is null and t.park_rearm_attempts = 0 and exists (select 1 from task_statuses o where o.id = t.park_from_status and o.category = 'in_review') and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and not exists (select 1 from task_reviews e where e.task_id = t.id and e.round = (select max(r4.round) from task_reviews r4 where r4.task_id = t.id) and e.status = 'ESCALATED' and e.referral_target_id is not null and not exists (select 1 from task_reviews x where x.task_id = t.id and x.round = e.round and x.reviewer_id = e.referral_target_id)) and $(park_order max "${1:-}")) x), 'none')"
  fi
  printf "%s" "select 'wedge', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status where s.category = 'in_review' and not exists (select 1 from task_reviews r where r.task_id = t.id and r.status = 'PENDING' and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) and $rule${blkarm}) x), 'none') union all select 'strand', coalesce(string_agg(t.id::text, ',' order by t.id), 'none') from tasks t join task_statuses s on s.id = t.status where s.category = 'waiting_answer' and not exists (select 1 from task_obligations o where o.task_id = t.id and o.role = 'ANSWER' and o.status = 'PENDING') and (select max(coalesce(o.resolved_at, o.created_at)) from task_obligations o where o.task_id = t.id and o.role = 'ANSWER') > t.updated_at union all select 'orphanans', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_obligations o on o.task_id = t.id where s.category = 'waiting_answer' and o.role = 'ANSWER' and o.status = 'PENDING' and o.employee_id is null and not exists (select 1 from task_obligations o2 where o2.task_id = t.id and o2.role = 'ANSWER' and o2.status = 'PENDING' and o2.employee_id is not null)) x), 'none') union all select 'stallrv', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_reviews r on r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null join ai_employees a on a.user_id = r.reviewer_id where $own and r.round = (select max(r2.round) from task_reviews r2 where r2.task_id = t.id) and r.created_at < now() - interval '5 minutes' and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.status = 'RUNNING') and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.employee_id = r.reviewer_id and tr.started_at >= r.created_at)) x), 'none') union all select 'lostsettle', coalesce((select string_agg(x.id::text, ',' order by x.id) from (select distinct t.id from tasks t join task_statuses s on s.id = t.status join task_reviews r on r.task_id = t.id and r.status = 'PENDING' and r.reviewer_id is not null join ai_employees a on a.user_id = r.reviewer_id where $own and (t.assignee_id is null or r.reviewer_id <> t.assignee_id) and r.round = (select max(r2.round) from task_reviews r2 where r2.task_id = t.id) and not exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.status = 'RUNNING') and exists (select 1 from task_runs tr join task_messages tm on tm.id = tr.message_id where tm.task_id = t.id and tr.employee_id = r.reviewer_id and tr.status = 'DONE' and tr.started_at >= r.created_at and tr.finished_at < now() - interval '2 minutes' and not exists (select 1 from task_runs tr2 join task_messages tm2 on tm2.id = tr2.message_id where tm2.task_id = t.id and tr2.employee_id = r.reviewer_id and (tr2.started_at, tr2.id) > (tr.started_at, tr.id)))) x), 'none')${ready}${orphan}${rekey}${parkclosed}"
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
# the RE-KEYED-HOME arm alone (#435) — sliced to its own bytes; the FINAL-PARK arm
# follows it, so the slice also cuts that tail off
strand_rekey_arm() {
  strand_sql "${1:-}" "${2:-}" | sed "s/.*select 'rekeyhome'/select 'rekeyhome'/; s/ union all select 'parkclosed'.*//"
}
# the FINAL-PARK arm alone (#431) — the UNION's LAST emission, so the slice runs to the
# end; an arm that was gated OUT yields EMPTY (never the whole SQL: the gate pins assert it)
strand_parkclosed_arm() {
  local s
  s=$(strand_sql "${1:-}" "${2:-}")
  case "$s" in
    *"select 'parkclosed'"*) printf '%s' "$s" | sed "s/.*select 'parkclosed'/select 'parkclosed'/" ;;
  esac
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
# LOOP LIVENESS (#485): the crons that DO the loop's work had no no-LLM arm — a
# delivery-preflight outage (WebSocket 500) failed tandem-triage 30x and tandem-critic
# 3x in a row for 29h while every PRODUCT arm here stayed green, and the designated
# dead-man (the critic) is itself an LLM cron that died with the provider. The record is
# the SCHEDULER's own cron/jobs.json, never passes.jsonl: a job that keeps ticking while
# every run FAILS looks fresh in its trail and dead in reality, so liveness = last
# SUCCESS and success includes deliverability and completion.
# Terms per enabled job (the probe excluded — it cannot witness its own death), each
# carrying the CAUSE (never swallowed):
#   (a) running-but-failing: a non-ok last_status at failure_streak >= 2. An operator
#       cancel is NOT a failure (Hermes clears its error and keeps the streak).
#   (a2) NOT DELIVERED: last_status = delivery_failed — Hermes counts that as a
#       SUCCESSFUL run with failure_streak forced to 0, so without its own term a job
#       whose every run reaches nobody is invisible. delivery_queued is IN PROGRESS (the
#       outbox still owes it) and stays silent.
#   (b) overdue: next_run_at more than an hour in the past — the exact missed-fire signal,
#       and the ONLY term that catches a low-cadence job (monthly/quarterly/annual) in
#       hours instead of multiples of its own gap.
#   (b2) stale fire: the newest fire stamp (last_dispatch.dispatched_at, last_run_at —
#       whichever is newer) older than 2x the job's own MAX schedule gap. A job that never
#       ran has no baseline and stays silent.
#   (b3) dispatched but never completing: fires keep advancing while last_run_at sits
#       beyond max(4x gap, 12h) — a hung run or a wedged handoff, the same "runs but
#       lands nowhere" class as (a2). The 12h floor is measured: the loop's own triage
#       runs take up to 6.9h, and a schedule-gap multiple alone paged on healthy runs.
#   (c) a schedule whose gap cannot be derived is an anomaly, never silence: an
#       un-watched job is not a green one.
# The gap is the LONGEST legitimate gap between two fires, never the mean cadence, and it
# is enumerated exactly from the cron fields over an 8-year core horizon plus a buffer
# (union semantics when day-of-month AND day-of-week are both restricted, named
# months/weekdays, dom 29-31 reality, croniter's seconds-LAST 6-field form, 0 and 7 both
# Sunday). Worded statically and the repeat-suppression key masks volatile cause tails,
# so a standing fault alerts once instead of every 10-min tick. The loop's BRAIN jobs
# (tandem-triage / tandem-critic) carry the `loopdead:P0!:` prefix: their death is the
# loop's, and a cause string can never forge the token.
loop_liveness() { python3 - "$1" "${2:-$(date -u +%s)}" <<'PY'
import datetime, hashlib, json, re, sys, unicodedata
BRAIN = ("tandem-triage", "tandem-critic")
SELF = "tandem-prod-watch"
SPACES_RE = re.compile(r" {2,}")
TOKEN_CHARS = " ._-"
# every code point a Unicode-aware line splitter treats as a break: C0, DEL, C1, LS, PS
CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
ALPHA = "abcdefghijklmnopqrstuvwxyz"

def disc(n):
    # A LETTERS-ONLY discriminator of the RAW name: the repeat-suppression key masks
    # long digit runs and hex ids, so a hex/numeric suffix could be erased and two
    # colliding display tokens would share a key. 12 letters (26**12): a birthday
    # search for a deliberate pair needs ~10**9 sanitised variants.
    h = int.from_bytes(hashlib.sha256(n.encode("utf-8", "surrogatepass")).digest(), "big")
    out = ""
    for _ in range(12):
        h, r = divmod(h, 26)
        out += ALPHA[r]
    return out

def display(n):
    # The DISPLAY token only, never identity: every char that is not a letter, a digit,
    # a combining mark, a space, '.', '_' or '-' (control chars, ':', '!', '=') becomes a
    # space; runs collapse and the edges trim, so a name stays READABLE in any script
    # (an accented name is not shredded into letter soup) while it can never carry the
    # punctuation the level token or the join separator is built from. A name with
    # nothing left renders as <unprintable>. Any name the sanitiser changed carries a
    # `~<12 letters>` discriminator of the RAW name, so two jobs whose tokens collide
    # still emit distinct lines. The raw name stays the identity key, so padding still
    # classifies verbatim.
    out = "".join(
        c if (c.isalnum() or c in TOKEN_CHARS or unicodedata.category(c).startswith("M")) else " "
        for c in n)
    out = SPACES_RE.sub(" ", out).strip()
    if not any(c.isalnum() for c in out):
        out = "<unprintable>"
    if out != n:
        out += "~" + disc(n)
    return out

def out_line(s):
    # TOTAL emission: no interpolated field may forge a physical line, and neither a lone
    # surrogate nor a non-UTF-8 locale may kill the scan (a UnicodeEncodeError here would
    # blind every later job, the brain ones included). Bytes go straight to the stream, so
    # the LOCALE never re-encodes them.
    s = CTRL_RE.sub(" ", s)
    sys.stdout.buffer.write(s.encode("utf-8", "backslashreplace") + b"\n")
    sys.stdout.buffer.flush()

OK_STATUS = {"ok", "success", "completed", "cancelled", "delivery_queued"}
EXC_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*(Error|Exception|Warning)\b")
NAMES = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
         "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
         "SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6}
CORE_DAYS = 8 * 366 + 1
BUFFER_DAYS = 800  # gaps are read only from fires inside the core; the buffer supplies
                   # each one's TRUE successor (no cycle-length assumption in the wrap)

def expand(f, lo, hi):
    f = str(f)
    for name, val in NAMES.items():
        f = re.sub(r"\b%s\b" % name, str(val), f, flags=re.I)
    vals = set()
    try:
        for p in f.split(","):
            p = p.strip()
            step = 1
            if "/" in p:
                p, s = p.split("/", 1)
                step = int(s)
                if step <= 0:
                    return set()
            if p in ("*", "?"):
                a, b = lo, hi
            elif "-" in p:
                a, b = (int(x) for x in p.split("-", 1))
            else:
                a = int(p)
                b = hi if step > 1 else a
            if a < lo or b > hi or a > b:
                return set()
            vals.update(range(a, b + 1, step))
    except ValueError:
        return set()
    return vals

def max_gap_minutes(sch):
    """Longest legitimate gap between two fires, in minutes (0 = underivable)."""
    kind = str(sch.get("kind") or "")
    if kind == "interval":
        return float(sch.get("minutes") or 0)
    if kind == "once":
        return 0.0  # handled by the caller: a one-shot has no recurring gap
    f = str(sch.get("expr") or "").split()
    if len(f) == 6:
        f = f[:5]  # croniter form: seconds LAST
    if len(f) != 5:
        return 0.0
    mi, hr = expand(f[0], 0, 59), expand(f[1], 0, 23)
    if not mi or not hr:
        return 0.0
    times = sorted(h * 60 + m for h in hr for m in mi)
    dom_s = None if f[2] in ("*", "?") else expand(f[2], 1, 31)
    mon_s = None if f[3] in ("*", "?") else expand(f[3], 1, 12)
    dow_s = None if f[4] in ("*", "?") else expand(f[4], 0, 7)
    if (dom_s is not None and not dom_s) or (mon_s is not None and not mon_s) or (dow_s is not None and not dow_s):
        return 0.0
    if dow_s is not None and 7 in dow_s:  # cron 0 and 7 are both Sunday
        dow_s = (dow_s - {7}) | {0}
    day = datetime.date(2024, 1, 1)
    fire = []  # (ordinal from the anchor, day)
    for i in range(CORE_DAYS + BUFFER_DAYS):
        if mon_s is None or day.month in mon_s:
            wd = (day.weekday() + 1) % 7  # python Mon=0 -> cron Sun=0
            if dom_s is not None and dow_s is not None:
                ok = day.day in dom_s or wd in dow_s  # cron fires on the UNION
            elif dom_s is not None:
                ok = day.day in dom_s
            elif dow_s is not None:
                ok = wd in dow_s
            else:
                ok = True
            if ok:
                fire.append(i)
        day += datetime.timedelta(days=1)
    if len(fire) < 2:
        return 0.0
    gaps = [(b - a) * 1440 - times[-1] + times[0]
            for a, b in zip(fire, fire[1:]) if a < CORE_DAYS]
    gaps += [y - x for x, y in zip(times, times[1:])]  # a cluster's own intra-day spacing
    return float(max(gaps)) if gaps else 0.0

def stamp(v):
    d = datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    if d.utcoffset() is None:  # offset-less stamps are UTC here, never host-local
        d = d.replace(tzinfo=datetime.timezone.utc)
    return d.timestamp()

def cause_of(j, prefer):
    """First MEANINGFUL line: an exception-class line, else a 'reason'/'failed' line, else
    the first line that is not the scheduler's prompt title ('# Cron Job: …')."""
    for key in prefer:
        raw = j.get(key)
        if key == "last_fire_error" and isinstance(raw, dict):
            raw = raw.get("detail")
        lines = [re.sub(r"\s+", " ", l).strip() for l in str(raw or "").splitlines() if l.strip()]
        lines = [l for l in lines if not l.startswith("#")]
        if not lines:
            continue
        exc = [l for l in lines if EXC_RE.match(l)]
        if exc:
            return exc[-1][:160].replace(";", ",")
        if any(l.startswith("Traceback (most recent call last)") for l in lines):
            tail = [l for l in lines if l and not l.startswith(" ") and not l.startswith("Traceback")]
            if tail:
                return tail[-1][:160].replace(";", ",")
        typed = [l for l in lines if re.match(r"^[A-Za-z_][A-Za-z0-9_.]*:\s", l)]
        if typed:
            return typed[-1][:160].replace(";", ",")
        why = [l for l in lines if re.search(r"\breason\b|\bfailed\b", l, re.I)]
        if why:
            return why[-1][:160].replace(";", ",")
        return lines[0][:160].replace(";", ",")
    return "no error recorded"

def fmtm(v):
    return "%d" % int(round(v))

def age_text(sec):
    return ("=%dm" % int(sec / 60)) if sec < 3600 else ("=%dh" % int(sec / 3600))

def one(j, now, name):
    sch = j.get("schedule") or {}
    kind = str(sch.get("kind") or "")
    status = str(j.get("last_status") or "").strip().lower()
    streak = int(j.get("failure_streak") or 0)
    cause_all = ("last_error", "last_delivery_error", "last_fire_error")
    claim = None
    for ck in ("run_claim", "fire_claim"):
        cv = j.get(ck)
        if isinstance(cv, dict) and cv.get("at") not in (None, ""):
            try:
                claim = stamp(cv["at"])
            except ValueError:
                claim = None
    if kind == "once" and not j.get("last_run_at") and status not in OK_STATUS \
            and j.get("state") not in ("paused", "running") \
            and not (claim is not None and abs(now - claim) < 7200):
        # a retired one-shot that never ran (Hermes retires it without a completion stamp)
        if not sch.get("run_at"):
            return "loopdead:%s unsupported schedule (once without run_at) un-watched cause=%s" % (
                name, cause_of(j, cause_all))
        if now > stamp(sch["run_at"]) + 3600:  # an hour of grace: the fire may be in flight
            return "loopdead:%s one-shot never fired (run_at %s) cause=%s" % (
                name, sch["run_at"], cause_of(j, cause_all))
        return None
    if j.get("enabled") is False or j.get("state") in ("paused", "completed"):
        return None
    if status == "delivery_failed":
        return "loopdead:%s run ok but NOT DELIVERED cause=%s" % (
            name, cause_of(j, ("last_delivery_error", "last_error", "last_fire_error")))
    if status not in OK_STATUS and streak >= 2:
        return "loopdead:%s failing >=2 consecutive ticks cause=%s" % (name, cause_of(j, cause_all))
    cause = cause_of(j, cause_all)
    if kind == "once":
        return None
    iv = max_gap_minutes(sch)
    if iv <= 0:
        shown = sch.get("expr") if kind != "interval" else "interval=%r minutes" % (sch.get("minutes"),)
        return "loopdead:%s unsupported schedule (%r) un-watched cause=%s" % (name, shown, cause)
    if "next_run_at" in j and j["next_run_at"] in (None, "") \
            and j.get("last_run_at") not in (None, ""):
        return "loopdead:%s no next fire scheduled (state=%s) - wedged cause=%s" % (
            name, j.get("state") or "?", cause)
    if j.get("next_run_at") not in (None, ""):
        late = now - stamp(j["next_run_at"])
        if late > 3600:  # the scheduler owes a fire: exact, cadence-independent
            return "loopdead:%s overdue fire: next_run_at past by %s (max gap %sm) cause=%s" % (
                name, age_text(late), fmtm(iv), cause)
    tick = None
    for v in ((j.get("last_dispatch") or {}).get("dispatched_at") if isinstance(j.get("last_dispatch"), dict) else None,
              j.get("last_run_at")):
        if v not in (None, ""):
            s = stamp(v)  # a corrupt stamp raises -> record-invalid line
            tick = s if tick is None else max(tick, s)
    if tick is not None and now - tick > 2 * iv * 60:
        return "loopdead:%s last fire %s ago (max gap %sm) cause=%s" % (
            name, age_text(now - tick), fmtm(iv), cause)
    done = None
    if j.get("last_run_at") not in (None, ""):
        done = stamp(j["last_run_at"])
    elif j.get("created_at") not in (None, "") and tick is not None:
        done = stamp(j["created_at"])  # fires but never completes: measure from creation
    if done is not None and tick is not None and now - done > max(4 * iv * 60, 12 * 3600):
        return "loopdead:%s dispatched but no completion for %s (max gap %sm) cause=%s" % (
            name, age_text(now - done), fmtm(iv), cause)
    return None

try:
    # the record is UTF-8 BYTES: a locale-encoded text open would raise UnicodeDecodeError
    # under LC_ALL=C and collapse the whole scan (the brain jobs' P0 included)
    jobs = json.loads(open(sys.argv[1], "rb").read().decode("utf-8", "replace")).get("jobs", [])
    if isinstance(jobs, dict):
        # name-keyed maps are legal: the KEY is the name when the entry has none, and a
        # blank/whitespace-only `name` IS none (blank falls back to the key; any other name
        # is kept verbatim, exactly like the list form)
        jobs = [dict(v, name=(str(v.get("name") or "") if str(v.get("name") or "").strip() else k)) if isinstance(v, dict) else v for k, v in jobs.items()]
    now = float(sys.argv[2])
    if not jobs:
        out_line("loopdead_scan: jobs.json has no jobs - un-watched")
    for j in jobs:
        if not isinstance(j, dict):
            out_line("loopdead_scan: non-object job entry %s" % repr(j).replace(";", ",")[:120])
            continue
        # a whitespace-only name IS no name (the un-watched guard keys on emptiness); any
        # other name is kept VERBATIM — the SELF/BRAIN identity checks compare exact names,
        # so stripping would silently re-classify `tandem-triage ` as the brain job
        raw_name = str(j.get("name") or "")
        name = raw_name if raw_name.strip() else ""
        if name == SELF:
            continue
        if not name:
            if j.get("enabled") is not False and j.get("state") not in ("paused", "completed"):
                out_line("loopdead_scan: unnamed enabled job (%s) - un-watched" % repr(j.get("schedule")).replace(";", ",")[:120])
            continue
        try:
            line = one(j, now, display(name))
        except Exception as e:
            line = "loopdead:%s record invalid (%s: %s)" % (
                display(name), type(e).__name__, str(e).replace("\n", " ")[:120])
        if line:
            line = line.replace(";", ",")  # the join separator must never appear in a line
            # the escalation prefix is chosen by the job's IDENTITY, never spelled by its
            # rendered name (the display token cannot carry ':' or '!', so a non-brain name
            # can never produce 'loopdead:P0!:')
            line = ("loopdead:P0!:" if name in BRAIN else "loopdead:") + line[len("loopdead:"):]
            # LINE INTEGRITY (#493): out_line sweeps every record-shaped field (name, state,
            # a schedule expression, a cause) of control characters, so the line count is a
            # property of the record's job count, never of its content.
            out_line(line)
except Exception as e:
    msg = ("%s: %s" % (type(e).__name__, e)).replace("\n", " ")[:160]
    out_line("loopdead_scan: unreadable jobs.json (%s)" % msg)
PY
}
# LEVEL: P0 for the probe's explicit P0 classes and the pre-existing infra phrases other
# arms emit; a cause string like `P0001` or a word like `P0RT` must never escalate it.
# runtime_stale is one of those classes: the gateway is running pre-update modules and
# every LLM cron is dead/dying.
# The brain prefix (loopdead:P0!:tandem-triage / :tandem-critic) is a LINE PREFIX: it only
# escalates at line start or immediately after the ';' join separator, with the job name
# terminated by a space — a look-alike name with a suffix (tandem-triage-2), record text or
# an error cause embedding the token stays P1 (#490; every emitted line is ';'-sanitised,
# so a separator can only be the join).
# SEGMENT LAW (#493): the level of a line is P0 when ANY ';'-joined segment is P0, and a
# segment that starts 'loopdead:' or 'loopdead_scan:' is classified by its own identity
# token ONLY — its payload (a job name, a cause, record text) never matches a loose P0
# phrase, so `loopdead:j cause=db unreachable` is P1 while a genuine `db: unreachable`
# segment in the same join still pages. (The caller keeps its own override: three or more
# anomaly lines are P0 whatever their individual level.)
probe_level() {
  local rest="$1" seg lvl=1
  while [ -n "$rest" ]; do
    seg="${rest%%;*}"
    if [ "$seg" = "$rest" ]; then rest=""; else rest="${rest#*;}"; fi
    case "$seg" in
      'loopdead:P0!:tandem-triage '*|'loopdead:P0!:tandem-critic '*) lvl=0; break ;;
      'loopdead:'*|'loopdead_scan:'*) continue ;;
      'runtime_stale: the gateway (pid'*|*unreachable*|*public=*|*version_rpc*|*container_inspect*) lvl=0; break ;;
    esac
  done
  echo "$lvl"
}
# DEDUPE KEY: blank the ticking parts of a line so a standing fault alerts once instead
# of every 10-min tick. The letters-only display discriminator (#493) survives every mask
# here by construction (a hex/numeric suffix would be normalised away).
dedupe_key() {
  printf '%s' "$1" | sed -E 's/=[0-9]+[mh]([^a-z0-9]|$)/=<age>\1/g; s/=[0-9]+s([^a-z0-9]|$)/=<age>s\1/g; s/ [0-9]+s([^a-z0-9]|$)/ <age>s\1/g; s/request_id=[^ ;]*/request_id=<id>/g; s/trace(_id)?=[^ ;]*/trace=<id>/g; s/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/<id>/g; s/\b[0-9a-fA-F]{16,}\b/<id>/g; s/\b[0-9]{6,}\b/<n>/g; s/(attempt|retry|tries|count)=[0-9]+/\1=<n>/g'
}

# RUNTIME-REFRESH (#487, 2026-11-17): the gateway ADVERTISES the code it booted
# (`code_sha`, `pid`, `start_time` in gateway_state.json). An install that lands under a
# LIVE gateway — the 2026-11-15 incident: files written 17:55:20Z, two minutes AFTER the
# 17:53:50Z gateway start — leaves the process holding its OLD modules while every LAZY
# import reads the NEW files, so the first lazily-imported module whose shape changed
# raises ImportError: `tui_gateway` imported `release_process_group_once_empty` at
# WebSocket-upgrade time, uvicorn answered the cron worker's /api/ws upgrade with HTTP 500,
# and every LLM cron died (`tandem-triage` 30 runs, `tandem-critic` 3, the dockhand report
# 1 — 29h, 18:00:15Z to the 23:02:15Z unit start) recording only `InvalidStatus: server
# rejected WebSocket connection`. The dead-man (loop-liveness) catches that only AFTER two
# failed ticks and cannot catch a break confined to one lazily-imported path. This arm
# reads the STATE the gateway itself publishes and compares the booted `code_sha` with the
# install's own code identity — `install-stamp.json`'s `commit` (the same source the
# gateway reads) or, with no valid stamp, the checkout's HEAD. ANY live record whose sha
# disagrees is the finding: a fresh sibling record never masks a stale one. A record
# counts as serving only when its `gateway_state` is `running` OR `degraded` (degraded is
# a serving gateway with a parked platform) AND its pid is alive at the SAME `start_time`
# stamp — a recycled pid, or a record carrying no stamp, is never trusted (a skipped
# record is a false negative the arm prefers to a misattributed P0). Candidates are tried
# in order (the profile's own state file, then the multiplexed root one), so a standalone
# and a multiplexed gateway are both read and a stale `stopped` document is skipped
# instead of blinding or alarming the arm. DECLARED BOUNDARIES (silent, never a false
# alarm): no readable state file, no live record that is both stamped and sha-bearing, a
# non-git install with no usable stamp, a dirty worktree at the same commit (the arm
# compares commits, not file bytes), and the DASHBOARD unit (a separate process, out of
# scope). The emitted line names the finding and points at SPEC's RUNTIME-REFRESH
# paragraph instead of embedding a runnable operator command — a literal operator command
# inside an executable trips the runtime's own self-guard and would block every operator
# run of this probe.
runtime_stale() {  # $1 = ':'-separated state candidates, $2 = install dir, $3 = proc root
  python3 - "${1:-}" "${2:-}" "${3:-}" <<'PY'
import json, os, subprocess, sys
cands, inst, proc = sys.argv[1], sys.argv[2], (sys.argv[3] or "/proc")
def silent():
    sys.exit(0)
if not cands or not inst:
    silent()
UPDATE_MECHANISMS = ("self", "app-installer", "electron-updater", "external", "microsoft-store")
def norm_sha(v):
    # the platform accepts any non-empty commit that is not the all-zero placeholder — it
    # imposes no length rule, and neither does this arm (a short stamp must not blind it)
    v = str(v or "").strip().lower()
    return v if v and set(v) != {"0"} else ""
def alive(pid, stamp):
    # field 22 of /proc/<pid>/stat is the start (jiffies since boot); the record's own stamp
    # must match, so a recycled pid never attributes a stale record to a live process
    try:
        with open(os.path.join(proc, str(pid), "stat")) as f:
            return int(stamp) == int(f.read().rsplit(")", 1)[1].split()[19])
    except Exception:
        return False
def git_head():
    try:
        return norm_sha(subprocess.run(["git", "-C", inst, "rev-parse", "--verify", "--quiet", "HEAD"],
                                      capture_output=True, text=True, timeout=20).stdout)
    except Exception:
        return ""
def installed_sha():
    # mirror the PLATFORM's own stamp gate (hermes_cli/version_info.py): a stamp must carry a
    # commit, a known updateMechanism and a non-light payload; a git-source stamp whose
    # checkout HEAD diverges is REJECTED (so a hot pull or a rollback resolves to HEAD);
    # otherwise the stamp IS the identity, and HEAD is the fallback when it is unusable.
    try:
        st = json.load(open(os.path.join(inst, "install-stamp.json")))
        if isinstance(st, dict) and "commit" in st:
            sha = norm_sha(st.get("commit"))
            if sha and st.get("updateMechanism") in UPDATE_MECHANISMS and st.get("payload") != "light":
                if str(st.get("source") or "") == "git" and os.path.exists(os.path.join(inst, ".git")):
                    head = git_head()
                    if head and head != sha:
                        return head
                return sha
    except Exception:
        pass
    return git_head()
installed = installed_sha()
if not installed:
    silent()  # no code identity to compare against: declared boundary
stale = None
for sf in [c for c in cands.split(":") if c]:
    try:
        st = json.load(open(sf))
    except Exception:
        continue
    if not isinstance(st, dict):
        continue  # valid JSON of the wrong shape is a skipped record, never a crash
    if str(st.get("gateway_state") or "") not in ("running", "degraded"):
        continue
    raw = st.get("pid")
    if isinstance(raw, bool):
        continue
    try:
        pid = int(raw)
    except Exception:
        continue
    if str(raw).strip() != str(pid) or pid < 2:
        continue
    if not alive(pid, st.get("start_time")):
        continue
    booted = norm_sha(st.get("code_sha"))
    if not booted:
        continue
    if booted != installed:
        stale = (pid, booted)
        break  # ANY live record that disagrees is the finding: a fresh sibling never masks it
if not stale:
    silent()
pid, booted = stale
print("runtime_stale: the gateway (pid %d) booted code %s but the install is %s - "
      "the unit is serving stale code (mixed modules can fail lazy imports, LLM crons "
      "may be dead or dying). See SPEC RUNTIME-REFRESH" % (pid, booted[:9], installed[:9]))
PY
}
if [ "${1:-}" = "--runtime-stale" ]; then
  # the arm's unit test drives THESE bytes with fixtures — no network, no state writes
  [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "usage: --runtime-stale <state1[:state2]> <install_dir> [proc_root]" >&2; exit 2; }
  runtime_stale "$2" "${3:-}" "${4:-}"
  exit 0
fi
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
  # RE-KEYED-HOME arm (#435) — same slice discipline as the orphan arm: the wedge and the
  # wait-state arms share pieces of the current-round clause, and the MIN subquery's text
  # (`r.status in (...)` + the round binding) is echoed by other arms' verdict scopes, so
  # every pin greps the arm's OWN bytes only — a whole-SQL substring pin stayed green
  # with arms deleted before (the #445 ready arm's shared `PENDING` text is the textbook).
  REKEY_ON=$(strand_rekey_arm 2.78.19 2)
  [ "$(printf '%s' "$REKEY_ON" | grep -oF "select 'rekeyhome'" | wc -l)" = "1" ] || { echo "selfcheck fail: rekey arm"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "s.category = 'paused'" || { echo "selfcheck fail: rekey paused scope"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "(t.pre_block_status is not null and exists (select 1 from task_statuses o where o.id = t.pre_block_status and o.category in ('done', 'cancelled'))) and" || { echo "selfcheck fail: rekey resolve clause (pre column)"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "(t.park_from_status is not null and exists (select 1 from task_statuses o where o.id = t.park_from_status and o.category in ('done', 'cancelled'))) and" || { echo "selfcheck fail: rekey resolve clause (park column)"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "not exists (select 1 from task_statuses o where o.category = 'in_review' and (o.id = t.pre_block_status or o.id = t.park_from_status))" || { echo "selfcheck fail: rekey in-review-resolver exclusion"; exit 1; }
  # one stamp term per origin branch (block + park) at/below the floor
  [ "$(printf '%s' "$REKEY_ON" | grep -oF ") > t.updated_at" | wc -l)" = "2" ] || { echo "selfcheck fail: rekey write discriminator"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "min(coalesce(r.decided_at, r.created_at))" || { echo "selfcheck fail: rekey ordering is not the MIN test"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)) > t.updated_at" || { echo "selfcheck fail: rekey MIN subquery lost its round binding"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "max(coalesce(r.decided_at" && { echo "selfcheck fail: rekey ordering fell back to max"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')" || { echo "selfcheck fail: rekey verdict scope"; exit 1; }
  printf '%s' "$REKEY_ON" | grep -qF "r.status = 'PENDING' and r.round = (select max(r3.round)" || { echo "selfcheck fail: rekey live-round clause"; exit 1; }
  # the rekey arm rides the same gates as the orphan arm: present at the pre-guard
  # version, VANISHING at the one-column gate, and never leaking into the orphan slice
  [ "$(printf '%s' "$(strand_sql 2.78.19 2)" | grep -oF "select 'rekeyhome'" | wc -l)" = "1" ] || { echo "selfcheck fail: rekey arm missing at the pre-guard version"; exit 1; }
  printf '%s' "$(strand_sql 2.78.19 1)" | grep -qF "rekeyhome" && { echo "selfcheck fail: rekey arm emitted without the park column"; exit 1; }
  printf '%s' "$(strand_orphan_arm 2.78.19 2)" | grep -qF "rekeyhome" && { echo "selfcheck fail: rekey arm leaked into the orphan slice"; exit 1; }
  printf '%s' "$(strand_rekey_arm 2.78.19 2)" | grep -qF "orphanhome" && { echo "selfcheck fail: orphan arm leaked into the rekey slice"; exit 1; }
  printf '%s' "$(strand_sql 2.78.20 2)" | grep -qF "orphanhome" || { echo "selfcheck fail: orphan arm missing at the current gate pair"; exit 1; }
  # BLOCK/PARK FLOW-RECORD floor (#466): the paused-row ordering is version-gated — the
  # retired stamp below 2.78.38, the newest gating flow record (with the stamp as the
  # record-less pre-floor fallback) at and above it. The pre-floor pins above stay green by
  # construction; these pin the floored half and the helpers' own gates.
  flow_floor_met 2.78.37 && { echo "selfcheck fail: flow floor met below 2.78.38"; exit 1; }
  flow_floor_met 2.78.38 || { echo "selfcheck fail: flow floor off at 2.78.38"; exit 1; }
  flow_floor_met 2.78.100 || { echo "selfcheck fail: flow floor off at a higher patch"; exit 1; }
  flow_floor_met 3.0.0 || { echo "selfcheck fail: flow floor off at the next major"; exit 1; }
  flow_floor_met '' && { echo "selfcheck fail: flow floor met on an empty version"; exit 1; }
  flow_floor_met guard-error && { echo "selfcheck fail: flow floor met on a non-semver"; exit 1; }
  flow_floor_met 2.78.38-rc1 && { echo "selfcheck fail: flow floor met on a pre-release"; exit 1; }
  paused_order bogus 2.78.38 && { echo "selfcheck fail: ordering accepted a non-max/min aggregate"; exit 1; }
  printf '%s' "$(paused_order max 2.78.37)" | grep -qF "task_messages" && { echo "selfcheck fail: pre-floor orphan ordering reads a record"; exit 1; }
  [ "$(printf '%s' "$(paused_order max 2.78.37)" | grep -oF ") > t.updated_at" | wc -l)" = "1" ] || { echo "selfcheck fail: pre-floor orphan ordering lost the stamp"; exit 1; }
  printf '%s' "$(paused_order max 2.78.38)" | grep -qF "coalesce((select max(m.created_at) from task_messages m where m.task_id = t.id" || { echo "selfcheck fail: floored orphan ordering lost the flow record"; exit 1; }
  printf '%s' "$(paused_order max 2.78.38)" | grep -qF ", t.updated_at)" || { echo "selfcheck fail: floored orphan ordering lost the pre-floor fallback"; exit 1; }
  printf '%s' "$(paused_order max 2.78.38)" | grep -qF "max(coalesce(r.decided_at, r.created_at))" || { echo "selfcheck fail: floored orphan ordering lost the MAX test"; exit 1; }
  printf '%s' "$(paused_order min 2.78.38)" | grep -qF "min(coalesce(r.decided_at, r.created_at))" || { echo "selfcheck fail: floored rekey ordering lost the MIN test"; exit 1; }
  printf '%s' "$(flow_record_ts)" | grep -qF "m.body like 'auto-blocked:%'" || { echo "selfcheck fail: flow record lost the block prefix"; exit 1; }
  printf '%s' "$(flow_record_ts)" | grep -qF "m.body like 'review parked %'" || { echo "selfcheck fail: flow record lost the park prefix"; exit 1; }
  printf '%s' "$(flow_record_ts)" | grep -qF "a.payload->>'kind' = 'STATUS'" || { echo "selfcheck fail: flow record lost the kind pin"; exit 1; }
  ORPHAN_FLOW=$(strand_orphan_arm 2.78.38 2)
  printf '%s' "$ORPHAN_FLOW" | grep -qF "auto-blocked:%" || { echo "selfcheck fail: floored orphan arm lost the flow record"; exit 1; }
  printf '%s' "$ORPHAN_FLOW" | grep -qF ") > t.updated_at" && { echo "selfcheck fail: floored orphan arm still orders by the stamp"; exit 1; }
  REKEY_FLOW=$(strand_rekey_arm 2.78.38 2)
  printf '%s' "$REKEY_FLOW" | grep -qF "case when (select max(m.created_at)" || { echo "selfcheck fail: floored rekey arm lost the record-present branch"; exit 1; }
  printf '%s' "$REKEY_FLOW" | grep -qF "exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id) and coalesce(r.decided_at, r.created_at) > (select max(m.created_at)" || { echo "selfcheck fail: floored rekey arm lost the per-verdict record term"; exit 1; }
  printf '%s' "$REKEY_FLOW" | grep -qF "min(coalesce(r.decided_at, r.created_at))" || { echo "selfcheck fail: floored rekey arm lost the record-less MIN fallback"; exit 1; }
  printf '%s' "$REKEY_FLOW" | grep -qF "m.body like 'auto-blocked:%'" || { echo "selfcheck fail: floored rekey arm lost the block origin's own record"; exit 1; }
  printf '%s' "$REKEY_FLOW" | grep -qF "m.body like 'review parked %'" || { echo "selfcheck fail: floored rekey arm lost the park origin's own record"; exit 1; }
  printf '%s' "$REKEY_FLOW" | grep -qF "or ((t.park_from_status is not null and exists" || { echo "selfcheck fail: floored rekey arm lost the per-origin branch"; exit 1; }
  printf '%s' "$REKEY_FLOW" | grep -qF " or m.body like" && { echo "selfcheck fail: rekey arm borrows the task-wide flow record"; exit 1; }
  printf '%s' "$(paused_order_any 2.78.37)" | grep -qF "task_messages" && { echo "selfcheck fail: pre-floor per-verdict ordering reads a record"; exit 1; }
  printf '%s' "$(paused_order_any 2.78.37)" | grep -qF "exists (select 1 from task_reviews" && { echo "selfcheck fail: pre-floor per-verdict ordering lost the MIN test"; exit 1; }
  printf '%s' "$(paused_order_any 2.78.38 '(select 1)')" | grep -qF "exists (select 1 from task_reviews" || { echo "selfcheck fail: floored per-verdict ordering lost the verdict term"; exit 1; }
  paused_order_any 2.78.38 && { echo "selfcheck fail: floored per-verdict ordering accepted a missing record"; exit 1; }
  printf '%s' "$(strand_rekey_arm 2.78.37 2)" | grep -qF "task_messages" && { echo "selfcheck fail: pre-floor rekey arm reads a record"; exit 1; }
  printf '%s' "$(strand_orphan_arm 2.78.37 2)" | grep -qF "auto-blocked:%" && { echo "selfcheck fail: pre-floor orphan arm reads a record"; exit 1; }
  # HOME-CATEGORY RECORD term (#491): floor matrix, the term's own bytes, and its scope —
  # below the floor the arm must stay byte-identical to the ordering-only shape (the field
  # does not exist on pre-floor notes), and the term rides the BLOCK half only (the park
  # origin carries no category record: declared boundary).
  home_floor_met 2.78.40 && { echo "selfcheck fail: home floor met below 2.78.41"; exit 1; }
  home_floor_met 2.78.41 || { echo "selfcheck fail: home floor off at 2.78.41"; exit 1; }
  home_floor_met 2.78.100 || { echo "selfcheck fail: home floor off above the floor"; exit 1; }
  home_floor_met 3.0.0 || { echo "selfcheck fail: home floor off at the next major"; exit 1; }
  home_floor_met '' && { echo "selfcheck fail: home floor met on an empty version"; exit 1; }
  home_floor_met guard-error && { echo "selfcheck fail: home floor met on a non-semver"; exit 1; }
  home_floor_met 2.78.41-rc1 && { echo "selfcheck fail: home floor met on a pre-release"; exit 1; }
  home_category_term 2.78.40 && { echo "selfcheck fail: home-category term emitted below its floor"; exit 1; }
  printf '%s' "$(home_category_term 2.78.41)" | grep -qF "homeCategory" || { echo "selfcheck fail: home-category term lost the record read"; exit 1; }
  printf '%s' "$(home_category_term 2.78.41)" | grep -qF "not exists (select 1 from task_statuses oc where oc.id = t.pre_block_status and oc.category = ah.payload->>'homeCategory')" || { echo "selfcheck fail: home-category term lost the recorded-vs-current category test"; exit 1; }
  printf '%s' "$(home_category_term 2.78.41)" | grep -qF "coalesce(r.decided_at, r.created_at)" && { echo "selfcheck fail: home-category term carries a dead ordering conjunct"; exit 1; }
  printf '%s' "$(home_category_term 2.78.41)" | grep -qF "ah.payload->>'homeCategory' <> ''" || { echo "selfcheck fail: home-category term lost the empty-record guard"; exit 1; }
  printf '%s' "$(strand_rekey_arm 2.78.40 2)" | grep -qF "homeCategory" && { echo "selfcheck fail: rekey arm reads homeCategory below its floor"; exit 1; }
  printf '%s' "$(strand_rekey_arm 2.78.41 2)" | grep -qF "homeCategory" || { echo "selfcheck fail: rekey arm lost the home-category term"; exit 1; }
  [ "$(printf '%s' "$(strand_rekey_arm 2.78.41 2)" | grep -oF "homeCategory" | wc -l)" = "6" ] || { echo "selfcheck fail: home-category term not scoped to the block half"; exit 1; }
  # NON-TERMINAL half (#496): the same floor, the block half only, and the ALL-OLDER gate
  # that keeps the legal hold-landing class silent (its closing verdict POSTDATES the
  # record, so the ordering term must not be reused on that half — it would fire there).
  rekey_nonterminal_half 2.78.40 && { echo "selfcheck fail: non-terminal half emitted below the home floor"; exit 1; }
  printf '%s' "$(rekey_nonterminal_half 2.78.41)" | grep -qF "o.category not in ('done', 'cancelled', 'in_review')" || { echo "selfcheck fail: non-terminal half lost its resolve clause"; exit 1; }
  printf '%s' "$(rekey_nonterminal_half 2.78.41)" | grep -qF "homeCategory" || { echo "selfcheck fail: non-terminal half lost the category record"; exit 1; }
  printf '%s' "$(rekey_nonterminal_half 2.78.41)" | grep -qF "not exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id) and coalesce(r.decided_at, r.created_at) > (select max(m.created_at)" || { echo "selfcheck fail: non-terminal half lost the all-older gate"; exit 1; }
  printf '%s' "$(strand_rekey_arm 2.78.40 2)" | grep -qF "o.category not in ('done', 'cancelled', 'in_review')" && { echo "selfcheck fail: non-terminal half on a pre-floor arm"; exit 1; }
  [ "$(printf '%s' "$(strand_rekey_arm 2.78.41 2)" | grep -oF "o.category not in ('done', 'cancelled', 'in_review')" | wc -l)" = "1" ] || { echo "selfcheck fail: non-terminal half not emitted exactly once"; exit 1; }
  [ "$(printf '%s' "$(strand_rekey_arm 2.78.41 2)" | grep -oF "not exists (select 1 from task_reviews r where r.task_id = t.id and r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED') and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id) and coalesce(r.decided_at, r.created_at) > (select max(m.created_at)" | wc -l)" = "1" ] || { echo "selfcheck fail: all-older gate not emitted exactly once"; exit 1; }
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
  # WIRING pin for the REKEY-HOME arm (#435 r1 review, the same class as the egress one):
  # the emit mode and the live pass are two places; without this, deleting the pass's arm
  # block keeps every SQL assertion green and ships a detector that never runs.
  REKPASS=$(grep -cE '^[[:space:]]*REKEYHOME=\$\(echo "\$STROUT"' "$0" 2>/dev/null || true)
  [ "$REKPASS" = "1" ] || { echo "selfcheck fail: rekey pass emit missing ($REKPASS)"; exit 1; }
  REKALERT=$(grep -cE '^[[:space:]]*anom\+=\("rekey_home:' "$0" 2>/dev/null || true)
  [ "$REKALERT" = "1" ] || { echo "selfcheck fail: rekey alert line missing ($REKALERT)"; exit 1; }
  REKPREV=$(grep -cE '^[[:space:]]*printf .*rekeyhome\.prev' "$0" 2>/dev/null || true)
  [ "$REKPREV" = "1" ] || { echo "selfcheck fail: rekey prev-write missing ($REKPREV)"; exit 1; }
  # WIRING pin for the FINAL-PARK arm (#431, the #435 r1 class): the arm must EMIT under
  # its gates, carry every discriminating term, and be CONSUMED by the live pass (emit,
  # alert, prev-write — exactly once each); without the consumer pins, deleting the pass's
  # arm block keeps every SQL assertion green and ships a detector that never runs.
  PCA_ON=$(strand_parkclosed_arm 2.78.38 2)
  [ -n "$PCA_ON" ] || { echo "selfcheck fail: parkclosed arm missing"; exit 1; }
  [ "$(printf '%s' "$PCA_ON" | grep -oF "select 'parkclosed'" | wc -l)" = "1" ] || { echo "selfcheck fail: parkclosed emission"; exit 1; }
  for term in "s.category = 'paused'" "t.park_from_status is not null" "t.park_rearm_after is null" "t.park_rearm_attempts = 0" "o.category = 'in_review'" "r.status = 'PENDING' and r.reviewer_id is not null and r.round = (select max(r3.round) from task_reviews r3 where r3.task_id = t.id)" "r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')" "max(coalesce(r.decided_at, r.created_at))" "m.body like 'review parked %'" "a.payload->>'kind' = 'STATUS'" ") > coalesce((select max(m.created_at)" "e.round = (select max(r4.round) from task_reviews r4 where r4.task_id = t.id) and e.status = 'ESCALATED' and e.referral_target_id is not null" "x.round = e.round and x.reviewer_id = e.referral_target_id"; do
    printf '%s' "$PCA_ON" | grep -qF "$term" || { echo "selfcheck fail: parkclosed term ($term)"; exit 1; }
  done
  # the arm orders against the PARK's own note only: the task-wide helper's block body must
  # never ride this slice (a stale auto-blocked note would order against the wrong flow)
  printf '%s' "$PCA_ON" | grep -qF "auto-blocked:" && { echo "selfcheck fail: parkclosed borrows the task-wide record"; exit 1; }
  # the REKEY slice must stop at the park arm: a cut regression would let its pins read
  # foreign clauses (single-copy slices are only as good as their tail cut)
  printf '%s' "$(strand_rekey_arm 2.78.38 2)" | grep -qF "parkclosed" && { echo "selfcheck fail: rekey slice carries the park arm"; exit 1; }
  [ -z "$(strand_parkclosed_arm 2.78.36 2)" ] || { echo "selfcheck fail: parkclosed column floor"; exit 1; }
  [ -n "$(strand_parkclosed_arm 2.78.37 2)" ] || { echo "selfcheck fail: parkclosed column floor release"; exit 1; }
  # ordering floor (2.78.38): the record above it, the retired stamp at the arm's own floor
  printf '%s' "$(strand_parkclosed_arm 2.78.37 2)" | grep -qF ") > t.updated_at" || { echo "selfcheck fail: parkclosed floor stamp ordering"; exit 1; }
  printf '%s' "$(strand_parkclosed_arm 2.78.38 2)" | grep -qF ") > coalesce((select max(m.created_at)" || { echo "selfcheck fail: parkclosed record ordering"; exit 1; }
  printf '%s' "$(strand_parkclosed_arm 2.78.38 2)" | grep -qF ") > t.updated_at" && { echo "selfcheck fail: parkclosed record floor lost the record"; exit 1; }
  [ -z "$(strand_parkclosed_arm 2.78.38 1)" ] || { echo "selfcheck fail: parkclosed column gate"; exit 1; }
  [ -z "$(strand_parkclosed_arm '' 2)" ] || { echo "selfcheck fail: parkclosed empty version"; exit 1; }
  PCPASS=$(grep -cE '^[[:space:]]*PARKCLOSED=\$\(echo "\$STROUT"' "$0" 2>/dev/null || true)
  [ "$PCPASS" = "1" ] || { echo "selfcheck fail: parkclosed pass emit missing ($PCPASS)"; exit 1; }
  PCALERT=$(grep -cE '^[[:space:]]*anom\+=\("park_lost_flip:' "$0" 2>/dev/null || true)
  [ "$PCALERT" = "1" ] || { echo "selfcheck fail: parkclosed alert line missing ($PCALERT)"; exit 1; }
  PCPREV=$(grep -cE '^[[:space:]]*printf .*parkclosed\.prev' "$0" 2>/dev/null || true)
  [ "$PCPREV" = "1" ] || { echo "selfcheck fail: parkclosed prev-write missing ($PCPREV)"; exit 1; }
  [ "$(to_epoch_s 1793957516932)" = "1793957516" ] || { echo "selfcheck fail: epoch ms"; exit 1; }
  [ "$(to_epoch_s 1793957516)" = "1793957516" ] || { echo "selfcheck fail: epoch s"; exit 1; }
  printf 'img unhealthy\n' | grep -qw healthy && { echo "selfcheck fail: unhealthy matched healthy"; exit 1; }
  printf 'img healthy\n' | grep -qw healthy || { echo "selfcheck fail: healthy missed"; exit 1; }
  # LOOP-LIVENESS (#485): the shipped function driven by fixtures — every term, every
  # silence, the cause selection, the gap enumeration and the escalation prefix are
  # pinned; a flipped threshold, a lost self-exclusion, a mean-cadence/union regression,
  # a 12h-floor regression or a dropped cause goes red here.
  LLT=$(mktemp -d)
  cat > "$LLT/jobs.json" <<'FIX'
{"jobs": [{"name": "tandem-prod-watch","enabled": true,"schedule": {"kind": "interval","minutes": 10},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T22:00:00+00:00"},{"name": "tandem-triage","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-17T00:00:00+00:00","last_dispatch": {"dispatched_at": "2026-11-17T02:00:00+00:00"}},{"name": "tandem-critic","enabled": true,"schedule": {"kind": "cron","expr": "0 11,23 * * *"},"last_status": "error","failure_streak": 3,"last_run_at": "2026-11-16T23:00:00+00:00","last_error": "InvalidStatus: server rejected WebSocket connection: HTTP 500"},{"name": "nightly-report","enabled": true,"schedule": {"kind": "cron","expr": "0 2 * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T02:00:00+00:00"},{"name": "paused-job","enabled": false,"schedule": {"kind": "interval","minutes": 10},"last_status": "error","failure_streak": 9,"last_run_at": "2026-11-01T00:00:00+00:00"},{"name": "streak2-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "failed","failure_streak": 2,"last_run_at": "2026-11-17T01:30:00+00:00","last_error": "boom"},{"name": "single-failure-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "error","failure_streak": 1,"last_run_at": "2026-11-17T01:45:00+00:00","last_error": "blip"},{"name": "undelivered-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "delivery_failed","failure_streak": 0,"last_run_at": "2026-11-17T01:30:00+00:00","last_error": "run completed","last_delivery_error": "discord: channel not found"},{"name": "queued-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "delivery_queued","failure_streak": 0,"last_run_at": "2026-11-17T01:45:00+00:00"},{"name": "queued-streak-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "delivery_queued","failure_streak": 2,"last_run_at": "2026-11-17T01:45:00+00:00"},{"name": "cancelled-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "cancelled","failure_streak": 5,"last_run_at": "2026-11-17T01:45:00+00:00"},{"name": "never-run-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": null,"failure_streak": 0,"last_run_at": null},{"name": "inflight-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T23:00:00+00:00","last_dispatch": {"dispatched_at": "2026-11-17T01:59:00+00:00"}},{"name": "no-completion-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T20:00:00+00:00","last_dispatch": {"dispatched_at": "2026-11-17T01:59:00+00:00"}},{"name": "stale-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T23:00:00+00:00","last_error": "last successful run"},{"name": "interval-job","enabled": true,"schedule": {"kind": "interval","minutes": 10},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-17T01:35:00+00:00"},{"name": "title-cause-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T23:00:00+00:00","last_error": "# Cron Job: hourly triage\nTraceback (most recent call last):\nRuntimeError: boom"},{"name": "fire-error-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T23:00:00+00:00","last_dispatch": {"dispatched_at": "2026-11-16T23:00:00+00:00"},"last_fire_error": {"detail": "dispatch handoff missed the fire window"}},{"name": "monthly-drill","enabled": true,"schedule": {"kind": "cron","expr": "0 3 1 * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-01T03:05:00+00:00"},{"name": "quarterly-job","enabled": true,"schedule": {"kind": "cron","expr": "0 3 1 */3 *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-10-01T03:05:00+00:00"},{"name": "annual-job","enabled": true,"schedule": {"kind": "cron","expr": "0 9 * 2 *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-02-28T09:00:00+00:00"},{"name": "named-month-job","enabled": true,"schedule": {"kind": "cron","expr": "0 9 1 JAN *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-01-01T09:05:00+00:00"},{"name": "weekday-job","enabled": true,"schedule": {"kind": "cron","expr": "0 4 * * 1-5"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-13T04:05:00+00:00"},{"name": "six-field-job","enabled": true,"schedule": {"kind": "cron","expr": "0 9 * * 1-5 0"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-10T09:00:00+00:00"},{"name": "union-job","enabled": true,"schedule": {"kind": "cron","expr": "0 9 1 * 1"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-10-25T09:00:00+00:00"},{"name": "once-job","enabled": true,"schedule": {"kind": "once","run_at": "2026-11-17T00:00:00+00:00"},"last_status": null,"failure_streak": 0,"last_run_at": null,"state": "completed"},{"name": "once-recent-job","enabled": true,"schedule": {"kind": "once","run_at": "2026-11-17T01:45:00+00:00"},"last_status": null,"failure_streak": 0,"last_run_at": null,"state": "scheduled"},{"name": "once-norunat-job","enabled": true,"schedule": {"kind": "once"},"last_status": null,"failure_streak": 0,"last_run_at": null},{"name": "unsupported-job","enabled": true,"schedule": {"kind": "cron","expr": "0 0 * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-17T01:00:00+00:00"},{"name": "paused-state-job","enabled": true,"state": "paused","schedule": {"kind": "interval","minutes": 10},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-01T00:00:00+00:00"},{"name": "bad-record-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "not-a-time"},{"name": "once-fired-job","enabled": true,"state": "completed","schedule": {"kind": "once","run_at": "2026-11-17T00:00:00+00:00"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-17T00:00:31+00:00"},{"name": "leap-job","enabled": true,"schedule": {"kind": "cron","expr": "0 0 29 2 *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2013-02-28T09:00:00+00:00"},{"name": "sunday7-job","enabled": true,"schedule": {"kind": "cron","expr": "0 9 * * 7"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-10-28T09:00:00+00:00"},{"name": "overdue-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-17T01:45:00+00:00","next_run_at": "2026-11-17T00:00:00+00:00"},{"name": "hung-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T13:00:00+00:00","last_dispatch": {"dispatched_at": "2026-11-17T01:59:00+00:00"}},{"name": "midnight-job","enabled": true,"schedule": {"kind": "cron","expr": "0 0,23 * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-14T23:00:00+00:00"},{"name": "ws-cause-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T23:00:00+00:00","last_error": "Traceback (most recent call last):\n  File \"/app/run.py\", line 7, in <module>\n    raise_for_status()\nwebsockets.exceptions.InvalidStatus: server rejected WebSocket connection: HTTP 500"},{"name": "never-completed-job","enabled": true,"created_at": "2026-11-15T00:00:00+00:00","schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "running","failure_streak": 0,"last_run_at": null,"last_dispatch": {"dispatched_at": "2026-11-17T01:59:00+00:00"}},{"name": "once-retired-job","enabled": false,"state": "completed","schedule": {"kind": "once","run_at": "2026-11-17T00:00:00+00:00"},"last_status": null,"failure_streak": 0,"last_run_at": null},{"name": "semicolon-cause-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T23:00:00+00:00","last_error": "boom; loopdead:P0!:forged"},{"name": "wedged-job","enabled": true,"state": "error","schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T20:00:00+00:00","next_run_at": null},{"name": "once-inflight-job","enabled": true,"schedule": {"kind": "once","run_at": "2026-11-17T00:00:00+00:00"},"last_status": null,"failure_streak": 0,"last_run_at": null,"run_claim": {"at": "2026-11-17T01:40:00+00:00"}},{"name": "P0!:fake","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-16T23:00:00+00:00","last_error": "look alike name"},{"name": "bad-semicolon-job","enabled": true,"schedule": {"kind": "cron","expr": "0 * * * *"},"last_status": "ok","failure_streak": 0,"last_run_at": "x;y"},{"name": " ","enabled": true,"schedule": {"kind": "interval","minutes": 10},"last_status": "ok","failure_streak": 0,"last_run_at": "2026-11-17T01:55:00+00:00"}]}
FIX
  LLN=$(date -u -d '2026-11-17T02:00:00Z' +%s)
  LLR=$(loop_liveness "$LLT/jobs.json" "$LLN")
  # (a) running-but-failing at EXACTLY streak 2, cause carried; a BRAIN line carries the
  # unforgeable 'loopdead:P0!:' prefix (never a bare suffix token)
  printf '%s\n' "$LLR" | grep -qxF 'loopdead:P0!:tandem-critic failing >=2 consecutive ticks cause=InvalidStatus: server rejected WebSocket connection: HTTP 500' || { echo "selfcheck fail: critic streak gate"; exit 1; }
  printf '%s\n' "$LLR" | grep -qxF 'loopdead:streak2-job failing >=2 consecutive ticks cause=boom' || { echo "selfcheck fail: streak=2 boundary"; exit 1; }
  # (a2) delivery_failed = run landed and reached nobody; the DELIVERY cause wins
  printf '%s\n' "$LLR" | grep -qxF 'loopdead:undelivered-job run ok but NOT DELIVERED cause=discord: channel not found' || { echo "selfcheck fail: delivery term"; exit 1; }
  # (b) overdue fire (the cadence-independent missed-fire signal)
  printf '%s\n' "$LLR" | grep -qxF 'loopdead:overdue-job overdue fire: next_run_at past by =2h (max gap 60m) cause=no error recorded' || { echo "selfcheck fail: overdue term"; exit 1; }
  # (b2) stale fire: the newest stamp wins, sub-hour ages in minutes
  printf '%s\n' "$LLR" | grep -qxF 'loopdead:stale-job last fire =3h ago (max gap 60m) cause=last successful run' || { echo "selfcheck fail: stale fire term"; exit 1; }
  printf '%s\n' "$LLR" | grep -qxF 'loopdead:interval-job last fire =25m ago (max gap 10m) cause=no error recorded' || { echo "selfcheck fail: sub-hour age"; exit 1; }
  # (b3) dispatched but never completing past max(4x gap, 12h); 6h inside the floor is fine
  printf '%s\n' "$LLR" | grep -qxF 'loopdead:hung-job dispatched but no completion for =13h (max gap 60m) cause=no error recorded' || { echo "selfcheck fail: no-completion term"; exit 1; }
  # cause selection: the prompt title is not a cause; last_fire_error is one
  printf '%s\n' "$LLR" | grep -qF 'loopdead:title-cause-job last fire =3h ago (max gap 60m) cause=RuntimeError: boom' || { echo "selfcheck fail: cause skips the title line"; exit 1; }
  printf '%s\n' "$LLR" | grep -qF 'cause=dispatch handoff missed the fire window' || { echo "selfcheck fail: last_fire_error cause"; exit 1; }
  # gap enumeration: dom/dow UNION, seconds-LAST six-field exprs, cron 7=Sunday,
  # leap-day reality (the buffer supplies each fire its true successor)
  printf '%s\n' "$LLR" | grep -qF 'loopdead:union-job last fire =545h ago (max gap 10080m)' || { echo "selfcheck fail: dom/dow union gap"; exit 1; }
  printf '%s\n' "$LLR" | grep -qF 'loopdead:six-field-job last fire =161h ago (max gap 4320m)' || { echo "selfcheck fail: six-field expr"; exit 1; }
  printf '%s\n' "$LLR" | grep -qF 'loopdead:sunday7-job last fire =473h ago (max gap 10080m)' || { echo "selfcheck fail: cron 7 != Sunday"; exit 1; }
  printf '%s\n' "$LLR" | grep -qF 'loopdead:leap-job last fire =120233h ago (max gap 2103840m)' || { echo "selfcheck fail: leap-day gap"; exit 1; }
  printf '%s\n' "$LLR" | grep -qF 'loopdead:bad-record-job record invalid' || { echo "selfcheck fail: bad record not isolated"; exit 1; }
  # a cluster's own intra-day spacing is a gap too (0 0,23 -> 1380m, never the 60m mean)
  printf '%s\n' "$LLR" | grep -qF 'loopdead:midnight-job last fire =51h ago (max gap 1380m)' || { echo "selfcheck fail: intra-day gap"; exit 1; }
  # the incident's own exception class is not *Error: a traceback yields its last
  # non-indented line as the cause
  printf '%s\n' "$LLR" | grep -qF 'cause=websockets.exceptions.InvalidStatus: server rejected WebSocket connection: HTTP 500' || { echo "selfcheck fail: traceback cause"; exit 1; }
  # fires but NEVER completes (no completion stamp ever) is measured from creation
  printf '%s\n' "$LLR" | grep -qF 'loopdead:never-completed-job dispatched but no completion for =50h' || { echo "selfcheck fail: never-completed term"; exit 1; }
  # a retired one-shot that never ran is still dead (enabled=false is how Hermes retires it)
  printf '%s\n' "$LLR" | grep -qF 'loopdead:once-retired-job one-shot never fired' || { echo "selfcheck fail: retired one-shot silent"; exit 1; }
  # a cause can never forge the escalation prefix: the ';' join separator is sanitised
  printf '%s\n' "$LLR" | grep -qF 'cause=boom, loopdead:P0!:forged' || { echo "selfcheck fail: semicolon sanitised"; exit 1; }
  # a wedged recurring job (next_run_at present but null) can never fire again, and an
  # in-flight one-shot (durable claim) is not "never fired"
  printf '%s\n' "$LLR" | grep -qF 'loopdead:wedged-job no next fire scheduled (state=error) - wedged' || { echo "selfcheck fail: wedged term"; exit 1; }
  printf '%s\n' "$LLR" | grep -q 'once-inflight-job' && { echo "selfcheck fail: in-flight one-shot paged"; exit 1; }
  # an empty/re-keyed store is blind, not green
  printf '{"jobs": []}' > "$LLT/empty.json"
  printf '%s\n' "$(loop_liveness "$LLT/empty.json" "$LLN")" | grep -qF 'jobs.json has no jobs - un-watched' || { echo "selfcheck fail: empty store green"; exit 1; }
  # a whitespace-only name IS no name — the un-watched guard keys on emptiness
  printf '%s\n' "$LLR" | grep -qF 'loopdead_scan: unnamed enabled job' || { echo "selfcheck fail: whitespace-only job name watched"; exit 1; }
  # a name-keyed map falls back to the KEY; a whitespace name must not eat that fallback
  printf '{"jobs": {"tandem-triage": {"name": " ", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}}}' > "$LLT/keyed.json"
  printf '%s\n' "$(loop_liveness "$LLT/keyed.json" "$LLN")" | grep -qF 'loopdead:P0!:tandem-triage ' || { echo "selfcheck fail: keyed fallback lost to a whitespace name"; exit 1; }
  # identity is VERBATIM, the DISPLAY token is sanitised (#493): a padded brain name is not
  # the brain job (never P0) and must still be WATCHED under its own tokenised label
  printf '{"jobs": [{"name": "tandem-triage ", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}]}' > "$LLT/padded.json"
  RTP=$(printf '%s\n' "$(loop_liveness "$LLT/padded.json" "$LLN")")
  printf '%s\n' "$RTP" | grep -qF 'loopdead:P0!:' && { echo "selfcheck fail: padded brain name escalated"; exit 1; }
  printf '%s\n' "$RTP" | grep -Eq '^loopdead:tandem-triage~[a-z]{12} last fire' || { echo "selfcheck fail: padded job fell out of the scan (silence)"; exit 1; }
  # #493: the display token never carries ':' '!' '=' or a control character, so a crafted
  # name can neither forge a second physical line nor spell the P0 token; the P0 prefix is
  # chosen by identity alone, a sanitised token carries a ~hash discriminator so colliding
  # names still emit distinct lines, and a loopdead payload never reaches a loose P0 phrase.
  printf '%s' '{"jobs": [{"name": "P0!:tandem-triage", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "line\nforge", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "nightly.report_v2", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "unreachable", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "!!!", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "nightly:report", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "nightly report", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "b\u00e1o c\u00e1o tu\u1ea7n", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "spaced-expr", "enabled": true, "schedule": {"kind": "cron", "expr": "0  0 * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "x=5m", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "a:b", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "a!b", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": " tandem-triage", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "\u0301", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}, {"name": "tandem-triage", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "error", "failure_streak": 3, "last_run_at": "2026-11-15T00:00:00+00:00"}]}' > "$LLT/crafted.json"
  RTC=$(printf '%s\n' "$(loop_liveness "$LLT/crafted.json" "$LLN")")
  [ "$(printf '%s\n' "$RTC" | grep -c .)" = "15" ] || { echo "selfcheck fail: crafted fixture is not one line per job"; exit 1; }
  printf '%s\n' "$RTC" | grep -q '^forge' && { echo "selfcheck fail: newline name forged a physical line"; exit 1; }
  printf '%s\n' "$RTC" | grep -Eq '^loopdead:P0 tandem-triage~[a-z]{12} last fire' || { echo "selfcheck fail: crafted P0 name not tokenised"; exit 1; }
  CCL=$(printf '%s\n' "$RTC" | grep '^loopdead:P0 tandem-triage' || true)
  [ -n "$CCL" ] || { echo "selfcheck fail: crafted P0 line missing (vacuous check)"; exit 1; }
  case "$CCL" in *'P0!:'*) echo "selfcheck fail: crafted name spelled the P0 token"; exit 1 ;; esac
  printf '%s\n' "$RTC" | grep -Eq '^loopdead:<unprintable>~[a-z]{12} last fire' || { echo "selfcheck fail: all-punctuation name lost its fallback token"; exit 1; }
  [ "$(printf '%s\n' "$RTC" | grep -E '^loopdead:nightly report' | sort -u | grep -c .)" = "2" ] || { echo "selfcheck fail: colliding display tokens emit identical lines"; exit 1; }
  D1=$(dedupe_key "$(printf '%s\n' "$RTC" | grep -E '^loopdead:nightly report' | sed -n 1p)")
  D2=$(dedupe_key "$(printf '%s\n' "$RTC" | grep -E '^loopdead:nightly report' | sed -n 2p)")
  [ -n "$D1" ] && [ "$D1" != "$D2" ] || { echo "selfcheck fail: colliding display tokens share a dedupe key"; exit 1; }
  printf '%s\n' "$RTC" | grep -q '^loopdead:báo cáo tuần last fire' || { echo "selfcheck fail: a non-ASCII name was shredded"; exit 1; }
  NFD=$(printf '%s' '{"jobs": [{"name": "ba\u0301o", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}]}' > "$LLT/nfd.json"; PYTHONIOENCODING=iso-8859-1 loop_liveness "$LLT/nfd.json" "$LLN")
  printf '%s\n' "$NFD" | grep -Eq '^loopdead:ba[^ ]+o last fire' || { echo "selfcheck fail: a decomposed name lost its combining mark or the locale killed the scan"; exit 1; }
  LOK=$(PYTHONUTF8=0 PYTHONCOERCECLOCALE=0 LC_ALL=C loop_liveness "$LLT/nfd.json" "$LLN")
  printf '%s\n' "$LOK" | grep -q '^loopdead:ba' || { echo "selfcheck fail: a C locale decode killed the scan"; exit 1; }
  # the record is read as BYTES: a stray invalid-UTF-8 byte degrades to U+FFFD and the scan
  # still reports the job (a locale-decoded text read would raise and blind every job)
  printf '{"jobs": [{"name": "bad\xe1byte", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}, "last_status": "ok", "failure_streak": 0, "last_run_at": "2026-11-15T00:00:00+00:00"}]}' > "$LLT/badutf.json"
  BUT=$(loop_liveness "$LLT/badutf.json" "$LLN")
  printf '%s\n' "$BUT" | grep -q '^loopdead:bad' || { echo "selfcheck fail: an invalid UTF-8 byte in the record killed the scan"; exit 1; }
  printf '%s\n' "$RTC" | grep -qF "unsupported schedule ('0  0 * *')" || { echo "selfcheck fail: the sweep rewrote quoted record text"; exit 1; }
  printf '%s\n' "$RTC" | grep -Eq '^loopdead:x 5m~[a-z]{12} last fire' || { echo "selfcheck fail: '=' survived into the token (age-mask collision)"; exit 1; }
  printf '%s\n' "$RTC" | grep -q '^loopdead:nightly.report_v2 last fire' || { echo "selfcheck fail: '.' or '_' was stripped from a clean name"; exit 1; }
  printf '%s\n' "$RTC" | grep -Eq '^loopdead:tandem-triage~[a-z]{12} last fire' || { echo "selfcheck fail: a leading space survived the trim"; exit 1; }
  printf '%s\n' "$RTC" | grep -Eq '^loopdead:<unprintable>~[a-z]{12} last fire' || { echo "selfcheck fail: a mark-only name rendered invisibly"; exit 1; }
  A1=$(printf '%s\n' "$RTC" | grep -E '^loopdead:a b' | sed -n 1p); A2=$(printf '%s\n' "$RTC" | grep -E '^loopdead:a b' | sed -n 2p)
  [ -n "$A1" ] && [ -n "$A2" ] && [ "$A1" != "$A2" ] && [ "$(dedupe_key "$A1")" != "$(dedupe_key "$A2")" ] || { echo "selfcheck fail: two identically-sanitised names collide in line or key"; exit 1; }
  printf '%s\n' "$RTC" | grep -q '^loopdead:P0!:tandem-triage failing' || { echo "selfcheck fail: real brain death lost its P0 token"; exit 1; }
  CPL=$(printf '%s\n' "$RTC" | grep '^loopdead:P0 tandem-triage' || true)
  [ -n "$CPL" ] || { echo "selfcheck fail: crafted P0 line missing (vacuous check)"; exit 1; }
  [ "$(probe_level "$CPL")" = "1" ] || { echo "selfcheck fail: crafted P0 name escalated"; exit 1; }
  URL=$(printf '%s\n' "$RTC" | grep '^loopdead:unreachable' || true)
  [ -n "$URL" ] || { echo "selfcheck fail: unreachable-name line missing (vacuous check)"; exit 1; }
  [ "$(probe_level "$URL")" = "1" ] || { echo "selfcheck fail: letters-only P0 phrase name escalated"; exit 1; }
  BRL=$(printf '%s\n' "$RTC" | grep '^loopdead:P0!:tandem-triage' || true)
  [ -n "$BRL" ] || { echo "selfcheck fail: brain line missing (vacuous check)"; exit 1; }
  [ "$(probe_level "$BRL")" = "0" ] || { echo "selfcheck fail: brain death not P0"; exit 1; }
  [ "$(probe_level 'loopdead:j cause=db unreachable')" = "1" ] || { echo "selfcheck fail: a cause forged a loose P0 phrase"; exit 1; }
  [ "$(probe_level 'loopdead:j last fire;db: unreachable')" = "0" ] || { echo "selfcheck fail: a genuine db P0 lost to the segment rule"; exit 1; }
  [ "$(probe_level 'x; loopdead:P0!:tandem-triage y')" = "1" ] || { echo "selfcheck fail: a space after the join separator escalated"; exit 1; }
  # LINE INTEGRITY (#493): every record-shaped field (name, state, schedule, cause) is swept
  # of every code point a Unicode line splitter treats as a break (C0/C1/LS/PS) at emission,
  # so the line count is the job count, not the content's; a lone surrogate must not kill the
  # scan (the brain job AFTER it must still emit its P0); a hostile name through the
  # record-invalid path is tokenised too.
  printf '%s' '{"jobs": [{"name": "surrogate", "last_status": "error", "failure_streak": 3, "last_error": "\ud800db: unreachable", "last_run_at": "2026-11-15T00:00:00+00:00", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}}, {"name": "stateforge", "state": "error\u0085db: unreachable", "next_run_at": null, "last_run_at": "2026-11-15T00:00:00+00:00", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}}, {"name": "stateforge4", "state": "error\u2029db: unreachable", "next_run_at": null, "last_run_at": "2026-11-15T00:00:00+00:00", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}}, {"name": "stateforge5", "state": "error\u007fdb: unreachable", "next_run_at": null, "last_run_at": "2026-11-15T00:00:00+00:00", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}}, {"name": "stateforge3", "state": "error\ndb: unreachable", "next_run_at": null, "last_run_at": "2026-11-15T00:00:00+00:00", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}}, {"name": "stateforge2", "state": "error\u2028db: unreachable", "next_run_at": null, "last_run_at": "2026-11-15T00:00:00+00:00", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}}, {"name": "tandem-triage", "last_status": "error", "failure_streak": 3, "last_run_at": "2026-11-15T00:00:00+00:00", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}}]}' > "$LLT/integrity.json"
  RTI=$(printf '%s\n' "$(loop_liveness "$LLT/integrity.json" "$LLN")")
  [ "$(printf '%s\n' "$RTI" | grep -c .)" = "7" ] || { echo "selfcheck fail: a record field forged a physical line or killed the scan"; exit 1; }
  printf '%s\n' "$RTI" | grep -q '^db:' && { echo "selfcheck fail: a swept break forged a line start"; exit 1; }
  printf '%s\n' "$RTI" | grep -q '^loopdead:P0!:tandem-triage failing' || { echo "selfcheck fail: a lone surrogate killed the scan before the brain job"; exit 1; }
  [ "$(probe_level "$(printf '%s\n' "$RTI" | grep '^loopdead:surrogate')")" = "1" ] || { echo "selfcheck fail: surrogate cause escalated"; exit 1; }
  printf '%s\n' "$RTI" | grep -Eq '^loopdead:stateforge no next fire scheduled \(state=error db: unreachable\) - wedged' || { echo "selfcheck fail: C1 state not swept"; exit 1; }
  printf '%s\n' "$RTI" | grep -Eq '^loopdead:stateforge4 no next fire scheduled \(state=error db: unreachable\) - wedged' || { echo "selfcheck fail: PS state not swept"; exit 1; }
  printf '%s\n' "$RTI" | grep -Eq '^loopdead:stateforge5 no next fire scheduled \(state=error db: unreachable\) - wedged' || { echo "selfcheck fail: DEL state not swept"; exit 1; }
  printf '%s\n' "$RTI" | grep -Eq '^loopdead:stateforge3 no next fire scheduled \(state=error db: unreachable\) - wedged' || { echo "selfcheck fail: C0 state not swept"; exit 1; }
  [ "$(probe_level "$(printf '%s\n' "$RTI" | grep '^loopdead:stateforge ' || true)")" = "1" ] || { echo "selfcheck fail: C1 state payload escalated"; exit 1; }
  printf '%s\n' "$RTI" | grep -Eq '^loopdead:stateforge2 no next fire scheduled \(state=error db: unreachable\) - wedged' || { echo "selfcheck fail: LS state not swept"; exit 1; }
  [ "$(probe_level "$(printf '%s\n' "$RTI" | grep '^loopdead:stateforge2')")" = "1" ] || { echo "selfcheck fail: state payload escalated"; exit 1; }
  printf '%s' '{"jobs": [{"name": "x\nloopdead:P0!:tandem-triage y", "last_run_at": "x;y", "enabled": true, "schedule": {"kind": "cron", "expr": "0 * * * *"}}]}' > "$LLT/invalid.json"
  RTJ=$(printf '%s\n' "$(loop_liveness "$LLT/invalid.json" "$LLN")")
  [ "$(printf '%s\n' "$RTJ" | grep -c .)" = "1" ] || { echo "selfcheck fail: record-invalid path forged a line"; exit 1; }
  printf '%s\n' "$RTJ" | grep -Eq '^loopdead:x loopdead P0 tandem-triage y~[a-z]{12} record invalid' || { echo "selfcheck fail: hostile name on the record-invalid path not tokenised"; exit 1; }
  printf '%s\n' "$RTJ" | grep -q '^loopdead:P0!:' && { echo "selfcheck fail: record-invalid path forged the P0 token"; exit 1; }
  # a scan line's record payload never reaches a loose P0 phrase either
  printf '%s' '{"jobs": ["db unreachable"]}' > "$LLT/scan.json"
  RTS=$(printf '%s\n' "$(loop_liveness "$LLT/scan.json" "$LLN")")
  printf '%s\n' "$RTS" | grep -qF "non-object job entry 'db unreachable'" || { echo "selfcheck fail: scan line missing"; exit 1; }
  [ "$(probe_level "$RTS")" = "1" ] || { echo "selfcheck fail: scan payload escalated"; exit 1; }
  # the join separator never appears inside a line, even in record text
  printf '%s\n' "$LLR" | grep -qF 'loopdead:bad-semicolon-job record invalid' || { echo "selfcheck fail: semicolon record missing"; exit 1; }
  printf '%s\n' "$LLR" | grep -qE 'bad-semicolon-job[^;]*;' && { echo "selfcheck fail: separator leaked into a line"; exit 1; }  # (c) one-shots and underivable schedules are anomalies, never silence
  printf '%s\n' "$LLR" | grep -qF 'loopdead:once-job one-shot never fired (run_at 2026-11-17T00:00:00+00:00)' || { echo "selfcheck fail: one-shot never fired"; exit 1; }
  printf '%s\n' "$LLR" | grep -qF 'loopdead:once-norunat-job unsupported schedule (once without run_at) un-watched' || { echo "selfcheck fail: once without run_at silent"; exit 1; }
  printf '%s\n' "$LLR" | grep -qF "loopdead:unsupported-job unsupported schedule ('0 0 * *') un-watched" || { echo "selfcheck fail: unsupported schedule silent"; exit 1; }
  # exactly these 25 'loopdead:' lines (the unnamed-job scan line is separate): silence on
  # a healthy record is as load-bearing as the alert
  LLC2=$(printf '%s\n' "$LLR" | grep -c '^loopdead:')
  [ "$LLC2" = "25" ] || { echo "selfcheck fail: expected 25 lines, got $LLC2"; exit 1; }
  # silences: inside 2x, a single failure, queued delivery (even with a stale streak), an
  # operator cancel, disabled, paused state, never-run, in-flight, 6h of a hung hourly run
  # inside the 12h floor, a fired one-shot, a one-shot inside its grace, the dom/quarterly/
  # annual drifts, named months, the weekday weekend gap, and the probe itself
  for QUIET in tandem-triage nightly-report single-failure-job queued-job queued-streak-job cancelled-job paused-job paused-state-job never-run-job inflight-job no-completion-job once-fired-job once-recent-job monthly-drill quarterly-job annual-job named-month-job weekday-job tandem-prod-watch; do
    printf '%s\n' "$LLR" | grep -q "loopdead:.*$QUIET" && { echo "selfcheck fail: $QUIET alerted on a healthy record"; exit 1; }
  done
  # boundary: the hourly job's dispatch stamp is 02:00, so at exactly 04:00 it is at 2x
  # (silent) and one minute later it is stale (strict >)
  printf '%s\n' "$(loop_liveness "$LLT/jobs.json" "$(date -u -d '2026-11-17T04:00:00Z' +%s)")" | grep -q 'loopdead:.*tandem-triage' && { echo "selfcheck fail: exactly 2x alerted"; exit 1; }
  printf '%s\n' "$(loop_liveness "$LLT/jobs.json" "$(date -u -d '2026-11-17T04:01:00Z' +%s)")" | grep -qF 'loopdead:P0!:tandem-triage last fire =2h ago (max gap 60m)' || { echo "selfcheck fail: just past 2x silent"; exit 1; }
  # unreadable scheduler record = blind, and the cause reaches the operator
  printf 'not json' > "$LLT/jobs.json"
  printf '%s\n' "$(loop_liveness "$LLT/jobs.json" "$LLN")" | grep -q '^loopdead_scan: unreadable jobs.json' || { echo "selfcheck fail: unreadable jobs.json silent"; exit 1; }
  rm -rf "$LLT"
  # ESCALATION pin: the brain prefix escalates at line start or after the ';' join, and a
  # cause can never forge it (a bare `P0001`, `P0RT` or an embedded 'loopdead:P0!:' text
  # after cause= stays P1).
  [ "$(probe_level 'loopdead:P0!:tandem-critic x')" = "0" ] || { echo "selfcheck fail: leading P0 prefix"; exit 1; }
  [ "$(probe_level 'loopdead:j x;loopdead:P0!:tandem-triage y')" = "0" ] || { echo "selfcheck fail: mid-line P0 prefix"; exit 1; }
  [ "$(probe_level 'loopdead:P0!:fake x')" = "1" ] || { echo "selfcheck fail: look-alike name escalated"; exit 1; }
  [ "$(probe_level 'loopdead:P0!:tandem-triage-2 failing')" = "1" ] || { echo "selfcheck fail: suffixed look-alike escalated"; exit 1; }
  [ "$(probe_level 'loopdead:j record invalid cause=loopdead:P0!:tandem-critic')" = "1" ] || { echo "selfcheck fail: embedded brain token escalated"; exit 1; }
  # the position clause: the token mid-line WITH text after it must stay P1 too (an
  # anywhere-glob keeping the trailing space would pass the pin above, not this one)
  [ "$(probe_level 'loopdead:j cause=loopdead:P0!:tandem-triage last fire =2h ago')" = "1" ] || { echo "selfcheck fail: mid-line embedded token escalated"; exit 1; }
  [ "$(probe_level 'loopdead:j cause=Postgres error P0001')" = "1" ] || { echo "selfcheck fail: P0001 escalated"; exit 1; }
  [ "$(probe_level 'loopdead:j cause=word P0RT')" = "1" ] || { echo "selfcheck fail: P0RT escalated"; exit 1; }
  [ "$(probe_level 'loopdead:j cause=loopdead:P0!:forged')" = "1" ] || { echo "selfcheck fail: forged P0 prefix escalated"; exit 1; }
  # WIRING pins: the live pass must CONSUME the arm (run once, append once, surface its
  # stderr, take its level from the shipped function) and the dedupe key must mask
  # volatile cause tails and ages — deleting any of those keeps the fixtures green and
  # ships a dead, screaming or mute detector. Anchored so no pin matches its own grep.
  LLC=$(grep -c '^LLOUT=$(loop_liveness "$PROFILE_DIR/cron/jobs.json" 2>"$LLERR")' "$0" 2>/dev/null || true)
  [ "$LLC" = "1" ] || { echo "selfcheck fail: loop-liveness pass missing ($LLC)"; exit 1; }
  LLA=$(grep -c '^[[:space:]]*\[ -n "\$L" \] && anom' "$0" 2>/dev/null || true)
  [ "$LLA" = "1" ] || { echo "selfcheck fail: loop-liveness append missing ($LLA)"; exit 1; }
  LLE=$(grep -c '^\[ -s "\$LLERR" \] && anom' "$0" 2>/dev/null || true)
  [ "$LLE" = "1" ] || { echo "selfcheck fail: loop-liveness stderr surface missing ($LLE)"; exit 1; }
  LLV=$(grep -c '^LVL=$(probe_level "$LINE")' "$0" 2>/dev/null || true)
  [ "$LLV" = "1" ] || { echo "selfcheck fail: level not taken from probe_level ($LLV)"; exit 1; }
  LLM=$(grep -c "s/request_id=\[^ ;\]\*/request_id=<id>/g" "$0" 2>/dev/null || true)
  [ "$LLM" = "1" ] || { echo "selfcheck fail: cause-tail masking missing ($LLM)"; exit 1; }
  LLM2=$(grep -c '^  printf .*s/=\[0-9\]+\[mh\](\[^a-z0-9\]|\$)/=<age>' "$0" 2>/dev/null || true)
  [ "$LLM2" = "1" ] || { echo "selfcheck fail: age masking missing ($LLM2)"; exit 1; }
  LLU=$(grep -c '^  printf .*\[0-9a-fA-F\]{8}-\[0-9a-fA-F\]{4}-' "$0" 2>/dev/null || true)
  [ "$LLU" = "1" ] || { echo "selfcheck fail: uuid masking missing ($LLU)"; exit 1; }
  # RUNTIME-REFRESH arm (#487): the shipped function is driven with fixtures through every
  # branch — a booted sha DIFFERENT from the install FIRES from a running AND from a
  # degraded record, and a stale record still fires when a FRESH live sibling precedes it
  # (no masking); the SAME sha is the steady state and stays silent; and a stopped record,
  # a recycled pid, a record with no start_time, a dead pid, an absent state file, an
  # absent sha, an all-zero placeholder sha, an unborn HEAD, a non-dict JSON document and a
  # non-git install each stay SILENT. The line carries no ';' join separator and names the
  # finding plus the SPEC pointer (never a runnable command); the level is P0 on the arm's
  # OWN prefix only (a look-alike cause string stays P1); the live pass consumes the arm
  # (call, then append) BEFORE the anomaly line is joined; the seam refuses a missing
  # install argument and is dispatched end-to-end AFTER its own pin.
  RTD=$(mktemp -d 2>/dev/null) || { echo "selfcheck fail: mktemp for the runtime fixture"; exit 1; }
  mkdir -p "$RTD/r" "$RTD/proc/4242" "$RTD/proc/7777"
  git init -q "$RTD/r" 2>/dev/null
  GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=f@example.invalid \
  GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=f@example.invalid \
  GIT_AUTHOR_DATE=2026-11-09T16:24:33Z GIT_COMMITTER_DATE=2026-11-09T16:24:33Z \
    git -C "$RTD/r" commit -q --no-gpg-sign --allow-empty -m fixture 2>/dev/null
  RT_SHA=$(git -C "$RTD/r" rev-parse HEAD)
  [ -n "$RT_SHA" ] || { echo "selfcheck fail: fixture git unusable"; exit 1; }
  python3 - "$RTD/proc/4242/stat" 1000 4242 <<'PY2'
import sys
open(sys.argv[1], "w").write("%s (gateway) S " % sys.argv[3] + " ".join(["0"] * 18 + [sys.argv[2]] + ["0"] * 10) + "\n")
PY2
  python3 - "$RTD/proc/7777/stat" 3000 7777 <<'PY2'
import sys
open(sys.argv[1], "w").write("%s (hermes) dashboard) x) S " % sys.argv[3] + " ".join(["0"] * 18 + [sys.argv[2]] + ["0"] * 10) + "\n")
PY2
  printf '{"gateway_state": "running", "pid": 4242, "start_time": 1000, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/stale.json"
  printf '{"gateway_state": "degraded", "pid": 4242, "start_time": 1000, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/degraded.json"
  printf '{"gateway_state": "running", "pid": 4242, "start_time": 1000, "code_sha": "%s"}' "$RT_SHA" > "$RTD/ok.json"
  printf '{"gateway_state": "stopped", "pid": 4242, "start_time": 1000, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/stopped.json"
  printf '{"gateway_state": "running", "pid": 4242, "start_time": 999, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/reused.json"
  printf '{"gateway_state": "running", "pid": 4242, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/nostamp.json"
  printf '{"gateway_state": "running", "pid": 9999, "start_time": 1000, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/dead.json"
  printf '{"gateway_state": "running", "pid": 4242, "start_time": 1000, "code_sha": ""}' > "$RTD/nosha.json"
  printf '{"gateway_state": "running", "pid": 4242, "start_time": 1000, "code_sha": "zzzz"}' > "$RTD/nonhex.json"
  printf '{"gateway_state": "running", "pid": 4242, "start_time": 1000, "code_sha": "0000000000000000000000000000000000000000"}' > "$RTD/zerosha.json"
  printf '[1, 2]' > "$RTD/array.json"
  printf '{"gateway_state": "running", "pid": "4242", "start_time": 1000, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/strpid.json"
  printf '{"gateway_state": "running", "pid": true, "start_time": 1000, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/boolpid.json"
  printf '{"gateway_state": "running", "pid": 4242.0, "start_time": 1000, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/floatpid.json"
  RTF=$(runtime_stale "$RTD/stale.json" "$RTD/r" "$RTD/proc")
  printf '%s' "$RTF" | grep -qF 'runtime_stale: the gateway (pid 4242) booted code 111111111 but the install is ' || { echo "selfcheck fail: stale runtime silent or mislabelled"; exit 1; }
  printf '%s' "$RTF" | grep -qF 'the unit is serving stale code' || { echo "selfcheck fail: stale runtime lost its verdict text"; exit 1; }
  printf '%s' "$RTF" | grep -qF 'SPEC RUNTIME-REFRESH' || { echo "selfcheck fail: stale runtime lost its SPEC pointer"; exit 1; }
  printf '%s' "$RTF" | grep -qF ';' && { echo "selfcheck fail: runtime line carries the join separator"; exit 1; }
  RT_CMD_RE=$(printf '%s|%s gateway (re%s|st%s)' 'systemctl' 'hermes' 'start' 'op')
  printf '%s' "$RTF" | grep -qE "$RT_CMD_RE" && { echo "selfcheck fail: the emitted line embeds a runnable operator command"; exit 1; }
  [ -n "$(runtime_stale "$RTD/degraded.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: degraded gateway not read as serving"; exit 1; }
  [ -n "$(runtime_stale "$RTD/strpid.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: numeric-string pid not read"; exit 1; }
  [ -z "$(runtime_stale "$RTD/ok.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: matching sha alarmed"; exit 1; }
  [ -z "$(runtime_stale "$RTD/stopped.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: stopped gateway alarmed"; exit 1; }
  [ -z "$(runtime_stale "$RTD/reused.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: recycled pid alarmed"; exit 1; }
  [ -z "$(runtime_stale "$RTD/nostamp.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: unstamped record trusted"; exit 1; }
  [ -z "$(runtime_stale "$RTD/boolpid.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: boolean pid trusted"; exit 1; }
  [ -z "$(runtime_stale "$RTD/floatpid.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: float pid trusted"; exit 1; }
  [ -z "$(runtime_stale "$RTD/dead.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: dead pid alarmed"; exit 1; }
  [ -z "$(runtime_stale "$RTD/absent.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: absent state alarmed"; exit 1; }
  [ -z "$(runtime_stale "$RTD/nosha.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: absent sha alarmed"; exit 1; }
  [ -n "$(runtime_stale "$RTD/nonhex.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: a non-hex sha was masked (charset rule reintroduced)"; exit 1; }
  printf '{"gateway_state": "running", "pid": 4242, "start_time": 1000, "code_sha": "111111111"}' > "$RTD/shortsha.json"
  [ -z "$(runtime_stale "$RTD/zerosha.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: placeholder zero sha alarmed"; exit 1; }
  [ -z "$(runtime_stale "$RTD/array.json" "$RTD/r" "$RTD/proc" 2>"$RTD/arr.err")" ] || { echo "selfcheck fail: non-dict JSON alarmed"; exit 1; }
  [ -s "$RTD/arr.err" ] && { echo "selfcheck fail: non-dict JSON raised on stderr"; exit 1; }
  [ -z "$(runtime_stale "$RTD/stale.json" "$RTD/nope" "$RTD/proc")" ] || { echo "selfcheck fail: non-git install alarmed"; exit 1; }
  mkdir -p "$RTD/unborn"; git init -q "$RTD/unborn" 2>/dev/null
  [ -z "$(runtime_stale "$RTD/stale.json" "$RTD/unborn" "$RTD/proc")" ] || { echo "selfcheck fail: unborn HEAD alarmed"; exit 1; }
  # a fresh live record must never mask a stale live sibling (two serving gateways)
  printf '%s' "$(runtime_stale "$RTD/ok.json:$RTD/stale.json" "$RTD/r" "$RTD/proc")" | grep -qF 'booted code 111111111' || { echo "selfcheck fail: a fresh live record masked a stale sibling"; exit 1; }
  printf '%s' "$(runtime_stale "$RTD/stale.json:$RTD/ok.json" "$RTD/r" "$RTD/proc")" | grep -qF 'booted code 111111111' || { echo "selfcheck fail: stale-first ordering broke"; exit 1; }
  # an install stamp is the primary identity; a checkout HEAD is the fallback
  printf '{"commit": "1111111111111111111111111111111111111111", "updateMechanism": "self"}' > "$RTD/r/install-stamp.json"
  [ -z "$(runtime_stale "$RTD/stale.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: install-stamp identity ignored (HEAD used instead of the stamp)"; exit 1; }
  printf '{"commit": "1111111111111111111111111111111111111111", "source": "git", "updateMechanism": "self"}' > "$RTD/r/install-stamp.json"
  [ -n "$(runtime_stale "$RTD/stale.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: a stale git-source stamp was trusted over HEAD"; exit 1; }
  printf '{"commit": "1111111111111111111111111111111111111111", "source": "wheel", "updateMechanism": "self"}' > "$RTD/r/install-stamp.json"
  [ -z "$(runtime_stale "$RTD/stale.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: a non-git stamp was ignored"; exit 1; }
  printf '{"commit": "111111111", "source": "wheel", "updateMechanism": "self"}' > "$RTD/r/install-stamp.json"
  [ -z "$(runtime_stale "$RTD/shortsha.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: a short stamp was not honoured as the identity"; exit 1; }
  printf '{"gateway_state": "running", "pid": 4242, "start_time": 1000, "code_sha": "%s"}' "$RT_SHA" > "$RTD/headsha.json"
  [ -n "$(runtime_stale "$RTD/headsha.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: a short stamp was not compared (length rule reintroduced)"; exit 1; }
  [ -n "$(runtime_stale "$RTD/stale.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: a short stamp did not expose the divergence"; exit 1; }
  printf '{"commit": "1111111111111111111111111111111111111111", "updateMechanism": "bogus"}' > "$RTD/r/install-stamp.json"
  [ -n "$(runtime_stale "$RTD/stale.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: a stamp with an unknown updateMechanism was honoured"; exit 1; }
  printf '{"commit": "1111111111111111111111111111111111111111", "updateMechanism": "self", "payload": "light"}' > "$RTD/r/install-stamp.json"
  [ -n "$(runtime_stale "$RTD/stale.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: a light-artifact stamp was honoured"; exit 1; }
  printf '{"commit": "%s", "updateMechanism": "self"}' "$RT_SHA" > "$RTD/r/install-stamp.json"
  [ -n "$(runtime_stale "$RTD/stale.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: install-stamp identity broke the fire path"; exit 1; }
  rm -f "$RTD/r/install-stamp.json"
  # a comm containing ')' must not shift the field index
  printf '{"gateway_state": "running", "pid": 7777, "start_time": 3000, "code_sha": "1111111111111111111111111111111111111111"}' > "$RTD/paren.json"
  [ -n "$(runtime_stale "$RTD/paren.json" "$RTD/r" "$RTD/proc")" ] || { echo "selfcheck fail: comm-with-paren parse broken"; exit 1; }
  [ "$(probe_level "$RTF")" = "0" ] || { echo "selfcheck fail: runtime_stale not P0"; exit 1; }
  [ "$(probe_level 'loopdead:docs-bot cause=RuntimeError: runtime_stale arm fired')" = "1" ] || { echo "selfcheck fail: a look-alike cause escalated"; exit 1; }
  [ "$(probe_level 'loopdead:docs-bot cause=error runtime_stale: the gateway (pid 1) booted code x')" = "1" ] || { echo "selfcheck fail: a cause-embedded prefix escalated"; exit 1; }
  [ "$(probe_level 'runtime_stale: the gateway (pid 1) booted code x but the install is y')" = "0" ] || { echo "selfcheck fail: the arm's own line is not P0"; exit 1; }
  [ "$(probe_level 'container: x;runtime_stale: the gateway (pid 1) booted code x')" = "0" ] || { echo "selfcheck fail: the arm after the join separator is not P0"; exit 1; }
  grep -cE '^ +out_line\("loopdead_scan: non-object job entry %s" % repr\(j\)\.replace\(";", ","\)' "$0" | grep -qx 1 || { echo "selfcheck fail: the non-object scan line no longer strips the separator"; exit 1; }
  grep -cE '^ +out_line\("loopdead_scan: unnamed enabled job \(%s\) - un-watched" % repr\(j\.get\("schedule"\)\)\.replace\(";", ","\)' "$0" | grep -qx 1 || { echo "selfcheck fail: the unnamed-job scan line no longer strips the separator"; exit 1; }
  grep -cxF 'RUNTIME=$(runtime_stale "${HERMES_GATEWAY_STATE:-$PROFILE_DIR/gateway_state.json:$HOME/.hermes/gateway_state.json}" "${HERMES_INSTALL_DIR:-/usr/local/lib/hermes-agent}" 2>"$PROBE_STATE/runtime.err")' "$0" | grep -qx 1 || { echo "selfcheck fail: runtime arm call changed"; exit 1; }
  grep -cE '^\[ -s "\$PROBE_STATE/runtime\.err" \] && anom\+=\("runtime_stale_err: ' "$0" | grep -qx 1 || { echo "selfcheck fail: runtime arm stderr surface missing"; exit 1; }
  grep -cxF '[ -n "$RUNTIME" ] && anom+=("$RUNTIME")' "$0" | grep -qx 1 || { echo "selfcheck fail: runtime arm append missing"; exit 1; }
  grep -cxF 'if [ "${1:-}" = "--runtime-stale" ]; then' "$0" | grep -qx 1 || { echo "selfcheck fail: runtime seam dispatch changed"; exit 1; }
  awk '/^anom=\(\)$/{s=NR} /^RUNTIME=\$\(runtime_stale /{a=NR} /^\[ -n "\$RUNTIME" \] && anom/{b=NR} /^if \[ \$\{#anom\[@\]\} -eq 0 \]/{d=NR} /^LINE="\$\(IFS=/{c=NR} END{exit !(s && a && b && d && c && s<a && a<b && b<d && d<c)}' "$0" || { echo "selfcheck fail: the wiring is not call-then-append before the empty-exit inside the live pass"; exit 1; }
  # the seam refuses a missing install argument, then dispatches end-to-end
  "$0" --runtime-stale "$RTD/stale.json" >/dev/null 2>&1; [ "$?" = "2" ] || { echo "selfcheck fail: seam accepts a missing install argument"; exit 1; }
  printf '%s' "$("$0" --runtime-stale "$RTD/stale.json" "$RTD/r" "$RTD/proc" 2>/dev/null)" | grep -qF 'runtime_stale:' || { echo "selfcheck fail: seam dispatch does not reach the arm"; exit 1; }
  rm -rf "$RTD"
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
if [ "${1:-}" = "--loop-liveness" ]; then
  # emit the liveness lines for an explicit jobs.json (+ optional now epoch): the arm's
  # unit test drives THESE bytes with fixtures — no network, no state writes.
  [ -n "${2:-}" ] || { echo "usage: --loop-liveness <jobs.json> [now_epoch]" >&2; exit 2; }
  loop_liveness "$2" "${3:-$(date -u +%s)}"
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

# 0. runtime refresh (#487): installed code newer than the serving process = mixed modules
RUNTIME=$(runtime_stale "${HERMES_GATEWAY_STATE:-$PROFILE_DIR/gateway_state.json:$HOME/.hermes/gateway_state.json}" "${HERMES_INSTALL_DIR:-/usr/local/lib/hermes-agent}" 2>"$PROBE_STATE/runtime.err")
[ -n "$RUNTIME" ] && anom+=("$RUNTIME")
[ -s "$PROBE_STATE/runtime.err" ] && anom+=("runtime_stale_err: $(tr '\n;' '  ' < "$PROBE_STATE/runtime.err" | head -c 200)")

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
    # (f2) rekey home: a block/park whose recorded origin RESOLVES to a TERMINAL home the
    # category was re-keyed under after the block recorded it, with the round closed over
    # it (#435). VERSION-INDEPENDENT like the orphan arm: the residual producer is the
    # statuses.save read->upsert window, present on every image. Previous-pass presence
    # confirm + id-set dedupe, like every other shape arm.
    REKEYHOME=$(echo "$STROUT" | awk -F'|' '/^rekeyhome/{print $2}')
    if [ -n "${REKEYHOME:-}" ] && [ "$REKEYHOME" != "none" ] && [ "$(cat "$PROBE_STATE/rekeyhome.prev" 2>/dev/null || echo none)" != "none" ]; then
      if [ "$(cat "$PROBE_STATE/rekeyhome.alerted" 2>/dev/null || echo none)" != "$REKEYHOME" ]; then
        anom+=("rekey_home: blocked task whose recorded block/park home was re-keyed into a terminal category over a decided round [$REKEYHOME] — the settle flip cannot land, #435 class")
        echo "$REKEYHOME" > "$PROBE_STATE/rekeyhome.alerted"
      fi
    else
      rm -f "$PROBE_STATE/rekeyhome.alerted"
    fi
    printf '%s\n' "${REKEYHOME:-none}" > "$PROBE_STATE/rekeyhome.prev"
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
    # (h) DECISION-parked round that CLOSED after the park with its flip lost (#431): a
    # LATE reviewer verdict landed on the parked task and the settle flip never followed,
    # so the task sits BLOCKED with the park standing and a closed round. No sweep reaches
    # it by contract — `restoreUnblocked` withholds a FINAL park, the re-arm scan filters
    # park_rearm_after IS NOT NULL, and the heals refuse a paused task — so the PARK OWNS
    # ITS OWN RESOLUTION: the alert asks for a status move, never a re-arm. Previous-pass
    # presence confirm + id-set dedupe, like every other shape arm.
    PARKCLOSED=$(echo "$STROUT" | awk -F'|' '/^parkclosed/{print $2}')
    if [ -n "${PARKCLOSED:-}" ] && [ "$PARKCLOSED" != "none" ] && [ "$(cat "$PROBE_STATE/parkclosed.prev" 2>/dev/null || echo none)" != "none" ]; then
      if [ "$(cat "$PROBE_STATE/parkclosed.alerted" 2>/dev/null || echo none)" != "$PARKCLOSED" ]; then
        anom+=("park_lost_flip: decision-parked task whose round closed after the park and the settle flip never landed [$PARKCLOSED] — the park owns its own resolution: move the task (the verdict is already recorded)")
        echo "$PARKCLOSED" > "$PROBE_STATE/parkclosed.alerted"
      fi
    else
      rm -f "$PROBE_STATE/parkclosed.alerted"
    fi
    printf '%s\n' "${PARKCLOSED:-none}" > "$PROBE_STATE/parkclosed.prev"
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
    # the record is UTF-8 BYTES: a locale-encoded text open would raise UnicodeDecodeError
    # under LC_ALL=C and collapse the whole scan (the brain jobs' P0 included)
    jobs = json.loads(open(sys.argv[1], "rb").read().decode("utf-8", "replace")).get("jobs", [])
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

# 6b. LOOP LIVENESS (#485): the loop's own crons had no no-LLM arm — 29h of dead
# triage/critic went unalerted because the product arms above watch prod, not the loop,
# and the designated dead-man (the critic) is itself an LLM cron. See loop_liveness.
LLERR=$(mktemp)
LLOUT=$(loop_liveness "$PROFILE_DIR/cron/jobs.json" 2>"$LLERR")
[ -s "$LLERR" ] && anom+=("loopdead_stderr: $(head -1 "$LLERR" | cut -c1-160)")
rm -f "$LLERR"
while IFS= read -r L; do
  [ -n "$L" ] && anom+=("$L")
done <<< "$LLOUT"


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
KEY=$(dedupe_key "$LINE")
if [ -f "$PROBE_STATE/last-anomaly" ] && [ "$(cat "$PROBE_STATE/last-anomaly" 2>/dev/null)" = "$KEY" ]; then
  echo "$(date -u +%FT%TZ) probe repeat-suppressed: $LINE" >> "$M"
  exit 0
fi
echo "$KEY" > "$PROBE_STATE/last-anomaly"
LVL=$(probe_level "$LINE"); [ ${#anom[@]} -ge 3 ] && LVL=0
printf 'P%d: %s\n' "$LVL" "$LINE"
