#!/usr/bin/env bash
# Probe drift check: the live profile copy must be a deploy of the repo-versioned
# file. Fetches the branch with an EXPLICIT refspec first (this clone's default
# refspec is limited, so a plain fetch can leave origin/dev stale → false green).
# Exit 0 = identical; 1 = drift (diff printed); 2 = cannot fetch/read either side.
# Test mode (TANDEM_PROBE_TEST=1) retargets the live path and exits 3 on identity,
# so a leaked TEST flag can never look like a clean production check.
set -u
PROFILE_DIR="${TANDEM_PROFILE_DIR:-/root/.hermes/profiles/nampa}"
LIVE="$PROFILE_DIR/scripts/tandem-prod-probe.sh"
REPO="${TANDEM_PROBE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REF="refs/remotes/origin/dev"
TESTMODE=0
if [ "${TANDEM_PROBE_TEST:-0}" = "1" ]; then
  LIVE="${TANDEM_PROBE_LIVE:-$LIVE}"
  TESTMODE=1
fi
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
if ! git -C "$REPO" fetch origin "+refs/heads/dev:refs/remotes/origin/dev" -q 2>/dev/null; then
  echo "probe-drift: cannot fetch origin dev from $REPO" >&2
  exit 2
fi
if ! git -C "$REPO" show "$REF:scripts/tandem-prod-probe.sh" > "$TMP" 2>/dev/null; then
  echo "probe-drift: cannot read $REF:scripts/tandem-prod-probe.sh from $REPO" >&2
  exit 2
fi
if [ ! -f "$LIVE" ]; then
  echo "probe-drift: live probe missing at $LIVE" >&2
  exit 2
fi
if ! diff -u "$TMP" "$LIVE"; then
  echo "probe-drift: live copy differs from $REF — deploy: git -C $REPO show $REF:scripts/tandem-prod-probe.sh > $LIVE" >&2
  exit 1
fi
if [ "$TESTMODE" = "1" ]; then
  echo "probe-drift: TEST-MODE identical (not a production clean result)"
  exit 3
fi
exit 0
