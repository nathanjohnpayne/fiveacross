import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockWebLocks } from '../../tests/support/mockWebLocks';
import { hasOfflineAttestation, recordOfflineAttestation } from './offlineAttestationWitness';

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); installMockWebLocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('minimal offline render witness (#1411)', () => {
  it('contains only a boolean and isolates project and UID', async () => {
    await recordOfflineAttestation('project-a', 'alice', true);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(localStorage.key(0)!)).toBe('1');
    expect(await hasOfflineAttestation('project-a', 'alice')).toBe(true);
    expect(await hasOfflineAttestation('project-a', 'bob')).toBe(false);
    expect(await hasOfflineAttestation('project-b', 'alice')).toBe(false);
  });
  it('checks an existing witness without another key when deletion is refused', async () => {
    await recordOfflineAttestation('lookup-project', 'alice', true);
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    expect(await hasOfflineAttestation('lookup-project', 'alice')).toBe(true);
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe('fiveacross:lookup-project:offline-attested:alice');
    expect(remove).not.toHaveBeenCalled();
  });
  it('does not create a witness or probe for an absent account', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    expect(await hasOfflineAttestation('missing-project', 'bob')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(set).not.toHaveBeenCalled();
  });
  it('refuses a failed scoped write without leaving another identity-bearing key', async () => {
    await recordOfflineAttestation('scoped-failure-project', 'alice', true);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('write refused'); });
    expect(await hasOfflineAttestation('scoped-failure-project', 'alice')).toBe(false);
    expect(set).toHaveBeenCalledWith('fiveacross:scoped-failure-project:offline-attested:alice', '1');
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(localStorage.key(0)!)).toBe('1');
  });
  it('refuses rendering when the scoped write reads back false', async () => {
    await recordOfflineAttestation('roundtrip-project', 'alice', true);
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, scopedKey, value) {
      realSet.call(this, scopedKey, value);
      realSet.call(this, 'fiveacross:roundtrip-project:offline-attested:alice', '0');
    });
    expect(await hasOfflineAttestation('roundtrip-project', 'alice')).toBe(false);
    expect(localStorage.length).toBe(1);
  });
  it('does not resurrect another document revocation queued during lookup', async () => {
    const scopedKey = 'fiveacross:cross-document:offline-attested:alice';
    await recordOfflineAttestation('cross-document', 'alice', true);
    vi.resetModules();
    const otherDocument = await import('./offlineAttestationWitness');
    const realGet = Storage.prototype.getItem;
    let revocation: Promise<void> | undefined;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
      const value = realGet.call(this, name);
      if (name === scopedKey && !revocation) revocation = Promise.resolve(otherDocument.recordOfflineAttestation('cross-document', 'alice', false));
      return value;
    });
    await hasOfflineAttestation('cross-document', 'alice');
    await revocation;
    expect(realGet.call(localStorage, scopedKey)).not.toBe('1');
    vi.restoreAllMocks();
    vi.resetModules();
    const freshDocument = await import('./offlineAttestationWitness');
    expect(await freshDocument.hasOfflineAttestation('cross-document', 'alice')).toBe(false);
  });
  it('refuses rendering when the origin lock is unavailable or denied', async () => {
    await recordOfflineAttestation('no-lock-project', 'alice', true);
    vi.stubGlobal('navigator', {});
    expect(await hasOfflineAttestation('no-lock-project', 'alice')).toBe(false);
    const request = installMockWebLocks();
    request.mockRejectedValue(new Error('Lock denied.'));
    expect(await hasOfflineAttestation('no-lock-project', 'alice')).toBe(false);
  });
  it('bounds a busy lock and does not mutate after a late grant', async () => {
    const scopedKey = 'fiveacross:busy-project:offline-attested:alice';
    await recordOfflineAttestation('busy-project', 'alice', true);
    const request = installMockWebLocks();
    let release = () => {};
    const held = request(scopedKey, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    vi.useFakeTimers();
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const lookup = hasOfflineAttestation('busy-project', 'alice');
    await vi.advanceTimersByTimeAsync(1001);
    expect(await lookup).toBe(false);
    release();
    await held;
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(1);
  });
  it('handles a native-style AbortError that arrives after the lock deadline', async () => {
    await recordOfflineAttestation('late-abort-project', 'alice', true);
    vi.useFakeTimers();
    let aborted = false;
    let rejected = false;
    const request = vi.fn((_name: string, options: LockOptions) => new Promise<never>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => {
        aborted = true;
        setTimeout(() => {
          rejected = true;
          reject(new DOMException('Lock request aborted.', 'AbortError'));
        }, 10);
      }, { once: true });
    }));
    vi.stubGlobal('navigator', { locks: { request } });
    const lookup = hasOfflineAttestation('late-abort-project', 'alice');
    await vi.advanceTimersByTimeAsync(1001);
    expect(await lookup).toBe(false);
    expect(aborted).toBe(true);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(rejected).toBe(true);
    // Promise.race observes its losing input even after its winner settled.
    expect(localStorage.getItem('fiveacross:late-abort-project:offline-attested:alice')).toBe('1');
  });
  it('preserves a successful other-document revocation before lookup acquires its lock', async () => {
    await recordOfflineAttestation('first-revocation', 'alice', true);
    vi.resetModules();
    const otherDocument = await import('./offlineAttestationWitness');
    const revoke = otherDocument.recordOfflineAttestation('first-revocation', 'alice', false);
    const lookup = hasOfflineAttestation('first-revocation', 'alice');
    await revoke;
    expect(await lookup).toBe(false);
    expect(localStorage.length).toBe(0);
  });
  it('keeps a newer in-process revocation when an older positive writer was queued', async () => {
    const scopedKey = 'fiveacross:newer-revocation:offline-attested:alice';
    await recordOfflineAttestation('newer-revocation', 'alice', true);
    const request = installMockWebLocks();
    let release = () => {};
    const held = request(scopedKey, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const older = recordOfflineAttestation('newer-revocation', 'alice', true).then(() => 'written', () => 'superseded');
    const newer = recordOfflineAttestation('newer-revocation', 'alice', false).catch(() => {});
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
      if (value === '0') throw new Error('false write refused');
      realSet.call(this, name, value);
    });
    release();
    await held;
    await newer;
    expect(await older).toBe('superseded');
    vi.restoreAllMocks();
    expect(await hasOfflineAttestation('newer-revocation', 'alice')).toBe(false);
    await recordOfflineAttestation('newer-revocation', 'alice', true);
    expect(await hasOfflineAttestation('newer-revocation', 'alice')).toBe(true);
  });
  it('checks the captured writer after lock acquisition before recording true', async () => {
    await expect(recordOfflineAttestation('retired-project', 'alice', true, () => { throw new Error('retired'); })).rejects.toThrow('retired');
    expect(localStorage.length).toBe(0);
  });
  it('retires a previously true witness on definitive server revocation', async () => {
    await recordOfflineAttestation('project', 'alice', true);
    await recordOfflineAttestation('project', 'alice', false);
    expect(await hasOfflineAttestation('project', 'alice')).toBe(false);
    expect(localStorage.length).toBe(0);
  });
  it('fails closed for readable but unwritable storage', async () => {
    await recordOfflineAttestation('project', 'alice', true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(await hasOfflineAttestation('project', 'alice')).toBe(false);
  });
  it('a failed removal writes a same-key false tombstone that survives reload', async () => {
    await recordOfflineAttestation('removal-project', 'alice', true);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    // The production caller catches storage errors after a definitive server read.
    try { await recordOfflineAttestation('removal-project', 'alice', false); } catch { /* advisory storage */ }
    vi.restoreAllMocks();
    vi.resetModules();
    const reloaded = await import('./offlineAttestationWitness');
    expect(await reloaded.hasOfflineAttestation('removal-project', 'alice')).toBe(false);
    expect(localStorage.getItem('fiveacross:removal-project:offline-attested:alice')).toBe('0');
  });
  it('all-write failure retires the process witness but cannot convey revocation to a fresh process', async () => {
    await recordOfflineAttestation('all-refused-project', 'alice', true);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('write refused'); });
    try { await recordOfflineAttestation('all-refused-project', 'alice', false); } catch { /* advisory storage */ }
    vi.restoreAllMocks();
    // Reload before the original process gets any chance to retry its tombstone.
    vi.resetModules();
    const freshProcess = await import('./offlineAttestationWitness');
    // This is the owner-accepted persistence limit, not a repaired reload.
    expect(await freshProcess.hasOfflineAttestation('all-refused-project', 'alice')).toBe(true);
    expect(await hasOfflineAttestation('all-refused-project', 'alice')).toBe(false);
    expect(await freshProcess.hasOfflineAttestation('all-refused-project', 'alice')).toBe(false);
    await recordOfflineAttestation('all-refused-project', 'alice', true);
    expect(await hasOfflineAttestation('all-refused-project', 'alice')).toBe(true);
  });

  it('a same-process read retries failed revocation after storage recovers before reload', async () => {
    await recordOfflineAttestation('retry-project', 'alice', true);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove refused'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('write refused'); });
    try { await recordOfflineAttestation('retry-project', 'alice', false); } catch { /* advisory storage */ }
    expect(await hasOfflineAttestation('retry-project', 'alice')).toBe(false);
    vi.restoreAllMocks();
    expect(await hasOfflineAttestation('retry-project', 'alice')).toBe(false);
    expect(localStorage.getItem('fiveacross:retry-project:offline-attested:alice')).toBeNull();
    vi.resetModules();
    const freshProcess = await import('./offlineAttestationWitness');
    expect(await freshProcess.hasOfflineAttestation('retry-project', 'alice')).toBe(false);
  });

});
