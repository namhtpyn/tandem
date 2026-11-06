#!/usr/bin/env bash
# Probe drift check: the live profile copy must be a deploy of the repo-versioned
# file. Fetches the branch with an EXPLICIT refspec first (this clone's default
# refspec is limited, so a plain fetch can leave origin/dev stale → false green).
# Exit 0 = identical; 1 = drift (diff printed); 2 = cannot fetch/read either side.
# The live path is a production constant; only TEST mode (TANDEM_PROBE_TEST=1)
# may retarget it, and test-mode identity exits 3 — never 0.
set -u
LIVE="/root/.hermes/profiles/nampa/scripts/tandem-prod-probe.sh"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="refs/remotes/origin/dev"
TESTMODE=0
if [ "${TANDEM_PROBE_TEST:-0}" = "1" ]; then
  LIVE="${TANDEM_PROBE_LIVE:-$LIVE}"
  REPO="${TANDEM_PROBE_REPO:-$REPO}"
  TESTMODE=1
elif [ -n "${TANDEM_PROBE_REPO:-}" ]; then
  REPO="$TANDEM_PROBE_REPO"
fi
if [ "$TESTMODE" = "0" ]; then
  URL=$(git -C "$REPO" remote get-url origin 2>/dev/null)
  case "$URL" in
    *namhtpyn/tandem*) ;;
    *)
      echo "probe-drift: origin is not namhtpyn/tandem ($URL)" >&2
      exit 2
      ;;
  esac
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
