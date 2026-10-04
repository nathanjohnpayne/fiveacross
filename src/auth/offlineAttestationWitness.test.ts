import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasOfflineAttestation, recordOfflineAttestation } from './offlineAttestationWitness';

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
describe('minimal offline render witness (#1411)', () => {
  it('contains only a boolean and isolates project and UID', () => {
    recordOfflineAttestation('project-a', 'alice', true);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(localStorage.key(0)!)).toBe('1');
    expect(hasOfflineAttestation('project-a', 'alice')).toBe(true);
    expect(hasOfflineAttestation('project-a', 'bob')).toBe(false);
    expect(hasOfflineAttestation('project-b', 'alice')).toBe(false);
  });
  it('retires a previously true witness on definitive server revocation', () => {
    recordOfflineAttestation('project', 'alice', true);
    recordOfflineAttestation('project', 'alice', false);
    expect(hasOfflineAttestation('project', 'alice')).toBe(false);
    expect(localStorage.length).toBe(0);
  });
  it('fails closed for readable but unwritable storage', () => {
    recordOfflineAttestation('project', 'alice', true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(hasOfflineAttestation('project', 'alice')).toBe(false);
  });
  it('a failed removal writes a same-key false tombstone that survives reload', async () => {
    recordOfflineAttestation('removal-project', 'alice', true);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    // The production caller catches storage errors after a definitive server read.
    try { recordOfflineAttestation('removal-project', 'alice', false); } catch { /* advisory storage */ }
    vi.restoreAllMocks();
    vi.resetModules();
    const reloaded = await import('./offlineAttestationWitness');
    expect(reloaded.hasOfflineAttestation('removal-project', 'alice')).toBe(false);
    expect(localStorage.getItem('fiveacross:removal-project:offline-attested:alice')).toBe('0');
  });
  it('all-write failure retires the process witness but cannot convey revocation to a fresh process', async () => {
    recordOfflineAttestation('all-refused-project', 'alice', true);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('write refused'); });
    try { recordOfflineAttestation('all-refused-project', 'alice', false); } catch { /* advisory storage */ }
    vi.restoreAllMocks();
    // Reload before the original process gets any chance to retry its tombstone.
    vi.resetModules();
    const freshProcess = await import('./offlineAttestationWitness');
    // This is the owner-accepted persistence limit, not a repaired reload.
    expect(freshProcess.hasOfflineAttestation('all-refused-project', 'alice')).toBe(true);
    expect(hasOfflineAttestation('all-refused-project', 'alice')).toBe(false);
    expect(freshProcess.hasOfflineAttestation('all-refused-project', 'alice')).toBe(false);
    recordOfflineAttestation('all-refused-project', 'alice', true);
    expect(hasOfflineAttestation('all-refused-project', 'alice')).toBe(true);
  });

  it('a same-process read retries failed revocation after storage recovers before reload', async () => {
    recordOfflineAttestation('retry-project', 'alice', true);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('write refused'); });
    try { recordOfflineAttestation('retry-project', 'alice', false); } catch { /* advisory storage */ }
    expect(hasOfflineAttestation('retry-project', 'alice')).toBe(false);
    vi.restoreAllMocks();
    expect(hasOfflineAttestation('retry-project', 'alice')).toBe(false);
    expect(localStorage.getItem('fiveacross:retry-project:offline-attested:alice')).toBeNull();
    vi.resetModules();
    const freshProcess = await import('./offlineAttestationWitness');
    expect(freshProcess.hasOfflineAttestation('retry-project', 'alice')).toBe(false);
  });

});
