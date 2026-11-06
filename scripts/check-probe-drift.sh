#!/usr/bin/env bash
# Probe drift check: the live profile copy must be a deploy of the repo-versioned
# file. Exit 0 = identical; 1 = drift (diff printed); 2 = cannot read either side.
# Run by the critic every pass (SPEC "Probe versioning").
set -u
LIVE="${TANDEM_PROBE_LIVE:-/root/.hermes/profiles/nampa/scripts/tandem-prod-probe.sh}"
REF="${TANDEM_PROBE_REF:-origin/dev}"
REPO="${TANDEM_PROBE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
if ! git -C "$REPO" show "$REF:scripts/tandem-prod-probe.sh" > "$TMP" 2>/dev/null; then
  echo "probe-drift: cannot read $REF:scripts/tandem-prod-probe.sh from $REPO" >&2
  exit 2
fi
if [ ! -f "$LIVE" ]; then
  echo "probe-drift: live probe missing at $LIVE" >&2
  exit 2
fi
if ! diff -u "$TMP" "$LIVE"; then
  echo "probe-drift: live copy differs from $REF — deploy: cp scripts/tandem-prod-probe.sh $LIVE" >&2
  exit 1
fi
exit 0
