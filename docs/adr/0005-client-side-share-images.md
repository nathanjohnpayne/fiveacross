---
status: accepted
---

# Share images are generated client-side and dropped into chat, not server-rendered for link-unfurls

The audience is a private, noindex, 18+ friend group sharing into group chats, where the value is an image *in* the chat—not a public link that unfurls. So for launch we generate Share Cards **on-device** (canvas / html-to-image) and hand them to the native share sheet, rather than running the scaffolded Cloud Run Playwright OG service behind public, crawler-facing share pages. The **BINGO celebration is the primary share surface** (a "share to the chat" button on the win); the Leaderboard is the second. We ship **BINGO + Leaderboard cards only**—no per-square proof cards, since a Proof already carries its own shareable media.

## Consequences

- The scaffolded `cloud-run/og-renderer/` and the public share pages are **not used at launch** (deferred, likely dropped). Bare-URL unfurls use static, Edition-specific `og-gcb.png`, `og-vacay.png`, or `og-fiveacross.png` artwork; `og-default.png` remains only so crawler caches can re-fetch old image URLs.
- **No public unauthenticated pages** exposing win/leaderboard data—everything stays behind the auth wall, which matters for an 18+ app.
- Sharing moves from **Phase 1 into Phase 0**.
- Revisit the Cloud Run OG path only if public link-unfurls ever become a real want.
