# Repository Overview

This repository is **Five Across** — a live, phone-first social bingo platform (PWA) for a group sharing one occasion. Players sign in, get a randomized 5×5 Day Card of things that might happen there, and mark them off as they do, with a shared Feed, a leaderboard, per-Day Themes, PWA install, and Marks that keep working offline and sync on reconnect. Printed cards are the Gay Cruise Bingo Edition's own fallback (`gcb.offlineNote`), not a platform feature.

One Brand wears an **Edition** per class of occasion and runs one **Event** per occasion, each addressed by its own hostname and resolved pre-auth ([ADR 0009](../adr/0009-event-resolved-from-hostname.md)). Two Editions are live: Gay Cruise Bingo (`gaycruisebingo.com`, the completed `med-2026` sailing) and Vacay Bingo (`bodega-bay.vacaybingo.com`). They are backed by two production Firebase projects, giving the Editions separate Firebase resources and deploy targets from one source tree. That split is **not** cohort isolation and must not be described as one — a signed-in account can still reach either app until membership-scoped rules land ([ADR 0008](../adr/0008-five-across-second-firebase-project.md)). The product overview is in [`README.md`](../../README.md), the Brand/Edition model in [`BRAND.md`](../../BRAND.md), and the domain vocabulary in [`CONTEXT.md`](../../CONTEXT.md) — which is also the neutral vocabulary the prose tree is converging on, so prefer Event over cruise or sailing.

## Stack

Vite + React 19 + TypeScript (strict) · Firebase (Auth · Firestore · Storage · Hosting · Analytics) · `vite-plugin-pwa` with a custom service worker · Cloud Functions · Cloud Scheduler · PostHog and GA4 · Cloudflare DNS and edge redirects. Player stats stay client-authoritative and the leaderboard is a client-side sort ([ADR 0001](../adr/0001-honor-system-trust-model.md)); the Functions package carries only what needs a server — scheduled Day unlocks and finale computation, threshold hiding, proof thumbnails, moderation email, bug-report intake, and Cloud Vision moderation behind a deploy-time gate.

## Agent role

Build and maintain the Five Across platform — game logic, Event and Edition resolution, Firebase data/rules, auth, Themes, and the proof/moderation system — keeping `specs/`, `docs/`, and tests in step with behavior. Ship changes via branch + PR under the review policy (see [`AGENTS.md`](../../AGENTS.md) § Code Review Policy).

## Relationship to mergepath

This repo was scaffolded from — and tracks — the **mergepath** template, the canonical implementation of the AI Agent Tooling Standard for this account. It therefore carries mergepath's governance and tooling: the review policy ([`REVIEW_POLICY.md`](../../REVIEW_POLICY.md)), the 1Password-backed deploy tooling ([`DEPLOYMENT.md`](../../DEPLOYMENT.md)), and this `docs/agents/` set. Five Across is a **consumer** of that template, not the template hub — the hub-only propagation/bootstrap docs alongside this one (e.g. [`propagation-ordering.md`](propagation-ordering.md), [`templated-propagation.md`](templated-propagation.md), [`bootstrap-runbook.md`](bootstrap-runbook.md)) describe machinery that runs in mergepath, not here.
