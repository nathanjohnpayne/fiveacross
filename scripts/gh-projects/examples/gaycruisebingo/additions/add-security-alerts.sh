#!/usr/bin/env bash
# scripts/gh-projects/examples/gaycruisebingo/additions/add-security-alerts.sh
#
# Additions driver (kit convention: add children to an EXISTING parent without
# recreating the tree). Files the two CodeQL security-fix tickets as native
# sub-issues of the Moderation epic and adds them to Project #7. Field/Status
# assignment is done by the companion set-fields.sh (its FIELDS table carries the
# two new slugs); run it after this with GCB_MAP pointed at the map written here.
#
# Idempotent by title (safe to re-run). macOS bash 3.2 compatible.
#
# Usage:
#   eval "$(scripts/op-preflight.sh --agent claude --mode all)"
#   export GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT"
#   GCB_MAP=/tmp/sec.map bash scripts/gh-projects/examples/gaycruisebingo/additions/add-security-alerts.sh
set -euo pipefail

export REPO="nathanjohnpayne/fiveacross" OWNER="nathanjohnpayne" PROJECT=7
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BODIES="$SCRIPT_DIR/../bodies"
MAP="${GCB_MAP:-$(mktemp -d)/sec.map}"; : > "$MAP"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../../lib.sh"   # enforces GH_TOKEN=nathanjohnpayne; provides create_child + ghp_gh

# Resolve the Moderation epic (parent) by exact title so we never guess a number.
PARENT_TITLE="Epic: Moderation, analytics & scaffold reconciliation"
ghp_gh issue list --repo "$REPO" --state all --limit 500 --json number,title > "$MAP.existing.json"
find_num(){ python3 -c "import json,sys;d=json.load(open(sys.argv[2]));print(next((str(i['number']) for i in d if i['title']==sys.argv[1]),''))" "$1" "$MAP.existing.json"; }
PARENT="$(find_num "$PARENT_TITLE")"
[ -n "$PARENT" ] || { echo "!! parent epic not found by title — aborting"; exit 1; }
echo "parent epic-moderation = #$PARENT"

LBL="agent-action,track:security,phase-0,wave-0,size:S,needs-phase-4"
add_child(){ # slug title
  local slug="$1" title="$2" ex url num
  ex="$(find_num "$title")"
  if [ -n "$ex" ]; then echo "= reuse #$ex  $slug"; echo "$slug=$ex" >> "$MAP"; return; fi
  [ -f "$BODIES/$slug.md" ] || { echo "!! missing body: bodies/$slug.md"; exit 1; }
  read -r url num _ <<<"$(create_child "$title" "$BODIES/$slug.md" "$LBL" "$PARENT")"
  echo "+ #$num  $slug  (sub-issue of #$PARENT)"; echo "$slug=$num" >> "$MAP"
}

add_child "sec-xss-proofsheet"          "Security: fix DOM XSS in the Proof sheet (CodeQL js/xss-through-dom)"
add_child "sec-clear-text-logging-seed" "Security: stop clear-text logging of ADMIN_UID in the seed script (CodeQL js/clear-text-logging)"
add_child "sec-xss-proofsheet-2"        "Security: fix the second DOM XSS in the Proof sheet (CodeQL js/xss-through-dom #3)"

echo "== done. slug→num map: $MAP =="
cat "$MAP"
