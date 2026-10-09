import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { isGenerationMismatch, isObjectAlreadyGone } from './proofStorageDeletes';
import { PRIVATE_PROOF_MEDIA_POLICY } from './proofMediaTokens';

export const MEDIA_HOLD_LEASE_MS = 10 * 60_000;
export const HIDE_COMMIT_MARGIN_MS = 2 * 60_000;
const ATTEMPTS = 8;
const REPAIRS = 'proofMediaHoldRepairs';
interface CommitTime { seconds: number; nanoseconds: number }
export interface HoldProof {
  exists: boolean;
  data?: { status?: unknown; safetyHide?: unknown; storagePath?: unknown };
  updateTime?: CommitTime;
  readTime: CommitTime;
}
export interface HoldMetadata {
  generation?: string | number;
  metageneration?: string | number;
  cacheControl?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
export interface HoldScope { eventId: string; proofId: string }
export interface HoldRepair extends HoldScope { key: string; revision: number }
export interface ProofMediaHoldStore {
  now(): number;
  proof(scope: HoldScope): Promise<HoldProof>;
  objects(scope: HoldScope): Promise<string[]>;
  metadata(path: string): Promise<HoldMetadata>;
  patch(path: string, metadata: HoldMetadata, metageneration: string | number, generation: string | number): Promise<void>;
  enqueue(scope: HoldScope, dueAt: number): Promise<void>;
}
export interface HoldRepairStore extends ProofMediaHoldStore {
  due(): Promise<HoldRepair[]>;
  acknowledge(job: HoldRepair): Promise<void>;
}

/** Lossless, lexically ordered Firestore time, including pre-1970 timestamps. */
export function proofMediaVersion(time: CommitTime): string {
  if (!time || !Number.isInteger(time.seconds) || time.seconds < -62135596800
    || time.seconds > 253402300799 || !Number.isInteger(time.nanoseconds)
    || time.nanoseconds < 0 || time.nanoseconds > 999999999) throw new Error('Invalid Firestore commit time');
  return `${String(time.seconds + 62135596800).padStart(12, '0')}.${String(time.nanoseconds).padStart(9, '0')}`;
}

/** Wanted state depends ONLY on this Proof snapshot. */
export function wantedProofMediaHold(proof: HoldProof): 'true' | 'false' {
  return proof.exists && proof.data?.status === 'active' && proof.data.safetyHide !== true ? 'false' : 'true';
}

function scopeValid(scope: HoldScope): void {
  for (const value of [scope.eventId, scope.proofId]) {
    if (!value || value === '.' || value === '..' || /[/\\\x00-\x1f]/.test(value)) throw new Error('Invalid hold scope');
  }
}
function isProofObject(path: string, scope: HoldScope): boolean {
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === 'proofs' && parts[1] === scope.eventId
    && !!parts[2] && (['jpg', 'webm', 'm4a'].some(ext => parts[3] === `${scope.proofId}.${ext}`)
      || parts[3] === `${scope.proofId}_thumb.jpg`);
}
function generation(metadata: HoldMetadata): string | number {
  const value = metadata.metageneration;
  if (value == null || !/^[1-9][0-9]*$/.test(String(value))) throw new Error('Invalid object metageneration');
  return value;
}
function objectGeneration(metadata: HoldMetadata): string | number {
  const value = metadata.generation;
  if (value == null || !/^[1-9][0-9]*$/.test(String(value))) throw new Error('Invalid object generation');
  return value;
}
function leaseDeadline(metadata: HoldMetadata): number | null {
  const value = metadata.metadata?.faLease;
  if (value == null) return null;
  const deadline = Number(value);
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(deadline)) throw new Error('Invalid media lease');
  return deadline;
}
function sourceVersion(metadata: HoldMetadata): string | undefined {
  const value = metadata.metadata?.faSrc;
  if (value == null) return undefined;
  if (typeof value !== 'string' || !/^[0-9]{12}\.[0-9]{9}$/.test(value)
    || value > '315537897599.999999999') throw new Error('Invalid media source version');
  return value;
}
function boundObjects(paths: string[], scope: HoldScope): string[] {
  if (paths.some(path => !isProofObject(path, scope))) throw new Error('Object outside hold scope');
  return [...new Set(paths)];
}

/** Current reads only. A metadata conflict restarts from the Proof read. */
export async function reconcileProofMediaHold(scope: HoldScope, store: ProofMediaHoldStore): Promise<void> {
  scopeValid(scope);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const proof = await store.proof(scope);
    const version = proofMediaVersion(proof.exists ? proof.updateTime! : proof.readTime);
    const wanted = wantedProofMediaHold(proof);
    const objects = boundObjects(await store.objects(scope), scope);
    try {
      for (const path of objects) {
        let current: HoldMetadata;
        try { current = await store.metadata(path); }
        catch (error) { if (isObjectAlreadyGone(error)) continue; throw error; }
        const source = sourceVersion(current);
        if (source !== undefined && version < source) continue;
        // A different uploader/extension is an orphan, even with the same id.
        const main = proof.data?.storagePath;
        const bound = typeof main === 'string' && isProofObject(main, scope)
          && (path === main || path === main.replace(/\.(jpg|webm|m4a)$/, '_thumb.jpg'));
        const hold = wanted === 'false' && bound ? 'false' : 'true';
        const lease = leaseDeadline(current);
        const liveLease = lease !== null && store.now() < lease;
        if (hold === 'false' && liveLease) { await store.enqueue(scope, lease); continue; }
        const clean = hold === 'false' || (current.metadata?.firebaseStorageDownloadTokens == null
          && current.cacheControl === PRIVATE_PROOF_MEDIA_POLICY);
        if (source === version && current.metadata?.faHold === hold && clean
          && (lease === null || liveLease)) continue;
        await store.patch(path, {
          metadata: { faHold: hold, faSrc: version,
            // Preserve every live pre-hold lease, including a hold-direction write.
            // Otherwise an overlapping restore could lift before that hide commits.
            ...(!liveLease ? { faLease: null } : {}),
            ...(hold === 'true' ? { firebaseStorageDownloadTokens: null } : {}),
          },
          ...(hold === 'true' ? { cacheControl: PRIVATE_PROOF_MEDIA_POLICY } : {}),
        }, generation(current), objectGeneration(current));
      }
      return;
    } catch (error) {
      if (!isGenerationMismatch(error)) throw error;
    }
  }
  throw new Error('Media hold contention; retry reconciliation');
}

export interface HideMediaLease { expiresAt: number; commitBefore: number }
export function assertHideCommitAllowed(lease: HideMediaLease, now: number): void {
  if (!Number.isSafeInteger(now) || now >= lease.commitBefore) throw new Error('Hide media lease must be renewed');
}

/** Reusable hide pre-hold: never advances faSrc and schedules its own repair. */
export async function preHoldProofMedia(scope: HoldScope, store: ProofMediaHoldStore): Promise<HideMediaLease> {
  scopeValid(scope);
  const expiresAt = store.now() + MEDIA_HOLD_LEASE_MS;
  const lease = { expiresAt, commitBefore: expiresAt - HIDE_COMMIT_MARGIN_MS };
  // Persist the repair FIRST: even a crash after the first object has a wakeup.
  await store.enqueue(scope, expiresAt);
  for (const path of boundObjects(await store.objects(scope), scope)) {
    let written = false;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      assertHideCommitAllowed(lease, store.now());
      try {
        const current = await store.metadata(path);
        const existing = leaseDeadline(current);
        // Never shorten another hide's live lease.
        const deadline = Math.max(expiresAt, existing ?? 0);
        await store.patch(path, { cacheControl: PRIVATE_PROOF_MEDIA_POLICY,
          metadata: { faHold: 'true', faLease: String(deadline), firebaseStorageDownloadTokens: null },
        }, generation(current), objectGeneration(current));
        written = true; break;
      } catch (error) {
        if (isObjectAlreadyGone(error)) { written = true; break; }
        if (!isGenerationMismatch(error)) throw error;
      }
    }
    if (!written) throw new Error('Pre-hold contention; retry hide');
  }
  assertHideCommitAllowed(lease, store.now());
  return lease;
}

/** Future hide callers prepare first; the final bounded commit starts before the margin. */
export async function withProofMediaHideLease(
  scope: HoldScope, store: ProofMediaHoldStore,
  prepare: (lease: HideMediaLease) => Promise<() => Promise<void>>,
): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const lease = await preHoldProofMedia(scope, store);
    const commit = await prepare(lease);
    if (store.now() >= lease.commitBefore) continue; // renew and prepare again
    assertHideCommitAllowed(lease, store.now());
    await commit();
    return;
  }
  throw new Error('Hide preparation repeatedly overran its media lease');
}

export async function runProofMediaHoldRepairs(store: HoldRepairStore): Promise<void> {
  let failed = false;
  for (const job of await store.due()) {
    try {
      await reconcileProofMediaHold(job, store);
      await store.acknowledge(job);
    } catch { failed = true; /* Keep this job; continue independent repairs. */ }
  }
  if (failed) throw new Error('Media hold repairs remain pending');
}

/** Server-only durable wakeups, scanned every minute; no client collection access. */
export function adminProofMediaHoldStore(bucket: ReturnType<Storage['bucket']>, db: Firestore): HoldRepairStore {
  return {
    now: Date.now,
    async proof({ eventId, proofId }) {
      const snap = await db.doc(`events/${eventId}/proofs/${proofId}`).get();
      return { exists: snap.exists, data: snap.data(), updateTime: snap.updateTime, readTime: snap.readTime };
    },
    async objects(scope) {
      const paths: string[] = [];
      let pageToken: string | undefined;
      const seen = new Set<string>();
      do {
        const [files, next] = await bucket.getFiles({ prefix: `proofs/${scope.eventId}/`,
          autoPaginate: false, maxResults: 100, ...(pageToken ? { pageToken } : {}),
        });
        paths.push(...files.map(file => file.name).filter(path => isProofObject(path, scope)));
        pageToken = next?.pageToken;
        if (pageToken && seen.has(pageToken)) throw new Error('Hold listing did not advance');
        if (pageToken) seen.add(pageToken);
      } while (pageToken);
      return paths;
    },
    async metadata(path) { return (await bucket.file(path).getMetadata())[0]; },
    async patch(path, metadata, metageneration, generation) {
      await bucket.file(path).setMetadata({ ...metadata }, { ifMetagenerationMatch: metageneration, ifGenerationMatch: generation });
    },
    async enqueue(scope, dueAt) {
      scopeValid(scope);
      const key = createHash('sha256').update(JSON.stringify([scope.eventId, scope.proofId])).digest('hex');
      const ref = db.collection(REPAIRS).doc(key);
      await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        const revision = current?.revision ?? 0;
        if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid repair revision');
        const prior = current?.dueAt;
        tx.set(ref, { ...scope, revision: revision + 1,
          dueAt: typeof prior === 'number' && prior > Date.now() ? Math.min(prior, dueAt) : dueAt });
      });
    },
    async due() {
      const jobs = await db.collection(REPAIRS).where('dueAt', '<=', Date.now()).limit(100).get();
      return jobs.docs.map(doc => {
        const row = doc.data();
        const job = { key: doc.id, eventId: row.eventId, proofId: row.proofId, revision: row.revision };
        scopeValid(job);
        if (!Number.isSafeInteger(job.revision) || job.revision < 1) throw new Error('Invalid repair revision');
        return job;
      });
    },
    async acknowledge(job) {
      const ref = db.collection(REPAIRS).doc(job.key);
      await db.runTransaction(async tx => {
        const current = await tx.get(ref);
        if (current.data()?.revision === job.revision) tx.delete(ref);
      });
    },
  };
}
