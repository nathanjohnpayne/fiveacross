---
spec_id: w3-security-hardening
status: accepted
---

# Security & rules hardening (`w3-security-hardening`)

A hardening pass whose main job is protecting the intentional design from a well-meaning "fix." It verifies the crawler `noindex`, adds an 18+ acceptable-use / community-guidelines page behind the auth wall, documents in the `firestore.rules` comments that the self-writable `boards/{uid}` + `players/{uid}` are intentional (ADR 0001) and that every Mark publishes to a public per-Prompt Tally (ADR 0002), and proposes closing the protected-path gap by adding the security-rules and Cloud Functions surfaces to `.github/review-policy.yml`. No behavior changes to the rules. The jsdom claims are exercised by `src/w3-security-hardening.test.tsx`; the rules documentation-guard by `tests/rules/self-writable.test.ts` (rules-emulator); both validated by `scripts/ci/check_spec_test_alignment`.

## The app serves `noindex` and exposes no public unauthenticated page (ADR 0005)

The audience is a private, noindex, 18+ friend group, so `index.html` must keep serving `robots: noindex` and nothing may be reachable without signing in—everything stays behind the auth wall (ADR 0005). This ticket verifies the meta tag and adds no public route.

- **Given** `index.html` **When** its `<head>` is scanned **Then** it contains `<meta name="robots" content="noindex" />`. (Test: "index.html serves robots noindex".)

## An 18+ acceptable-use page renders behind auth and is unreachable signed out

A signed-in Player can open a community-guidelines surface that states the 18+ posture, the community expectations, and how to report a Prompt or Proof (the report path that feeds #37). It self-gates on the signed-in User—nothing renders while signed out—and is not added to the frozen tab route table. `AcceptableUse` itself still supports a `variant="floating"` presentation (the original bottom-left fixed chip, exercised by this spec's own tests below via the component's default prop) and a `variant="row"` presentation; as of Phase 1.5 (#208, daily-cards-spec § "More menu") the LIVE app mounts only `variant="row"`, once, inside the More tab—reachable from Card and every other signed-in route by tapping More, since More is itself a frozen tab-bar stop rather than a route-conditional composition-root mount. See specs/d15-more-menu.md § Contract for that relocation.

- **Given** a signed-in Player **When** they open the acceptable-use affordance **Then** they see the 18+ guidelines and how to report a Prompt or Proof. (Test: "AcceptableUse renders the 18+ guidelines and report path for a signed-in Player".)
- **Given** a signed-out visitor **When** `AcceptableUse` mounts **Then** it renders nothing and exposes no page (ADR 0005). (Test: "AcceptableUse renders nothing while signed out".)
- **Given** a signed-in Player on Card or any other tab **When** the app renders **Then** exactly one Guidelines affordance is reachable, mounted once inside the More tab (`variant="row"`)—Board.tsx and main.tsx no longer mount it directly. (Test: "keeps AcceptableUse reachable from the More menu on every signed-in route".)
- **Given** the reporting paths today only increment `reportCount` (`src/data/api.ts`, `src/data/proofs.ts`) and visibility only changes via an Admin action (`src/data/admin.ts`)—the threshold auto-hide is future work (#37) **When** the report-a-Prompt-or-Proof copy is read **Then** it says a report flags the item for an Admin's review and Admins can hide or remove it, and it does not claim reports hide anything automatically. (Test: "does not promise automatic report-threshold hiding".)
- **Given** a signed-in Player using a keyboard or screen reader **When** they open the guidelines dialog **Then** focus moves into the dialog, Tab/Shift+Tab stay trapped inside it while it is open, Escape closes it, and focus returns to the trigger on close via any of "Got it", the backdrop, or Escape—so the covered app chrome behind the dialog is never reachable by Tab. (Test: "moves focus into the dialog on open and restores it to the trigger when \"Got it\" closes it", "traps Tab and Shift+Tab within the dialog while it is open", "closes on Escape and restores focus to the trigger", "restores focus to the trigger when the backdrop closes the dialog".)

## The rules comments pin self-writable-by-design and Tally-publishes as intentional (ADR 0001 / 0002)

The self-writable `boards/{uid}` + `players/{uid}` are load-bearing honor-system design (ADR 0001): a Player writes their own Board and stats directly, so a lock-down "fix" is a misread. Every Mark self-publishes an attributed entry to its Prompt's public Tally (ADR 0002) while the Board stays private. The comments document this so a future reviewer does not revert it; a rules-emulator guard test-pins the intent so it is not merely commented. No rule behavior changes.

- **Given** the emulator + rules **When** an owner writes their own `boards/{uid}` or `players/{uid}` **Then** the write is ALLOWED, and a write to another Player's board or stats is DENIED. (Test: "ADR 0001: boards/players stay self-writable for the owner; cross-player writes denied".)
- **Given** a Mark **When** a Player writes their own `tally/{itemId}/markers/{uid}` entry **Then** it is ALLOWED and publicly readable, while forging another Player's entry is DENIED. (Test: "ADR 0002: a Mark publishes an attributed Tally entry; forgery denied".)

## The security-rules and functions surfaces are proposed as protected paths

`firestore.rules`, `storage.rules`, and `functions/**` gate every client's access, so a change to them should always draw external (Phase 4) review regardless of line count. This ticket adds them to `external_review_paths` in `.github/review-policy.yml`, closing the protected-path gap the parallelization plan names.

- **Given** `.github/review-policy.yml` **When** `external_review_paths` is read **Then** it lists `firestore.rules`, `storage.rules`, and `functions/**`. (Test: "review-policy.yml protects the security-rules and functions surfaces".)
