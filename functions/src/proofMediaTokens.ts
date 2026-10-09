import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { isGenerationMismatch, isObjectAlreadyGone } from './proofStorageDeletes';

/** Same policy as the browser writer; parity is pinned by the Functions suite. */
export const PRIVATE_PROOF_MEDIA_POLICY = 'private, no-store, max-age=0';

interface MediaMetadata {
  metageneration?: string | number;
  cacheControl?: string;
  metadata?: Record<string, string | boolean | number | null>;
}

export interface TokenSweepProgress {
  bucket: string;
  eventId: string;
  status: 'pending' | 'complete';
  pageToken: string | null;
  processed: number;
  revision: number;
}

/** Every platform seam is injected. Progress updates must be transactional. */
export interface ProofMediaTokenStore {
  bucket: string;
  metadata(path: string): Promise<MediaMetadata>;
  strip(path: string, metageneration: string | number): Promise<void>;
  list(prefix: string, pageToken: string | null): Promise<{ paths: string[]; next: string | null }>;
  progress(key: string, update: (row: TokenSweepProgress | null) => TokenSweepProgress): Promise<TokenSweepProgress>;
}

function pathSegment(value: string): void {
  if (!value || value === '.' || value === '..' || /[/\\\x00-\x1f]/.test(value)) {
    throw new Error('Invalid proof-media scope');
  }
}

/** Strip tokens and set policy in ONE conditional metadata write, never bytes. */
export async function stripProofMediaTokens(path: string, store: ProofMediaTokenStore): Promise<void> {
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== 'proofs') throw new Error('Not proof media');
  parts.slice(1).forEach(pathSegment);
  // Bound contention; failure leaves the sweep pending and a retry resumes it.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const metadata = await store.metadata(path);
      if (metadata.metadata?.firebaseStorageDownloadTokens == null
        && metadata.cacheControl === PRIVATE_PROOF_MEDIA_POLICY) return;
      const generation = metadata.metageneration;
      if (generation == null || !/^[1-9][0-9]*$/.test(String(generation))) {
        throw new Error('Missing proof-media metageneration');
      }
      await store.strip(path, generation);
      return;
    } catch (error) {
      if (isObjectAlreadyGone(error)) return;
      if (!isGenerationMismatch(error)) throw error;
    }
  }
  throw new Error('Proof-media metadata contention; retry sweep');
}

/**
 * Resume one named operation. A fresh revocation uses a fresh sweepId.
 * Competing workers may repeat a page, but only its current revision advances.
 * A failed object/page never advances the cursor or publishes complete.
 */
export async function sweepProofMediaTokens(
  eventId: string,
  sweepId: string,
  store: ProofMediaTokenStore,
): Promise<TokenSweepProgress> {
  pathSegment(eventId);
  pathSegment(sweepId);
  const key = createHash('sha256').update(JSON.stringify([store.bucket, eventId, sweepId])).digest('hex');
  let current = await store.progress(key, row => row ?? {
    bucket: store.bucket, eventId, status: 'pending', pageToken: null, processed: 0, revision: 0,
  });
  if (current.bucket !== store.bucket || current.eventId !== eventId) throw new Error('Sweep scope mismatch');
  while (current.status !== 'complete') {
    if (current.bucket !== store.bucket || current.eventId !== eventId) throw new Error('Sweep scope mismatch');
    const prefix = `proofs/${eventId}/`;
    const page = await store.list(prefix, current.pageToken);
    if (page.next !== null && page.next === current.pageToken) throw new Error('Sweep cursor did not advance');
    for (const path of page.paths) {
      if (!path.startsWith(prefix)) throw new Error('Sweep object outside Event');
      await stripProofMediaTokens(path, store);
    }
    const observed = current;
    current = await store.progress(key, row => {
      if (!row) throw new Error('Sweep progress disappeared');
      if (row.revision !== observed.revision) return row;
      return {
        ...row,
        pageToken: page.next,
        processed: row.processed + page.paths.length,
        revision: row.revision + 1,
        status: page.next === null ? 'complete' : 'pending',
      };
    });
  }
  return current;
}

function readProgress(value: FirebaseFirestore.DocumentData | undefined): TokenSweepProgress | null {
  if (value === undefined) return null;
  if (typeof value.bucket !== 'string' || typeof value.eventId !== 'string'
    || !['pending', 'complete'].includes(value.status)
    || !(value.pageToken === null || typeof value.pageToken === 'string')
    || !Number.isSafeInteger(value.processed) || value.processed < 0
    || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('Invalid proof-media sweep progress');
  }
  return value as TokenSweepProgress;
}

/** Admin SDK adapter. Constructing it performs no I/O; no trigger ships here. */
export function adminProofMediaTokenStore(
  bucket: ReturnType<Storage['bucket']>,
  db: Firestore,
): ProofMediaTokenStore {
  return {
    bucket: bucket.name,
    async metadata(path) {
      const [metadata] = await bucket.file(path).getMetadata();
      return metadata;
    },
    async strip(path, metageneration) {
      await bucket.file(path).setMetadata({
        metadata: { firebaseStorageDownloadTokens: null },
        cacheControl: PRIVATE_PROOF_MEDIA_POLICY,
      }, { ifMetagenerationMatch: metageneration });
    },
    async list(prefix, pageToken) {
      const [files, next] = await bucket.getFiles({
        prefix, autoPaginate: false, maxResults: 100,
        ...(pageToken === null ? {} : { pageToken }),
      });
      return { paths: files.map(file => file.name), next: next?.pageToken ?? null };
    },
    async progress(key, update) {
      const reference = db.collection('proofMediaTokenSweeps').doc(key);
      return db.runTransaction(async transaction => {
        const row = readProgress((await transaction.get(reference)).data());
        const next = update(row);
        if (next !== row) transaction.set(reference, next);
        return next;
      });
    },
  };
}
