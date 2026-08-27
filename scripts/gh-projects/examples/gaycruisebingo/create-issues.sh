#!/usr/bin/env bash
# scripts/gh-projects/examples/gaycruisebingo/create-issues.sh
#
# Fresh-create driver for the Gay Cruise Bingo backlog (Project #7). Creates the
# epic parents + child tickets from the templated body files in ./bodies/, links
# children as native sub-issues, and adds everything to the Project board.
#
# Idempotent: an issue whose exact title already exists is reused, not duplicated
# (so a partial run — e.g. the pilot — can be re-run safely). Cross-issue refs in
# the bodies use `#__NUM_<slug>__` tokens; this driver substitutes them in two
# passes (create with the map-so-far, then re-render every body with the full map
# and `gh issue edit`).
#
# macOS bash 3.2 compatible: no associative arrays — the slug→number map is a
# flat `slug=num` file (GCB_MAP), matching lib.sh / move-item.sh conventions.
#
# Usage:
#   eval "$(scripts/op-preflight.sh --agent claude --mode all)"
#   export GH_TOKEN="$OP_PREFLIGHT_AUTHOR_PAT"
#   # pilot a subset (space-separated slugs), then the rest (skips existing):
#   bash scripts/gh-projects/examples/gaycruisebingo/create-issues.sh epic-foundation w0-test-harness
#   bash scripts/gh-projects/examples/gaycruisebingo/create-issues.sh
#
# Field/Status assignment lives in the companion set-fields.sh (run after this).

set -euo pipefail

export REPO="nathanjohnpayne/fiveacross"
export OWNER="nathanjohnpayne"
export PROJECT=7

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BODIES="$SCRIPT_DIR/bodies"
WORKDIR="${GCB_WORKDIR:-$(mktemp -d)}"
MAP="${GCB_MAP:-$WORKDIR/slug-num.map}"
mkdir -p "$WORKDIR"
[ -f "$MAP" ] || : > "$MAP"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../lib.sh"   # enforces GH_TOKEN=nathanjohnpayne; provides helpers + ghp_gh

# ---- ticket table: slug|title|parent-slug (or -)|labels-csv -----------------
# Topological order: epics first, standalone, then children by wave.
read -r -d '' TABLE <<'TSV' || true
epic-foundation|Epic: Foundation & test harness|-|epic,track:foundation,phase-0
epic-identity|Epic: Identity, 18+ attestation & profile|-|epic,track:identity,phase-0
epic-play|Epic: Core play — Board, Prompts, Themes, PWA|-|epic,track:play,phase-0
epic-social|Epic: Social core — Tally, Doubts, Proof, Feed/Moments, Leaderboard, Claims, Share Cards|-|epic,track:feed,phase-0
epic-moderation|Epic: Moderation, analytics & scaffold reconciliation|-|epic,track:moderation,phase-0
epic-backend|Epic: Phase 1 backend & infra|-|epic,track:backend,phase-1
epic-launch|Epic: Launch, e2e & cross-cutting|-|epic,track:launch,hardening
epic-phase2-hardening|Epic: Phase 2 — Hardening (Cloud Vision, App Check, archive)|-|epic,track:backend,phase-2,hardening
x-decisions-needed|Decisions needed: open operational/config choices blocking specific tickets|-|decision-needed,track:launch,phase-0,wave-0,size:S
w0-test-harness|Wire the test harness (vitest jsdom + RTL, emulator rules tests, Playwright e2e, CI)|epic-foundation|agent-action,track:foundation,phase-0,wave-0,size:L
w0-type-contract|Reconcile the domain type contract (verified→admin_confirmed, drop blackoutEnabled, add Tally/Doubt/Moment/attestation types)|epic-foundation|agent-action,track:foundation,phase-0,wave-0,size:M,reconciliation
w0-app-shell|App shell & bottom-tab navigation (stable route mount points)|epic-foundation|agent-action,track:foundation,phase-0,wave-0,size:M
w0-firestore-rules|Firestore rules baseline + rules-emulator tests (self-writable allowed; Tally/Doubts/Moments/attestation)|epic-foundation|agent-action,track:security,phase-0,wave-0,size:L,needs-phase-4
w0-storage-rules|Storage rules review + emulator tests (proof/avatar MIME + size caps)|epic-foundation|agent-action,track:security,phase-0,wave-0,size:S,needs-phase-4
w0-offline-persistence|Firestore offline persistence (persistentLocalCache + multi-tab) so Marks queue durably|epic-foundation|agent-action,track:offline,phase-0,wave-0,size:M
w1-auth-google|Google sign-in + AuthContext hardening (surface join/deal errors)|epic-identity|agent-action,track:identity,phase-0,wave-1,size:M,needs-phase-4
w1-event-seed|Reconcile the Event/pool seed script (drop blackoutEnabled, admin roster, threshold, align claimMode)|epic-identity|agent-action,track:foundation,phase-0,wave-1,size:S,reconciliation,decision-needed
w1-adult-attestation|Persist the 18+ attestation as a timestamped profile attestation|epic-identity|agent-action,track:identity,phase-0,wave-1,size:M,needs-phase-4
w1-profile-avatar|Profile: display name + custom avatar upload|epic-identity|agent-action,track:identity,phase-0,wave-1,size:M
w1-board-deal-join|Board render + deal/freeze-at-join (24 + Free Space; guard pool<24; NO re-deal)|epic-play|agent-action,track:play,phase-0,wave-1,size:L
w1-board-mark-win|Mark a Square + BINGO/Blackout detection + celebration (offline-durable Marks)|epic-play|agent-action,track:play,phase-0,wave-1,size:L
w1-prompt-pool|Prompt pool: add / report / rate-limit + pre-cruise framing|epic-play|agent-action,track:prompts,phase-0,wave-1,size:M
w1-themes|8 Atlantis Themes: switcher + persistence + WCAG contrast|epic-play|agent-action,track:themes,phase-0,wave-1,size:M
w1-pwa|PWA: manifest / SW / install prompt / iOS safe-area / Lighthouse ≥ 90|epic-play|agent-action,track:pwa,phase-0,wave-1,size:M
w2-tally|Per-Prompt Tally: every Mark publishes an attributed public record + tap-to-see-who|epic-social|agent-action,track:tally,phase-0,wave-2,size:L
w2-proof-capture|Proof capture (photo/audio/text) + on-device downscale + Storage upload|epic-social|agent-action,track:proof,phase-0,wave-2,size:L
w2-doubts|Doubts (ask-for-proof): count on Square + Tally, satisfied by a Proof|epic-social|agent-action,track:doubts,phase-0,wave-2,size:M
w2-feed-moments|Feed = Proofs + Moments (first-BINGO / Blackout / First to BINGO; bare Marks post nothing)|epic-social|agent-action,track:feed,phase-0,wave-2,size:L
w2-leaderboard|Leaderboard: bingos→squares→earliest-first-bingo, pinned First to BINGO, filters|epic-social|agent-action,track:leaderboard,phase-0,wave-2,size:M
w2-share-cards|On-device Share Cards (BINGO + Leaderboard) → native share sheet|epic-social|agent-action,track:share,phase-0,wave-2,size:M
w2-admin-console|Admin & moderation console: reactive auto-hide at reportHideThreshold (client Phase 0) + report queue + ban|epic-moderation|agent-action,track:moderation,phase-0,wave-2,size:L
w2-ga4-events|GA4 events + DebugView + consent notice (complete the 12-event set)|epic-moderation|agent-action,track:analytics,phase-0,wave-2,size:M
recon-share-og|Reconciliation: remove cloud-run/og-renderer + share function + /s rewrite; keep static og-default.png|epic-moderation|agent-action,track:reconciliation,phase-0,wave-2,size:M,reconciliation
recon-recompute-stats|Reconciliation: remove recomputeStats as anti-cheat + fix phase-1-deploy stat-locking guidance|epic-moderation|agent-action,track:reconciliation,phase-0,wave-2,size:S,reconciliation,needs-phase-4
w3-claim-modes|Claim Modes (honor / proof_required / admin_confirmed) + Claims + admin confirm/reject|epic-social|agent-action,track:claims,phase-0,wave-3,size:L
w3-security-hardening|Security & rules hardening: noindex, acceptable-use page, self-writable-by-design docs, protected-path policy|epic-moderation|agent-action,track:security,hardening,wave-3,size:M,needs-phase-4
w4-phase1-functions|Phase 1 functions: server-authoritative hide (flip status at threshold) + keep Vision extreme-only + sharp thumbs|epic-backend|agent-action,track:backend,phase-1,wave-4,size:L,needs-phase-4
w4-app-check|App Check enforcement (reCAPTCHA Enterprise): provision key + enforce|epic-phase2-hardening|agent-action,track:backend,phase-2,hardening,wave-4,size:M,needs-phase-4,decision-needed
w4-infra-domain|Infra: Cloudflare → Firebase Hosting custom domain + SSL (DNS-only) + headers|epic-backend|agent-action,track:infra,hardening,wave-4,size:M,needs-phase-4
w4-infra-blaze-budget|Infra: Blaze upgrade + budget alert before enabling Phase 1|epic-backend|agent-action,track:infra,phase-1,wave-4,size:S,needs-phase-4,decision-needed
p2-vision-proof|Cloud Vision (proof): re-enable the gated moderateProof SafeSearch scanner + thumbnails|epic-phase2-hardening|agent-action,track:proof,phase-2,hardening,wave-4,size:M,needs-phase-4
p2-vision-moderation|Cloud Vision (moderation): auto-hide extreme/illegal Vision flags (extend shipped autohide)|epic-phase2-hardening|agent-action,track:moderation,phase-2,hardening,wave-4,size:M,needs-phase-4
p2-archive|Post-sailing archive: freeze the Event + durable Leaderboard / First-to-BINGO hall of fame|epic-phase2-hardening|agent-action,track:launch,phase-2,hardening,wave-4,size:M,needs-phase-4
x-e2e-happy-path|E2E happy-path (join → mark → BINGO → leaderboard) + offline-mark test against the emulator|epic-launch|agent-action,track:launch,hardening,wave-3,size:M
x-launch-checklist|Cross-device matrix + launch checklist + printed-PDF fallback|epic-launch|agent-action,track:launch,hardening,wave-4,size:M
x-multi-event-schema|Multi-event schema readiness (P2, design-only)|epic-launch|agent-action,track:schema,hardening,wave-4,size:S
TSV

# ---- slug→num map helpers (flat file; bash 3.2 safe) ------------------------
map_get(){ awk -F= -v s="$1" '$1==s{v=$2} END{if(v!="")print v}' "$MAP" 2>/dev/null; }
map_set(){ echo "$1=$2" >> "$MAP"; }

# ---- optional slug filter (pilot mode) --------------------------------------
FILTER=0; WANTLIST=""
if [ "$#" -gt 0 ]; then FILTER=1; WANTLIST=" $* "; fi
wanted(){ [ "$FILTER" -eq 0 ] && return 0; case "$WANTLIST" in *" $1 "*) return 0;; esac; return 1; }

# ---- existing issues (idempotency) ------------------------------------------
ghp_gh issue list --repo "$REPO" --state all --limit 500 --json number,title > "$WORKDIR/existing.json"
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

# ---- Pass A: create (or reuse) each issue -----------------------------------
echo "== Pass A: create/reuse =="
while IFS='|' read -r slug title parent labels; do
  [ -z "$slug" ] && continue
  wanted "$slug" || continue
  [ -f "$BODIES/$slug.md" ] || { echo "  !! missing body: bodies/$slug.md — skipping"; continue; }
  if [ -n "$(map_get "$slug")" ]; then echo "  = have  #$(map_get "$slug")  $slug"; continue; fi
  existing="$(num_by_title "$title")"
  if [ -n "$existing" ]; then map_set "$slug" "$existing"; echo "  = reuse #$existing  $slug"; continue; fi
  body="$(render "$slug")"
  if [ "$parent" = "-" ]; then
    url="$(create_parent "$title" "$body" "$labels")"; num="${url##*/}"
  else
    pnum="$(map_get "$parent")"
    if [ -z "$pnum" ]; then echo "  !! parent $parent not created yet for $slug — run epics first"; exit 1; fi
    read -r url num _ <<<"$(create_child "$title" "$body" "$labels" "$pnum")"
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
sort -t= -k1,1 "$MAP" | awk -F= '!seen[$1]++'
