import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteField,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

// Deploy 1 of #804 freezes the per-Event switch before any production allow
// arm is allowed to consult admission. The deliberately separate suite keeps
// that rollout boundary executable: deploy 2 will replace its negative source
// assertions when the full Event inventory is gated.

const RULES_PATH = fileURLToPath(
  new URL('../../firestore.rules', import.meta.url),
);
const RULES_SOURCE = readFileSync(RULES_PATH, 'utf8');
const EXECUTABLE_RULES = RULES_SOURCE.replace(/\/\/.*$/gm, '');
const EVENT = 'membership-freeze-event';
const ADMIN = 'admin-uid';
const MEMBERLESS_PLAYER = 'memberless-player';

let testEnv: RulesTestEnvironment;
const db = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const eventPath = (eventId = EVENT) => `events/${eventId}`;

function eventData(
  membershipEnforcement?: 'off' | 'enforced',
): Record<string, unknown> {
  return {
    name: 'Membership freeze fixture',
    status: 'active',
    admins: [ADMIN],
    ...(membershipEnforcement === undefined ? {} : { membershipEnforcement }),
  };
}

async function seedEvent(
  membershipEnforcement?: 'off' | 'enforced',
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), eventPath()),
      eventData(membershipEnforcement),
    );
  });
}

function rootEventWriteAllow(): string {
  const matchStart = EXECUTABLE_RULES.indexOf('match /events/{eventId} {');
  const allowStart = EXECUTABLE_RULES.indexOf(
    'allow create, update: if',
    matchStart,
  );
  const allowEnd = EXECUTABLE_RULES.indexOf(';', allowStart);

  if (matchStart < 0 || allowStart < 0 || allowEnd < 0) {
    throw new Error('root Event create/update allow arm was not found');
  }

  return EXECUTABLE_RULES.slice(allowStart, allowEnd + 1).trim();
}

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const [hostname, port] = host.split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-fiveacross-membership-freeze',
    firestore: {
      host: hostname,
      port: Number(port),
      rules: RULES_SOURCE,
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe('firestore.rules — membership enforcement switch freeze (#804 deploy 1)', () => {
  it('preserves presence and value across every Admin update state', async () => {
    await seedEvent();
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { name: 'Still absent' }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        membershipEnforcement: 'off',
      }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        membershipEnforcement: 'enforced',
      }),
    );

    await seedEvent('off');
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { name: 'Still off' }),
    );
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), {
        membershipEnforcement: 'off',
      }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        membershipEnforcement: 'enforced',
      }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        membershipEnforcement: deleteField(),
      }),
    );

    await seedEvent('enforced');
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), { name: 'Still enforced' }),
    );
    await assertSucceeds(
      updateDoc(doc(db(ADMIN), eventPath()), {
        membershipEnforcement: 'enforced',
      }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        membershipEnforcement: 'off',
      }),
    );
    await assertFails(
      updateDoc(doc(db(ADMIN), eventPath()), {
        membershipEnforcement: deleteField(),
      }),
    );
  });

  it('preserves the existing Event create and non-Admin denials', async () => {
    await assertFails(
      setDoc(doc(db(ADMIN), eventPath('client-created')), eventData('off')),
    );

    await seedEvent('off');
    await assertFails(
      updateDoc(doc(db(MEMBERLESS_PLAYER), eventPath()), {
        name: 'Not an Admin',
      }),
    );
  });

  it('keeps admission dark even when an Event already says enforced', async () => {
    await seedEvent('enforced');

    await assertSucceeds(
      getDoc(doc(db(MEMBERLESS_PLAYER), eventPath())),
    );
    await assertSucceeds(
      setDoc(
        doc(db(MEMBERLESS_PLAYER), `${eventPath()}/players/${MEMBERLESS_PLAYER}`),
        { uid: MEMBERLESS_PLAYER, displayName: 'Memberless player' },
      ),
    );
  });

  it('pins the source boundary between the freeze and the later gate deploy', () => {
    const allowStatements = EXECUTABLE_RULES.match(/\ballow\b[\s\S]*?;/g) ?? [];
    const rootWrite = rootEventWriteAllow();

    expect(allowStatements.length).toBeGreaterThan(0);
    expect(allowStatements.join('\n')).not.toMatch(
      /\badmitted(?:WithEvent)?\s*\(/,
    );
    // Direct allow-arm checks are insufficient: an arm could call a new wrapper
    // that reaches isEventMember(), or inline the Membership path. Exact-count
    // the complete canonical scaffold so either form fails closed until deploy
    // 2 deliberately replaces this dark-boundary assertion.
    expect(EXECUTABLE_RULES.match(/\badmitted\s*\(/g)).toHaveLength(1);
    expect(EXECUTABLE_RULES.match(/\badmittedWithEvent\s*\(/g)).toHaveLength(2);
    expect(EXECUTABLE_RULES.match(/\bisEventMember\s*\(/g)).toHaveLength(2);
    expect(EXECUTABLE_RULES.match(/\bmembershipDoc\s*\(/g)).toHaveLength(3);
    expect(EXECUTABLE_RULES.match(/\/memberships\//g)).toHaveLength(1);
    expect(
      EXECUTABLE_RULES.match(
        /event\.get\('membershipEnforcement', 'off'\)/g,
      ),
    ).toHaveLength(1);
    expect(rootWrite).toMatch(/^allow create, update: if isAdmin\(eventId\)/);
    expect(rootWrite).toMatch(
      /&&\s*\(resource == null\s*\|\|\s*membershipEnforcementUnchanged\(\)\)/,
    );
    expect(EXECUTABLE_RULES).not.toContain(
      'function eventConfigWriteAuthorized(eventId)',
    );
  });
});
