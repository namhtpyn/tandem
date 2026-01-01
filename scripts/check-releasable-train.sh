#!/usr/bin/env bash
# Release-train preflight: semantic-release skips the tag SILENTLY when the
# train range releases NOTHING. Run BEFORE opening the dev→main train PR; pair
# the train with a fix-typed commit when this fails.
#
# Mirrors @semantic-release/commit-analyzer v13 (analyzer v13.0.1, oracle-
# verified against the real analyzeCommits with this repo's parserOpts):
#   - the analyzer's final analyzed SET is order-independent: every commit
#     except canceled revert-pairs and empty-message commits is analyzed.
#   - cancel: a REVERTISH commit (raw matches default revertPattern:
#     ^(?:Revert|revert:)\s…\sThis reverts commit <hash>) cancels the commit
#     whose trimmed header line == the revert's quoted subject AND whose
#     FULL hash == the cited hash string EXACTLY (abbreviated hashes never
#     cancel). Pair members drop out of the analyzed set entirely.
#   - releasable subjects (per analyzed commit):
#       fix|feat|perf|revert (lowercase), FIX|FEAT (JSHint defaults),
#       any conventional type with breaking header `!:` — breaking scope
#       class EXCLUDES `+` (`type(a+b)!:` parses as a plain non-breaking
#       type: releasable only for fix|feat|perf|revert|FIX|FEAT),
#       empty type/scope allowed (`!: x` and `fix(): x` release).
#       any REVERTISH commit releases patch via the default
#       {type: revert, release: patch} rule (commit.revert truthy) —
#       regardless of its header shape.
#       `Revert "…"` WITHOUT a trailer releases nothing (revertPattern
#       needs the trailer; headerPattern rejects the quoted form).
#   - commits whose whole message is whitespace are dropped by the analyzer.
#   - subjects are the FIRST LINE of %B: %s strips trailing whitespace, and
#     "fix: " (with space, empty subject) DOES release patch.
#   NOT detectable by a subject scan: a BREAKING CHANGE footer on a
#   non-breaking subject (releases major; fail-closed rc=1 — acceptable).
#   Locale: every grep runs under LC_ALL=C — glibc UTF-8 collation matches
#   non-ASCII inside [A-Za-z] ranges (the false-green direction).
# Exit 0 = something releases (subjects printed to stdout); 1 = nothing
# releases, fail-closed; 2 = cannot fetch/verify/read the range, ref is not a
# commit object, or the range has ZERO commits (nothing to train — including
# post-train where main already contains dev). A non-empty range whose
# commits merely lack subjects is rc=1. stdout is the rc=0 data channel only;
# every diagnostic goes to stderr. TANDEM_TRAIN_REPO retargets the repo in
# every mode (sibling parity); TEST mode (TANDEM_TRAIN_TEST=1) retargets refs
# (TANDEM_TRAIN_BASE/HEAD), skips the origin guard, and prints a TEST-MODE
# marker on stderr so a rehearsal is never mistaken for a production clean.
set -u
export LC_ALL=C # byte-exact string ops + ASCII [[:space:]]/[[:alnum:]] + the greps below
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
for R in "$BASE_REF" "$HEAD_REF"; do
  if ! git -C "$REPO" rev-parse --verify --quiet "$R" >/dev/null 2>&1; then
    echo "train-preflight: cannot resolve ref $R in $REPO" >&2
    exit 2
  fi
  if [ "$(git -C "$REPO" cat-file -t "$R" 2>/dev/null)" != "commit" ]; then
    echo "train-preflight: ref $R is not a commit object in $REPO" >&2
    exit 2
  fi
done
SUBJECTS=$(git -C "$REPO" log --format=%s "$BASE_REF..$HEAD_REF") || {
  echo "train-preflight: cannot read range $BASE_REF..$HEAD_REF in $REPO" >&2
  exit 2
}
COUNT=$(git -C "$REPO" rev-list --count "$BASE_REF..$HEAD_REF") || {
  echo "train-preflight: cannot count range $BASE_REF..$HEAD_REF in $REPO" >&2
  exit 2
}
if [ "$COUNT" -eq 0 ]; then
  echo "train-preflight: $BASE_REF..$HEAD_REF is empty — nothing to train" >&2
  exit 2
fi
# Pass 1 — collect per-commit: sha, trimmed first line of %B, revertish flag,
# cited (header,hash) for revertish commits. NUL-delimited records MUST go
# through process substitution: $( ) strips NUL bytes and would collapse the
# delimiter-less read.
declare -A SHA2IDX=() # sha -> index (cited-hash lookup)
declare -a SUBJ_OF=() REVT_OF=() HDR_OF=() CITED_OF=() CANCELED=()
n=0
while IFS= read -r -d '' rec || [ -n "$rec" ]; do
  sha=${rec%%$'\x01'*}
  raw=${rec#*$'\x01'}
  # analyzer drops commits whose whole message is whitespace-only
  [ -z "$(printf '%s' "$raw" | tr -d '[:space:]')" ] && continue
  subj=$(printf '%s' "$raw" | head -1)
  subj="${subj#"${subj%%[![:space:]]*}"}"
  subj="${subj%"${subj##*[![:space:]]}"}"
  SHA2IDX["$sha"]=$n
  REVT_OF[$n]=0
  # revertish: the ANGULAR preset's effective revertPattern
  # /^(?:Revert|revert:)\s"?([\s\S]+?)"?\s*This reverts commit (\w{7,40})\b/i
  # (the repo's parserOpts override header patterns but NOT revertPattern —
  # load-parser-config merges {...angular.parser, ...parserOpts}):
  #   prefix 'revert:'/'revert' CASE-INSENSITIVE + ONE JS-\s char (NBSP and
  #   the unicode width family included); group1 is ONE-OR-MORE lazy chars —
  #   the chosen occurrence is the FIRST 'This reverts commit ' phrase at
  #   least 1 char after the opening optional-quote whose following token is
  #   7-40 ASCII word chars ([A-Za-z0-9_], JS \w — no $) with a word boundary
  #   after (a >40-char run NEVER binds: every k<=40 ends inside the run);
  #   cited hash = that token; quoted header text = the span, minus ONE
  #   trailing quote + trailing whitespace, trimmed (isMatch trims both
  #   sides). No valid occurrence => NOT revertish (a lone 6-char cite or a
  #   unicode-digit token never matches the pattern).
  rest="$raw"
  pfx=$(printf '%s' "${raw:0:8}" | tr 'A-Z' 'a-z')
  case "$pfx" in
    revert:*) off=7 ;;
    revert*) off=6 ;;
    *) off=0 ;;
  esac
  REVT_OF[$n]=0
  if [ "$off" -gt 0 ]; then
    tail="${raw:$off}"
    sep=0
    case "$tail" in
      [[:space:]]*) sep=1 ;;
      $'\xc2\xa0'* | $'\xe2\x80\x80'* | $'\xe2\x80\x81'* | $'\xe2\x80\x82'* | $'\xe2\x80\x83'* | $'\xe2\x80\x84'* | $'\xe2\x80\x85'* | $'\xe2\x80\x86'* | $'\xe2\x80\x87'* | $'\xe2\x80\x88'* | $'\xe2\x80\x89'* | $'\xe2\x80\x8a'* | $'\xe2\x80\xa8'* | $'\xe2\x80\xa9'* | $'\xe2\x80\xaf'* | $'\xe2\x81\x9f'* | $'\xe3\x80\x80'* | $'\xef\xbb\xbf'*) sep=1 ;;
    esac
    if [ "$sep" = "1" ]; then
      # span start: skip the ONE JS-\s char, then the greedy leading "? eats
      # ONE quote if present; group1 runs from there (>=1 char)
      rest="${tail:1}"
      rest="${rest#\"}" # greedy leading "? eats ONE quote if present (no-op otherwise)
      # occurrence offsets (bytes = chars under LC_ALL=C), left to right
      tpf=$(mktemp "${TMPDIR:-/tmp}/tpf.XXXXXX")
      printf '%s' "$rest" | grep -abo 'This reverts commit ' > "$tpf" 2>/dev/null || true
      while IFS=: read -r o _; do
        [ -n "$o" ] || continue
        [ "$o" -ge 1 ] || continue # group1 >= 1 char
        t="${rest:$((o + 20))}"
        run=$(printf '%s' "$t" | grep -o '^[A-Za-z0-9_]*' | head -1)
        l=${#run}
        if [ "$l" -ge 7 ] && [ "$l" -le 40 ]; then
          REVT_OF[$n]=1
          hdr="${rest:0:$o}"
          hdr="${hdr%"${hdr##*[![:space:]]}"}"
          hdr="${hdr%\"}"
          hdr="${hdr%"${hdr%%[![:space:]]*}"}"
          hdr="${hdr%"${hdr##*[![:space:]]}"}"
          HDR_OF[$n]="$hdr"
          CITED_OF[$n]="$run"
          break
        fi
      done < "$tpf"
      rm -f "$tpf"
    fi
  fi
  SUBJ_OF[$n]="$subj"
  n=$((n + 1))
done < <(git -C "$REPO" log --format='%x00%H%x01%B' "$BASE_REF..$HEAD_REF")
# Pass 2 — revert-pair cancellation: a revertish commit whose cited
# (header, EXACT hash) matches a range commit drops BOTH from the set.
PAIRS=0
for ((j = 0; j < n; j++)); do
  [ "${REVT_OF[$j]}" = "1" ] || continue
  t="${CITED_OF[$j]}"
  [ -n "$t" ] || continue
  ti="${SHA2IDX[$t]:-}"
  if [ -n "$ti" ] && [ "${SUBJ_OF[$ti]}" = "${HDR_OF[$j]}" ] && [ "${CANCELED[$j]:-0}" = "0" ] && [ "${CANCELED[$ti]:-0}" = "0" ]; then
    CANCELED[$j]=1
    CANCELED[$ti]=1
    PAIRS=$((PAIRS + 1))
  fi
done
# Pass 3 — releasable verdict over the analyzed set (non-canceled commits)
CAND=""
for ((j = 0; j < n; j++)); do
  [ "${CANCELED[$j]:-0}" = "1" ] && continue
  CAND+="${SUBJ_OF[$j]}"$'\n'
done
RELEASABLE=$(printf '%s' "$CAND" | LC_ALL=C grep -E '^(fix|feat|perf|revert|FIX|FEAT)(\([A-Za-z0-9_$@.+*/ -]*\))?!?: |^[A-Za-z0-9_]*(\([A-Za-z0-9_$@.*/ -]*\))?!: ' || true)
REVERT_PATCH=""
for ((j = 0; j < n; j++)); do
  [ "${REVT_OF[$j]}" = "1" ] || continue
  [ "${CANCELED[$j]:-0}" = "1" ] && continue
  REVERT_PATCH+="${SUBJ_OF[$j]}"$'\n'
done
if [ -n "$RELEASABLE" ]; then
  printf '%s\n' "$RELEASABLE" | sed '/^$/d'
  exit 0
fi
if [ -n "$REVERT_PATCH" ]; then
  printf '%s' "$REVERT_PATCH"
  exit 0
fi
echo "train-preflight: FAIL — $BASE_REF..$HEAD_REF releases NOTHING ($COUNT commits, $PAIRS revert-pairs canceled); the train would skip the tag silently" >&2
echo "train-preflight: pair with a fix-typed commit (e.g. fix(release): …) before opening the train PR" >&2
printf '%s\n' "$SUBJECTS" | sed 's/^/  /' >&2
exit 1
