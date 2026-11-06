#!/usr/bin/env bash
# Probe drift check: the live profile copy must be a deploy of the repo-versioned
# file. Fetches origin/<branch> first so a stale local ref cannot green-light drift.
# Exit 0 = identical; 1 = drift (diff printed); 2 = cannot fetch/read either side.
# Run by the critic every pass (SPEC "Probe versioning").
set -u
PROFILE_DIR="${TANDEM_PROFILE_DIR:-/root/.hermes/profiles/nampa}"
BRANCH="${TANDEM_PROBE_BRANCH:-dev}"
if [ "${TANDEM_PROBE_TEST:-0}" = "1" ]; then
  LIVE="${TANDEM_PROBE_LIVE:-$PROFILE_DIR/scripts/tandem-prod-probe.sh}"
  REPO="${TANDEM_PROBE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  REF="${TANDEM_PROBE_REF:-origin/$BRANCH}"
else
  LIVE="$PROFILE_DIR/scripts/tandem-prod-probe.sh"
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  REF="origin/$BRANCH"
fi
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
case "$REF" in
  origin/*)
    if ! git -C "$REPO" fetch origin "$BRANCH" -q 2>/dev/null; then
      echo "probe-drift: cannot fetch origin $BRANCH from $REPO" >&2
      exit 2
    fi
    ;;
esac
if ! git -C "$REPO" show "$REF:scripts/tandem-prod-probe.sh" > "$TMP" 2>/dev/null; then
  echo "probe-drift: cannot read $REF:scripts/tandem-prod-probe.sh from $REPO" >&2
  exit 2
fi
if [ ! -f "$LIVE" ]; then
  echo "probe-drift: live probe missing at $LIVE" >&2
  exit 2
fi
if ! diff -u "$TMP" "$LIVE"; then
  echo "probe-drift: live copy differs from $REF — deploy: cp $REPO/scripts/tandem-prod-probe.sh $LIVE" >&2
  exit 1
fi
exit 0
