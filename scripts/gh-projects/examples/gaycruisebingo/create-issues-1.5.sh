#!/usr/bin/env bash
# scripts/gh-projects/examples/gaycruisebingo/create-issues-1.5.sh
#
# Fresh-create driver for the Gay Cruise Bingo **Phase 1.5 — Daily Cards** backlog
# (repo nathanjohnpayne/fiveacross). Creates the epic parent + child tickets
# from the templated body files in ./bodies-1.5/, applies labels, and links
# children as native sub-issues of the epic.
#
# REPO-SCOPE ONLY: this driver deliberately does NOT add issues to Project #7 or
# set any project field — that half lives in the companion board-fields-1.5.sh,
# which needs a `project`-scoped nathanjohnpayne token. The split exists because
# the nathanjohnpayne PAT currently carries repo scope but not project scope; issue
# creation works today, board wiring waits for the scope grant. Once the token has
# `project`, run board-fields-1.5.sh with the same GCB_MAP to add + field every item.
#
# Idempotent: an issue whose exact title already exists is reused, not duplicated
# (a partial/pilot run can be re-run safely). Cross-issue refs in the bodies use
# `#__NUM_<slug>__` tokens; this driver substitutes them in two passes (create with
# the map-so-far, then re-render every body with the full map and `gh issue edit`).
#
# macOS bash 3.2 compatible: no associative arrays — the slug→number map is a flat
# `slug=num` file (GCB_MAP), matching lib.sh / move-item.sh conventions.
#
# Usage:
#   eval "$(scripts/op-preflight.sh --agent claude --mode review)"
#   export GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT"
#   # pilot the epic + one child (space-separated slugs), then the rest (skips existing):
#   GCB_MAP=/tmp/gcb-15.map bash scripts/gh-projects/examples/gaycruisebingo/create-issues-1.5.sh d15-epic d15-schema-contract
#   GCB_MAP=/tmp/gcb-15.map bash scripts/gh-projects/examples/gaycruisebingo/create-issues-1.5.sh
#
# The slug→num map is written to $GCB_MAP (default: a fresh mktemp path echoed at the
# end). Pass a stable GCB_MAP so board-fields-1.5.sh can consume the same mapping.

set -euo pipefail

export REPO="nathanjohnpayne/fiveacross"
export OWNER="nathanjohnpayne"
export PROJECT=7   # referenced only by the sourced lib.sh guards; no project writes happen here.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BODIES="$SCRIPT_DIR/bodies-1.5"
WORKDIR="${GCB_WORKDIR:-$(mktemp -d)}"
MAP="${GCB_MAP:-$WORKDIR/slug-num-1.5.map}"
mkdir -p "$WORKDIR"
[ -f "$MAP" ] || : > "$MAP"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../lib.sh"   # enforces GH_TOKEN=nathanjohnpayne; provides ghp_gh + link_sub_issue + ensure_label

# ---- ensure the Phase 1.5 labels exist (idempotent; reuses existing colors) --
ensure_label "phase-1.5" "bfd4f2" "Phase 1.5 — Daily Cards redesign" || true
for t in rules scheduler dealing day-ui more-menu tutorial-content approvals scoring icons docs; do
  ensure_label "track:$t" "1d76db" "Track: $t" || true
done

# ---- ticket table: slug|title|parent-slug (or -)|labels-csv -----------------
# Topological order: epic first, then children by wave. Fine track:* labels here;
# the coarser project Track *field* option is set by board-fields-1.5.sh.
read -r -d '' TABLE <<'TSV' || true
d15-epic|Epic: Phase 1.5 — Daily Cards (one themed board per cruise day)|-|epic,phase-1.5,track:day-ui
d15-schema-contract|Phase 1.5 schema & type contract (DayDef, days[], pools, snapshots, dayIndex, +2 ThemeIds)|d15-epic|agent-action,track:schema,phase-1.5,wave-0,size:L
d15-firestore-rules|Phase 1.5 Firestore rules: day-scoped boards + unlock gating + pending-item visibility + day-meta firstBingo|d15-epic|agent-action,track:rules,phase-1.5,wave-0,size:L,needs-phase-4
d15-scheduler-unlock|Phase 1.5 scheduler: unlockDay snapshot function (08:00 Europe/Rome) + finale beats + manual-unlock fallback|d15-epic|agent-action,track:scheduler,phase-1.5,wave-0,size:L,needs-phase-4
d15-tab-contract|Phase 1.5 tab-contract revision: Card · Feed · Ranks · More; Nav drops avatar + sign-out|d15-epic|agent-action,track:foundation,phase-1.5,wave-0,size:M
d15-dealing|Per-day dealing from the Day Snapshot: no-repeat-across-cruise + 10/14 stratification + snapshot-gated|d15-epic|agent-action,track:dealing,phase-1.5,wave-1,size:L
d15-day-switcher|Day switcher strip + locked-day preview + two-line header + per-day free space + viewed-day retint|d15-epic|agent-action,track:day-ui,phase-1.5,wave-1,size:L
d15-two-themes|Two new Themes (welcome-aboard, so-long-farewell) + ThemeMeta description for all 10|d15-epic|agent-action,track:themes,phase-1.5,wave-1,size:M
d15-tutorial-seed|Seed embark + farewell curated pools (28 + 28, verbatim) + pool field + per-day free-space overrides|d15-epic|agent-action,track:tutorial-content,phase-1.5,wave-1,size:M
d15-more-menu|More menu (⋯/avatar tab): profile, theme + Auto-match, schedule, suggest, how-to-play, install, bug, 18+, admin, sign out, version|d15-epic|agent-action,track:more-menu,phase-1.5,wave-1,size:L
d15-docs-glossary|CONTEXT.md glossary additions (Day, Day Card, Tutorial Day, Pool, Pending, Day Snapshot, Tally Card)|d15-epic|agent-action,track:docs,phase-1.5,wave-1,size:S
d15-approvals|Item approval flow: submissions → pending; Admin approvals queue (approve/reject, bulk); grandfathering; snapshot pickup|d15-epic|agent-action,track:approvals,phase-1.5,wave-2,size:L,needs-phase-4
d15-claim-sheet-photo|Claim sheet #190: two-affordance photo + source stamp + 🖼️ badge + camera_only override + EXIF strip + heat line + dayIndex|d15-epic|agent-action,track:proof,phase-1.5,wave-2,size:L
d15-scoring-aggregates|Cruise-wide scoring across Day Cards + per-day First to BINGO + honors strip; tutorial-day rules|d15-epic|agent-action,track:scoring,phase-1.5,wave-2,size:L,needs-phase-4
d15-tutorial-banners|Embark "How this works" banner + farewell goodbye banner + warm-up tags|d15-epic|agent-action,track:tutorial-content,phase-1.5,wave-2,size:M
d15-coach-overlay|First-open coach overlay (badge legend) — per-event localStorage, replayable|d15-epic|agent-action,track:tutorial-content,phase-1.5,wave-3,size:M
d15-text-size|Text size S/M/L segmented control + auto-fit guard wins|d15-epic|agent-action,track:more-menu,phase-1.5,wave-3,size:M
d15-tally-cards|Tally Cards in the Feed: merged Proofs+Moments+Tally stream, bump debounce, +Proof / 🙋 Got-it-too|d15-epic|agent-action,track:tally,phase-1.5,wave-3,size:L
d15-finale|Two-beat finale: last-call Moment (20:00 D9) + freeze + podium banner/Moment (08:00 D10)|d15-epic|agent-action,track:scoring,phase-1.5,wave-3,size:M,needs-phase-4
d15-proof-chips-ranks|Optional latest-proof media chips (📷 🎙 ✍️ 🖼️) on Leaderboard rows, tap-through to Feed|d15-epic|agent-action,track:scoring,phase-1.5,wave-3,size:S
d15-pwa-toasts|PWA presentation: install nudge after-first-mark + copy; update banner copy + defer-while-sheet-open; toast stacking|d15-epic|agent-action,track:pwa,phase-1.5,wave-3,size:M
d15-icons-lucide|Iconography: lucide-react for chrome/controls, emoji for camp (spec mapping table)|d15-epic|agent-action,track:icons,phase-1.5,wave-3,size:M
d15-admin-schedule|Admin Schedule editor: ten Days as rows, theme dropdown, locked once unlocked|d15-epic|agent-action,track:approvals,phase-1.5,wave-3,size:M,needs-phase-4
d15-admin-proof-claims|Admin "Proof & Claims" panel: claim mode, photo source, EXIF strip, visionGate, report threshold, pending claims|d15-epic|agent-action,track:proof,phase-1.5,wave-3,size:M
TSV

# ---- slug→num map helpers (flat file; bash 3.2 safe) ------------------------
map_get(){ awk -F= -v s="$1" '$1==s{v=$2} END{if(v!="")print v}' "$MAP" 2>/dev/null; }
map_set(){ echo "$1=$2" >> "$MAP"; }

# ---- optional slug filter (pilot mode) --------------------------------------
FILTER=0; WANTLIST=""
if [ "$#" -gt 0 ]; then FILTER=1; WANTLIST=" $* "; fi
wanted(){ [ "$FILTER" -eq 0 ] && return 0; case "$WANTLIST" in *" $1 "*) return 0;; esac; return 1; }

# ---- existing issues (idempotency) ------------------------------------------
ghp_gh issue list --repo "$REPO" --state all --limit 800 --json number,title > "$WORKDIR/existing.json"
num_by_title(){ python3 -c "import json,sys;d=json.load(open(sys.argv[2]));print(next((str(i['number']) for i in d if i['title']==sys.argv[1]),''))" "$1" "$WORKDIR/existing.json"; }

render(){ # slug -> path to token-substituted body (uses current MAP)
  local slug="$1" dst="$WORKDIR/$1.body.md" s n
  cp "$BODIES/$slug.md" "$dst"
  while IFS='=' read -r s n; do
    [ -z "$s" ] && continue
    sed -i '' "s|#__NUM_${s}__|#${n}|g; s|__NUM_${s}__|${n}|g" "$dst"
  done < "$MAP"
  echo "$dst"
}

# ---- no-project create helpers (repo scope only) ----------------------------
create_parent_np() { # title body_file labels -> echoes issue number
  local url; url=$(ghp_gh issue create --repo "$REPO" --title "$1" --body-file "$2" --label "$3" | tail -1)
  echo "${url##*/}"
}
create_child_np() { # title body_file labels parent_num -> echoes "num id"
  local url num id
  url=$(ghp_gh issue create --repo "$REPO" --title "$1" --body-file "$2" --label "$3" | tail -1)
  num="${url##*/}"
  id=$(ghp_gh api "repos/$REPO/issues/$num" --jq .id)
  link_sub_issue "$4" "$id" || echo "  !! sub-issue link failed for #$num → parent #$4 (continuing)"
  echo "$num $id"
}

# ---- Pass A: create (or reuse) each issue -----------------------------------
echo "== Pass A: create/reuse (repo scope; NO project writes) =="
while IFS='|' read -r slug title parent labels; do
  [ -z "$slug" ] && continue
  wanted "$slug" || continue
  [ -f "$BODIES/$slug.md" ] || { echo "  !! missing body: bodies-1.5/$slug.md — skipping"; continue; }
  if [ -n "$(map_get "$slug")" ]; then echo "  = have  #$(map_get "$slug")  $slug"; continue; fi
  existing="$(num_by_title "$title")"
  if [ -n "$existing" ]; then map_set "$slug" "$existing"; echo "  = reuse #$existing  $slug"; continue; fi
  body="$(render "$slug")"
  if [ "$parent" = "-" ]; then
    num="$(create_parent_np "$title" "$body" "$labels")"
  else
    pnum="$(map_get "$parent")"
    if [ -z "$pnum" ]; then echo "  !! parent $parent not created yet for $slug — run the epic first"; exit 1; fi
    read -r num _ <<<"$(create_child_np "$title" "$body" "$labels" "$pnum")"
  fi
  map_set "$slug" "$num"; echo "  + #$num  $slug  (parent ${parent})"
done <<<"$TABLE"

# ---- Pass B: re-render every body with the full map + edit ------------------
echo "== Pass B: finalize bodies (resolve all #__NUM_*__ tokens) =="
while IFS='|' read -r slug title parent labels; do
  [ -z "$slug" ] && continue
  n="$(map_get "$slug")"; [ -n "$n" ] || continue
  [ -f "$BODIES/$slug.md" ] || continue
  body="$(render "$slug")"
  ghp_gh issue edit "$n" --repo "$REPO" --body-file "$body" >/dev/null && echo "  ~ #$n  $slug"
done <<<"$TABLE"

echo "== done. slug→num map: $MAP =="
echo "== next: once the nathanjohnpayne token has 'project' scope, run:"
echo "==   GCB_MAP=$MAP bash $SCRIPT_DIR/board-fields-1.5.sh"
sort -t= -k1,1 "$MAP" | awk -F= '!seen[$1]++'
