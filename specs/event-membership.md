---
spec_id: event-membership
status: proposed
---

# Event membership — the non-self-writable admission record (`event-membership`)

The admission contract for epic [#801](https://github.com/nathanjohnpayne/gaycruisebingo/issues/801), consumed by every other child in it. It defines what a membership record is, where it lives, who may write it, the single predicate the two rules files transcribe, and the per-Event switch that lets enforcement land dark. It changes no rule and ships no UI: `firestore.rules`, `storage.rules` and `functions/**` are deliberately untouched, so that #803–#809 start from a settled shape instead of five divergent ones.

**Status is `proposed`, not `accepted`, and that is a deliberate signal.** The parts the code forces are settled and safe to build against — the invariant, the path, the single-`get()` constraint, the document shape, the predicate, the budget, and the enforcement switch. Two of the epic's open decisions are genuinely product (§ Decisions, D2/D8) and are recorded here as options rather than answers; D5 and D-A were ruled on by the owner 2026-08-18 and are now answers. Downstream tickets may implement everything under § Contract today; under § Decisions, the three the owner has ruled on (D5, D9, D-A) are commitments and the rest are not.

## The invariant

**A gate the reader can satisfy by writing its own admission record is not a gate.**

Every candidate record in the tree today is exactly that. `events/{eventId}/players/{uid}` is `allow create, update: if (isOwner(uid) || isAdmin(eventId)) && reshuffleCounterMonotonic()` (`firestore.rules:1007-1008`) with no membership precondition, so any signed-in account mints its own Player row under any Event id it knows and then satisfies any predicate keyed off that row. The same self-create shape exists at `items` (`:958-968`), `reshuffles` (`:1044-1053`), `proofs` (`:1202-1283`), `claims` (`:1305`), `markers` (`:1332-1337`), `doubts` (`:1351-1396`), `hearts` (`:1419-1456`) and `moments` (`:1466-1532`).

This is not a theoretical objection. [#844](https://github.com/nathanjohnpayne/gaycruisebingo/issues/844), filed from PR #838's review, reached it independently and from the other direction: `resolveAbuseEscalation` (`functions/src/bugReports.ts`) gates an admin alert on the reporter holding a Player document, and Codex correctly observed that the check is a fact the client asserts rather than one the platform knows. That issue's own conclusion — *"Some Event-scoped notion of legitimate participation that a client cannot mint"* — is what this spec specifies, and its first listed candidate ("a server-written membership fact — join goes through a callable that records something clients cannot write") is the shape adopted below.

The in-tree precedent for a record whose value depends on clients being unable to author it is `hostnames/{host}`: `allow get: if true; allow list: if false; allow create, update, delete: if false` (`firestore.rules:624-628`) — written only by the Admin SDK. Membership follows it exactly.

## Glossary

**Membership** — the organizer-issued record that a User is admitted to one Event. One document per (Event, User), non-self-writable, carrying the grant's provenance and its revocation. It is a *record*, not a person: a Player **holds** a Membership. *Avoid:* roster entry, admission ticket, invite (an invitation is the thing redeemed to produce one — #803).

**Admission** — the question the record answers: may this UID read or write inside this Event at all. Distinct from *privilege* (may they moderate — `EventDoc.admins`), from *visibility* (is their content shown — `EventDoc.bannedUids`), and from *blocking* (do two Players see each other — #689). *Avoid:* access, permission, authorization (all three are wider).

**Enforcement switch** — `EventDoc.membershipEnforcement`, the per-Event posture that decides whether that Event's rules consult admission at all. Absent and `'off'` both mean they do not. *Avoid:* feature flag (it is per-Event data, not a build or remote-config flag).

**Revocation** — moving a Membership's `status` from `'active'` to `'revoked'`. Ends admission going forward; it does not delete the record, the person's Marks, their Proofs, or their Leaderboard row. *Avoid:* ban (a different, presentational thing — see § Admins, bans and the three notions of not-welcome), removal, kick.

## Contract

### One document, one `get()`, no query

The record lives at **`events/{eventId}/memberships/{uid}`**, and the document id **is** the uid.

That is a constraint, not a convenience. `storage.rules` can only reach Firestore through `firestore.get()` / `firestore.exists()` on a fully-qualified path — it cannot run a query, and it has no `{database}` wildcard to interpolate, so the path is literally `/databases/(default)/documents/events/$(eventId)/memberships/$(request.auth.uid)` (compare the one existing cross-service call, `storage.rules:9`). Any shape that needed a lookup is therefore unreachable from Storage, and Storage is half the boundary (`storage.rules:30` — `allow read: if signedIn()` on all proof media). This single requirement eliminates:

- **a membership array on the Event document** — reachable, but it scales badly, it puts the roster inside a document that is already at Firestore's expression cap (#850), and every membership change would rewrite a document every rule reads;
- **a subcollection under `users/{uid}`** — not addressable from the Storage path, which carries `eventId` and `uid` but no way to know the Event's own identifiers;
- **anything keyed by an invitation id or a membership id** — not computable from `(eventId, uid)`.

`src/data/eventMembership.ts` exports `membershipPath()` and `membershipRulesPath()` so the client, the seeds and the two rules transcriptions all derive that string from one place.

**The Functions cannot import that module as written** (Codex P2 on PR #891). `functions/tsconfig.json` sets `rootDir: "src"`, so a runtime import from `../../src/**` fails with TS6059 — verified against the Functions compiler, not assumed. The two existing cross-tree imports (`functions/src/dailyEmailContent.ts:19`, `functions/src/finaleContent.ts:26`) work only because they are `import type` from a declaration-only `.d.ts`, which emits nothing, so they are not a precedent for runtime code. The repo does have a pattern for this shape of problem: `functions/src/scoringVocab.ts` mirrors `src/game/scoring.ts`, pinned by `tests/functions/finale-parity.test.ts`, which feeds one fixture to both sides and fails if either moves alone — because, as that mirror's own header puts it, a mirror without a parity test is how the podium implementations diverged in the first place. **That precedent is not automatically the right answer here, and this spec does not mandate it** (Codex P1 on PR #891). A hand-maintained mirror is a second implementation, which `docs/agents/code-modification-rules.md` prohibits outright and which contradicts this spec's own claim that admission has exactly one answer. The stakes also differ from the precedent: drift in `scoringVocab` mis-ranks a podium, whereas drift here is an authorization bug, and a fixture-based parity test only ever covers the cases someone thought to enumerate.

So the requirement #803 inherits is **one implementation, not two kept in step**: a build arrangement both projects can consume — a TypeScript project reference, a local workspace package, or a `rootDir` that spans the shared module — or, failing that, a mirror **generated** from this module rather than written by hand, so drift is impossible instead of merely detectable. A hand-written copy plus fixtures is the fallback of last resort and needs its own justification at the time. Choosing between those is #803's call, made against its own constraints; what this spec fixes is that TS6059 is real, that the two existing `../../src/` imports are type-only and are not a precedent for runtime code, and that duplicating the predicate is the outcome to avoid rather than the plan. Until #803 lands there is no second copy, so nothing can drift yet.

### Who may write it

**No client credential may write this collection, in any Event, ever.** Writes take the `hostnames` shape. Reads do **not** take the admission predicate, and the difference matters in both directions (Codex P1 on PR #891):

```
match /memberships/{uid} {
  // Self-inspection is NOT admission. A revoked member must still be able to
  // read their OWN record, or the client cannot tell them "you were removed
  // from this Event" and shows a permission error instead — and the
  // `denied-revoked` outcome this spec promises becomes unreachable.
  //
  // This arm is now the ONLY path to that outcome, so it is load-bearing rather
  // than a convenience (Phase 4b P1, round 3). An earlier draft ALSO carved the
  // Event document out of the admission gate to keep `membershipEnforcement`
  // readable after revocation; that carve-out is withdrawn, because it leaked
  // the whole Event document — settings, schedule, `admins`, `bannedUids` —
  // permanently, to exactly the people revocation removed. Everything the client
  // needs to render the removal state is in the record it reads here.
  allow get: if isOwner(uid) || (admitted(eventId) && isAdmin(eventId));
  // The roster is Admin-only AND admission-gated. Admin alone is not enough:
  // `EventDoc.admins` is client-writable, so an Admin can promote any UID by
  // editing the array, and that UID would otherwise list every member together
  // with `grantedBy`, `invitationId` and the revocation audit fields without
  // ever holding a membership. Admission alone is not enough either — that
  // would let any member enumerate the whole roster.
  allow list: if admitted(eventId) && isAdmin(eventId);
  allow create, update, delete: if false;
}
```

Reusing `admitted(eventId)` here would have been wrong twice over: too tight for the member reading their own revocation, and far too loose for the member reading everyone else's. **The admission predicate gates Event CONTENT; it does not gate the admission record itself.**

**Which makes `isAdmin()` load-bearing here, so revoking an Admin MUST be a two-part atomic write.** `isAdmin()` reads `EventDoc.admins` and knows nothing about membership, so a revocation implemented as a bare status flip would leave a revoked Admin still passing both branches above — able to read every membership record and list the whole roster, audit fields included, after being removed from the Event (Codex P1 on PR #891). **Revoking a membership therefore removes the uid from `EventDoc.admins`, if it is there, in the same transaction that flips `status` — keyed on the ARRAY, never on the record's `role`.**

Keying it on `role` would miss the common case (Codex P1 on PR #891). `EventDoc.admins` is client-writable by any existing Admin, and `memberships` is client-writable by nobody, so an Admin who promotes a member by editing the array produces a uid that **is** an Admin while its membership still reads `role: 'member'`. A `role`-conditioned removal would leave exactly that uid in `admins` after revocation, still passing `isAdmin()`. `role` records what the grant conferred; it is not a reliable statement of current privilege, and only the array is. This is the same invariant § The role model already states — admission is a precondition for privilege — carried through to the operation that can break it, and #803's revoke callable owns it.

The invariant is checkable rather than merely instructed: a revoked Admin left in `admins` is exactly an Admin with no active membership, which is what `adminsMissingMembership()` returns. It is the drift detector for both directions — an Admin never granted a membership, and an Admin whose membership was revoked without the array write — and it must be empty on any enforced Event. **The admin branches are conjoined with admission, which is a reversal.** An earlier draft rejected exactly that, on the grounds that it costs a second read and makes reading the admission record depend on the admission record. Both objections were weak and the second was wrong: rules do not recurse, and the reader's own membership is a *different* document from the one being read, so there is no circularity — only one more `get()` on a path that is not batched and not hot. The atomic removal above remains necessary but is no longer the sole defence, and it never covered promotion at all (Codex P1 on PR #891): an Admin who adds a UID to `admins` after enforcement creates a privileged account with **no** membership, which a revocation-only fix cannot reach. Conjoining admission closes the promotion gap and the revocation gap together, and does it with the same rule this spec applies everywhere else.

**The root cause is that `admins` is client-writable at all**, which is what lets privilege drift from the grant record. The durable fix is to route admin promotion and demotion through the same server path that writes memberships, so the array and the record move together and `role` becomes trustworthy. That is a change to the `events/{eventId}` update rule and to #803's callable surface, not something this spec settles — recorded here as the thing to fix rather than to keep compensating for. Until it lands, the array is authoritative and the removal above is keyed on it.

Creation cannot be a client transaction, for the same reason Event creation cannot be one (#785 § Contract facts) and for the same reason a handoff code cannot be (#548): the record's whole value is that the party it authorizes did not write it. Grants therefore arrive by exactly three Admin-SDK paths, and #803 owns the first:

1. **Invitation redemption** (#803) — a callable that consumes a single-use invitation and writes the membership in the same Firestore transaction that reads it, exactly as `exchangeAuthHandoff` consumes a handoff code (#548 / PR #842: *"a Firestore document rather than a stateless signed blob because single-use cannot be enforced statelessly"*). `invitationId` records which invitation was burned.
2. **Provisioner grant** (#793) — the launch provisioner grants the Event's creator a membership alongside `admins: [uid]`. `grantedBy` is `system:provisioner`, `invitationId` is `null`.
3. **Backfill** (#805) — the migration of the two live cohorts. `grantedBy` is `system:backfill`, `invitationId` is `null`. **Its Admin slice is ordered before path 1, not alongside it** (§ Rollout, step 2): invitation redemption cannot grant the FIRST membership on an Event, because the callable requires its issuing Admin to already hold one. Backfill is therefore the only grant path that can bootstrap an Event, and the only one whose authority comes from being server-side rather than from a prior membership.

Revocation is a server-side status flip on the same path, never a delete (§ Glossary).

### The document shape

Declared in `src/domainTypes.d.ts` as `MembershipDoc`. Fields: `schemaVersion`, `eventId`, `uid`, `role`, `status`, `grantedAt`, `grantedBy`, `invitationId`, and `revokedAt` / `revokedBy` once revoked.

**The path and `status` are frozen; everything else is versioned.** The two rules files transcribe exactly one field comparison — `status == 'active'` — and re-versioning it would put a rules deploy in lockstep with every data migration, which is the same deploy-ordering outage the enforcement switch exists to prevent, reintroduced one layer down. `schemaVersion` therefore gates the *parse* (`readMembership`, which reads a drifted version as a miss rather than coercing it, following the envelope convention `src/eventResolution.ts` uses for its hostname cache and ADR 0009 for the general rule) and never the authorization answer. `src/data/eventMembership.test.ts` pins that a version-drifted but active record still admits while still failing to parse — the property that keeps the TypeScript answer and the rules answer from diverging.

**Revocation is a status-dependent pair.** `revokedAt` and `revokedBy` both exist once `status` is `'revoked'`, and both are absent while it is `'active'`. `readMembership` reads any other combination as a miss rather than coercing it: silently dropping an unusable half hands a consumer a "parsed" revocation with no author and no date, which is precisely the provenance the record exists to carry, and retaining a stale half beside an active status is a half-applied write. This is a **parse** decision and never an authorization one — `admits` reads `status` alone, so an inconsistent revoked record still denies and an inconsistent active one still admits, exactly as the rules would. Strictness in the parse can change what a consumer may read; it must never change who gets in, or the reference stops mirroring the rules.

`eventId` and `uid` are denormalised out of the path because the Functions read these documents detached from their location, and because a future "which Events am I in?" lookup needs a collectionGroup query, which can filter on a field but not on a document id. **That query is deliberately not enabled by this spec.** A `{path=**}/memberships/{uid}` read rule would be a new cross-Event read surface of exactly the kind this epic exists to close — the same shape as the `{path=**}/markers/{markerUid}` rule (`firestore.rules:1770-1772`) that already delivers other Events' markers over the wire. Whoever enables it must bind it to `resource.data.uid == request.auth.uid`.

### The role model

`role` is `'member' | 'admin'`. **Admin is the only privileged role today** (`CONTEXT.md` § People), and a Host is a social identity that grants nothing, so the union is two-valued rather than speculative.

`role` is the record **of the grant**. `EventDoc.admins` remains the sole authority on **privilege** and is what `isAdmin()` reads (`firestore.rules:8-11`); no rule reads `role`. The two are held consistent by the server grant path and checked by `adminsMissingMembership()`.

**Admin does not imply admission.** The predicate has no `admins` disjunct. The reason is not budget — a disjunct would cost one extra textual call and no extra distinct document, since the switch already fetches the Event document — it is that `admins` is freely rewritable by any existing Admin (the `events/{eventId}` update rule validates `bannedUids` against `admins` at `:806-809` but never locks `admins` itself). If membership in that array granted admission, then admission would be grantable by an unaudited array write, with no `grantedBy`, no `invitationId`, and nothing to revoke — which makes #803's single-use, revocable, audited invitation path optional at exactly the moment it is supposed to be the only door.

**That invariant binds every privileged surface, not just the ones `firestore.rules` covers.** Four separate review rounds on PR #891 found it violated in four different places — roster reads, root Event update and delete, the invitation callable, and revocation itself — each time because `EventDoc.admins` is client-writable and each surface checked the array without checking admission. The rule is therefore stated once, generally: **anything that consults `EventDoc.admins` to authorize an action conjoins an active-membership check**, whether it is a Firestore rule, a Storage rule, or an Admin-SDK callable where no rule runs at all. A surface that checks the roster alone is a bug by construction. **The root cause is that `admins` is client-writable at all**, which is Decision D-A's territory. D-A is now ruled (§ Decisions): `admins` stays client-writable, so this conjunction is the permanent control rather than a placeholder, and any NEW privileged surface inherits the obligation.

**D-A's transitional bypass needs its own general statement, for the same reason the conjunction did.** Rounds 4–7 of PR #891 found one defect on four surfaces because the rule was restated per surface instead of once; the bypass then reproduced that exact pattern, because a disjunct also has to be transcribed onto every surface and each surface swallows it differently — `firestore.rules` composes a clean `false` from `exists()`, `storage.rules` gets an *error* from a bare `get()` on a missing document, and an Admin-SDK callable runs no rules at all. Stated once, generally: **anything transcribing D-A places the Admin disjunct where its own surface's failure mode cannot swallow it — before any access whose absence errors rather than returning false — and removes it in the same change that removes the `firestore.rules` disjunct.** A bypass that is merely *present* is not a bypass; Storage's must precede its membership `get()` or it can never fire for the backfill-missed Admin it exists for (§ The shared predicate).

**And the sharper rule the fourth round produced, which subsumes the scoping question: `admits()` gates ACCESS, never GRANT authority.** Access decisions are confined to the window in which they happen, so `admits()` may be — and deliberately is — permissive while an Event is unenforced. A grant is not confined to that window: the membership it writes is still there after the flip, and decisive. Any surface that acts on SOMEONE ELSE'S admission — issuing an invitation, revoking a membership — therefore authorizes from `mayAdministerMembership()`, which takes no enforcement input at all, rather than from `admits()` in any posture. **Redemption is the exception and must not be folded in** (Phase 4b P1, round 5): an invitee consuming a single-use invitation is minting a membership too, but they hold neither a membership nor a place in `admins`, so requiring either would reject every first-time redemption and leave only the provisioner and backfill paths — the same circular bootstrap § Rollout step 2 exists to break, one level down. Redemption is authorized by the authenticated invitee plus a valid unconsumed invitation bound to them, and by nothing about their prior admission, which is nil by definition. That predicate belongs to #803 with the invitation record; it is deliberately not written here while the invitation's shape is still open (§ Decisions, D4). The failure this closes is subtle precisely because `admits()` returns `true` in the vulnerable case: the permissive answer is correct for the question `admits()` was asked, and wrong for the question the caller meant.

**D-A is scoped to the two RULES surfaces, and the invitation callable is deliberately OUT of scope.** This is a scoping decision rather than an omission, so it is recorded rather than left to be inferred. The bypass exists to stop a backfill miss locking an Admin out of reading and writing their own Event — an outage, on surfaces where the alternative is a bare permission error the Admin cannot self-remedy. Issuing an invitation is not that: being unable to mint one is a deferred action rather than an outage, its remedy is the same server-side grant § Rollout step 2 already performs, and extending the bypass there would re-open round 7's P1 by letting a UID added to the client-writable array mint invitations while holding no admission at all — durably, since the memberships it writes survive the flip to `'enforced'`. The callable therefore keeps the strict conjunction in BOTH postures — but **not by calling `admits()` without the flag**, which an earlier draft of this paragraph claimed and which is wrong (Phase 4b P1, round 4). `admits()` answers ACCESS and is deliberately permissive while an Event is unenforced: it returns `admitted-unenforced` before `membership` is inspected at all. Since § Rollout step 3 runs this callable while every Event is still `'off'`, authorizing from `admits()` would have required no membership whatsoever, and a UID added to the client-writable array could have minted invitations whose memberships remain — and become decisive — after the flip. **`admits()` gates access; it never authorizes granting.** Anything that issues an invitation or revokes a membership asks `mayAdministerMembership()` instead: authenticated, present in the live `admins` roster, and holding an ACTIVE membership of their own, conjoined and enforcement-blind by construction, because there is no state of the switch in which handing out or withdrawing someone else's admission without holding your own is acceptable. Redemption is separately authorized and carries no such requirement — see § The role model.

The model instead requires the invariant **admission is a precondition for privilege**: every uid in `admins` holds an active Membership. `adminsMissingMembership()` returns the violating set, which is precisely the set of Admins a flip would lock out of their own Event, and #805 must drive it to empty before enforcing. The break-glass if one is missed is the enforcement switch, not a rules clause. A transitional `|| isAdmin(eventId)` disjunct during rollout is the ruled shape (§ Decisions, D-A): #804 ships it, and a follow-up removes it once #805's backfill is verified on both Events.

### The shared predicate

Three clauses, implemented once per surface and transcribed from the same reference. `src/data/eventMembership.ts` is that reference; `admits()` mirrors it clause for clause so a divergence is a test failure rather than a production denial.

**Firestore** (`firestore.rules`, ticket #804):

```
function membershipDoc(eventId, uid) {
  return /databases/$(database)/documents/events/$(eventId)/memberships/$(uid);
}

function membershipEnforced(eventId) {
  return get(/databases/$(database)/documents/events/$(eventId))
           .data.get('membershipEnforcement', 'off') == 'enforced';
}

function isEventMember(eventId, uid) {
  return exists(membershipDoc(eventId, uid))
    && get(membershipDoc(eventId, uid)).data.status == 'active';
}

function admitted(eventId) {
  return signedIn()
    && (!membershipEnforced(eventId)
        // TRANSITIONAL (Decision D-A) — REMOVE together with the storage.rules
        // form, in the same change, once #805's backfill is verified on both
        // Events. Present here because this snippet is what #804 transcribes:
        // an omission makes the canonical reference deny the backfill-missed
        // Admin the decision exists to protect, while `admits()` and the
        // Storage form admit them (Codex P1 on PR #891).
        //
        // Placement follows the same rule as Storage's, for a different
        // reason: here `exists()` yields a clean `false` rather than erroring,
        // so ordering is not forced — but keeping the disjunct in the SAME
        // position in both files is what makes the paired removal a mechanical
        // diff rather than a judgement call.
        || isAdmin(eventId)
        || isEventMember(eventId, request.auth.uid));
}
```

**Storage** (`storage.rules`, ticket #806) — the same decision, but **not the same shape**. Its budget is two Firestore accesses per evaluation, and this spec previously read that as "two documents" and then spent three calls on them (Codex P1 on PR #891). The membership side therefore collapses to a **single** `firestore.get()`:

```
function membershipEnforced(eventId) {
  return firestore.get(/databases/(default)/documents/events/$(eventId))
           .data.get('membershipEnforcement', 'off') == 'enforced';
}

// The Event document is fetched ONCE and threaded through, because the switch
// and the existing isEventAdmin() both need it and a second fetch would be a
// third access. Rules have no `let`, so the call site inlines the fetch and
// passes `.data` down — the same hoist prescribed for firestore.rules' boards
// clause, and here it is not an optimisation but the difference between
// fitting the budget and denying every admin moderation delete.
function admittedWith(ev, eventId) {
  return ev.get('membershipEnforcement', 'off') != 'enforced'
    // TRANSITIONAL (Decision D-A) — REMOVE with the firestore.rules disjunct.
    // Its POSITION is load-bearing and is not a style choice (Phase 4b P1,
    // round 3): it must precede the membership get(), because that get() ERRORS
    // on a missing document and an error denies the whole evaluation. Appended
    // AFTER the get(), `|| isEventAdminWith(ev)` is unreachable in precisely the
    // case D-A exists for — an Admin the backfill missed, who therefore has no
    // membership document at all. Placed here it also short-circuits before the
    // access is spent, so the bypass costs nothing against the two-document
    // ceiling. Storage would otherwise deny a caller that firestore.rules,
    // admits() and the Functions all admit.
    || isEventAdminWith(ev)
    // ONE access, not exists()+get(). A `get()` on a missing document ERRORS,
    // and an error denies — the answer a non-member should get anyway.
    || firestore.get(/databases/(default)/documents/events/$(eventId)/memberships/$(request.auth.uid))
         .data.status == 'active';
}

// isEventAdmin's existing body re-fetches the Event (storage.rules:7-10). #806
// must re-express it against the threaded `ev` instead, or the delete arm goes
// to three accesses.
function isEventAdminWith(ev) { return request.auth.uid in ev.admins; }

// Call site, e.g. the delete arm:
//   allow delete: if signedIn() && deleteOk(
//     firestore.get(/databases/(default)/documents/events/$(eventId)).data, eventId, uid);
//   function deleteOk(ev, eventId, uid) {
//     return admittedWith(ev, eventId) && (isOwner(uid) || isEventAdminWith(ev));
//   }
```

**`signedIn()` leads, and the TypeScript mirror must lead with it too.** An unenforced Event is open to every **signed-in** account, never to the public, so the authentication check precedes the enforcement switch rather than following it. This is where the reference implementation first drifted from the rules it mirrors: `admits()` originally answered from `enforcement` alone and would have admitted an unauthenticated caller for every Event in the dark-rollout state — which is every Event today (Codex P2 on PR #891). It now takes the caller's uid and denies its absence first. The lesson generalises: a divergence between the two is a silent authorization bug in whichever one a consumer happens to trust, which is why the parity properties below are tested rather than asserted in prose.

**The two files deliberately differ, and the difference is the budget.** Firestore uses `exists()` then `get()` — two calls on one document — because a clean `false` composes and an error does not. Storage cannot afford the second call: the switch already spends one of its two, so the membership check gets exactly one and relies on error-to-deny. That is safe there because the Storage arms conjoin admission with `isOwner`/`isEventAdmin` rather than falling through to them, so an error and a `false` reach the same verdict. **Anyone tempted to unify the two forms should unify them toward the Firestore shape and re-check the Storage budget first, not the other way round.**

Three properties are load-bearing and must survive any rewrite.

**The `exists()` precedes the `get()`**, so a stranger — the adversary case — short-circuits after one access call and never pays for the second; only a legitimate member pays both. And **the enforcement check precedes the membership check**, so an unenforced Event costs exactly one access call and no membership read at all, which is what makes landing dark cheap rather than merely possible. While Decision D-A's transitional disjunct is deployed, Storage orders it **between** those two — after the switch, before the membership `get()` — and that position is required rather than preferred: the `get()` errors on a missing document and an error denies the evaluation, so a bypass placed after it can never fire for the backfill-missed Admin it exists for. It also costs nothing, reading the already-threaded Event data and short-circuiting before the access is spent.

**Admission is CONJOINED with each rule's existing authorization, never disjoined.** The shape is `admitted(eventId) && <the rule's current condition>`. An earlier draft of this spec wrote `admitted(eventId) || isOwner(...)`, which is backwards and would have widened access rather than narrowing it: `boards` is owner/admin-only today (`:1105`) and `claims` likewise (`:1304`), so OR-ing admission in would have handed every member of an Event read access to every other member's private Board and Claims — a regression introduced by the very change meant to harden the boundary (Codex P1 on PR #891). Membership is an **additional** gate. It subtracts from what each rule already allows and never adds to it, and any rule that comes out of #804 more permissive than it went in is wrong on its face.

**The `exists()` is not redundant, and collapsing the predicate to a single `get()` is a trap.** Ticket #802 asks for "exactly one document `get()`", and the constraint that actually matters — one *document*, at a path computable from `(eventId, uid)`, with no query — is met; the call count is two because `get(path).data.status` on a missing document does not evaluate to false, it *errors*, and an erroring clause is not a false clause. Under pure conjunction an error and a `false` both deny, so this is a robustness property rather than the correctness one the same paragraph previously claimed on the strength of the withdrawn OR shape. It still earns its call: `admitted()` has an internal disjunction, #689's block predicate and the `momentRetractions` arms compose further, and a clause that yields `false` can be reasoned about locally while one that throws cannot.

### The rules-evaluation budget

Firestore's published limits are **10 `exists()`/`get()`/`getAfter()` calls per single-document request *and* per query request**, 20 for multi-document reads, transactions and batched writes *with the 10 still applying to each operation inside them*, and **1,000 evaluated expressions per request**. Cloud Storage's cross-service limit is different in kind: **no more than two Firestore documents per rules evaluation**. Firestore counts calls; Storage counts documents.

Firestore's caching note is *"some document access calls may be cached, and cached calls do not count towards the limits"* — a "may", not a guarantee. **This spec budgets textual access calls and treats de-duplication as headroom that was not spent.** Where the distinct-document count differs materially it is given alongside.

Predicate cost, worst case: **1 call** when the Event is unenforced (the Event document, then short-circuit), **2** when enforced and the caller is not a member, **3** when enforced and they are. Distinct documents added: one (`memberships/{uid}`) — the Event document is already fetched by every rule that calls `isAdmin()`. Decision D-A's transitional disjunct adds **no distinct document** for the same reason, and in Storage adds no access at all because it reads the threaded `ev`; in `firestore.rules` an un-hoisted `|| isAdmin(eventId)` costs one further *call* against the ten-call ceiling on a document already counted. That cost comes back out when the disjunct is removed.

| Rule | Lines | Today (textual / distinct) | + predicate, worst case | Verdict |
|---|---|---|---|---|
| `boards` create+update — **reshuffle** | `1106-1148` | **9 admin, 8 owner / 5** | **12 / 6** as written; **7 / 4** after finding 1's refactor | **Over the limit until the double-charges are paid off** |
| `moments` delete (owner retraction) | `1599-1606` | 3 / 3 | 6 / 4 | Fits |
| `boards` create+update (admin, non-reshuffle) | `1106-1148` | 2 / 1 | 5 / 2 | Fits |
| `meta` create (admin) | `1181-1189` | 2 / 1 | 5 / 2 | Fits |
| `moments` create (day-scoped) | `1466-1532` | 2 / 2 | 5 / 3 | Fits |
| `events/{eventId}` create+update | `796-916` | 2 / 2 | — | **Expression-capped, see below** |
| `players` create+update (admin) | `1007-1008` | 1 / 1 | 4 / 2 | Fits |
| `reshuffles` create | `1044-1053` | 1 / 1 | 4 / 2 | Fits |
| `doubts` create | `1351-1396` | 1 / 1 | 4 / 2 | Fits |
| `hearts` create | `1419-1456` | 1 / 1 | 4 / 2 | Fits |
| `claims` read | `1304` | 1 / 1 | 4 / 2 | Fits |
| `proofs` create; `claims` create; `markers` create+update; every bare `signedIn()` read | various | 0 / 0 | 3 / 2 | Fits |
| **Storage** `proofs/{eventId}/{uid}/{file}` read | `storage.rules:30` | 0 accesses | **2 accesses** (switch + one membership `get`) | **At the 2-access limit** |
| **Storage** `proofs` delete | `storage.rules:36` | 1 access | **3 accesses** as written; **2** once the Event fetch is threaded | **Over the limit without the hoist** |

Three findings the rules tickets must not rediscover at the emulator:

**1. The reshuffle board write has one call of headroom, and the predicate needs three — so the existing double-charges have to be paid off first.** The `boards` create/update clause (`:1106-1149`) spends **nine** textual calls on the admin path and **eight** on the owner path, who short-circuits `isAdmin`: one for `isAdmin` (`:8-11`), one for the `unlockAt` read, and seven inside `reshuffleOk()` (`:234-238`) — three in `reshuffleCounterPaired` (`:199-203`) and four in `reshuffleSpendMarked` (`:225-228`). The four is the surprising half: `reshuffleSpendMarkerDoc` (`:222-224`) reads like a path constructor beside `playerDoc`, but it embeds a `getAfter(playerDoc(...))` in the path it *returns*, so both of its call sites silently pay for the player document a second time. It survives today only because it collapses to five distinct (path, operation) pairs, and this spec will not spend a "may be cached".

**The gate must still apply to updates.** An earlier draft proposed appending `&& (resource != null || admitted(eventId))`, gating the create and letting mutations through for free. That is wrong, and Codex flagged it as blocking on PR #891: a member who is admitted, deals a board, and is then revoked would go on marking and reshuffling it forever, which contradicts this spec's own definition of revocation as stopping future writes. Any shape that skips admission on updates has the same hole, so the "gate the create, not the mutation" generalisation is withdrawn entirely rather than narrowed.

**The budget is recovered by removing the redundant reads, not by skipping the check.** Two refactors, both #804's to implement and neither changing any rule's meaning:

- **Hoist the Event document.** `isAdmin()`, the `unlockAt` comparison and the enforcement switch all read the same document. Rules have no `let`, but a helper can take the already-fetched `.data` as a parameter, so one `get()` serves all three instead of one each.
- **Parameterise the reshuffle counter.** `getAfter(playerDoc(...)).data.reshufflesUsed` is evaluated four times across `reshuffleCounterPaired` and the marker-path constructor. Computing it once at the `reshuffleOk` call site and passing it down collapses `reshuffleOk` from seven calls to four.

Worst case afterwards, admin reshuffle **with** the gate on both arms: one hoisted Event read + four in `reshuffleOk` + two for the membership = **seven of ten**, three to spare — cheaper than the eight or nine the path costs today. A plain Mark costs three. The double-charges, not the membership gate, were the budget problem.

This is a prescription, not a measurement: #804 must confirm it at the emulator, where #850's ten-Day fixture belongs too — and, since `e87c7f5` closed #850 with a short-circuit that only helps when Days are unchanged, the fixture that matters for this spec is the all-Days-differ one rather than the single-Day edit that commit targets.

**2. The `events/{eventId}` rule is expression-tight, and #850 relieved that CONDITIONALLY rather than structurally.** (#850 closed 2026-08-19 in `e87c7f5`, after this section was written; the finding is updated rather than deleted because most of it still holds.) Its create/update arm (`:796-916`) already exceeds the 1,000-expression cap on a ten-Day schedule — `daysThemeLockOk` (`:500-512`) and `daysScoringValid` (`:475-486`) are each ten-way unrolls, and the file itself records four separate checks weakened or deferred for that reason (`:464-469`, `:848-852`, `:874-879`, `:900-907`), with the repro parked as `it.skip` at `tests/rules/d15-admin-schedule.test.ts:274`. The membership work needs one expression there — not for a read gate, but to hold `membershipEnforcement` immutable to clients, which the rule does not do today because it has no key whitelist. **#850 is therefore a prerequisite of #804, not an unrelated bug**; the epic's dependency graph does not draw that edge and should. (Note the read arm, `:728`, is a separate rule and is not expression-capped — gating reads of the Event document is unaffected.)

**4. The per-operation budget is not the binding one — the 20-call BATCH aggregate is, and the Mark path already blows it.** This spec quoted the aggregate limit and then budgeted only per operation; Codex caught the gap on PR #891. Firestore allows 20 access calls across a batched write or transaction *in addition to* the 10 each operation gets, and the Mark path is not a single write:

- `setMark` (`src/data/api.ts:1940-2070`) commits **one batch** containing the acted Board, **one write per echoed sibling Board**, the Player row, and the Tally marker — `3 + E` operations for `E` echoes (`specs/echo-marks.md`).
- `reconcileEchoes` (`:2553-2576`) commits the repaired Board plus **one write per marker repair**, and a repair sweep can carry up to a full card's worth — `1 + M`, with `M` as large as 24.

At the conservative three admission calls per gated write, the aggregate is spent after **six** operations: a Mark with four echoes costs 21 before a single existing rule access, and a repair sweep costs far more. **Enforcement as specced would reject valid Echo Marks and repairs** — silently, as a permission error on a fire-and-forget batch, which is the failure shape hardest to attribute.

**A cheaper predicate does not solve this, and an earlier draft wrongly offered one as an independent remedy** (Codex P1 on PR #891). Two reasons it cannot work. The floor is not one call but **two** — collapsing `isEventMember` to a bare `exists()` still leaves the enforcement-switch lookup, so every gated write costs at least two. And even at one call per write, a full-card repair of 25 operations spends 25 against a limit of 20 before any existing rule access. **No per-write cost makes the largest documented batch fit.** Reducing the predicate lowers the multiplier and widens the ceiling on `setMark`; it does not lift it, and it must not be recorded as an alternative to the two things that do:

- **Prove cross-operation caching, first and in the emulator.** Every operation in the batch reads the *same* Event document for the switch, and every echoed board the same membership document. If Firestore's "some document access calls may be cached" collapses those across a batch, the aggregate is near-constant and the problem dissolves; if it does not, the arithmetic above stands unchanged. This single measurement decides the shape of the gate on the whole Mark path and is the first thing #804 must settle — everything else here is contingent on its answer.
- **Split or cap the batch** so the gated operations in any one commit stay inside the aggregate. At a two-call predicate that means at most ten gated writes per batch, which `setMark` satisfies up to seven echoes but which a full-card `reconcileEchoes` repair does not — so **repair batching has to change regardless of the caching answer**, unless caching proves out. That is a client change in #807's lane rather than a rules one, which makes it a cross-ticket dependency and not something #804 can absorb alone.

Recorded as a **blocking prerequisite of #804**: the gate cannot ship on the Mark path until the measurement is done and, if it comes back negative, until the batching changes.

**3. Storage has zero headroom, which fixes where the switch lives.** Two Firestore **accesses** is the whole budget — counted as calls, not as distinct paths, which is the stricter reading and the one this spec now takes after getting it wrong once. The switch spends one and the membership check spends the other, which is why the Storage membership check is a single `get()` rather than Firestore's `exists()`-then-`get()`. **And why `isEventAdmin()` cannot keep its own `get()`**: on the delete arm the switch, the membership and `isEventAdmin` would be three accesses, so #806 must thread one Event fetch through both the switch and the admin check or every admin moderation delete is denied on an enforced Event (Codex P1 on PR #891). A switch on any third document — a sentinel inside `memberships`, a sibling config collection — would be structurally unreadable from Storage. That is why `membershipEnforcement` is a field on `EventDoc` and not somewhere tidier, and why no future clause may add another cross-service read.

### The enforced-path inventory

What #804 and #806 gate, and — as importantly — what they must not.

**Gate (Event-scoped, currently open to any signed-in account).** `events/{eventId}` read (`:728`) — gated like every other arm; the carve-out an earlier draft granted it is withdrawn below — **and its update (`:796`) and delete (`:917`) arms**; `items` (`:940-985`); `players` (`:1006-1009`); `reshuffles` (`:1043-1054`); `boards` (`:1105-1149`, create **and** update); `meta` (`:1180-1190`); `proofs` (`:1198-1298`); `claims` (`:1304-1306`); `tally` (`:1324-1325`) and its nested `markers` (`:1331-1339`); `doubts` (`:1348-1403`); `hearts` (`:1418-1457`); `moments` (`:1465-1606`); `momentRetractions` (`:1652-1681`); `notices` (`:1693-1755`); and **`players/{uid}/analyticsTransitions`** (`:1015-1018`). That last one was originally filed here as "already closed" and is not: `allow read: if isOwner(uid) || isAdmin(eventId)` stays true for a revoked owner, so without a gate a revoked member keeps listening to server-authored Event transition records (Codex P2 on PR #891). Write is already `if false` and stays so; only the read arm gains admission as a conjunct. **An earlier draft carved the Event document out of this gate, and that carve-out is WITHDRAWN** (Phase 4b P1, round 3). It would have let anyone holding a membership record — *including a revoked one* — read `events/{eventId}` permanently. Firestore cannot expose a single field, so that is not read access to `membershipEnforcement`; it is read access to the Event's settings, schedule, `admins` roster and `bannedUids`, retained indefinitely by someone revocation was supposed to put out of the Event. It contradicted both this spec's central invariant and D5's ruling that revocation stops future reads.

Its stated justification does not survive contact with the rules as written. The claim was that a revoked member could otherwise never be told they were removed, because `admits()` needs `membershipEnforcement` to tell `denied-revoked` from `admitted-unenforced`. But **the client does not learn its revocation from the Event document — it learns it from its own membership record**, which `match /memberships/{uid}` already keeps self-readable through `allow get: if isOwner(uid) || …` no matter what admission says. A revoked caller reads `status: 'revoked'` at their own uid and renders the removal state from that. And the case where enforcement genuinely matters to the answer is the unenforced one — where the ordinary admission branch admits every signed-in account and the Event read is permitted anyway. The carve-out therefore bought nothing that the self-read does not already provide, at the cost of a permanent leak. `events/{eventId}` read is gated on active admission like every other arm.

**The root Event's write arms need admission too, and an earlier draft gated only its read** (Codex P1 on PR #891). `events/{eventId}` update and delete are `isAdmin(eventId)`-gated, and `EventDoc.admins` is client-writable, so an Admin who adds a UID to that array after enforcement creates a privileged non-member who can rewrite the Event's settings, rewrite the admin roster itself, and **delete the Event** — while holding no membership at all. Gating only the read left the most destructive operations in the file ungated. `create` is deliberately excluded: it is the provisioner's Admin-SDK path (#793), which bypasses rules entirely, and the existing client-side create arm is already unsatisfiable because `isAdmin(eventId)` reads a document that does not exist yet.

**This lands on the rule that was already at the expression cap**, alongside the `membershipEnforcement` immutability clause from finding 2. Both additions target `events/{eventId}` update.

**#850 is now closed (`e87c7f5`), and #804 must not read that as headroom.** The fix short-circuits an unchanged Day — `newDay == oldDay ||` ahead of the field checks — so a write that edits ONE Day costs one comparison for each of the other nine instead of a full expansion. That is a large win in the common case and **no win at all in the worst one**: a write that changes every Day still expands all ten, which is the shape a bulk reschedule takes. So the ordering dependency is discharged, but the budget question is not, and #804 adds to the same arm either way. Confirm at the emulator against a ten-Day fixture in which **every** Day differs, not merely the one-Day edit `e87c7f5` was written to fix — the passing case after that commit is the cheap one.

Most read arms above are a bare `signedIn()`, but **not all of them** — `boards` (`:1105`) and `claims` (`:1304`) are already owner/admin-only. Those two keep their existing predicate and gain admission as a conjunct; they must not be loosened to `signedIn() && admitted(...)`.

**Gate (Storage).** `proofs/{eventId}/{uid}/{file}` read, create/update and delete (`storage.rules:29-37`). The read arm is the widest surface in either file.

**Gate (Admin-SDK callables).** The inventory above covers the two rules files, and an earlier draft stopped there — which left the surfaces where **no rule runs at all** unenumerated even though § The role model already declared them in scope (CodeRabbit, Security & Privacy Major, on PR #891). Firestore rules do not protect a callable invoked through the Admin SDK, so `EventDoc.admins` being client-writable is unmitigated on these paths unless the callable checks admission itself:

- **`manualUnlockNow`** (`functions/src/unlockDay.ts:1031`) — unlocks a Day on demand.
- **`resnapshotDayIfNoBoards`** (`functions/src/unlockDay.ts:1079`) — OVERWRITES a Day's snapshot.

Both authorize through `isEventAdmin(event, uid)` (`functions/src/unlockDay.ts:479`), which is `event.admins.includes(uid)` and nothing else. A UID added to the array by any existing Admin can therefore unlock a Day or rewrite a Day's snapshot while holding no admission at all. Both conjoin an active-membership check against the caller's own record, per § The role model's general rule, and both are named in § Acceptance criteria so the requirement is testable rather than implied. Neither takes Decision D-A's transitional bypass: like #803's invitation callable, these MINT or REWRITE state that outlives the unenforced window, and § The role model scopes D-A to the two rules surfaces.

**Do not gate.**

- **`resolveAbuseEscalation`** (`functions/src/bugReports.ts:79`) reads `EventDoc.admins` and must NOT gain this conjunction, despite matching the grep. It is not an authorization check: it answers "does this reporter have a relationship with this Event?" to decide whether an abuse report escalates to that Event's admins, and it already treats the `players` row as an equally valid answer. Conjoining membership would make a real participant read as a stranger during the entire pre-backfill window and silently stop escalating their reports — a fail-OPEN on moderation dressed as a fail-closed on admission. It also already fails closed correctly on its own terms, returning `null` rather than `false` when the lookup cannot be completed. Recorded here because it is the one roster read in `functions/` that a later sweep would otherwise "fix".
- **`hostnames/{host}`** (`:624-628`) stays `allow get: if true`. It resolves before there is a signed-in user at all, so a membership gate there breaks sign-in for everyone. ADR 0009 already reconciles this: a Slug is not a secret, and the `get`-yes/`list`-no split *is* the safety property. Pinned by `tests/rules/hostnames-lookup.test.ts`.
- **`users/{uid}`** (`:631-643`) and **`avatars/{file}`** (`storage.rules:23-26`) are global identity, cross-Event by design (`specs/x-multi-event-schema.md`: a Player's identity and avatar carry to the next Event). **Decided and closed** — profiles stay global and membership enforcement does not reach them (§ Decisions, D9). This is a chosen limit, not an omission: #804 and #806 must leave both paths exactly as they are.
- **`bugReports`, `bugReportRateLimits`, `authHandoffs`, `emailPrefs`, `adminAlerts`, `adminAlertBatches`** are already fully closed (`allow read, write: if false`). Adding a gate would be noise, and the `authHandoffs` deny is load-bearing in both directions.
- **Nothing narrows mark visibility *inside* an Event.** ADR 0002 is explicit that publishing each Mark to its Prompt's Tally is intended and must not be locked down. Membership narrows who is in the room, never what a member sees of other members. A rules change that hides Tally entries from co-members is a regression, not hardening.

**Cannot be gated as written.** `/{path=**}/markers/{markerUid}` (`:1770-1772`) is `allow read: if signedIn()` and **binds no `eventId` at all**, so no Event-scoped predicate is expressible there. It exists because `useTallyCards` runs a `collectionGroup(db, 'markers')` and filters the Event inside the callback (`src/hooks/useData.ts:768`, `:779` — the epic cites `:767`, which is one line off) — the client genuinely receives other Events' markers over the wire today. Narrowing this rule before that query is scoped denies the whole listen rather than filtering it, which is the #294/#314 failure mode verbatim: a denied collectionGroup listen looks intermittent, because the reader's own writes still render. **#807 must land before #804 touches this rule** — a second edge the epic's graph does not draw, and the reason #807 is not merely a parallel lane.

**Not closed by rules at all.** An already-minted `getDownloadURL` token is a bearer capability that `storage.rules` never sees. Tightening Storage does nothing to a URL already pasted into a group chat. That is the PRD's own risk row and epic Decision 6; it belongs to #806 as an inventory-then-decision, and this spec's predicate does not pretend to address it.

### Admins, bans, and the three notions of not-welcome

Four Event-scoped notions now exist and must stay disjoint, or the codebase acquires overlapping half-answers to the same question.

| | Who decides | What it controls | Where it lives | Rules-enforced? |
|---|---|---|---|---|
| **Admission** (this spec) | Organizer, via an invitation | Whether you may read or write in the Event at all | `memberships/{uid}.status` | Yes, once enforced |
| **Privilege** | Existing Admin | Whether you may moderate, approve, resolve | `EventDoc.admins` | Yes, today (`isAdmin()`) |
| **Ban** | Admin | Whether *your content* is shown to others | `EventDoc.bannedUids` | No — presentational (ADR 0004 Phase 0) |
| **Block** (#689) | Player, reciprocal | Whether *two Players* see each other | not yet built | Planned |

**A banned member is still a member, and ban does not enter the predicate.** `bannedUids` is documented in `src/domainTypes.d.ts` as *"NOT hard access revocation"* — an Event-scoped hide/mute of a Player's content that never gates posting or reads server-side. Its only rules appearance is a validation that a banned uid is disjoint from `admins` (`:806-809`), which is a well-formedness check on the field, not an access decision. So the two compose rather than contend: ban answers "is your content shown", admission answers "are you in the room". If the intent is to put someone *out* of the room, that is revocation. `admits()` accepts an `isBanned` argument and provably ignores it, so the non-interaction is stated and tested rather than left as an omission a later reader might "fix".

**Revocation and ban are not substitutes.** Revoking stops future reads and writes; it does not retract Marks, Proofs, Tally entries or a Leaderboard row (ADR 0001 — the honor-system record is a social artefact, not a ledger to rewrite; ADR 0002 — a Mark is already public in its Prompt's Tally). An Admin who wants a person's content gone bans them; an Admin who wants them out of the Event revokes them; the two are independently useful and frequently both. The full menu of revocation semantics was epic Decision 5 (§ Decisions, D5); the owner ruled option (a) on 2026-08-18, so this paragraph is now the contract rather than a recommendation.

### The enforcement switch, and landing dark

`EventDoc.membershipEnforcement?: 'off' | 'enforced'`. **Absent reads as `'off'`.**

Fail-open on a security switch is deliberate and the reasoning has to be exact. Every Event document in existence predates the field, and both live cohorts joined by self-creating `players` rows, so a deploy that read a missing field as "enforce" would deny every current player mid-Event. The safety property is not the default; it is that enforcement is turned on **per Event, explicitly, after that Event's backfill is verified** (#805). `membershipEnforcementFor()` is the only place the default lives, and it enforces only on a literal `'enforced'` — the same defensive posture `dailyEmailEnabled` is read with server-side, so a half-written Event document degrades to today's behaviour rather than to an outage.

The rollout order is therefore fixed, and each step is checkable rather than merely instructed:

1. This spec and its types land (#802). Nothing changes at runtime.
2. **Seed the existing Admins' memberships, server-side** (a slice of #805, and it must land BEFORE #803's callable is enabled). Grant an active membership to every uid already in each Event's `admins`, then assert `adminsMissingMembership()` is empty for both live Events. **This step exists because the bootstrap is circular** (Codex P2 on PR #891): § Decisions D8 requires the invitation callable to authorize against the live roster AND an active membership, conjoined, so an Admin needs a membership to issue the very invitations that create memberships. Without this step neither live Event can begin the rollout at all — every Admin is refused by the callable, and there is no other path that writes a membership. The seeding is a server-side write for the same reason the flip is: no client credential may mint admission. **The alternative was considered and rejected**: making the callable enforcement-aware, so the roster alone authorizes while an Event is `'off'`, would relax the round 7 P1 conjunction during precisely the window in which a self-promoted UID could mint itself a **durable** membership that survives the flip to `'enforced'` — converting a transient exposure into a permanent admission, which is the one thing the enforcement switch cannot walk back. Reordering carries no equivalent residual.
3. Invitations mint and redeem, writing memberships, while every Event is still `'off'` (#803).
4. **Freeze the switch before anything reads it** (#804, deploy 1): ship the immutability clause alone, so no client can write `membershipEnforcement`, while no rule yet consults it. This deploy changes no behaviour.
5. **Scrub and verify**: assert that every Event document carries `membershipEnforcement` absent or `'off'`. **This step is not optional and the window it closes is real** (Codex P1 on PR #891). Between this spec landing and step 3, the field exists in the contract while the Event update arm still accepts arbitrary writes to it — so an Admin can set `'enforced'` today. Shipping the freeze and the gate in one deploy would then freeze that pre-set value *and* immediately honour it, enforcing an Event before its backfill and locking out its whole cohort — the exact outage the switch exists to prevent, delivered by the deploy that was supposed to be a no-op.
6. The rules ship **with the switch consulted and every Event off** (#804, deploy 2), after #850 and #807. Now a no-op for both live cohorts, because the scrub-and-verify step (5) proved there is nothing to honour.
7. Backfill each Event and drive `adminsMissingMembership()` to empty (#805).
8. Flip that Event to `'enforced'` — a server-side write, since the freeze step (4) made the field non-client-writable. Flipping back is one field and is the break-glass.

The switch must not be client-writable, and today it would be: the `events/{eventId}` update rule has no key whitelist, so an Admin could flip their own Event's isolation off. #804 adds the immutability clause — which is the one expression that makes #850 a prerequisite (§ budget, finding 2). If #850 slips, shipping the switch as admin-writable is a viable descope whose cost is exactly that an Admin (or a compromised Admin account) can downgrade their own Event's posture to today's; it should be a recorded decision rather than an accident.

## Acceptance criteria

- **Given** the membership path and a client credential for any UID, **when** that client attempts to create, update or delete its own membership document, **then** the model requires denial, and the clause #804 must add is named above: `allow create, update, delete: if false` on `match /memberships/{uid}`.
- **Given** an `(eventId, uid)` pair, **when** the predicate is evaluated, **then** it resolves through document accesses at paths computable from that pair alone, with no query — so `storage.rules` can perform the identical check via `firestore.get()` / `firestore.exists()`.
- **Given** an Event with an Admin who holds no membership, **when** the predicate runs, **then** the Admin is **not** admitted; `adminsMissingMembership()` names them, and #805 must return the empty set before that Event is enforced.
- **Given** a UID in `bannedUids` holding an active membership, **when** the predicate runs, **then** they are admitted: ban is presentational and admission is not, and the predicate demonstrably ignores the ban.
- **Given** an Event with no `membershipEnforcement` field, **when** the predicate runs, **then** everyone signed in is admitted, with the outcome distinguishable from a real admission.
- **Given** a membership written at a schema version this build does not understand, **when** it is read, **then** the parse yields a miss while the authorization answer still admits if `status` is `'active'`.
- **Given** a UID present in `EventDoc.admins` but holding no active membership, **when** `manualUnlockNow` or `resnapshotDayIfNoBoards` is invoked by that UID, **then** the callable refuses — because no Firestore rule runs on an Admin-SDK path, so the conjunction has to be in the callable itself, and both are named in § Contract rather than left to a reader to infer from the general rule.
- **Given** an abuse report from a UID with a `players` row but no membership, **when** `resolveAbuseEscalation` runs, **then** it still reports a relationship and the report still escalates — the deliberate non-gate, asserted so a later sweep cannot quietly conjoin membership there and stop escalating real participants' reports.
- **Given** the heaviest existing rules path, **when** the added accesses are counted, **then** the spec records the worst case against the published limit — and it records that the reshuffle board write does **not** fit as written, with the two refactors that make it fit while admission still gates create **and** update.

## Decisions

Epic #801 surfaced nine. Four are answered here because the code forces them, two have been ruled on by the owner (D5 and D9), and the rest are still open — plus **D-A**, which this spec adds and the owner ruled on the same day. Nothing in § Contract depends on the open ones.

**Answered by the code.**

- **D1 — the membership record is a sibling roster, not a promoted `players/{uid}`.** Promoting the Player row fails on three counts. It is written by the client inside a `runTransaction` on the join path (`src/data/api.ts:401-460`) and concurrently by the lazy Day-Card deal, a race the code already documents and guards; a server-owned create cannot participate in that client transaction, so promotion means either moving every stat write server-side or a create/update field-split whose per-field rules are the delicate part. It conflates a record that must never be rewritten (a grant and its provenance) with one rewritten on every Mark. And it makes revocation destructive of Leaderboard history, which ADR 0001 and ADR 0002 forbid. **The losing option's merit is real and worth recording:** `CONTEXT.md` already defines Player as *"A User's membership and stats within one Event"*, so the sibling roster does leave two documents describing one relationship. This spec resolves that by narrowing the vocabulary rather than the data — after this lands, `players/{uid}` is a **stats row**, not an admission, and a Player row with no Membership is exactly the pre-enforcement state that #805 backfills. Both nouns are in `CONTEXT.md` § People.
- **D8 (partial) — Admin does not imply admission**, and `EventDoc.admins` is not a second membership system. Reasoning in § The role model. The *product* half of D8 (may a Host invite?) is still open below.
- **The switch lives on `EventDoc`** — forced by Storage's two-access ceiling (§ budget, finding 3).
- **`schemaVersion` gates the parse and not the authorization answer** — forced by the deploy-ordering hazard of putting a rules deploy in lockstep with a data migration.

**Answered by the owner.**

- **D9 — profiles stay global; membership enforcement does not cover `users/{uid}` or avatars.** *Decided by Nathan, 2026-08-18, via the coordinating session.* A User is one identity across Events (`CONTEXT.md` § People), and display names and photos are the low-sensitivity tier. **The isolation guarantee this epic delivers covers Event CONTENT — boards, proofs, marks, claims, media — not profile identity.**

  **The residual, at full strength.** These are two different exposures and the weaker description of either would misrepresent the decision, so both are stated exactly as the rules permit:

  - **`users/{uid}` is readable by any signed-in account** — `allow read: if signedIn()` (`firestore.rules:631-643`). Not scoped to the Event, and not limited to display name and photo: the clause exposes the whole document, which per `UserDoc` is `displayName`, `handle`, `photoURL`, `customPhoto`, `createdAt` and `attestedAdultAt`.
  - **`avatars/{file}` is readable by ANYONE, with no authentication whatsoever** — `allow read: if true` (`storage.rules:23-26`). Not "any signed-in account": no account at all, no sign-in, public internet. And the object name is *derivable* rather than merely guessable, because the write clause on the next line pins it to `request.auth.uid + '.jpg'` — so a bare UID yields the avatar URL directly.

  UIDs are not secret and are discoverable from Feed, Tally and Leaderboard data inside an Event, so both are reachable in practice rather than in theory. **Both predate this epic**; Phase 3 neither introduces nor widens them, and #804 and #806 leave both rules untouched. Accepted as the low-sensitivity tier.

  One factual note that the decision's framing did not reach, recorded rather than acted on: `attestedAdultAt` is the one field above that is not a display name or a photo — it is the honor-system 18+ self-attestation (ADR 0001). D9 stands as decided and nothing here reopens it; this is flagged only so that a later reader does not conclude the field was overlooked.

  **The exit condition is therefore qualified, and #809 must be written against the qualified bar.** The PRD's Phase 3 exit condition — *"two unrelated groups can use the Five Across production project without seeing or modifying one another's information or media"* — is satisfied **for Event content, with profile identity as a stated, deliberate exception**. #809's two-cohort acceptance criteria assert the qualified property; a test that asserts the literal PRD sentence would fail against a system behaving exactly as designed, and reading that failure as a defect would be the wrong conclusion. Anyone revisiting this should reopen D9 rather than treat it as a bug.

- **D5 — revocation stops future reads and writes, and nothing else.** *Decided by Nathan, 2026-08-18, via the coordinating session.* Option (a) of three: (a) stop future reads and writes only; (b) also hide the person's existing content from other members; (c) delete it. (a) was already this spec's working assumption, so the ruling changes no clause of § Contract — it converts an assumption into a commitment the five downstream tickets can encode. The reasons it is also the right answer: (b) and (c) collide with ADR 0002 (a Mark is already public in every co-member's Tally) and ADR 0001 (the honor record is a social artefact, not a ledger to rewrite), and (a) is the only option needing no new machinery. **Bans remain the separate tool** for hiding a person's content, per § Revocation and ban are not substitutes. **Still open inside (a):** does revocation invalidate already-minted media download tokens? That is Decision 6 and belongs to #806.
- **D-A — ship the transitional `|| isAdmin(eventId)` disjunct, then remove it.** *Decided by Nathan, 2026-08-18, via the coordinating session.* #804 ships the disjunct; a follow-up removes it once #805's backfill is verified on both Events. It costs one extra textual call and no extra distinct document, and it removes the "Admin locked out of their own Event by a backfill miss" failure mode. **The accepted cost, stated plainly:** while the disjunct is in place, admission is grantable by a raw `admins` array write, so during rollout the array is still a privilege path that bypasses admission — which is exactly the exposure the four PR #891 P1 rounds found. The mitigations are that the window is bounded by #805's verification, and that the general rule of § The role model still binds every surface, so nothing NEW may authorize from the roster alone. **Scope:** the two rules surfaces only — `firestore.rules` and `storage.rules`. The invitation callable is deliberately excluded and keeps the strict conjunction in both postures (§ The role model gives the reasoning; pinned in `src/data/eventMembership.test.ts`). **The rejected alternative is worth recording:** routing promotion and demotion through a server path would make `admins` non-client-writable and collapse several compensating conjunctions into a single invariant — a simpler spec than this one. It was not chosen because it is a larger change than the rollout needs; if it is ever revisited, § The role model and D8's authorization note are the two places that simplify.

**Recorded, needs the owner.**

- **D2 — do existing Events grandfather their members?** Backfilling from today's `players` rows admits every drive-by account that ever signed in; requiring re-invitation re-onboards a live cohort mid-Event; backfilling only rows with evidence of play (a Mark, a Proof, a Claim) locks out real-but-idle players. #805 implements the answer and must not default to one. Unblocked for now: enforcement is off everywhere, so nothing waits on this until the scrub-and-verify step (5) of the rollout — renumbered from 4 when the Admin-seeding step was inserted at 2, and named here so a later insertion cannot rot the reference.
- **D8 — who may issue an invitation?** Admins only, or Host too? `CONTEXT.md` is blunt that *"A Host is a social identity, not a permission"*, so "Hosts may invite" is a new role rather than a rules tweak. The model leaves room: it would be a third value in `MembershipRole` and **no rules change**, because no rule reads `role`. **But the callable must not authorize from `role`** (Codex P2 on PR #891). `role` is grant-time and `EventDoc.admins` is client-writable, so the two drift both ways — an array-edit demotion leaves `role: 'admin'` on someone who is no longer an Admin, and would let them keep issuing invitations; an array-edit promotion leaves `role: 'member'` on a real Admin, and would falsely deny them. Whatever the answer to this decision, the invite callable authorizes against the **live roster AND an active membership, conjoined** — not the roster alone (Codex P1 on PR #891). Firestore rules do not protect an Admin-SDK callable, so the admission gates specced above are simply absent on that path; a UID added to the client-writable `admins` array without a membership would otherwise exercise a privileged operation while holding no admission at all. **That conjunction is bootstrappable only because § Rollout step 2 seeds the existing Admins' memberships server-side before this callable is enabled** (Codex P2 on PR #891) — without that ordering the requirement is not merely strict but unsatisfiable, since every Admin on both live Events would be refused by the very callable that mints the memberships they need. `membershipRoleSatisfies()` stays a way to reason about what a grant conferred rather than a permission check. That drift disappears only if promotion and demotion are routed through the server path (§ The role model) — the root fix D-A considered and **declined**, so the drift is a standing condition rather than something a later ticket removes for free. Any answer to this decision must therefore hold with `admins` client-writable. Should be answered together with #793's mirror-image question of who may create an Event.
- **D3, D4, D6, D7** — whether GCB is ever enforced; the invitation's shape and UX; the download-token disposition; and whether in-session Event switching ships. None is resolved here and none blocks this spec.

## Test coverage

- `src/data/eventMembership.test.ts` — the whole pure surface. The path is computable from `(eventId, uid)` with the uid as the document id and no query; the Storage absolute form carries the literal `(default)`; `status == 'active'` is the only admission, including against truthy near-misses a JS-only reading might let through. The versioned parse round-trips, carries the revocation audit fields, and reads version drift, corruption and shape drift as a miss. The parity property: a version-drifted but active record still admits while failing to parse. The role lattice both ways. The switch reading absent as `'off'`, enforcing only on a literal `'enforced'`, and degrading an unrecognised value rather than failing closed into an outage. `admits()` across all five outcomes, including that a `PlayerDoc`-shaped object is **not** evidence of admission, that a banned member is still admitted, and that an Admin without a membership is not. `adminsMissingMembership()` on the empty, missing, revoked, duplicate and malformed cases.
- `src/data/eventMembership.test.ts` also pins the two parity properties Codex round 1 turned up on PR #891: an unauthenticated caller is denied **before** the enforcement switch is consulted (so an unenforced Event is not an open one), and rejecting an internally inconsistent record is a parse decision that leaves the admission answer untouched in both directions.
- **Not covered here, by design.** No Functions-side coverage: nothing on that side consumes these predicates yet, and § One document requires #803 to reach ONE implementation rather than a second copy — if it nonetheless lands a generated mirror, the generation check is its test, not a fixture comparison. No emulator layer: that the deployed rules agree with this reference belongs to #804 (`tests/rules/event-membership.test.ts`, alongside the existing `tests/rules/` suites) and #806 (`tests/rules/w0-storage-rules.test.ts`, which already loads both rules files for the Storage↔Firestore lockstep check). The two-cohort adversarial gate is #809. Until those land, this spec's claims about rules are claims about rules that do not exist yet, and the spec says so.
