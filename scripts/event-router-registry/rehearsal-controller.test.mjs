import { describe, expect, it, vi } from 'vitest';
import {
  cleanupRehearsal,
  provisionRehearsal,
  validateRehearsalManifest,
} from './rehearsal-controller.mjs';

const EVENT_HOST = 'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app';
const ROOT_HOST = 'r2-root-abcdefghijklmnopqrst.vacaybingo.com';

function manifest(hosts = [EVENT_HOST, ROOT_HOST]) {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    sourceCommit: 'a'.repeat(40),
    scriptVersion: 'registry-router-v1',
    creator: 'nathanjohnpayne',
    expiresAt: '2026-08-20T12:00:00.000Z',
    hosts: hosts.map((host, index) => ({
      host,
      class: host.includes('r2-root-') ? 'root-test' : 'synthetic',
      dnsRecordId: `dns-${index}`,
      routeId: `route-${index}`,
      expectedState: host.includes('r2-root-') ? 'root' : 'disabled',
    })),
  };
}

function deps() {
  return {
    reserveTransaction: vi.fn(),
    createExactDns: vi.fn(),
    attachExactRoute: vi.fn(),
    tombstoneAndWait: vi.fn(),
    removeExactRoute: vi.fn(),
    removeExactDns: vi.fn(),
    verifyAbsent: vi.fn(),
  };
}

describe('guarded rehearsal controller', () => {
  it('accepts only the two closed synthetic classes and at most 64 permanent reservations', () => {
    expect(validateRehearsalManifest(manifest(), { existingReservations: 62 })).toMatchObject({
      runId: 'run-1',
    });
    expect(() => validateRehearsalManifest(manifest(), { existingReservations: 63 })).toThrow('64');
  });

  it.each([
    '*.fiveacross.app',
    'fiveacross.app',
    'bodega-bay.fiveacross.app',
    'r2-ABCDEFGHIJKLMNOPQRSTUVWXYZ.fiveacross.app',
    'r2-short.fiveacross.app',
  ])('hard-rejects wildcard, apex, real, or out-of-class host %s', (host) => {
    expect(() => validateRehearsalManifest(manifest([host]), { existingReservations: 0 })).toThrow(
      'closed synthetic class',
    );
  });

  it('is dry-run by default and describes exact host-only DNS/route operations without mutation', async () => {
    const provider = deps();
    const result = await provisionRehearsal(manifest(), provider, { existingReservations: 0 });
    expect(result.dryRun).toBe(true);
    expect(result.operations).toContain(`attach exact route ${EVENT_HOST}/*`);
    expect(provider.reserveTransaction).not.toHaveBeenCalled();
    expect(provider.createExactDns).not.toHaveBeenCalled();
    expect(provider.attachExactRoute).not.toHaveBeenCalled();
  });

  it('uses one reservation transaction and never turns a root test into an apex/path namespace', async () => {
    const provider = deps();
    await provisionRehearsal(manifest(), provider, { existingReservations: 0, dryRun: false });
    expect(provider.reserveTransaction).toHaveBeenCalledOnce();
    expect(provider.reserveTransaction.mock.calls[0][0][1]).toMatchObject({
      host: ROOT_HOST,
      class: 'root-test',
      rootProjection: { pathNamespace: null },
      permanent: true,
    });
    expect(provider.createExactDns).toHaveBeenCalledTimes(2);
    expect(provider.attachExactRoute).toHaveBeenCalledWith(ROOT_HOST, `${ROOT_HOST}/*`, 'route-1');
  });

  it('tombstones and waits for DO convergence before removing only manifest-recorded artifacts', async () => {
    const provider = deps();
    const result = await cleanupRehearsal(manifest(), provider, {
      dryRun: false,
      observedArtifacts: [
        { kind: 'dns', id: 'dns-0', host: EVENT_HOST },
        { kind: 'route', id: 'route-0', host: EVENT_HOST },
        { kind: 'dns', id: 'dns-1', host: ROOT_HOST },
        { kind: 'route', id: 'route-1', host: ROOT_HOST },
      ],
    });
    expect(result.permanentReservationsRetained).toBe(true);
    expect(provider.tombstoneAndWait).toHaveBeenCalledBefore(provider.removeExactRoute);
    expect(provider.removeExactRoute).toHaveBeenCalledTimes(2);
    expect(provider.removeExactDns).toHaveBeenCalledTimes(2);
    expect(provider.verifyAbsent).toHaveBeenCalledOnce();
  });

  it('refuses cleanup when the provider reports an unrecorded artifact', async () => {
    const provider = deps();
    await expect(
      cleanupRehearsal(manifest(), provider, {
        observedArtifacts: [{ kind: 'route', id: 'unknown-route', host: EVENT_HOST }],
      }),
    ).rejects.toThrow('unrecorded artifact');
    expect(provider.tombstoneAndWait).not.toHaveBeenCalled();
  });
});
