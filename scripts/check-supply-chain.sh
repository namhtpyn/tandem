#!/usr/bin/env bash
# Supply-chain gate — contract: SPEC.md "Deployment" / supply-chain contract.
# Fails on any of:
#   1. a `uses:` action ref that is not a full 40-hex commit SHA
#      (tags/branches float; local `./path` actions and
#      `docker://image@sha256:...` refs are the allowed exceptions)
#   2. a workflow file without an explicit top-level `permissions:` block
#      (least privilege must be declared, never defaulted)
#   3. a Dockerfile `FROM` base not pinned `@sha256:<64-hex>` (tag alone floats)
# Green is silent: exit 0, no output. Findings print one FAIL line each
# (CI auto-files them as a `[supply-chain]` issue on main pushes).
set -u

wf_dir="${SUPPLY_CHAIN_DIR:-.github/workflows}"
dockerfile="${SUPPLY_CHAIN_DOCKERFILE:-Dockerfile}"
rc=0
fail() { printf 'FAIL: %s\n' "$1"; rc=1; }

# --- 1. action refs pinned by full commit SHA -------------------------------
if [ ! -d "$wf_dir" ]; then
  fail "workflow dir '$wf_dir' missing (fail closed)"
else
  # find uses: lines; strip the allowed forms; whatever survives is a finding
  viol=$(grep -rEn '^[[:space:]]*(-[[:space:]]+)?uses:' "$wf_dir" --include='*.y*ml' 2>/dev/null \
    | grep -vE 'uses:[[:space:]]*["'"'"']?(\./|\.\./)' \
    | grep -vE '@[0-9a-fA-F]{40}([[:space:]]*$|[[:space:]]+#|[[:space:]]*["'"'"'])' \
    | grep -vE 'docker://[^[:space:]]+@sha256:[0-9a-f]{64}')
  while IFS= read -r v; do
    [ -n "$v" ] && fail "$v (action ref must be a full 40-hex commit SHA; tags/branches float)"
  done <<< "$viol"
fi

# --- 2. explicit permissions block per workflow file ------------------------
shopt -s nullglob
for f in "$wf_dir"/*.yml "$wf_dir"/*.yaml; do
  grep -qE '^permissions:' "$f" || fail "$f: no top-level 'permissions:' block (least privilege must be explicit)"
done
shopt -u nullglob

# --- 3. Dockerfile FROM bases pinned by digest ------------------------------
if [ ! -f "$dockerfile" ]; then
  fail "dockerfile '$dockerfile' missing (fail closed)"
else
  while IFS= read -r row; do
    lineno=${row%%:*}
    body=${row#*:}
    case $body in
      *'FROM scratch'*|*'FROM scratch '*) continue ;;
    esac
    case $body in
      *@sha256:*) ;;
      *) fail "$dockerfile:$lineno: $body (FROM base must be pinned tag@sha256:<digest>; tags float)" ;;
    esac
  done < <(grep -nE '^[[:space:]]*FROM[[:space:]]' "$dockerfile")
fi

exit "$rc"
