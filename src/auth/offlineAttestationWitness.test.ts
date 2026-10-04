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
});
