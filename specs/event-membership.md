---
spec_id: event-membership
status: proposed
---

# Event membership — the non-self-writable admission record (`event-membership`)

The admission contract for epic [#801](https://github.com/nathanjohnpayne/gaycruisebingo/issues/801), consumed by every other child in it. It defines what a membership record is, where it lives, who may write it, the single predicate the two rules files transcribe, and the per-Event switch that lets enforcement land dark. It changes no rule and ships no UI: `firestore.rules`, `storage.rules` and `functions/**` are deliberately untouched, so that #803–#809 start from a settled shape instead of five divergent ones.

**Status is `proposed`, not `accepted`, and that is a deliberate signal.** The parts the code forces are settled and safe to build against — the invariant, the path, the single-`get()` constraint, the document shape, the predicate, the budget, and the enforcement switch. Three of the epic's open decisions are genuinely product (§ Decisions, D2/D5/D8) and are recorded here as options rather than answers. Downstream tickets may implement everything under § Contract today; nothing under § Decisions is a commitment until the owner rules on it.

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

**The Functions cannot import that module, and must mirror it instead** (Codex P2 on PR #891). `functions/tsconfig.json` sets `rootDir: "src"`, so a runtime import from `../../src/**` fails with TS6059 — verified against the Functions compiler, not assumed. The two existing cross-tree imports (`functions/src/dailyEmailContent.ts:19`, `functions/src/finaleContent.ts:26`) work only because they are `import type` from a declaration-only `.d.ts`, which emits nothing, so they are not a precedent for runtime code. The repo already has the right pattern for this: `functions/src/scoringVocab.ts` mirrors `src/game/scoring.ts`, and `tests/functions/finale-parity.test.ts` feeds one fixture to both sides and fails if either moves alone — because, as that mirror's own header puts it, a mirror without a parity test is how the podium implementations diverged in the first place. **#803 therefore adds `functions/src/membershipVocab.ts` plus a parity test when its callable first needs these predicates**, and does not relax `rootDir` to dodge the mirror: the `.d.ts` type contract is genuinely shared, the runtime predicate is genuinely duplicated, and a parity test is what keeps the duplication honest. Until #803 lands there is no second copy, so nothing can drift yet.

### Who may write it

**No client credential may write this collection, in any Event, ever.** The rules arm #804 adds is the `hostnames` shape:

```
match /memberships/{uid} {
  allow read: if <the predicate below>;
  allow create, update, delete: if false;
}
```

Creation cannot be a client transaction, for the same reason Event creation cannot be one (#785 § Contract facts) and for the same reason a handoff code cannot be (#548): the record's whole value is that the party it authorizes did not write it. Grants therefore arrive by exactly three Admin-SDK paths, and #803 owns the first:

1. **Invitation redemption** (#803) — a callable that consumes a single-use invitation and writes the membership in the same Firestore transaction that reads it, exactly as `exchangeAuthHandoff` consumes a handoff code (#548 / PR #842: *"a Firestore document rather than a stateless signed blob because single-use cannot be enforced statelessly"*). `invitationId` records which invitation was burned.
2. **Provisioner grant** (#793) — the launch provisioner grants the Event's creator a membership alongside `admins: [uid]`. `grantedBy` is `system:provisioner`, `invitationId` is `null`.
3. **Backfill** (#805) — the migration of the two live cohorts. `grantedBy` is `system:backfill`, `invitationId` is `null`.

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

The model instead requires the invariant **admission is a precondition for privilege**: every uid in `admins` holds an active Membership. `adminsMissingMembership()` returns the violating set, which is precisely the set of Admins a flip would lock out of their own Event, and #805 must drive it to empty before enforcing. The break-glass if one is missed is the enforcement switch, not a rules clause. A transitional `|| isAdmin(eventId)` disjunct during rollout is a defensible variant (§ Decisions, D-A).

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
    && (!membershipEnforced(eventId) || isEventMember(eventId, request.auth.uid));
}
```

**Storage** (`storage.rules`, ticket #806) — the identical decision, two documents:

```
function membershipEnforced(eventId) {
  return firestore.get(/databases/(default)/documents/events/$(eventId))
           .data.get('membershipEnforcement', 'off') == 'enforced';
}

function isEventMember(eventId) {
  return firestore.exists(/databases/(default)/documents/events/$(eventId)/memberships/$(request.auth.uid))
    && firestore.get(/databases/(default)/documents/events/$(eventId)/memberships/$(request.auth.uid))
         .data.status == 'active';
}
```

**`signedIn()` leads, and the TypeScript mirror must lead with it too.** An unenforced Event is open to every **signed-in** account, never to the public, so the authentication check precedes the enforcement switch rather than following it. This is where the reference implementation first drifted from the rules it mirrors: `admits()` originally answered from `enforcement` alone and would have admitted an unauthenticated caller for every Event in the dark-rollout state — which is every Event today (Codex P2 on PR #891). It now takes the caller's uid and denies its absence first. The lesson generalises: a divergence between the two is a silent authorization bug in whichever one a consumer happens to trust, which is why the parity properties below are tested rather than asserted in prose.

Three properties are load-bearing and must survive any rewrite.

**The `exists()` precedes the `get()`**, so a stranger — the adversary case — short-circuits after one access call and never pays for the second; only a legitimate member pays both. And **the enforcement check precedes the membership check**, so an unenforced Event costs exactly one access call and no membership read at all, which is what makes landing dark cheap rather than merely possible.

**The `exists()` is not redundant, and collapsing the predicate to a single `get()` is a trap.** Ticket #802 asks for "exactly one document `get()`", and the constraint that actually matters — one *document*, at a path computable from `(eventId, uid)`, with no query — is met; the call count is two because `get(path).data.status` on a missing document does not evaluate to false, it *errors*, and an erroring clause is not a false clause. It denies the whole evaluation instead of yielding `false` to the surrounding expression, so a bare `get()` poisons every disjunction it sits inside — and #804 will need exactly those, since most rules here are `admitted(eventId) || isOwner(...)` or `admitted(eventId) || isAdmin(eventId)` shaped. `exists() && get()` yields a clean `false` and composes. The one place a single `get()` is safe is where the predicate is the entire condition, which is not worth a second, subtly different form of the same check.

### The rules-evaluation budget

Firestore's published limits are **10 `exists()`/`get()`/`getAfter()` calls per single-document request *and* per query request**, 20 for multi-document reads, transactions and batched writes *with the 10 still applying to each operation inside them*, and **1,000 evaluated expressions per request**. Cloud Storage's cross-service limit is different in kind: **no more than two Firestore documents per rules evaluation**. Firestore counts calls; Storage counts documents.

Firestore's caching note is *"some document access calls may be cached, and cached calls do not count towards the limits"* — a "may", not a guarantee. **This spec budgets textual access calls and treats de-duplication as headroom that was not spent.** Where the distinct-document count differs materially it is given alongside.

Predicate cost, worst case: **1 call** when the Event is unenforced (the Event document, then short-circuit), **2** when enforced and the caller is not a member, **3** when enforced and they are. Distinct documents added: one (`memberships/{uid}`) — the Event document is already fetched by every rule that calls `isAdmin()`.

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
| **Storage** `proofs/{eventId}/{uid}/{file}` read | `storage.rules:30` | 0 documents | **2 documents** | **At the 2-document limit** |
| **Storage** `proofs` delete | `storage.rules:36` | 1 document | **2 documents** | **At the limit** |

Three findings the rules tickets must not rediscover at the emulator:

**1. The reshuffle board write has one call of headroom, and the predicate needs three — so the existing double-charges have to be paid off first.** The `boards` create/update clause (`:1106-1149`) spends **nine** textual calls on the admin path and **eight** on the owner path, who short-circuits `isAdmin`: one for `isAdmin` (`:8-11`), one for the `unlockAt` read, and seven inside `reshuffleOk()` (`:234-238`) — three in `reshuffleCounterPaired` (`:199-203`) and four in `reshuffleSpendMarked` (`:225-228`). The four is the surprising half: `reshuffleSpendMarkerDoc` (`:222-224`) reads like a path constructor beside `playerDoc`, but it embeds a `getAfter(playerDoc(...))` in the path it *returns*, so both of its call sites silently pay for the player document a second time. It survives today only because it collapses to five distinct (path, operation) pairs, and this spec will not spend a "may be cached".

**The gate must still apply to updates.** An earlier draft proposed appending `&& (resource != null || admitted(eventId))`, gating the create and letting mutations through for free. That is wrong, and Codex flagged it as blocking on PR #891: a member who is admitted, deals a board, and is then revoked would go on marking and reshuffling it forever, which contradicts this spec's own definition of revocation as stopping future writes. Any shape that skips admission on updates has the same hole, so the "gate the create, not the mutation" generalisation is withdrawn entirely rather than narrowed.

**The budget is recovered by removing the redundant reads, not by skipping the check.** Two refactors, both #804's to implement and neither changing any rule's meaning:

- **Hoist the Event document.** `isAdmin()`, the `unlockAt` comparison and the enforcement switch all read the same document. Rules have no `let`, but a helper can take the already-fetched `.data` as a parameter, so one `get()` serves all three instead of one each.
- **Parameterise the reshuffle counter.** `getAfter(playerDoc(...)).data.reshufflesUsed` is evaluated four times across `reshuffleCounterPaired` and the marker-path constructor. Computing it once at the `reshuffleOk` call site and passing it down collapses `reshuffleOk` from seven calls to four.

Worst case afterwards, admin reshuffle **with** the gate on both arms: one hoisted Event read + four in `reshuffleOk` + two for the membership = **seven of ten**, three to spare — cheaper than the eight or nine the path costs today. A plain Mark costs three. The double-charges, not the membership gate, were the budget problem.

This is a prescription, not a measurement: #804 must confirm it at the emulator, where #850's ten-Day fixture belongs too.

**2. The `events/{eventId}` rule cannot absorb one more expression, so #850 blocks #804.** Its create/update arm (`:796-916`) already exceeds the 1,000-expression cap on a ten-Day schedule — `daysThemeLockOk` (`:500-512`) and `daysScoringValid` (`:475-486`) are each ten-way unrolls, and the file itself records four separate checks weakened or deferred for that reason (`:464-469`, `:848-852`, `:874-879`, `:900-907`), with the repro parked as `it.skip` at `tests/rules/d15-admin-schedule.test.ts:274`. The membership work needs one expression there — not for a read gate, but to hold `membershipEnforcement` immutable to clients, which the rule does not do today because it has no key whitelist. **#850 is therefore a prerequisite of #804, not an unrelated bug**; the epic's dependency graph does not draw that edge and should. (Note the read arm, `:728`, is a separate rule and is not expression-capped — gating reads of the Event document is unaffected.)

**3. Storage has zero headroom, which fixes where the switch lives.** Two documents is the whole budget, the membership record is one of them, and the Event document is the other. A switch on any third document — a sentinel inside `memberships`, a sibling config collection — would be structurally unreadable from Storage. That is why `membershipEnforcement` is a field on `EventDoc` and not somewhere tidier, and why no future clause may add a third cross-service read.

### The enforced-path inventory

What #804 and #806 gate, and — as importantly — what they must not.

**Gate (Event-scoped, currently open to any signed-in account).** `events/{eventId}` read (`:728`); `items` (`:940-985`); `players` (`:1006-1009`); `reshuffles` (`:1043-1054`); `boards` (`:1105-1149`, create-side only per finding 1); `meta` (`:1180-1190`); `proofs` (`:1198-1298`); `claims` (`:1304-1306`); `tally` (`:1324-1325`) and its nested `markers` (`:1331-1339`); `doubts` (`:1348-1403`); `hearts` (`:1418-1457`); `moments` (`:1465-1606`); `momentRetractions` (`:1652-1681`); `notices` (`:1693-1755`). Every read arm above is a bare `signedIn()`.

**Gate (Storage).** `proofs/{eventId}/{uid}/{file}` read, create/update and delete (`storage.rules:29-37`). The read arm is the widest surface in either file.

**Do not gate.**

- **`hostnames/{host}`** (`:624-628`) stays `allow get: if true`. It resolves before there is a signed-in user at all, so a membership gate there breaks sign-in for everyone. ADR 0009 already reconciles this: a Slug is not a secret, and the `get`-yes/`list`-no split *is* the safety property. Pinned by `tests/rules/hostnames-lookup.test.ts`.
- **`users/{uid}`** (`:631-643`) and **`avatars/{file}`** (`storage.rules:23-26`) are global identity, cross-Event by design (`specs/x-multi-event-schema.md`: a Player's identity and avatar carry to the next Event). Whether that is acceptable is epic Decision 9 (§ Decisions, D9); this spec does not narrow it.
- **`bugReports`, `bugReportRateLimits`, `authHandoffs`, `emailPrefs`, `adminAlerts`, `adminAlertBatches`, `analyticsTransitions`** are already fully closed (`allow read, write: if false`, or owner/admin-only). Adding a gate would be noise, and the `authHandoffs` deny is load-bearing in both directions.
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

**Revocation and ban are not substitutes.** Revoking stops future reads and writes; it does not retract Marks, Proofs, Tally entries or a Leaderboard row (ADR 0001 — the honor-system record is a social artefact, not a ledger to rewrite; ADR 0002 — a Mark is already public in its Prompt's Tally). An Admin who wants a person's content gone bans them; an Admin who wants them out of the Event revokes them; the two are independently useful and frequently both. The full menu of revocation semantics is epic Decision 5 (§ Decisions, D5) and this paragraph is the recommended option, not a ruling.

### The enforcement switch, and landing dark

`EventDoc.membershipEnforcement?: 'off' | 'enforced'`. **Absent reads as `'off'`.**

Fail-open on a security switch is deliberate and the reasoning has to be exact. Every Event document in existence predates the field, and both live cohorts joined by self-creating `players` rows, so a deploy that read a missing field as "enforce" would deny every current player mid-Event. The safety property is not the default; it is that enforcement is turned on **per Event, explicitly, after that Event's backfill is verified** (#805). `membershipEnforcementFor()` is the only place the default lives, and it enforces only on a literal `'enforced'` — the same defensive posture `dailyEmailEnabled` is read with server-side, so a half-written Event document degrades to today's behaviour rather than to an outage.

The rollout order is therefore fixed, and each step is checkable rather than merely instructed:

1. This spec and its types land (#802). Nothing changes at runtime.
2. Invitations mint and redeem, writing memberships, while every Event is still `'off'` (#803).
3. The rules ship **with the switch consulted and every Event off** (#804), after #850 and #807. A rules deploy at this point is a no-op for both live cohorts.
4. Backfill each Event and drive `adminsMissingMembership()` to empty (#805).
5. Flip that Event to `'enforced'`. Flipping back is one field and is the break-glass.

The switch must not be client-writable, and today it would be: the `events/{eventId}` update rule has no key whitelist, so an Admin could flip their own Event's isolation off. #804 adds the immutability clause — which is the one expression that makes #850 a prerequisite (§ budget, finding 2). If #850 slips, shipping the switch as admin-writable is a viable descope whose cost is exactly that an Admin (or a compromised Admin account) can downgrade their own Event's posture to today's; it should be a recorded decision rather than an accident.

## Acceptance criteria

- **Given** the membership path and a client credential for any UID, **when** that client attempts to create, update or delete its own membership document, **then** the model requires denial, and the clause #804 must add is named above: `allow create, update, delete: if false` on `match /memberships/{uid}`.
- **Given** an `(eventId, uid)` pair, **when** the predicate is evaluated, **then** it resolves through document accesses at paths computable from that pair alone, with no query — so `storage.rules` can perform the identical check via `firestore.get()` / `firestore.exists()`.
- **Given** an Event with an Admin who holds no membership, **when** the predicate runs, **then** the Admin is **not** admitted; `adminsMissingMembership()` names them, and #805 must return the empty set before that Event is enforced.
- **Given** a UID in `bannedUids` holding an active membership, **when** the predicate runs, **then** they are admitted: ban is presentational and admission is not, and the predicate demonstrably ignores the ban.
- **Given** an Event with no `membershipEnforcement` field, **when** the predicate runs, **then** everyone signed in is admitted, with the outcome distinguishable from a real admission.
- **Given** a membership written at a schema version this build does not understand, **when** it is read, **then** the parse yields a miss while the authorization answer still admits if `status` is `'active'`.
- **Given** the heaviest existing rules path, **when** the added accesses are counted, **then** the spec records the worst case against the published limit — and it records that the reshuffle board write does **not** fit, with the create-side-only shape that does.

## Decisions

Epic #801 surfaced nine. Four are answered here because the code forces them; five need the owner. Nothing in § Contract depends on the five.

**Answered by the code.**

- **D1 — the membership record is a sibling roster, not a promoted `players/{uid}`.** Promoting the Player row fails on three counts. It is written by the client inside a `runTransaction` on the join path (`src/data/api.ts:401-460`) and concurrently by the lazy Day-Card deal, a race the code already documents and guards; a server-owned create cannot participate in that client transaction, so promotion means either moving every stat write server-side or a create/update field-split whose per-field rules are the delicate part. It conflates a record that must never be rewritten (a grant and its provenance) with one rewritten on every Mark. And it makes revocation destructive of Leaderboard history, which ADR 0001 and ADR 0002 forbid. **The losing option's merit is real and worth recording:** `CONTEXT.md` already defines Player as *"A User's membership and stats within one Event"*, so the sibling roster does leave two documents describing one relationship. This spec resolves that by narrowing the vocabulary rather than the data — after this lands, `players/{uid}` is a **stats row**, not an admission, and a Player row with no Membership is exactly the pre-enforcement state that #805 backfills. Both nouns are in `CONTEXT.md` § People.
- **D8 (partial) — Admin does not imply admission**, and `EventDoc.admins` is not a second membership system. Reasoning in § The role model. The *product* half of D8 (may a Host invite?) is still open below.
- **The switch lives on `EventDoc`** — forced by Storage's two-document ceiling (§ budget, finding 3).
- **`schemaVersion` gates the parse and not the authorization answer** — forced by the deploy-ordering hazard of putting a rules deploy in lockstep with a data migration.

**Recorded, needs the owner.**

- **D-A — a transitional `|| isAdmin(eventId)` disjunct during rollout?** Costs one extra textual call and no extra distinct document. It removes the "Admin locked out of their own Event by a backfill miss" failure mode at the price of making admission grantable by a raw `admins` array write while it is in place. A reasonable shape is to ship it in #804, remove it in a follow-up once #805's backfill is verified on both Events. Recommended, but it is a risk-appetite call.
- **D2 — do existing Events grandfather their members?** Backfilling from today's `players` rows admits every drive-by account that ever signed in; requiring re-invitation re-onboards a live cohort mid-Event; backfilling only rows with evidence of play (a Mark, a Proof, a Claim) locks out real-but-idle players. #805 implements the answer and must not default to one. Unblocked for now: enforcement is off everywhere, so nothing waits on this until step 4 of the rollout.
- **D5 — revocation semantics.** (a) stop future reads and writes only; (b) also hide the person's existing content from other members; (c) delete it. This spec's contract assumes **(a)** and says so, because (b) and (c) collide with ADR 0002 (a Mark is already public in every co-member's Tally) and ADR 0001 (the honor record is a social artefact, not a ledger to rewrite) — and because (a) is the only one that needs no new machinery. If the owner picks (b), it is a new presentational filter that composes with `bannedUids` rather than a change to this predicate; (c) is a data-deletion feature with its own ticket. Also open inside (a): does revocation invalidate already-minted media download tokens? That is Decision 6 and belongs to #806.
- **D8 — who may issue an invitation?** Admins only, or Host too? `CONTEXT.md` is blunt that *"A Host is a social identity, not a permission"*, so "Hosts may invite" is a new role rather than a rules tweak. The model leaves room: it would be a third value in `MembershipRole` plus a server-side `membershipRoleSatisfies()` check on the invite callable, and **no rules change**, because no rule reads `role`. Should be answered together with #793's mirror-image question of who may create an Event.
- **D3, D4, D6, D7, D9** — whether GCB is ever enforced; the invitation's shape and UX; the download-token disposition; whether in-session Event switching ships; and whether `users/{uid}` and avatars come inside the boundary. None is resolved here and none blocks this spec. D9 is worth an explicit note: two unrelated cohorts sharing one project can still enumerate each other's display names and photos given a UID (`firestore.rules:631-643`, `storage.rules:23-26`), which is deliberate today because identity is cross-Event — but it is a real residual in the epic's exit condition and should be accepted in writing rather than by silence.

## Test coverage

- `src/data/eventMembership.test.ts` — the whole pure surface. The path is computable from `(eventId, uid)` with the uid as the document id and no query; the Storage absolute form carries the literal `(default)`; `status == 'active'` is the only admission, including against truthy near-misses a JS-only reading might let through. The versioned parse round-trips, carries the revocation audit fields, and reads version drift, corruption and shape drift as a miss. The parity property: a version-drifted but active record still admits while failing to parse. The role lattice both ways. The switch reading absent as `'off'`, enforcing only on a literal `'enforced'`, and degrading an unrecognised value rather than failing closed into an outage. `admits()` across all five outcomes, including that a `PlayerDoc`-shaped object is **not** evidence of admission, that a banned member is still admitted, and that an Admin without a membership is not. `adminsMissingMembership()` on the empty, missing, revoked, duplicate and malformed cases.
- `src/data/eventMembership.test.ts` also pins the two parity properties Codex round 1 turned up on PR #891: an unauthenticated caller is denied **before** the enforcement switch is consulted (so an unenforced Event is not an open one), and rejecting an internally inconsistent record is a parse decision that leaves the admission answer untouched in both directions.
- **Not covered here, by design.** No Functions parity test: there is no `functions/src/membershipVocab.ts` yet, and a parity test with one side missing tests nothing. #803 adds the mirror and its parity test together, on the `tests/functions/finale-parity.test.ts` pattern — the coupling is stated in § One document so the mirror cannot land without it. No emulator layer: that the deployed rules agree with this reference belongs to #804 (`tests/rules/event-membership.test.ts`, alongside the existing `tests/rules/` suites) and #806 (`tests/rules/w0-storage-rules.test.ts`, which already loads both rules files for the Storage↔Firestore lockstep check). The two-cohort adversarial gate is #809. Until those land, this spec's claims about rules are claims about rules that do not exist yet, and the spec says so.
