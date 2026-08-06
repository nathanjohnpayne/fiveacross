---
status: accepted
implemented: true
---

# The 18+ posture is a server-derived, public, monotone routing fact

## Context

The sign-in gate must know whether an Event contains adult material before authentication, but the source fields live on signed-in-only documents: active Prompts carry `spicy`, and the Event carries the Admin override `settings.forceAdult`. An Edition cannot answer this question because mature content is an Event property: a Five Across Event may be adult, while a Gay Cruise Bingo Event may have a tame pool.

Deriving the answer in the client would either require exposing the Prompt pool before sign-in or render explicit content before the acknowledgement settles. Treating every Event as adults-only is safe but mislabels general-audience Events and fabricates an age claim they never needed.

## Decision

Cloud Functions derive `adultContent = settings.forceAdult || any active spicy Prompt in a dealable pool` and publish `adultContent: true` onto every `hostnames/{host}` routing document for the Event. The value is monotone: automatic code never lowers it. Item writes, Event override writes, and hostname writes each have a dedicated idempotent trigger so an approval, a force-adult change, or a later alias all converge on the same invariant. Trigger failures throw so the platform retries them.

The routing field remains world-readable under ADR 0009's `get`-yes / `list`-no boundary. It discloses only the posture needed to render the public gate; it does not expose Prompts, membership, or an enumerable Event directory.

Clients fail closed. Missing, malformed, cached-unproven, or unreachable posture data reads as adults-only. A literal server-confirmed `false` is the only authority for hiding the acknowledgement. Open tabs watch the routing document so approving the first explicit Prompt re-gates un-attested Players, and every frozen-card publish path withholds explicit Prompts until the raised posture is visible.

A single-Event build may seed the initial posture with `VITE_ADULT_CONTENT=false`, but that is not authority and not a permanent opt-out. It still watches `hostnames/{current-host}`; a missing or failed live read returns the session to the gated posture. A non-adult single-Event deployment therefore requires the corresponding routing document as well as the build-time seed.

## Consequences

- The Functions deployment owns a security-relevant derived-data invariant and must include all three triggers.
- Hostname provisioning must write `eventId` correctly; a late canonical host or alias is reconciled from the Event and Prompt sources.
- Once an Event becomes 18+, removing the last explicit Prompt does not un-gate it automatically. An operator must make any exceptional correction deliberately.
- `attestedAdultAt` remains a global, cross-Event self-attestation, so it may be written only from an acknowledgement the Player actually supplied.
- Player stats remain client-authoritative under ADR 0001; this ADR changes ownership only for the pre-auth content posture.

## Considered alternatives

- **Derive from Edition** — rejected because Edition and adult content are independent axes.
- **Query Prompts from the signed-out client** — rejected because it widens the pre-auth data boundary and still races first paint.
- **Allow `true` to lower automatically** — rejected because a flapping gate cannot retract an acknowledgement already collected and creates new under-gating races.
- **Trust cached or build-time `false` indefinitely** — rejected because an Admin can approve the first explicit Prompt while a tab is open or a build remains deployed.
