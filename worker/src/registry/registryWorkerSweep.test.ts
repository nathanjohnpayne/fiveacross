// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sweepProbeArtifacts, type ProbeSweepStorage } from './probeSweep';

class MemoryProbeSweepStorage implements ProbeSweepStorage {
  alarm: number | null = null;

  constructor(readonly values: Map<string, unknown>) {}

  async list<T>(options: { prefix: string; limit: number }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, options.limit) as [string, T][],
    );
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.values.delete(key);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

function expiryKey(expiresAt: number, artifactKey: string): string {
  return `probe/expiry/${String(expiresAt).padStart(16, '0')}:${encodeURIComponent(artifactKey)}`;
}

function principalKey(
  principal: { subject: string; keyFingerprint: string; region: string },
  artifactKey: string,
): string {
  return `probe/principal/${encodeURIComponent(principal.subject)}:${encodeURIComponent(
    principal.keyFingerprint,
  )}:${encodeURIComponent(principal.region)}/${encodeURIComponent(artifactKey)}`;
}

describe('probe expiry sweep recovery', () => {
  it('recovers expired challenge and attestation identities from malformed index values', async () => {
    const now = 2_000;
    const expiresAt = 1_000;
    const challengeKey = 'probe/challenge/malformed-challenge';
    const attestationKey = 'probe/attestation/malformed-attestation';
    const challengePrincipal = {
      subject: 'probe-challenge',
      keyVersion: 'probe-key/challenge',
      keyFingerprint: 'a'.repeat(64),
      region: 'us-west1',
    };
    const attestationPrincipal = {
      subject: 'probe-attestation',
      keyVersion: 'probe-key/attestation',
      keyFingerprint: 'b'.repeat(64),
      region: 'us-east1',
    };
    const values = new Map<string, unknown>([
      [challengeKey, challengePrincipal],
      [principalKey(challengePrincipal, challengeKey), true],
      [expiryKey(expiresAt, challengeKey), true],
      [attestationKey, attestationPrincipal],
      [principalKey(attestationPrincipal, attestationKey), true],
      [expiryKey(expiresAt, attestationKey), { artifactKey: 7 }],
    ]);
    const storage = new MemoryProbeSweepStorage(values);

    await sweepProbeArtifacts(storage, now);

    expect([...values.keys()]).toEqual([]);
    expect(storage.alarm).toBeNull();
  });

  it('retains a fresh malformed index as the sweep reference and schedules its expiry', async () => {
    const now = 1_000;
    const expiresAt = 2_000;
    const artifactKey = 'probe/challenge/fresh-malformed';
    const principal = {
      subject: 'probe-fresh',
      keyVersion: 'probe-key/fresh',
      keyFingerprint: 'c'.repeat(64),
      region: 'europe-west1',
    };
    const indexKey = expiryKey(expiresAt, artifactKey);
    const quotaKey = principalKey(principal, artifactKey);
    const values = new Map<string, unknown>([
      [artifactKey, principal],
      [quotaKey, true],
      [indexKey, false],
    ]);
    const storage = new MemoryProbeSweepStorage(values);

    await sweepProbeArtifacts(storage, now);

    expect([...values.keys()].sort()).toEqual([artifactKey, indexKey, quotaKey].sort());
    expect(storage.alarm).toBe(expiresAt + 1);
  });

  it('fails without deleting an expiry index whose key cannot recover the artifact identity', async () => {
    const indexKey = 'probe/expiry/not-a-canonical-index';
    const values = new Map<string, unknown>([[indexKey, true]]);
    const storage = new MemoryProbeSweepStorage(values);

    await expect(sweepProbeArtifacts(storage, 2_000)).rejects.toThrow('probe expiry index is malformed');
    expect(values.has(indexKey)).toBe(true);
  });
});
