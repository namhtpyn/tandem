#!/usr/bin/env bash
# Release-train preflight: semantic-release skips the tag SILENTLY when the
# train range carries no releasable-typed subject (a train of test:/docs:/spec:
# subjects + merge commits ships nothing — merge-commit bodies carrying PR
# titles are ignored; the commit-analyzer reads the header line only).
# Run BEFORE opening the dev→main train PR; pair the train with a fix-typed
# commit when this fails. Exit 0 = releasable subject present; 1 = none
# (fail closed); 2 = cannot fetch/read the range. TEST mode
# (TANDEM_TRAIN_TEST=1) retargets repo/refs and skips the origin guard so the
# check can be rehearsed against any local clone and any commit range.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_REF="refs/remotes/origin/main"
HEAD_REF="refs/remotes/origin/dev"
TESTMODE=0
if [ "${TANDEM_TRAIN_TEST:-0}" = "1" ]; then
  REPO="${TANDEM_TRAIN_REPO:-$REPO}"
  BASE_REF="${TANDEM_TRAIN_BASE:-$BASE_REF}"
  HEAD_REF="${TANDEM_TRAIN_HEAD:-$HEAD_REF}"
  TESTMODE=1
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
# Conventional header only (%s): the analyzer never sees merge-commit bodies.
SUBJECTS=$(git -C "$REPO" log --format=%s "$BASE_REF..$HEAD_REF" 2>/dev/null)
if [ -z "$SUBJECTS" ] && [ "$(git -C "$REPO" rev-parse "$BASE_REF" 2>/dev/null)" = "$(git -C "$REPO" rev-parse "$HEAD_REF" 2>/dev/null)" ]; then
  echo "train-preflight: main..dev is empty — nothing to train"
  exit 2
fi
RELEASABLE=$(printf '%s\n' "$SUBJECTS" | grep -E '^(fix|feat|perf|revert)(\([[:print:]]+\))?!?: ' || true)
if [ -n "$RELEASABLE" ]; then
  printf '%s\n' "$RELEASABLE"
  exit 0
fi
echo "train-preflight: FAIL — main..dev has NO releasable subject; the train would skip the tag silently" >&2
echo "train-preflight: pair with a fix-typed commit (e.g. fix(release): …) before opening the train PR" >&2
printf '%s\n' "$SUBJECTS" | sed 's/^/  /' >&2
exit 1
