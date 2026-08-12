**Track:** infra · **Phase:** hardening · **Wave:** 4 · **Size:** M · **ADR(s):** —
**Epic:** #__NUM_epic-backend__
**Labels:** agent-action, track:infra, hardening, wave-4, size:M, needs-phase-4

## Context & scope

Connect the production domain `gaycruisebingo.com` to Firebase Hosting so the Event is reachable at its real URL before embarkation. Because SSL-cert issuance can take up to ~24 h (a PRD risk), the DNS records must be added early and left DNS-only / unproxied through Cloudflare so Firebase can validate the domain and issue the cert — do this step first. Verify the existing `firebase.json` hosting headers survive the cutover, and deploy through `op-firebase-deploy`. Pure infra — no app-code or ADR surface.

## Current state (scaffold)

- **Exists:** `firebase.json` hosting block — SPA rewrite + Cache-Control headers (immutable long-cache for hashed `js|css|woff2|png|svg` assets, `no-cache` for `index.html` and `sw.js`/icons); `.firebaserc` default project `gaycruisebingo`; `package.json` `deploy` = `npm run build && op-firebase-deploy`, `deploy:hosting` = `... --only hosting`.
- **Missing:** `gaycruisebingo.com` is not connected to Firebase Hosting; no custom-domain DNS records; SSL cert not issued.
- **Contradicts:** none.

## Files to create / modify

- `firebase.json` — verify the hosting headers still apply post-cutover (no change expected unless a header is missing).
- DNS (Cloudflare) — add Firebase Hosting's A / TXT records DNS-only (grey cloud / unproxied) so Firebase can issue the cert.
- Firebase console — add the custom domain and complete verification.

## Implementation notes

- Records MUST be DNS-only / unproxied — a proxied (orange-cloud) record blocks Firebase's cert issuance. Do the DNS step FIRST because propagation + issuance can take up to ~24 h (PRD risk).
- Phase 0 hosting runs on the Spark plan; the domain connection does not require Blaze (unlike Functions).
- Deploy via `op-firebase-deploy` (1Password-backed; `npm run deploy:gaycruisebingo:hosting` or targeted `npm run deploy -- gaycruisebingo`) — never `firebase login` / `firebase deploy` directly (`docs/app/README.md`).
- Keep `noindex` (`index.html:25`) intact — the custom domain does not change public discoverability.
- Keep the PR small (needs-phase-4, deploy/infra); expect external review.
- **decision-needed context:** the cutover timing is an open operational decision — tracked in #__NUM_x-decisions-needed__.

## Tests to add

- Infra/provisioning — no app test layer. `specs/w4-infra-domain.md` is a runbook carrying frontmatter `tested: false` + `reason:` (infra) per the spec↔test checker (layer: n/a).
- Verify the live domain serves the app over HTTPS with a valid cert and the expected Cache-Control headers; record in the commit `Verified:` trailer (layer: n/a — manual verification).

## Acceptance criteria

- **Given** DNS-only records added early **When** Firebase issues the SSL cert (within ~24 h) **Then** `gaycruisebingo.com` serves the app over HTTPS with a valid cert.
- **Given** the custom domain is live **When** any page loads **Then** the `firebase.json` Cache-Control headers apply (immutable hashed assets, `no-cache` `index.html`/`sw.js`) and `noindex` is preserved.
- [ ] `gaycruisebingo.com` connected to Firebase Hosting, DNS-only / unproxied
- [ ] SSL cert issued and valid
- [ ] Hosting headers verified post-cutover; deployed via `op-firebase-deploy`
- [ ] Cutover-timing decision resolved via #__NUM_x-decisions-needed__

## Definition of Done

- [ ] Spec `specs/w4-infra-domain.md` created/updated **with a matching test** (checker `scripts/ci/check_spec_test_alignment` matches basename → a test under `tests/**` or `src/**/*.test.*`; design-only specs use frontmatter `tested: false` + `reason:`)
- [ ] `npm run typecheck` · `npm test` · `npm run build` green locally (no `lint` script; app tests are not CI-run — record in the commit `Verified:` trailer)
- [ ] Repo gates pass: `repo_lint` (incl. spec↔test alignment), `md-prose-wrap`, review-policy label gate
- [ ] Conventional commits + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; PR body `Closes #<this issue>`; authored `nathanjohnpayne`, reviewed under `nathanpayne-{agent}`; driven to merge
- [ ] Board discipline per `docs/agents/ticket-workflow.md` (claim → In progress; PR → In review; merge → Done)

## Dependencies

- Depends on #__NUM_x-decisions-needed__ — domain cutover-timing decision (no code/ticket deps otherwise)
