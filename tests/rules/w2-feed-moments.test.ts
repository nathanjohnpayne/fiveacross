import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, writeBatch, type Firestore } from 'firebase/firestore';

// specs/w2-feed-moments.md — the Moments rules contract (ADR 0002). Pinned against
// the block that shipped from #16/#18, was TIGHTENED in PR #99 (Codex P2) — the
// create rule bounds createdAt near request.time (finding 3) and the update path was
// removed so a Moment is fully immutable (finding 4) — and was tightened again in #103
// to bind the doc id to the payload kind. A Moment is an own-beat, self-published
// broadcast: a Player may create ONLY a Moment carrying their own uid (a forged uid is
// denied), at the deterministic id its kind implies (issue #103), with a valid kind +
// non-empty ≤100 displayName + a numeric, near-now createdAt; reads are public; a
// Moment is fully immutable (no update path); deletable by its owner or an admin.
//
// Two design-critical facts this suite PINS honestly (see the spec):
//   1. The create rule BINDS the doc id to the payload kind (issue #103): the event-
//      singleton `first_bingo` must carry kind 'first_bingo', and every other id must
//      equal `${uid}-${kind}` — the writer's deterministic scheme (src/data/moments.ts).
//      With `update` DENIED for everyone, a re-broadcast to an already-written
//      deterministic id hits the deny-all `update` rule and is denied (admins included),
//      so the once-only dedup is STRUCTURAL — and the id can no longer be squatted with
//      a mismatched kind (the first_bingo denial-of-ceremony hole #103 closes). This is
//      the strongest dedup the rules allow.
//   2. The create rule has NO hasOnly/keys() constraint, so it does NOT reject a
//      Moment carrying extra media/proofId fields. The ADR 0002 "a Moment carries
//      no evidence" guarantee is therefore a WRITER + TYPE contract (moments.ts
//      writes exactly the MomentDoc fields; MomentDoc has no media/proofId), NOT a
//      rules-layer one — pinned here so no one mistakes the rule for enforcing it.
// The PERMISSION_DENIED lines the SDK logs are the expected assertFails denials.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB, CAROL] = ['admin-uid', 'alice', 'bob', 'carol'];
const NOW = () => Date.now();

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;
const momentPath = (id: string) => at(`moments/${id}`);
// The Moment shape moments.ts writes: { kind, uid, displayName, photoURL, createdAt }.
const moment = (uid: string, over: Record<string, unknown> = {}) => ({
  kind: 'bingo',
  uid,
  displayName: uid,
  photoURL: null,
  createdAt: NOW(),
  ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-w2-feed-moments',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// Each test starts clean with a canonical Event and a foreign Moment (Carol's) so
// the public-read + owner/admin-delete invariants have something to read against.
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.firestore();
    await setDoc(doc(s, `events/${EVENT}`), {
      name: 'Cruise', sailStart: '2026-01-01', sailEnd: '2026-01-07', status: 'active',
      defaultTheme: 'neon-playground', claimMode: 'honor', admins: [ADMIN],
      settings: { reportHideThreshold: 3 },
      // Ten minimal Days: the per-card blackout id arm (#267) bounds its Day to
      // the schedule (`dayIndex < days.size()`), so the fixture needs a real
      // array. Entries stay minimal — only event UPDATES run the schedule lock.
      days: Array.from({ length: 10 }, (_, index) => ({ index })),
    });
    await setDoc(doc(s, momentPath(`${CAROL}-bingo`)), moment(CAROL));
  });
});

describe('firestore.rules — Feed Moments (specs/w2-feed-moments.md)', () => {
  it('a Player self-publishes their OWN Moment (BINGO / Blackout / First-to-BINGO)', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), momentPath(`${ALICE}-bingo`)), moment(ALICE)));
    await assertSucceeds(
      setDoc(doc(db(ALICE), momentPath(`${ALICE}-blackout`)), moment(ALICE, { kind: 'blackout' })),
    );
    await assertSucceeds(
      setDoc(doc(db(ALICE), momentPath('first_bingo')), moment(ALICE, { kind: 'first_bingo' })),
    );
  });

  it('denies a forged uid — a Player cannot broadcast a Moment as someone else', async () => {
    // isOwner(request.resource.data.uid) requires the doc's uid == the caller.
    await assertFails(setDoc(doc(db(ALICE), momentPath(`${BOB}-bingo`)), moment(BOB)));
    await assertFails(setDoc(doc(db(ALICE), momentPath('spoof')), moment(BOB)));
  });

  it('binds the doc id to the payload kind on create — the first_bingo singleton cannot be squatted (issue #103)', async () => {
    // The create rule binds momentId to the payload, mirroring the writer's
    // deterministic scheme (src/data/moments.ts): the event singleton `first_bingo`
    // requires kind 'first_bingo', and every other id must be `${uid}-${kind}`. Without
    // it any signed-in Player could create moments/first_bingo with a MISMATCHED kind —
    // the read-side filter (useData.ts hasCanonicalMomentId) would hide it, but a Moment
    // is fully immutable, so the legitimate First-to-BINGO create would then be denied
    // FOREVER as a doc-exists update (a denial-of-ceremony squat). Each assertion below
    // turns SOLELY on the id↔kind binding — uid, kind, displayName and createdAt are all
    // otherwise valid, so the binding is the only clause that can flip the outcome.
    const p = (id: string) => doc(db(ALICE), momentPath(id));
    // The squat: the singleton id carrying a non-first_bingo kind is DENIED (the hole).
    await assertFails(setDoc(p('first_bingo'), moment(ALICE, { kind: 'bingo' })));
    // The canonical singleton create (kind first_bingo AT id first_bingo) is ALLOWED.
    await assertSucceeds(setDoc(p('first_bingo'), moment(ALICE, { kind: 'first_bingo' })));
    // A per-Player id whose kind does not match its `${uid}-${kind}` id is DENIED:
    // `${ALICE}-bingo` carrying kind 'blackout' is not `${ALICE}-blackout`.
    await assertFails(setDoc(p(`${ALICE}-bingo`), moment(ALICE, { kind: 'blackout' })));
    // The matching per-Player create (the deterministic id the writer uses) is ALLOWED.
    await assertSucceeds(setDoc(p(`${ALICE}-blackout`), moment(ALICE, { kind: 'blackout' })));
    // The documented HARMLESS ORPHAN (specs/w2-feed-moments.md): `${uid}-first_bingo`
    // satisfies the per-Player binding (uid + '-' + kind), so the rules ALLOW the
    // create — the writer never targets it and hasCanonicalMomentId keeps it out of
    // every Feed (first_bingo renders only from the literal singleton id). Pinned so
    // a future edit cannot silently tighten or loosen this documented allowance
    // (CodeRabbit nitpick, PR #105).
    await assertSucceeds(setDoc(p(`${ALICE}-first_bingo`), moment(ALICE, { kind: 'first_bingo' })));
  });

  it('allows the PER-CARD blackout id `${uid}-blackout-d${dayIndex}` only when the id Day matches the payload (#267)', async () => {
    const p = (id: string) => doc(db(ALICE), momentPath(id));
    // The canonical per-card create: day-scoped id, matching integer dayIndex.
    await assertSucceeds(setDoc(p(`${ALICE}-blackout-d3`), moment(ALICE, { kind: 'blackout', dayIndex: 3 })));
    // A SECOND Day's card posts its own Moment — distinct id, same Player.
    await assertSucceeds(setDoc(p(`${ALICE}-blackout-d7`), moment(ALICE, { kind: 'blackout', dayIndex: 7 })));
    // The id's Day must equal the payload's dayIndex — a mismatch is denied.
    // A FRESH id (d8), not one created above: a reused id would be denied as an
    // immutable-doc update regardless, masking the create-rule condition under
    // test (Codex P3 on #277).
    await assertFails(setDoc(p(`${ALICE}-blackout-d8`), moment(ALICE, { kind: 'blackout', dayIndex: 5 })));
    // A day-suffixed id with NO dayIndex field is denied (nothing to bind to).
    await assertFails(setDoc(p(`${ALICE}-blackout-d4`), moment(ALICE, { kind: 'blackout' })));
    // A non-integer dayIndex is denied.
    await assertFails(setDoc(p(`${ALICE}-blackout-d4`), moment(ALICE, { kind: 'blackout', dayIndex: '4' })));
    // Out-of-schedule Days are denied (Codex P2 on #277): the Day must index a
    // real entry of the Event's `days` — no unbounded junk-doc minting.
    await assertFails(setDoc(p(`${ALICE}-blackout-d10`), moment(ALICE, { kind: 'blackout', dayIndex: 10 })));
    await assertFails(setDoc(p(`${ALICE}-blackout-d999999`), moment(ALICE, { kind: 'blackout', dayIndex: 999999 })));
    await assertFails(setDoc(p(`${ALICE}-blackout-d-1`), moment(ALICE, { kind: 'blackout', dayIndex: -1 })));
    // The day-scoped form is for the PER-CARD kinds only (#372 added bingo — see
    // its own test below): the event-wide `first_bingo` singleton cannot ride it,
    // or the ceremony would mint one per Day instead of one per Event.
    await assertFails(setDoc(p(`${ALICE}-first_bingo-d3`), moment(ALICE, { kind: 'first_bingo', dayIndex: 3 })));
    // Forged owner: Alice cannot create Bob's per-card blackout id.
    await assertFails(setDoc(p(`${BOB}-blackout-d3`), moment(ALICE, { kind: 'blackout', dayIndex: 3 })));
    // The legacy day-less per-Player id still works (asserted above too) — and a
    // legacy id carrying a dayIndex payload stays valid: the binding constrains
    // the day-SUFFIXED id form, not the field's presence.
    await assertSucceeds(
      setDoc(doc(db(BOB), momentPath(`${BOB}-blackout`)), moment(BOB, { kind: 'blackout', dayIndex: 2 })),
    );
  });

  it('allows the PER-CARD bingo id `${uid}-bingo-d${dayIndex}` only when the id Day matches the payload (#372)', async () => {
    const p = (id: string) => doc(db(ALICE), momentPath(id));
    // The canonical per-card create: day-scoped id, matching integer dayIndex.
    await assertSucceeds(setDoc(p(`${ALICE}-bingo-d3`), moment(ALICE, { kind: 'bingo', dayIndex: 3 })));
    // The bug this closes (#372): a SECOND Day's bingo posts its own Moment.
    // Under the pre-#372 once-per-Player `${uid}-bingo` id this create was a
    // doc-exists update on an immutable Moment, so every bingo after a Player's
    // first was silently denied and never reached the Feed.
    await assertSucceeds(setDoc(p(`${ALICE}-bingo-d7`), moment(ALICE, { kind: 'bingo', dayIndex: 7 })));
    // The id's Day must equal the payload's dayIndex — a mismatch is denied. A
    // FRESH id (d8), not one created above: a reused id would be denied as an
    // immutable-doc update regardless, masking the create-rule condition under
    // test (Codex P3 on #277).
    await assertFails(setDoc(p(`${ALICE}-bingo-d8`), moment(ALICE, { kind: 'bingo', dayIndex: 5 })));
    // A day-suffixed id with NO dayIndex field is denied (nothing to bind to).
    await assertFails(setDoc(p(`${ALICE}-bingo-d4`), moment(ALICE, { kind: 'bingo' })));
    // A non-integer dayIndex is denied.
    await assertFails(setDoc(p(`${ALICE}-bingo-d4`), moment(ALICE, { kind: 'bingo', dayIndex: '4' })));
    // Out-of-schedule Days are denied (the #277 Codex P2 bound, inherited by the
    // shared arm): the Day must index a real entry of the Event's `days`.
    await assertFails(setDoc(p(`${ALICE}-bingo-d10`), moment(ALICE, { kind: 'bingo', dayIndex: 10 })));
    await assertFails(setDoc(p(`${ALICE}-bingo-d999999`), moment(ALICE, { kind: 'bingo', dayIndex: 999999 })));
    await assertFails(setDoc(p(`${ALICE}-bingo-d-1`), moment(ALICE, { kind: 'bingo', dayIndex: -1 })));
    // Forged owner: Alice cannot create Bob's per-card bingo id.
    await assertFails(setDoc(p(`${BOB}-bingo-d3`), moment(ALICE, { kind: 'bingo', dayIndex: 3 })));
    // The legacy day-less per-Player id still works — pre-#372 clients keep
    // writing it, and a legacy id carrying a dayIndex payload stays valid: the
    // binding constrains the day-SUFFIXED id form, not the field's presence.
    await assertSucceeds(
      setDoc(doc(db(BOB), momentPath(`${BOB}-bingo`)), moment(BOB, { kind: 'bingo', dayIndex: 2 })),
    );
  });

  it('enforces the shape — valid kind, non-empty ≤100 displayName, numeric createdAt', async () => {
    // Every id here SATISFIES the #103 id↔kind binding (`${uid}-${kind}`), so the only
    // clause that can deny is the shape rule under test — never the binding. The denied
    // writes persist nothing, so they can share `${ALICE}-bingo`; the accepted one is last.
    const p = (id: string) => doc(db(ALICE), momentPath(id));
    await assertFails(setDoc(p(`${ALICE}-streak`), moment(ALICE, { kind: 'streak' }))); // not a MomentKind
    await assertFails(setDoc(p(`${ALICE}-bingo`), moment(ALICE, { displayName: '' }))); // empty name
    await assertFails(setDoc(p(`${ALICE}-bingo`), moment(ALICE, { displayName: 'x'.repeat(101) }))); // over cap
    await assertFails(setDoc(p(`${ALICE}-bingo`), moment(ALICE, { createdAt: 'now' }))); // non-numeric stamp
    await assertSucceeds(setDoc(p(`${ALICE}-bingo`), moment(ALICE, { displayName: 'x'.repeat(100) }))); // exactly the cap
  });

  it('is FULLY immutable — the deterministic id + create-only rule is the once-only backstop, and NO ONE (not even an admin) can update (PR #99 finding 4)', async () => {
    // The strongest dedup the rules allow: a deterministic id makes a re-broadcast a
    // doc-exists `update`, which is DENIED for everyone — a Moment has no update
    // path. So a duplicate BINGO / First-to-BINGO can never post, and an admin
    // cannot overwrite an existing Moment (which would clobber the first_bingo
    // singleton under a stale-roster race). MomentDoc has no moderation field to
    // change; moderation here is delete-only (a status field is deferred to #37/#41).
    // moments.ts relies on exactly this.
    const id = `${ALICE}-bingo`;
    await assertSucceeds(setDoc(doc(db(ALICE), momentPath(id)), moment(ALICE))); // create wins
    await assertFails(setDoc(doc(db(ALICE), momentPath(id)), moment(ALICE, { displayName: 'again' }))); // owner re-broadcast denied
    // An admin repeat-broadcast AND an admin content rewrite are BOTH denied now —
    // the admin update path is gone, so an admin-player is dedup'd like everyone else.
    await assertFails(setDoc(doc(db(ADMIN), momentPath(id)), moment(ALICE))); // admin repeat-broadcast denied
    await assertFails(setDoc(doc(db(ADMIN), momentPath(id)), moment(ALICE, { displayName: 'moderated' }))); // admin content rewrite denied
  });

  it('bounds createdAt near request.time like proofs — in-bounds accepted, far-future and far-past denied (PR #99 finding 3)', async () => {
    // An unbounded createdAt let a bad clock or a forged far-future stamp pin a
    // Moment above all Feed activity forever; the create rule now requires the same
    // +60s / -24h window proofs uses. The client writes Date.now() (in bounds by
    // construction); an offline Moment drains with its ORIGINAL stamp, so a >24h
    // offline queue would trip the lower bound (accepted residual — see the spec).
    const p = (id: string) => doc(db(ALICE), momentPath(id));
    const now = Date.now();
    // Canonical id (`${uid}-bingo`) so only the createdAt bound decides each outcome —
    // the #103 id↔kind binding is satisfied. The denied writes persist nothing, so the
    // accepted case reuses the same id last.
    await assertFails(setDoc(p(`${ALICE}-bingo`), moment(ALICE, { createdAt: now + 3600000 }))); // +1h > +60s: denied
    await assertFails(setDoc(p(`${ALICE}-bingo`), moment(ALICE, { createdAt: now - 172800000 }))); // -2d < -24h: denied
    await assertSucceeds(setDoc(p(`${ALICE}-bingo`), moment(ALICE, { createdAt: now }))); // near-now: accepted
  });

  it('does NOT reject extra media/proofId fields — no-evidence is a writer/type contract, not a rules one', async () => {
    // The create rule has no hasOnly()/keys() constraint, so extra fields pass.
    // The ADR 0002 guarantee that a Moment carries no evidence is enforced by
    // moments.ts (writes only the MomentDoc fields) and the MomentDoc type — the
    // unit test src/data/w2-feed-moments.test.ts pins the writer side.
    await assertSucceeds(
      // Canonical id (`${uid}-bingo`, kind bingo) — the id↔kind binding (#103) still
      // does not gate extra fields; that stays a writer/type contract, not a rules one.
      setDoc(doc(db(ALICE), momentPath(`${ALICE}-bingo`)), moment(ALICE, {
        mediaURL: 'https://firebasestorage.example/x.jpg',
        proofId: 'p1',
      })),
    );
  });

  it('Moment reads are public — the Feed everyone watches (ADR 0002)', async () => {
    await assertSucceeds(getDoc(doc(db(BOB), momentPath(`${CAROL}-bingo`)))); // Bob reads Carol's beat
  });

  it('an owner deletes their own Moment ONLY as a retraction (#377); a peer cannot delete another’s', async () => {
    const alice = db(ALICE);
    const mine = doc(alice, momentPath(`${ALICE}-bingo`));
    await assertSucceeds(setDoc(mine, moment(ALICE)));
    // A BARE owner delete is denied since #377: it would leave the win unspent and
    // freely repostable at the same deterministic id with a fresh createdAt — the
    // top-of-Feed flapping loop the tombstone exists to close. The owner-delete arm
    // now requires the matching tombstone in the SAME atomic write (getAfter).
    await assertFails(deleteDoc(mine));
    // The retraction itself — delete + tombstone in one batch — is allowed.
    const batch = writeBatch(alice as Firestore);
    batch.delete(doc(alice, momentPath(`${ALICE}-bingo`)));
    batch.set(doc(alice, at(`momentRetractions/${ALICE}-bingo`)), {
      uid: ALICE, kind: 'bingo', createdAt: NOW(),
    });
    await assertSucceeds(batch.commit());
    await assertFails(deleteDoc(doc(db(BOB), momentPath(`${CAROL}-bingo`)))); // a peer may not moderate
  });

  it('an admin may delete any Moment', async () => {
    await assertSucceeds(deleteDoc(doc(db(ADMIN), momentPath(`${CAROL}-bingo`))));
  });
});

// --- Retract-once: the tombstone (#377) --------------------------------------
//
// The Feed must not keep claiming a win the card no longer supports. Retraction
// is DELETE + TOMBSTONE, never a bare delete: the deterministic per-card id is the
// strongest anti-gaming primitive here (one Moment per (Player, Day), create-only,
// immutable), and a bare delete would break it — retract-then-re-mark recreates
// the SAME id with a fresh `createdAt`, and the Feed sorts by `createdAt` desc, so
// mark/unmark/re-mark would bounce one win back to the TOP of the Feed repeatedly.
// The tombstone SPENDS that (Player, Day) win instead: the moments create rule
// denies any create whose tombstone exists.
//
// Stated plainly, because the scope must stay honest: retraction does nothing
// against deliberate gaming — a player claiming squares they did not earn simply
// does not unclick. Its value is Feed TRUTH for honest self-correction, and it
// must not cost the once-per-card bound to get it.
describe('firestore.rules — retraction tombstones (#377, specs/w2-feed-moments.md)', () => {
  // Exactly the tombstone contract the writer emits (src/data/moments.ts).
  const tombstone = (uid: string, over: Record<string, unknown> = {}) => ({
    uid,
    kind: 'bingo',
    createdAt: NOW(),
    ...over,
  });
  const tombstonePath = (id: string) => at(`momentRetractions/${id}`);
  // The retraction as the client actually issues it (src/data/moments.ts): the
  // Moment delete and its tombstone(s) in ONE atomic batch. Since #377 that is
  // the ONLY shape an owner delete can take — the delete rule's `getAfter`
  // requires the tombstone to exist once the request completes, so a lone delete
  // denies. Since the round-2 sibling-form spend, a Day-scoped retraction (a
  // `dayIndex` in `over`) tombstones BOTH id forms of the win — the legacy
  // day-less `${uid}-${kind}` and the day-scoped `${uid}-${kind}-d${dayIndex}` —
  // exactly as the client's commitRetraction does; a day-less retraction has no
  // sibling form and writes one tombstone.
  const retract = (uid: string, id: string, over: Record<string, unknown> = {}) => {
    const s = db(uid) as Firestore;
    const batch = writeBatch(s);
    batch.delete(doc(s, momentPath(id)));
    const kind = (over.kind as string) ?? 'bingo';
    const dayIndex = over.dayIndex as number | undefined;
    batch.set(doc(s, tombstonePath(`${uid}-${kind}`)), tombstone(uid, over));
    if (dayIndex !== undefined) {
      batch.set(doc(s, tombstonePath(`${uid}-${kind}-d${dayIndex}`)), tombstone(uid, over));
    }
    return batch.commit();
  };

  it('a Player tombstones their OWN win — all four canonical retractable id forms', async () => {
    const t = (id: string) => doc(db(ALICE), tombstonePath(id));
    // The two per-card forms (blackout since #267, bingo since #372).
    await assertSucceeds(setDoc(t(`${ALICE}-bingo-d3`), tombstone(ALICE, { dayIndex: 3 })));
    await assertSucceeds(
      setDoc(t(`${ALICE}-blackout-d3`), tombstone(ALICE, { kind: 'blackout', dayIndex: 3 })),
    );
    // The two LEGACY day-less forms — a pre-#267/#372 Moment (or a legacy
    // single-board Event's) is just as retractable, and its tombstone mirrors that
    // day-less id.
    await assertSucceeds(setDoc(t(`${ALICE}-bingo`), tombstone(ALICE)));
    await assertSucceeds(setDoc(t(`${ALICE}-blackout`), tombstone(ALICE, { kind: 'blackout' })));
  });

  it('SPENDS the win — the retracted (Player, Day) Moment can never be re-posted (the headline AC)', async () => {
    const alice = db(ALICE);
    const id = `${ALICE}-bingo-d3`;
    // 1. The win posts.
    await assertSucceeds(setDoc(doc(alice, momentPath(id)), moment(ALICE, { kind: 'bingo', dayIndex: 3 })));
    // 2. The completing square is unmarked → the client deletes the Moment and
    //    tombstones it in ONE atomic batch. Since #377 that is the only shape the
    //    owner delete permits: a bare delete is denied (see the immutability case).
    await assertSucceeds(retract(ALICE, id, { dayIndex: 3 }));
    // 3. Re-marking the same square CANNOT re-post it. Without the tombstone this
    //    create would SUCCEED (the doc is gone, so it is a create, not an update)
    //    with a fresh createdAt — straight back to the top of the Feed.
    await assertFails(setDoc(doc(alice, momentPath(id)), moment(ALICE, { kind: 'bingo', dayIndex: 3 })));
    // A SIBLING Day is untouched: the denial is keyed on the exact Moment id.
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo-d7`)), moment(ALICE, { kind: 'bingo', dayIndex: 7 })));
  });

  it('spends the LEGACY day-less forms too — the retract-once bound is not per-card-only', async () => {
    const alice = db(ALICE);
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo`)), moment(ALICE)));
    await assertSucceeds(retract(ALICE, `${ALICE}-bingo`));
    await assertFails(setDoc(doc(alice, momentPath(`${ALICE}-bingo`)), moment(ALICE)));
    // The blackout twin, same shape.
    await assertSucceeds(
      setDoc(doc(alice, tombstonePath(`${ALICE}-blackout`)), tombstone(ALICE, { kind: 'blackout' })),
    );
    await assertFails(
      setDoc(doc(alice, momentPath(`${ALICE}-blackout`)), moment(ALICE, { kind: 'blackout' })),
    );
  });

  it('retracting a LEGACY Moment spends the DAY-SCOPED twin too — the current bundle cannot repost the same win (Codex round 2)', async () => {
    // The bypass this closes: the legacy same-day dedupe means a Day-3 win can
    // live at `${uid}-bingo` with a day-stamped payload. A tombstone at only that
    // id left `${uid}-bingo-d3` freely creatable — retract, re-mark, and the
    // CURRENT bundle reposts the exact win just spent, at the top of the Feed.
    const alice = db(ALICE);
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo`)), moment(ALICE, { dayIndex: 3 })));
    await assertSucceeds(retract(ALICE, `${ALICE}-bingo`, { dayIndex: 3 }));
    // The same (Player, Day) win under the day-scoped id: DENIED.
    await assertFails(setDoc(doc(alice, momentPath(`${ALICE}-bingo-d3`)), moment(ALICE, { dayIndex: 3 })));
    // ANOTHER Day's day-scoped win is untouched — the sibling spend names Day 3.
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo-d5`)), moment(ALICE, { dayIndex: 5 })));
    // The OTHER kind is untouched entirely.
    await assertSucceeds(
      setDoc(doc(alice, momentPath(`${ALICE}-blackout-d3`)), moment(ALICE, { kind: 'blackout', dayIndex: 3 })),
    );
  });

  it('retracting a LEGACY blackout spends its day-scoped twin too — both kinds carry the bound', async () => {
    const alice = db(ALICE);
    await assertSucceeds(
      setDoc(doc(alice, momentPath(`${ALICE}-blackout`)), moment(ALICE, { kind: 'blackout', dayIndex: 4 })),
    );
    await assertSucceeds(retract(ALICE, `${ALICE}-blackout`, { kind: 'blackout', dayIndex: 4 }));
    await assertFails(
      setDoc(doc(alice, momentPath(`${ALICE}-blackout-d4`)), moment(ALICE, { kind: 'blackout', dayIndex: 4 })),
    );
    await assertSucceeds(
      setDoc(doc(alice, momentPath(`${ALICE}-blackout-d6`)), moment(ALICE, { kind: 'blackout', dayIndex: 6 })),
    );
  });

  it('retracting a DAY-SCOPED Moment spends the LEGACY twin too — a stale bundle cannot repost the same win (Codex round 2)', async () => {
    // The mirror image: a pre-#372 bundle writes the day-less `${uid}-bingo` id,
    // so a tombstone at only `${uid}-bingo-d3` left that form freely creatable.
    const alice = db(ALICE);
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo-d3`)), moment(ALICE, { dayIndex: 3 })));
    await assertSucceeds(retract(ALICE, `${ALICE}-bingo-d3`, { dayIndex: 3 }));
    // The legacy repost a stale bundle would issue (day-less payload): DENIED.
    await assertFails(setDoc(doc(alice, momentPath(`${ALICE}-bingo`)), moment(ALICE)));
    // A day-stamped payload at the legacy id changes nothing — the check is id-keyed.
    await assertFails(setDoc(doc(alice, momentPath(`${ALICE}-bingo`)), moment(ALICE, { dayIndex: 3 })));
    // ANOTHER Day's day-scoped win is untouched. (A stale bundle's OTHER-Day win
    // at the now-spent legacy id IS over-blocked — the accepted, silence-direction
    // residual documented in the spec.)
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo-d7`)), moment(ALICE, { dayIndex: 7 })));
    // The other kind is untouched.
    await assertSucceeds(
      setDoc(doc(alice, momentPath(`${ALICE}-blackout-d3`)), moment(ALICE, { kind: 'blackout', dayIndex: 3 })),
    );
  });

  it('the delete rule ENFORCES the sibling spend — a half-retraction cannot smuggle the bypass back (Codex round 2)', async () => {
    // Server-enforced, not client-voluntary: a hand-built client issuing the old
    // one-tombstone batch must be denied, or the cross-form bypass survives for
    // anyone willing to skip the app.
    const alice = db(ALICE);
    // Day-scoped Moment + only its own tombstone (no legacy twin): DENIED.
    const id = `${ALICE}-bingo-d3`;
    await assertSucceeds(setDoc(doc(alice, momentPath(id)), moment(ALICE, { dayIndex: 3 })));
    const dayOnly = writeBatch(alice as Firestore);
    dayOnly.delete(doc(alice, momentPath(id)));
    dayOnly.set(doc(alice, tombstonePath(id)), tombstone(ALICE, { dayIndex: 3 }));
    await assertFails(dayOnly.commit());
    // Legacy Moment whose payload NAMES its Day + only the legacy tombstone: DENIED.
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-blackout`)), moment(ALICE, { kind: 'blackout', dayIndex: 2 })));
    const legacyOnly = writeBatch(alice as Firestore);
    legacyOnly.delete(doc(alice, momentPath(`${ALICE}-blackout`)));
    legacyOnly.set(doc(alice, tombstonePath(`${ALICE}-blackout`)), tombstone(ALICE, { kind: 'blackout', dayIndex: 2 }));
    await assertFails(legacyOnly.commit());
    // Both Moments survived the denied half-retractions; the full spends land.
    await assertSucceeds(retract(ALICE, id, { dayIndex: 3 }));
    await assertSucceeds(retract(ALICE, `${ALICE}-blackout`, { kind: 'blackout', dayIndex: 2 }));
  });

  it('a LEGACY Moment naming NO Day needs only its own tombstone — there is no sibling id to derive', async () => {
    // A true pre-#262 doc (or a single-board Event's) carries no dayIndex: the
    // rules cannot conjure a Day from a day-less id, so the one-tombstone
    // retraction stays valid. (The client never retracts a day-less-payload doc
    // on a daily Event at all — deliberately conservative.)
    const alice = db(ALICE);
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo`)), moment(ALICE)));
    await assertSucceeds(retract(ALICE, `${ALICE}-bingo`));
  });

  it('accepts a PRE-EXISTING sibling tombstone — a second retraction of the same kind on another Day still lands', async () => {
    // Tombstones are permanent with no update path, so the client SKIPS re-setting
    // one an earlier retraction minted; the delete rule's getAfter must accept the
    // already-standing legacy tombstone or same-kind wins become one-retraction-ever.
    const alice = db(ALICE);
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo-d3`)), moment(ALICE, { dayIndex: 3 })));
    await assertSucceeds(retract(ALICE, `${ALICE}-bingo-d3`, { dayIndex: 3 })); // spends d3 + legacy
    await assertSucceeds(setDoc(doc(alice, momentPath(`${ALICE}-bingo-d5`)), moment(ALICE, { dayIndex: 5 })));
    // The client's second batch: delete d5, set ONLY the d5 tombstone (the legacy
    // one already exists — getAfter reads it as post-request state regardless).
    const second = writeBatch(alice as Firestore);
    second.delete(doc(alice, momentPath(`${ALICE}-bingo-d5`)));
    second.set(doc(alice, tombstonePath(`${ALICE}-bingo-d5`)), tombstone(ALICE, { dayIndex: 5 }));
    await assertSucceeds(second.commit());
  });

  it('an owner Moment delete must CARRY its tombstone — a bare delete cannot bypass retract-once (Codex P1)', async () => {
    // The create-side exists() check alone made retract-once VOLUNTARY: a player
    // could delete their Moment straight through the SDK, skip the tombstone, and
    // recreate the same deterministic id with a fresh createdAt — the flapping loop,
    // bypassed. `getAfter` on the delete rule closes it: the tombstone must exist
    // once the request completes, which only an atomic batch can satisfy.
    const alice = db(ALICE);
    const id = `${ALICE}-bingo-d3`;
    await assertSucceeds(setDoc(doc(alice, momentPath(id)), moment(ALICE, { dayIndex: 3 })));
    // Bare delete: DENIED.
    await assertFails(deleteDoc(doc(alice, momentPath(id))));
    // Delete batched with a tombstone for SOMEONE ELSE's win does not satisfy it
    // either — the tombstone must be at this Moment's own id.
    const wrongId = writeBatch(alice as Firestore);
    wrongId.delete(doc(alice, momentPath(id)));
    wrongId.set(doc(alice, tombstonePath(`${ALICE}-bingo-d7`)), tombstone(ALICE, { dayIndex: 7 }));
    await assertFails(wrongId.commit());
    // The Moment is still there — nothing above removed it.
    await assertSucceeds(getDoc(doc(alice, momentPath(id))));
    // The real retraction lands.
    await assertSucceeds(retract(ALICE, id, { dayIndex: 3 }));
  });

  it('an ADMIN may still delete a Moment WITHOUT spending its win — moderation is not retraction', async () => {
    // An admin removing a Moment is moderation, not a player retracting a win, so
    // the (Player, Day) slot must stay unspent: the player can post it again.
    await assertSucceeds(deleteDoc(doc(db(ADMIN), momentPath(`${CAROL}-bingo`))));
    await assertSucceeds(setDoc(doc(db(CAROL), momentPath(`${CAROL}-bingo`)), moment(CAROL)));
  });

  it('denies a forged tombstone — a Player cannot spend another Player’s win', async () => {
    // The denial-of-win shape the id binding closes: without it, any signed-in
    // Player could pre-tombstone `${BOB}-bingo-d3` and permanently deny Bob that
    // Day's Moment. Both halves are checked — the payload uid (isOwner) and the id
    // binding (which embeds the payload uid).
    await assertFails(setDoc(doc(db(ALICE), tombstonePath(`${BOB}-bingo-d3`)), tombstone(BOB, { dayIndex: 3 })));
    await assertFails(setDoc(doc(db(ALICE), tombstonePath(`${BOB}-bingo-d3`)), tombstone(ALICE, { dayIndex: 3 })));
    // And Bob's own Moment still posts, proving the denials above left no mark.
    await assertSucceeds(setDoc(doc(db(BOB), momentPath(`${BOB}-bingo-d3`)), moment(BOB, { dayIndex: 3 })));
  });

  it('binds the tombstone id to its payload exactly as the moments create rule does', async () => {
    const t = (id: string) => doc(db(ALICE), tombstonePath(id));
    // The id's Day must equal the payload's dayIndex. A FRESH id each time: a
    // reused id would be denied as a doc-exists update regardless, masking the
    // create-rule condition under test (Codex P3 on #277).
    await assertFails(setDoc(t(`${ALICE}-bingo-d8`), tombstone(ALICE, { dayIndex: 5 })));
    // A day-suffixed id with NO dayIndex has nothing to bind to.
    await assertFails(setDoc(t(`${ALICE}-bingo-d4`), tombstone(ALICE)));
    // A non-integer dayIndex is denied.
    await assertFails(setDoc(t(`${ALICE}-bingo-d4`), tombstone(ALICE, { dayIndex: '4' })));
    // Out-of-schedule Days are denied — no unbounded junk-doc minting, the same
    // bound the moments block carries (Codex P2 on #277).
    await assertFails(setDoc(t(`${ALICE}-bingo-d10`), tombstone(ALICE, { dayIndex: 10 })));
    await assertFails(setDoc(t(`${ALICE}-bingo-d999999`), tombstone(ALICE, { dayIndex: 999999 })));
    await assertFails(setDoc(t(`${ALICE}-bingo-d-1`), tombstone(ALICE, { dayIndex: -1 })));
    // An id whose kind does not match its payload kind is denied.
    await assertFails(setDoc(t(`${ALICE}-bingo-d4`), tombstone(ALICE, { kind: 'blackout', dayIndex: 4 })));
    // An arbitrary id is denied — the tombstone is not a free-form doc.
    await assertFails(setDoc(t('spoof'), tombstone(ALICE)));
    // Extra fields are denied (hasOnly) — DELIBERATELY stricter than the moments
    // create rule, which accepts them (the honesty pin above). A tombstone is pure
    // bookkeeping nothing renders, so there is no payload to grow into.
    await assertFails(setDoc(t(`${ALICE}-bingo-d4`), tombstone(ALICE, { dayIndex: 4, note: 'oops' })));
    // createdAt carries the house near-now bound.
    await assertFails(setDoc(t(`${ALICE}-bingo-d4`), tombstone(ALICE, { dayIndex: 4, createdAt: NOW() + 3600000 })));
    await assertFails(setDoc(t(`${ALICE}-bingo-d4`), tombstone(ALICE, { dayIndex: 4, createdAt: 'now' })));
    // The canonical create still lands after all of the above.
    await assertSucceeds(setDoc(t(`${ALICE}-bingo-d4`), tombstone(ALICE, { dayIndex: 4 })));
    // A day-LESS id with a day-stamped payload is valid — since the round-2
    // sibling-form spend the writer DOES mint this: the legacy tombstone of a
    // daily-Event retraction records WHICH Day spent the legacy slot.
    await assertSucceeds(setDoc(t(`${ALICE}-bingo`), tombstone(ALICE, { dayIndex: 2 })));
    // ... but when present it must still be a real scheduled Day — hasOnly alone
    // would otherwise admit junk into a publicly-readable doc.
    await assertFails(setDoc(t(`${ALICE}-blackout`), tombstone(ALICE, { kind: 'blackout', dayIndex: '2' })));
    await assertFails(setDoc(t(`${ALICE}-blackout`), tombstone(ALICE, { kind: 'blackout', dayIndex: 99 })));
    await assertFails(setDoc(t(`${ALICE}-blackout`), tombstone(ALICE, { kind: 'blackout', dayIndex: -1 })));
  });

  it('cannot tombstone the ceremonial First-to-BINGO — the event singleton has no retraction path', async () => {
    // `kind` is restricted to the two PER-CARD kinds and the singleton id matches
    // no `${uid}-${kind}` form, so the event-wide honor keeps its existing
    // admin-delete-only moderation. A per-Player retraction lever on an
    // Event-level record is not something one Player gets.
    await assertFails(setDoc(doc(db(ALICE), tombstonePath('first_bingo')), tombstone(ALICE, { kind: 'first_bingo' })));
    await assertFails(setDoc(doc(db(ALICE), tombstonePath(`${ALICE}-first_bingo`)), tombstone(ALICE, { kind: 'first_bingo' })));
    // And the singleton itself still posts — nothing above spent it.
    await assertSucceeds(setDoc(doc(db(ALICE), momentPath('first_bingo')), moment(ALICE, { kind: 'first_bingo' })));
  });

  it('is IMMUTABLE and NOT owner-deletable — an undoable tombstone would restore the repost loop', async () => {
    const id = `${ALICE}-bingo-d3`;
    await assertSucceeds(setDoc(doc(db(ALICE), tombstonePath(id)), tombstone(ALICE, { dayIndex: 3 })));
    // No update path — for the owner OR an admin, exactly like a Moment.
    await assertFails(setDoc(doc(db(ALICE), tombstonePath(id)), tombstone(ALICE, { dayIndex: 3 })));
    await assertFails(setDoc(doc(db(ADMIN), tombstonePath(id)), tombstone(ALICE, { dayIndex: 3 })));
    // The owner may NOT delete it: an owner-deletable tombstone is just the
    // delete-then-repost loop with an extra step.
    await assertFails(deleteDoc(doc(db(ALICE), tombstonePath(id))));
    await assertFails(deleteDoc(doc(db(BOB), tombstonePath(id))));
    // An ADMIN may — the moderation escape hatch for a genuine mis-retraction,
    // mirroring the write-once per-day honor doc. Afterwards the win posts again.
    await assertSucceeds(deleteDoc(doc(db(ADMIN), tombstonePath(id))));
    await assertSucceeds(setDoc(doc(db(ALICE), momentPath(id)), moment(ALICE, { dayIndex: 3 })));
  });

  it('tombstone reads are public, like the Feed they describe', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), tombstonePath(`${ALICE}-bingo-d3`)), tombstone(ALICE, { dayIndex: 3 })));
    await assertSucceeds(getDoc(doc(db(BOB), tombstonePath(`${ALICE}-bingo-d3`))));
  });
});
