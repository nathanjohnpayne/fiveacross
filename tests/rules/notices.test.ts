import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, deleteField, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// specs/admin-messages.md (#439, #455) — the Notices rules contract. A Notice is an
// admin-authored broadcast at events/{eventId}/notices/{noticeId}: reads require
// Event admission; new names match the bounded ID token. Only an admin creates, updates
// (pin/unpin and an in-place copy correction), or deletes it, and both create and
// update validate the title/body caps + boolean `pinned`. On update the diff is
// pinned to title/body/pinned/editedAt, so attribution (`uid`, `displayName`) and
// Feed ordering (`createdAt`) are immutable. The PERMISSION_DENIED lines the SDK
// logs are the expected assertFails denials.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const EVENT = 'cruise';
const [ADMIN, ALICE, BOB] = ['admin-uid', 'alice', 'bob'];
const NOW = () => Date.now();

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid, { name: uid }).firestore();
const at = (p: string) => `events/${EVENT}/${p}`;
const noticePath = (id: string) => at(`notices/${id}`);
// The Notice shape notices.ts writes: { title, body, uid, displayName, createdAt, pinned }.
const notice = (uid: string, over: Record<string, unknown> = {}) => ({
  title: 'Final stretch 🏁',
  body: 'Last days at sea.',
  uid,
  displayName: uid,
  createdAt: NOW(),
  pinned: true,
  ...over,
});

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-gaycruisebingo-notices',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// Each test starts clean with a canonical Event (ADMIN is the sole admin) and one
// admin-authored Notice, so the admitted-read + admin-write invariants have a doc to
// read/mutate against.
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.firestore();
    await setDoc(doc(s, `events/${EVENT}`), {
      name: 'Cruise', sailStart: '2026-01-01', sailEnd: '2026-01-07', status: 'active',
      defaultTheme: 'neon-playground', claimMode: 'honor', admins: [ADMIN],
      settings: { reportHideThreshold: 3 },
      days: Array.from({ length: 10 }, (_, index) => ({ index })),
    });
    await setDoc(doc(s, noticePath('seed')), notice(ADMIN));
    // A Notice corrected THREE DAYS AGO — its stored `editedAt` is well outside the
    // 24h freshness window. The pin controls must still work on it (Codex P1, #456).
    await setDoc(
      doc(s, noticePath('stale-edit')),
      notice(ADMIN, { editedAt: NOW() - 3 * 86_400_000 }),
    );
  });
});

describe('firestore.rules — Notices (specs/admin-messages.md)', () => {
  it.each([
    ['forged', { displayName: 'Another Admin' }],
    ['missing', { displayName: deleteField() }],
    ['null', { displayName: null }],
    ['number', { displayName: 42 }],
    ['oversized', { displayName: 'x'.repeat(101) }],
  ])('denies %s Notice attribution rather than trusting an Admin-supplied label', async (_label, fields) => {
    const payload: Record<string, unknown> = notice(ADMIN, fields);
    if (_label === 'missing') delete payload.displayName;
    await assertFails(setDoc(doc(db(ADMIN), noticePath('bad-label')), payload));
    expect((await getDoc(doc(db(ADMIN), noticePath('bad-label')))).exists()).toBe(false);
  });

  it.each([undefined, null, 42, '', 'x'.repeat(101)])('denies an unusable authenticated token name %j', async name => {
    const claims = name === undefined ? {} : { name };
    const admin = testEnv.authenticatedContext(ADMIN, claims).firestore();
    await assertFails(setDoc(doc(admin, noticePath('bad-token-name')), notice(ADMIN, {
      displayName: typeof name === 'string' ? name : ADMIN,
    })));
  });

  it('accepts the exact bounded token label and keeps attribution fixed after an account rename', async () => {
    const oldName = 'N'.repeat(100);
    const first = testEnv.authenticatedContext(ADMIN, { name: oldName }).firestore();
    await assertSucceeds(setDoc(doc(first, noticePath('original')), notice(ADMIN, { displayName: oldName })));
    const renamed = testEnv.authenticatedContext(ADMIN, { name: 'Renamed Google account' }).firestore();
    await assertSucceeds(setDoc(doc(renamed, noticePath('renamed')), notice(ADMIN, { displayName: 'Renamed Google account' })));
    await assertSucceeds(updateDoc(doc(renamed, noticePath('original')), { pinned: false }));
    await assertFails(updateDoc(doc(renamed, noticePath('original')), { displayName: 'Renamed Google account' }));
    expect((await getDoc(doc(renamed, noticePath('original')))).data()?.displayName).toBe(oldName);
  });


  it('the Event admission predicate permits Notice reads', async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), noticePath('seed'))));
    await assertSucceeds(getDoc(doc(db(BOB), noticePath('seed'))));
  });

  it('an admin creates a Notice', async () => {
    await assertSucceeds(setDoc(doc(db(ADMIN), noticePath('n1')), notice(ADMIN)));
  });

  it('a non-admin cannot create, update, or delete a Notice', async () => {
    await assertFails(setDoc(doc(db(ALICE), noticePath('n1')), notice(ALICE)));
    await assertFails(updateDoc(doc(db(ALICE), noticePath('seed')), { pinned: false }));
    await assertFails(deleteDoc(doc(db(ALICE), noticePath('seed'))));
  });

  it('an admin pins/unpins (update) and deletes a Notice', async () => {
    await assertSucceeds(updateDoc(doc(db(ADMIN), noticePath('seed')), { pinned: false }));
    await assertSucceeds(deleteDoc(doc(db(ADMIN), noticePath('seed'))));
  });

  it('attribution and Feed ordering stay immutable — only copy + pin are mutable (#455)', async () => {
    // #455 opened title/body to an in-place copy correction, but kept the integrity
    // half PR #440 hardened: a stale or hand-built admin client still cannot re-attribute
    // an already-delivered Notice or re-sort it to the top of the Feed.
    await assertFails(updateDoc(doc(db(ADMIN), noticePath('seed')), { uid: ALICE }));
    await assertFails(updateDoc(doc(db(ADMIN), noticePath('seed')), { displayName: 'Someone else' }));
    await assertFails(updateDoc(doc(db(ADMIN), noticePath('seed')), { createdAt: 1 }));
    await assertFails(updateDoc(doc(db(ADMIN), noticePath('seed')), { dayIndex: 3 }));
    // Smuggling an immutable field alongside a legal copy edit is still denied.
    await assertFails(
      updateDoc(doc(db(ADMIN), noticePath('seed')), { title: 'Legal', createdAt: 1 }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), noticePath('seed')), { body: 'Legal', displayName: 'Nope' }),
    );
    // A non-boolean pinned is denied even alone.
    await assertFails(updateDoc(doc(db(ADMIN), noticePath('seed')), { pinned: 'no' }));
  });

  it('an admin corrects the copy in place and stamps editedAt (#455)', async () => {
    const p = () => doc(db(ADMIN), noticePath('seed'));
    // The whole point of the ticket: fix the copy without a Delete + repost.
    await assertSucceeds(
      updateDoc(p(), { title: 'Final stretch 🏁', body: 'happened—if', editedAt: NOW() }),
    );
    // A copy change WITHOUT a fresh stamp is denied — that is what makes the
    // "edited" marker an enforced invariant, not a client convention (Codex P2, #456).
    await assertFails(updateDoc(p(), { title: 'Retitled' }));
    await assertFails(updateDoc(p(), { body: 'Rewritten' }));
    // The create caps are revalidated on update — an edit can't smuggle in overlong
    // copy. A fresh stamp is included so these isolate the CAP, not the stamp rule.
    await assertFails(updateDoc(p(), { title: 'x'.repeat(61), editedAt: NOW() }));
    await assertFails(updateDoc(p(), { body: 'x'.repeat(401), editedAt: NOW() }));
    await assertFails(updateDoc(p(), { title: 42, editedAt: NOW() }));
    // editedAt is bounded like createdAt, so an edit can't backdate or future-date
    // its own provenance.
    await assertFails(updateDoc(p(), { title: 'ok', editedAt: 'now' }));
    await assertFails(updateDoc(p(), { title: 'ok', editedAt: NOW() + 3_600_000 }));
    await assertFails(updateDoc(p(), { title: 'ok', editedAt: NOW() - 2 * 86_400_000 }));
  });

  it('a stale editedAt never expires the pin controls (Codex P1, #456)', async () => {
    // 'stale-edit' was corrected three days ago. A pin-only updateDoc still MERGES
    // that stored stamp into request.resource.data, so a presence-scoped freshness
    // check would reject every Pin/Unpin on it forever. The bound is diff-scoped.
    const p = () => doc(db(ADMIN), noticePath('stale-edit'));
    await assertSucceeds(updateDoc(p(), { pinned: false }));
    await assertSucceeds(updateDoc(p(), { pinned: true }));
    // Correcting its copy again still works — with a fresh stamp.
    await assertSucceeds(updateDoc(p(), { body: 'Corrected again', editedAt: NOW() }));
  });

  it('provenance cannot be stripped to hide an edit (Codex P2, #456)', async () => {
    const p = () => doc(db(ADMIN), noticePath('stale-edit'));
    // Deleting the stamp outright — with or without a copy change — is denied,
    // because the diff touches editedAt and the survivor must be a number.
    await assertFails(updateDoc(p(), { editedAt: deleteField() }));
    await assertFails(updateDoc(p(), { body: 'Sneaky', editedAt: deleteField() }));
  });

  it('a non-admin cannot edit a Notice (#455)', async () => {
    // A fresh stamp is included so this isolates the isAdmin gate, not the stamp rule.
    await assertFails(
      updateDoc(doc(db(ALICE), noticePath('seed')), { body: 'Hijacked', editedAt: NOW() }),
    );
    await assertFails(
      updateDoc(doc(db(ALICE), noticePath('seed')), { title: 'Hijacked', editedAt: NOW() }),
    );
  });

  it('enforces the title ≤60, body ≤400, and boolean-pinned caps on create', async () => {
    const p = (id: string) => doc(db(ADMIN), noticePath(id));
    await assertFails(setDoc(p('long-title'), notice(ADMIN, { title: 'x'.repeat(61) })));
    await assertFails(setDoc(p('long-body'), notice(ADMIN, { body: 'x'.repeat(401) })));
    await assertFails(setDoc(p('bad-pinned'), notice(ADMIN, { pinned: 'yes' })));
    await assertFails(setDoc(p('num-title'), notice(ADMIN, { title: 42 })));
    // A Notice exactly at the caps is accepted.
    await assertSucceeds(
      setDoc(p('at-caps'), notice(ADMIN, { title: 'x'.repeat(60), body: 'y'.repeat(400) })),
    );
  });

  it('binds attribution to the authenticated admin — a forged uid is denied (Codex #440)', async () => {
    // An admin cannot mint a Notice attributed to a different uid (isOwner-of-uid).
    await assertFails(setDoc(doc(db(ADMIN), noticePath('forged')), notice(ALICE)));
    await assertSucceeds(setDoc(doc(db(ADMIN), noticePath('own')), notice(ADMIN)));
  });

  it('bounds createdAt near request.time so a forged stamp cannot pin forever (Codex #440)', async () => {
    const p = (id: string) => doc(db(ADMIN), noticePath(id));
    await assertFails(setDoc(p('future'), notice(ADMIN, { createdAt: NOW() + 3_600_000 })));
    await assertFails(setDoc(p('ancient'), notice(ADMIN, { createdAt: NOW() - 2 * 86_400_000 })));
    await assertFails(setDoc(p('nonnum'), notice(ADMIN, { createdAt: 'now' })));
    await assertSucceeds(setDoc(p('nowish'), notice(ADMIN, { createdAt: NOW() })));
  });
});
