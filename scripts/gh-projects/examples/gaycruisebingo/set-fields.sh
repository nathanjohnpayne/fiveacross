#!/usr/bin/env bash
# scripts/gh-projects/examples/gaycruisebingo/set-fields.sh
#
# Sets the Project #7 custom fields (Track / Phase / Wave / Size / ADR) and
# Status for every backlog issue created by create-issues.sh. Discovers the
# project node id + field/option ids at runtime (no stale ids), maps each issue
# number to its project item id, and issues one `gh project item-edit` per field.
#
# Status mapping: new → Backlog; unblocked Wave-0 → Ready (w0-test-harness,
# w0-type-contract, w0-app-shell). Everything else Backlog.
#
# CAUTION: the Status column FORCES Status on every listed issue each run. After
# tickets have progressed (In review / Done), a wholesale re-run resets them to
# the TSV value — prefer a targeted `gh project item-edit` for a handful of
# issues, or refresh this Status column before a full re-run. Phase 2 rows carry
# Phase `2`, a Phase single-select option added 2026-07-09.
#
# Usage:
#   eval "$(scripts/op-preflight.sh --agent claude --mode all)"
#   export GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT"
#   GCB_MAP=<path to slug-num.map> bash scripts/gh-projects/examples/gaycruisebingo/set-fields.sh
set -euo pipefail

export OWNER="nathanjohnpayne"
export PROJECT=7
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAP="${GCB_MAP:?set GCB_MAP to the slug-num.map written by create-issues.sh}"
: "${GH_TOKEN:?GH_TOKEN must be the author PAT (nathanjohnpayne)}"
WORK="$(mktemp -d)"

ghp_gh() ( unset GITHUB_TOKEN; gh "$@"; )

# ---- fields table: slug|Track|Phase|Wave|Size|ADR|Status  ('-' = leave unset)
read -r -d '' FIELDS <<'TSV' || true
epic-foundation|foundation|0|0|-|-|Backlog
epic-identity|identity|0|1|-|-|Backlog
epic-play|play|0|1|-|-|Backlog
epic-social|feed|0|2|-|-|Backlog
epic-moderation|moderation|0|2|-|-|Backlog
epic-backend|backend|1|4|-|-|Backlog
epic-launch|launch|hardening|3|-|-|Backlog
epic-phase2-hardening|backend|2|4|-|-|Backlog
x-decisions-needed|launch|0|0|S|-|Backlog
w0-test-harness|foundation|0|0|L|0001, 0002|Ready
w0-type-contract|foundation|0|0|M|0001, 0002, 0004|Ready
w0-app-shell|foundation|0|0|M|-|Ready
w0-firestore-rules|security|0|0|L|0001, 0002, 0004|Backlog
w0-storage-rules|security|0|0|S|0004|Backlog
w0-offline-persistence|offline|0|0|M|0006|Backlog
w1-auth-google|identity|0|1|M|0001|Backlog
w1-event-seed|foundation|0|1|S|0003, 0004|Backlog
w1-adult-attestation|identity|0|1|M|0001|Backlog
w1-profile-avatar|identity|0|1|M|0002|Backlog
w1-board-deal-join|play|0|1|L|0003|Backlog
w1-board-mark-win|play|0|1|L|0001, 0006|Backlog
w1-prompt-pool|prompts|0|1|M|0003, 0004|Backlog
w1-themes|themes|0|1|M|-|Backlog
w1-pwa|pwa|0|1|M|0006|Backlog
w2-tally|tally|0|2|L|0001, 0002|Backlog
w2-proof-capture|proof|0|2|L|0002, 0004|Backlog
w2-doubts|doubts|0|2|M|0001, 0002|Backlog
w2-feed-moments|feed|0|2|L|0002|Backlog
w2-leaderboard|leaderboard|0|2|M|0001|Backlog
w2-share-cards|share|0|2|M|0005|Backlog
w2-admin-console|moderation|0|2|L|0004|Backlog
w2-ga4-events|analytics|0|2|M|-|Backlog
recon-share-og|reconciliation|0|2|M|0005|Backlog
recon-recompute-stats|reconciliation|0|2|S|0001|Backlog
w3-claim-modes|claims|0|3|L|0001|Backlog
w3-security-hardening|security|hardening|3|M|0001, 0002, 0004|Backlog
w4-phase1-functions|backend|1|4|L|0004|Backlog
w4-app-check|backend|2|4|M|0004|Backlog
w4-infra-domain|infra|hardening|4|M|-|Backlog
w4-infra-blaze-budget|infra|1|4|S|-|Backlog
p2-vision-proof|proof|2|4|M|0004|Backlog
p2-vision-moderation|moderation|2|4|M|0004|Backlog
p2-archive|launch|2|4|M|0001, 0003|Backlog
x-e2e-happy-path|launch|hardening|3|M|0006|Backlog
x-launch-checklist|launch|hardening|4|M|-|Backlog
x-multi-event-schema|schema|hardening|4|S|0003|Backlog
sec-xss-proofsheet|security|0|0|S|0002|Ready
sec-clear-text-logging-seed|security|0|0|S|-|Ready
sec-xss-proofsheet-2|security|0|0|S|0002|Ready
TSV
printf '%s\n' "$FIELDS" > "$WORK/fields.tsv"

echo "Discovering project + field ids…"
ghp_gh project view "$PROJECT" --owner "$OWNER" --format json > "$WORK/proj.json"
ghp_gh project field-list "$PROJECT" --owner "$OWNER" --limit 100 --format json > "$WORK/fieldlist.json"
ghp_gh project item-list "$PROJECT" --owner "$OWNER" --format json --limit 500 > "$WORK/items.json"

# Build the exact `gh project item-edit` arg-lines with python (one per field/value).
python3 - "$WORK" "$MAP" "$SCRIPT_DIR" > "$WORK/cmds.tsv" <<'PY'
import json, os, sys
work, mapfile, _ = sys.argv[1], sys.argv[2], sys.argv[3]
proj = json.load(open(f"{work}/proj.json"))
pid = proj["id"]
fl = json.load(open(f"{work}/fieldlist.json"))["fields"]
fld = {}
for f in fl:
    e = {"id": f.get("id"), "type": f.get("type"), "opts": {}}
    for o in (f.get("options") or []):
        e["opts"][o["name"]] = o["id"]
    fld[f.get("name")] = e
items = json.load(open(f"{work}/items.json"))["items"]
url2item = {}
for it in items:
    c = it.get("content") or {}
    if c.get("url"):
        url2item[c["url"]] = it["id"]
num = {}
for line in open(mapfile):
    line = line.strip()
    if "=" in line:
        s, n = line.split("=", 1); num[s] = n
REPO = "nathanjohnpayne/fiveacross"
COL = ["Track", "Phase", "Wave", "Size", "ADR", "Status"]
out = []
for line in open(f"{work}/fields.tsv"):
    line = line.rstrip("\n")
    if not line: continue
    slug, *vals = line.split("|")
    n = num.get(slug)
    if not n:
        sys.stderr.write(f"  ! no issue number for {slug}\n"); continue
    url = f"https://github.com/{REPO}/issues/{n}"
    item = url2item.get(url)
    if not item:
        sys.stderr.write(f"  ! {slug} #{n} not on the board\n"); continue
    for col, val in zip(COL, vals):
        if val == "-" or val == "": continue
        f = fld.get(col)
        if not f: sys.stderr.write(f"  ! no field {col}\n"); continue
        if col == "ADR":  # text field
            out.append("\t".join([item, pid, f["id"], "text", val]))
        else:
            oid = f["opts"].get(val)
            if not oid: sys.stderr.write(f"  ! {col} has no option {val!r}\n"); continue
            out.append("\t".join([item, pid, f["id"], "opt", oid]))
sys.stdout.write("\n".join(out) + ("\n" if out else ""))
PY

total=$(wc -l < "$WORK/cmds.tsv" | tr -d ' '); i=0
echo "Applying $total field values…"
while IFS=$'\t' read -r item pid fid kind val; do
  [ -z "$item" ] && continue
  i=$((i+1))
  if [ "$kind" = "text" ]; then
    ghp_gh project item-edit --id "$item" --project-id "$pid" --field-id "$fid" --text "$val" >/dev/null
  else
    ghp_gh project item-edit --id "$item" --project-id "$pid" --field-id "$fid" --single-select-option-id "$val" >/dev/null
  fi
  [ $((i % 20)) -eq 0 ] && echo "  …$i/$total"
done < "$WORK/cmds.tsv"
echo "Set $i field values across the board."
