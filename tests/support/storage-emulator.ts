// Actually emptying the Storage emulator between rules tests (#1153, Codex
// round 3 P2).
//
// `RulesTestEnvironment.clearStorage()` is a no-op for this repo's object
// layout. Its implementation lists the bucket ROOT and deletes the `items` it
// finds — and `listAll()` is not recursive: it returns the files at that level
// plus the `prefixes` below it. Every object this app writes lives under a
// prefix (`proofs/{eventId}/{uid}/{file}`, `avatars/{file}`,
// `bug-reports/{...}`), so the root has no `items` at all and the call deletes
// nothing. Both rules suites have been calling it in `beforeEach` and carrying
// every object for the whole file.
//
// That was invisible while `storage.rules` allowed an overwrite: a test that
// re-uploaded to a path a previous test had used simply succeeded either way.
// It stopped being invisible when proof objects became IMMUTABLE (`resource ==
// null` on the proof-media arm), because the second test's upload is then a
// denied overwrite of an object its own `beforeEach` was supposed to have
// removed — a test failing on leaked state rather than on the rule it asserts.
//
// So this walks the prefixes and deletes for real. Rules are disabled for the
// walk, which is what makes it a fixture operation rather than something the
// arms under test could refuse.
import type { RulesTestContext, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteObject, listAll, ref, type StorageReference } from 'firebase/storage';

/** Delete every object at or below `folder`, depth-first. */
async function emptyPrefix(folder: StorageReference): Promise<void> {
  const { items, prefixes } = await listAll(folder);
  await Promise.all(items.map((item) => deleteObject(item)));
  // Sequential rather than parallel across prefixes: the emulator is a single
  // local process and a wide fan-out buys nothing on a fixture this small.
  for (const prefix of prefixes) await emptyPrefix(prefix);
}

/**
 * Empty the Storage emulator's default bucket, prefixes included.
 *
 * Drop-in replacement for `testEnv.clearStorage()` in a `beforeEach`. Safe on an
 * already-empty bucket, and safe on a test env with no Storage configured only
 * in the sense that it will throw the same way `clearStorage()` would — call it
 * from suites that wired Storage in.
 */
export async function clearStorageDeep(testEnv: RulesTestEnvironment): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await emptyPrefix(ref(context.storage()));
  });
}
