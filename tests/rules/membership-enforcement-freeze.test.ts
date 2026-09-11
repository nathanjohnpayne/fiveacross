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

// Structural locator (#1100). Rather than the first substring hit, the arm is
// found by a small scanner over a string-aware, comment-free copy of the rules
// source that understands what a substring search cannot:
//
//   - comments and string literals: `//` and `/* */` comments are removed by
//     a pass that honours string literals (so a `//` inside a URL literal does
//     not truncate the line), and a `'}'` or `';'` inside a literal is data,
//     not structure (Codex P2 rounds 3 and 4 on #1194); removing comments
//     first also lets `match /events/{id} /* note */ {` parse (round 4);
//   - effective match paths: every `match <path> {` pushes its segments, so a
//     block is identified by the path it governs, not by its spelling.
//     `match /archives/{a} { match /events/{e} { ... } }` governs
//     `archives/.../events/...` (round 3), `match /events/{id}` and
//     `match /events/{eventId}` are the same block (round 2), and a literal
//     `match /events/production-event {` is a root Event block for one Event
//     and is counted too (round 4);
//   - recursive wildcards: `{name=**}` matches zero or more segments under
//     rules_version 2, so a grant inside `match /{document=**}` or
//     `match /events/{e}/{rest=**}` also reaches the root Event document
//     (round 3).
//
// What is enumerated: every `allow <verbs>: if ... ;` whose effective path can
// match some `events/<id>`, with the terminator found by the same string-aware
// scan (round 4). Exactly one of them may grant `create` or `write` and it is
// the arm this suite pins. Every other arm that grants `update` must be one of
// the approved archive-lifecycle arms, recognised structurally rather than
// waved through: it is Admin-gated (`isAdmittedAdmin(eventId)`) and it reads
// or writes the `archiving` handshake, and their number is pinned, so an
// unexpected update grant that could reach an Event document fails loudly
// instead of being ignored (round 4). A malformed source (an unbalanced block,
// an unterminated arm or literal) throws instead of pinning the wrong text.
const DOCUMENTS_ROOT = ['databases', '{database}', 'documents'];
const MATCH_PATH = /match\s+(\/[^\s{}]*(?:\{[^}]*\}[^\s{}]*)*)\s*\{/y;
const ALLOW_ARM = /allow\s+([a-z]+(?:\s*,\s*[a-z]+)*)\s*:\s*if\b/y;
const APPROVED_UPDATE_ONLY_ARMS = 4; // the archive-lifecycle handshake arms

function verbsOf(arm: string): string[] {
  return arm.split(',').map((verb) => verb.trim());
}

function isRecursiveWildcard(segment: string): boolean {
  return /^\{[A-Za-z_][A-Za-z0-9_]*=\*\*\}$/.test(segment);
}

function isSingleWildcard(segment: string): boolean {
  return /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment);
}

// Can the effective path pattern match a path of the target's shape? A target
// segment of `null` stands for "any one segment", so ['events', null] is every
// root Event document; a literal pattern segment matches only itself or the
// wildcard target, a `{x}` matches one segment, a `{x=**}` zero or more.
function pathCanMatch(pattern: string[], target: Array<string | null>): boolean {
  if (pattern.length === 0) return target.length === 0;
  const [head, ...rest] = pattern;
  if (isRecursiveWildcard(head)) {
    for (let take = 0; take <= target.length; take += 1) {
      if (pathCanMatch(rest, target.slice(take))) return true;
    }
    return false;
  }
  if (target.length === 0) return false;
  const want = target[0];
  if (want !== null && head !== want && !isSingleWildcard(head)) return false;
  return pathCanMatch(rest, target.slice(1));
}

function stripDocumentsRoot(path: string[]): string[] | null {
  for (let i = 0; i < DOCUMENTS_ROOT.length; i += 1) {
    if (path[i] !== DOCUMENTS_ROOT[i] && !(i === 1 && isSingleWildcard(path[i] ?? ''))) return null;
  }
  return path.slice(DOCUMENTS_ROOT.length);
}

// Remove `//` and `/* */` comments while honouring string literals; the result
// is what the scanner walks, so no later step needs comment awareness.
function withoutComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      if (j >= src.length || src[j] === '\n') throw new Error('rules source has an unterminated string literal');
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      out += ' ';
      i = nl - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new Error('rules source has an unterminated block comment');
      out += ' ';
      i = close + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// Index of the string literal's closing quote, or -1 if it does not close on
// this line (rules literals never span lines).
function endOfLiteral(src: string, open: number): number {
  const quote = src[open];
  let j = open + 1;
  while (j < src.length && src[j] !== quote && src[j] !== '\n') {
    if (src[j] === '\\') j += 1;
    j += 1;
  }
  return j < src.length && src[j] === quote ? j : -1;
}

// Index of the `;` that terminates the arm starting at `start`, skipping any
// `;` inside a string literal.
function armTerminator(src: string, start: number): number {
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const close = endOfLiteral(src, i);
      if (close < 0) throw new Error('an allow arm contains an unterminated string literal');
      i = close;
      continue;
    }
    if (ch === ';') return i;
  }
  return -1;
}

function isApprovedLifecycleArm(arm: string): boolean {
  return /\bisAdmittedAdmin\(eventId\)/.test(arm) && /'archiving'/.test(arm);
}

function rootEventWriteAllow(): string {
  const src = withoutComments(RULES_SOURCE);
  // One stack entry per open brace: the match path segments it introduced, or
  // null for a brace that is not a match block (a function body, for example).
  const scopes: Array<string[] | null> = [];
  const createArms: string[] = [];
  const updateOnlyArms: string[] = [];
  let rootEventBlocks = 0;
  let pendingMatch: string[] | null = null;
  const effectivePath = () => scopes.flatMap((scope) => scope ?? []);
  const boundary = (i: number) => i === 0 || !/[A-Za-z0-9_]/.test(src[i - 1]);

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const close = endOfLiteral(src, i);
      if (close < 0) throw new Error('rules source has an unterminated string literal');
      i = close;
      continue;
    }
    if (ch === 'm' && boundary(i)) {
      MATCH_PATH.lastIndex = i;
      const m = MATCH_PATH.exec(src);
      if (m !== null) {
        pendingMatch = m[1].split('/').filter((segment) => segment.length > 0);
        // Stop just before the block's own brace so the next iteration's `{`
        // branch pushes the scope (lastIndex points past the brace).
        i = MATCH_PATH.lastIndex - 2;
        continue;
      }
    }
    if (ch === '{') {
      scopes.push(pendingMatch);
      if (pendingMatch !== null) {
        const relative = stripDocumentsRoot(effectivePath());
        if (relative !== null && relative.length === 2 && pathCanMatch(relative, ['events', null])) {
          rootEventBlocks += 1;
        }
      }
      pendingMatch = null;
      continue;
    }
    if (ch === '}') {
      if (scopes.length === 0) throw new Error('rules source has an unbalanced closing brace');
      scopes.pop();
      continue;
    }
    if (ch === 'a' && boundary(i)) {
      ALLOW_ARM.lastIndex = i;
      const arm = ALLOW_ARM.exec(src);
      if (arm !== null) {
        const relative = stripDocumentsRoot(effectivePath());
        if (relative !== null && pathCanMatch(relative, ['events', null])) {
          const end = armTerminator(src, i);
          if (end < 0) throw new Error('an allow arm reaching the root Event document is unterminated');
          const text = src.slice(i, end + 1).replace(/\s+/g, ' ').trim();
          const verbs = verbsOf(arm[1]);
          if (verbs.includes('create') || verbs.includes('write')) createArms.push(text);
          else if (verbs.includes('update')) updateOnlyArms.push(text);
          i = end;
        }
      }
    }
  }
  if (scopes.length !== 0) throw new Error('rules source has an unclosed block');
  if (rootEventBlocks !== 1) {
    throw new Error(`root Event match block: expected exactly one block governing events/{id}, found ${rootEventBlocks}`);
  }
  if (createArms.length !== 1) {
    throw new Error(
      `expected exactly one allow arm granting create or write that can reach events/{id}, found ${createArms.length}: ${createArms.map((a) => a.slice(0, 60)).join(' | ')}`,
    );
  }
  const unapproved = updateOnlyArms.filter((arm) => !isApprovedLifecycleArm(arm));
  if (unapproved.length > 0 || updateOnlyArms.length !== APPROVED_UPDATE_ONLY_ARMS) {
    throw new Error(
      `update-only arms reaching events/{id}: expected exactly ${APPROVED_UPDATE_ONLY_ARMS} Admin-gated archive-lifecycle arms, found ${updateOnlyArms.length} (${unapproved.length} unrecognised): ${unapproved.map((a) => a.slice(0, 60)).join(' | ')}`,
    );
  }
  return createArms[0];
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
