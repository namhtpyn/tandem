#!/usr/bin/env bash
# Release-train preflight: semantic-release skips the tag SILENTLY when the
# train range carries no releasable-typed subject. Run BEFORE opening the
# dev→main train PR; pair the train with a fix-typed commit when this fails.
# Releasable set mirrors the repo's .releaserc.json analyzer on SUBJECTS ONLY
# (merge-commit bodies carrying PR titles are never read by the analyzer):
#   - fix|feat|perf|revert (lowercase default rules)
#   - FIX|FEAT (JSHint defaults the analyzer falls back to)
#   - any conventional type with a breaking header `!:` (major)
#   - canonical `Revert "…"` headers
#   - scope charset is the analyzer's ASCII class [A-Za-z0-9_$@.+\-*/ ], empty
#     allowed — NOT [[:print:]], which is locale-dependent and would false-green
#     non-ASCII scopes the parser rejects.
#   NOT detectable by a subject scan: a BREAKING CHANGE footer on a
#   non-breaking subject (releases major; fail-closed rc=1 here — acceptable).
# Exit 0 = releasable subject present (printed); 1 = none, fail-closed;
# 2 = cannot fetch/verify/read the range or the range is empty (nothing to
# train — including the post-train state where main already contains dev).
# TANDEM_TRAIN_REPO retargets the repo in every mode (house style, sibling
# parity); TEST mode (TANDEM_TRAIN_TEST=1) additionally retargets refs
# (TANDEM_TRAIN_BASE/HEAD), skips the origin guard, and prints a TEST-MODE
# marker on stderr so a rehearsed result is never mistaken for a production
# clean.
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
if [ -z "$SUBJECTS" ]; then
  echo "train-preflight: $BASE_REF..$HEAD_REF is empty — nothing to train"
  exit 2
fi
# Mirrors the analyzer's releasable headers (see header comment). grep -E:
RELEASABLE=$(printf '%s\n' "$SUBJECTS" | grep -E '^(fix|feat|perf|revert|FIX|FEAT)(\([A-Za-z0-9_$@.+*/ -]*\))?!?: |^[A-Za-z0-9_]+(\([A-Za-z0-9_$@.+*/ -]*\))?!: |^Revert "' || true)
if [ -n "$RELEASABLE" ]; then
  printf '%s\n' "$RELEASABLE"
  exit 0
fi
echo "train-preflight: FAIL — $BASE_REF..$HEAD_REF has NO releasable subject; the train would skip the tag silently" >&2
echo "train-preflight: pair with a fix-typed commit (e.g. fix(release): …) before opening the train PR" >&2
printf '%s\n' "$SUBJECTS" | sed 's/^/  /' >&2
exit 1
