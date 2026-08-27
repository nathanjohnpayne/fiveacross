#!/usr/bin/env bash
# scripts/gh-projects/examples/gaycruisebingo/board-fields-1.5.sh
#
# Deferred board-wiring pass for the Phase 1.5 — Daily Cards backlog. Run AFTER
# create-issues-1.5.sh, and ONLY once the nathanjohnpayne token has `project`
# scope (the create step needs only `repo`; this step needs `project`). Discovers
# the Project #7 node id + field/option ids at runtime, then, for every issue in
# the GCB_MAP:
#   1. adds it to Project #7 (idempotent — Projects v2 dedupes by content url),
#   2. sets Track / Phase(1.5) / Wave / Size / Status.
# Finally it appends the Phase 1.5 section to the project README (idempotent — skips
# if the marker heading is already present) and refreshes the short description if it
# doesn't yet mention daily cards. Phase 0/1/2 README text and field assignments are
# never clobbered.
#
# PREREQUISITE — the Phase field needs a "1.5" option. This script does NOT mutate
# the project's field *schema* (adding options via the API replaces the whole option
# list and would risk existing Phase 0/1/2 assignments). If "1.5" is missing it prints
# a one-line instruction and sets every field EXCEPT Phase; add the option in the UI
# (Project #7 → Settings → Phase → + add option "1.5") and re-run to fill Phase.
#
# CAUTION: the Status column FORCES Status on every listed issue each run. After
# tickets progress (In progress / In review / Done), a wholesale re-run resets them to
# the TSV value — prefer a targeted move-item.sh for a handful, or blank the Status
# column here before a full re-run.
#
# Usage:
#   eval "$(scripts/op-preflight.sh --agent claude --mode review)"   # (needs a project-scoped author PAT)
#   export GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT"
#   GCB_MAP=/tmp/gcb-15.map bash scripts/gh-projects/examples/gaycruisebingo/board-fields-1.5.sh
set -euo pipefail

export OWNER="nathanjohnpayne"
export REPO="nathanjohnpayne/fiveacross"
export PROJECT=7
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Defaults to the committed, title-verified slug->issue map (regenerate with
# genmap if issues are ever recreated). Override with GCB_MAP=<path> if needed.
MAP="${GCB_MAP:-$SCRIPT_DIR/slug-num-1.5.map}"
README_ADD="$SCRIPT_DIR/additions/readme-phase-1.5.md"
: "${GH_TOKEN:?GH_TOKEN must be the author PAT (nathanjohnpayne) with repo + project scopes}"
WORK="$(mktemp -d)"

ghp_gh() ( unset GITHUB_TOKEN; gh "$@"; )

# ---- identity guard (same contract as lib.sh / set-fields.sh) ---------------
CHECKER="$SCRIPT_DIR/../../identity-check.sh"
if [ "${GHP_SKIP_TOKEN_IDENTITY_CHECK:-0}" != "1" ] && [ -x "$CHECKER" ]; then
  GH_TOKEN="$GH_TOKEN" "$CHECKER" --expect-token-identity "${GHP_EXPECTED_IDENTITY:-nathanjohnpayne}" \
    || { echo "Error: GH_TOKEN must resolve to nathanjohnpayne for project mutations." >&2; exit 2; }
fi

# ---- fields table: slug|Track|Phase|Wave|Size|Status  ('-' = leave unset) ----
# Track values are existing project Track-*field* options (coarser than the
# fine track:* labels). Status: the two dependency-free Wave-0 roots start Ready.
read -r -d '' FIELDS <<'TSV' || true
d15-epic|-|1.5|-|-|Backlog
d15-schema-contract|schema|1.5|0|L|Ready
d15-firestore-rules|security|1.5|0|L|Backlog
d15-scheduler-unlock|backend|1.5|0|L|Backlog
d15-tab-contract|foundation|1.5|0|M|Ready
d15-dealing|play|1.5|1|L|Backlog
d15-day-switcher|play|1.5|1|L|Backlog
d15-two-themes|themes|1.5|1|M|Backlog
d15-tutorial-seed|prompts|1.5|1|M|Backlog
d15-more-menu|play|1.5|1|L|Backlog
d15-docs-glossary|foundation|1.5|1|S|Backlog
d15-approvals|moderation|1.5|2|L|Backlog
d15-claim-sheet-photo|proof|1.5|2|L|Backlog
d15-scoring-aggregates|leaderboard|1.5|2|L|Backlog
d15-tutorial-banners|play|1.5|2|M|Backlog
d15-coach-overlay|play|1.5|3|M|Backlog
d15-text-size|play|1.5|3|M|Backlog
d15-tally-cards|tally|1.5|3|L|Backlog
d15-finale|leaderboard|1.5|3|M|Backlog
d15-proof-chips-ranks|leaderboard|1.5|3|S|Backlog
d15-pwa-toasts|pwa|1.5|3|M|Backlog
d15-icons-lucide|play|1.5|3|M|Backlog
d15-admin-schedule|moderation|1.5|3|M|Backlog
d15-admin-proof-claims|moderation|1.5|3|M|Backlog
TSV
printf '%s\n' "$FIELDS" > "$WORK/fields.tsv"

# ---- 1. add every mapped issue to the project (idempotent) ------------------
echo "== Adding issues to Project #$PROJECT =="
while IFS='=' read -r slug num; do
  [ -z "$slug" ] && continue
  ghp_gh project item-add "$PROJECT" --owner "$OWNER" --url "https://github.com/$REPO/issues/$num" >/dev/null \
    && echo "  + #$num  $slug" || echo "  ! add failed #$num $slug"
done < "$MAP"

echo "Discovering project + field ids…"
ghp_gh project view "$PROJECT" --owner "$OWNER" --format json > "$WORK/proj.json"
ghp_gh project field-list "$PROJECT" --owner "$OWNER" --limit 100 --format json > "$WORK/fieldlist.json"
ghp_gh project item-list "$PROJECT" --owner "$OWNER" --format json --limit 800 > "$WORK/items.json"

# ---- Phase "1.5" option present? (advisory) ---------------------------------
HAS_15=$(python3 -c "
import json,sys
fl=json.load(open('$WORK/fieldlist.json'))['fields']
for f in fl:
    if f.get('name')=='Phase':
        print('yes' if any(o.get('name')=='1.5' for o in (f.get('options') or [])) else 'no'); break
else: print('nofield')
")
if [ "$HAS_15" != "yes" ]; then
  echo "  !! Phase field has no '1.5' option ($HAS_15). Add it in the UI:" >&2
  echo "     Project #$PROJECT → Settings → Phase → + add option \"1.5\", then re-run to fill Phase." >&2
  echo "     (Setting all OTHER fields now; Phase will be skipped.)" >&2
fi

# ---- 2. build + apply field edits -------------------------------------------
python3 - "$WORK" "$MAP" "$HAS_15" > "$WORK/cmds.tsv" <<'PY'
import json, sys
work, mapfile, has15 = sys.argv[1], sys.argv[2], sys.argv[3]
proj = json.load(open(f"{work}/proj.json")); pid = proj["id"]
fl = json.load(open(f"{work}/fieldlist.json"))["fields"]
fld = {}
for f in fl:
    e = {"id": f.get("id"), "opts": {}}
    for o in (f.get("options") or []): e["opts"][o["name"]] = o["id"]
    fld[f.get("name")] = e
items = json.load(open(f"{work}/items.json"))["items"]
url2item = {}
for it in items:
    c = it.get("content") or {}
    if c.get("url"): url2item[c["url"]] = it["id"]
num = {}
for line in open(mapfile):
    line = line.strip()
    if "=" in line:
        s, n = line.split("=", 1); num[s] = n
REPO = "nathanjohnpayne/fiveacross"
COL = ["Track", "Phase", "Wave", "Size", "Status"]
out = []
for line in open(f"{work}/fields.tsv"):
    line = line.rstrip("\n")
    if not line: continue
    slug, *vals = line.split("|")
    n = num.get(slug)
    if not n:
        sys.stderr.write(f"  ! no issue number for {slug}\n"); continue
    item = url2item.get(f"https://github.com/{REPO}/issues/{n}")
    if not item:
        sys.stderr.write(f"  ! {slug} #{n} not on the board\n"); continue
    for col, val in zip(COL, vals):
        if val in ("-", ""): continue
        if col == "Phase" and has15 != "yes": continue
        f = fld.get(col)
        if not f: sys.stderr.write(f"  ! no field {col}\n"); continue
        oid = f["opts"].get(val)
        if not oid: sys.stderr.write(f"  ! {col} has no option {val!r}\n"); continue
        out.append("\t".join([item, pid, f["id"], oid]))
sys.stdout.write("\n".join(out) + ("\n" if out else ""))
PY

total=$(grep -c . "$WORK/cmds.tsv" || echo 0); i=0
echo "Applying $total field values…"
while IFS=$'\t' read -r item pid fid oid; do
  [ -z "$item" ] && continue
  i=$((i+1))
  ghp_gh project item-edit --id "$item" --project-id "$pid" --field-id "$fid" --single-select-option-id "$oid" >/dev/null
  [ $((i % 20)) -eq 0 ] && echo "  …$i/$total"
done < "$WORK/cmds.tsv"
echo "Set $i field values across the board."

# ---- 3. README append (idempotent) + short description ----------------------
if [ -f "$README_ADD" ]; then
  CUR_README=$(python3 -c "import json;print(json.load(open('$WORK/proj.json')).get('readme','') or '')")
  if printf '%s' "$CUR_README" | grep -q "Phase 1.5 — Daily Cards"; then
    echo "README already has the Phase 1.5 section — leaving it."
  else
    printf '%s\n\n%s\n' "$CUR_README" "$(cat "$README_ADD")" > "$WORK/readme.md"
    ghp_gh project edit "$PROJECT" --owner "$OWNER" --readme "$(cat "$WORK/readme.md")" >/dev/null \
      && echo "Appended Phase 1.5 section to the project README."
  fi
else
  echo "  ! README addition file missing: $README_ADD (skipping README update)"
fi

CUR_DESC=$(python3 -c "import json;print(json.load(open('$WORK/proj.json')).get('shortDescription','') or '')")
if printf '%s' "$CUR_DESC" | grep -qi "daily"; then
  echo "Short description already mentions daily cards — leaving it."
else
  NEW_DESC="Live, phone-first honor-system bingo PWA for the Atlantis Trieste→Barcelona cruise — now a themed Day Card per cruise day with 8 a.m. unlocks and tutorial days; the group's feed is the verification."
  ghp_gh project edit "$PROJECT" --owner "$OWNER" --short-description "$NEW_DESC" >/dev/null \
    && echo "Updated short description to mention daily cards."
fi

echo "== board-fields-1.5 done =="
