import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

// Covers specs/hostnames-lookup.md — the pre-auth Event lookup (ADR 0009).
//
// The get/list split IS the safety property here, not a style choice: `get`
// resolves an address the caller already typed, while `list` would enumerate
// every Event on the platform and turn a set of unguessable addresses into a
// directory. A reviewer who "tidies" these two arms into `allow read` silently
// grants list and trips the named test below.

const RULES_PATH = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const CANONICAL = 'bodega-bay.vacaybingo.com';
// Deliberately a reserved-TLD name (RFC 2606) rather than a production hostname.
// This fixture needs an address that is non-canonical *by construction*, and no
// real Bodega host qualifies: `bodega-bay.fiveacross.app` is the designated
// canonical (README, docs/app/deploy-targets.md), `bodega-bay.vacaybingo.com`
// still names itself canonical until the #601 repoint, and
// `bodega-bay.fiveacrossbingo.com` — used here previously — is a redirect
// hostname on a zone being retired (#630) that never served an Event at all.
// Seeding any of them as `isCanonical: false` would teach the opposite of the
// deployed migration state. The rule under test cares only that a second
// document resolves and names its canonical elsewhere, so a name that can never
// be a real serving host is the honest fixture.
const ALIAS = 'bodega-bay.alias.test';

let testEnv: RulesTestEnvironment;
const authed = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    // Suite-specific projectId so this suite's clearFirestore() cannot race the
    // other rules suites under Vitest's default file parallelism (same reason
    // w1-attestation.test.ts and self-writable.test.ts carry their own ids).
    projectId: 'demo-gcb-hostnames-lookup',
    firestore: { host: hostname, port: Number(port), rules: readFileSync(RULES_PATH, 'utf8') },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

// Seed through the rules-disabled context — the Admin SDK stand-in, and the
// only writer this collection ever has in production.
beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `hostnames/${CANONICAL}`), {
      eventId: 'bodega-bay-2026',
      canonicalHost: CANONICAL,
      edition: 'vacay',
      status: 'active',
      slug: 'bodega-bay',
      isCanonical: true,
    });
    await setDoc(doc(db, `hostnames/${ALIAS}`), {
      eventId: 'bodega-bay-2026',
      canonicalHost: CANONICAL,
      edition: 'vacay',
      status: 'active',
      slug: 'bodega-bay',
      isCanonical: false,
    });
  });
});

describe('firestore.rules — hostnames/{host} pre-auth lookup (hostnames-lookup)', () => {
  it('an UNAUTHENTICATED client may get a hostname document', async () => {
    // The load-bearing case: resolution happens before sign-in, because the
    // sign-in screen itself needs the Event's Edition to render correctly.
    const snap = await assertSucceeds(getDoc(doc(anon(), `hostnames/${CANONICAL}`)));
    expect(snap.exists()).toBe(true);
    expect(snap.data()?.eventId).toBe('bodega-bay-2026');
  });

  it('a signed-in client may get a hostname document', async () => {
    const snap = await assertSucceeds(getDoc(doc(authed('alice'), `hostnames/${CANONICAL}`)));
    expect(snap.data()?.edition).toBe('vacay');
  });

  it('an alias document resolves to the same Event and names its canonical', async () => {
    const snap = await assertSucceeds(getDoc(doc(anon(), `hostnames/${ALIAS}`)));
    expect(snap.data()?.eventId).toBe('bodega-bay-2026');
    expect(snap.data()?.canonicalHost).toBe(CANONICAL);
    expect(snap.data()?.isCanonical).toBe(false);
  });

  it('LISTING the collection is denied — unauthenticated', async () => {
    // Enumeration would convert unguessable addresses into a directory of every
    // Event on the platform. This is the whole reason the rule splits get/list.
    await assertFails(getDocs(collection(anon(), 'hostnames')));
  });

  it('LISTING the collection is denied — signed in', async () => {
    await assertFails(getDocs(collection(authed('alice'), 'hostnames')));
  });

  it('an unknown host is a MISSING DOCUMENT, not a denial', async () => {
    // A client must be able to tell "no Event here" from "permission problem",
    // so it renders an Event-not-found state rather than a network-ish error.
    const snap = await assertSucceeds(getDoc(doc(anon(), 'hostnames/nope.vacaybingo.com')));
    expect(snap.exists()).toBe(false);
  });

  it('client CREATE is denied', async () => {
    await assertFails(
      setDoc(doc(authed('alice'), 'hostnames/squat.vacaybingo.com'), {
        eventId: 'bodega-bay-2026',
        canonicalHost: 'squat.vacaybingo.com',
        edition: 'vacay',
        status: 'active',
        slug: 'squat',
        isCanonical: true,
      }),
    );
  });

  it('client UPDATE is denied — a writable mapping could repoint a live address', async () => {
    await assertFails(
      updateDoc(doc(authed('alice'), `hostnames/${CANONICAL}`), { eventId: 'some-other-event' }),
    );
  });

  it('client DELETE is denied', async () => {
    await assertFails(deleteDoc(doc(authed('alice'), `hostnames/${CANONICAL}`)));
  });

  it('an unauthenticated client cannot write either', async () => {
    await assertFails(
      setDoc(doc(anon(), 'hostnames/anon.vacaybingo.com'), { eventId: 'x' }),
    );
  });

  it('an EVENT ADMIN cannot write the mapping', async () => {
    // Deliberately no admin arm: hostnames is a GLOBAL namespace, and a
    // per-Event admin has no authority over it. An admin who could write here
    // could point another Event's address at their own.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'events/bodega-bay-2026'), {
        name: 'Bodega Bay',
        admins: ['kim'],
        status: 'active',
      });
    });
    await assertFails(
      updateDoc(doc(authed('kim'), `hostnames/${CANONICAL}`), { eventId: 'some-other-event' }),
    );
  });
});
