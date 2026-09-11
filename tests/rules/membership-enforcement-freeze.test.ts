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

// Deploy 1 of #804 froze the per-Event switch before any production allow arm
// consulted admission; deploy 2 gated the inventory and replaced this suite's
// negative dark-boundary assertions with their live counterparts. The
// presence/value matrix itself is unchanged across both deploys.

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

// Structural locator (#1100): the arm is found by walking the root Event
// match block's braces rather than by the first substring hit, so a second
// `match /events/{eventId}` block, a nested match that carries its own
// `allow create, update` arm, or an unterminated arm all fail loudly here
// instead of silently pinning the wrong text. Both needles are
// whitespace-tolerant regexes (Codex P2 on #1194): a duplicate block written
// as `match /events/{eventId}  {` or with its brace on the next line is
// counted, not skipped. Comments are already stripped from EXECUTABLE_RULES,
// so only real braces are counted; the `{eventId}` segments of nested match
// paths net to zero and never reach depth 1 at the start of an `allow`.
const ROOT_EVENT_MATCH = /match\s+\/events\/\{eventId\}\s*\{/g;
const CREATE_UPDATE_ARM = /allow\s+create\s*,\s*update\s*:\s*if\b/y;

function rootEventWriteAllow(): string {
  const blocks = [...EXECUTABLE_RULES.matchAll(ROOT_EVENT_MATCH)];
  if (blocks.length !== 1) {
    throw new Error(
      `root Event match block: expected exactly one 'match /events/{eventId} {', found ${blocks.length}`,
    );
  }
  const arms: string[] = [];
  let depth = 0;
  // Start on the block's own opening brace (the last character of the match).
  let i = (blocks[0].index ?? 0) + blocks[0][0].length - 1;
  for (; i < EXECUTABLE_RULES.length; i += 1) {
    const ch = EXECUTABLE_RULES[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && ch === 'a') {
      CREATE_UPDATE_ARM.lastIndex = i;
      if (CREATE_UPDATE_ARM.test(EXECUTABLE_RULES)) {
        const end = EXECUTABLE_RULES.indexOf(';', i);
        if (end < 0) {
          throw new Error('root Event create/update allow arm is unterminated');
        }
        arms.push(EXECUTABLE_RULES.slice(i, end + 1).trim());
      }
    }
  }
  if (depth !== 0) {
    throw new Error('root Event match block is unbalanced');
  }
  if (arms.length !== 1) {
    throw new Error(
      `root Event match block: expected exactly one direct 'allow create, update: if' arm, found ${arms.length}`,
    );
  }
  return arms[0];
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

  it('denies a non-merge overwrite that drops the switch (#1101)', async () => {
    // setDoc without { merge: true } is still an update to the rules engine
    // once the document exists, but request.resource.data is the whole new
    // document rather than updateDoc's implicit field-preserving merge, so a
    // rewrite that simply omits membershipEnforcement would silently clear it
    // if the freeze only compared present fields. Same Admin, same Event, same
    // payload shape as the seed: the only variable is the switch field.
    await seedEvent('off');
    await assertFails(setDoc(doc(db(ADMIN), eventPath()), eventData()));
    await assertFails(setDoc(doc(db(ADMIN), eventPath()), eventData('enforced')));
    await assertSucceeds(setDoc(doc(db(ADMIN), eventPath()), eventData('off')));

    // Absent stays absent: an overwrite that omits the field on an Event that
    // never carried it is the frozen no-op, not a change.
    await seedEvent();
    await assertSucceeds(setDoc(doc(db(ADMIN), eventPath()), eventData()));
    await assertFails(setDoc(doc(db(ADMIN), eventPath()), eventData('off')));
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

  it('consults admission now that the inventory is gated (deploy 2)', async () => {
    // Deploy 1 pinned the opposite: a memberless signed-in Player could still
    // read and self-write beneath an Event that already said 'enforced'. Deploy
    // 2 replaces that dark-boundary assertion with the live one, and keeps the
    // off-state proof that the switch, not the deploy, decides.
    await seedEvent('enforced');
    await assertFails(getDoc(doc(db(MEMBERLESS_PLAYER), eventPath())));
    await assertFails(
      setDoc(
        doc(db(MEMBERLESS_PLAYER), `${eventPath()}/players/${MEMBERLESS_PLAYER}`),
        { uid: MEMBERLESS_PLAYER, displayName: 'Memberless player' },
      ),
    );

    await seedEvent('off');
    await assertSucceeds(getDoc(doc(db(MEMBERLESS_PLAYER), eventPath())));
    await assertSucceeds(
      setDoc(
        doc(db(MEMBERLESS_PLAYER), `${eventPath()}/players/${MEMBERLESS_PLAYER}`),
        { uid: MEMBERLESS_PLAYER, displayName: 'Memberless player' },
      ),
    );
  });

  it('pins the root Event write arm to the frozen-switch composition', () => {
    // Scoped to the one arm this suite owns (#1099): the root Event write must
    // route through the single helper that composes the Admin roster, the
    // create-vs-update null guard, admission, and the switch freeze. Global
    // helper call counts belong to the inventory suite, not here.
    const rootWrite = rootEventWriteAllow();
    // The arm keeps its field-shape validators after the helper; only the
    // authorization head is this suite's concern.
    expect(rootWrite).toMatch(
      /^allow create, update: if eventConfigWriteAuthorized\(eventId\)/,
    );
    expect(rootWrite).not.toMatch(/\bisAdmin\(eventId\)/);

    const helperStart = EXECUTABLE_RULES.indexOf(
      'function eventConfigWriteAuthorized(eventId)',
    );
    expect(helperStart).toBeGreaterThan(-1);
    const helper = EXECUTABLE_RULES.slice(
      helperStart,
      EXECUTABLE_RULES.indexOf('}', helperStart) + 1,
    );
    expect(helper).toMatch(/isAdminWithEvent\(event\)/);
    expect(helper).toMatch(/resource == null/);
    expect(helper).toMatch(/admittedWithEvent\(eventId, event\)/);
    expect(helper).toMatch(/membershipEnforcementUnchanged\(\)/);

    // One switch read site: a second reader would be a second switch
    // semantics, which is the drift the freeze exists to prevent.
    expect(
      EXECUTABLE_RULES.match(
        /event\.get\('membershipEnforcement', 'off'\)/g,
      ),
    ).toHaveLength(1);
  });
});
