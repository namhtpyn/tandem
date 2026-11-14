#!/usr/bin/env bash
# Release-train preflight: semantic-release skips the tag SILENTLY when the
# train range carries no releasable-typed subject. Run BEFORE opening the
# dev→main train PR; pair the train with a fix-typed commit when this fails.
# Releasable set mirrors the repo's .releaserc.json analyzer on SUBJECTS (plus
# revert-body pairing); merge-commit bodies carrying PR titles are never read
# by the analyzer:
#   - fix|feat|perf|revert (lowercase default rules)
#   - FIX|FEAT (JSHint defaults the analyzer falls back to)
#   - any conventional type with a breaking header `!:` — releasable at SOME
#     magnitude (the script decides releasable/not, not patch vs major; scope
#     `+` quirks and revert-typed reverts change only the magnitude, never
#     releasable/not)
#   - canonical `Revert "…"` headers ONLY when that commit's body carries the
#     parser's `This reverts commit <sha>` trailer — subject-only Revert
#     headers release NOTHING (proven against commit-analyzer v13), so the
#     pair is required per commit
#   - scope charset is the analyzer's ASCII class [A-Za-z0-9_$@.+*/ -], empty
#     allowed; grep runs under LC_ALL=C because glibc collation would
#     otherwise let UTF-8 locales match non-ASCII inside A-Z ranges — the
#     false-green direction this tool exists to prevent.
#   NOT detectable here: a BREAKING CHANGE footer on a non-breaking subject
#   (releases major; fail-closed rc=1 — acceptable).
# Exit 0 = releasable subject present (printed); 1 = none, fail-closed;
# 2 = cannot fetch/verify/read the range, or the range has ZERO commits
# (nothing to train — including the post-train state where main already
# contains dev). A non-empty range whose commits merely lack subjects is rc=1.
# TANDEM_TRAIN_REPO retargets the repo in every mode (house style, sibling
# parity); TEST mode (TANDEM_TRAIN_TEST=1) additionally retargets refs
# (TANDEM_TRAIN_BASE/HEAD), skips the origin guard, and prints a TEST-MODE
# marker on stderr so a rehearsed result is never mistaken for a production
# clean. All diagnostics go to stderr; stdout is the rc=0 data channel only.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -n "${TANDEM_TRAIN_REPO:-}" ] && REPO="$TANDEM_TRAIN_REPO"
BASE_REF="refs/remotes/origin/main"
HEAD_REF="refs/remotes/origin/dev"
TESTMODE=0
if [ "${TANDEM_TRAIN_TEST:-0}" = "1" ]; then
  BASE_REF="${TANDEM_TRAIN_BASE:-$BASE_REF}"
  HEAD_REF="${TANDEM_TRAIN_HEAD:-$HEAD_REF}"
  TESTMODE=1
  echo "train-preflight: TEST-MODE (rehearsal, not a production clean)" >&2
fi
if [ "$TESTMODE" = "0" ]; then
  URL=$(git -C "$REPO" remote get-url origin 2>/dev/null)
  URL=${URL%.git}
  if [ -z "$URL" ]; then
    echo "train-preflight: cannot read the origin remote URL in $REPO (missing remote?)" >&2
    exit 2
  fi
  case "$URL" in
    https://github.com/namhtpyn/tandem | git@github.com:namhtpyn/tandem | ssh://git@github.com/namhtpyn/tandem) ;;
    *)
      echo "train-preflight: origin is not namhtpyn/tandem ($URL)" >&2
      exit 2
      ;;
  esac
  if ! git -C "$REPO" fetch origin "+refs/heads/main:$BASE_REF" "+refs/heads/dev:$HEAD_REF" -q 2>/dev/null; then
    echo "train-preflight: cannot fetch origin main+dev from $REPO" >&2
    exit 2
  fi
fi
if ! git -C "$REPO" rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  echo "train-preflight: cannot resolve base ref $BASE_REF in $REPO" >&2
  exit 2
fi
if ! git -C "$REPO" rev-parse --verify --quiet "$HEAD_REF" >/dev/null 2>&1; then
  echo "train-preflight: cannot resolve head ref $HEAD_REF in $REPO" >&2
  exit 2
fi
SUBJECTS=$(git -C "$REPO" log --format=%s "$BASE_REF..$HEAD_REF") || {
  echo "train-preflight: cannot read range $BASE_REF..$HEAD_REF in $REPO" >&2
  exit 2
}
COUNT=$(git -C "$REPO" rev-list --count "$BASE_REF..$HEAD_REF")
if [ "$COUNT" -eq 0 ]; then
  echo "train-preflight: $BASE_REF..$HEAD_REF is empty — nothing to train" >&2
  exit 2
fi
# Mirrors the analyzer's releasable headers (see header comment). LC_ALL=C is
# required: glibc UTF-8 collation matches non-ASCII inside [A-Za-z] ranges.
RELEASABLE=$(printf '%s\n' "$SUBJECTS" | LC_ALL=C grep -E '^(fix|feat|perf|revert|FIX|FEAT)(\([A-Za-z0-9_$@.+*/ -]*\))?!?: |^[A-Za-z0-9_]+(\([A-Za-z0-9_$@.+*/ -]*\))?!: ' || true)
# Revert headers release only with their body trailer — pair per commit.
# NUL-delimited records MUST go through process substitution: $( ) strips NUL
# bytes, which would collapse every commit into one delimiter-less read.
REVERT_SUBJECTS=""
unset RECORDS
while IFS= read -r -d '' rec || [ -n "$rec" ]; do
  subj=${rec%%$'\x01'*}
  body=${rec#*$'\x01'}
  case "$subj" in
    Revert\ \"*)
      if printf '%s' "$body" | LC_ALL=C grep -q 'This reverts commit '; then
        REVERT_SUBJECTS="${REVERT_SUBJECTS}${subj}
"
      fi
      ;;
  esac
  rec=""
done < <(git -C "$REPO" log --format='%x00%s%x01%b' "$BASE_REF..$HEAD_REF")
if [ -n "$RELEASABLE" ] || [ -n "$REVERT_SUBJECTS" ]; then
  [ -n "$RELEASABLE" ] && printf '%s\n' "$RELEASABLE"
  [ -n "$REVERT_SUBJECTS" ] && printf '%s' "$REVERT_SUBJECTS"
  exit 0
fi
echo "train-preflight: FAIL — $BASE_REF..$HEAD_REF has NO releasable subject ($COUNT commits); the train would skip the tag silently" >&2
echo "train-preflight: pair with a fix-typed commit (e.g. fix(release): …) before opening the train PR" >&2
printf '%s\n' "$SUBJECTS" | sed 's/^/  /' >&2
exit 1
