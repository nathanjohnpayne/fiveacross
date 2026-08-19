import { describe, expect, it } from 'vitest';
import type { MembershipDoc } from '../types';
import {
  MEMBERSHIP_COLLECTION,
  MEMBERSHIP_SCHEMA_VERSION,
  admits,
  adminsMissingMembership,
  isActiveMembershipData,
  membershipEnforcementFor,
  membershipPath,
  membershipRoleSatisfies,
  membershipRulesPath,
  readMembership,
} from './eventMembership';

// specs/event-membership.md — the admission contract every Phase 3 child
// (#803-#809) consumes. These tests are the reference the two rules files are
// transcribed AGAINST; #804's emulator suite pins that the transcription agrees.

const EVENT = 'cruise';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';

function activeRecord(over: Partial<MembershipDoc> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMBERSHIP_SCHEMA_VERSION,
    eventId: EVENT,
    uid: ALICE,
    role: 'member',
    status: 'active',
    grantedAt: 1_700_000_000_000,
    grantedBy: 'admin-uid',
    invitationId: 'inv-1',
    ...over,
  };
}

describe('the membership path', () => {
  it('is computable from (eventId, uid) alone, with the uid as the document id', () => {
    expect(membershipPath(EVENT, ALICE)).toBe(`events/${EVENT}/${MEMBERSHIP_COLLECTION}/${ALICE}`);
  });

  it('exposes the absolute form storage.rules must pass to firestore.get()', () => {
    // storage.rules has no {database} wildcard to interpolate — the literal
    // `(default)` is the only form that resolves there (storage.rules:9).
    expect(membershipRulesPath(EVENT, ALICE)).toBe(
      `/databases/(default)/documents/events/${EVENT}/${MEMBERSHIP_COLLECTION}/${ALICE}`,
    );
  });

  it('needs no query, no fan-out and no second document to locate a member', () => {
    // The whole shape exists to satisfy this. If this ever needs an index, a
    // where(), or a second path, the Storage half of the epic is unbuildable.
    expect(membershipPath(EVENT, BOB).split('/')).toHaveLength(4);
  });
});

describe('isActiveMembershipData — the frozen core the rules transcribe', () => {
  it('admits exactly status active', () => {
    expect(isActiveMembershipData({ status: 'active' })).toBe(true);
  });

  it('denies a revoked record, an absent one, and a shape-drifted one', () => {
    expect(isActiveMembershipData({ status: 'revoked' })).toBe(false);
    expect(isActiveMembershipData(null)).toBe(false);
    expect(isActiveMembershipData(undefined)).toBe(false);
    expect(isActiveMembershipData({})).toBe(false);
    expect(isActiveMembershipData('active')).toBe(false);
  });

  it('does not accept a truthy near-miss', () => {
    // Rules compare a string literal; anything else must not sneak through a
    // JS truthiness check that the rules transcription would not reproduce.
    expect(isActiveMembershipData({ status: true })).toBe(false);
    expect(isActiveMembershipData({ status: 'ACTIVE' })).toBe(false);
    expect(isActiveMembershipData({ active: true })).toBe(false);
  });
});

describe('readMembership — the versioned parse', () => {
  it('round-trips a well-formed record', () => {
    const parsed = readMembership(activeRecord());
    expect(parsed).toEqual({
      schemaVersion: MEMBERSHIP_SCHEMA_VERSION,
      eventId: EVENT,
      uid: ALICE,
      role: 'member',
      status: 'active',
      grantedAt: 1_700_000_000_000,
      grantedBy: 'admin-uid',
      invitationId: 'inv-1',
    });
  });

  it('carries the revocation audit fields when present', () => {
    const parsed = readMembership(
      activeRecord({ status: 'revoked', revokedAt: 1_700_000_100_000, revokedBy: 'admin-uid' }),
    );
    expect(parsed?.status).toBe('revoked');
    expect(parsed?.revokedAt).toBe(1_700_000_100_000);
    expect(parsed?.revokedBy).toBe('admin-uid');
  });

  it('reads a version drift as a MISS, never as coerced data', () => {
    // ADR 0009's cache convention: a record written by a shape this build does
    // not understand is absent, not guessed at.
    expect(readMembership(activeRecord({ schemaVersion: MEMBERSHIP_SCHEMA_VERSION + 1 }))).toBeNull();
    expect(readMembership(activeRecord({ schemaVersion: 0 }))).toBeNull();
    expect(readMembership({ ...activeRecord(), schemaVersion: undefined })).toBeNull();
  });

  it('reads corrupt, absent and shape-drifted records as a miss', () => {
    expect(readMembership(null)).toBeNull();
    expect(readMembership('nope')).toBeNull();
    expect(readMembership({})).toBeNull();
    expect(readMembership({ ...activeRecord(), role: 'host' })).toBeNull();
    expect(readMembership({ ...activeRecord(), status: 'pending' })).toBeNull();
    expect(readMembership({ ...activeRecord(), grantedAt: '2026-01-01' })).toBeNull();
    expect(readMembership({ ...activeRecord(), grantedBy: '' })).toBeNull();
    expect(readMembership({ ...activeRecord(), invitationId: 42 })).toBeNull();
  });

  it('accepts a null invitationId — provisioner and backfill grants have none', () => {
    expect(readMembership(activeRecord({ invitationId: null }))?.invitationId).toBeNull();
  });

  it('rejects a revoked record whose audit fields are missing or unusable', () => {
    // Codex P2 on PR #891. Silently dropping the unusable half handed consumers
    // a "parsed" revocation with no author and no date — exactly the provenance
    // the record exists to carry.
    expect(readMembership(activeRecord({ status: 'revoked' }))).toBeNull();
    expect(readMembership({ ...activeRecord(), status: 'revoked', revokedAt: 1 })).toBeNull();
    expect(
      readMembership({ ...activeRecord(), status: 'revoked', revokedBy: 'admin-uid' }),
    ).toBeNull();
    expect(
      readMembership({
        ...activeRecord(),
        status: 'revoked',
        revokedAt: 'yesterday',
        revokedBy: 'a',
      }),
    ).toBeNull();
    expect(
      readMembership({ ...activeRecord(), status: 'revoked', revokedAt: 1, revokedBy: '' }),
    ).toBeNull();
  });

  it('rejects an ACTIVE record still carrying revocation fields', () => {
    // A half-applied write, in the other direction.
    expect(readMembership({ ...activeRecord(), revokedAt: 1_700_000_100_000 })).toBeNull();
    expect(readMembership({ ...activeRecord(), revokedBy: 'admin-uid' })).toBeNull();
  });

  it('rejecting an inconsistent record is a PARSE decision, never an authorization one', () => {
    // Strictness in the parse must not change who gets in, or the reference
    // stops mirroring the rules. An inconsistent revoked record still denies;
    // an inconsistent active one still admits, exactly as `status` alone says.
    const badRevoked = activeRecord({ status: 'revoked' });
    expect(readMembership(badRevoked)).toBeNull();
    expect(admits({ uid: ALICE, enforcement: 'enforced', membership: badRevoked }).outcome).toBe(
      'denied-revoked',
    );

    const badActive = { ...activeRecord(), revokedAt: 1_700_000_100_000 };
    expect(readMembership(badActive)).toBeNull();
    expect(
      admits({ uid: ALICE, enforcement: 'enforced', membership: badActive }).admitted,
    ).toBe(true);
  });
});

describe('the parse and the authorization answer are deliberately different questions', () => {
  it('a version-drifted but ACTIVE record still admits, though it cannot be parsed', () => {
    // This is the parity property that keeps the rules honest. Rules read
    // `status` and nothing else, so if the TypeScript answer gated on
    // schemaVersion the two would disagree the moment the version was bumped —
    // and the disagreement would be a rules deploy racing a data migration.
    const drifted = activeRecord({ schemaVersion: MEMBERSHIP_SCHEMA_VERSION + 1 });
    expect(readMembership(drifted)).toBeNull();
    expect(isActiveMembershipData(drifted)).toBe(true);
    expect(admits({ uid: ALICE, enforcement: 'enforced', membership: drifted }).admitted).toBe(true);
  });
});

describe('membershipRoleSatisfies', () => {
  it('lets admin satisfy a member requirement, but not the reverse', () => {
    expect(membershipRoleSatisfies('admin', 'member')).toBe(true);
    expect(membershipRoleSatisfies('member', 'admin')).toBe(false);
  });

  it('is reflexive on every role', () => {
    expect(membershipRoleSatisfies('member', 'member')).toBe(true);
    expect(membershipRoleSatisfies('admin', 'admin')).toBe(true);
  });
});

describe('membershipEnforcementFor — the per-Event switch', () => {
  it('reads an ABSENT field as off, because every live Event document lacks it', () => {
    // Both live cohorts joined by self-creating players rows. A missing field
    // read as "enforce" is an outage for every one of them.
    expect(membershipEnforcementFor({})).toBe('off');
    expect(membershipEnforcementFor(null)).toBe('off');
    expect(membershipEnforcementFor(undefined)).toBe('off');
  });

  it('enforces only on an EXPLICIT enforced', () => {
    expect(membershipEnforcementFor({ membershipEnforcement: 'enforced' })).toBe('enforced');
    expect(membershipEnforcementFor({ membershipEnforcement: 'off' })).toBe('off');
  });

  it('degrades an unrecognised value to off rather than to an outage', () => {
    expect(
      membershipEnforcementFor({ membershipEnforcement: 'yes' as unknown as 'enforced' }),
    ).toBe('off');
  });
});

describe('admits — the one decision', () => {
  it('admits everyone while the Event is unenforced, and says so', () => {
    expect(admits({ uid: ALICE, enforcement: 'off', membership: null })).toEqual({
      admitted: true,
      outcome: 'admitted-unenforced',
    });
  });

  it('admits an active member on an enforced Event', () => {
    expect(admits({ uid: ALICE, enforcement: 'enforced', membership: activeRecord() })).toEqual({
      admitted: true,
      outcome: 'admitted',
    });
  });

  it('denies a UID with no record at all', () => {
    expect(admits({ uid: ALICE, enforcement: 'enforced', membership: null })).toEqual({
      admitted: false,
      outcome: 'denied-not-a-member',
    });
  });

  it('distinguishes REVOKED from never-a-member', () => {
    // The client says different things for each, so the difference must survive
    // the predicate rather than collapse into a boolean.
    expect(admits({ uid: ALICE, enforcement: 'enforced', membership: activeRecord({ status: 'revoked' }) })).toEqual(
      { admitted: false, outcome: 'denied-revoked' },
    );
  });

  it('denies an unreadable record', () => {
    expect(
      admits({ uid: ALICE, enforcement: 'enforced', membership: { ...activeRecord(), status: 'pending' } }),
    ).toEqual({ admitted: false, outcome: 'denied-unreadable' });
  });

  it('does NOT treat a self-created players row as evidence of admission', () => {
    // The whole point of the epic. A PlayerDoc-shaped object carries none of the
    // membership fields, and must never be mistaken for one.
    const forgedPlayerRow = {
      uid: BOB,
      displayName: 'Bob',
      photoURL: null,
      joinedAt: 1_700_000_000_000,
      bingoCount: 0,
      squaresMarked: 0,
      firstBingoAt: null,
      reshufflesUsed: 0,
    };
    expect(admits({ uid: ALICE, enforcement: 'enforced', membership: forgedPlayerRow }).admitted).toBe(false);
  });

  it('a BANNED member is still admitted — ban and admission are different questions', () => {
    // EventDoc.bannedUids is a presentational, Event-scoped hide/mute of a
    // Player's CONTENT (ADR 0004 Phase 0), explicitly "NOT hard access
    // revocation". A banned Player is still in the room. Putting them OUT of
    // the room is revocation, which is the record's own status.
    expect(
      admits({ uid: ALICE, enforcement: 'enforced', membership: activeRecord(), isBanned: true }),
    ).toEqual({ admitted: true, outcome: 'admitted' });
  });

  it('a banned NON-member is denied for not being a member, not for the ban', () => {
    expect(admits({ uid: ALICE, enforcement: 'enforced', membership: null, isBanned: true }).outcome).toBe(
      'denied-not-a-member',
    );
  });

  it('denies an UNAUTHENTICATED caller first, even while the Event is unenforced', () => {
    // Codex P2 on PR #891. The reference predicate leads with signedIn(), so
    // answering from `enforcement` alone would admit the public to every Event
    // in the dark-rollout state — which is every Event today. Unenforced means
    // open to any signed-in account, not open to everyone.
    expect(admits({ uid: null, enforcement: 'off', membership: null })).toEqual({
      admitted: false,
      outcome: 'denied-not-signed-in',
    });
    expect(admits({ uid: undefined, enforcement: 'off', membership: null }).admitted).toBe(false);
    expect(admits({ uid: '', enforcement: 'off', membership: null }).outcome).toBe(
      'denied-not-signed-in',
    );
  });

  it('denies an unauthenticated caller holding an otherwise valid record', () => {
    expect(admits({ uid: null, enforcement: 'enforced', membership: activeRecord() })).toEqual({
      admitted: false,
      outcome: 'denied-not-signed-in',
    });
  });

  it('does not admit an Admin who holds no membership', () => {
    // The answer to the epic's Admin question, implemented once. `EventDoc.admins`
    // is the authority on PRIVILEGE and this collection on ADMISSION; the model
    // requires an Admin to hold both, rather than letting either imply the other.
    // A disjunction here would make a raw `admins` array write a way to grant
    // admission, bypassing the audited invitation path entirely (#803).
    expect(admits({ uid: ALICE, enforcement: 'enforced', membership: null }).admitted).toBe(false);
  });
});

describe('adminsMissingMembership — the invariant #805 must satisfy before any flip', () => {
  it('is empty when every Admin holds an active membership', () => {
    expect(
      adminsMissingMembership({
        admins: [ALICE, BOB],
        memberships: { [ALICE]: activeRecord(), [BOB]: activeRecord({ uid: BOB, role: 'admin' }) },
      }),
    ).toEqual([]);
  });

  it('names an Admin with no record — the set that would be locked out by a flip', () => {
    expect(
      adminsMissingMembership({ admins: [ALICE, BOB], memberships: { [ALICE]: activeRecord() } }),
    ).toEqual([BOB]);
  });

  it('counts a REVOKED Admin as missing, because a revoked membership does not admit', () => {
    expect(
      adminsMissingMembership({
        admins: [ALICE],
        memberships: { [ALICE]: activeRecord({ status: 'revoked' }) },
      }),
    ).toEqual([ALICE]);
  });

  it('is order-independent and de-duplicates a repeated admin uid', () => {
    expect(adminsMissingMembership({ admins: [BOB, BOB], memberships: {} })).toEqual([BOB]);
  });

  it('ignores empty and non-string entries rather than reporting them as people', () => {
    expect(
      adminsMissingMembership({
        admins: ['', ALICE, null as unknown as string],
        memberships: {},
      }),
    ).toEqual([ALICE]);
  });

  it('does not accept a Player row as an Admins membership', () => {
    expect(
      adminsMissingMembership({ admins: [ALICE], memberships: { [ALICE]: { joinedAt: 1 } } }),
    ).toEqual([ALICE]);
  });
});
